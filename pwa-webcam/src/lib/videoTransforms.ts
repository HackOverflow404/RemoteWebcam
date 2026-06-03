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

  let running = true;
  let ready = false;

  // Physical device rotation in degrees (0/90/180/270), updated by setRotation().
  // Used to compute the canvas correction for platforms where ctx.drawImage()
  // delivers raw sensor pixels without orientation correction (iOS Safari).
  let rot = 0;

  const ensurePlay = () => { video.play().catch(() => {}); };
  video.onloadedmetadata = () => { ready = true; ensurePlay(); };
  video.onloadeddata = ensurePlay;

  const draw = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, outW, outH);

    if (!ready || video.readyState < 2) return;

    const srcW = video.videoWidth || 1;
    const srcH = video.videoHeight || 1;

    // On iOS Safari (and many Android browsers) ctx.drawImage() gives the raw
    // camera sensor pixels WITHOUT the orientation correction that the <video>
    // element's display applies. The iPhone sensor is landscape-oriented, so
    // when getUserMedia delivers landscape dims (srcW > srcH), the drawn pixels
    // are always landscape regardless of how the phone is held.
    //
    // When srcH > srcW the browser negotiated portrait output — pixels are
    // already correctly oriented, so just contain-fit without rotation.
    //
    // Correction angle maps physical device rotation to canvas rotation:
    //   rot=0   (portrait)         → correctionDeg=270 (= −90°): landscape→portrait
    //   rot=90  (landscape-right)  → correctionDeg=0:   landscape→landscape ✓
    //   rot=180 (upside-down)      → correctionDeg=90:  landscape→portrait flipped
    //   rot=270 (landscape-left)   → correctionDeg=180: landscape→landscape flipped
    const cameraIsLandscape = srcW > srcH;
    const correctionDeg = cameraIsLandscape ? ((rot - 90 + 360) % 360) : 0;
    const correctionRad = (correctionDeg * Math.PI) / 180;

    // After applying correctionDeg rotation, effective display dimensions are swapped
    // for 90° or 270° rotations (landscape frame becomes portrait in canvas space).
    const is90or270 = correctionDeg === 90 || correctionDeg === 270;
    const effW = is90or270 ? srcH : srcW;
    const effH = is90or270 ? srcW : srcH;

    // Contain: scale to fit within outW×outH preserving aspect ratio.
    const scale = Math.min(outW / effW, outH / effH);
    const drawW = srcW * scale;
    const drawH = srcH * scale;

    ctx.save();
    ctx.translate(outW / 2, outH / 2);
    if (correctionRad !== 0) ctx.rotate(correctionRad);
    ctx.drawImage(video, -drawW / 2, -drawH / 2, drawW, drawH);
    ctx.restore();
  };

  // requestVideoFrameCallback prevents frozen canvas streams on iOS
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
    setRotation: (r: number) => { rot = r; },
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
