import { useEffect, useRef } from "react";
import { MdMic } from "react-icons/md";
import { getAudioContext } from "@/lib/audioContext";

const SAMPLE_MS = 80;

export default function AudioVolumeIndicator({ isEnabled, mediaStream }: { isEnabled: boolean; mediaStream: MediaStream | null }) {
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const track = mediaStream?.getAudioTracks()[0];
    if (!isEnabled || !track) return;

    const ctx = getAudioContext();
    if (!ctx) return;
    // Analyse only the audio track (and don't touch the stream's tracks on cleanup).
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    // Safari only processes nodes that lead to the destination; a dangling
    // analyser reads silence forever. Route it there through a muted gain.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(analyser);
    analyser.connect(mute);
    mute.connect(ctx.destination);
    const samples = new Float32Array(analyser.fftSize);

    // Normally already running (unlocked by the "Start Stream" tap). If not,
    // iOS only allows resuming inside a user gesture, so retry on the next tap.
    const resume = () => { if (ctx.state !== "running") void ctx.resume().catch(() => {}); };
    resume();
    const gestures = ["pointerdown", "touchend", "click"] as const;
    gestures.forEach((g) => document.addEventListener(g, resume, { capture: true, passive: true }));

    // Update the bar directly instead of via React state: no re-render of the
    // stream page 12x per second while the camera pipeline is running.
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      const rms = Math.sqrt(sum / samples.length);
      // dB scale: -60 dBFS (near silence) -> empty, 0 dBFS -> full.
      const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
      const level = Math.max(0, Math.min(1, (db + 60) / 60));
      if (barRef.current) barRef.current.style.transform = `scaleX(${level})`;
    }, SAMPLE_MS);

    return () => {
      clearInterval(timer);
      gestures.forEach((g) => document.removeEventListener(g, resume, { capture: true }));
      // The context is shared across pages; only detach this meter's nodes.
      source.disconnect();
      analyser.disconnect();
      mute.disconnect();
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
