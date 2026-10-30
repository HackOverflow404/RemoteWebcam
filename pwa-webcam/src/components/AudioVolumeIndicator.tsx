import { useEffect, useRef } from "react";
import { MdMic } from "react-icons/md";

const SAMPLE_MS = 80;

export default function AudioVolumeIndicator({ isEnabled, mediaStream }: { isEnabled: boolean; mediaStream: MediaStream | null }) {
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const track = mediaStream?.getAudioTracks()[0];
    if (!isEnabled || !track) return;

    const Ctx = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx: AudioContext = new Ctx();
    // Analyse only the audio track (and don't touch the stream's tracks on cleanup).
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);

    // Update the bar directly instead of via React state: no re-render of the
    // stream page 12x per second while the camera pipeline is running.
    const timer = setInterval(() => {
      if (ctx.state === "suspended") void ctx.resume();
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      const rms = Math.sqrt(sum / samples.length);
      const level = Math.min(1, rms * 4);
      if (barRef.current) barRef.current.style.transform = `scaleX(${level})`;
    }, SAMPLE_MS);

    return () => {
      clearInterval(timer);
      source.disconnect();
      void ctx.close();
    };
  }, [isEnabled, mediaStream]);

  if (!isEnabled) return null;

  return (
    <div className="w-full flex items-center justify-center gap-2 px-5 my-2">
      <MdMic size={20} color="white" aria-hidden="true" />
      <div className="relative flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
        <div
          ref={barRef}
          style={{
            transform: "scaleX(0)",
            transformOrigin: "left center",
            transition: `transform ${SAMPLE_MS}ms linear`,
            width: "100%",
            height: "100%",
          }}
          className="bg-blue-500"
        />
      </div>
    </div>
  );
}
