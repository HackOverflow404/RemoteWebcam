import asyncio
import json
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
import numpy as np
from datetime import datetime, timedelta
from enum import Enum
import random
import logging

logging.basicConfig(level=logging.DEBUG)


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
        self.code = code
        self.pc = None
        self.running = False
        self.loop = None
        self.track_task = None

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

        self.connection_state_changed.emit(ConnectionState.DISCONNECTED)

    # --------------------
    # THREAD / LOOP SETUP
    # --------------------

    def _run_async_thread(self):
        asyncio.run(self._run())

    async def _shutdown(self):
        if self.track_task:
            self.track_task.cancel()
            self.track_task = None

        if self.pc:
            await self.pc.close()
            self.pc = None

    # --------------------
    # MAIN WEBRTC FLOW
    # --------------------

    async def _run(self):
        self.loop = asyncio.get_running_loop()

        print("⏳ Waiting for JS offer…")
        offer_json = await asyncio.to_thread(self.poll_for_offer, self.code)
        if not self.running:
            return

        offer = RTCSessionDescription(
            sdp=offer_json["sdp"],
            type=offer_json["type"],
        )
        print("✅ Got JS offer")

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
                await self._shutdown()
            elif state == "closed":
                self.connection_state_changed.emit(ConnectionState.DISCONNECTED)

        @self.pc.on("track")
        def on_track(track):
            if track.kind == "video":
                self.track_task = asyncio.create_task(
                    self.handle_track(track)
                )

        @self.pc.on("datachannel")
        def on_datachannel(channel):
            @channel.on("message")
            def on_message(msg):
                channel.send("Hello from Python!")

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

        while self.running:
            await asyncio.sleep(1)

        await self._shutdown()

    # --------------------
    # HELPERS
    # --------------------

    def poll_for_offer(self, code):
        while self.running:
            r = requests.post(self.CHECK_OFFER_URL, json={"code": code})
            if r.status_code == 200 and r.json().get("offer"):
                return r.json()["offer"]
            time.sleep(1)
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

    # --------------------
    # TRACK HANDLER (FIXED)
    # --------------------

    async def handle_track(self, track: MediaStreamTrack):
        frame_count = 0

        try:
            while self.running:
                frame = await track.recv()
                frame_count += 1

                if isinstance(frame, VideoFrame):
                    frame = frame.to_ndarray(format="bgr24")

                timestamp = datetime.now().strftime("%H:%M:%S.%f")[:-3]
                cv2.putText(
                    frame,
                    timestamp,
                    (10, frame.shape[0] - 30),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    1,
                    (0, 255, 0),
                    2,
                )

                self.video_frame_received.emit(frame)

        except asyncio.CancelledError:
            pass
        except Exception as e:
            print("Track error:", e)