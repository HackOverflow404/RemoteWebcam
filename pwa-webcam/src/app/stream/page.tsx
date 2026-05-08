"use client";

import { useRouter, useSearchParams } from "next/navigation";
import React, {
  useState,
  useCallback,
  useEffect,
  useRef,
  Suspense,
  useMemo,
} from "react";

const AudioVolumeIndicator = React.lazy(
  () => import("@/components/AudioVolumeIndicator")
);

import useMediaStream from "@/lib/useMediaStream";
import useWebRTCStream from "@/lib/useWebRTCStream";

const icons = {
  fps: { "30": "30fps", "60": "60fps" } as const,
  resolution: { sd: "sd", hd: "hd", "4k": "4k" } as const,
  microphone: { on: "mic", off: "mic_off", error: "mic_alert" } as const,
  video: {
    on: "videocam",
    off: "videocam_off",
    error: "videocam_alert",
  } as const,
  connection: {
    connecting: "cloud_sync",
    connected: "cloud_done",
    disconnected: "cloud_off",
    error: "cloud_alert",
  } as const,
};

// Smooth rotation style applied to each individual icon/button
const rotStyle = (rot: number): React.CSSProperties => ({
  transform: `rotate(${rot}deg)`,
  transition: "transform 0.3s ease",
  display: "inline-block",
});

function StreamPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const { code, webcam, mic } = useMemo(() => {
    return {
      code: searchParams.get("code") || "",
      webcam: searchParams.get("webcam") === "true",
      mic: searchParams.get("mic") === "true",
    };
  }, [searchParams]);

  const sessionCode = code;
  const initialWebcam = webcam;
  const initialMic = mic;

  const fps = "60";
  const resolution = "hd";
  const exposure = 0;

  const [rot, setRot] = useState<number>(0);
  const rotRef = useRef<number>(0);

  const handleRemoteTermination = useCallback(() => {
    setTimeout(() => router.push("/"), 1500);
  }, [router]);

  const {
    videoRef,
    stream: media,
    start: startMedia,
    stop: stopMedia,
    toggleMic,
    toggleVid,
    toggleMedia,
    flipCamera,
    isMicOn,
    isVidOn,
    isFrontCamera,
    loading: isLoadingMedia,
    error: mediaStreamError,
  } = useMediaStream({
    initialAudio: initialMic,
    initialVideo: initialWebcam,
    fps,
    resolution,
  });

  const {
    startStream,
    stopStream,
    replaceTrack,
    handleRotate,
    relayToggle,
    isStreamOn,
    connectionStatus,
    error: RTCStreamError,
  } = useWebRTCStream({
    videoRef,
    media,
    sessionCode,
    isMicOn,
    isVidOn,
    isFrontCamera,
    resolution,
    fps: Number(fps),
    exposure,
    toggleMic,
    toggleVid,
    startMedia,
    stopMedia,
    handleRemoteTermination,
  });

  const allErrors = [mediaStreamError, RTCStreamError].filter(Boolean);
  const errorMessage = allErrors[0] || null;

  // --- initial media + stream startup ---
  useEffect(() => {
    if (sessionCode) startMedia();
  }, [sessionCode]);

  useEffect(() => {
    if (media && !isLoadingMedia && !isStreamOn) startStream();
  }, [media, isLoadingMedia]);

  useEffect(() => {
    if (connectionStatus === "disconnected" && isStreamOn) stopMedia();
  }, [connectionStatus]);

  // --- attempt to lock orientation (works on Android/Chrome; silently fails on iOS) ---
  useEffect(() => {
    (screen.orientation as any)?.lock?.("portrait")?.catch?.(() => {});
  }, []);

  // --- physical orientation detection + WebRTC stream rotation ---
  useEffect(() => {
    let raf = 0;

    const normalize = (deg: number) => ((deg % 360) + 360) % 360;

    const getAngle = (): number => {
      // 1) window.orientation — reflects physical device rotation even in
      //    portrait-locked PWA mode on iOS (unlike screen.orientation which
      //    always reports the LOCKED orientation in that context).
      const w = window as any;
      if (typeof w.orientation === "number") {
        const o = w.orientation as number;
        if (o !== 0) return normalize(o); // 90, -90, 180
        // orientation says 0 — only trust it when viewport also says portrait
        if (window.innerWidth <= window.innerHeight) return 0;
        // viewport is landscape but window.orientation lied (some older iOS) — fall through
      }

      // 2) Screen Orientation API — reliable on Android / Chrome / non-locked iOS
      const so = window.screen?.orientation;
      if (so?.type) {
        switch (so.type) {
          case "landscape-primary":   return 90;
          case "landscape-secondary": return 270;
          case "portrait-secondary":  return 180;
          default:                    return 0;
        }
      }

      // 3) Aspect-ratio heuristic (can't distinguish 90° from 270°)
      return window.innerWidth > window.innerHeight ? 90 : 0;
    };

    const emit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // 300 ms lets the iOS viewport finish settling before we read dimensions
        setTimeout(() => {
          const angle = normalize(getAngle());
          if (angle !== rotRef.current) {
            rotRef.current = angle;
            setRot(angle);
            handleRotate(angle);
          }
        }, 300);
      });
    };

    const handleVisibilityChange = () => { if (!document.hidden) emit(); };

    emit(); // run once on mount

    window.addEventListener("orientationchange", emit, { passive: true });
    window.addEventListener("resize", emit, { passive: true });
    window.visualViewport?.addEventListener("resize", emit, { passive: true });

    const mqLandscape = window.matchMedia("(orientation: landscape)");
    mqLandscape.addEventListener("change", emit);

    window.addEventListener("pageshow", emit, { passive: true });
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.screen?.orientation?.addEventListener?.("change", emit);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("orientationchange", emit);
      window.removeEventListener("resize", emit);
      window.visualViewport?.removeEventListener("resize", emit);
      mqLandscape.removeEventListener("change", emit);
      window.removeEventListener("pageshow", emit);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.screen?.orientation?.removeEventListener?.("change", emit);
    };
  }, [handleRotate]);

  const handleBack = useCallback(() => {
    stopStream();
    router.push("/");
  }, [stopStream, router]);

  const connectionColor =
    connectionStatus === "connected"   ? "#22c55e"
    : connectionStatus === "connecting" ? "#eab308"
    : connectionStatus === "disconnected" ? "#9ca3af"
    : "#ef4444";

  return (
    <section
      className="fixed inset-0 overflow-hidden bg-black"
      onDoubleClick={async () => {
        const newTrack = await flipCamera();
        if (newTrack && isStreamOn) replaceTrack("video", newTrack);
      }}
    >
      {/* Loading overlay */}
      {isLoadingMedia && (
        <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-50 pointer-events-none">
          <div className="flex flex-col items-center gap-3">
            <div
              className="w-10 h-10 rounded-full border-2 border-white/20 border-t-white animate-spin"
              aria-hidden="true"
            />
            <span className="text-white/80 text-sm tracking-wide">Starting camera…</span>
          </div>
        </div>
      )}

      {/* Camera preview */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        controls={false}
        className="absolute inset-0 w-full h-full object-cover z-0"
        style={{ transform: `scaleX(${isFrontCamera ? "-1" : "1"})` }}
      />

      {/* Error banner */}
      {errorMessage && (
        <div
          className="absolute left-0 right-0 flex justify-center z-20 px-4"
          style={{ top: "calc(env(safe-area-inset-top, 0px) + 5rem)" }}
          aria-label={"Error: " + errorMessage}
        >
          <div className="bg-red-500/90 backdrop-blur-sm text-white px-4 py-2 rounded-xl flex items-center gap-2 shadow-lg">
            <span className="material-symbols-outlined text-base">error</span>
            <span className="text-sm">{errorMessage}</span>
          </div>
        </div>
      )}

      {/* Overlay */}
      <div className="absolute inset-0 flex flex-col justify-between z-10 pointer-events-none">
        {/* ── Header ── */}
        <header
          className="flex items-center justify-between pointer-events-auto px-4"
          style={{
            paddingTop: "max(1.25rem, env(safe-area-inset-top, 0px))",
            paddingBottom: "0.75rem",
            background: "linear-gradient(to bottom, rgba(0,0,0,0.55) 0%, transparent 100%)",
          }}
        >
          <button
            onClick={handleBack}
            className="p-2 rounded-full active:bg-white/10 transition-colors"
            aria-label="Return"
          >
            <span
              className="material-symbols-outlined text-white"
              style={{ ...rotStyle(rot), fontSize: "28px" }}
            >
              keyboard_return
            </span>
          </button>

          {sessionCode && (
            <div
              className="bg-black/50 backdrop-blur-sm text-white text-sm px-3 py-1.5 rounded-lg tracking-widest font-mono"
              aria-label={"Session Code: " + sessionCode}
            >
              {sessionCode}
            </div>
          )}

          <div
            className="flex items-center gap-1.5"
            style={{ color: connectionColor }}
            aria-label={"Connection: " + connectionStatus}
          >
            <span
              className="material-symbols-outlined"
              style={{ ...rotStyle(rot), fontSize: "24px" }}
            >
              {icons.connection[connectionStatus]}
            </span>
            <span className="text-xs font-medium capitalize hidden sm:block">
              {connectionStatus}
            </span>
          </div>
        </header>

        {/* ── Footer ── */}
        <footer
          className="flex flex-col pointer-events-auto"
          style={{
            paddingBottom: "max(1.25rem, env(safe-area-inset-bottom, 0px))",
            paddingTop: "0.75rem",
            background: "linear-gradient(to top, rgba(0,0,0,0.55) 0%, transparent 100%)",
          }}
        >
          {isMicOn === "on" && media && media.getAudioTracks().length > 0 && (
            <div className="px-8 mb-2">
              <React.Suspense fallback={null}>
                <AudioVolumeIndicator isEnabled={true} mediaStream={media} />
              </React.Suspense>
            </div>
          )}

          <div className="flex flex-row items-center justify-evenly w-full">
            {/* Mic toggle */}
            <button
              onClick={() => {
                toggleMic();
                relayToggle("mic", isMicOn === "on" ? "off" : "on");
              }}
              className="p-3 rounded-full active:bg-white/10 transition-colors"
              aria-label={isMicOn === "on" ? "Mute Microphone" : "Unmute Microphone"}
            >
              <span
                className="material-symbols-outlined text-white"
                style={{ ...rotStyle(rot), fontSize: "36px" }}
              >
                {icons.microphone[isMicOn]}
              </span>
            </button>

            {/* Stream toggle (large, center) */}
            <button
              onClick={() => {
                toggleMedia();
                relayToggle(
                  "media",
                  isMicOn === "off" && isVidOn === "off" ? "on" : "off"
                );
              }}
              className="p-3 rounded-full active:bg-white/10 transition-colors"
              style={{
                color: isStreamOn
                  ? "#ef4444"
                  : connectionStatus === "connecting"
                    ? "#eab308"
                    : "#22c55e",
              }}
              aria-label={isStreamOn ? "Pause Streaming" : "Resume Streaming"}
            >
              <span
                className="material-symbols-outlined"
                style={{ ...rotStyle(rot), fontSize: "72px" }}
              >
                {isStreamOn ? "radio_button_checked" : "radio_button_unchecked"}
              </span>
            </button>

            {/* Camera toggle */}
            <button
              onClick={() => {
                toggleVid();
                relayToggle("cam", isVidOn === "on" ? "off" : "on");
              }}
              className="p-3 rounded-full active:bg-white/10 transition-colors"
              aria-label={isVidOn === "on" ? "Stop Video" : "Start Video"}
            >
              <span
                className="material-symbols-outlined text-white"
                style={{ ...rotStyle(rot), fontSize: "36px" }}
              >
                {icons.video[isVidOn]}
              </span>
            </button>
          </div>
        </footer>
      </div>

    </section>
  );
}

export default function Page() {
  return (
    <Suspense fallback={
      <div className="fixed inset-0 bg-black flex items-center justify-center">
        <div className="w-10 h-10 rounded-full border-2 border-white/20 border-t-white animate-spin" />
      </div>
    }>
      <StreamPage />
    </Suspense>
  );
}
