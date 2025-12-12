import { useState, useRef, useCallback, useEffect } from "react";

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
}

export default function useWebRTCStream(initialProps: UseWebRTCStreamProps) {
  const propsRef = useRef(initialProps);
  useEffect(() => {
    propsRef.current = initialProps;
  });

  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const pollingRef = useRef(false);
  const startedRef = useRef(false);

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

    setOn(false);
    setStatus("disconnected");
  }, []);

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
      dc.onopen = () => dc.send("Hello from JS!");
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
        pc.addTrack(track, media);
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

      if (sender) {
        await sender.replaceTrack(track);
      } else if (track) {
        pc.addTrack(track, propsRef.current.media!);
      }
    },
    []
  );

  return {
    isStreamOn: on,
    connectionStatus: status,
    error,
    replaceTrack,
    startStream,
    stopStream,
  };
}
