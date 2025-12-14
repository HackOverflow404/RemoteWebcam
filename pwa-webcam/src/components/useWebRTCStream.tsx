import { useState, useRef, useCallback, useEffect } from "react";
import {
  createMirroredTrack,
  createLetterboxedTrack,
  createRotatedTrack,
  ProcessedTrack,
  Rotation,
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

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const startedRef = useRef(false);
  const rotationRef = useRef<Rotation>(0);
  const processedVideoRef = useRef<ProcessedTrack | null>(null);

  const [status, setStatus] = useState<ConnectionState>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [on, setOn] = useState(false);

  const log = (...msg: unknown[]) => console.log("[useWebRTCStream]", ...msg);

  const cleanup = useCallback((reason?: string) => {
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
  }, []);

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

  const handleRotate = useCallback(async (w: number, h: number) => {
    const pc = peerRef.current;
    const media = propsRef.current.media;

    if (!pc || !media) return;

    const sourceTrack = media.getVideoTracks()[0];
    if (!sourceTrack) return;

    const settings = sourceTrack.getSettings();
    const tw = settings.width ?? 0;
    const th = settings.height ?? 0;

    const wantLandscape = w > h;

    // Decide if we need to rotate based on what the camera is *actually* outputting.
    // If camera frames are portrait but UI is landscape => rotate 90.
    // If camera frames are landscape but UI is portrait => rotate -90.
    let nextRot: Rotation = 0;

    if (tw && th) {
      const trackIsLandscape = tw > th;

      if (wantLandscape && !trackIsLandscape) nextRot = 90;
      else if (!wantLandscape && trackIsLandscape) nextRot = -90;
    } else {
      // Fallback: if we can’t read track dims, don’t thrash.
      nextRot = wantLandscape ? 90 : 0;
    }

    if (rotationRef.current === nextRot) return; // no-op
    rotationRef.current = nextRot;

    // Only do the expensive rebuild if we are actively streaming
    const sender = pc.getSenders().find((s) => s.track?.kind === "video");
    if (!sender) return;

    cleanupProcessedVideo();

    const processed = makeProcessedVideo(sourceTrack);
    processedVideoRef.current = processed;

    await sender.replaceTrack(processed.track);
  }, []);

  function makeProcessedVideo(track: MediaStreamTrack): ProcessedTrack {
    const { fps, isFrontCamera, resolution } = propsRef.current;
    const { w, h } = getOutputDims(resolution);
    const rot = rotationRef.current;

    // Rotate first (so “mirror horizontally” is correct in final orientation)
    const rotated = createRotatedTrack(track, rot, fps, "black");

    const mirrored = createMirroredTrack(rotated.track, isFrontCamera, fps);

    // Letterbox into fixed output; in landscape it will fill and effectively show no bars
    const boxed = createLetterboxedTrack(mirrored.track, w, h, fps, "black");

    return {
      track: boxed.track,
      stop: () => {
        boxed.stop();
        mirrored.stop();
        rotated.stop();
      },
    };
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
          cleanupProcessedVideo();

          const processed = makeProcessedVideo(track);
          processedVideoRef.current = processed;

          // Use a dedicated stream for the processed track
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
  }, [cleanup]);

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
          await sender.replaceTrack(null);
          return;
        }

        const processed = makeProcessedVideo(track);
        processedVideoRef.current = processed;

        await sender.replaceTrack(processed.track);
        return;
      }

      await sender.replaceTrack(track);
    },
    []
  );

  function cleanupProcessedVideo() {
    if (processedVideoRef.current) {
      processedVideoRef.current.stop();
      processedVideoRef.current = null;
    }
  }

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
