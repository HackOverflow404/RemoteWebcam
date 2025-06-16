import { useCallback, useEffect, useRef, useState } from "react";

export type MediaState = "on" | "off" | "error";

interface UseMediaStreamOptions {
    initialAudio?: boolean;
    initialVideo?: boolean;
    initialFacingMode?: "user" | "environment";
    fps?: "30" | "60";
    resolution?: "sd" | "hd" | "4k";
}

export default function useMediaStream({
    initialAudio = true,
    initialVideo = true,
    initialFacingMode = "user",
    fps = "60",
    resolution = "hd"
}: UseMediaStreamOptions = {}) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const [stream, setStream] = useState<MediaStream | null>(null);
    const [isMicOn, setIsMicOn] = useState<MediaState>(initialAudio ? "on" : "off");
    const [isVidOn, setIsVidOn] = useState<MediaState>(initialVideo ? "on" : "off");
    const [isFrontCamera, setIsFrontCamera] = useState(initialFacingMode === "user");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const getConstraints = useCallback(
        (videoState: MediaState = isVidOn, audioState: MediaState = isMicOn, facing = isFrontCamera): MediaStreamConstraints => ({
            video: videoState === "on"
                ? {
                      facingMode: facing ? "user" : "environment",
                      frameRate: { ideal: parseInt(fps) },
                      width: resolution === "sd" ? { ideal: 640 } : resolution === "hd" ? { ideal: 1280 } : { ideal: 3840 },
                      height: resolution === "sd" ? { ideal: 480 } : resolution === "hd" ? { ideal: 720 } : { ideal: 2160 },
                  }
                : false,
            audio: audioState === "on"
        }),
        [isVidOn, isMicOn, isFrontCamera, fps, resolution]
    );

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

    const replaceTrack = async (
        type: "video" | "audio",
        state: MediaState,
        facingOverride?: boolean
    ) => {
        if (!stream) return;

        const newStream = await navigator.mediaDevices.getUserMedia(
            getConstraints(
                type === "video" ? state : isVidOn,
                type === "audio" ? state : isMicOn,
                facingOverride ?? isFrontCamera
            )
        );

        const newTrack = type === "video" ? newStream.getVideoTracks()[0] : newStream.getAudioTracks()[0];
        const senderTrack = stream.getTracks().find(t => t.kind === type);
        if (senderTrack && newTrack) {
            stream.removeTrack(senderTrack);
            senderTrack.stop();
            stream.addTrack(newTrack);
            if (videoRef.current) videoRef.current.srcObject = stream;
        }

        if (type === "video") {
            setIsVidOn(newTrack ? "on" : "off");
        } else {
            setIsMicOn(newTrack ? "on" : "off");
        }
    };

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

    const stop = useCallback(() => {
        stream?.getTracks().forEach(t => t.stop());
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