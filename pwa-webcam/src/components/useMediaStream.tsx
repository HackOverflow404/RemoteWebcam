import { useCallback, useEffect, useRef, useState } from "react";

export type MediaState = "on" | "off" | "error";

interface UseMediaStreamOptions {
    initialAudio?: boolean;
    initialVideo?: boolean;
    initialFacingMode?: "user" | "environment";
    fps?: "30" | "60";
    resolution?: "sd" | "hd" | "4k";
}

interface UpdateConstraintsOptions {
    fps?: "30" | "60";
    resolution?: "sd" | "hd" | "4k";
    facingMode?: "user" | "environment";
    exposure?: number;
}

export default function useMediaStream({
    initialAudio = true,
    initialVideo = true,
    fps = "60",
    resolution = "hd"
}: UseMediaStreamOptions = {}) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);

    const [stream, setStream] = useState<MediaStream | null>(null);
    const [isMicOn, setIsMicOn] = useState<MediaState>(initialAudio ? "on" : "off");
    const [isVidOn, setIsVidOn] = useState<MediaState>(initialVideo ? "on" : "off");
    const [isFrontCamera, setIsFrontCamera] = useState(true);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [fpsState, setFpsState] = useState<"30" | "60">(fps);
    const [resolutionState, setResolutionState] = useState<"sd" | "hd" | "4k">(resolution);
    const [facingModeState, setFacingModeState] = useState<"user" | "environment">("user");

    // Keep streamRef in sync with state
    useEffect(() => {
        streamRef.current = stream;
    }, [stream]);

    // --- Utility for constraints ---
    const getConstraints = useCallback(
        (
            videoState: MediaState = isVidOn,
            audioState: MediaState = isMicOn,
            facing = facingModeState
        ): MediaStreamConstraints => ({
            video: videoState === "on"
                ? {
                    facingMode: facing,
                    frameRate: { ideal: Number(fpsState) },
                    width: resolutionState === "sd" ? { ideal: 640 } : resolutionState === "hd" ? { ideal: 1280 } : { ideal: 3840 },
                    height: resolutionState === "sd" ? { ideal: 480 } : resolutionState === "hd" ? { ideal: 720 } : { ideal: 2160 },
                }
                : false,
            audio: audioState === "on"
        }),
        [isVidOn, isMicOn, facingModeState, fpsState, resolutionState]
    );

    // --- Clean up utility ---
    const stopAllTracks = useCallback((s: MediaStream | null) => {
        if (!s) return;
        s.getTracks().forEach(track => track.stop());
    }, []);

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
            console.error("MediaStream error:", err);
        } finally {
            setLoading(false);
        }
    }, [getConstraints]);

    // --- Replace track (memoized, always uses ref) ---
    const replaceTrack = useCallback(
        async (type: "video" | "audio", state: MediaState, facingOverride?: boolean) => {
            const currentStream = streamRef.current;
            if (!currentStream) return;

            const facingMode: "user" | "environment" =
                (facingOverride ?? isFrontCamera) ? "user" : "environment";

            const newStream = await navigator.mediaDevices.getUserMedia(
                getConstraints(
                    type === "video" ? state : isVidOn,
                    type === "audio" ? state : isMicOn,
                    facingMode
                )
            );

            // Stop and remove old tracks of this type
            currentStream.getTracks().forEach(track => {
                if (track.kind === type) {
                    track.stop();
                    currentStream.removeTrack(track);
                }
            });

            // Add new track(s) of this type
            const newTracks = type === "video" ? newStream.getVideoTracks() : newStream.getAudioTracks();
            newTracks.forEach(track => currentStream.addTrack(track));

            if (videoRef.current) videoRef.current.srcObject = currentStream;

            if (type === "video") setIsVidOn(newTracks.length ? "on" : "off");
            else setIsMicOn(newTracks.length ? "on" : "off");

            // Clean up extra tracks in newStream
            stopAllTracks(newStream);
        },
        [getConstraints, isVidOn, isMicOn, isFrontCamera, stopAllTracks]
    );

    const updateConstraints = useCallback(async (opts: UpdateConstraintsOptions) => {
        if (opts.fps) setFpsState(opts.fps);
        if (opts.resolution) setResolutionState(opts.resolution);
        if (opts.facingMode) setFacingModeState(opts.facingMode);

        const newConstraints = getConstraints(
            "on",
            isMicOn,
            opts.facingMode ?? facingModeState
        );

        try {
            const newStream = await navigator.mediaDevices.getUserMedia(newConstraints);
            const currentStream = streamRef.current;

            if (currentStream) {
                // Remove old video tracks
                currentStream.getVideoTracks().forEach(track => {
                    track.stop();
                    currentStream.removeTrack(track);
                });
                // Add new video track(s)
                newStream.getVideoTracks().forEach(track => currentStream.addTrack(track));
                if (videoRef.current) videoRef.current.srcObject = currentStream;
                setIsVidOn(newStream.getVideoTracks().length ? "on" : "off");
            } else {
                setStream(newStream);
                if (videoRef.current) videoRef.current.srcObject = newStream;
                setIsVidOn(newStream.getVideoTracks().length ? "on" : "off");
            }

            // Clean up unused tracks
            newStream.getAudioTracks().forEach(track => track.stop());

            setError(null);
        } catch (err: any) {
            setError(err.message || "Failed to update constraints");
            setIsVidOn("error");
        }
    }, [getConstraints, facingModeState, isMicOn]);

    // --- Toggle mic/video/camera (all use stable handlers) ---
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

    // --- Stop everything (always uses ref) ---
    const stop = useCallback(() => {
        stopAllTracks(streamRef.current);
        setStream(null);
        if (videoRef.current) videoRef.current.srcObject = null;
        setIsMicOn("off");
        setIsVidOn("off");
    }, [stopAllTracks]);

    // --- Initial mount/unmount only: handlers now stable, so no deps needed ---
    useEffect(() => {
        // startInitialStream();
        return () => stop();
    }, []); // safe

    return {
        videoRef,
        stream,
        start: startInitialStream,
        stop,
        toggleMic,
        toggleVideo,
        flipCamera,
        updateConstraints,
        isMicOn,
        isVidOn,
        isFrontCamera,
        loading,
        error,
    };
}