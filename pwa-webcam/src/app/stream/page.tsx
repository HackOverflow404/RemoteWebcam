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

// --- Icon mappings ---
const icons = {
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

// stream/page.tsx (only the StreamPage component contents changed)

function StreamPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const { code, webcam, mic } = useMemo(() => {
    const extractedCode = searchParams.get("code") || "";
    const extractedWebcam = searchParams.get("webcam") === "true";
    const extractedMic = searchParams.get("mic") === "true";
    return { code: extractedCode, webcam: extractedWebcam, mic: extractedMic };
  }, [searchParams]);

  const sessionCode = code;
  const initialWebcam = webcam;
  const initialMic = mic;

  const [vp, setVp] = useState({ w: 1, h: 1 });
  const [rotateDeg, setRotateDeg] = useState<0 | 90 | -90>(0);

  const fps: "30" | "60" = "60";
  const resolution: "sd" | "hd" | "4k" = "hd";
  const exposure = 0;

  const handleRemoteTermination = useCallback(() => {
    setTimeout(() => router.push("/"), 1500);
  }, [router]);

  const {
    videoRef,
    stream: media,
    start: startMedia,
    stop: stopMedia,
    toggleMic,
    toggleVideo,
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
    startMedia,
    stopMedia,
    handleRemoteTermination,
  });

  const allErrors = [mediaStreamError, RTCStreamError].filter(Boolean);
  const errorMessage = allErrors[0] || null;

  useEffect(() => {
    if (sessionCode) startMedia();
  }, [sessionCode, startMedia]);

  useEffect(() => {
    if (media && !isLoadingMedia && !isStreamOn) startStream();
  }, [media, isLoadingMedia, isStreamOn, startStream]);

  useEffect(() => {
    if (connectionStatus === "disconnected" && isStreamOn) stopMedia();
  }, [connectionStatus, isStreamOn, stopMedia]);

  const computeRotation = useCallback((w: number, h: number): 0 | 90 | -90 => {
    const isLandscape = w > h;
    if (!isLandscape) return 0;

    const type = window.screen?.orientation?.type;
    if (type === "landscape-secondary") return -90;
    if (type === "landscape-primary") return 90;

    const screenAngle = (window.screen?.orientation?.angle ?? 0) as number;
    const legacyAngle =
      typeof (window as any).orientation === "number"
        ? (window as any).orientation
        : 0;

    const angle = screenAngle || legacyAngle || 0;
    return angle === -90 || angle === 270 ? -90 : 90;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    let raf = 0;
    const recompute = () => {
      const vv = window.visualViewport;
      const w = Math.round(vv?.width ?? window.innerWidth);
      const h = Math.round(vv?.height ?? window.innerHeight);

      setVp({ w, h });

      const rot = computeRotation(w, h);
      setRotateDeg(rot);

      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => handleRotate(w, h));
    };

    recompute();
    window.addEventListener("resize", recompute);
    window.addEventListener("orientationchange", recompute);
    window.visualViewport?.addEventListener?.("resize", recompute);
    window.screen?.orientation?.addEventListener?.("change", recompute);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", recompute);
      window.removeEventListener("orientationchange", recompute);
      window.visualViewport?.removeEventListener?.("resize", recompute);
      window.screen?.orientation?.removeEventListener?.("change", recompute);
    };
  }, [computeRotation, handleRotate]);

  const videoStyle = useMemo<React.CSSProperties>(() => {
    const mirror = isFrontCamera ? -1 : 1;

    if (rotateDeg === 0) {
      return {
        position: "fixed",
        inset: 0,
        width: "100dvw",
        height: "100dvh",
        objectFit: "cover",
        transform: `scaleX(${mirror})`,
        transformOrigin: "center",
      };
    }

    return {
      position: "fixed",
      top: "50%",
      left: "50%",
      width: vp.h,
      height: vp.w,
      objectFit: "cover",
      transformOrigin: "center",
      transform: `translate(-50%, -50%) rotate(${rotateDeg}deg) scaleX(${mirror})`,
    };
  }, [rotateDeg, vp.w, vp.h, isFrontCamera]);

  const handleBack = useCallback(() => {
    stopStream();
    router.push("/");
  }, [stopStream, router]);

  const insetTop = "env(safe-area-inset-top)";
  const insetRight = "env(safe-area-inset-right)";
  const insetBottom = "env(safe-area-inset-bottom)";
  const insetLeft = "env(safe-area-inset-left)";

  const isLandscape = rotateDeg !== 0;

  // These are the "thickness" of the side bars in landscape.
  const HEADER_THICKNESS = 56;
  const FOOTER_THICKNESS = 120;

  // Counter-rotate *individual* elements (icons/text) so they read upright
  const counterRotateStyle = useMemo<React.CSSProperties>(() => {
    if (rotateDeg === 0) return {};
    return { transform: `rotate(${-rotateDeg}deg)` };
  }, [rotateDeg]);

  // Header positioning: portrait = top, landscape = right side (rotated)
  const headerPosStyle = useMemo<React.CSSProperties>(() => {
    if (!isLandscape) {
      return {
        position: "absolute",
        left: 0,
        right: 0,
        top: `calc(${insetTop} + 10px)`,
        paddingLeft: `calc(${insetLeft} + 10px)`,
        paddingRight: `calc(${insetRight} + 10px)`,
      };
    }

    return {
      position: "fixed",
      top: "50%",
      left: `calc(100% - (${insetRight} + 10px) - ${HEADER_THICKNESS / 2}px)`,
      width: `calc(100dvh - ${insetTop} - ${insetBottom} - 20px)`,
      height: `${HEADER_THICKNESS}px`,
      transform: `translate(-50%, -50%) rotate(${rotateDeg}deg)`,
      transformOrigin: "center",
      paddingLeft: `calc(${insetTop} + 10px)`,
      paddingRight: `calc(${insetBottom} + 10px)`,
    };
  }, [
    isLandscape,
    rotateDeg,
    insetTop,
    insetRight,
    insetBottom,
    insetLeft,
  ]);

  // Footer positioning: portrait = bottom, landscape = left side (rotated)
  const footerPosStyle = useMemo<React.CSSProperties>(() => {
    if (!isLandscape) {
      return {
        position: "absolute",
        left: 0,
        right: 0,
        bottom: `calc(${insetBottom} + 12px)`,
        paddingLeft: `calc(${insetLeft} + 10px)`,
        paddingRight: `calc(${insetRight} + 10px)`,
      };
    }

    return {
      position: "fixed",
      top: "50%",
      left: `calc(${insetLeft} + 10px + ${FOOTER_THICKNESS / 2}px)`,
      width: `calc(100dvh - ${insetTop} - ${insetBottom} - 20px)`,
      height: `${FOOTER_THICKNESS}px`,
      transform: `translate(-50%, -50%) rotate(${rotateDeg}deg)`,
      transformOrigin: "center",
      paddingLeft: `calc(${insetTop} + 10px)`,
      paddingRight: `calc(${insetBottom} + 10px)`,
    };
  }, [isLandscape, rotateDeg, insetTop, insetBottom, insetLeft, insetRight]);

  return (
    <section className="fixed inset-0 overflow-hidden bg-black">
      {/* FULLSCREEN VIDEO */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        controls={false}
        onDoubleClick={async () => {
          const newTrack = await flipCamera();
          if (newTrack && isStreamOn) replaceTrack("video", newTrack);
        }}
        style={videoStyle}
        className="z-0"
      />

      {/* UI OVERLAY */}
      <div className="fixed inset-0 z-10">
        {isLoadingMedia && (
          <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-50">
            <div className="text-white text-2xl">Loading Media...</div>
          </div>
        )}

        {/* HEADER (top in portrait, right in landscape) */}
        <header style={headerPosStyle} className="z-20">
          <div className="h-full w-full bg-black/45 backdrop-blur-md rounded-2xl shadow-lg px-3 py-2 grid grid-cols-[auto,1fr,auto] items-center gap-3">
            <button
              onClick={handleBack}
              className="shrink-0 p-2 rounded-xl bg-black/30 text-white active:scale-95 transition"
              aria-label="Back"
            >
              <span
                className="material-symbols-outlined inline-flex"
                style={{ ...counterRotateStyle, fontSize: 26 }}
              >
                arrow_back
              </span>
            </button>

            {/* Center: keep it one line, truncate if needed */}
            <div className="min-w-0 flex justify-center">
              {sessionCode && (
                <div className="min-w-0 max-w-full bg-black/35 text-white rounded-xl px-3 py-1.5">
                  <span
                    className="block text-sm font-medium font-mono tracking-widest truncate"
                    style={counterRotateStyle}
                    title={sessionCode}
                  >
                    CODE {sessionCode}
                  </span>
                </div>
              )}
            </div>

            <div
              className={`shrink-0 flex items-center justify-end gap-2 whitespace-nowrap text-sm font-medium ${connectionStatus === "connected"
                  ? "text-green-400"
                  : connectionStatus === "connecting"
                    ? "text-yellow-300"
                    : connectionStatus === "disconnected"
                      ? "text-gray-300"
                      : "text-red-400"
                }`}
            >
              <span
                className="material-symbols-outlined inline-flex"
                style={{ ...counterRotateStyle, fontSize: 22 }}
              >
                {icons.connection[connectionStatus]}
              </span>
              <span style={counterRotateStyle}>
                {connectionStatus.charAt(0).toUpperCase() +
                  connectionStatus.slice(1)}
              </span>
            </div>
          </div>
        </header>

        {errorMessage && (
          <div
            className="absolute left-0 right-0 flex justify-center z-30"
            style={{ top: `calc(${insetTop} + 64px)` }}
          >
            <div className="bg-red-500 text-white px-4 py-2 rounded-md">
              {errorMessage}
            </div>
          </div>
        )}

        {/* FOOTER (bottom in portrait, left in landscape) */}
        <div style={footerPosStyle} className="z-20">
          <div className="h-full w-full bg-black/45 backdrop-blur-md rounded-3xl shadow-lg px-4 py-3 flex flex-col items-center justify-center gap-3">
            {/* Volume indicator */}
            {isMicOn === "on" && media && media.getAudioTracks().length > 0 && (
              <div style={counterRotateStyle}>
                <React.Suspense fallback={null}>
                  <AudioVolumeIndicator isEnabled={true} mediaStream={media} />
                </React.Suspense>
              </div>
            )}

            {/* Controls row (becomes a vertical stack visually once the footer is rotated) */}
            <div className="w-full grid grid-cols-3 items-center">
              <button
                onClick={toggleMic}
                className="p-3 flex items-center justify-center active:scale-95 transition"
                aria-label={
                  isMicOn === "on" ? "Mute Microphone" : "Unmute Microphone"
                }
              >
                <span
                  className="material-symbols-outlined inline-flex"
                  style={{ ...counterRotateStyle, fontSize: 40 }}
                >
                  {icons.microphone[isMicOn]}
                </span>
              </button>

              <button
                onClick={isStreamOn ? stopStream : startStream}
                className={`p-3 flex items-center justify-center active:scale-95 transition ${isStreamOn
                    ? "text-red-400"
                    : connectionStatus === "connecting"
                      ? "text-yellow-300"
                      : "text-green-400"
                  }`}
                aria-label={isStreamOn ? "Stop Streaming" : "Start Streaming"}
              >
                <span
                  className="material-symbols-outlined inline-flex"
                  style={{ ...counterRotateStyle, fontSize: 82, lineHeight: 1 }}
                >
                  {isStreamOn
                    ? "radio_button_checked"
                    : "radio_button_unchecked"}
                </span>
              </button>

              <button
                onClick={toggleVideo}
                className="p-3 flex items-center justify-center active:scale-95 transition"
                aria-label={isVidOn === "on" ? "Stop Video" : "Start Video"}
              >
                <span
                  className="material-symbols-outlined inline-flex"
                  style={{ ...counterRotateStyle, fontSize: 40 }}
                >
                  {icons.video[isVidOn]}
                </span>
              </button>
            </div>
          </div>
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
