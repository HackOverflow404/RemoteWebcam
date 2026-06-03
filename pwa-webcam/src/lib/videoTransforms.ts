export interface ProcessedTrack {
  track: MediaStreamTrack;
  stop: () => void;
  setRotation: (r: number) => void; // kept for API compat; canvas uses contain-fit
}

export function createTransformedTrack(
  inputTrack: MediaStreamTrack,
  opts: {
    outW: number;
    outH: number;
    fps?: number;
    background?: string;
  }
): ProcessedTrack {
  const { outW, outH, fps = 30, background = "black" } = opts;

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

  const ensurePlay = () => { video.play().catch(() => {}); };
  video.onloadedmetadata = () => { ready = true; ensurePlay(); };
  video.onloadeddata = ensurePlay;

  const draw = () => {
    // Clear with background
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, outW, outH);

    if (!ready || video.readyState < 2) return;

    const srcW = video.videoWidth || 1;
    const srcH = video.videoHeight || 1;

    // Contain: preserve aspect ratio, letterbox/pillarbox with black bars.
    // The browser already applies orientation transforms when drawing from a
    // camera-backed video element, so we never rotate here — doing so would
    // double-rotate and corrupt the stream.
    const scale = Math.min(outW / srcW, outH / srcH);
    const drawW = srcW * scale;
    const drawH = srcH * scale;

    ctx.drawImage(
      video,
      (outW - drawW) / 2,
      (outH - drawH) / 2,
      drawW,
      drawH
    );
  };

  // Use requestVideoFrameCallback when available (prevents frozen canvas streams)
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
    setRotation: (_r: number) => { /* no-op: canvas uses contain-fit, not rotation */ },
    stop: () => {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      try { (video as any).cancelVideoFrameCallback?.(vfcId); } catch {}
      try { outputTrack.stop(); } catch {}
      try { video.pause(); } catch {}
      video.srcObject = null;
    },
  };
}
