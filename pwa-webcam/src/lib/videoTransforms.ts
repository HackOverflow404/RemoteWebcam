export interface ProcessedTrack {
  track: MediaStreamTrack;
  stop: () => void;
  setRotation: (r: Rotation) => void;
}

export type Rotation = 0 | 90 | -90;
export type FitMode = "contain" | "cover";

export function createTransformedTrack(
  inputTrack: MediaStreamTrack,
  opts: {
    outW: number;
    outH: number;
    fps?: number;
    mirror?: boolean;
    rotation?: Rotation;
    fit?: FitMode;
    background?: string;
  }
): ProcessedTrack {
  const {
    outW,
    outH,
    fps = 30,
    mirror = false,
    rotation = 0,
    fit = "contain",
    background = "black",
  } = opts;

  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([inputTrack]);

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;

  const ctx = canvas.getContext("2d", { alpha: false })!;
  const stream = canvas.captureStream(fps);
  const outputTrack = stream.getVideoTracks()[0];

  let running = true;
  let ready = false;

  let rot: Rotation = rotation;
  let rad = rot === 90 ? Math.PI / 2 : rot === -90 ? -Math.PI / 2 : 0;

  const setRotation = (r: Rotation) => {
    rot = r;
    rad = rot === 90 ? Math.PI / 2 : rot === -90 ? -Math.PI / 2 : 0;
  };

  const ensurePlay = () => {
    video
      .play()
      .then(() => {
        ready = true;
      })
      .catch(() => {
        // iOS can deny until user gesture; keep trying lightly
        ready = video.readyState >= 2;
      });
  };

  video.addEventListener("loadeddata", ensurePlay);
  ensurePlay();

  const drawOnce = () => {
    if (!running) return;

    const cw = outW;
    const ch = outH;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, cw, ch);

    if (ready && video.videoWidth && video.videoHeight) {
      const srcW = video.videoWidth;
      const srcH = video.videoHeight;

      const effW = rot === 90 || rot === -90 ? srcH : srcW;
      const effH = rot === 90 || rot === -90 ? srcW : srcH;

      const scale =
        fit === "cover"
          ? Math.max(cw / effW, ch / effH)
          : Math.min(cw / effW, ch / effH);

      const drawW = srcW * scale;
      const drawH = srcH * scale;

      ctx.save();
      ctx.translate(cw / 2, ch / 2);
      ctx.rotate(rad);
      if (mirror) ctx.scale(-1, 1);
      ctx.drawImage(video, -drawW / 2, -drawH / 2, drawW, drawH);
      ctx.restore();
    }
  };

  // Prefer RVFC (prevents “frozen frame” issues on iOS)
  const anyVideo = video as any;
  let rafId = 0;
  let rvfcId = 0;

  const loop = () => {
    if (!running) return;
    drawOnce();
    rafId = requestAnimationFrame(loop);
  };

  const onVideoFrame = () => {
    if (!running) return;
    drawOnce();
    rvfcId = anyVideo.requestVideoFrameCallback(onVideoFrame);
  };

  if (typeof anyVideo.requestVideoFrameCallback === "function") {
    rvfcId = anyVideo.requestVideoFrameCallback(onVideoFrame);
  } else {
    rafId = requestAnimationFrame(loop);
  }

  return {
    track: outputTrack,
    setRotation,
    stop: () => {
      running = false;
      try {
        cancelAnimationFrame(rafId);
      } catch {}
      try {
        anyVideo.cancelVideoFrameCallback?.(rvfcId);
      } catch {}
      try {
        outputTrack.stop();
      } catch {}
      try {
        video.pause();
      } catch {}
      video.srcObject = null;
    },
  };
}
