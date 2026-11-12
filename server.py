"""
AI Robot canlı yayın serveri.

  - /         -> robot səhifəsi (OBS Browser Source)
  - /control  -> test paneli (saxta şərh göndərmək üçün)
  - /ws       -> WebSocket (server <-> səhifələr)

Hissə 1: skelet
Hissə 2: səs (edge-tts), səs səhifədə çalınır
Hissə 3: AI beyin (Gemini), süzgəc və növbə
Hissə 4: TikTok canlı yayınına qoşulma
"""

import asyncio
import json
import logging
import os
import time
import uuid
from pathlib import Path

from aiohttp import web, WSMsgType
from dotenv import load_dotenv

from brain import Brain
from tiktok import TikTokSource
from tts import TTS

BASE_DIR = Path(__file__).parent
load_dotenv(BASE_DIR / ".env")
WEB_DIR = BASE_DIR / "web"
MEDIA_DIR = BASE_DIR / "media"
TTS_DIR = MEDIA_DIR / "tts"

HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", 8080))

QUEUE_SIZE = 5        # növbədə ən çox bu qədər şərh; dolanda ən köhnəsi atılır
MAX_COMMENT_AGE = 30  # bundan köhnə şərhə cavab verilmir (saniyə)

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("robot")


class Hub:
    """Qoşulmuş səhifələri və şərh növbəsini idarə edir."""

    def __init__(self) -> None:
        self.clients: set[web.WebSocketResponse] = set()
        self.queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=QUEUE_SIZE)
        self.tts = TTS(TTS_DIR)
        self.brain = Brain(BASE_DIR)
        # Səsi hazır olan cavablar (1 ədəd əvvəlcədən hazırlanır)
        self.ready: asyncio.Queue[tuple] = asyncio.Queue(maxsize=1)
        # Robot səhifəsi səsi bitirəndə "speak_done" göndərir; onu burada gözləyirik
        self.pending: dict[str, asyncio.Event] = {}
        # TikTok
        self.tiktok_status = {"type": "tiktok_status", "state": "stopped", "detail": "", "username": ""}
        self.tiktok = TikTokSource(
            on_comment=self.add_comment,
            on_gift=self.on_gift,
            on_follow=self.on_follow,
            on_status=self.set_tiktok_status,
        )

    # ---------- TikTok hadisələri ----------

    def set_tiktok_status(self, state: str, detail: str) -> None:
        self.tiktok_status = {"type": "tiktok_status", "state": state, "detail": detail,
                              "username": self.tiktok.username or ""}
        asyncio.create_task(self.broadcast(self.tiktok_status))

    def on_gift(self, user: str, gift: str, count: int) -> None:
        log.info("🎁 Hədiyyə: %s -> %s x%d", user, gift, count)
        asyncio.create_task(self.broadcast({"type": "gesture", "name": "nod"}))

    def on_follow(self, user: str) -> None:
        log.info("➕ Follow: %s", user)
        asyncio.create_task(self.broadcast({"type": "gesture", "name": "nod"}))

    async def broadcast(self, message: dict) -> None:
        data = json.dumps(message, ensure_ascii=False)
        for ws in list(self.clients):
            try:
                await ws.send_str(data)
            except ConnectionResetError:
                self.clients.discard(ws)

    def add_comment(self, user: str, text: str) -> None:
        reason = self.brain.accept_comment(user, text)
        if reason:
            log.info("Atıldı (%s): %s: %s", reason, user, text)
            return
        if self.queue.full():
            dropped = self.queue.get_nowait()  # təzə şərhlər daha maraqlıdır
            log.info("Növbə dolu, köhnə şərh atıldı: %s", dropped["text"])
        self.queue.put_nowait({"user": user, "text": text, "time": time.time()})

    async def preparer(self) -> None:
        """Növbədən şərh götürür, AI cavabını və səsini HAZIRLAYIR.
        Robot bir cavabı deyərkən növbəti cavab artıq hazırlanır."""
        while True:
            comment = await self.queue.get()
            if time.time() - comment["time"] > MAX_COMMENT_AGE:
                log.info("Köhnə şərh keçildi: %s", comment["text"])
                continue
            log.info("Şərh: %s: %s", comment["user"], comment["text"])
            try:
                reply = await self.brain.reply(comment["user"], comment["text"])
                if not reply:
                    log.info("AI cavab vermədi (SKIP və ya xəta)")
                    continue
                filename, duration = await self.tts.synthesize(reply)
                await self.ready.put((comment, reply, filename, duration))
            except Exception:
                log.exception("Cavab hazırlana bilmədi")

    async def speaker(self) -> None:
        """Hazır cavabları bir-bir robota dedirir."""
        while True:
            comment, reply, filename, duration = await self.ready.get()
            try:
                await self.play(reply, filename, duration, comment)
            except Exception:
                log.exception("Cavab səsləndirilə bilmədi")
            await asyncio.sleep(0.4)  # cavablar arasında kiçik fasilə

    async def say(self, text: str) -> None:
        """Növbədən kənar birbaşa danışmaq üçün (məsələn, salamlama)."""
        filename, duration = await self.tts.synthesize(text)
        await self.play(text, filename, duration)

    async def play(self, text: str, filename: str, duration: float, comment: dict | None = None) -> None:
        """Hazır səsi robot səhifəsində çalır və bitənə qədər gözləyir."""
        speak_id = uuid.uuid4().hex
        done = asyncio.Event()
        self.pending[speak_id] = done

        if comment:
            await self.broadcast({"type": "comment", "user": comment["user"], "text": comment["text"]})
        await self.broadcast({
            "type": "speak",
            "id": speak_id,
            "text": text,
            "audio": f"/media/tts/{filename}",
        })
        log.info("Robot: %s (%.1f san)", text, duration)

        try:
            # Səhifə cavab verməsə (məsələn, açıq deyil), müddət bitəndə davam edirik
            await asyncio.wait_for(done.wait(), timeout=duration + 3)
        except TimeoutError:
            await self.broadcast({"type": "speak_end", "id": speak_id})
        finally:
            self.pending.pop(speak_id, None)

    def speak_done(self, speak_id: str) -> None:
        event = self.pending.get(speak_id)
        if event:
            event.set()


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    hub: Hub = request.app["hub"]
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)
    hub.clients.add(ws)
    log.info("Səhifə qoşuldu (cəmi: %d)", len(hub.clients))
    await ws.send_str(json.dumps(hub.tiktok_status, ensure_ascii=False))

    try:
        async for msg in ws:
            if msg.type != WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except json.JSONDecodeError:
                continue
            kind = data.get("type")
            if kind == "test_comment":
                user = str(data.get("user") or "test").strip()[:40]
                text = str(data.get("text") or "").strip()[:200]
                if text:
                    hub.add_comment(user, text)
            elif kind == "speak_done":
                hub.speak_done(str(data.get("id", "")))
            elif kind == "tiktok_connect":
                username = str(data.get("username") or "").strip()[:60]
                log.info("TikTok hesabı: %s", username or "(dayandırıldı)")
                hub.tiktok.set_username(username)
    finally:
        hub.clients.discard(ws)
        log.info("Səhifə ayrıldı (cəmi: %d)", len(hub.clients))
    return ws


def page(filename: str):
    async def handler(request: web.Request) -> web.FileResponse:
        return web.FileResponse(WEB_DIR / filename)
    return handler


async def on_startup(app: web.Application) -> None:
    hub: Hub = app["hub"]
    app["tasks"] = [asyncio.create_task(hub.preparer()), asyncio.create_task(hub.speaker())]
    # .env-də TIKTOK_USERNAME varsa, avtomatik qoşul
    if os.environ.get("TIKTOK_USERNAME"):
        hub.tiktok.set_username(os.environ["TIKTOK_USERNAME"])


async def on_cleanup(app: web.Application) -> None:
    for task in app["tasks"]:
        task.cancel()
    app["hub"].tiktok.set_username(None)


def create_app() -> web.Application:
    MEDIA_DIR.mkdir(exist_ok=True)
    app = web.Application()
    app["hub"] = Hub()
    app.router.add_get("/", page("robot.html"))
    app.router.add_get("/control", page("control.html"))
    app.router.add_get("/ws", ws_handler)
    app.router.add_static("/media/", MEDIA_DIR)
    app.router.add_static("/static/", WEB_DIR)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


if __name__ == "__main__":
    print(f"\n  Robot səhifəsi:  http://{HOST}:{PORT}/")
    print(f"  Test paneli:     http://{HOST}:{PORT}/control\n")
    web.run_app(create_app(), host=HOST, port=PORT, print=None)
