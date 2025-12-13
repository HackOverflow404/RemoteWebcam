import threading
import time
import pyvirtualcam
from pyvirtualcam import PixelFormat
import cv2

OUTPUT_WIDTH = 1280
OUTPUT_HEIGHT = 720

class VirtualCamThread(threading.Thread):
    def __init__(self, frame_queue, running_flag, fps=20):
        super().__init__(daemon=True)
        self.frame_queue = frame_queue
        self.running_flag = running_flag
        self.fps = fps
        self.cam = None

    def run(self):
        try:
            # Create camera ONCE with fixed resolution
            self.cam = pyvirtualcam.Camera(
                width=OUTPUT_WIDTH,
                height=OUTPUT_HEIGHT,
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

                # FORCE resolution (critical)
                if img.shape[1] != OUTPUT_WIDTH or img.shape[0] != OUTPUT_HEIGHT:
                    img = cv2.resize(img, (OUTPUT_WIDTH, OUTPUT_HEIGHT))

                # Convert BGR → YUYV
                img_yuyv = cv2.cvtColor(img, cv2.COLOR_BGR2YUV_YUY2)

                self.cam.send(img_yuyv)
                self.cam.sleep_until_next_frame()

        finally:
            if self.cam:
                self.cam.close()
                print("[VirtualCam] Closed")