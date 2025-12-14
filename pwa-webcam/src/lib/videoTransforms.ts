export interface ProcessedTrack {
  track: MediaStreamTrack;
  stop: () => void;
}

export function createMirroredTrack(
  inputTrack: MediaStreamTrack,
  mirror: boolean,
  fps: number = 30
): ProcessedTrack {
  const video = document.createElement("video");
  video.srcObject = new MediaStream([inputTrack]);
  video.muted = true;
  video.playsInline = true;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false })!;

  const stream = canvas.captureStream(fps);
  const outputTrack = stream.getVideoTracks()[0];

  let running = true;
  let rafId = 0;

  video.onloadedmetadata = () => {
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    video.play().catch(() => {});
  };

  function draw() {
    if (!running) return;

    const w = canvas.width;
    const h = canvas.height;

    ctx.save();
    if (mirror) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, w, h);
    ctx.restore();

    rafId = requestAnimationFrame(draw);
  }

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

export function createLetterboxedTrack(
  inputTrack: MediaStreamTrack,
  outW: number,
  outH: number,
  fps: number = 30,
  background: string = "black"
): ProcessedTrack {
  const video = document.createElement("video");
  video.srcObject = new MediaStream([inputTrack]);
  video.muted = true;
  video.playsInline = true;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false })!;
  canvas.width = outW;
  canvas.height = outH;

  const stream = canvas.captureStream(fps);
  const outputTrack = stream.getVideoTracks()[0];

  let running = true;
  let rafId = 0;

  video.onloadedmetadata = () => {
    video.play().catch(() => {});
  };

  function draw() {
    if (!running) return;

    const srcW = video.videoWidth || 0;
    const srcH = video.videoHeight || 0;

    ctx.fillStyle = background;
    ctx.fillRect(0, 0, outW, outH);

    if (srcW > 0 && srcH > 0) {
      const scale = Math.min(outW / srcW, outH / srcH);
      const newW = Math.round(srcW * scale);
      const newH = Math.round(srcH * scale);
      const xOff = Math.floor((outW - newW) / 2);
      const yOff = Math.floor((outH - newH) / 2);
      ctx.drawImage(video, xOff, yOff, newW, newH);
    }

    rafId = requestAnimationFrame(draw);
  }

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
