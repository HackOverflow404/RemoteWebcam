export function createMirroredTrack(
  inputTrack: MediaStreamTrack,
  mirror: boolean
): MediaStreamTrack {
  const video = document.createElement("video");
  video.srcObject = new MediaStream([inputTrack]);
  video.muted = true;
  video.playsInline = true;
  video.play();

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;

  const draw = () => {
    if (video.videoWidth && video.videoHeight) {
      if (
        canvas.width !== video.videoWidth ||
        canvas.height !== video.videoHeight
      ) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }

      ctx.save();
      if (mirror) {
        ctx.scale(-1, 1);
        ctx.drawImage(video, -canvas.width, 0);
      } else {
        ctx.drawImage(video, 0, 0);
      }
      ctx.restore();
    }
    requestAnimationFrame(draw);
  };

  draw();

  return canvas.captureStream().getVideoTracks()[0];
}