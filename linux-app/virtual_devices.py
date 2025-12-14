import threading
import time
import pyvirtualcam
from pyvirtualcam import PixelFormat
import cv2
import subprocess
import queue
import numpy as np


class VirtualCamThread(threading.Thread):
    def __init__(self, frame_queue, running_flag, width=1280, height=720, fps=20):
        super().__init__(daemon=True)
        self.frame_queue = frame_queue
        self.running_flag = running_flag
        self.fps = fps
        self.cam = None
        self.width = width
        self.height = height

    def run(self):
        try:
            # Create camera ONCE with fixed resolution
            self.cam = pyvirtualcam.Camera(
                width=self.width,
                height=self.height,
                fps=self.fps,
                fmt=PixelFormat.YUYV,
                print_fps=True,
            )
            print("[VirtualCam] Device:", self.cam.device)

            while self.running_flag():
                if not self.frame_queue:
                    time.sleep(0.005)
                    continue

                img = self.frame_queue.popleft()

                if img.shape[1] != self.width or img.shape[0] != self.height:
                    img = cv2.resize(img, (self.width, self.height))

                # Convert BGR → YUYV
                img_yuyv = cv2.cvtColor(img, cv2.COLOR_BGR2YUV_YUY2)

                self.cam.send(img_yuyv)
                self.cam.sleep_until_next_frame()

        finally:
            if self.cam:
                self.cam.close()
                print("[VirtualCam] Closed")


class VirtualMicThread(threading.Thread):
    def __init__(self, audio_queue, running_flag, sink_name="pixel_streamer_sink"):
        super().__init__(daemon=True)
        self.audio_queue = audio_queue
        self.running_flag = running_flag
        self.sink_name = sink_name
        self.proc = None

        self.SAMPLE_RATE = 48000
        self.CHANNELS = 2

    def run(self):
        try:
            self.proc = subprocess.Popen(
                [
                    "pw-cat",
                    "--playback",
                    "--format", "f32",
                    "--rate", str(self.SAMPLE_RATE),
                    "--channels", str(self.CHANNELS),
                    "--target", self.sink_name,
                ],
                stdin=subprocess.PIPE,
            )

            print("[VirtualMic] pw-cat connected to", self.sink_name)

            while self.running_flag():
                try:
                    frame = self.audio_queue.get(timeout=0.05)
                except queue.Empty:
                    continue

                if frame.shape[1] == 1:
                    frame = np.repeat(frame, 2, axis=1)

                self.proc.stdin.write(frame.astype(np.float32).tobytes())
                self.proc.stdin.flush()

        finally:
            if self.proc:
                self.proc.terminate()
                print("[VirtualMic] Closed")