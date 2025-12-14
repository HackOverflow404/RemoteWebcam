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
import cv2
from enum import Enum
import json
from collections import deque
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

    def __init__(self, code: str, widget_win_id: int):
        super().__init__()
        self.loop = None
        self.running = False
        self.shutting_down = False
        
        self.pc = None
        self.code = code
        self.data_channels = set()
        
        self.last_preview_ts = 0
        self.video_track_task = None
        self.VIRTUAL_CAM_WIDTH = 1280
        self.VIRTUAL_CAM_HEIGHT = 720
        self.virtual_cam_thread = None
        self.preview_interval = 1 / 10
        self.frame_queue = deque(maxlen=2)
        
        self.audio_track_task = None
        self.virtual_mic_thread = None
        self.audio_queue = queue.Queue(maxsize=10)

        self.CHECK_OFFER_URL = "https://checkoffer-qaf2yvcrrq-uc.a.run.app"
        self.SUBMIT_ANSWER_URL = "https://submitanswer-qaf2yvcrrq-uc.a.run.app"
        self.GET_TURN_URL = "https://getturncredentials-qaf2yvcrrq-uc.a.run.app"

    # --------------------
    # PUBLIC API
    # --------------------

    def start(self):
        if self.running:
            return

        self.running = True
        threading.Thread(target=self._run_async_thread, daemon=True).start()
        self.connection_state_changed.emit(ConnectionState.CONNECTING)

    def stop(self):
        self.running = False
        if self.loop and self.loop.is_running():
            self.loop.call_soon_threadsafe(
                lambda: asyncio.create_task(self._shutdown())
            )

    # --------------------
    # THREAD / LOOP SETUP
    # --------------------

    def _run_async_thread(self):
        asyncio.run(self._run())

    async def _shutdown(self):
        if self.shutting_down:
            return
        self.shutting_down = True

        try:
            await self.send_termination()
        except Exception:
            pass

        if self.video_track_task:
            self.video_track_task.cancel()
            self.video_track_task = None
        
        if self.audio_track_task:
            self.audio_track_task.cancel()
            self.audio_track_task = None

        for ch in self.data_channels:
            try:
                ch.close()
            except Exception:
                pass
        self.data_channels.clear()

        if self.pc:
            await self.pc.close()
            self.pc = None

        self.running = False
        self.virtual_cam_thread = None
        self.virtual_mic_thread = None
        self.connection_state_changed.emit(ConnectionState.DISCONNECTED)

    # --------------------
    # MAIN WEBRTC FLOW
    # --------------------

    async def _run(self):
        self.loop = asyncio.get_running_loop()

        print("Waiting for JS offer…")
        offer_json = await asyncio.to_thread(self.poll_for_offer, self.code)
        if not self.running:
            return

        offer = RTCSessionDescription(
            sdp=offer_json["sdp"],
            type=offer_json["type"],
        )
        print("Got JS offer")

        config = self.get_ice_configuration()
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
                self.running = False
            elif state == "closed":
                self.running = False

        @self.pc.on("track")
        def on_track(track):
            if track.kind == "video":
                self.video_track_task = asyncio.create_task(self.handle_video_track(track))

                if not self.virtual_cam_thread:
                    self.virtual_cam_thread = VirtualCamThread(
                        frame_queue=self.frame_queue,
                        running_flag=lambda: self.running,
                        width=self.VIRTUAL_CAM_WIDTH,
                        height=self.VIRTUAL_CAM_HEIGHT,
                        fps=20,
                    )
                    self.virtual_cam_thread.start()
            elif track.kind == "audio":
                self.audio_track_task = asyncio.create_task(self.handle_audio_track(track))

                if not self.virtual_mic_thread:
                    self.virtual_mic_thread = VirtualMicThread(
                        audio_queue=self.audio_queue,
                        running_flag=lambda: self.running,
                    )
                    self.virtual_mic_thread.start()

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
                    await self._shutdown()

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
        )

        try:
            while self.running:
                await asyncio.sleep(1)
        finally:
            await self._shutdown()

    # --------------------
    # HELPERS
    # --------------------
    async def send_termination(self):
        if not self.pc:
            return

        for channel in self.data_channels:
            if channel.readyState == "open":
                channel.send('{"type":"terminate","source":"linux"}')

    def poll_for_offer(self, code):
        while self.running:
            r = requests.post(self.CHECK_OFFER_URL, json={"code": code})
            if r.status_code == 200 and r.json().get("offer"):
                return r.json()["offer"]
            for _ in range(10):
                if not self.running:
                    return None
                time.sleep(0.1)
        return None

    def get_ice_configuration(self):
        resp = requests.post(self.GET_TURN_URL, json={})
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
    
    def letterbox(self, img, out_w, out_h):
        h, w = img.shape[:2]

        scale = min(out_w / w, out_h / h)
        new_w = int(w * scale)
        new_h = int(h * scale)

        resized = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)

        canvas = np.zeros((out_h, out_w, 3), dtype=np.uint8)

        x_off = (out_w - new_w) // 2
        y_off = (out_h - new_h) // 2

        canvas[y_off:y_off + new_h, x_off:x_off + new_w] = resized
        return canvas

    # --------------------
    # TRACK HANDLER (FIXED)
    # --------------------
    async def handle_video_track(self, track: MediaStreamTrack):
        try:
            while self.running:
                frame = await track.recv()

                if not isinstance(frame, VideoFrame):
                    continue

                img = frame.to_ndarray(format="bgr24")

                # Adaptive letterboxing to fixed output size
                img = self.letterbox(
                    img,
                    self.VIRTUAL_CAM_WIDTH,
                    self.VIRTUAL_CAM_HEIGHT,
                )

                # Non-blocking enqueue (always same shape now)
                self.frame_queue.append(img)

                # Preview throttle
                now = time.monotonic()
                if now - self.last_preview_ts >= self.preview_interval:
                    self.last_preview_ts = now
                    self.video_frame_received.emit(img)

        except asyncio.CancelledError:
            pass
        except Exception as e:
            print("Track recv error:", e)
    
    async def handle_audio_track(self, track: MediaStreamTrack):
        try:
            while self.running:
                frame = await track.recv()

                if not isinstance(frame, AudioFrame):
                    continue

                pcm = frame.to_ndarray()

                # Shape normalization:
                # aiortc gives (channels, samples)
                if pcm.ndim == 2:
                    pcm = pcm.T  # → (samples, channels)

                # Convert int16 → float32 if needed
                if pcm.dtype == np.int16:
                    pcm = pcm.astype(np.float32) / 32768.0

                # Enqueue non-blocking
                try:
                    self.audio_queue.put_nowait(pcm)
                except queue.Full:
                    pass

        except asyncio.CancelledError:
            pass
        except Exception as e:
            print("Audio track error:", e)