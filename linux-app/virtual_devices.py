"""
Virtual camera (v4l2loopback) and virtual microphone (PipeWire) outputs.

Both devices live for the whole app session rather than per WebRTC session:
apps like Zoom/OBS/Chrome keep the device selected across reconnects, and
with v4l2loopback's exclusive_caps=1 the camera is only listed as a capture
device while a producer is attached. Between sessions the camera shows black
and the microphone plays silence.
"""
import fcntl
import glob
import json
import os
import queue
import shutil
import subprocess
import sys
import termios
import threading
import time

import av
import cv2
import numpy as np
import pyvirtualcam

_STOP = object()

# Linux-only fcntl op; not exposed by the Python fcntl module on all versions.
F_SETPIPE_SZ = getattr(fcntl, "F_SETPIPE_SZ", 1031)


def _put_latest(q: "queue.Queue", item) -> None:
    """Non-blocking put that drops the oldest item when the queue is full."""
    while True:
        try:
            q.put_nowait(item)
            return
        except queue.Full:
            try:
                q.get_nowait()
            except queue.Empty:
                pass


CAM_LABEL = "PixelStreamer"

# Run as root via pkexec: add a loopback device to an already-loaded
# v4l2loopback (which may belong to another app) through its control device.
_ADD_DEVICE_SCRIPT = r"""
import fcntl, struct, sys
label = sys.argv[1].encode()[:31]
new = struct.pack("ii32sIIIIiiii", -1, -1, label, 0, 0, 0, 0, -1, -1, -1, 0)  # >= 0.13
old = struct.pack("ii32siiiiii", -1, -1, label, 0, 0, -1, -1, -1, 0)       # < 0.13
IOW = lambda nr, size: (1 << 30) | (size << 16) | (ord("~") << 8) | nr
err = None
with open("/dev/v4l2loopback", "rb") as ctl:
    for req, conf in ((IOW(1, len(new)), new), (0x4C80, old)):
        try:
            fcntl.ioctl(ctl.fileno(), req, bytearray(conf), True)
            break
        except OSError as e:
            err = e
    else:
        sys.exit(f"V4L2LOOPBACK_CTL_ADD failed: {err}")
"""


def find_loopback_device(label: str = CAM_LABEL):
    """Return /dev/videoN of the v4l2loopback device with our card label."""
    for name_file in sorted(glob.glob("/sys/devices/virtual/video4linux/video*/name")):
        try:
            with open(name_file) as f:
                if f.read().strip() == label:
                    return "/dev/" + os.path.basename(os.path.dirname(name_file))
        except OSError:
            pass
    return None


def create_loopback_device(label: str = CAM_LABEL) -> bool:
    """
    Create our loopback device, asking for authorisation through polkit.
    Never touches devices that other apps created.
    """
    if not shutil.which("pkexec"):
        print("[VirtualCam] pkexec not found; create the device manually:\n"
              f"  modprobe v4l2loopback devices=1 card_label={label} exclusive_caps=1")
        return False
    if os.path.exists("/sys/module/v4l2loopback"):
        cmd = ["pkexec", os.path.realpath(sys.executable), "-c", _ADD_DEVICE_SCRIPT, label]
    else:
        cmd = ["pkexec", "modprobe", "v4l2loopback", "devices=1",
               f"card_label={label}", "exclusive_caps=1"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except Exception as e:
        print(f"[VirtualCam] Could not create loopback device: {e}")
        return False
    if r.returncode != 0:
        print(f"[VirtualCam] Could not create loopback device (rc={r.returncode}): {r.stderr.strip()}")
        return False
    # udev needs a moment to create the node.
    for _ in range(20):
        if find_loopback_device(label):
            return True
        time.sleep(0.1)
    return False


class VirtualCamThread(threading.Thread):
    """
    Pushes decoded WebRTC frames to the v4l2loopback device as soon as they
    arrive (no fixed-rate resampling, so no added latency or judder).

    Frames are sent as I420, which is what the decoder already produces, so a
    frame at the output size is copied straight through with no colour
    conversion. Other sizes are scaled and letterboxed.
    """

    IDLE_RESEND_S = 0.2   # keep consumers fed while no frames arrive
    RETRY_OPEN_S = 2.0
    PREVIEW_INTERVAL_S = 0.1
    PREVIEW_WIDTH = 640

    def __init__(self, width=1280, height=720, fps=60, on_preview=None):
        super().__init__(daemon=True, name="VirtualCam")
        assert width % 2 == 0 and height % 2 == 0
        self.width, self.height, self.fps = width, height, fps
        self.on_preview = on_preview  # callable(rgb ndarray | None), any thread
        self._q: "queue.Queue" = queue.Queue(maxsize=1)
        self._stopped = threading.Event()
        self._black = self._blank()
        self._last_preview = 0.0

    # ---- public API (thread-safe) ----
    def push(self, frame: "av.VideoFrame") -> None:
        _put_latest(self._q, frame)

    def clear(self) -> None:
        """Show black (e.g. when a session ends) instead of a frozen frame."""
        _put_latest(self._q, None)

    def stop(self) -> None:
        self._stopped.set()
        _put_latest(self._q, _STOP)

    # ---- I420 helpers ----
    def _blank(self) -> np.ndarray:
        w, h = self.width, self.height
        buf = np.empty(w * h * 3 // 2, dtype=np.uint8)
        buf[: w * h] = 16      # limited-range black
        buf[w * h :] = 128     # neutral chroma
        return buf

    @staticmethod
    def _planes(buf: np.ndarray, w: int, h: int):
        flat = buf.reshape(-1)
        ys, cs = w * h, (w // 2) * (h // 2)
        return (
            flat[:ys].reshape(h, w),
            flat[ys : ys + cs].reshape(h // 2, w // 2),
            flat[ys + cs : ys + 2 * cs].reshape(h // 2, w // 2),
        )

    def _to_i420(self, frame: "av.VideoFrame") -> np.ndarray:
        W, H = self.width, self.height
        fw, fh = frame.width, frame.height
        if fw == W and fh == H:
            return frame.to_ndarray(format="yuv420p").reshape(-1)

        scale = min(W / fw, H / fh)
        nw = max(2, int(fw * scale) // 2 * 2)
        nh = max(2, int(fh * scale) // 2 * 2)
        small = frame.reformat(width=nw, height=nh, format="yuv420p").to_ndarray()
        if nw == W and nh == H:
            return small.reshape(-1)

        out = self._black.copy()
        x0 = (W - nw) // 4 * 2
        y0 = (H - nh) // 4 * 2
        for dst, src, div in zip(self._planes(out, W, H), self._planes(small, nw, nh), (1, 2, 2)):
            dst[y0 // div : y0 // div + nh // div, x0 // div : x0 // div + nw // div] = src
        return out

    def _emit_preview(self, buf: np.ndarray, force=False) -> None:
        if not self.on_preview:
            return
        now = time.monotonic()
        if not force and now - self._last_preview < self.PREVIEW_INTERVAL_S:
            return
        self._last_preview = now
        if buf is self._black:
            self.on_preview(None)
            return
        rgb = cv2.cvtColor(buf.reshape(self.height * 3 // 2, self.width), cv2.COLOR_YUV2RGB_I420)
        pw = self.PREVIEW_WIDTH
        ph = int(self.height * pw / self.width)
        self.on_preview(cv2.resize(rgb, (pw, ph), interpolation=cv2.INTER_AREA))

    # ---- thread ----
    def run(self):
        warned = False
        tried_create = False
        while not self._stopped.is_set():
            device = find_loopback_device()
            if device is None and not tried_create:
                tried_create = True
                create_loopback_device()
                device = find_loopback_device()
            if device is None:
                if not warned:
                    print(f"[VirtualCam] No '{CAM_LABEL}' loopback device; "
                          f"retrying every {self.RETRY_OPEN_S:.0f}s")
                    warned = True
                self._stopped.wait(self.RETRY_OPEN_S)
                continue
            try:
                cam = pyvirtualcam.Camera(
                    width=self.width, height=self.height, fps=self.fps,
                    fmt=pyvirtualcam.PixelFormat.I420, device=device,
                    backend="v4l2loopback", print_fps=False,
                )
            except Exception as e:
                if not warned:
                    print(f"[VirtualCam] Could not open {device} (retrying): {e}")
                    warned = True
                self._stopped.wait(self.RETRY_OPEN_S)
                continue

            print(f"[VirtualCam] Opened {cam.device} {self.width}x{self.height} I420")
            warned = False
            try:
                with cam:
                    self._loop(cam)
            except Exception as e:
                print(f"[VirtualCam] Error, reopening: {e!r}")
                self._stopped.wait(self.RETRY_OPEN_S)
        print("[VirtualCam] Closed")

    def _loop(self, cam):
        current = self._black
        cam.send(current)
        while not self._stopped.is_set():
            try:
                item = self._q.get(timeout=self.IDLE_RESEND_S)
            except queue.Empty:
                cam.send(current)
                continue
            if item is _STOP:
                return
            if item is None:
                current = self._black
                cam.send(current)
                self._emit_preview(current, force=True)
                continue
            try:
                current = self._to_i420(item)
            except Exception as e:
                print(f"[VirtualCam] Bad frame dropped: {e!r}")
                continue
            cam.send(current)
            self._emit_preview(current)


class VirtualMicThread(threading.Thread):
    """
    Creates a PipeWire null sink + remapped source ("PixelStreamer Virtual
    Mic") and plays received audio into it through pw-cat.

    Latency is bounded by shrinking pw-cat's stdin pipe to one page (~21 ms of
    48 kHz stereo s16): blocking writes then pace us to the audio graph's own
    clock, so there is no drift between our clock and PipeWire's and no room
    for a backlog to build up. Silence is only written when the pipe is about
    to run dry.
    """

    RATE = 48000
    CHANNELS = 2
    BYTES_PER_SAMPLE = 2
    QUEUE_FRAMES = 3      # ~60 ms of 20 ms Opus frames before dropping oldest
    POLL_S = 0.005

    def __init__(self):
        super().__init__(daemon=True, name="VirtualMic")
        self.sink_name = "pixel_mic_sink"
        self.source_name = "pixel_mic"

        self._q: "queue.Queue" = queue.Queue(maxsize=self.QUEUE_FRAMES)
        self._stopped = threading.Event()
        self._mod_sink_id = None
        self._mod_source_id = None
        self._pwcat = None
        self._resampler = None

        bytes_per_ms = self.RATE * self.CHANNELS * self.BYTES_PER_SAMPLE // 1000
        self._low_water = 10 * bytes_per_ms          # top up below 10 ms
        self._silence = b"\x00" * (10 * bytes_per_ms)

    # ---- public API (thread-safe) ----
    def push(self, frame: "av.AudioFrame") -> None:
        _put_latest(self._q, frame)

    def clear(self) -> None:
        """Drop queued audio (e.g. when a session ends)."""
        try:
            while True:
                self._q.get_nowait()
        except queue.Empty:
            pass
        self._resampler = None

    def stop(self) -> None:
        self._stopped.set()
        _put_latest(self._q, _STOP)

    # ---- pactl helpers ----
    def _pactl_load(self, module: str, args: str) -> int:
        # pactl joins its arguments with spaces and hands them to pulse's own
        # modargs parser, so pass them as one string with pulse-style quoting.
        out = subprocess.check_output(
            ["pactl", "load-module", module, args],
            text=True, stderr=subprocess.STDOUT, timeout=5,
        )
        return int(out.strip())

    def _pactl_unload(self, mod_id) -> None:
        if not mod_id:
            return
        try:
            subprocess.run(
                ["pactl", "unload-module", str(mod_id)],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5,
            )
        except Exception:
            pass

    def _unload_existing_named_modules(self) -> None:
        """Remove modules leaked by a previous run that didn't exit cleanly."""
        try:
            out = subprocess.check_output(["pactl", "list", "short", "modules"], text=True, timeout=5)
        except Exception:
            return
        for line in out.splitlines():
            parts = line.split("\t", 2)
            if len(parts) < 3:
                continue
            mod_id, _name, args = parts
            if f"sink_name={self.sink_name}" in args or f"source_name={self.source_name}" in args:
                self._pactl_unload(mod_id)

    def _setup_virtual_mic(self) -> None:
        self._unload_existing_named_modules()
        common = f"rate={self.RATE} channels={self.CHANNELS} channel_map=front-left,front-right"
        self._mod_sink_id = self._pactl_load(
            "module-null-sink",
            f"sink_name={self.sink_name} "
            f"sink_properties='device.description=\"PixelStreamer Mic Sink\"' {common}",
        )
        self._mod_source_id = self._pactl_load(
            "module-remap-source",
            f"master={self.sink_name}.monitor source_name={self.source_name} "
            f"source_properties='device.description=\"PixelStreamer Virtual Mic\"' {common}",
        )
        print(f"[VirtualMic] Ready: {self.source_name}")

    def _teardown_virtual_mic(self) -> None:
        self._pactl_unload(self._mod_source_id)
        self._pactl_unload(self._mod_sink_id)
        self._mod_source_id = self._mod_sink_id = None

    # ---- pw-cat ----
    def _find_sink_serial(self, timeout_s: float = 2.0):
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            try:
                dump = json.loads(subprocess.check_output(["pw-dump"], text=True, timeout=5))
            except Exception:
                dump = []
            for obj in dump:
                if obj.get("type") != "PipeWire:Interface:Node":
                    continue
                props = (obj.get("info") or {}).get("props") or {}
                if props.get("node.name") == self.sink_name and "Audio/Sink" in (props.get("media.class") or ""):
                    serial = props.get("object.serial")
                    if serial is not None:
                        return str(serial)
            time.sleep(0.1)
        return None

    def _start_pwcat(self) -> None:
        target = self._find_sink_serial() or self.sink_name
        cmd = [
            "pw-cat", "--playback", "--raw",
            "--rate", str(self.RATE),
            "--channels", str(self.CHANNELS),
            "--channel-map", "stereo",
            "--format", "s16",
            "--latency", "10ms",
            "--target", target,
            "-",
        ]
        self._pwcat = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE, bufsize=0,
        )
        try:
            fcntl.fcntl(self._pwcat.stdin.fileno(), F_SETPIPE_SZ, 4096)
        except OSError as e:
            print(f"[VirtualMic] Could not shrink pipe buffer (latency may grow): {e}")
        time.sleep(0.05)
        if self._pwcat.poll() is not None:
            err = self._pwcat.stderr.read().decode(errors="replace").strip()
            raise RuntimeError(f"pw-cat exited immediately (rc={self._pwcat.returncode}): {err}")

    def _stop_pwcat(self) -> None:
        p, self._pwcat = self._pwcat, None
        if not p:
            return
        try:
            p.stdin.close()
        except Exception:
            pass
        try:
            p.terminate()
            p.wait(timeout=1)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass

    def _pipe_fill(self) -> int:
        if not self._pwcat:
            return 0
        buf = fcntl.ioctl(self._pwcat.stdin.fileno(), termios.FIONREAD, b"\0\0\0\0")
        return int.from_bytes(buf, "little")

    def _write(self, data: bytes) -> None:
        # Blocking write: waits for pw-cat to consume, pacing us to the graph clock.
        fd = self._pwcat.stdin.fileno()
        view = memoryview(data)
        while view:
            n = os.write(fd, view)
            view = view[n:]

    def _to_s16_bytes(self, frame: "av.AudioFrame") -> bytes:
        # aiortc's Opus decoder already yields 48 kHz stereo s16, in which case
        # the resampler is a cheap passthrough; anything else is converted.
        if self._resampler is None:
            self._resampler = av.AudioResampler(format="s16", layout="stereo", rate=self.RATE)
        return b"".join(bytes(f.planes[0])[: f.samples * self.CHANNELS * self.BYTES_PER_SAMPLE]
                        for f in self._resampler.resample(frame))

    # ---- thread ----
    def run(self):
        backoff = 1.0
        while not self._stopped.is_set():
            try:
                self._setup_virtual_mic()
                self._start_pwcat()
                backoff = 1.0
                self._loop()
            except Exception as e:
                if not self._stopped.is_set():
                    print(f"[VirtualMic] Error, restarting in {backoff:.0f}s: {e}")
            finally:
                self._stop_pwcat()
                self._teardown_virtual_mic()
            if self._stopped.wait(backoff):
                break
            backoff = min(backoff * 2, 30.0)
        print("[VirtualMic] Closed")

    def _loop(self):
        while not self._stopped.is_set():
            try:
                item = self._q.get(timeout=self.POLL_S)
            except queue.Empty:
                if self._pipe_fill() < self._low_water:
                    self._write(self._silence)
                continue
            if item is _STOP:
                return
            try:
                data = self._to_s16_bytes(item)
            except Exception as e:
                print(f"[VirtualMic] Bad frame dropped: {e!r}")
                self._resampler = None
                continue
            if data:
                self._write(data)
