import asyncio
import json
import threading
from enum import Enum

from aiortc import (
    RTCConfiguration,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
    MediaStreamTrack,
)
from aiortc.mediastreams import MediaStreamError
from PySide6.QtCore import QObject, Signal

import api
import ice_tuning

ice_tuning.install()


class ConnectionState(Enum):
    WAITING = "waiting for phone"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    DISCONNECTED = "disconnected"
    FAILED = "failed"


# Give up if ICE/DTLS hasn't completed this long after answering.
CONNECT_TIMEOUT_S = 30
# A "disconnected" peer often recovers (Wi-Fi roam, brief loss); wait before ending.
DISCONNECT_GRACE_S = 10


class WebRTCWorker(QObject):
    """
    One pairing session: waits for the phone's offer, answers it, and feeds
    received media into the (app-lifetime) virtual camera and microphone.

    Runs its own asyncio loop on a background thread. Emits exactly one
    terminal state (DISCONNECTED or FAILED) and then stops.
    """

    state_changed = Signal(object)          # ConnectionState
    failed = Signal(str)                    # human-readable reason
    remote_toggle = Signal(str, str)        # device ("mic"/"cam"/"media"), "on"/"off"

    def __init__(self, code: str, cam, mic):
        super().__init__()
        self.code = code
        self.cam = cam
        self.mic = mic

        self.loop = None
        self.pc = None
        self._thread = None
        self._stop_requested = threading.Event()
        self._closing = None            # asyncio.Event, set when shutdown starts
        self._shutdown_task = None
        self._done = False
        self._tasks = set()
        self._channels = set()
        self._grace_task = None

    # ---------------- public API (GUI thread) ----------------
    def start(self):
        if self._thread:
            return
        self._thread = threading.Thread(target=self._thread_main, daemon=True, name=f"WebRTC-{self.code}")
        self._thread.start()

    def stop(self, wait: bool = False, timeout: float = 3.0):
        """Request shutdown. Never blocks the GUI unless wait=True (app exit)."""
        self._stop_requested.set()
        loop = self.loop
        if loop and not loop.is_closed():
            try:
                loop.call_soon_threadsafe(self._begin_shutdown, None, True)
            except RuntimeError:
                pass  # loop already closed
        if wait and self._thread and self._thread is not threading.current_thread():
            self._thread.join(timeout)

    def toggle_cam(self, on: bool):
        self._send_threadsafe({"type": "toggle_cam", "value": "on" if on else "off", "source": "linux"})

    def toggle_mic(self, on: bool):
        self._send_threadsafe({"type": "toggle_mic", "value": "on" if on else "off", "source": "linux"})

    # ---------------- loop thread ----------------
    def _thread_main(self):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        def quiet_exceptions(loop, context):
            # aioice's TURN refresh/channel-bind tasks raise TransactionFailed
            # when a relay path dies mid-session; that is expected noise.
            exc = context.get("exception")
            if exc is not None and type(exc).__name__ in ("TransactionFailed", "TransactionTimeout"):
                return
            loop.default_exception_handler(context)

        loop.set_exception_handler(quiet_exceptions)
        self.loop = loop
        try:
            loop.run_until_complete(self._main())
        finally:
            pending = [t for t in asyncio.all_tasks(loop) if not t.done()]
            for t in pending:
                t.cancel()
            if pending:
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.close()

    async def _main(self):
        self._closing = asyncio.Event()
        if self._stop_requested.is_set():
            self._begin_shutdown(None, True)
        try:
            await self._run()
        except asyncio.CancelledError:
            pass
        except api.CodeGone:
            self._begin_shutdown("Code expired or was deleted")
        except api.OfferTimeout:
            self._begin_shutdown("No phone connected within 10 minutes; generate a new code")
        except Exception as e:
            print(f"[WebRTC] Session error: {e!r}")
            self._begin_shutdown(f"Connection error: {e}")
        # Whatever ended _run, make sure teardown runs to completion.
        self._begin_shutdown(None, True)
        await self._shutdown_task

    def _spawn(self, coro):
        t = asyncio.ensure_future(coro)
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)
        return t

    async def _run(self):
        self.state_changed.emit(ConnectionState.WAITING)

        # Fetch TURN credentials while we wait for the phone, so they're ready
        # the moment the offer lands instead of adding a round trip after it.
        ice_task = self._spawn(asyncio.to_thread(api.get_ice_servers))
        offer_task = self._spawn(asyncio.to_thread(api.wait_for_offer, self.code, self._stop_requested))

        await asyncio.wait({offer_task, self._spawn(self._closing.wait())},
                           return_when=asyncio.FIRST_COMPLETED)
        if self._closing.is_set():
            return
        offer_json = offer_task.result()
        if not offer_json:
            return

        print("[WebRTC] Got offer")
        self.state_changed.emit(ConnectionState.CONNECTING)

        servers = await ice_task
        self.pc = pc = RTCPeerConnection(RTCConfiguration(iceServers=[
            RTCIceServer(urls=s.get("urls") or s.get("url"),
                         username=s.get("username"), credential=s.get("credential"))
            for s in servers
        ]))
        pc.addTransceiver("video", direction="recvonly")
        pc.addTransceiver("audio", direction="recvonly")
        connected = asyncio.Event()

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            state = pc.connectionState
            print(f"[WebRTC] Connection state: {state}")
            if state == "connected":
                connected.set()
                if self._grace_task:
                    self._grace_task.cancel()
                    self._grace_task = None
                self.state_changed.emit(ConnectionState.CONNECTED)
            elif state == "disconnected":
                if not self._grace_task:
                    self._grace_task = self._spawn(self._disconnect_grace())
            elif state == "failed":
                self._begin_shutdown("Connection lost")
            elif state == "closed":
                self._begin_shutdown(None)

        @pc.on("track")
        def on_track(track):
            print(f"[WebRTC] {track.kind} track received")
            if track.kind == "video":
                self._spawn(self._pump(track, self.cam.push))
            elif track.kind == "audio":
                self._spawn(self._pump(track, self.mic.push))

        @pc.on("datachannel")
        def on_datachannel(channel):
            self._channels.add(channel)
            channel.on("close", lambda: self._channels.discard(channel))

            @channel.on("message")
            def on_message(msg):
                if not isinstance(msg, str):
                    return
                try:
                    data = json.loads(msg)
                except ValueError:
                    return
                if not isinstance(data, dict):
                    return
                kind = data.get("type")
                if kind == "toggle":
                    device, value = data.get("device"), data.get("value")
                    if device in ("mic", "cam", "media") and value in ("on", "off"):
                        self.remote_toggle.emit(device, value)
                elif kind == "terminate":
                    print("[WebRTC] Phone ended the session")
                    self._begin_shutdown(None, send_terminate=False)

        await pc.setRemoteDescription(RTCSessionDescription(sdp=offer_json["sdp"], type=offer_json["type"]))
        await pc.setLocalDescription(await pc.createAnswer())
        if self._closing.is_set():
            return
        await asyncio.to_thread(api.submit_answer, self.code,
                                {"sdp": pc.localDescription.sdp, "type": pc.localDescription.type})
        print("[WebRTC] Answer submitted")

        try:
            await asyncio.wait_for(connected.wait(), CONNECT_TIMEOUT_S)
        except asyncio.TimeoutError:
            self._begin_shutdown("Timed out connecting to phone (network blocked?)")
            return

        await self._closing.wait()

    async def _disconnect_grace(self):
        try:
            await asyncio.sleep(DISCONNECT_GRACE_S)
        except asyncio.CancelledError:
            return
        if self.pc and self.pc.connectionState != "connected":
            self._begin_shutdown("Connection lost")

    async def _pump(self, track: MediaStreamTrack, sink):
        try:
            while True:
                sink(await track.recv())
        except (asyncio.CancelledError, MediaStreamError):
            pass
        except Exception as e:
            print(f"[WebRTC] {track.kind} receive error: {e!r}")

    # ---------------- data channel ----------------
    def _send_threadsafe(self, payload: dict):
        loop = self.loop
        if not loop or loop.is_closed():
            return
        try:
            loop.call_soon_threadsafe(self._send_json, payload)
        except RuntimeError:
            pass

    def _send_json(self, payload: dict):
        msg = json.dumps(payload)
        for ch in list(self._channels):
            if ch.readyState == "open":
                try:
                    ch.send(msg)
                except Exception as e:
                    print(f"[WebRTC] Data channel send failed: {e!r}")

    # ---------------- shutdown ----------------
    def _begin_shutdown(self, error, send_terminate=True):
        """Idempotent; must run on the loop thread."""
        if self._closing is None:
            return
        if self._closing.is_set():
            return
        self._closing.set()
        self._stop_requested.set()
        self._shutdown_task = asyncio.ensure_future(self._shutdown(error, send_terminate))

    async def _shutdown(self, error, send_terminate):
        if send_terminate and self._channels:
            self._send_json({"type": "terminate", "source": "linux"})
            await asyncio.sleep(0.15)  # let SCTP flush before tearing down

        current = asyncio.current_task()
        tasks = [t for t in self._tasks if t is not current]
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

        if self.pc:
            try:
                await asyncio.wait_for(self.pc.close(), 3)
            except Exception:
                pass
            self.pc = None
        self._channels.clear()

        self.cam.clear()
        self.mic.clear()

        if not self._done:
            self._done = True
            if error:
                print(f"[WebRTC] Session failed: {error}")
                self.failed.emit(error)
                self.state_changed.emit(ConnectionState.FAILED)
            else:
                self.state_changed.emit(ConnectionState.DISCONNECTED)
