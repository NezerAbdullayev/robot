"""
Hədiyyə və follow reaksiyaları: təşəkkür sözləri (AI-siz, hazır şablonlar) və hərəkət videoları.

Cədvəl actions.json faylındadır. Videolar bir dəfə hazırlanır, media/actions/ qovluğunda
saxlanır və hər dəfə uyğun hədiyyə gələndə yenidən oynadılır.
"""

import json
import logging
import random
import time
from pathlib import Path

log = logging.getLogger("robot")


class Reactions:
    def __init__(self, config_path: Path, videos_dir: Path, clean_name) -> None:
        self.config_path = config_path
        self.videos_dir = videos_dir
        self.clean_name = clean_name  # brain.clean_name (ad təmizləmə)
        self.videos_dir.mkdir(parents=True, exist_ok=True)
        self.last_thanks: dict[str, float] = {}
        self.last_video: dict[str, str] = {}
        self.warned: set[str] = set()
        self.config: dict = {}
        self.mtime = 0.0
        self.reload()

    def reload(self) -> None:
        """actions.json dəyişibsə, yenidən oxuyur (serveri yenidən başlatmadan)."""
        try:
            mtime = self.config_path.stat().st_mtime
            if mtime != self.mtime:
                self.config = json.loads(self.config_path.read_text(encoding="utf-8"))
                self.mtime = mtime
                log.info("actions.json yükləndi")
        except Exception as err:
            log.warning("actions.json oxuna bilmədi: %s", err)

    def _rule_for_gift(self, gift: str, coins: int) -> dict:
        """1) coin dəyərinə görə qayda (ümumi dəyər həddən çoxdursa)  2) adla yazılmış qayda  3) "*" (qalan hamısı)"""
        for rule in sorted(self.config.get("value_rules", []), key=lambda r: -r.get("min_coins", 0)):
            if coins >= rule.get("min_coins", 0):
                return rule
        gifts = self.config.get("gifts", {})
        for name, rule in gifts.items():
            if name != "*" and name.lower() == gift.lower():
                return rule
        return gifts.get("*", {"thanks": True, "action": None})

    def pick_video(self, action: str | None) -> str | None:
        """Hərəkət üçün mövcud videolardan birini seçir (eyni videonu ard-arda təkrarlamır)."""
        if not action:
            return None
        files = [f for f in self.config.get("actions", {}).get(action, []) if (self.videos_dir / f).exists()]
        if not files:
            if action not in self.warned:  # eyni xəbərdarlığı log-da təkrarlamırıq
                self.warned.add(action)
                log.info("'%s' hərəkəti üçün video yoxdur (media/actions/ qovluğuna qoyun), yalnız təşəkkür ediləcək", action)
            return None
        choices = [f for f in files if f != self.last_video.get(action)] or files
        chosen = random.choice(choices)
        self.last_video[action] = chosen
        return chosen

    def _thanks_text(self, kind: str, user: str) -> str | None:
        cooldown = float(self.config.get("thanks_cooldown_seconds", 20))
        now = time.time()
        if now - self.last_thanks.get(user, 0) < cooldown:
            return None  # eyni adama tez-tez təşəkkür etmə (hədiyyə yağışında)
        self.last_thanks[user] = now
        templates = self.config.get(kind, []) or ["{name}, sağ ol!"]
        name = self.clean_name(user)
        text = random.choice(templates)
        if name:
            return text.replace("{name}", name)
        # Ad oxunmursa: "{name}, " hissəsini at
        text = text.replace("{name}, ", "").replace("{name}", "dostum").strip()
        return text[:1].upper() + text[1:]

    def for_gift(self, user: str, gift: str, coins: int = 0) -> tuple[str | None, str | None]:
        """(təşəkkür mətni, video faylı). coins = hədiyyənin ümumi dəyəri (say x qiymət)"""
        self.reload()
        rule = self._rule_for_gift(gift, coins)
        text = self._thanks_text("gift_thanks", user) if rule.get("thanks", True) else None
        return text, self.pick_video(rule.get("action"))

    def join_settings(self) -> dict:
        self.reload()
        return {"greet": True, "idle_seconds": 5, "repeat_minutes": 10, **self.config.get("join", {})}

    def greeting_for(self, user: str) -> str | None:
        """Yayına qoşulan izləyici üçün salamlama (ad oxunmursa None)."""
        name = self.clean_name(user)
        if not name:
            return None
        templates = self.config.get("join_greetings", []) or ["Salam {name}, xoş gəldin! Necəsən?"]
        return random.choice(templates).replace("{name}", name)

    def for_follow(self, user: str) -> tuple[str | None, str | None]:
        self.reload()
        rule = self.config.get("follow", {"thanks": True, "action": None})
        text = self._thanks_text("follow_thanks", user) if rule.get("thanks", True) else None
        return text, self.pick_video(rule.get("action"))
