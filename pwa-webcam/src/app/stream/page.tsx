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
import type { IconType } from "react-icons";
import {
  MdMic,
  MdMicOff,
  MdVideocam,
  MdVideocamOff,
  MdCloudSync,
  MdCloudDone,
  MdCloudOff,
  MdWarning,
  MdKeyboardReturn,
  MdRadioButtonChecked,
  MdRadioButtonUnchecked,
  MdError,
} from "react-icons/md";

const AudioVolumeIndicator = React.lazy(
  () => import("@/components/AudioVolumeIndicator")
);

import useMediaStream from "@/lib/useMediaStream";
import type { MediaState } from "@/lib/useMediaStream";
import useWebRTCStream from "@/lib/useWebRTCStream";
import type { ConnectionState } from "@/lib/useWebRTCStream";

// SVG icon maps — no font loading required, works offline on iPhone
const micIcons: Record<MediaState, IconType> = {
  on: MdMic,
  off: MdMicOff,
  error: MdMicOff,
};
const vidIcons: Record<MediaState, IconType> = {
  on: MdVideocam,
  off: MdVideocamOff,
  error: MdVideocamOff,
};
const connIcons: Record<ConnectionState, IconType> = {
  connecting: MdCloudSync,
  connected: MdCloudDone,
  disconnected: MdCloudOff,
  error: MdWarning,
};

// Renders an icon that counter-rotates smoothly to appear upright when the
// phone is physically tilted. Only the icon rotates — the layout stays fixed.
// `rot` is the physical device angle (0/90/180/270°); the icon rotates the
// same amount so it appears upright to someone holding the tilted phone.
function RotIcon({
  icon: Ic,
  size,
  color = "white",
  rot,
}: {
  icon: IconType;
  size: number;
  color?: string;
  rot: number;
}) {
  return (
    <Ic
      size={size}
      color={color}
      style={{
        transform: `rotate(${rot}deg)`,
        transition: "transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)",
        display: "inline-block",
        willChange: "transform",
      }}
    />
  );
}

function StreamPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const { code, webcam, mic } = useMemo(
    () => ({
      code: searchParams.get("code") || "",
      webcam: searchParams.get("webcam") === "true",
      mic: searchParams.get("mic") === "true",
    }),
    [searchParams]
  );

  const fps = "60";
  const resolution = "hd";
  const exposure = 0;

  // viewportOrientation: raw window.orientation value (0 / 90 / -90 / 180).
  // The manifest no longer locks orientation so the viewport rotates freely,
  // and this value changes without any permission dialog.
  const [viewportOrientation, setViewportOrientation] = useState(0);
  const lastRotRef = useRef(-1); // used in orientation effect (after handleRotate is defined)

  // Only 90° / -90° are landscape (viewport is rotated and dims are swapped).
  // 180° is portrait upside-down — no dim swap, just rotate.
  const isViewportLandscape = Math.abs(viewportOrientation) === 90;

  // Counter-rotate the section so the UI stays portrait in physical space
  // while the viewport is landscape. Works because the manifest no longer
  // applies an orientation lock, so the viewport (and window.orientation)
  // actually reflects the physical tilt without needing gyro permission.
  const sectionLandscapeStyle: React.CSSProperties = isViewportLandscape
    ? {
        width: "100svh",
        height: "100svw",
        top: "calc((100svh - 100svw) / 2)",
        left: "calc((100svw - 100svh) / 2)",
        right: "auto",
        bottom: "auto",
        transform: `rotate(${-viewportOrientation}deg)`,
        transformOrigin: "center center",
      }
    : viewportOrientation === 180
    ? { transform: "rotate(180deg)", transformOrigin: "center center" }
    : {};

  // No extra icon rotation needed: the section counter-rotation already keeps
  // all content (icons included) visually upright relative to the user.
  const iconRot = 0;

  const handleRemoteTermination = useCallback((_: boolean) => {
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
    initialAudio: mic,
    initialVideo: webcam,
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
    sessionCode: code,
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

  const errorMessage =
    [mediaStreamError, RTCStreamError].find(Boolean) || null;

  // Orientation detection — must be after handleRotate is declared above.
  // Reads window.orientation on change (no permission dialog needed) and
  // updates both the section rotation state and the canvas stream correction.
  useEffect(() => {
    const readOri = (): number => {
      const w = window as any;
      if (typeof w.orientation === "number") return w.orientation as number;
      const type = window.screen?.orientation?.type ?? "";
      if (type === "landscape-primary")   return  90;
      if (type === "landscape-secondary") return -90;
      if (type === "portrait-secondary")  return 180;
      return 0;
    };
    const update = () => {
      const o = readOri();
      setViewportOrientation(o);
      const r = ((o % 360) + 360) % 360; // normalize to 0/90/180/270
      if (r !== lastRotRef.current) {
        lastRotRef.current = r;
        handleRotate(r);
      }
    };
    update();
    window.addEventListener("orientationchange", update, { passive: true });
    window.screen?.orientation?.addEventListener?.("change", update);
    return () => {
      window.removeEventListener("orientationchange", update);
      window.screen?.orientation?.removeEventListener?.("change", update);
    };
  }, [handleRotate]);

  // --- startup ---
  useEffect(() => {
    if (code) startMedia();
  }, [code]);

  useEffect(() => {
    if (media && !isLoadingMedia && !isStreamOn) startStream();
  }, [media, isLoadingMedia]);

  useEffect(() => {
    if (connectionStatus === "disconnected" && isStreamOn) stopMedia();
  }, [connectionStatus]);


  useEffect(() => {
    return () => { stopStream(); };
  }, [stopStream]);

  const handleBack = useCallback(() => {
    stopStream();
    router.push("/");
  }, [stopStream, router]);

  const connectionColor =
    connectionStatus === "connected"     ? "#22c55e"
    : connectionStatus === "connecting"  ? "#eab308"
    : connectionStatus === "disconnected"? "#9ca3af"
    : "#ef4444";

  const MicIcon  = micIcons[isMicOn];
  const VidIcon  = vidIcons[isVidOn];
  const ConnIcon = connIcons[connectionStatus];

  return (
    <section
      className="stream-section"
      style={sectionLandscapeStyle}
      onDoubleClick={async () => {
        const track = await flipCamera();
        if (track && isStreamOn) replaceTrack("video", track);
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
            <span className="text-white/80 text-sm tracking-wide">
              Starting camera…
            </span>
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
        >
          <div className="bg-red-500/90 backdrop-blur-sm text-white px-4 py-2 rounded-xl flex items-center gap-2 shadow-lg">
            <MdError size={18} />
            <span className="text-sm">{errorMessage}</span>
          </div>
        </div>
      )}

      <div className="absolute inset-0 flex flex-col justify-between z-10 pointer-events-none">
        {/* ── Header ── */}
        <header
          className="flex items-center justify-between pointer-events-auto px-4"
          style={{
            paddingTop: "max(1.25rem, env(safe-area-inset-top, 0px))",
            paddingBottom: "0.75rem",
            background:
              "linear-gradient(to bottom, rgba(0,0,0,0.55) 0%, transparent 100%)",
          }}
        >
          <button
            onClick={handleBack}
            className="p-2 rounded-full active:bg-white/10 transition-colors"
            aria-label="Return"
          >
            <RotIcon icon={MdKeyboardReturn} size={28} rot={iconRot} />
          </button>

          {code && (
            <div className="bg-black/50 backdrop-blur-sm text-white text-sm px-3 py-1.5 rounded-lg tracking-widest font-mono">
              {code}
            </div>
          )}

          <div
            className="flex items-center gap-1.5"
            style={{ color: connectionColor }}
            aria-label={"Connection: " + connectionStatus}
          >
            <ConnIcon
              size={24}
              color={connectionColor}
              style={{
                transform: `rotate(${iconRot}deg)`,
                transition: "transform 0.25s cubic-bezier(0.4, 0, 0.2, 1)",
                display: "inline-block",
                willChange: "transform",
              }}
            />
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
            background:
              "linear-gradient(to top, rgba(0,0,0,0.55) 0%, transparent 100%)",
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
              aria-label={
                isMicOn === "on" ? "Mute Microphone" : "Unmute Microphone"
              }
            >
              <RotIcon
                icon={MicIcon}
                size={36}
                color={isMicOn === "error" ? "#ef4444" : "white"}
                rot={iconRot}
              />
            </button>

            {/* Stream toggle — large centre button */}
            <button
              onClick={() => {
                toggleMedia();
                relayToggle(
                  "media",
                  isMicOn === "off" && isVidOn === "off" ? "on" : "off"
                );
              }}
              className="p-3 rounded-full active:bg-white/10 transition-colors"
              aria-label={isStreamOn ? "Pause Streaming" : "Resume Streaming"}
            >
              <RotIcon
                icon={
                  isStreamOn
                    ? MdRadioButtonChecked
                    : MdRadioButtonUnchecked
                }
                size={72}
                color={
                  isStreamOn
                    ? "#ef4444"
                    : connectionStatus === "connecting"
                    ? "#eab308"
                    : "#22c55e"
                }
                rot={iconRot}
              />
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
              <RotIcon
                icon={VidIcon}
                size={36}
                color={isVidOn === "error" ? "#ef4444" : "white"}
                rot={iconRot}
              />
            </button>
          </div>
        </footer>
      </div>
    </section>
  );
}

export default function Page() {
  return (
    <Suspense
      fallback={
        <div className="fixed inset-0 bg-black flex items-center justify-center">
          <div className="w-10 h-10 rounded-full border-2 border-white/20 border-t-white animate-spin" />
        </div>
      }
    >
      <StreamPage />
    </Suspense>
  );
}
