"""
AI Robot canlı yayın serveri.

  - /         -> robot səhifəsi (OBS Browser Source)
  - /control  -> test paneli (saxta şərh göndərmək üçün)
  - /ws       -> WebSocket (server <-> səhifələr)

Hissə 1: skelet
Hissə 2: səs (edge-tts), səs səhifədə çalınır
"""

import asyncio
import json
import logging
import uuid
from pathlib import Path

from aiohttp import web, WSMsgType

from tts import TTS

BASE_DIR = Path(__file__).parent
WEB_DIR = BASE_DIR / "web"
MEDIA_DIR = BASE_DIR / "media"
TTS_DIR = MEDIA_DIR / "tts"

HOST = "127.0.0.1"
PORT = 8080

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("robot")


class Hub:
    """Qoşulmuş səhifələri və şərh növbəsini idarə edir."""

    def __init__(self) -> None:
        self.clients: set[web.WebSocketResponse] = set()
        self.queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=20)
        self.tts = TTS(TTS_DIR)
        # Robot səhifəsi səsi bitirəndə "speak_done" göndərir; onu burada gözləyirik
        self.pending: dict[str, asyncio.Event] = {}

    async def broadcast(self, message: dict) -> None:
        data = json.dumps(message, ensure_ascii=False)
        for ws in list(self.clients):
            try:
                await ws.send_str(data)
            except ConnectionResetError:
                self.clients.discard(ws)

    def add_comment(self, user: str, text: str) -> None:
        if self.queue.full():
            log.info("Növbə doludur, şərh atıldı: %s: %s", user, text)
            return
        self.queue.put_nowait({"user": user, "text": text})

    async def worker(self) -> None:
        """Növbədən bir-bir şərh götürür və robotu 'danışdırır'."""
        while True:
            comment = await self.queue.get()
            log.info("Şərh: %s: %s", comment["user"], comment["text"])

            # Hələ AI yoxdur (Hissə 3), robot şərhi sadəcə təkrarlayır.
            reply = comment["text"]
            try:
                await self.say(reply, comment)
            except Exception:
                log.exception("Cavab verilə bilmədi")
            await asyncio.sleep(0.5)  # cavablar arasında kiçik fasilə

    async def say(self, text: str, comment: dict | None = None) -> None:
        """Mətni səsləndirir və robot səsi bitirənə qədər gözləyir."""
        filename, duration = await self.tts.synthesize(text)
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
    finally:
        hub.clients.discard(ws)
        log.info("Səhifə ayrıldı (cəmi: %d)", len(hub.clients))
    return ws


def page(filename: str):
    async def handler(request: web.Request) -> web.FileResponse:
        return web.FileResponse(WEB_DIR / filename)
    return handler


async def on_startup(app: web.Application) -> None:
    app["worker"] = asyncio.create_task(app["hub"].worker())


async def on_cleanup(app: web.Application) -> None:
    app["worker"].cancel()


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
