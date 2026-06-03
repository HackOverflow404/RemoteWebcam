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

  // rot = detected PHYSICAL rotation angle (0 / 90 / 180 / 270).
  // Used ONLY to rotate individual UI icons so they appear upright when the
  // phone is tilted. The camera preview and layout are never rotated.
  const [rot, setRot] = useState(0);
  const rotRef = useRef(0);

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

  // Lock the screen to portrait where the API is supported (Chrome/Android PWA).
  // On iOS the manifest orientation: "portrait" provides the lock; the API call
  // throws and is silently swallowed. Either way, the physical-rotation gyro
  // still detects tilt and rotates individual icons independently.
  useEffect(() => {
    (screen.orientation as any)?.lock?.("portrait-primary")?.catch?.(() => {});
    return () => {
      (screen.orientation as any)?.unlock?.();
    };
  }, []);

  // iOS 13+ requires explicit permission to read DeviceOrientationEvent data.
  // The API must be called from a user-gesture context, so we hook into the
  // first touch/click on the page — whichever comes first.
  useEffect(() => {
    const request = async () => {
      const DOE = DeviceOrientationEvent as any;
      if (typeof DOE.requestPermission === "function") {
        try { await DOE.requestPermission(); } catch { /* user denied or unavailable */ }
      }
    };
    document.addEventListener("touchstart", request, { once: true, capture: true });
    document.addEventListener("click",      request, { once: true, capture: true });
    return () => {
      document.removeEventListener("touchstart", request, true);
      document.removeEventListener("click",      request, true);
    };
  }, []);

  // Physical rotation detection — drives icon counter-rotation only.
  //
  // Primary path: DeviceOrientationEvent (gamma / beta axes from the IMU).
  // This reads the physical sensor directly and works in iOS PWA mode where
  // screen.orientation is always "portrait-primary" and never changes.
  //
  // Fallback path: screen / window orientation APIs, used in browser mode on
  // Android where the viewport actually rotates. Skipped once the IMU fires.
  //
  // Hysteresis: we use a ±55° threshold to enter a new bucket but only leave
  // it once the angle crosses back past ±35°. This prevents the icon from
  // flickering when the phone rests near the 45° boundary.
  useEffect(() => {
    const norm = (d: number) => ((d % 360) + 360) % 360;
    let doeActive = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingAngle = rotRef.current;

    // Classify the raw gamma/beta into a 90° bucket with hysteresis.
    // currentBucket is the last committed angle so we can apply the dead-zone.
    const classifyDOE = (g: number, b: number, current: number): number => {
      const abs = Math.abs(g);
      // In an established landscape bucket, only leave at <35° (dead zone)
      if (current === 90  && g > 0  && abs > 35) return 90;
      if (current === 270 && g < 0  && abs > 35) return 270;
      if (current === 180 && b < 0  && b > -55)  return 180;
      // Enter a new bucket with a 55° threshold for stability
      if (g >  55) return 90;
      if (g < -55) return 270;
      if (b < -55) return 180;
      return 0;
    };

    const commit = (angle: number) => {
      const n = norm(angle);
      if (n === pendingAngle) return;
      pendingAngle = n;
      if (timer) clearTimeout(timer);
      // 250 ms debounce — long enough for iOS to settle, short enough to feel crisp
      timer = setTimeout(() => {
        timer = null;
        if (n !== rotRef.current) {
          rotRef.current = n;
          setRot(n);
          handleRotate(n);
        }
      }, 250);
    };

    const onDOE = (e: DeviceOrientationEvent) => {
      if (e.gamma === null) return;
      doeActive = true;
      commit(classifyDOE(e.gamma, e.beta ?? 0, rotRef.current));
    };

    // Fallback: screen/window APIs for browser mode and Android.
    const getAngle = (): number => {
      const w = window as any;
      if (typeof w.orientation === "number") {
        const o = w.orientation as number;
        if (o !== 0) return norm(o);
        if (window.innerWidth <= window.innerHeight) return 0;
      }
      const so = window.screen?.orientation;
      if (so?.type) {
        if (so.type === "landscape-primary")   return 90;
        if (so.type === "landscape-secondary") return 270;
        if (so.type === "portrait-secondary")  return 180;
        return 0;
      }
      return window.innerWidth > window.innerHeight ? 90 : 0;
    };

    const onScreenChange = () => { if (!doeActive) commit(getAngle()); };
    const onVisible = () => { if (!document.hidden) onScreenChange(); };

    commit(getAngle()); // seed from screen API on mount

    const vid = videoRef.current;
    window.addEventListener("deviceorientation",  onDOE,          { passive: true });
    window.addEventListener("orientationchange",  onScreenChange, { passive: true });
    window.addEventListener("resize",             onScreenChange, { passive: true });
    window.addEventListener("pageshow",           onScreenChange, { passive: true });
    window.screen?.orientation?.addEventListener?.("change", onScreenChange);
    document.addEventListener("visibilitychange", onVisible);
    vid?.addEventListener("resize", onScreenChange);

    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("deviceorientation",  onDOE);
      window.removeEventListener("orientationchange",  onScreenChange);
      window.removeEventListener("resize",             onScreenChange);
      window.removeEventListener("pageshow",           onScreenChange);
      window.screen?.orientation?.removeEventListener?.("change", onScreenChange);
      document.removeEventListener("visibilitychange", onVisible);
      vid?.removeEventListener("resize", onScreenChange);
    };
  }, [handleRotate]);

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
    // .stream-section is defined in globals.css.
    // In browser landscape mode the CSS @media rule instantly counter-rotates the
    // container so the layout stays portrait — no JS delay, no snap.
    <section
      className="stream-section"
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
            <RotIcon icon={MdKeyboardReturn} size={28} rot={rot} />
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
                transform: `rotate(${rot}deg)`,
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
                rot={rot}
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
                rot={rot}
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
                rot={rot}
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
