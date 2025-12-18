export interface ProcessedTrack {
  track: MediaStreamTrack;
  stop: () => void;
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
  video.srcObject = new MediaStream([inputTrack]);
  video.muted = true;
  video.playsInline = true;

  // ✅ FIXED OUTPUT SIZE BEFORE CAPTURE
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;

  const ctx = canvas.getContext("2d", { alpha: false })!;
  const stream = canvas.captureStream(fps);
  const outputTrack = stream.getVideoTracks()[0];

  let running = true;
  let rafId = 0;
  let ready = false;

  const rad =
    rotation === 90 ? Math.PI / 2 : rotation === -90 ? -Math.PI / 2 : 0;

  video.onloadedmetadata = () => {
    ready = true;
    video.play().catch(() => {});
  };

  const draw = () => {
    if (!running) return;

    const cw = outW;
    const ch = outH;

    // background
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, cw, ch);

    if (ready) {
      const srcW = video.videoWidth || 1;
      const srcH = video.videoHeight || 1;

      // After rotation, the bounding box swaps
      const effW = rotation === 90 || rotation === -90 ? srcH : srcW;
      const effH = rotation === 90 || rotation === -90 ? srcW : srcH;

      const scale =
        fit === "cover"
          ? Math.max(cw / effW, ch / effH)
          : Math.min(cw / effW, ch / effH);

      const drawW = srcW * scale;
      const drawH = srcH * scale;

      ctx.save();
      ctx.translate(cw / 2, ch / 2);
      ctx.rotate(rad);

      // mirror in output space
      if (mirror) ctx.scale(-1, 1);

      ctx.drawImage(video, -drawW / 2, -drawH / 2, drawW, drawH);
      ctx.restore();
    }

    rafId = requestAnimationFrame(draw);
  };

  rafId = requestAnimationFrame(draw);

  return {
    track: outputTrack,
    stop: () => {
      running = false;
      cancelAnimationFrame(rafId);
      try { outputTrack.stop(); } catch {}
      try { video.pause(); } catch {}
      video.srcObject = null;
    },
  };
}