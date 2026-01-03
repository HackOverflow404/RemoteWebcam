import threading
import time
import pyvirtualcam
from pyvirtualcam import PixelFormat
import cv2
import subprocess
import queue
import numpy as np
import shlex

class VirtualCamThread(threading.Thread):
    def __init__(self, frame_queue, running_flag, width, height, fps=60):
        super().__init__(daemon=True)
        self.cam = None
        self.q = frame_queue
        self.running_flag = running_flag
        self.width, self.height, self.fps = width, height, fps

    def run(self):
        try:
            last = np.zeros((self.height, self.width, 3), dtype=np.uint8)  # black until first frame

            with pyvirtualcam.Camera(
                width=self.width, height=self.height, fps=self.fps,
                fmt=PixelFormat.BGR, print_fps=True
            ) as self.cam:
                while self.running_flag():
                    # Keep only the newest frame (drop backlog)
                    try:
                        while True:
                            last = self.q.get_nowait()
                    except queue.Empty:
                        pass

                    if last.shape[1] != self.width or last.shape[0] != self.height:
                        last = cv2.resize(last, (self.width, self.height), interpolation=cv2.INTER_LINEAR)
                    self.cam.send(last)
                    self.cam.sleep_until_next_frame()

        finally:
            if self.cam:
                self.cam.close()
                print("[VirtualCam] Closed")

class VirtualMicThread(threading.Thread):
    def __init__(self, audio_queue: "queue.Queue", running_flag, rate=48000, channels=2):
        super().__init__(daemon=True)
        self.audio_queue = audio_queue
        self.running_flag = running_flag
        self.rate = rate
        self.channels = channels

        self.sink_name = "pixel_mic_sink"
        self.source_name = "pixel_mic"

        self._mod_sink_id = None
        self._mod_source_id = None
        self._pwcat = None

    # ---------- PipeWire/Pulse module helpers ----------
    def _pactl_load(self, args: str) -> int:
        # returns module id (int)
        out = subprocess.check_output(["pactl", "load-module"] + shlex.split(args), text=True)
        return int(out.strip())

    def _pactl_unload(self, mod_id: int) -> None:
        if mod_id is None:
            return
        try:
            subprocess.check_call(["pactl", "unload-module", str(mod_id)])
        except Exception:
            pass

    def _setup_virtual_mic(self):
        # 1) null sink
        self._mod_sink_id = self._pactl_load(
            f"module-null-sink sink_name={self.sink_name} "
            f'sink_properties=device.description="PixelStreamer Mic Sink" '
            f"rate={self.rate} channels={self.channels} channel_map=stereo"
        )
        # 2) remap source from sink.monitor
        self._mod_source_id = self._pactl_load(
            f"module-remap-source master={self.sink_name}.monitor "
            f"source_name={self.source_name} "
            f'source_properties=device.description="PixelStreamer Virtual Mic" '
            f"rate={self.rate} channels={self.channels} channel_map=stereo"
        )

    def _teardown_virtual_mic(self):
        self._pactl_unload(self._mod_source_id)
        self._pactl_unload(self._mod_sink_id)
        self._mod_source_id = None
        self._mod_sink_id = None

    # ---------- audio conversion ----------
    def _to_interleaved_s16_stereo(self, pcm: np.ndarray) -> bytes:
        """
        Accepts common shapes:
          - (channels, samples)  (planar)
          - (samples, channels)  (interleaved)
          - (samples,) mono
        Accepts int16 or float32. If float looks normalized [-1,1], scale to int16.
        """
        a = np.asarray(pcm)

        # Make it (samples, channels)
        if a.ndim == 1:
            a = a[:, None]  # (samples, 1)
        elif a.ndim == 2:
            # Heuristic: if first dim is small (1/2) and second is large, treat as (channels, samples)
            if a.shape[0] in (1, 2) and a.shape[1] > a.shape[0]:
                a = a.T  # -> (samples, channels)
        else:
            # Unexpected; drop
            return b""

        # Force stereo
        if a.shape[1] == 1 and self.channels == 2:
            a = np.repeat(a, 2, axis=1)
        elif a.shape[1] >= 2 and self.channels == 2:
            a = a[:, :2]
        elif a.shape[1] != self.channels:
            # basic fallback: crop or pad with zeros
            if a.shape[1] > self.channels:
                a = a[:, :self.channels]
            else:
                pad = np.zeros((a.shape[0], self.channels - a.shape[1]), dtype=a.dtype)
                a = np.concatenate([a, pad], axis=1)

        # Convert to int16
        if a.dtype == np.int16:
            s16 = a
        else:
            a = a.astype(np.float32, copy=False)
            peak = float(np.max(np.abs(a))) if a.size else 0.0

            # If it looks normalized, scale; otherwise assume it's already "int16-like" floats
            if peak <= 1.5:
                a = np.clip(a, -1.0, 1.0) * 32767.0
            else:
                a = np.clip(a, -32768.0, 32767.0)

            s16 = a.astype(np.int16)

        # Interleaved little-endian s16 frames
        return s16.reshape(-1).tobytes(order="C")

    # ---------- main thread ----------
    def run(self):
        try:
            self._setup_virtual_mic()

            # Pipe raw PCM into the null sink; apps record from remapped source.
            # pw-cat raw stdin expects you to specify rate/channels/format. :contentReference[oaicite:6]{index=6}
            self._pwcat = subprocess.Popen(
                [
                    "pw-cat",
                    "--playback",
                    f"--target={self.sink_name}",
                    f"--rate={self.rate}",
                    f"--channels={self.channels}",
                    "--format=s16",
                    "-",  # stdin
                ],
                stdin=subprocess.PIPE,
            )

            while self.running_flag():
                try:
                    pcm = self.audio_queue.get(timeout=0.05)
                except queue.Empty:
                    continue

                if self._pwcat.poll() is not None:
                    # pw-cat died
                    break

                data = self._to_interleaved_s16_stereo(pcm)
                if not data:
                    continue

                try:
                    self._pwcat.stdin.write(data)
                except BrokenPipeError:
                    break

        finally:
            try:
                if self._pwcat and self._pwcat.stdin:
                    self._pwcat.stdin.close()
                if self._pwcat:
                    self._pwcat.terminate()
            except Exception:
                pass
            self._teardown_virtual_mic()