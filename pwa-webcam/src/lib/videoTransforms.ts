export interface ProcessedTrack {
  track: MediaStreamTrack;
  stop: () => void;
}

export function createMirroredTrack(
  inputTrack: MediaStreamTrack,
  mirror: boolean
): ProcessedTrack {
  const video = document.createElement("video");
  video.srcObject = new MediaStream([inputTrack]);
  video.muted = true;
  video.playsInline = true;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;

  const stream = canvas.captureStream();
  const outputTrack = stream.getVideoTracks()[0];

  let running = true;

  video.onloadedmetadata = () => {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    video.play();
  };

  function draw() {
    if (!running) return;

    ctx.save();
    if (mirror) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.restore();

    requestAnimationFrame(draw);
  }

  draw();

  return {
    track: outputTrack,
    stop: () => {
      running = false;
      outputTrack.stop();
      inputTrack.stop();
    },
  };
}