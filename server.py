"""
AI Robot canlı yayın serveri.

  - /         -> robot səhifəsi (OBS Browser Source)
  - /control  -> test paneli (saxta şərh göndərmək üçün)
  - /ws       -> WebSocket (server <-> səhifələr)

Hissə 1: skelet
Hissə 2: səs (edge-tts), səs səhifədə çalınır
Hissə 3: AI beyin (Gemini), süzgəc və növbə
Hissə 4: TikTok canlı yayınına qoşulma
Video studiyası: robotun cavablarını TikTok üçün MP4 videoya yazır
Reaksiyalar: hədiyyə/follow -> təşəkkür + hərəkət videosu (actions.json)
"""

import asyncio
import json
import logging
import os
import shutil
import socket
import time
import uuid
from pathlib import Path

from aiohttp import web, WSMsgType
from dotenv import load_dotenv

from brain import Brain
from tiktok import TikTokSource
from actions import Reactions
from tts import TTS

BASE_DIR = Path(__file__).parent
load_dotenv(BASE_DIR / ".env")
WEB_DIR = BASE_DIR / "web"
MEDIA_DIR = BASE_DIR / "media"
TTS_DIR = MEDIA_DIR / "tts"
CLIPS_DIR = MEDIA_DIR / "clips"
ACTIONS_DIR = MEDIA_DIR / "actions"   # hərəkət videoları (rəqs, əl yelləmə...)
EVENT_QUEUE_SIZE = 8  # gözləyən reaksiyalar (hədiyyə yağışında artığı atılır)

# 0.0.0.0: robot səhifəsi eyni Wi-Fi-dakı telefonda da açılır (telefonla yayın üçün).
# İdarəetmə (test paneli, TikTok, video studiyası) isə yalnız bu Mac-dən mümkündür.
HOST = os.environ.get("HOST", "0.0.0.0")
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
        # Eyni anda yalnız bir danışıq (canlı cavab və ya video yazısı)
        self.speak_lock = asyncio.Lock()
        # Hədiyyə/follow reaksiyaları
        self.reactions = Reactions(BASE_DIR / "actions.json", ACTIONS_DIR, self.brain.clean_name)
        self.events: asyncio.Queue[dict] = asyncio.Queue(maxsize=EVENT_QUEUE_SIZE)
        self.action_waiters: dict[str, asyncio.Event] = {}
        # Video studiyası
        self.clip_queue: asyncio.Queue[dict] = asyncio.Queue()
        self.clip_waiters: dict[str, asyncio.Future] = {}
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
        text, video = self.reactions.for_gift(user, gift)
        label = f"🎁 {gift}" + (f" x{count}" if count > 1 else "") + " göndərdi"
        self._add_event(user, label, text, video)

    def on_follow(self, user: str) -> None:
        log.info("➕ Follow: %s", user)
        text, video = self.reactions.for_follow(user)
        self._add_event(user, "➕ izləməyə başladı", text, video)

    def _add_event(self, user: str, label: str, text: str | None, video: str | None) -> None:
        asyncio.create_task(self.broadcast({"type": "gesture", "name": "nod"}))
        if not text and not video:
            return
        if self.events.full():
            log.info("Reaksiya növbəsi dolu, atıldı: %s %s", user, label)
            return
        self.events.put_nowait({"user": user, "label": label, "text": text, "video": video})

    async def event_worker(self) -> None:
        """Hədiyyə/follow reaksiyalarını oynadır. Video oynayanda şərhlər gözləyir (speak_lock)."""
        while True:
            ev = await self.events.get()
            try:
                audio = await self.tts.synthesize(ev["text"]) if ev["text"] else None
                async with self.speak_lock:
                    await self.broadcast({"type": "comment", "user": ev["user"], "text": ev["label"]})
                    if audio:
                        await self.play(ev["text"], *audio)
                    if ev["video"]:
                        await self.play_action(ev["video"])
                        # AI-nin yaddaşına: robot indicə hərəkət etdi (sonrakı suallara uyğun cavab versin)
                        self.brain.history.append(f"(Robo indicə {ev['user']} üçün {ev['video'].rsplit('.', 1)[0]} hərəkətini etdi, məsələn rəqs etdi)")
            except Exception:
                log.exception("Reaksiya oynadıla bilmədi")
            await asyncio.sleep(0.3)

    async def play_action(self, video: str) -> None:
        """Hərəkət videosunu robot səhifəsində oynadır və bitənə qədər gözləyir."""
        action_id = uuid.uuid4().hex
        done = asyncio.Event()
        self.action_waiters[action_id] = done
        log.info("🎬 Hərəkət: %s", video)
        await self.broadcast({"type": "action", "id": action_id, "video": f"/media/actions/{video}"})
        try:
            await asyncio.wait_for(done.wait(), timeout=90)
        except TimeoutError:
            log.warning("Hərəkət videosu 90 saniyədə bitmədi (robot səhifəsi açıqdır?)")
        finally:
            self.action_waiters.pop(action_id, None)

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
                async with self.speak_lock:
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

    # ---------- Video studiyası ----------

    async def add_clip(self, question: str, user: str) -> None:
        job = {"id": uuid.uuid4().hex, "question": question, "user": user}
        await self.clip_status(job, "queued")
        self.clip_queue.put_nowait(job)

    async def clip_status(self, job: dict, state: str, **extra) -> None:
        await self.broadcast({"type": "clip_status", "id": job["id"], "question": job["question"], "state": state, **extra})

    async def clip_worker(self) -> None:
        while True:
            job = await self.clip_queue.get()
            try:
                await self.make_clip(job)
            except Exception as err:
                log.exception("Video yazıla bilmədi")
                await self.clip_status(job, "error", detail=str(err)[:120])

    async def make_clip(self, job: dict) -> None:
        await self.clip_status(job, "thinking")
        reply = await self.brain.reply(job["user"] or "", job["question"])
        if not reply:
            await self.clip_status(job, "error", detail="AI cavab vermədi")
            return
        filename, duration = await self.tts.synthesize(reply)
        future = asyncio.get_running_loop().create_future()
        self.clip_waiters[job["id"]] = future
        async with self.speak_lock:
            await self.clip_status(job, "recording", text=reply)
            await self.broadcast({
                "type": "clip", "id": job["id"], "user": job["user"] or "izləyici",
                "question": job["question"], "text": reply, "audio": f"/media/tts/{filename}",
            })
            try:
                raw: Path = await asyncio.wait_for(future, timeout=duration + 30)
            except TimeoutError:
                await self.clip_status(job, "error", detail="Robot səhifəsi cavab vermədi (açıqdır? səs aktivdir?)")
                return
            finally:
                self.clip_waiters.pop(job["id"], None)
        await self.clip_status(job, "converting", text=reply)
        final = await convert_to_mp4(raw)
        log.info("🎬 Video hazırdır: %s", final.name)
        await self.clip_status(job, "ready", text=reply, url=f"/media/clips/{final.name}", name=final.name)

    def speak_done(self, speak_id: str) -> None:
        event = self.pending.get(speak_id)
        if event:
            event.set()


def is_local(request: web.Request) -> bool:
    return request.remote in ("127.0.0.1", "::1")


def lan_ip() -> str | None:
    """Bu Mac-in Wi-Fi şəbəkəsindəki IP ünvanı (telefon üçün link)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))  # paket göndərilmir, yalnız marşrut seçilir
            return s.getsockname()[0]
    except OSError:
        return None


async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    hub: Hub = request.app["hub"]
    local = is_local(request)
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
            # Başqa cihazlar (telefon) yalnız robot səhifəsi kimi işləyə bilər, idarə edə bilməz
            if not local and kind in ("test_comment", "clip_request", "tiktok_connect", "test_gift", "test_follow"):
                continue
            if kind == "test_comment":
                user = str(data.get("user") or "test").strip()[:40]
                text = str(data.get("text") or "").strip()[:200]
                if text:
                    hub.add_comment(user, text)
            elif kind == "speak_done":
                hub.speak_done(str(data.get("id", "")))
            elif kind == "clip_request":
                user = str(data.get("user") or "").strip()[:40]
                for q in str(data.get("questions") or "").splitlines():
                    q = q.strip()[:200]
                    if q:
                        await hub.add_clip(q, user)
            elif kind == "clip_error":
                fut = hub.clip_waiters.get(str(data.get("id", "")))
                if fut and not fut.done():
                    fut.set_exception(RuntimeError(str(data.get("detail") or "səhifədə xəta")))
            elif kind == "action_done":
                ev = hub.action_waiters.get(str(data.get("id", "")))
                if ev:
                    ev.set()
            elif kind == "test_gift":
                hub.on_gift(str(data.get("user") or "test")[:40], str(data.get("gift") or "Rose")[:40],
                            max(1, int(data.get("count") or 1)))
            elif kind == "test_follow":
                hub.on_follow(str(data.get("user") or "test")[:40])
            elif kind == "tiktok_connect":
                username = str(data.get("username") or "").strip()[:60]
                log.info("TikTok hesabı: %s", username or "(dayandırıldı)")
                hub.tiktok.set_username(username)
    finally:
        hub.clients.discard(ws)
        log.info("Səhifə ayrıldı (cəmi: %d)", len(hub.clients))
    return ws


async def convert_to_mp4(raw: Path) -> Path:
    """Brauzerin yazdığı videonu TikTok üçün standart MP4-ə (H.264 + AAC) çevirir."""
    ffmpeg = shutil.which("ffmpeg") or ("/opt/homebrew/bin/ffmpeg" if Path("/opt/homebrew/bin/ffmpeg").exists() else None)
    if not ffmpeg:
        log.warning("ffmpeg tapılmadı, video olduğu kimi saxlanılır: %s", raw.name)
        return raw
    out = raw.with_name(raw.stem + "_tiktok.mp4")
    proc = await asyncio.create_subprocess_exec(
        ffmpeg, "-y", "-loglevel", "error", "-i", str(raw),
        "-vf", "scale=1080:1920:out_range=tv,fps=30", "-color_range", "tv", "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-movflags", "+faststart", str(out),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    if proc.returncode != 0 or not out.exists():
        log.warning("ffmpeg xətası: %s", err.decode(errors="ignore")[:300])
        return raw
    raw.unlink(missing_ok=True)
    return out


async def clip_upload(request: web.Request) -> web.Response:
    """Robot səhifəsi yazdığı videonu bura göndərir."""
    hub: Hub = request.app["hub"]
    if not is_local(request):
        raise web.HTTPForbidden()
    clip_id = request.query.get("id", "")
    ext = "mp4" if "mp4" in (request.content_type or "") else "webm"
    data = await request.read()
    CLIPS_DIR.mkdir(parents=True, exist_ok=True)
    raw = CLIPS_DIR / f"{time.strftime('%Y%m%d_%H%M%S')}_{clip_id[:4]}.{ext}"
    future = hub.clip_waiters.get(clip_id)
    if not future or future.done():
        return web.json_response({"ok": False, "reason": "gözlənilmir"})  # məsələn, ikinci açıq tab
    raw.write_bytes(data)
    future.set_result(raw)
    log.info("Video qəbul edildi: %s (%.1f MB)", raw.name, len(data) / 1e6)
    return web.json_response({"ok": True})


def page(filename: str, local_only: bool = False):
    async def handler(request: web.Request) -> web.StreamResponse:
        if local_only and not is_local(request):
            raise web.HTTPForbidden(text="Test paneli yalnız Mac-in özündən açılır.")
        return web.FileResponse(WEB_DIR / filename)
    return handler


async def on_startup(app: web.Application) -> None:
    hub: Hub = app["hub"]
    app["tasks"] = [asyncio.create_task(hub.preparer()), asyncio.create_task(hub.speaker()),
                    asyncio.create_task(hub.clip_worker()), asyncio.create_task(hub.event_worker())]
    # .env-də TIKTOK_USERNAME varsa, avtomatik qoşul
    if os.environ.get("TIKTOK_USERNAME"):
        hub.tiktok.set_username(os.environ["TIKTOK_USERNAME"])


async def on_cleanup(app: web.Application) -> None:
    for task in app["tasks"]:
        task.cancel()
    app["hub"].tiktok.set_username(None)


def create_app() -> web.Application:
    MEDIA_DIR.mkdir(exist_ok=True)
    app = web.Application(client_max_size=300 * 1024 * 1024)  # video yükləmələri üçün
    app["hub"] = Hub()
    app.router.add_get("/", page("robot.html"))
    app.router.add_get("/control", page("control.html", local_only=True))
    app.router.add_get("/ws", ws_handler)
    app.router.add_post("/clip_upload", clip_upload)
    app.router.add_static("/media/", MEDIA_DIR)
    app.router.add_static("/static/", WEB_DIR)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    return app


if __name__ == "__main__":
    print(f"\n  Robot səhifəsi:  http://127.0.0.1:{PORT}/")
    print(f"  Test paneli:     http://127.0.0.1:{PORT}/control")
    ip = lan_ip()
    if HOST == "0.0.0.0" and ip:
        print(f"  Telefon üçün:    http://{ip}:{PORT}/   (eyni Wi-Fi-da)")
    print()
    web.run_app(create_app(), host=HOST, port=PORT, print=None)
