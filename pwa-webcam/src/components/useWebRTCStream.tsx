import React, { useState, useRef, useCallback, useEffect } from 'react'

type ConnectionState = "connecting" | "connected" | "disconnected" | "error";
type MediaState = "on" | "off" | "error";

interface UseWebRTCStreamProps {
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

export default function useWebRTCStream({
    videoRef,
    media,
    sessionCode,
    isMicOn,
    isVidOn,
    isFrontCamera,
    resolution,
    fps,
    exposure,
    startMedia,
    stopMedia
}: UseWebRTCStreamProps) {
    const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
    const statsIntervalRef = useRef<NodeJS.Timeout | null>(null);
    const pollingActiveRef = useRef(true);

    const [isStreamOn, setIsStreamOn] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [connectionStatus, setConnectionStatus] = useState<ConnectionState>("connecting");

    // --- Cleanup ---
    const cleanup = useCallback(() => {
        pollingActiveRef.current = false;
        if (statsIntervalRef.current) {
            clearInterval(statsIntervalRef.current);
            statsIntervalRef.current = null;
        }
        if (peerConnectionRef.current) {
            peerConnectionRef.current.close();
            peerConnectionRef.current = null;
        }
        if (videoRef.current) {
            videoRef.current.srcObject = null;
        }
        setIsStreamOn(false);
        setConnectionStatus("disconnected");
    }, [videoRef]);

    // --- Stable startStream handler ---
    const startStream = useCallback(() => {
        pollingActiveRef.current = true;
        let peerConnection: RTCPeerConnection;
        let sdpOffer: RTCSessionDescription | null;

        const waitForIceGathering = () =>
            new Promise<void>((resolve) => {
                if (peerConnection.iceGatheringState === "complete") return resolve();
                const check = () => {
                    if (peerConnection.iceGatheringState === "complete") {
                        peerConnection.removeEventListener("icegatheringstatechange", check);
                        resolve();
                    }
                };
                peerConnection.addEventListener("icegatheringstatechange", check);
            });

        const init = async () => {
            const response = await fetch("https://getturncredentials-qaf2yvcrrq-uc.a.run.app", { method: "POST" });
            if (!response.ok) {
                setError("Failed to fetch ICE servers");
                return;
            }
            let iceServers = await response.json();

            const config: RTCConfiguration = {
                iceServers,
                bundlePolicy: "max-bundle",
            };

            // Cleanup old PeerConnection
            if (peerConnectionRef.current) {
                peerConnectionRef.current.close();
            }
            peerConnection = new RTCPeerConnection(config);
            peerConnectionRef.current = peerConnection;

            // Add tracks
            if (!media) {
                setError("No media stream available");
                return;
            }
            media.getTracks().forEach(track => {
                const sender = peerConnection.addTrack(track, media);
                const transceiver = peerConnection.getTransceivers().find(t => t.sender === sender);
                if (transceiver) transceiver.direction = "sendonly";
            });
            // Debugging info
            peerConnection.getTransceivers().forEach((t, i) => {
                console.log(`[Transceiver ${i}] kind: ${t.sender.track?.kind}, direction: ${t.direction}`);
            });
        };

        const createOffer = async () => {
            peerConnection.onicecandidate = event => {
                if (event.candidate) {
                    console.log("ICE candidate:", event.candidate);
                }
            };
            peerConnection.oniceconnectionstatechange = () => {
                console.log("ICE Connection State:", peerConnection.iceConnectionState);
            };
            peerConnection.onicegatheringstatechange = () => {
                console.log("ICE Gathering State:", peerConnection.iceGatheringState);
            };
            peerConnection.onicecandidateerror = (error) => {
                console.error("ICE Candidate error:", error);
            };

            if (!media || media.getTracks().length === 0) {
                setError("No media tracks to offer. Did startMedia() complete?");
                return;
            }

            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            await waitForIceGathering();
            sdpOffer = peerConnection.localDescription;
        };

        const submitOffer = async () => {
            const response = await fetch("https://submitoffer-qaf2yvcrrq-uc.a.run.app", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    code: sessionCode,
                    offer: sdpOffer,
                    metadata: {
                        mic: isMicOn === "on",
                        webcam: isVidOn === "on",
                        resolution,
                        fps,
                        platform: "mobile",
                        facingMode: isFrontCamera ? "user" : "environment",
                        exposureLevel: exposure,
                        timestamp: Date.now(),
                    },
                }),
            });

            if (!response.ok) {
                setConnectionStatus("disconnected");
                setIsStreamOn(false);
                setError("Failed to submit offer");
                return;
            }

            peerConnection.onconnectionstatechange = () => {
                if (peerConnection.connectionState === "connected") {
                    setConnectionStatus("connected");
                    setIsStreamOn(true);
                } else if (peerConnection.connectionState === "disconnected") {
                    setConnectionStatus("disconnected");
                    setIsStreamOn(false);
                    cleanup();
                } else if (peerConnection.connectionState === "failed") {
                    setConnectionStatus("error");
                    setError("PeerConnection failed");
                    setIsStreamOn(false);
                    cleanup();
                } else if (peerConnection.connectionState === "closed") {
                    setConnectionStatus("disconnected");
                    setIsStreamOn(false);
                    cleanup();
                } else {
                    setConnectionStatus("connecting");
                }
            };
        };

        const addAnswer = async (answer: string) => {
            const parsed = JSON.parse(answer);
            if (!peerConnection.remoteDescription) {
                await peerConnection.setRemoteDescription(parsed);
                setConnectionStatus("connecting");
                setIsStreamOn(true);
            }
        };

        const pollForAnswer = async () => {
            const response = await fetch("https://checkanswer-qaf2yvcrrq-uc.a.run.app", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ code: sessionCode }),
            });

            if (response.status === 204) return false;

            if (response.ok) {
                const data = await response.json();
                console.log("Received answer:", data);
                if (data.answer) {
                    await addAnswer(JSON.stringify(data.answer));
                    if (!statsIntervalRef.current) {
                        statsIntervalRef.current = setInterval(async () => {
                            if (peerConnection.connectionState !== "connected") return;
                            const stats = await peerConnection.getStats();
                            stats.forEach(report => {
                                if (report.type === "candidate-pair" && report.state === "succeeded") {
                                    console.log("✅ ICE Connected:", report);
                                }
                                if (report.type === "outbound-rtp" && report.kind === "video") {
                                    console.log("📤 Video Sent:", {
                                        packetsSent: report.packetsSent,
                                        bytesSent: report.bytesSent,
                                    });
                                }
                            });
                        }, 3000);
                    }
                    return true;
                }
            }
            return false;
        };

        const pollTimer = async () => {
            let backoffDelay = 2000;
            while (pollingActiveRef.current) {
                const gotAnswer = await pollForAnswer();
                if (gotAnswer) break;
                await new Promise((r) => setTimeout(r, backoffDelay));
                backoffDelay = Math.min(backoffDelay * 2, 30000);
            }
        };

        // Main sequence
        (async () => {
            try {
                await init();
                await createOffer();
                await submitOffer();
                await pollTimer();
            } catch (err: any) {
                setError(err.message || "WebRTC sendonly setup error");
                cleanup();
            }
        })();

        // Clean up when component unmounts or stream is stopped
        return cleanup;
    // Only depends on the latest props, and cleanup is always stable
    }, [
        media, sessionCode, isMicOn, isVidOn,
        isFrontCamera, resolution, fps, exposure, cleanup
    ]);

    // --- Replace track is always stable ---
    const replaceTrack = useCallback(async (kind: "video" | "audio", newTrack: MediaStreamTrack | null) => {
        const pc = peerConnectionRef.current;
        if (!pc) {
            console.warn("No PeerConnection to replace track on");
            return;
        }
        const sender = pc.getSenders().find(s => s.track && s.track.kind === kind);
        if (sender) {
            await sender.replaceTrack(newTrack);
            console.log(`[WebRTC] ${kind} track replaced`);
        } else if (newTrack) {
            pc.addTrack(newTrack, media!);
            console.log(`[WebRTC] ${kind} track added (no existing sender)`);
        } else {
            console.warn(`[WebRTC] No ${kind} sender and no track to add`);
        }
    }, [media]);

    // --- Stable stopStream ---
    const stopStream = useCallback(() => {
        cleanup();
    }, [cleanup]);

    // --- Stable toggleStream ---
    const toggleStream = useCallback(() => {
        if (isStreamOn) {
            stopStream();
        } else {
            setConnectionStatus("connecting");
            stopMedia();
            startMedia();
            startStream();
        }
    }, [isStreamOn, stopStream, stopMedia, startMedia, startStream]);

    // --- Only once on mount/unmount ---
    useEffect(() => {
        return cleanup;
    }, [cleanup]);

    return {
        isStreamOn,
        connectionStatus,
        error,
        replaceTrack,
        startStream,
        stopStream,
        toggleStream,
    };
}