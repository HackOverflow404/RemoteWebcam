import { useState, useRef, useCallback, useEffect } from "react";
import {
  createTransformedTrack,
  Rotation,
  ProcessedTrack,
} from "@/lib/videoTransforms";

export type ConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";
export type MediaState = "on" | "off" | "error";

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
  startMedia: () => void;
  stopMedia: () => void;
  handleRemoteTermination: (remoteTermination: boolean) => void;
}

export default function useWebRTCStream(initialProps: UseWebRTCStreamProps) {
  const propsRef = useRef(initialProps);
  useEffect(() => {
    propsRef.current = initialProps;
  });

  const startedRef = useRef(false);
  const rotationRef = useRef<Rotation>(0);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const processedVideoRef = useRef<ProcessedTrack | null>(null);
  const sourceVideoTrackRef = useRef<MediaStreamTrack | null>(null);
  const outDimsRef = useRef<{ w: number; h: number } | null>(null);

  const [status, setStatus] = useState<ConnectionState>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [on, setOn] = useState(false);

  const log = (...msg: unknown[]) => console.log("[useWebRTCStream]", ...msg);

  const lockOutputDimsOnce = useCallback(() => {
    if (outDimsRef.current) return outDimsRef.current;

    const { resolution } = propsRef.current;
    const dims =
      resolution === "4k"
        ? { w: 3840, h: 2160 }
        : resolution === "sd"
        ? { w: 640, h: 480 }
        : { w: 1280, h: 720 };

    outDimsRef.current = dims;
    return dims;
  }, []);

  const buildProcessed = useCallback(
    (track: MediaStreamTrack, rot: Rotation) => {
      const { fps, isFrontCamera } = propsRef.current;
      const { w, h } = lockOutputDimsOnce();

      const fit = rot === 0 ? "contain" : "cover";

      return createTransformedTrack(track, {
        outW: w,
        outH: h,
        fps,
        mirror: isFrontCamera,
        rotation: rot,
        fit,
        background: "black",
      });
    },
    [lockOutputDimsOnce]
  );

  const cleanupProcessedVideo = useCallback(() => {
    if (processedVideoRef.current) {
      processedVideoRef.current.stop();
      processedVideoRef.current = null;
    }
  }, []);

  const computeRotation = (w: number, h: number): Rotation => {
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
  };

  const handleRotate = useCallback(async (w: number, h: number) => {
    const rot = computeRotation(w, h);
    if (rot === rotationRef.current) return;
    rotationRef.current = rot;

    processedVideoRef.current?.setRotation(rot);
  }, []);

  const cleanup = useCallback(
    (reason?: string) => {
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
        try {
          peerRef.current.close();
        } catch {}
        peerRef.current = null;
      }

      cleanupProcessedVideo();

      setOn(false);
      setStatus("disconnected");

      if (reason == "remote-linux-termination") {
        propsRef.current.handleRemoteTermination(true);
      }
    },
    [cleanupProcessedVideo]
  );

  function getOutputDims(resolution: string) {
    // Keep output constant so WebRTC never renegotiates on rotation.
    switch (resolution) {
      case "4k":
        return { w: 3840, h: 2160 };
      case "hd":
        return { w: 1280, h: 720 };
      case "sd":
        return { w: 640, h: 480 };
    }
    return { w: 1280, h: 720 }; // hd default
  }

  async function fetchIceServers() {
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
      const pc = new RTCPeerConnection({ iceServers });
      peerRef.current = pc;

      pc.onconnectionstatechange = () => {
        log("connectionState →", pc.connectionState);

        if (pc.connectionState === "connected") {
          setStatus("connected");
          setOn(true);
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

          const w = window.visualViewport?.width ?? window.innerWidth;
          const h = window.visualViewport?.height ?? window.innerHeight;
          rotationRef.current = computeRotation(Math.round(w), Math.round(h));

          const processed = buildProcessed(track, rotationRef.current);
          processedVideoRef.current = processed;

          pc.addTrack(processed.track, new MediaStream([processed.track]));
        } else {
          pc.addTrack(track, media);
        }
      });

      await pc.setLocalDescription(await pc.createOffer());

      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === "complete") resolve();
        };
      });

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
        }
      }

      await pc.setRemoteDescription(answer);
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

        const processed = buildProcessed(track, rotationRef.current);
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
    handleRotate,
    replaceTrack,
    startStream,
    stopStream,
  };
}
