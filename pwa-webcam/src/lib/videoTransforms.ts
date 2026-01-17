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
    fit = "cover",
    background = "black",
  } = opts;

  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.style.position = "fixed";
  video.style.left = "-9999px";
  video.style.top = "-9999px";
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

  let rot: Rotation = rotation;
  let rad = rot === 90 ? Math.PI / 2 : rot === -90 ? -Math.PI / 2 : 0;

  const setRotation = (r: Rotation) => {
    rot = r;
    rad = r === 90 ? Math.PI / 2 : r === -90 ? -Math.PI / 2 : 0;

    // Swap canvas dimensions on rotation
    if (r === 90 || r === -90) {
      canvas.width = outH;
      canvas.height = outW;
    } else {
      canvas.width = outW;
      canvas.height = outH;
    }
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

    const effW = rot === 90 || rot === -90 ? srcH : srcW;
    const effH = rot === 90 || rot === -90 ? srcW : srcH;

    const scale =
      fit === "cover"
        ? Math.max(cw / effW, ch / effH)
        : Math.min(cw / effW, ch / effH);

    const drawW = effW * scale;
    const drawH = effH * scale;

    ctx.save();
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate(rad);

    if (mirror) {
      if (rot === 0) ctx.scale(-1, 1);
      else ctx.scale(1, -1);
    }

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
      vfcId = rvfc(() => {
        if (running) loop();
      });
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
