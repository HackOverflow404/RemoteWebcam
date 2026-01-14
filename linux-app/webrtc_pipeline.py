import asyncio
import time
import threading
import requests
from aiortc import (
    RTCConfiguration,
    RTCIceServer,
    RTCPeerConnection,
    RTCSessionDescription,
    MediaStreamTrack,
)
from PySide6.QtCore import QObject, Signal
from av import VideoFrame
from enum import Enum
import json
from virtual_devices import VirtualCamThread, VirtualMicThread
import numpy as np
from av import AudioFrame
import queue


class ConnectionState(Enum):
    CONNECTING = "connecting"
    CONNECTED = "connected"
    DISCONNECTED = "disconnected"
    FAILED = "failed"


class WebRTCWorker(QObject):
    video_frame_received = Signal(object)
    connection_state_changed = Signal(ConnectionState)

    def __init__(self, code: str):
        super().__init__()
        self.loop = None
        self._thread = None
        self.running = False
        self.shutting_down = False
        self._shutdown_task = None
        self._shutdown_lock = None

        self.pc = None
        self.code = code
        self.data_channels = set()

        self.last_preview_ts = 0
        self.video_track_task = None
        self.VIRTUAL_CAM_WIDTH = 1280
        self.VIRTUAL_CAM_HEIGHT = 720
        self.virtual_cam_thread = None
        self.preview_interval = 1 / 10
        self.video_track_received = False
        self.video_queue = queue.Queue(maxsize=1)

        self._audio_frames = 0
        self.audio_track_task = None
        self.virtual_mic_thread = None
        self.audio_queue = queue.Queue(maxsize=4)

        self.CHECK_OFFER_URL = "https://checkoffer-qaf2yvcrrq-uc.a.run.app"
        self.SUBMIT_ANSWER_URL = "https://submitanswer-qaf2yvcrrq-uc.a.run.app"
        self.GET_TURN_URL = "https://getturncredentials-qaf2yvcrrq-uc.a.run.app"

    # PUBLIC API
    def start(self):
        if self.running:
            return

        self.running = True
        self.shutting_down = False
        self._shutdown_task = None
        self._shutdown_lock = None

        self._thread = threading.Thread(target=self._run_async_thread, daemon=True)
        self._thread.start()

    def stop(self):
        # Make stop idempotent and deterministic
        self.running = False

        # If the loop exists, run shutdown on it and wait (briefly) for completion
        if self.loop and self.loop.is_running():
            fut = asyncio.run_coroutine_threadsafe(self.__handle_shutdown(), self.loop)
            try:
                fut.result(timeout=3)
            except Exception:
                pass
            finally:
                try:
                    self.loop.call_soon_threadsafe(self.loop.stop)
                except Exception:
                    pass

        # Join the background thread so it doesn't pile up across sessions
        if self._thread and threading.current_thread() is not self._thread:
            self._thread.join(timeout=3)
        self._thread = None
    
    def toggle_cam(self, isChecked: bool):
        desired = "off" if isChecked else "on"   # or invert if your UI means “muted”
        msg = json.dumps({"type": "toggle_cam", "value": desired, "source": "linux"})

        if not self.data_channels:
            print("[WebRTC] Data channels unavailable")
            return

        for ch in list(self.data_channels):
            if ch.readyState == "open":
                print("[WebRTC] Sending toggle cam:", msg)
                ch.send(msg)

    def toggle_mic(self, isChecked: bool):
        desired = "off" if isChecked else "on"
        msg = json.dumps({"type": "toggle_mic", "value": desired, "source": "linux"})

        if not self.data_channels:
            print("[WebRTC] Data channels unavailable")
            return

        for ch in list(self.data_channels):
            if ch.readyState == "open":
                print("[WebRTC] Sending toggle mic:", msg)
                ch.send(msg)

    # THREAD / LOOP SETUP
    def _run_async_thread(self):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        main = self.loop.create_task(self.__run())
        try:
            self.loop.run_forever()
        finally:
            # ensure __run finishes
            if not main.done():
                main.cancel()
                try:
                    self.loop.run_until_complete(main)
                except Exception:
                    pass
            self.loop.close()

    async def __shutdown(self):
        if self.shutting_down:
            return
        self.shutting_down = True

        # Flip running first so other loops exit
        self.running = False

        try:
            await self.__send_termination()
        except Exception:
            pass

        # Cancel tasks and wait for them to finish
        tasks = [t for t in [self.video_track_task, self.audio_track_task] if t]
        for t in tasks:
            t.cancel()
        if tasks:
            try:
                await asyncio.gather(*tasks, return_exceptions=True)
            except Exception:
                pass
        self.video_track_task = None
        self.audio_track_task = None

        # Close data channels
        for ch in list(self.data_channels):
            try:
                ch.close()
            except Exception:
                pass
        self.data_channels.clear()

        # Close peer connection
        if self.pc:
            try:
                await self.pc.close()
            except Exception:
                pass
            self.pc = None

        # JOIN virtual device threads (don’t just drop references)
        if self.virtual_cam_thread:
            try:
                self.virtual_cam_thread.join(timeout=2)
            except Exception:
                pass
            self.virtual_cam_thread = None

        if self.virtual_mic_thread:
            try:
                self.virtual_mic_thread.join(timeout=2)
            except Exception:
                pass
            self.virtual_mic_thread = None

        self.connection_state_changed.emit(ConnectionState.DISCONNECTED)
    
    async def __handle_shutdown(self):
        if self._shutdown_lock is None:
            self._shutdown_lock = asyncio.Lock()
        # If a shutdown is already in progress, await it
        t = self._shutdown_task
        if t:
            if not t.done():
                await t
                return
            # done already
            exc = t.exception()
            if exc:
                print("[Shutdown] previous shutdown task failed:", repr(exc))
            return

        async def _do():
            # Only one shutdown body runs at a time
            async with self._shutdown_lock:
                await self.__shutdown()

        self._shutdown_task = asyncio.create_task(_do())
        try:
            await self._shutdown_task
        finally:
            self._shutdown_task = None

    # MAIN WEBRTC FLOW
    async def __run(self):
        self.loop = asyncio.get_running_loop()
        self._shutdown_lock = asyncio.Lock()

        print("Waiting for JS offer…")
        offer_json = await asyncio.to_thread(self.__poll_for_offer, self.code)
        if not offer_json:
            self.connection_state_changed.emit(ConnectionState.FAILED)
            await self.__handle_shutdown()
            return
        if not self.running:
            return

        self.connection_state_changed.emit(ConnectionState.CONNECTING)

        offer = RTCSessionDescription(
            sdp=offer_json["sdp"],
            type=offer_json["type"],
        )
        print("Got JS offer")

        try:
            config = self.__get_ice_configuration()
        except Exception as e:
            print("[WebRTC] ICE config failed:", repr(e))
            self.connection_state_changed.emit(ConnectionState.FAILED)
            await self.__handle_shutdown()
            return
        self.pc = RTCPeerConnection(configuration=config)

        self.pc.addTransceiver("video", direction="recvonly")
        self.pc.addTransceiver("audio", direction="recvonly")

        @self.pc.on("connectionstatechange")
        async def on_connectionstatechange():
            state = self.pc.connectionState
            print(f"[WebRTC] State: {state}")

            if state == "connected":
                self.connection_state_changed.emit(ConnectionState.CONNECTED)
            elif state == "failed":
                self.connection_state_changed.emit(ConnectionState.FAILED)
            
            if state in ("failed", "closed", "disconnected"):
                self.running = False
                asyncio.create_task(self.__handle_shutdown())

        @self.pc.on("track")
        async def on_track(track):
            if track.kind == "video":
                print("[WebRTC] Video track received")
                self.video_track_task = asyncio.create_task(
                    self.__handle_video_track(track)
                )

                self.video_track_received = True
            elif track.kind == "audio":
                print("[WebRTC] Audio track received")
                self.audio_track_task = asyncio.create_task(
                    self.__handle_audio_track(track)
                )

        @self.pc.on("datachannel")
        def on_datachannel(channel):
            self.data_channels.add(channel)

            @channel.on("open")
            def on_open(*args):
                channel.send('{"type":"hello","source":"linux"}')

            @channel.on("message")
            async def on_message(msg):
                try:
                    data = msg if isinstance(msg, dict) else json.loads(msg)
                except Exception:
                    return

                if data.get("type") == "terminate":
                    await self.__handle_shutdown()
                if data.get("type") == "dimensions":
                    self.VIRTUAL_CAM_WIDTH = data.get("width")
                    self.VIRTUAL_CAM_HEIGHT = data.get("height")
                    if self.video_frame_received:
                        if not self.virtual_cam_thread:
                            self.virtual_cam_thread = VirtualCamThread(
                                frame_queue=self.video_queue,
                                running_flag=lambda: self.running,
                                width=self.VIRTUAL_CAM_WIDTH,
                                height=self.VIRTUAL_CAM_HEIGHT,
                                fps=60,
                            )
                            self.virtual_cam_thread.start()

        await self.pc.setRemoteDescription(offer)
        answer = await self.pc.createAnswer()
        await self.pc.setLocalDescription(answer)

        await asyncio.to_thread(
            requests.post,
            self.SUBMIT_ANSWER_URL,
            json={
                "code": self.code,
                "answer": {
                    "sdp": self.pc.localDescription.sdp,
                    "type": self.pc.localDescription.type,
                },
            },
            timeout=5
        )

        try:
            while self.running:
                await asyncio.sleep(1)
        finally:
            await self.__handle_shutdown()
            try:
                self.loop.stop()
            except Exception:
                pass

    # HELPERS
    async def __send_termination(self):
        if not self.pc:
            return

        for channel in self.data_channels:
            if channel.readyState == "open":
                channel.send('{"type":"terminate","source":"linux"}')

    def __poll_for_offer(self, code, timeout_s=60):
        deadline = time.monotonic() + timeout_s
        while self.running and time.monotonic() < deadline:
            r = requests.post(self.CHECK_OFFER_URL, json={"code": code}, timeout=5)
            if r.status_code == 200 and r.json().get("offer"):
                return r.json()["offer"]
            for _ in range(10):
                if not self.running:
                    return None
                time.sleep(0.1)
        return None

    def __get_ice_configuration(self):
        resp = requests.post(self.GET_TURN_URL, json={}, timeout=5)
        raw = resp.json()

        servers = []
        for s in raw:
            servers.append(
                RTCIceServer(
                    urls=s.get("urls") or s.get("url"),
                    username=s.get("username"),
                    credential=s.get("credential"),
                )
            )
        return RTCConfiguration(iceServers=servers)

    # TRACK HANDLER
    async def __handle_video_track(self, track: MediaStreamTrack):
        try:
            while self.running:
                frame = await track.recv()
                if not isinstance(frame, VideoFrame):
                    continue

                img = frame.to_ndarray(format="bgr24")

                # Non-blocking enqueue, drop-oldest on overflow (per frame)
                try:
                    self.video_queue.put_nowait(img)
                except queue.Full:
                    try:
                        _ = self.video_queue.get_nowait()
                    except queue.Empty:
                        pass
                    try:
                        self.video_queue.put_nowait(img)
                    except queue.Full:
                        pass

                # Preview throttle (also per frame)
                now = time.monotonic()
                if now - self.last_preview_ts >= self.preview_interval:
                    self.last_preview_ts = now
                    self.video_frame_received.emit(img)

        except asyncio.CancelledError:
            pass
        except Exception as e:
            print("Track recv error:", repr(e))

    async def __handle_audio_track(self, track: MediaStreamTrack):
        try:
            frame = await track.recv()
            if not isinstance(frame, AudioFrame):
                return
            rate = frame.sample_rate
            pcm = frame.to_ndarray()

            # WebRTC aiortc: channels from layout OR detect planar/interleaved
            if hasattr(frame, "layout") and frame.layout:
                channels = frame.layout.nb_channels
            elif pcm.ndim == 2 and pcm.shape[0] == 1:  # (1, samples) -> mono planar
                channels = 1
            elif pcm.ndim == 2:
                channels = pcm.shape[1] if pcm.shape[1] <= 8 else 1  # Safety
            else:
                channels = 1

            print(f"pcm.shape={pcm.shape}, channels={channels}")
            if not self.virtual_mic_thread:
                self.virtual_mic_thread = VirtualMicThread(
                    audio_queue=self.audio_queue,
                    running_flag=lambda: self.running,
                    rate=rate,
                    channels=channels,
                )
                self.virtual_mic_thread.start()
            
            try:
                self.audio_queue.put_nowait(pcm)
            except queue.Full:
                try:
                    _ = self.audio_queue.get_nowait()
                except queue.Empty:
                    pass
                try:
                    self.audio_queue.put_nowait(pcm)
                except queue.Full:
                    pass
        
            while self.running:
                frame = await track.recv()
                if not isinstance(frame, AudioFrame):
                    continue

                pcm = frame.to_ndarray()

                self._audio_frames += 1
                # if self._audio_frames % 50 == 0:
                #     a = pcm.astype(np.float32, copy=False)
                #     rms = float(np.sqrt(np.mean(a * a))) if a.size else 0.0
                #     print("[AUDIO] frames:", self._audio_frames,
                #         "shape:", pcm.shape, "dtype:", pcm.dtype,
                #         "rms:", rms, "sr:", frame.sample_rate,
                #         "layout:", getattr(frame.layout, "name", None),
                #         "fmt:", getattr(frame.format, "name", None))

                # then your queueing (convert later in mic thread)
                try:
                    self.audio_queue.put_nowait(pcm)
                except queue.Full:
                    try:
                        _ = self.audio_queue.get_nowait()
                    except queue.Empty:
                        pass
                    try:
                        self.audio_queue.put_nowait(pcm)
                    except queue.Full:
                        pass

        except asyncio.CancelledError:
            pass
        except Exception as e:
            print("Audio track error:", repr(e))
