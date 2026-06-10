export interface ProcessedTrack {
  track: MediaStreamTrack;
  stop: () => void;
  setRotation: (r: number) => void;
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
  // Hint the WebRTC encoder that this is live motion video (not a screen/document),
  // so it allocates more bits for the stream instead of optimising for sharpness.
  try { (outputTrack as any).contentHint = "motion"; } catch {}

  let running = true;
  let ready = false;
  let rot = 0; // physical device rotation degrees (0/90/180/270)

  const ensurePlay = () => { video.play().catch(() => {}); };
  video.onloadedmetadata = () => { ready = true; ensurePlay(); };
  video.onloadeddata = ensurePlay;

  // Resume when page comes back to foreground (iOS suspends video in background)
  const onVisible = () => { if (!document.hidden) ensurePlay(); };
  document.addEventListener("visibilitychange", onVisible);

  const draw = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, outW, outH);

    if (!ready || video.readyState < 2) return;

    const srcW = video.videoWidth || 1;
    const srcH = video.videoHeight || 1;

    // iOS Safari's ctx.drawImage() gives raw landscape sensor pixels when the
    // camera reports landscape dims (srcW > srcH).  We must rotate the canvas
    // to make the person appear upright on the Linux side.
    //
    // Physical orientation → rot (from gyro):
    //   CW tilt  (left side down, gamma < 0) → rot = 270
    //   CCW tilt (right side down, gamma > 0) → rot = 90
    //
    // For landscape orientations (rot=90 or 270) the camera IS correctly aligned
    // with the physical device — no canvas rotation needed; the stream fills the
    // 1280×720 canvas as a proper landscape frame.
    //
    // For portrait/upside-down (rot=0/180) the sensor is 90° off — apply the
    // appropriate correction so Linux receives an upright portrait-letterboxed frame.
    //
    // Correction table (cameraIsLandscape = true):
    //   rot=0   (portrait)      → 270° (=−90°): unrotate landscape to portrait  ✓
    //   rot=90  (CCW landscape) →   0°: already correct                          ✓
    //   rot=180 (upside-down)   →  90°: unrotate other way                       ✓
    //   rot=270 (CW landscape)  →   0°: already correct (was 180° — WRONG)       ✓
    const cameraIsLandscape = srcW > srcH;
    let correctionDeg = 0;
    if (cameraIsLandscape) {
      if      (rot === 0)   correctionDeg = 270;
      else if (rot === 180) correctionDeg = 90;
      // rot === 90 or 270: both landscape orientations → 0° correction
    }
    const correctionRad = (correctionDeg * Math.PI) / 180;

    // After rotation, effective display dims may be swapped (90°/270° rotations)
    const is90or270 = correctionDeg === 90 || correctionDeg === 270;
    const effW = is90or270 ? srcH : srcW;
    const effH = is90or270 ? srcW : srcH;

    // Contain: scale to fit within outW×outH, letterbox/pillarbox remainder
    const scale = Math.min(outW / effW, outH / effH);
    const drawW = srcW * scale;
    const drawH = srcH * scale;

    ctx.save();
    ctx.translate(outW / 2, outH / 2);
    if (correctionRad !== 0) ctx.rotate(correctionRad);
    ctx.drawImage(video, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
  };

  // ─── Drawing loop ──────────────────────────────────────────────────────────
  // Strategy: use requestVideoFrameCallback (rvfc) when available — it fires
  // in sync with video frame delivery and prevents frozen canvas streams on iOS.
  // Additionally run a RAF watchdog in parallel: if rvfc stalls (video suspended
  // by iOS power management, page backgrounded, etc.), the watchdog detects the
  // gap and keeps drawing so the WebRTC stream never appears fully frozen.

  const rvfc = (video as any).requestVideoFrameCallback?.bind(video) as
    | ((cb: (now: number, metadata: any) => void) => number)
    | undefined;

  let rafId = 0;
  let vfcId = 0;
  let lastVfcMs = 0;      // timestamp of last rvfc draw
  let vfcScheduled = false; // whether an rvfc callback is pending

  if (rvfc) {
    const onVfc = () => {
      if (!running) return;
      vfcScheduled = false;
      lastVfcMs = performance.now();
      draw();
      vfcScheduled = true;
      vfcId = rvfc(onVfc);
    };

    // Kick off the rvfc loop
    vfcScheduled = true;
    vfcId = rvfc(onVfc);

    // RAF watchdog: runs every frame, wakes up the rvfc loop if it stalled.
    // 500 ms without an rvfc callback → assume video suspended → fall back.
    const STALL_MS = 500;
    const watchdog = () => {
      if (!running) return;
      const now = performance.now();
      if (now - lastVfcMs > STALL_MS) {
        // rvfc has stalled — draw the current (possibly frozen) frame and
        // try to restart both video playback and the rvfc loop.
        draw();
        ensurePlay();
        if (!vfcScheduled) {
          vfcScheduled = true;
          vfcId = rvfc(onVfc);
        }
      }
      rafId = requestAnimationFrame(watchdog);
    };
    rafId = requestAnimationFrame(watchdog);
  } else {
    // Plain RAF loop for browsers without rvfc
    const loop = () => {
      if (!running) return;
      draw();
      rafId = requestAnimationFrame(loop);
    };
    loop();
  }

  return {
    track: outputTrack,
    setRotation: (r: number) => { rot = r; },
    stop: () => {
      running = false;
      document.removeEventListener("visibilitychange", onVisible);
      if (rafId) cancelAnimationFrame(rafId);
      try { (video as any).cancelVideoFrameCallback?.(vfcId); } catch {}
      try { outputTrack.stop(); } catch {}
      try { video.pause(); } catch {}
      video.srcObject = null;
    },
  };
}
