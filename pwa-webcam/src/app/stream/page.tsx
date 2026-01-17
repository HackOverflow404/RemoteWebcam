"use client";

import { useRouter, useSearchParams } from "next/navigation";
import React, {
  useState,
  useCallback,
  useEffect,
  Suspense,
  useMemo,
} from "react";

const AudioVolumeIndicator = React.lazy(
  () => import("@/components/AudioVolumeIndicator")
);

import useMediaStream from "@/lib/useMediaStream";
import useWebRTCStream from "@/lib/useWebRTCStream";
import useOrientationState from "@/lib/useOrientationState";

// --- Icon mappings ---
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

function StreamPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const { code, webcam, mic } = useMemo(() => {
    const extractedCode = searchParams.get("code") || "";
    const extractedWebcam = searchParams.get("webcam") === "true";
    const extractedMic = searchParams.get("mic") === "true";

    return {
      code: extractedCode,
      webcam: extractedWebcam,
      mic: extractedMic,
    };
  }, [searchParams]);

  const sessionCode = code;
  const initialWebcam = webcam;
  const initialMic = mic;

  const fps = "60";
  const resolution = "hd";
  const exposure = 0;

  const { isLandscape, angle: rot } = useOrientationState();

  const handleRemoteTermination = useCallback(() => {
    setTimeout(() => router.push("/"), 1500);
  }, [router]);

  // -- Media Stream Hook --
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

  // -- WebRTC Hook --
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

  // --- rotation + viewport sizing ---
  useEffect(() => {
    let raf = 0;

    const normalize = (deg: number) => ((deg % 360) + 360) % 360;

    const getAngle = () => {
      // 1) Modern browsers (Chrome/Android, some iOS contexts)
      const so = window.screen?.orientation;
      if (so && typeof so.angle === "number") return so.angle;

      // 2) iOS Safari (most reliable)
      const w = window as unknown as { orientation?: number };
      if (typeof w.orientation === "number") return w.orientation;

      // 3) Fallback heuristic
      return window.innerWidth > window.innerHeight ? 90 : 0;
    };

    const emit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setTimeout(() => {
          const angle = normalize(getAngle());
          handleRotate(angle);
        }, 50);
      });
    };

    // Run once on mount (important on iOS)
    emit();

    const handleVisibilityChange = () => {
      if (!document.hidden) emit();
    }

    // iOS Safari triggers this reliably
    window.addEventListener("orientationchange", emit, { passive: true });

    // Also useful because Safari sometimes “resizes” without firing orientationchange
    window.addEventListener("resize", emit, { passive: true });

    // Best signal for the *visual* viewport on iOS (address bar collapse/expand, etc.)
    window.visualViewport?.addEventListener("resize", emit, { passive: true });

    // Coming back from background often needs a refresh
    window.addEventListener("pageshow", emit, { passive: true });
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Use ScreenOrientation event where it exists (harmless on iOS; helpful elsewhere)
    window.screen?.orientation?.addEventListener?.("change", emit);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("orientationchange", emit);
      window.removeEventListener("resize", emit);
      window.visualViewport?.removeEventListener("resize", emit);
      window.removeEventListener("pageshow", emit);
      window.screen?.orientation?.removeEventListener?.("change", emit);
      window.removeEventListener("visibilitychange", handleVisibilityChange);

    };
  }, [handleRotate]);

  const handleBack = useCallback(() => {
    stopStream();
    router.push("/");
  }, [stopStream, router]);

  // Calculate dimensions based on rotation
  const containerWidth = isLandscape ? "var(--app-vh)" : "var(--app-vw)";
  const containerHeight = isLandscape ? "var(--app-vw)" : "var(--app-vh)";

  return (
    <section
      className="fixed inset-0 overflow-hidden bg-black"
      style={{
        transform: `rotate(${-rot}deg)`,
        transformOrigin: "center center",
        width: containerWidth,
        height: containerHeight,
        left: isLandscape ? `calc((var(--app-vw) - var(--app-vh)) / 2)` : "0",
        top: isLandscape ? `calc((var(--app-vh) - var(--app-vw)) / 2)` : "0",
      }}
      onDoubleClick={async () => {
        console.log("Double tap registered");
        const newTrack = await flipCamera();
        if (newTrack && isStreamOn) replaceTrack("video", newTrack);
      }}>
      <div>
        {isLoadingMedia && (
          <div className="absolute inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 pointer-events-none">
            <div className="text-white text-2xl" aria-label="Loading Media">Loading Media...</div>
          </div>
        )}

        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          controls={false}
          style={{
            transform: `scaleX(${isFrontCamera ? "-1" : "1"})`,
            transition: "opacity 0.3s ease",
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
          className="absolute inset-0 object-cover z-0 m-0 p-0"
        />

        {errorMessage && (
          <div
            className="absolute top-24 left-0 right-0 flex justify-center animate-pulse z-20"
            aria-label={"Error Message: " + errorMessage}
          >
            <div className="bg-red-500 text-white px-4 py-2 rounded-md flex items-center">
              <span>{errorMessage}</span>
              <button className="ml-2" onClick={() => { }}>
                ✕
              </button>
            </div>
          </div>
        )}

        {/* Overlay */}
        <div
          className="absolute inset-0 flex flex-col items-center z-10"
        >
          <header className={`flex absolute top-0 left-0 right-0 w-full py-5 justify-evenly z-10`}>
            <button
              onClick={handleBack}
              className="p-3"
              aria-label="Return"
              style={{
                transform: `rotate(${rot}deg)`,
              }}
            >
              <span className="material-symbols-outlined">keyboard_return</span>
            </button>

            {sessionCode && (
              <div aria-label={"Session Code: " + sessionCode} className="bg-black bg-opacity-50 flex items-center justify-center text-white h-10 px-3 py-1 rounded-md">
                Code: {sessionCode}
              </div>
            )}

            <div
              className={`flex items-center ${connectionStatus === "connected"
                ? "text-green-500"
                : connectionStatus === "connecting"
                  ? "text-yellow-500"
                  : connectionStatus === "disconnected"
                    ? "text-gray-500"
                    : "text-red-500"
                }`}
              aria-label={"Connection status: " + connectionStatus}
            >
              <span className="material-symbols-outlined">
                {icons.connection[connectionStatus]}
              </span>
              <span className="ml-2">
                {connectionStatus.charAt(0).toUpperCase() +
                  connectionStatus.slice(1)}
              </span>
            </div>

          </header>

          {/* Bottom settings */}
          <footer className="flex flex-col absolute bottom-0 left-0 right-0 w-full py-4 justify-evenly z-10">
            {isMicOn === "on" && media && media.getAudioTracks().length > 0 && (
              <React.Suspense fallback={<div>Loading Mic Volume...</div>}>
                <AudioVolumeIndicator isEnabled={true} mediaStream={media} />
              </React.Suspense>
            )}

            <div className="flex flex-row w-full justify-evenly">
              <button
                onClick={() => { toggleMic(); relayToggle("mic", isMicOn == "on" ? "off" : "on"); }}
                className="p-3 w-15 h-15 flex items-center justify-center"
                aria-label={
                  isMicOn === "on" ? "Mute Microphone" : "Unmute Microphone"
                }
                style={{
                  transform: `rotate(${rot}deg)`,
                }}
              >
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: "40px" }}
                >
                  {icons.microphone[isMicOn]}
                </span>
              </button>

              <button
                onClick={() => { toggleMedia(); relayToggle("media", isMicOn == "off" && isVidOn == "off" ? "on" : "off"); }}
                className={`p-3 w-15 h-15 flex items-center justify-center ${isStreamOn
                  ? "text-red-500"
                  : connectionStatus === "connecting"
                    ? "text-yellow-500"
                    : "text-green-500"
                  }`}
                aria-label={isStreamOn ? "Pause Streaming" : "Resume Streaming"}
                style={{
                  transform: `rotate(${rot}deg)`,
                }}
              >
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: "80px" }}
                >
                  {isStreamOn
                    ? "radio_button_checked"
                    : "radio_button_unchecked"}
                </span>
              </button>

              <button
                onClick={() => { toggleVid(); relayToggle("cam", isVidOn == "on" ? "off" : "on"); }}
                className="p-3 w-15 h-15 flex items-center justify-center"
                aria-label={isVidOn === "on" ? "Stop Video" : "Start Video"}
                style={{
                  transform: `rotate(${rot}deg)`,
                }}
              >
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: "40px" }}
                >
                  {icons.video[isVidOn]}
                </span>
              </button>
            </div>
          </footer>
        </div>
      </div>
    </section>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div>Loading stream...</div>}>
      <StreamPage />
    </Suspense>
  );
}