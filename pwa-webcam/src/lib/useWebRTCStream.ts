import { useState, useRef, useCallback, useEffect } from "react";
import {
  createTransformedTrack,
  ProcessedTrack,
} from "@/lib/videoTransforms";

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
  const processedVideoRef = useRef<ProcessedTrack | null>(null);
  const outDimsRef = useRef<{ w: number; h: number } | null>(null);
  const sourceVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const statsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
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

  // Called by the gyro detector in stream/page.tsx whenever the physical
  // device angle changes. Updates the canvas correction in real-time so
  // the stream stays correctly oriented without renegotiating WebRTC.
  const handleRotate = useCallback((rot: number) => {
    rotationRef.current = rot;
    processedVideoRef.current?.setRotation(rot);
  }, []);

  const cleanup = useCallback(
    async (reason?: string) => {
      log("cleanup()", reason ?? "");

      if (reason !== "remote-linux-termination") {
        if (dcRef.current?.readyState === "open") {
          dcRef.current.send(
            JSON.stringify({ type: "terminate", source: "pwa" })
          );
        }
      }

      dcRef.current = null;
      startedRef.current = false;
      outDimsRef.current = null;

      if (peerRef.current) {
        peerRef.current.onconnectionstatechange = null;
        try {
          peerRef.current.close();
        } catch {}
        peerRef.current = null;
      }

      if (wakeLock.current) {
        try {
          await wakeLock.current.release();
          wakeLock.current = null;
        } catch (err: any) {
          log(`${err.name}: ${err.message}`);
        }
      }

      cleanupProcessedVideo();
      sourceVideoTrackRef.current = null;
      stopStatsLogging();

      setOn(false);
      setStatus("disconnected");

      if (reason == "remote-linux-termination") {
        propsRef.current.handleRemoteTermination(true);
      }
    },
    [cleanupProcessedVideo]
  );

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      void cleanup("unmount");
    };
  // cleanup is stable (its deps never change), but omit from deps so this
  // effect runs only on unmount and never re-registers on re-render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startStatsLogging = (pc: RTCPeerConnection) => {
    stopStatsLogging(); // ensure only one timer

    statsTimerRef.current = setInterval(async () => {
      try {
        const stats = await pc.getStats(); // :contentReference[oaicite:3]{index=3}
        stats.forEach((r: any) => {
          // outbound-rtp == sender stats :contentReference[oaicite:4]{index=4}
          if (r.type === "outbound-rtp" && r.kind === "video") {
            // last encoded frame dimensions :contentReference[oaicite:5]{index=5}
            console.log("[stats] outbound video:", r.frameWidth, r.frameHeight);
          }
        });
      } catch (e) {
        // ignore transient errors when closing
      }
    }, 1000); // polling regularly is expected :contentReference[oaicite:6]{index=6}
  };

  const stopStatsLogging = () => {
    if (statsTimerRef.current) {
      clearInterval(statsTimerRef.current);
      statsTimerRef.current = null;
    }
  };

  const relayToggle = (trigger: "mic" | "cam" | "media", state: MediaState) => {
    if (dcRef.current) {
      switch (trigger) {
        case "mic":
          dcRef.current.send(JSON.stringify({"type": "toggle", device: "mic", "value": state, "source": "pwa"}));
          break;
        case "cam":
          dcRef.current.send(JSON.stringify({"type": "toggle", device: "cam", "value": state, "source": "pwa"}));
          break;
        case "media":
          dcRef.current.send(JSON.stringify({"type": "toggle", device: "media", "value": state, "source": "pwa"}));
          break;
        default:
          log("relayToggle()", "unknown trigger source");
          break;
      };
    }
  }

  const fetchIceServers = async () => {
    const resp = await fetch(
      "https://getturncredentials-qaf2yvcrrq-uc.a.run.app",
      { method: "POST" }
    );
    const raw = await resp.json();
    return raw.map((s: any) => ({
      urls: s.urls ?? s.url,
      username: s.username,
      credential: s.credential,
    }));
  }

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
    setStatus("connecting");
    setError(null);

    try {
      const iceServers = await fetchIceServers();
      if (!mountedRef.current) return;

      const pc = new RTCPeerConnection({ iceServers });
      peerRef.current = pc;

      pc.onconnectionstatechange = () => {
        log("connectionState →", pc.connectionState);

        if (pc.connectionState === "connected") {
          setStatus("connected");
          setOn(true);
          // Push for high bitrate now that the connection is live
          pc.getSenders().forEach((sender) => {
            if (sender.track?.kind !== "video") return;
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
              params.encodings = [{}];
            }
            params.encodings[0].maxBitrate = 8_000_000; // 8 Mbps
            sender.setParameters(params).catch(() => {});
          });
          return;
        }

        if (
          pc.connectionState === "failed" ||
          pc.connectionState === "closed"
        ) {
          setError("WebRTC connection failed");
          cleanup("pc failed/closed");
        }
      };

      const dc = pc.createDataChannel("chat");
      dc.onopen = () => {
        dc.send("Hello from JS!");
        const { resolution } = propsRef.current;
        const { w, h } = getOutputDims(resolution);
        dc.send(JSON.stringify({ type: "dimensions", width: w, height: h }));
      };
      dc.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          console.log("Message received: ", msg);
          console.log("[dc] msg at", performance.now());

          if (msg.type === "toggle_mic" && msg.source === "linux") {
            if (propsRef.current.isMicOn !== msg.value.toLowerCase()) {
              console.log("Linux toggled mic");
              propsRef.current.toggleMic();
            }
          }
          
          if (msg.type === "toggle_cam" && msg.source === "linux") {
            if (propsRef.current.isVidOn !== msg.value.toLowerCase()) {
              console.log("Linux toggled cam");
              propsRef.current.toggleVid();
            }
          }
          
          if (msg.type === "terminate" && msg.source === "linux") {
            console.log("Linux terminated session");
            cleanup("remote-linux-termination");
          }
        } catch {
          console.log("DataChannel message:", e.data);
        }
      };
      dcRef.current = dc;

      media.getTracks().forEach((track) => {
        if (track.kind === "video") {
          sourceVideoTrackRef.current = track;
          cleanupProcessedVideo();

          const processed = buildProcessed(track);
          processedVideoRef.current = processed;

          pc.addTrack(processed.track, new MediaStream([processed.track]));
        } else {
          pc.addTrack(track, media);
        }
      });

      
      // Prefer VP9 or H.264 for better compression and quality
      pc.getTransceivers().forEach((t) => {
        if (t.sender.track?.kind !== "video") return;
        const caps = RTCRtpSender.getCapabilities?.("video");
        if (!caps) return;
        const preferred = caps.codecs.filter((c) =>
          /vp9|h264/i.test(c.mimeType)
        );
        if (preferred.length > 0) {
          try {
            t.setCodecPreferences([
              ...preferred,
              ...caps.codecs.filter((c) => !preferred.includes(c)),
            ]);
          } catch {}
        }
      });

      await pc.setLocalDescription(await pc.createOffer());
      if (!mountedRef.current) return;

      startStatsLogging(pc);

      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === "complete") resolve();
        };
      });
      if (!mountedRef.current) return;

      await fetch("https://submitoffer-qaf2yvcrrq-uc.a.run.app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: sessionCode,
          offer: pc.localDescription,
        }),
      });

      // Poll for answer
      let answer: RTCSessionDescriptionInit | null = null;
      while (!answer) {
        if (!mountedRef.current) return;

        const resp = await fetch(
          "https://checkanswer-qaf2yvcrrq-uc.a.run.app",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: sessionCode }),
          }
        );

        if (resp.status === 200) {
          const data = await resp.json();
          answer = data.answer;
        } else {
          await new Promise((r) => setTimeout(r, 1000));
          if (!mountedRef.current) return;
        }
      }
      if (!mountedRef.current) return;

      await pc.setRemoteDescription(answer);
      if (!mountedRef.current) return;
      
      try {
        wakeLock.current = await navigator.wakeLock.request('screen');
        wakeLock.current.addEventListener('release', () => {
          console.log('Wake Lock was released');
        });
      console.log('Wake Lock is active');
      } catch (error) {
        log("startStream() wakeLock failed");
      }
      log("WebRTC fully established");
    } catch (e: any) {
      console.error("WebRTC error:", e);
      setError(e.message || "WebRTC error");
      cleanup("exception");
    }
  }, [cleanup, buildProcessed, cleanupProcessedVideo]);

  const stopStream = useCallback(() => {
    log("stopStream()");
    cleanup("user stop");
  }, [cleanup]);

  const replaceTrack = useCallback(
    async (kind: "video" | "audio", track: MediaStreamTrack | null) => {
      const pc = peerRef.current;
      if (!pc) return;

      const sender = pc.getSenders().find((s) => s.track?.kind === kind);
      if (!sender) return;

      if (kind === "video") {
        cleanupProcessedVideo();

        if (!track) {
          sourceVideoTrackRef.current = null;
          await sender.replaceTrack(null);
          return;
        }

        sourceVideoTrackRef.current = track;

        const processed = buildProcessed(track);
        processedVideoRef.current = processed;

        await sender.replaceTrack(processed.track);
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
