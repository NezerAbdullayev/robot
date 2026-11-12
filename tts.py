"""
Mətni səsə çevirir (edge-tts, Microsoft-un pulsuz neyron səsləri).

Azərbaycan səsləri:
  az-AZ-BabekNeural  (kişi)
  az-AZ-BanuNeural   (qadın)
"""

import time
import uuid
from pathlib import Path

import edge_tts

VOICE = "az-AZ-BabekNeural"
RATE = "+0%"     # sürət, məsələn "+10%" daha tez danışır
PITCH = "-8Hz"   # səs tonu; mənfi = daha qalın, bir az "robot" səsi

# edge-tts mp3-ü 48 kbit/s verir, ona görə müddəti fayl ölçüsündən hesablamaq olur
MP3_BITRATE = 48_000
KEEP_FILES = 30  # köhnə səs fayllarından ən çox bu qədəri saxlanılır


class TTS:
    def __init__(self, out_dir: Path) -> None:
        self.out_dir = out_dir
        self.out_dir.mkdir(parents=True, exist_ok=True)

    async def synthesize(self, text: str) -> tuple[str, float]:
        """Səs faylı yaradır. Qaytarır: (fayl adı, müddət saniyə ilə)."""
        name = f"{int(time.time())}_{uuid.uuid4().hex[:6]}.mp3"
        path = self.out_dir / name
        await edge_tts.Communicate(text, VOICE, rate=RATE, pitch=PITCH).save(str(path))
        duration = path.stat().st_size * 8 / MP3_BITRATE
        self._cleanup()
        return name, duration

    def _cleanup(self) -> None:
        files = sorted(self.out_dir.glob("*.mp3"), key=lambda p: p.stat().st_mtime)
        for old in files[:-KEEP_FILES]:
            old.unlink(missing_ok=True)
