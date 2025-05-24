import asyncio
import json
import threading
import requests
from aiortc import RTCPeerConnection, RTCSessionDescription, MediaStreamTrack
from PyQt5.QtCore import QObject, pyqtSignal
from av import VideoFrame
import gi
import cv2
import numpy as np
from datetime import datetime, timedelta

gi.require_version("Gst", "1.0")
from gi.repository import Gst

Gst.init(None)

class GStreamerPipeline:
  def __init__(self, widget_win_id: int):
    self.widget_id = widget_win_id
    self.pipeline = None
    self.appsrc = None

  def build_pipeline(self):
    pipeline_description = f"""
      appsrc name=mysrc is-live=true block=true format=time do-timestamp=true !
      videoconvert !
      queue !
      autovideosink sync=false
    """
    self.pipeline = Gst.parse_launch(pipeline_description)
    self.appsrc = self.pipeline.get_by_name("mysrc")
    self.pipeline.set_state(Gst.State.PLAYING)

  def push_frame(self, frame_bytes, width, height, fmt="RGB"):
    buf = Gst.Buffer.new_wrapped(frame_bytes)
    caps = Gst.Caps.from_string(f"video/x-raw,format={fmt},width={width},height={height},framerate=30/1")
    self.appsrc.set_caps(caps)
    self.appsrc.emit("push-buffer", buf)

  def stop(self):
    if self.pipeline:
      self.pipeline.set_state(Gst.State.NULL)

class WebRTCWorker(QObject):
  video_frame_received = pyqtSignal(object)
  connection_state_changed = pyqtSignal(str)

  def __init__(self, code: str, widget_win_id: int, offer):
    super().__init__()
    self.code = code
    self.offer = offer
    self.pc = None
    self.running = False
    self.gst_pipeline = GStreamerPipeline(widget_win_id)

  def start(self):
    self.running = True
    threading.Thread(target=self._run_async_thread, daemon=True).start()

  def stop(self):
    self.running = False
    if self.pc:
      asyncio.run_coroutine_threadsafe(self.pc.close(), asyncio.get_event_loop())
    self.gst_pipeline.stop()

  def _run_async_thread(self):
    asyncio.run(self._run())

  async def _run(self):
    self.pc = RTCPeerConnection()

    @self.pc.on("connectionstatechange")
    async def on_connectionstatechange():
      state = self.pc.connectionState
      print(f"[WebRTC] State: {state}")
      self.connection_state_changed.emit(state)

    @self.pc.on("track")
    def on_track(track):
      print(f"[WebRTC] Track received: {track.kind}")
      if track.kind == "video":
        # asyncio.ensure_future(self.consume_video(track))
        asyncio.ensure_future(self.handle_track(track))

    offer = self.offer
    if not offer:
      self.connection_state_changed.emit("failed")
      return

    await self.pc.setRemoteDescription(RTCSessionDescription(**offer))
    answer = await self.pc.createAnswer()
    await self.pc.setLocalDescription(answer)
    await self.send_answer(self.pc.localDescription)

  async def send_answer(self, sdp):
    try:
      res = requests.post(
        "https://submitanswer-qaf2yvcrrq-uc.a.run.app",
        json={
          "code": self.code,
          "answer": {
            "sdp": sdp.sdp,
            "type": sdp.type
          }
        },
        timeout=10
      )
      if res.status_code == 200:
        print("[WebRTC] Answer submitted successfully")
      else:
        print(f"[WebRTC] Answer submission failed: {res.status_code}")
    except Exception as e:
      print(f"[WebRTC] Answer error: {e}")

  async def consume_video(self, track: MediaStreamTrack):
    print("[WebRTC] Starting video track consumption")
    self.gst_pipeline.build_pipeline()
    while self.running:
      try:
        frame: VideoFrame = await track.recv()
        img = frame.to_ndarray(format="rgb24")
        self.gst_pipeline.push_frame(img.tobytes(), frame.width, frame.height)
      except Exception as e:
        print(f"[WebRTC] Video track ended: {e}")
        break
   
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
          print(f"Frame type: VideoFrame, pts: {frame.pts}, time_base: {frame.time_base}")
          frame = frame.to_ndarray(format="bgr24")
        elif isinstance(frame, np.ndarray):
          print(f"Frame type: numpy array")
        else:
          print(f"Unexpected frame type: {type(frame)}")
          continue
       
         # Add timestamp to the frame
        current_time = datetime.now()
        new_time = current_time - timedelta( seconds=55)
        timestamp = new_time.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
        cv2.putText(frame, timestamp, (10, frame.shape[0] - 30), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2, cv2.LINE_AA)
        cv2.imwrite(f"imgs/received_frame_{frame_count}.jpg", frame)
        print(f"Saved frame {frame_count} to file")
        cv2.imshow("Frame", frame)
  
        # Exit on 'q' key press
        if cv2.waitKey(1) & 0xFF == ord('q'):
          break
      except asyncio.TimeoutError:
        print("Timeout waiting for frame, continuing...")
      except Exception as e:
        print(f"Error in handle_track: {str(e)}")
        if "Connection" in str(e):
          break
    print("Exiting handle_track")