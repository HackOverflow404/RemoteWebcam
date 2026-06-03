import os
import queue
import shlex
import subprocess
import threading
import time
import numpy as np
import pyvirtualcam
import cv2
import json

class VirtualCamThread(threading.Thread):
    def __init__(self, frame_queue, running_flag, width, height, fps=60):
        super().__init__(daemon=True)
        self.cam = None
        self.q = frame_queue
        self.running_flag = running_flag
        self.width, self.height, self.fps = width, height, fps

    def _letterbox(self, frame: np.ndarray) -> np.ndarray:
        """Fit frame into (self.height, self.width) preserving aspect ratio."""
        fh, fw = frame.shape[:2]
        if fw == self.width and fh == self.height:
            return frame
        scale = min(self.width / fw, self.height / fh)
        nw, nh = int(fw * scale), int(fh * scale)
        resized = cv2.resize(frame, (nw, nh), interpolation=cv2.INTER_LINEAR)
        out = np.zeros((self.height, self.width, 3), dtype=np.uint8)
        y0 = (self.height - nh) // 2
        x0 = (self.width  - nw) // 2
        out[y0:y0 + nh, x0:x0 + nw] = resized
        return out

    def run(self):
        try:
            last = np.zeros((self.height, self.width, 3), dtype=np.uint8)

            try:
                cam_ctx = pyvirtualcam.Camera(
                    width=self.width, height=self.height, fps=self.fps,
                    fmt=pyvirtualcam.PixelFormat.BGR, print_fps=False,
                )
            except RuntimeError as e:
                print(
                    "[VirtualCam] ERROR: Could not open virtual camera.\n"
                    "  Make sure v4l2loopback is loaded:  sudo modprobe v4l2loopback\n"
                    f"  Details: {e}"
                )
                return

            with cam_ctx as self.cam:
                while self.running_flag():
                    try:
                        while True:
                            last = self.q.get_nowait()
                    except queue.Empty:
                        pass

                    frame = self._letterbox(last)
                    self.cam.send(frame)
                    self.cam.sleep_until_next_frame()

        except Exception as e:
            print(f"[VirtualCam] Unexpected error: {e}")
        finally:
            print("[VirtualCam] Closed")



class VirtualMicThread(threading.Thread):
    def __init__(self, audio_queue: "queue.Queue", running_flag, rate=48000, channels=2):
        super().__init__(daemon=True)
        self.audio_queue = audio_queue
        self.running_flag = running_flag
        self.rate = int(rate)
        self.channels = 1 if int(channels) <= 1 else 2  # keep stable (mono/stereo)

        self.sink_name = "pixel_mic_sink"
        self.source_name = "pixel_mic"

        self._mod_sink_id = None
        self._mod_source_id = None
        self._pwcat = None

        # 20ms chunking
        self._frame_ms = 20
        self._samples_per_frame = int(self.rate * self._frame_ms / 1000)
        self._target_bytes = self._samples_per_frame * self.channels * 2  # s16 = 2 bytes
        self._buf = bytearray()
        self._silence = b"\x00" * self._target_bytes

    # ---------------- pactl helpers ----------------
    def _pactl_load(self, args: str) -> int:
        cmd = ["pactl", "load-module"] + shlex.split(args)
        print(f"[VirtualMic] [DEBUG] pactl: {' '.join(cmd)}")
        out = subprocess.check_output(cmd, text=True, stderr=subprocess.STDOUT)
        return int(out.strip())

    def _pactl_unload(self, mod_id: int) -> None:
        if not mod_id:
            return
        try:
            subprocess.check_call(
                ["pactl", "unload-module", str(mod_id)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass

    def _unload_existing_named_modules(self) -> None:
        try:
            out = subprocess.check_output(["pactl", "list", "short", "modules"], text=True)
            for line in out.splitlines():
                parts = line.split("\t", 2)
                if len(parts) < 3:
                    continue
                mod_id, _mod_name, args = parts
                if (self.sink_name in args) or (self.source_name in args):
                    self._pactl_unload(int(mod_id))
        except Exception:
            pass

    def _channel_map_pactl(self) -> str:
        # pactl module args often accept "front-left,front-right"
        return "mono" if self.channels == 1 else "front-left,front-right"

    def _setup_virtual_mic(self) -> None:
        print(f"[VirtualMic] Setup: {self.rate}Hz {self.channels}ch")
        self._unload_existing_named_modules()

        chmap = self._channel_map_pactl()

        sink_args = (
            f'module-null-sink sink_name={self.sink_name} '
            f'sink_properties=device.description="PixelStreamer Mic Sink" device.virtual=true '
            f"rate={self.rate} channels={self.channels} channel_map={chmap}"
        )
        self._mod_sink_id = self._pactl_load(sink_args)

        time.sleep(0.2)

        source_args = (
            f"module-remap-source master={self.sink_name}.monitor "
            f"source_name={self.source_name} "
            f'source_properties=device.description="PixelStreamer Virtual Mic" device.virtual=true '
            f"rate={self.rate} channels={self.channels} channel_map={chmap}"
        )
        self._mod_source_id = self._pactl_load(source_args)

        print(f"[VirtualMic] READY: {self.source_name}")

    def _teardown_virtual_mic(self) -> None:
        self._pactl_unload(self._mod_source_id)
        self._pactl_unload(self._mod_sink_id)
        self._mod_source_id = None
        self._mod_sink_id = None
        print("[VirtualMic] Teardown complete")

    def _write_fd_all(self, data: bytes) -> bool:
        """
        Write all bytes to pw-cat stdin via os.write().
        Returns False if pipe is dead.
        """
        if not self._pwcat or not self._pwcat.stdin:
            return False

        fd = self._pwcat.stdin.fileno()
        view = memoryview(data)
        total = 0
        while total < len(data):
            try:
                n = os.write(fd, view[total:])
                if n <= 0:
                    return False
                total += n
            except BlockingIOError:
                # Backpressure: yield and retry
                time.sleep(0.001)
            except BrokenPipeError:
                return False
            except OSError:
                return False
        return True

    
    # ---------------- PCM conversion ----------------
    def _to_interleaved_s16(self, pcm: np.ndarray) -> bytes:
        a = np.asarray(pcm)

        # Normalize shapes to (samples, channels_guess)
        if a.ndim == 1:
            a = a[:, None]
        elif a.ndim == 2:
            # if a.shape[0] == 1:
            #     print("[VirtualMic] samples:", a[0, :8])
            # Handle (1, N) where N might be interleaved stereo flattened
            if a.shape[0] == 1 and self.channels == 2 and (a.shape[1] % 2 == 0):
                a = a.reshape(-1, 2)
            # Handle planar (channels, samples)
            elif a.shape[0] in (1, 2) and a.shape[1] > a.shape[0] * 8:
                a = a.T
            # else assume already (samples, channels)
        else:
            a = a.reshape(-1, 1)

        if a.ndim != 2:
            a = a.reshape(-1, 1)

        # Match channels (1 or 2)
        if a.shape[1] > self.channels:
            a = a[:, : self.channels]
        elif a.shape[1] < self.channels:
            pad = np.zeros((a.shape[0], self.channels - a.shape[1]), dtype=a.dtype)
            a = np.concatenate([a, pad], axis=1)

        # Convert to s16
        if np.issubdtype(a.dtype, np.integer):
            if a.dtype == np.int16:
                s16 = a
            else:
                s16 = np.clip(a.astype(np.int32), -32768, 32767).astype(np.int16)
        else:
            # float assumed normalized [-1, 1]
            af = a.astype(np.float32, copy=False)
            af = np.clip(af, -1.0, 1.0)
            s16 = (af * 32767.0).astype(np.int16)

        s16 = np.ascontiguousarray(s16).astype(np.int16, copy=False)
        return s16.tobytes()

    # ---------------- PipeWire target discovery ----------------
    def _pw_dump(self):
        out = subprocess.check_output(["pw-dump"], text=True)
        return json.loads(out)

    def _find_pw_target_id(self, timeout_s: float = 2.0) -> str | None:
        """
        Returns a pw-cat --target value (prefer numeric id/serial as string).
        We try to match by:
          - node.name containing sink_name
          - node.description containing our sink description
          - any property containing sink_name
        """
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            try:
                dump = self._pw_dump()
            except Exception:
                time.sleep(0.1)
                continue

            candidates = []
            for obj in dump:
                if obj.get("type") != "PipeWire:Interface:Node":
                    continue
                info = obj.get("info") or {}
                props = info.get("props") or {}
                node_name = (props.get("node.name") or "")
                node_desc = (props.get("node.description") or props.get("node.nick") or "")
                media_class = (props.get("media.class") or "")

                # We want an output node to play into (sink)
                if "Audio/Sink" not in media_class and "Audio" not in media_class:
                    # don’t over-filter; pipewire-pulse nodes vary
                    pass

                hay = " ".join([node_name, node_desc, json.dumps(props, ensure_ascii=False)])
                if self.sink_name in hay or "PixelStreamer Mic Sink" in hay:
                    candidates.append((obj.get("id"), node_name, node_desc, media_class))

            # Prefer nodes that look like sinks (Pulse sink nodes usually have "output"/"sink" in name)
            if candidates:
                # pick the first numeric id; stable enough
                best = candidates[0]
                target_id = best[0]
                if target_id is not None:
                    print(f"[VirtualMic] pw target: id={target_id} name={best[1]} desc={best[2]}")
                    return str(target_id)

            time.sleep(0.1)

        return None
    
    def _find_pw_target_serial(self, timeout_s: float = 2.0) -> str | None:
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            try:
                dump = self._pw_dump()
            except Exception:
                time.sleep(0.1)
                continue

            for obj in dump:
                if obj.get("type") != "PipeWire:Interface:Node":
                    continue
                info = obj.get("info") or {}
                props = info.get("props") or {}
                media_class = props.get("media.class") or ""
                node_name = props.get("node.name") or ""
                node_desc = props.get("node.description") or props.get("node.nick") or ""

                # Strongly prefer actual sinks
                if "Audio/Sink" not in media_class:
                    continue

                hay = " ".join([node_name, node_desc, json.dumps(props, ensure_ascii=False)])
                if self.sink_name in hay or "PixelStreamer Mic Sink" in hay:
                    serial = props.get("object.serial")
                    if serial is not None:
                        print(f"[VirtualMic] pw target serial: {serial} name={node_name} desc={node_desc}")
                        return str(serial)

            time.sleep(0.1)
        return None


    # ---------------- pw-cat management ----------------
    def _start_pwcat(self) -> None:
        # Resolve a PipeWire node identifier that pw-cat can link to.
        # Prefer object.serial if available; otherwise fall back to id; finally name.
        target = self._find_pw_target_serial(timeout_s=2.0) or self._find_pw_target_id(timeout_s=2.0) or self.sink_name

        cmd = [
            "pw-cat",
            "--playback",
            "--rate", str(self.rate),
            "--channels", str(self.channels),
            "--channel-map", "stereo",
            "--format", "s16",
            "--latency", "20ms",
            "--target", str(target),
            "-",
        ]
        print("[VirtualMic] [DEBUG] pw-cat:", " ".join(cmd))

        self._pwcat = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            bufsize=0,  # IMPORTANT: unbuffered stdin
        )

        time.sleep(0.05)
        if self._pwcat.poll() is not None:
            err = b""
            try:
                err = self._pwcat.stderr.read()
            except Exception:
                pass
            if err:
                print("[VirtualMic] [CRITICAL] pw-cat:", err.decode(errors="replace").strip())
            raise RuntimeError(f"pw-cat died immediately (rc={self._pwcat.returncode})")

        print(f"[VirtualMic] pw-cat running PID: {self._pwcat.pid}")

    def _stop_pwcat(self) -> None:
        if not self._pwcat:
            return
        try:
            try:
                self._pwcat.stdin.close()
            except Exception:
                pass
            self._pwcat.terminate()
            self._pwcat.wait(timeout=1)
        except Exception:
            try:
                self._pwcat.kill()
            except Exception:
                pass
        finally:
            self._pwcat = None

    # ---------------- thread loop ----------------
    def run(self):
        try:
            self._setup_virtual_mic()
            time.sleep(0.2)
            self._start_pwcat()

            # Use a stable 20ms cadence
            period = self._frame_ms / 1000.0
            next_t = time.monotonic()

            while self.running_flag():
                # Wait for one packet of audio (don’t drain aggressively)
                try:
                    pcm = self.audio_queue.get(timeout=0.1)
                    data = self._to_interleaved_s16(pcm)
                except queue.Empty:
                    data = self._silence

                # Ensure we always write exactly one "period" worth
                # (Your incoming frames are already 20ms; this is mainly safety.)
                if len(data) < self._target_bytes:
                    data = data + (b"\x00" * (self._target_bytes - len(data)))
                elif len(data) > self._target_bytes:
                    data = data[:self._target_bytes]

                if not self._write_fd_all(data):
                    break

                # Pace to real-time
                next_t += period
                now = time.monotonic()
                sleep_for = next_t - now
                if sleep_for > 0:
                    time.sleep(sleep_for)
                else:
                    # If we fell behind, reset the clock to avoid runaway
                    next_t = now

        except Exception as e:
            print(f"[VirtualMic] [Error]: {e}")
        finally:
            self._stop_pwcat()
            self._teardown_virtual_mic()
