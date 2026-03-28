export interface ProcessedTrack {
  track: MediaStreamTrack;
  stop: () => void;
  setRotation: (r: number) => void;
}

export type FitMode = "contain" | "cover";

export function createTransformedTrack(
  inputTrack: MediaStreamTrack,
  opts: {
    outW: number;
    outH: number;
    fps?: number;
    mirror?: boolean;
    rotation?: number;
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
    fit = "cover",
    background = "black",
  } = opts;

  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");

  video.srcObject = new MediaStream([inputTrack]);

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;

  const ctx = canvas.getContext("2d", { alpha: false })!;
  const stream = canvas.captureStream(fps);
  const outputTrack = stream.getVideoTracks()[0];

  let running = true;
  let ready = false;

  let rot: number = rotation;
  const toRad = (r: number) =>
    r === 90 ? Math.PI / 2
    : r === -90 || r === 270 ? -Math.PI / 2
    : r === 180 ? Math.PI
    : 0;
  let rad = toRad(rot);

  const setRotation = (r: number) => {
    rot = r;
    rad = toRad(rot);
  };

  const ensurePlay = () => {
    video.play().catch(() => {});
  };

  video.onloadedmetadata = () => {
    ready = true;
    ensurePlay();
  };
  video.onloadeddata = ensurePlay;

  const draw = () => {
    const cw = outW;
    const ch = outH;

    // background
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, cw, ch);

    if (!ready || video.readyState < 2) return;

    const srcW = video.videoWidth || 1;
    const srcH = video.videoHeight || 1;

    const isRotated90 = rot === 90 || rot === -90 || rot === 270;
    const effW = isRotated90 ? srcH : srcW;
    const effH = isRotated90 ? srcW : srcH;

    // Recompute fit dynamically so it updates when rotation changes mid-session
    const currentFit: FitMode = rot === 0 || rot === 180 ? "contain" : "cover";
    const scale =
      currentFit === "cover"
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
  };

  // Use requestVideoFrameCallback when available (prevents “frozen” canvas streams)
  const rvfc = (video as any).requestVideoFrameCallback?.bind(video) as
    | ((cb: (now: number, metadata: any) => void) => number)
    | undefined;

  let rafId = 0;
  let vfcId = 0;

  const loop = () => {
    if (!running) return;
    draw();

    if (rvfc) {
      vfcId = rvfc(() => loop());
    } else {
      rafId = requestAnimationFrame(loop);
    }
  };

  loop();

  return {
    track: outputTrack,
    setRotation,
    stop: () => {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      try {
        (video as any).cancelVideoFrameCallback?.(vfcId);
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
