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
        self.offer = None
        self.pc = None
        self.running = False
        self.GENERATE_CODE_URL = "https://generatecode-qaf2yvcrrq-uc.a.run.app"
        self.CHECK_OFFER_URL = "https://checkoffer-qaf2yvcrrq-uc.a.run.app"
        self.SUBMIT_ANSWER_URL = "https://submitanswer-qaf2yvcrrq-uc.a.run.app"
        self.GET_TURN_URL = "https://getturncredentials-qaf2yvcrrq-uc.a.run.app"

    def start(self):
        self.running = True
        threading.Thread(target=self._run_async_thread, daemon=True).start()
        self.connection_state_changed.emit(ConnectionState.CONNECTING)

    def stop(self):
        self.running = False
        if self.pc:
            if self.pc and hasattr(self, "loop"):
                asyncio.run_coroutine_threadsafe(self.pc.close(), self.loop)
        self.connection_state_changed.emit(ConnectionState.DISCONNECTED)

    def _run_async_thread(self):
        asyncio.run(self._run())

    async def _run(self):
        # if await self.poll_for_offer() == 1:
        #     return
        # if not self.offer:
        #     self.connection_state_changed.emit(ConnectionState.FAILED)
        #     return

        self.loop = asyncio.get_running_loop()

        print("⏳ Waiting for JS offer…")
        offer_json = await asyncio.to_thread(self.poll_for_offer, self.code)
        offer = RTCSessionDescription(sdp=offer_json["sdp"], type=offer_json["type"])
        print("✅ Got JS offer")

        # ice_servers = self.fetch_ice_servers()
        # print("[TURN] Using ICE servers:", ice_servers)
        # config = RTCConfiguration(iceServers = ice_servers)
        config = self.get_ice_configuration()
        self.pc = RTCPeerConnection(configuration=config)
        self.pc.addTransceiver("video", direction="recvonly")
        self.pc.addTransceiver("audio", direction="recvonly")

        @self.pc.on("connectionstatechange")
        async def on_connectionstatechange():
            state = self.pc.connectionState
            print(f"[WebRTC] State: {state}")
            match state:
                case "connected":
                    self.connection_state_changed.emit(ConnectionState.CONNECTED)
                    print("🔗 DataChannel is open! Listening 30s…")
                    print("🏁 Done.")
                case "closed":
                    self.connection_state_changed.emit(ConnectionState.DISCONNECTED)
                case "failed":
                    self.connection_state_changed.emit(ConnectionState.FAILED)
                case "connecting":
                    self.connection_state_changed.emit(ConnectionState.CONNECTING)

        @self.pc.on("track")
        def on_track(track):
            print(f"[WebRTC] Track received: {track.kind}")
            if track.kind == "video":
                self.loop.create_task(self.handle_track(track))
            elif track.kind == "audio":
                print("[WebRTC] Audio track received")

        @self.pc.on("datachannel")
        def on_datachannel(channel):
            @channel.on("message")
            def on_message(msg):
                print("📥 from JS:", msg)
                channel.send("Hello from Python!")

        @self.pc.on("iceconnectionstatechange")
        async def on_iceconnchange():
            print("[WebRTC] ICE connection state:", self.pc.iceConnectionState)

        # Prepare a Future to be resolved when ICE gathering is done
        self.ice_complete = self.loop.create_future()
        
        @self.pc.on("icegatheringstatechange")
        async def on_icegatheringstatechange():
            print("[WebRTC] ICE gathering state:", self.pc.iceGatheringState)
            if self.pc.iceGatheringState == "complete":
                if not self.ice_complete.done():
                    self.ice_complete.set_result(True)

        # Set the remote SDP
        await self.pc.setRemoteDescription(offer)

        # Create the answer
        answer = await self.pc.createAnswer()
        print("[WebRTC] Created answer:", answer)

        # Start ICE gathering by setting the local description
        await self.pc.setLocalDescription(answer)

        # Now wait for ICE gathering to complete
        await self.ice_complete

        # Send the fully-formed answer SDP (includes ICE candidates)
        # self.send_answer(self.pc.localDescription)
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

    # async def poll_for_offer(self):
    #     self.poll_attempt = 0
    #     self.max_attempts = 30
    #     self.base_delay = 1.0
    #     self.max_delay = 30.0

    #     while self.poll_attempt < self.max_attempts:
    #         if not self.running or self.code is None:
    #             print("🛑 Polling stopped.")
    #             self.connection_state_changed.emit(ConnectionState.DISCONNECTED)
    #             return 1

    #         print(f"[Polling] Attempt {self.poll_attempt + 1}")
    #         try:
    #             response = requests.post(
    #                 "https://checkoffer-qaf2yvcrrq-uc.a.run.app",
    #                 json = {"code": self.code},
    #                 timeout=5
    #             )
    #             if response.status_code == 200:
    #                 print("✅ Offer received!")
    #                 self.offer = response.json().get("offer")
    #                 self.connection_state_changed.emit(ConnectionState.CONNECTING)
    #                 return 0
    #             elif response.status_code == 204:
    #                 print("🕐 Not ready yet...")
    #             else:
    #                 print(f"⚠️ Unexpected status: {response.status_code}")
    #         except Exception as e:
    #             print(f"❌ Poll error: {e}")

    #         self.poll_attempt += 1
    #         delay = random.uniform(0, min(self.max_delay, self.base_delay * (2 ** self.poll_attempt)))
    #         print(f"🔁 Retrying in {delay:.2f} seconds...")
    #         await asyncio.sleep(delay)

    #     print("⛔ Gave up waiting for offer.")
    #     self.connection_state_changed.emit(ConnectionState.FAILED)

    def poll_for_offer(self, code):
        while True:
            r = requests.post(self.CHECK_OFFER_URL, json={"code": code})
            if r.status_code == 200 and r.json().get("offer"):
                return r.json()["offer"]
            time.sleep(1)

    def get_ice_configuration(self):
        resp = requests.post(self.GET_TURN_URL, json={})
        raw = resp.json()
        ice_servers = []
        for s in raw:
            urls = s.get("urls") or s.get("url")
            ice_servers.append(
                RTCIceServer(
                    urls=urls,
                    username=s.get("username"),
                    credential=s.get("credential"),
                )
            )
        return RTCConfiguration(iceServers=ice_servers)

    def fetch_ice_servers(self):
        try:
            response = requests.post(
                "https://getturncredentials-qaf2yvcrrq-uc.a.run.app", timeout=10
            )
            response.raise_for_status()
            data = response.json()

            print(f"[WebRTC] Fetched ICE servers: {data}")

            ice_servers = []
            for server in data:
                ice_servers.append(
                    RTCIceServer(
                        urls=server["urls"],
                        username=server.get("username"),
                        credential=server.get("credential"),
                    )
                )
            return ice_servers
        except Exception as e:
            print(f"❌ Failed to fetch TURN credentials: {e}")
            return []

    def send_answer(self, sdp):
        print(sdp)
        try:
            res = requests.post(
                "https://submitanswer-qaf2yvcrrq-uc.a.run.app",
                json={
                    "code": self.code,
                    "answer": {"sdp": sdp.sdp, "type": sdp.type},
                },
                timeout=10,
            )
            if res.status_code == 200:
                print("[WebRTC] Answer submitted successfully")
            else:
                print(f"[WebRTC] Answer submission failed: {res.status_code}")
        except Exception as e:
            print(f"[WebRTC] Answer error: {e}")

    async def handle_track(self, track: MediaStreamTrack):
        print("Inside handle track")
        self.track = track
        frame_count = 0
        while True:
            try:
                print("Waiting for frame...")
                frame = await asyncio.wait_for(track.recv(), timeout=5.0)
                frame_count += 1
                print(f"Received frame {frame_count}")

                if isinstance(frame, VideoFrame):
                    print(
                        f"Frame type: VideoFrame, pts: {frame.pts}, time_base: {frame.time_base}"
                    )
                    frame = frame.to_ndarray(format="bgr24")
                elif isinstance(frame, np.ndarray):
                    print(f"Frame type: numpy array")
                else:
                    print(f"Unexpected frame type: {type(frame)}")
                    continue

                # Add timestamp to the frame
                current_time = datetime.now()
                new_time = current_time - timedelta(seconds=55)
                timestamp = new_time.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
                cv2.putText(
                    frame,
                    timestamp,
                    (10, frame.shape[0] - 30),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    1,
                    (0, 255, 0),
                    2,
                    cv2.LINE_AA,
                )
                cv2.imwrite(f"imgs/received_frame_{frame_count}.jpg", frame)
                print(f"Saved frame {frame_count} to file")
                cv2.imshow("Frame", frame)

                # Exit on 'q' key press
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
            except asyncio.TimeoutError:
                print("Timeout waiting for frame, continuing...")
            except Exception as e:
                print(f"Error in handle_track: {str(e)}")
                if "Connection" in str(e):
                    break

        print("Exiting handle_track")
        await self.pc.close()
