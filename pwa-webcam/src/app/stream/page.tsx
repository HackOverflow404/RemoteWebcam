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

import useMediaStream from "@/components/useMediaStream";
import useWebRTCStream from "@/components/useWebRTCStream";

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

  const [fps, setFps] = useState<"30" | "60">("60");
  const [resolution, setResolution] = useState<"sd" | "hd" | "4k">("hd");
  const [exposure, setExposure] = useState(0);

  // viewport in px (critical for correct rotation math on mobile/PWA)
  const [vp, setVp] = useState({ w: 1, h: 1 });

  // rotation degrees for the stage: 0, 90, -90
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
    updateConstraints,
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

    const mq = window.matchMedia?.("(orientation: landscape)");

    const recompute = () => {
      const w = Math.round(window.innerWidth);
      const h = Math.round(window.innerHeight);

      setVp({ w, h });

      const isLandscape = mq?.matches ?? w > h;

      handleRotate( w, h);

      if (!isLandscape) {
        setRotateDeg(0);
        return;
      }

      const type = window.screen?.orientation?.type; // best signal when available
      if (type === "landscape-secondary") {
        setRotateDeg(-90);
        return;
      }
      if (type === "landscape-primary") {
        setRotateDeg(90);
        return;
      }

      // fallback: angle
      const screenAngle = (window.screen?.orientation?.angle ?? 0) as number;
      const legacyAngle =
        typeof (window as any).orientation === "number"
          ? (window as any).orientation
          : 0;
      const angle = screenAngle || legacyAngle || 0;

      if (angle === -90 || angle === 270) setRotateDeg(-90);
      else setRotateDeg(90);
    };

    recompute();

    window.addEventListener("resize", recompute);
    window.addEventListener("orientationchange", recompute);
    window.visualViewport?.addEventListener?.("resize", recompute);

    if (mq?.addEventListener) mq.addEventListener("change", recompute);
    else if ((mq as any)?.addListener) (mq as any).addListener(recompute);

    window.screen?.orientation?.addEventListener?.("change", recompute);

    return () => {
      window.removeEventListener("resize", recompute);
      window.removeEventListener("orientationchange", recompute);
      window.visualViewport?.removeEventListener?.("resize", recompute);

      if (mq?.removeEventListener) mq.removeEventListener("change", recompute);
      else if ((mq as any)?.removeListener)
        (mq as any).removeListener(recompute);

      window.screen?.orientation?.removeEventListener?.("change", recompute);
    };
  }, []);

  // Stage style: rotate the whole “surface” and translate it into view
  const stageStyle = useMemo<React.CSSProperties>(() => {
    // Prefer dynamic viewport units when supported; fall back to vw/vh
    const vw = "100dvw";
    const vh = "100dvh";

    if (rotateDeg === 0) {
      return {
        position: "fixed",
        inset: 0,
        width: vw,
        height: vh,
        transform: "none",
      };
    }

    // In landscape, swap dims and rotate around the center
    return {
      position: "fixed",
      top: "50%",
      left: "50%",
      width: vh, // swapped
      height: vw, // swapped
      transformOrigin: "center",
      transform: `translate(-50%, -50%) rotate(${rotateDeg}deg)`,
    };
  }, [rotateDeg]);

  // --- Unified video settings handler ---
  const handleVideoSettings = useCallback(
    async (
      newFps?: "30" | "60",
      newRes?: "sd" | "hd" | "4k",
      newExposure?: number
    ) => {
      if (newFps) setFps(newFps);
      if (newRes) setResolution(newRes);
      if (typeof newExposure === "number") setExposure(newExposure);

      if (updateConstraints) {
        const newTrack = await updateConstraints({
          fps: newFps || fps,
          resolution: newRes || resolution,
          exposure: typeof newExposure === "number" ? newExposure : exposure,
        });

        if (replaceTrack && newTrack && isStreamOn) {
          replaceTrack("video", newTrack);
        }
      } else {
        if (isVidOn && media) setTimeout(toggleVideo, 100);
      }
    },
    [fps, resolution, exposure, updateConstraints, isVidOn, media, toggleVideo]
  );

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
            transform: isFrontCamera ? "scaleX(-1)" : "scaleX(1)",
            transition: "opacity 0.3s ease",
          }}
          className="absolute inset-0 w-full h-full object-cover z-0"
        />

        {errorMessage && (
          <div
            className="absolute top-24 left-0 right-0 flex justify-center animate-pulse z-20"
            style={{ transform: `rotate(-${rotateDeg}deg)` }}
          >
            <div className="bg-red-500 text-white px-4 py-2 rounded-md flex items-center">
              <span>{errorMessage}</span>
              <button className="ml-2" onClick={() => {}}>
                ✕
              </button>
            </div>
          </div>
        )}

        <div
          className={`absolute top-20 right-4 flex items-center z-20 ${
            connectionStatus === "connected"
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

        {sessionCode && (
          <div className="absolute top-16 left-4 bg-black bg-opacity-50 text-white px-3 py-1 rounded-md z-20">
            Code: {sessionCode}
          </div>
        )}

        {/* Overlay setting buttons */}
        {/* IMPORTANT: absolute (not fixed) so it rotates with stage */}
        <div className="absolute inset-0 flex flex-col items-center z-10">
          {/* Top settings */}
          <header className="flex absolute top-0 left-0 right-0 w-full py-5 justify-evenly z-10">
            <button
              onClick={handleBack}
              className="p-3"
              style={{ transform: `rotate(-${rotateDeg}deg)` }}
              aria-label="Return"
            >
              <span className="material-symbols-outlined">keyboard_return</span>
            </button>

            <button
              onClick={() => handleVideoSettings(fps === "30" ? "60" : "30")}
              className="p-3"
              style={{ transform: `rotate(-${rotateDeg}deg)` }}
              aria-label="Toggle FPS"
            >
              <span className="material-symbols-outlined">
                {icons.fps[fps]}
              </span>
            </button>

            <button
              className="p-3"
              style={{ transform: `rotate(-${rotateDeg}deg)` }}
              aria-label="Portrait Mode"
            >
              <span className="material-symbols-outlined">frame_person</span>
            </button>

            <button
              onClick={() =>
                handleVideoSettings(undefined, undefined, (exposure + 1) % 3)
              }
              className="p-3"
              style={{ transform: `rotate(-${rotateDeg}deg)` }}
              aria-label="Adjust Exposure"
            >
              <span className="material-symbols-outlined">exposure</span>
            </button>

            <button
              onClick={() =>
                handleVideoSettings(
                  undefined,
                  resolution === "sd" ? "hd" : resolution === "hd" ? "4k" : "sd"
                )
              }
              className="p-3"
              style={{ transform: `rotate(-${rotateDeg}deg)` }}
              aria-label="Toggle Resolution"
            >
              <span className="material-symbols-outlined">
                {icons.resolution[resolution]}
              </span>
            </button>
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
                className={`p-3 w-15 h-15 flex items-center justify-center ${
                  isStreamOn
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
