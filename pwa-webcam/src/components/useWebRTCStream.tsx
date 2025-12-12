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
  const statsRef = useRef<NodeJS.Timeout | null>(null);
  const pollingRef = useRef(false);
  const hasAutoStarted = useRef(false);

  const [status, setStatus] = useState<ConnectionState>("disconnected");
  const [error, setError] = useState<string | null>(null);
  const [on, setOn] = useState(false);

  const log = (...msg: unknown[]) => console.log("[useWebRTCStream]", ...msg);

  const cleanup = useCallback(() => {
    log("cleanup() called");
    pollingRef.current = false;

    if (statsRef.current) {
      log("clearing stats interval");
      clearInterval(statsRef.current);
      statsRef.current = null;
    }

    if (peerRef.current) {
      log("closing RTCPeerConnection");
      peerRef.current.close();
      peerRef.current = null;
    }

    setStatus("disconnected");
    setOn(false);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  async function fetchIceServers() {
    const resp = await fetch(
      "https://getturncredentials-qaf2yvcrrq-uc.a.run.app",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }
    );

    // resp.json() is already an array of ICE‐server objects
    const iceServers = await resp.json();
    return iceServers;
  }

  // const startStream = useCallback(async () => {
  //   log('startStream() invoked');

  //   if (status === 'connecting' || status === 'connected') {
  //     log('already', status, ' - aborting duplicate call');
  //     return;
  //   }

  //   const {
  //     media, sessionCode, isMicOn, isVidOn,
  //     resolution, fps, isFrontCamera, exposure,
  //   } = propsRef.current;

  //   if (!media) {
  //     log('⚠️  No media present - setError and bail');
  //     setError('No media');
  //     return;
  //   }

  //   try {
  //     setStatus('connecting');
  //     log('fetching TURN credentials…');
  //     const iceServers = await fetchIceServers();
  //     log('TURN credentials received', iceServers);

  //     const pc = new RTCPeerConnection({ iceServers: iceServers, bundlePolicy: 'max-bundle' });
  //     peerRef.current = pc;
  //     log('RTCPeerConnection created');

  //     pc.onicegatheringstatechange = () => log('ICE gathering state →', pc.iceGatheringState);
  //     pc.oniceconnectionstatechange = () => log('ICE connection state →', pc.iceConnectionState);
  //     pc.onconnectionstatechange = () => log('Peer connection state →', pc.connectionState);
  //     pc.onicecandidateerror = (e) => log('ICE candidate error', e);

  //     media.getTracks().forEach(t => {
  //       const sender = pc.addTrack(t, media);
  //       pc.getTransceivers().find(tr => tr.sender === sender)!.direction = 'sendonly';
  //       log(`added track (${t.kind}) direction=sendonly`);
  //     });

  //     await pc.setLocalDescription(await pc.createOffer());
  //     log('offer created and local description set');

  //     await new Promise<void>(res => {
  //       if (pc.iceGatheringState === 'complete') return res();
  //       const callback = () => {
  //         if (pc.iceGatheringState === 'complete') {
  //           pc.removeEventListener('icegatheringstatechange', callback);
  //           res();
  //         }
  //       };
  //       pc.addEventListener('icegatheringstatechange', callback);
  //     });
  //     log('ICE gathering complete');

  //     const body = {
  //       code: sessionCode,
  //       offer: pc.localDescription,
  //       metadata: {
  //         mic:  isMicOn === 'on',
  //         webcam: isVidOn === 'on',
  //         resolution, fps,
  //         platform: 'mobile',
  //         facingMode: isFrontCamera ? 'user' : 'environment',
  //         exposureLevel: exposure,
  //         ts: Date.now(),
  //       },
  //     };
  //     log('submitting offer', body);
  //     const submitResp = await fetch('https://submitoffer-qaf2yvcrrq-uc.a.run.app', {
  //       method: 'POST',
  //       headers: { 'Content-Type': 'application/json' },
  //       body: JSON.stringify(body),
  //     });
  //     if (!submitResp.ok) throw new Error(`submitOffer failed: ${submitResp.status}`);
  //     log('offer submitted OK');

  //     pc.onconnectionstatechange = () => {
  //       log('peer connectionState →', pc.connectionState);
  //       switch (pc.connectionState) {
  //         case 'connected': setStatus('connected'); setOn(true); break;
  //         case 'disconnected':
  //         case 'closed': cleanup(); break;
  //         case 'failed': setError('PeerConnection failed'); propsRef.current.stopMedia(); cleanup(); break;
  //         default: setStatus('connecting');
  //       }
  //     };

  //     // pollingRef.current = true;
  //     // let delay = 2000;
  //     // while (pollingRef.current) {
  //     //   log(`polling for answer (delay ${delay} ms)`);
  //     //   const ansResp = await fetch('https://checkanswer-qaf2yvcrrq-uc.a.run.app', {
  //     //     method: 'POST',
  //     //     headers: { 'Content-Type': 'application/json' },
  //     //     body: JSON.stringify({ code: sessionCode }),
  //     //   });

  //     //   if (ansResp.status === 204) {
  //     //     await new Promise(r => setTimeout(r, delay));
  //     //     delay = Math.min(delay * 2, 30000);
  //     //     continue;
  //     //   }

  //     //   if (!ansResp.ok) throw new Error(`checkAnswer failed: ${ansResp.status}`);
  //     //   const { answer } = await ansResp.json();
  //     //   if (answer) {
  //     //     log('answer received', answer);
  //     //     await pc.setRemoteDescription(answer);
  //     //     log('remote description set - streaming should begin');

  //     //     if (!statsRef.current) {
  //     //       statsRef.current = setInterval(async () => {
  //     //         if (pc.connectionState !== 'connected') return;
  //     //         const stats = await pc.getStats();
  //     //         stats.forEach(r => {
  //     //           if (r.type === 'candidate-pair' && r.state === 'succeeded') {
  //     //             log('ICE ✔ succeeded via', r.localCandidateId, '→', r.remoteCandidateId);
  //     //           }

  //     //           if (r.type === 'candidate-pair' && r.state === 'failed') {
  //     //             log('ICE ✖ failed for pair:', r.localCandidateId, '→', r.remoteCandidateId);
  //     //           }

  //     //           if (r.type === 'outbound-rtp' && r.kind === 'video') {
  //     //             log('Video outbound - packets', r.packetsSent, 'bytes', r.bytesSent);
  //     //           }
  //     //         });
  //     //       }, 3000);
  //     //       log('stats interval started');
  //     //     }
  //     //     break
  //     //   }
  //     //   await new Promise(r => setTimeout(r, delay));
  //     // }

  //     let answerDesc;
  //     while (!answerDesc) {
  //       const resp = await fetch("https://checkanswer-qaf2yvcrrq-uc.a.run.app", {
  //         method: 'POST',
  //         headers: {'Content-Type':'application/json'},
  //         body: JSON.stringify({ code: sessionCode })
  //       });
  //       if (resp.status === 200) {
  //         const { answer } = await resp.json();
  //         answerDesc = new RTCSessionDescription(answer);
  //       } else {
  //         await new Promise(r => setTimeout(r, 1000));
  //       }
  //     }

  //     await pc.setRemoteDescription(answerDesc);
  //     console.log('Remote Description set - streaming should begin');

  //   } catch (e: any) {
  //     log('Error during startStream -', e.message);
  //     setError(e.message || 'unknown WebRTC error');
  //     cleanup();
  //   }
  // }, [cleanup, status]);

  const startStream = useCallback(async () => {
    const {
      media,
      sessionCode,
      isMicOn,
      isVidOn,
      resolution,
      fps,
      isFrontCamera,
      exposure,
    } = propsRef.current;

    if (!media) {
      setError("No media stream available");
      return;
    }

    try {
      // 1) Prompt for code
      const code = sessionCode;

      // 2) Get ICE servers
      const iceServers = await fetchIceServers();

      // 3) Create PC + data-channel
      const pc = new RTCPeerConnection({ iceServers });
      peerRef.current = pc;

      const dc = pc.createDataChannel("chat");
      dc.onopen = () => dc.send("Hello from JS!");
      dc.onmessage = (e) => console.log("📥 from Python:", e.data);

      media.getTracks().forEach((track) => {
        pc.addTrack(track, media);
      });

      // 4) Make & send the offer
      await pc.setLocalDescription(await pc.createOffer());

      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === "complete") resolve();
        };
      });

      await fetch("submitoffer", {
        method: "POST",
        body: JSON.stringify({ code, offer: pc.localDescription }),
      });

      // 5) Poll for answer
      let answerDesc: RTCSessionDescriptionInit | null = null;
      while (!answerDesc) {
        const resp = await fetch(
          "https://checkanswer-qaf2yvcrrq-uc.a.run.app",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code }),
          }
        );
        if (resp.status === 200) {
          const { answer } = await resp.json();
          answerDesc = answer;
        } else {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      // 6) Apply the answer
      await pc.setRemoteDescription(new RTCSessionDescription(answerDesc));
      console.log("✅ WebRTC connection established!");

      // 7) Update status & leave the PC running
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") {
          setStatus("connected");
          setOn(true);
        } else if (pc.connectionState === "failed") {
          setError("PeerConnection failed");
          cleanup();
        }
      };
    } catch (e: any) {
      console.error("WebRTC error:", e);
      setError(e.message || "Unknown error");
      cleanup();
    }
  }, [fetchIceServers, propsRef, cleanup]);

  const stopStream = useCallback(() => {
    log("stopStream called");
    cleanup();
  }, [cleanup]);

  const toggleStream = useCallback(() => {
    log("toggleStream - on?", on);
    if (on) {
      // Stop both media & WebRTC
      propsRef.current.stopMedia();
      stopStream();
    } else if (propsRef.current.media) {
      // Media already live → initiate WebRTC
      startStream();
    } else {
      // First get user media, then our effect below will auto‐start WebRTC
      propsRef.current.startMedia();
    }
  }, [on, stopStream, startStream]);

  useEffect(() => {
    if (initialProps.media && !hasAutoStarted.current) {
      log("auto‑starting WebRTC stream");
      hasAutoStarted.current = true;
      startStream();
    }
  }, [initialProps.media, startStream]);

  const replaceTrack = useCallback(
    async (kind: "video" | "audio", track: MediaStreamTrack | null) => {
      const pc = peerRef.current;
      if (!pc) {
        log("replaceTrack called but no pc");
        return;
      }

      const sender = pc.getSenders().find((s) => s.track?.kind === kind);
      if (sender) {
        log(`replacing existing ${kind} track`);
        await sender.replaceTrack(track);
      } else if (track) {
        log(`adding new ${kind} track (no sender)`);
        pc.addTrack(track, propsRef.current.media!);
      } else {
        log(`no ${kind} sender and no new track - nothing to do`);
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
    toggleStream,
  };
}
