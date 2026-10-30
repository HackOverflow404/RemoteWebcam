import { useState, useRef, useCallback, useEffect } from "react";
import {
  createTransformedTrack,
  ProcessedTrack,
} from "@/lib/videoTransforms";

import { startSessionStats } from "@/lib/webrtcSessionStats";
import { getIceServers, submitOffer, waitForAnswer } from "@/lib/signaling";

export type ConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";
export type MediaState = "on" | "off" | "error";

// Keep output dimensions constant for the entire session so WebRTC never
// needs to renegotiate when the phone rotates. The canvas handles fitting.
const getOutputDims = (resolution: string) => {
  switch (resolution) {
    case "4k": return { w: 3840, h: 2160 };
    case "hd": return { w: 1280, h: 720 };
    case "sd": return { w: 640, h: 480 };
  }
  return { w: 1280, h: 720 };
};

// The desktop (aiortc) can't trickle ICE, so the offer has to carry its
// candidates. Waiting for gathering to fully complete can take many seconds
// (every TURN transport, STUN probes on interfaces without internet), so send
// the offer once we have the best candidate type available — relay when a
// TURN server is configured, otherwise server-reflexive — plus a short grace
// for stragglers, or at the cap.
const ICE_GATHER_CAP_MS = 3000;
const ICE_GRACE_MS = 250;
// A "disconnected" peer often recovers on its own (Wi-Fi roam, brief loss).
const DISCONNECT_GRACE_MS = 10_000;
const MAX_VIDEO_BITRATE = 8_000_000;

export interface UseWebRTCStreamProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  media: MediaStream | null;
  sessionCode: string;
  isMicOn: MediaState;
  isVidOn: MediaState;
  isFrontCamera: boolean;
  resolution: string;
  fps: number;
  exposure: number;
  toggleMic: () => void;
  toggleVid: () => void;
  startMedia: () => void;
  stopMedia: () => void;
  handleRemoteTermination: (remoteTermination: boolean) => void;
}

function waitForIceCandidates(
  pc: RTCPeerConnection,
  hasTurn: boolean,
  signal: AbortSignal
): Promise<void> {
  const target = hasTurn ? "relay" : "srflx";
  return new Promise((resolve) => {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(capTimer);
      clearTimeout(graceTimer);
      pc.removeEventListener("icegatheringstatechange", onState);
      pc.removeEventListener("icecandidate", onCandidate);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const onState = () => { if (pc.iceGatheringState === "complete") done(); };
    const onCandidate = (e: RTCPeerConnectionIceEvent) => {
      if (!e.candidate) return done();
      if (e.candidate.type === target && !graceTimer) {
        graceTimer = setTimeout(done, ICE_GRACE_MS);
      }
    };
    const capTimer = setTimeout(done, ICE_GATHER_CAP_MS);
    if (pc.iceGatheringState === "complete") return done();
    pc.addEventListener("icegatheringstatechange", onState);
    pc.addEventListener("icecandidate", onCandidate);
    signal.addEventListener("abort", done);
  });
}

// aiortc decodes VP8 and H.264; prefer H.264 so iPhones use the hardware encoder.
function preferH264(transceiver: RTCRtpTransceiver) {
  const caps =
    RTCRtpReceiver.getCapabilities?.("video") ?? RTCRtpSender.getCapabilities?.("video");
  if (!caps || typeof transceiver.setCodecPreferences !== "function") return;
  const rank = (c: RTCRtpCodec) =>
    /h264/i.test(c.mimeType) ? 0 : /vp8/i.test(c.mimeType) ? 1 : 2;
  const sorted = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
  try {
    transceiver.setCodecPreferences(sorted);
  } catch (e) {
    console.warn("[useWebRTCStream] setCodecPreferences failed:", e);
  }
}

export default function useWebRTCStream(initialProps: UseWebRTCStreamProps) {
  const propsRef = useRef(initialProps);
  useEffect(() => {
    propsRef.current = initialProps;
  });

  const mountedRef = useRef(true);
  const startedRef = useRef(false);
  const rotationRef = useRef<number>(0);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processedVideoRef = useRef<ProcessedTrack | null>(null);
  const outDimsRef = useRef<{ w: number; h: number } | null>(null);
  const sessionStatsRef = useRef<ReturnType<typeof startSessionStats> | null>(null);
  const wakeLock = useRef<WakeLockSentinel | null>(null);

  const [status, setStatus] = useState<ConnectionState>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [on, setOn] = useState(false);

  const log = (...msg: unknown[]) => console.log("[useWebRTCStream]", ...msg);

  const lockOutputDimsOnce = useCallback(() => {
    if (outDimsRef.current) return outDimsRef.current;
    const { resolution } = propsRef.current;
    outDimsRef.current = getOutputDims(resolution);
    return outDimsRef.current;
  }, []);

  const buildProcessed = useCallback(
    (track: MediaStreamTrack) => {
      const { fps } = propsRef.current;
      const { w, h } = lockOutputDimsOnce();
      // Never mirror the outgoing stream — only the local preview is mirrored
      // (via CSS scaleX on the video element). The virtual webcam on Linux
      // should show the un-mirrored feed, matching how a real webcam behaves.
      const processed = createTransformedTrack(track, {
        outW: w,
        outH: h,
        fps,
        background: "black",
      });
      // Sync the canvas to the current physical rotation immediately so the
      // very first frame is already correctly oriented.
      processed.setRotation(rotationRef.current);
      return processed;
    },
    [lockOutputDimsOnce]
  );

  const cleanupProcessedVideo = useCallback(() => {
    if (processedVideoRef.current) {
      processedVideoRef.current.stop();
      processedVideoRef.current = null;
    }
  }, []);

  // Called by the orientation detector in stream/page.tsx whenever the
  // device angle changes. Updates the canvas correction in real-time so
  // the stream stays correctly oriented without renegotiating WebRTC.
  const handleRotate = useCallback((rot: number) => {
    rotationRef.current = rot;
    processedVideoRef.current?.setRotation(rot);
  }, []);

  const requestWakeLock = useCallback(async () => {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    if (wakeLock.current && !wakeLock.current.released) return;
    try {
      wakeLock.current = await navigator.wakeLock.request("screen");
    } catch (err) {
      log("wakeLock request failed:", err);
    }
  }, []);

  const cleanup = useCallback(
    (reason?: string, errorMessage?: string) => {
      log("cleanup()", reason ?? "");
      sessionStatsRef.current?.stop(reason);
      sessionStatsRef.current = null;

      abortRef.current?.abort();
      abortRef.current = null;
      if (disconnectTimerRef.current) {
        clearTimeout(disconnectTimerRef.current);
        disconnectTimerRef.current = null;
      }

      const dc = dcRef.current;
      if (reason !== "remote-linux-termination" && dc?.readyState === "open") {
        try {
          dc.send(JSON.stringify({ type: "terminate", source: "pwa" }));
        } catch {}
      }
      dcRef.current = null;
      startedRef.current = false;
      outDimsRef.current = null;

      const pc = peerRef.current;
      peerRef.current = null;
      if (pc) {
        pc.onconnectionstatechange = null;
        // Give the terminate message a moment to leave before closing.
        const close = () => { try { pc.close(); } catch {} };
        if (dc?.readyState === "open" && reason !== "pagehide") setTimeout(close, 100);
        else close();
      }

      wakeLock.current?.release().catch(() => {});
      wakeLock.current = null;

      cleanupProcessedVideo();

      if (!mountedRef.current) return;
      setOn(false);
      setStatus(errorMessage ? "error" : "disconnected");
      if (errorMessage) setError(errorMessage);

      if (reason === "remote-linux-termination") {
        propsRef.current.handleRemoteTermination(true);
      }
    },
    [cleanupProcessedVideo]
  );

  useEffect(() => {
    mountedRef.current = true; // StrictMode re-mounts reuse refs
    // Tell the desktop right away when the tab/app is closed, rather than
    // leaving it to notice ~30 s later via ICE consent timeouts.
    const onPageHide = () => { if (peerRef.current) cleanup("pagehide"); };
    const onVisible = () => {
      if (document.visibilityState === "visible" && peerRef.current) void requestWakeLock();
    };
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisible);
      mountedRef.current = false;
      cleanup("unmount");
    };
  }, [cleanup, requestWakeLock]);

  const relayToggle = useCallback((trigger: "mic" | "cam" | "media", state: MediaState) => {
    const dc = dcRef.current;
    if (dc?.readyState !== "open") return;
    try {
      dc.send(JSON.stringify({ type: "toggle", device: trigger, value: state, source: "pwa" }));
    } catch (e) {
      log("relayToggle() failed:", e);
    }
  }, []);

  const startStream = useCallback(async () => {
    if (startedRef.current || peerRef.current) {
      log("startStream ignored: already active");
      return;
    }

    const { media, sessionCode } = propsRef.current;

    if (!media) {
      setError("No media stream available");
      return;
    }

    startedRef.current = true;
    const abort = new AbortController();
    abortRef.current = abort;
    setStatus("connecting");
    setError(null);
    void requestWakeLock();

    try {
      const iceServers = await getIceServers();
      if (abort.signal.aborted) return;

      const pc = new RTCPeerConnection({ iceServers, bundlePolicy: "max-bundle" });
      peerRef.current = pc;
      sessionStatsRef.current = startSessionStats(pc);

      pc.onconnectionstatechange = () => {
        log("connectionState →", pc.connectionState);
        if (peerRef.current !== pc) return;

        if (disconnectTimerRef.current) {
          clearTimeout(disconnectTimerRef.current);
          disconnectTimerRef.current = null;
        }

        switch (pc.connectionState) {
          case "connected":
            sessionStatsRef.current?.markConnected();
            setStatus("connected");
            setOn(true);
            pc.getSenders().forEach((sender) => {
              if (sender.track?.kind !== "video") return;
              const params = sender.getParameters();
              if (!params.encodings || params.encodings.length === 0) {
                params.encodings = [{}];
              }
              params.encodings[0].maxBitrate = MAX_VIDEO_BITRATE;
              params.encodings[0].maxFramerate = propsRef.current.fps;
              sender.setParameters(params).catch(() => {});
            });
            break;
          case "disconnected":
            setStatus("connecting");
            disconnectTimerRef.current = setTimeout(() => {
              if (peerRef.current === pc && pc.connectionState !== "connected") {
                cleanup("disconnect timeout", "Connection lost");
              }
            }, DISCONNECT_GRACE_MS);
            break;
          case "failed":
            cleanup("pc failed", "Connection failed. Check that both devices are online.");
            break;
          case "closed":
            cleanup("pc closed");
            break;
        }
      };

      const dc = pc.createDataChannel("chat");
      dc.onmessage = (e) => {
        let msg: { type?: string; source?: string; value?: unknown };
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.source !== "linux") return;
        const value = typeof msg.value === "string" ? msg.value.toLowerCase() : null;

        if (msg.type === "toggle_mic" && value && propsRef.current.isMicOn !== value) {
          propsRef.current.toggleMic();
        } else if (msg.type === "toggle_cam" && value && propsRef.current.isVidOn !== value) {
          propsRef.current.toggleVid();
        } else if (msg.type === "terminate") {
          log("Linux terminated session");
          cleanup("remote-linux-termination");
        }
      };
      dcRef.current = dc;

      media.getTracks().forEach((track) => {
        if (track.kind === "video") {
          cleanupProcessedVideo();
          const processed = buildProcessed(track);
          processedVideoRef.current = processed;
          const t = pc.addTransceiver(processed.track, {
            direction: "sendonly",
            streams: [new MediaStream([processed.track])],
          });
          preferH264(t);
        } else {
          pc.addTransceiver(track, { direction: "sendonly", streams: [media] });
        }
      });

      await pc.setLocalDescription(await pc.createOffer());
      const hasTurn = iceServers.some((s) =>
        [s.urls].flat().some((u) => /^turns?:/i.test(u))
      );
      await waitForIceCandidates(pc, hasTurn, abort.signal);
      if (abort.signal.aborted) return;

      await submitOffer(sessionCode, pc.localDescription!, abort.signal);
      const answer = await waitForAnswer(sessionCode, { signal: abort.signal });
      if (abort.signal.aborted) return;

      await pc.setRemoteDescription(answer);
      log("WebRTC signaling complete");
    } catch (e: any) {
      if (abort.signal.aborted) return;
      console.error("WebRTC error:", e);
      cleanup("exception", e?.message || "WebRTC error");
    }
  }, [cleanup, buildProcessed, cleanupProcessedVideo, requestWakeLock]);

  const stopStream = useCallback(() => {
    log("stopStream()");
    cleanup("user stop");
  }, [cleanup]);

  const replaceTrack = useCallback(
    async (kind: "video" | "audio", track: MediaStreamTrack | null) => {
      const pc = peerRef.current;
      if (!pc) return;

      const transceiver = pc
        .getTransceivers()
        .find((t) => t.receiver.track?.kind === kind);
      const sender = transceiver?.sender;
      if (!sender) return;

      if (kind === "video") {
        const old = processedVideoRef.current;
        if (!track) {
          await sender.replaceTrack(null);
          cleanupProcessedVideo();
          return;
        }
        const processed = buildProcessed(track);
        processedVideoRef.current = processed;
        await sender.replaceTrack(processed.track);
        old?.stop(); // swap first, then stop, so the sender never goes blank
        return;
      }

      await sender.replaceTrack(track);
    },
    [buildProcessed, cleanupProcessedVideo]
  );

  return {
    isStreamOn: on,
    connectionStatus: status,
    error,
    relayToggle,
    handleRotate,
    replaceTrack,
    startStream,
    stopStream,
  };
}
