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




def _run(cmd):
    return subprocess.run(cmd, check=False, capture_output=True, text=True)


def _pactl_has(kind: str, name: str) -> bool:
    # kind: "sinks" or "sources"
    r = _run(["pactl", "list", "short", kind])
    if r.returncode != 0:
        return False
    for line in r.stdout.splitlines():
        # columns: index \t name \t driver \t ...
        parts = line.split("\t")
        if len(parts) >= 2 and parts[1].strip() == name:
            return True
    return False


def _pactl_load_module(args: list[str]) -> int | None:
    r = _run(["pactl", "load-module", *args])
    if r.returncode != 0:
        return None
    # pactl prints module id on stdout
    try:
        return int(r.stdout.strip())
    except Exception:
        return None


def _wpctl_find_node_id_by_name(name: str) -> str | None:
    """
    Try to resolve a PipeWire node id for pw-cat --target.
    We search wpctl status output for an exact-ish sink match.
    """
    r = _run(["wpctl", "status"])
    if r.returncode != 0:
        return None

    lines = r.stdout.splitlines()

    in_sinks = False
    for ln in lines:
        if "Sinks:" in ln:
            in_sinks = True
            continue
        if in_sinks and ("Sources:" in ln or "Sink endpoints:" in ln or "Clients:" in ln):
            in_sinks = False
        if not in_sinks:
            continue

        # Typical format: "  * 45. PixelStreamer_Sink [vol: ...]"
        # or:           "    45. pixel_streamer_sink"
        s = ln.strip()
        if not s:
            continue

        # Pull leading id like "45." or "* 45."
        s2 = s.lstrip("*").strip()
        if "." not in s2:
            continue

        id_part, rest = s2.split(".", 1)
        id_part = id_part.strip()
        rest = rest.strip()

        if not id_part.isdigit():
            continue

        # match either the sink_name or the description containing it
        if name in rest:
            return id_part

    return None


class VirtualMicThread(threading.Thread):
    """
    Streams audio frames into a virtual sink, and exposes a virtual mic source.

    - Creates (if missing):
        * null sink:   <sink_name>
        * remap source <mic_name> that uses master=<sink_name>.monitor

    - Sends audio to <sink_name> using pw-cat in playback mode.

    Apps should pick <mic_name> as the microphone.
    """
    def __init__(
        self,
        audio_queue: "queue.Queue",
        running_flag,
        sink_name: str = "pixel_streamer_sink",
        mic_name: str = "pixel_streamer_mic",
        sample_rate: int = 48000,
        channels: int = 2,
        latency_ms: int = 50,
    ):
        super().__init__(daemon=True)
        self.audio_queue = audio_queue
        self.running_flag = running_flag
        self.sink_name = sink_name
        self.mic_name = mic_name
        self.sample_rate = sample_rate
        self.channels = channels
        self.latency_ms = latency_ms

        self._proc = None
        self._mod_sink = None
        self._mod_mic = None

    def _ensure_virtual_devices(self):
        # Create virtual sink if missing
        if not _pactl_has("sinks", self.sink_name):
            self._mod_sink = _pactl_load_module([
                "module-null-sink",
                f"sink_name={self.sink_name}",
                'sink_properties=device.description=PixelStreamer_Sink',
            ])
            if self._mod_sink is None:
                raise RuntimeError("Failed to load module-null-sink (is pipewire-pulse/pulseaudio running?)")

        # Create virtual mic (remap source from sink monitor) if missing
        if not _pactl_has("sources", self.mic_name):
            self._mod_mic = _pactl_load_module([
                "module-remap-source",
                f"master={self.sink_name}.monitor",
                f"source_name={self.mic_name}",
                'source_properties=device.description=PixelStreamer_Mic',
            ])
            if self._mod_mic is None:
                raise RuntimeError("Failed to load module-remap-source")

    def _start_pwcat(self):
        # pw-cat --target accepts node.name or object.serial; try id first, fall back to sink name
        target = _wpctl_find_node_id_by_name(self.sink_name) or self.sink_name

        self._proc = subprocess.Popen(
            [
                "pw-cat",
                "--playback",
                "--format", "f32",                 # valid: u8/s8/s16/s24/s32/f32/f64 :contentReference[oaicite:2]{index=2}
                "--rate", str(self.sample_rate),
                "--channels", str(self.channels),
                "--latency", f"{self.latency_ms}ms",
                "--target", str(target),           # node.name or id/serial :contentReference[oaicite:3]{index=3}
                "-",                               # read raw PCM from stdin
            ],
            stdin=subprocess.PIPE,
            bufsize=0,  # unbuffered for lower latency
        )

        print(f"[VirtualMic] pw-cat -> target={target} (sink={self.sink_name}, mic={self.mic_name})")

    @staticmethod
    def _to_f32_interleaved(frame: np.ndarray, channels: int) -> bytes:
        # Accept: (N,), (N,1), (N,2), (2,N) etc.
        x = np.asarray(frame)

        if x.ndim == 1:
            x = x.reshape(-1, 1)

        # If shape is (C, N), transpose to (N, C)
        if x.shape[0] in (1, 2, 6, 8) and x.shape[1] > x.shape[0] and x.shape[1] > 64:
            # heuristic: treat as (C,N)
            if x.shape[0] <= 8:
                x = x.T

        # Now x is (N, C?)
        if x.shape[1] == 1 and channels == 2:
            x = np.repeat(x, 2, axis=1)
        elif x.shape[1] != channels:
            # Simple fallback: up/down-mix by truncation or repetition
            if x.shape[1] > channels:
                x = x[:, :channels]
            else:
                x = np.repeat(x, channels, axis=1)

        # Convert to float32 in [-1, 1] if it looks like int16 PCM
        if np.issubdtype(x.dtype, np.integer):
            # assume int16-ish
            x = x.astype(np.float32) / 32768.0
        else:
            x = x.astype(np.float32)

        # Avoid NaNs / clamp
        np.nan_to_num(x, copy=False)
        np.clip(x, -1.0, 1.0, out=x)

        # Interleaved (N,C) in C-order -> bytes are L0R0L1R1...
        return np.ascontiguousarray(x).tobytes()

    def run(self):
        try:
            self._ensure_virtual_devices()
            self._start_pwcat()

            while self.running_flag():
                if self._proc is None or self._proc.poll() is not None:
                    # Restart if pw-cat died
                    try:
                        self._start_pwcat()
                    except Exception as e:
                        print("[VirtualMic] pw-cat restart failed:", e)
                        time.sleep(0.25)
                        continue

                try:
                    frame = self.audio_queue.get(timeout=0.05)
                except queue.Empty:
                    continue

                if frame is None:
                    continue

                try:
                    payload = self._to_f32_interleaved(frame, self.channels)
                    self._proc.stdin.write(payload)
                except (BrokenPipeError, OSError):
                    # pw-cat likely died; loop will restart it
                    try:
                        self._proc.terminate()
                    except Exception:
                        pass
                    self._proc = None

        finally:
            if self._proc:
                try:
                    self._proc.terminate()
                except Exception:
                    pass
                self._proc = None

            # Optional: unload modules we created (only if we created them)
            # If you want them to persist across runs, remove this block.
            if self._mod_mic is not None:
                _run(["pactl", "unload-module", str(self._mod_mic)])
            if self._mod_sink is not None:
                _run(["pactl", "unload-module", str(self._mod_sink)])

            print("[VirtualMic] Closed")
