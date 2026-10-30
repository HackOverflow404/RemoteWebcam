"use client";

import { useRouter, useSearchParams } from "next/navigation";
import React, {
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
import CopySessionStats from "@/components/CopySessionStats";
import { getIceServers } from "@/lib/signaling";

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

  // Last physical rotation sent to the outgoing-stream canvas (0/90/180/270).
  const lastRotRef = useRef(-1);

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
  // Only drives the outgoing-stream canvas correction; the on-screen UI just
  // reflows with the viewport (see the landscape: classes below).
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
    if (!code) {
      router.replace("/");
      return;
    }
    // Fetch TURN credentials while the camera permission prompt is up.
    void getIceServers();
    startMedia();
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (media && !isLoadingMedia) startStream();
  }, [media, isLoadingMedia, startStream]);

  // Release the camera once a session has failed; it can't be resumed with
  // the same code, so the user goes back and pairs again.
  useEffect(() => {
    if (connectionStatus === "error") stopMedia();
  }, [connectionStatus, stopMedia]);

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

  const controlButton = "p-3 rounded-full active:bg-white/10 transition-colors";

  return (
    <section
      className="stream-section"
      onDoubleClick={async () => {
        try {
          const track = await flipCamera();
          if (track) await replaceTrack("video", track);
        } catch (e) {
          console.error("Camera flip failed:", e);
        }
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

      {/* Camera preview. iOS already rotates the camera frames to match the
          screen, so the preview is simply full-bleed in both orientations. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        controls={false}
        className="absolute inset-0 w-full h-full object-cover z-0"
        style={{ transform: `scaleX(${isFrontCamera ? "-1" : "1"})` }}
      />

      {/* Shading behind the overlays, laid out independently of them so the
          gradients span the full edge without seams. */}
      <div className="stream-scrim-top" aria-hidden="true" />
      <div className="stream-scrim-controls" aria-hidden="true" />

      {/* Portrait: header on top, controls row along the bottom.
          Landscape: header on top, controls column down the right edge.
          Every edge pads by its own safe-area inset (notch / home bar). */}
      <div className="absolute inset-0 flex flex-col landscape:flex-row z-10 pointer-events-none">
        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <header
            className="stream-header flex items-center justify-between gap-3 pointer-events-auto"
          >
            <button onClick={handleBack} className="p-2 rounded-full bg-black/40 backdrop-blur-sm active:bg-white/10 transition-colors" aria-label="Return">
              <MdKeyboardReturn size={28} color="white" />
            </button>

            {code && (
              <div className="bg-black/50 backdrop-blur-sm text-white text-sm px-3 py-1.5 rounded-lg tracking-widest font-mono">
                {code}
              </div>
            )}

            <div
              className="flex items-center gap-1.5 bg-black/50 backdrop-blur-sm rounded-lg px-2.5 py-1.5"
              style={{ color: connectionColor }}
              aria-label={"Connection: " + connectionStatus}
            >
              <ConnIcon size={22} color={connectionColor} />
              <span className="text-xs font-medium capitalize hidden sm:block">
                {connectionStatus}
              </span>
            </div>
          </header>

          {errorMessage && (
            <div className="flex justify-center px-4 mt-2">
              <div className="bg-red-500/90 backdrop-blur-sm text-white px-4 py-2 rounded-xl flex items-center gap-2 shadow-lg max-w-md">
                <MdError size={18} className="shrink-0" />
                <span className="text-sm">{errorMessage}</span>
              </div>
            </div>
          )}

          <div className="hidden landscape:flex mt-auto stream-landscape-stats pointer-events-auto">
            <CopySessionStats />
          </div>
        </div>

        <footer className="stream-controls flex flex-col landscape:justify-center items-center pointer-events-auto">
          {isMicOn === "on" && media && media.getAudioTracks().length > 0 && (
            <div className="w-full px-8 landscape:px-0 landscape:w-28 landscape:order-last">
              <React.Suspense fallback={null}>
                <AudioVolumeIndicator isEnabled={true} mediaStream={media} />
              </React.Suspense>
            </div>
          )}

          <div className="flex flex-row landscape:flex-col items-center justify-evenly w-full landscape:w-auto landscape:gap-1">
            <button
              onClick={() => {
                toggleMic();
                relayToggle("mic", isMicOn === "on" ? "off" : "on");
              }}
              className={controlButton}
              aria-label={isMicOn === "on" ? "Mute Microphone" : "Unmute Microphone"}
            >
              <MicIcon size={36} color={isMicOn === "error" ? "#ef4444" : "white"} />
            </button>

            <button
              onClick={() => {
                toggleMedia();
                relayToggle(
                  "media",
                  isMicOn === "off" && isVidOn === "off" ? "on" : "off"
                );
              }}
              className={controlButton}
              aria-label={isStreamOn ? "Pause Streaming" : "Resume Streaming"}
            >
              {React.createElement(isStreamOn ? MdRadioButtonChecked : MdRadioButtonUnchecked, {
                className: "w-[72px] h-[72px] landscape:w-16 landscape:h-16",
                color: isStreamOn
                  ? "#ef4444"
                  : connectionStatus === "connecting"
                  ? "#eab308"
                  : "#22c55e",
              })}
            </button>

            <button
              onClick={() => {
                toggleVid();
                relayToggle("cam", isVidOn === "on" ? "off" : "on");
              }}
              className={controlButton}
              aria-label={isVidOn === "on" ? "Stop Video" : "Start Video"}
            >
              <VidIcon size={36} color={isVidOn === "error" ? "#ef4444" : "white"} />
            </button>
          </div>
          <div className="landscape:hidden">
            <CopySessionStats />
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
