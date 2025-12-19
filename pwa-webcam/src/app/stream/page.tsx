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

  const [vp, setVp] = useState({ w: 1, h: 1 });
  const [safeRaw, setSafeRaw] = useState({ t: 0, r: 0, b: 0, l: 0 });
  const [rotateDeg, setRotateDeg] = useState<0 | 90 | -90>(0);

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

  // -- WebRTC Hook --
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

  // --- initial media + stream startup ---
  useEffect(() => {
    if (sessionCode) startMedia();
  }, [sessionCode]); // keep your original dependency choice

  useEffect(() => {
    if (media && !isLoadingMedia && !isStreamOn) startStream();
  }, [media, isLoadingMedia]); // keep your original dependency choice

  useEffect(() => {
    if (connectionStatus === "disconnected" && isStreamOn) stopMedia();
  }, [connectionStatus]); // keep your original dependency choice

  // --- rotation + viewport sizing ---
  useEffect(() => {
    if (typeof window === "undefined") return;

    const read = () => {
      const s = getComputedStyle(document.documentElement);
      const px = (v: string) => Math.round(parseFloat(v || "0")) || 0;
      setSafeRaw({
        t: px(s.getPropertyValue("--sat")),
        r: px(s.getPropertyValue("--sar")),
        b: px(s.getPropertyValue("--sab")),
        l: px(s.getPropertyValue("--sal")),
      });
    };

    read();
    window.addEventListener("resize", read);
    window.visualViewport?.addEventListener?.("resize", read);
    return () => {
      window.removeEventListener("resize", read);
      window.visualViewport?.removeEventListener?.("resize", read);
    };
  }, []);

  const safe = useMemo(() => {
    const { t, r, b, l } = safeRaw;

    if (rotateDeg === 0) return { t, r, b, l };

    // rotateDeg === 90: content-top aligns to physical-left, etc.
    if (rotateDeg === 90) return { t: l, r: t, b: r, l: b };

    // rotateDeg === -90
    return { t: r, r: b, b: l, l: t };
  }, [safeRaw, rotateDeg]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const mq = window.matchMedia?.("(orientation: landscape)");
    let raf = 0;

    const recompute = () => {
      const vv = window.visualViewport;
      const w = Math.round(vv?.width ?? window.innerWidth);
      const h = Math.round(vv?.height ?? window.innerHeight);
      setVp({ w, h });

      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        handleRotate(w, h);
      });

      const isLandscape = mq?.matches ?? w > h;

      if (!isLandscape) {
        setRotateDeg(0);
        return;
      }

      const type = window.screen?.orientation?.type;
      if (type === "landscape-secondary") return setRotateDeg(-90);
      if (type === "landscape-primary") return setRotateDeg(90);

      const screenAngle = (window.screen?.orientation?.angle ?? 0) as number;
      const legacyAngle =
        typeof (window as any).orientation === "number"
          ? (window as any).orientation
          : 0;
      const angle = screenAngle || legacyAngle || 0;

      setRotateDeg(angle === -90 || angle === 270 ? -90 : 90);
    };

    recompute();

    window.addEventListener("resize", recompute);
    window.addEventListener("orientationchange", recompute);
    window.visualViewport?.addEventListener?.("resize", recompute);

    if (mq?.addEventListener) mq.addEventListener("change", recompute);
    else if ((mq as any)?.addListener) (mq as any).addListener(recompute);

    window.screen?.orientation?.addEventListener?.("change", recompute);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", recompute);
      window.removeEventListener("orientationchange", recompute);
      window.visualViewport?.removeEventListener?.("resize", recompute);

      if (mq?.removeEventListener) mq.removeEventListener("change", recompute);
      else if ((mq as any)?.removeListener)
        (mq as any).removeListener(recompute);

      window.screen?.orientation?.removeEventListener?.("change", recompute);
    };
  }, [handleRotate, isStreamOn]);

  // Stage style: rotate the whole “surface” and translate it into view
  const stageStyle = useMemo<React.CSSProperties>(() => {
    const W = vp.w;
    const H = vp.h;

    if (rotateDeg === 0) {
      return {
        position: "fixed",
        inset: 0,
        width: W,
        height: H,
        transform: "none",
      };
    }

    // In landscape, pre-rotate size is swapped so the rotated bbox matches viewport
    return {
      position: "fixed",
      top: "50%",
      left: "50%",
      width: H,
      height: W,
      transformOrigin: "center",
      transform: `translate(-50%, -50%) rotate(${rotateDeg}deg)`,
    };
  }, [rotateDeg, vp.w, vp.h]);

  const handleBack = useCallback(() => {
    stopStream();
    router.push("/");
  }, [stopStream, router]);

  return (
    <section className="fixed inset-0 overflow-hidden bg-black">
      <div style={stageStyle}>
        {isLoadingMedia && (
          <div className="absolute inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 pointer-events-none">
            <div className="text-white text-2xl">Loading Media...</div>
          </div>
        )}

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
          style={{
            transform: `scale(${isFrontCamera ? "-" : ""}1, ${rotateDeg < 0 ? "-" : ""}1)`,
            transition: "opacity 0.3s ease",
            width: rotateDeg == 0 ? "100dvw" : vp.h,
            height: rotateDeg == 0 ? "100dvh" : vp.w,
            objectFit: "cover",
          }}
          className="absolute inset-0 object-cover z-0"
        />

        {errorMessage && (
          <div
            className="absolute top-24 left-0 right-0 flex justify-center animate-pulse z-20"
            style={{ transform: `rotate(-${rotateDeg}deg)` }}
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
          style={{
            paddingTop: safe.t,
            paddingRight: safe.r,
            paddingBottom: safe.b, // set to 0 if you *want* to go under home indicator
            paddingLeft: safe.l,
          }}
        >
          <header className={`flex absolute top-0 left-0 right-0 w-full py-5 justify-evenly z-10 ${rotateDeg == 0 ? "" : "mt-4"}`}>
            <button
              onClick={handleBack}
              className="p-3"
              style={{ transform: `rotate(-${rotateDeg}deg)` }}
              aria-label="Return"
            >
              <span className="material-symbols-outlined">keyboard_return</span>
            </button>

            {sessionCode && (
              <div className="bg-black bg-opacity-50 flex items-center justify-center text-white h-10 px-3 py-1 rounded-md">
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
          <footer className="flex flex-col absolute bottom-0 left-0 right-0 w-full py-10 justify-evenly z-10">
            {isMicOn === "on" && media && media.getAudioTracks().length > 0 && (
              <React.Suspense fallback={<div>Loading Mic Volume...</div>}>
                <AudioVolumeIndicator isEnabled={true} mediaStream={media} />
              </React.Suspense>
            )}

            <div className="flex flex-row w-full justify-evenly">
              <button
                onClick={toggleMic}
                className="p-3 w-15 h-15 flex items-center justify-center"
                style={{ transform: `rotate(-${rotateDeg}deg)` }}
                aria-label={
                  isMicOn === "on" ? "Mute Microphone" : "Unmute Microphone"
                }
              >
                <span
                  className="material-symbols-outlined"
                  style={{ fontSize: "40px" }}
                >
                  {icons.microphone[isMicOn]}
                </span>
              </button>

              <button
                onClick={isStreamOn ? stopStream : startStream}
                className={`p-3 w-15 h-15 flex items-center justify-center ${isStreamOn
                  ? "text-red-500"
                  : connectionStatus === "connecting"
                    ? "text-yellow-500"
                    : "text-green-500"
                  }`}
                style={{ transform: `rotate(-${rotateDeg}deg)` }}
                aria-label={isStreamOn ? "Stop Streaming" : "Start Streaming"}
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
                onClick={toggleVideo}
                className="p-3 w-15 h-15 flex items-center justify-center"
                style={{ transform: `rotate(-${rotateDeg}deg)` }}
                aria-label={isVidOn === "on" ? "Stop Video" : "Start Video"}
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