"""
TikTok canlı yayınına qoşulma (TikTokLive kitabxanası, qeyri-rəsmi).

Yayının şərhlərini, hədiyyələrini və follow-larını oxuyur, yayına heç nə yazmır.
Yayın hələ başlamayıbsa və ya bağlantı kəsilibsə, bir müddətdən sonra yenidən cəhd edir.
"""

import asyncio
import logging
import time
from typing import Callable

from TikTokLive import TikTokLiveClient
from TikTokLive.events import (
    CommentEvent,
    ConnectEvent,
    DisconnectEvent,
    FollowEvent,
    GiftEvent,
    LiveEndEvent,
)

log = logging.getLogger("robot")

RETRY_OFFLINE = 30  # yayın yoxdursa, neçə saniyədən bir yoxlanılsın
RETRY_ERROR = 10    # xəta olanda neçə saniyədən sonra yenidən cəhd
HISTORY_SKIP = 2.0  # qoşulandan sonra bu qədər saniyə gələn şərhlər köhnədir (TikTok tarixçəni göndərir)


def display_name(user) -> str:
    """İzləyicinin göstəriləcək adı: nickname, yoxdursa @handle."""
    if user is None:
        return "izləyici"
    return (getattr(user, "nickname", "") or getattr(user, "unique_id", "") or "izləyici").strip()


class TikTokSource:
    """
    on_comment(name, text)         - hər şərh üçün
    on_gift(name, gift, count)     - hədiyyə (seriya bitəndə bir dəfə)
    on_follow(name)                - yeni follow
    on_status(state, detail)       - "connecting" | "live" | "offline" | "error" | "stopped"
    """

    def __init__(self, on_comment: Callable, on_gift: Callable, on_follow: Callable, on_status: Callable) -> None:
        self.on_comment = on_comment
        self.on_gift = on_gift
        self.on_follow = on_follow
        self.on_status = on_status
        self.username: str | None = None
        self.task: asyncio.Task | None = None
        self.client: TikTokLiveClient | None = None
        self.connected_at: float | None = None

    def set_username(self, username: str | None) -> None:
        """Hesabı dəyişir (boş verilərsə, bağlantını dayandırır)."""
        username = (username or "").strip().lstrip("@")
        if self.task:
            self.task.cancel()  # _run öz bağlantısını təmiz bağlayır
            self.task = None
        self.username = username or None
        if self.username:
            self.task = asyncio.create_task(self._run(self.username))
        else:
            self.on_status("stopped", "")

    async def _run(self, username: str) -> None:
        while True:
            client = TikTokLiveClient(unique_id=f"@{username}")
            self.client = client
            self.connected_at = None
            self._register(client, username)
            try:
                self.on_status("connecting", username)
                if not await client.is_live():
                    self.on_status("offline", username)
                    log.info("TikTok: @%s hazırda canlı deyil, %d san sonra yenidən yoxlanılacaq", username, RETRY_OFFLINE)
                    await asyncio.sleep(RETRY_OFFLINE)
                    continue
                # Qeyd: client.connect() ləğv ediləndə bütün event loop-u dayandırmağa çalışır,
                # ona görə start() + disconnect() ilə özümüz idarə edirik.
                task = await client.start()
                await asyncio.shield(task)  # bağlantı kəsilənə qədər gözləyir
                log.info("TikTok: @%s bağlantısı bitdi", username)
                await asyncio.sleep(3)
            except asyncio.CancelledError:
                await self._close(client)
                raise
            except Exception as err:
                self.on_status("error", f"{type(err).__name__}: {str(err)[:120]}")
                log.warning("TikTok xətası (@%s): %s: %s", username, type(err).__name__, str(err)[:200])
                await self._close(client)
                await asyncio.sleep(RETRY_ERROR)

    async def _close(self, client: TikTokLiveClient) -> None:
        try:
            client.remove_all_listeners()  # köhnə bağlantıdan heç bir hadisə gəlməsin
        except Exception:
            pass
        try:
            await asyncio.wait_for(client.disconnect(), timeout=5)
        except Exception as err:
            log.debug("TikTok disconnect: %s", err)

    def _register(self, client: TikTokLiveClient, username: str) -> None:
        @client.on(ConnectEvent)
        async def _connected(event: ConnectEvent) -> None:
            self.connected_at = time.monotonic()
            log.info("TikTok: @%s canlı yayınına qoşuldu", username)
            self.on_status("live", username)

        @client.on(DisconnectEvent)
        async def _disconnected(event: DisconnectEvent) -> None:
            log.info("TikTok: @%s bağlantısı kəsildi", username)
            self.on_status("offline", username)

        @client.on(LiveEndEvent)
        async def _ended(event: LiveEndEvent) -> None:
            log.info("TikTok: @%s canlı yayını bitdi", username)
            self.on_status("offline", username)

        @client.on(CommentEvent)
        async def _comment(event: CommentEvent) -> None:
            if self.connected_at is None or time.monotonic() - self.connected_at < HISTORY_SKIP:
                return  # qoşulma anında gələn köhnə şərhlər (TikTok tarixçəni göndərir)
            text = (event.comment or "").strip()
            if text:
                self.on_comment(display_name(event.user), text)

        @client.on(GiftEvent)
        async def _gift(event: GiftEvent) -> None:
            # Seriyalı hədiyyələr (məsələn 10 dəfə Rose) seriya bitəndə bir dəfə sayılır
            gift = event.gift
            if gift is not None and getattr(gift, "streakable", False) and event.streaking:
                return
            name = getattr(gift, "name", "") or "hədiyyə"
            self.on_gift(display_name(event.user), name, max(1, event.repeat_count or 1))

        @client.on(FollowEvent)
        async def _follow(event: FollowEvent) -> None:
            self.on_follow(display_name(event.user))
