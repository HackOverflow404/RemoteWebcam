import { useCallback, useEffect, useRef, useState } from "react";

export type MediaState = "on" | "off" | "error";

interface UseMediaStreamOptions {
    initialAudio?: boolean;
    initialVideo?: boolean;
    initialFacingMode?: "user" | "environment";
    fps?: "30" | "60"; // more flexible
    resolution?: "sd" | "hd" | "4k";
}

export default function useMediaStream({
    initialAudio = true,
    initialVideo = true,
    fps = "60",
    resolution = "hd"
}: UseMediaStreamOptions = {}) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [stream, setStream] = useState<MediaStream | null>(null);
    const [isMicOn, setIsMicOn] = useState<MediaState>(initialAudio ? "on" : "off");
    const [isVidOn, setIsVidOn] = useState<MediaState>(initialVideo ? "on" : "off");
    const [isFrontCamera, setIsFrontCamera] = useState(true);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // --- Utility for constraints ---
    const getConstraints = useCallback(
        (videoState: MediaState = isVidOn, audioState: MediaState = isMicOn, facing = isFrontCamera): MediaStreamConstraints => ({
            video: videoState === "on"
                ? {
                    facingMode: facing ? "user" : "environment",
                    frameRate: { ideal: Number(fps) },
                    width: resolution === "sd" ? { ideal: 640 } : resolution === "hd" ? { ideal: 1280 } : { ideal: 3840 },
                    height: resolution === "sd" ? { ideal: 480 } : resolution === "hd" ? { ideal: 720 } : { ideal: 2160 },
                }
                : false,
            audio: audioState === "on"
        }),
        [isVidOn, isMicOn, isFrontCamera, fps, resolution]
    );

    // --- Clean up utility ---
    const stopAllTracks = (s: MediaStream | null) => {
        if (!s) return;
        s.getTracks().forEach(track => track.stop());
    };

    // --- Initial stream setup ---
    const startInitialStream = useCallback(async () => {
        setLoading(true);
        try {
            const mediaStream = await navigator.mediaDevices.getUserMedia(getConstraints());
            if (videoRef.current) videoRef.current.srcObject = mediaStream;
            setStream(mediaStream);
            setIsMicOn(mediaStream.getAudioTracks().length > 0 ? "on" : "off");
            setIsVidOn(mediaStream.getVideoTracks().length > 0 ? "on" : "off");
            setError(null);
        } catch (err: any) {
            setError(err.message || "Media error");
            setIsMicOn("error");
            setIsVidOn("error");
        } finally {
            setLoading(false);
        }
    }, [getConstraints]);

    // --- Replace track (memoized) ---
    const replaceTrack = useCallback(
        async (type: "video" | "audio", state: MediaState, facingOverride?: boolean) => {
            if (!stream) return;

            const newStream = await navigator.mediaDevices.getUserMedia(
                getConstraints(
                    type === "video" ? state : isVidOn,
                    type === "audio" ? state : isMicOn,
                    facingOverride ?? isFrontCamera
                )
            );

            // Stop and remove old tracks of this type
            stream.getTracks().forEach(track => {
                if (track.kind === type) {
                    track.stop();
                    stream.removeTrack(track);
                }
            });

            // Add new track(s) of this type
            const newTracks = type === "video" ? newStream.getVideoTracks() : newStream.getAudioTracks();
            newTracks.forEach(track => stream.addTrack(track));

            if (videoRef.current) videoRef.current.srcObject = stream;

            if (type === "video") setIsVidOn(newTracks.length ? "on" : "off");
            else setIsMicOn(newTracks.length ? "on" : "off");

            // Clean up extra tracks in newStream
            stopAllTracks(newStream);
        },
        [stream, getConstraints, isVidOn, isMicOn, isFrontCamera]
    );

    // --- Toggle mic/video/camera ---
    const toggleMic = useCallback(() => {
        const newState: MediaState = isMicOn === "on" ? "off" : "on";
        replaceTrack("audio", newState);
    }, [isMicOn, replaceTrack]);

    const toggleVideo = useCallback(() => {
        const newState: MediaState = isVidOn === "on" ? "off" : "on";
        replaceTrack("video", newState);
    }, [isVidOn, replaceTrack]);

    const flipCamera = useCallback(() => {
        const newFacing = !isFrontCamera;
        setIsFrontCamera(newFacing);
        replaceTrack("video", "on", newFacing);
    }, [isFrontCamera, replaceTrack]);

    // --- Stop everything ---
    const stop = useCallback(() => {
        stopAllTracks(stream);
        setStream(null);
        if (videoRef.current) videoRef.current.srcObject = null;
        setIsMicOn("off");
        setIsVidOn("off");
    }, [stream]);

    useEffect(() => {
        startInitialStream();
        return () => stop();
    }, []);

    return {
        videoRef,
        stream,
        start: startInitialStream,
        stop,
        toggleMic,
        toggleVideo,
        flipCamera,
        isMicOn,
        isVidOn,
        isFrontCamera,
        loading,
        error,
    };
}
