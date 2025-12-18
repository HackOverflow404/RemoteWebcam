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
  fps = "60",
  resolution = "hd",
}: UseMediaStreamOptions = {}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isMicOn, setIsMicOn] = useState<MediaState>(
    initialAudio ? "on" : "off"
  );
  const [isVidOn, setIsVidOn] = useState<MediaState>(
    initialVideo ? "on" : "off"
  );
  const [isFrontCamera, setIsFrontCamera] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep streamRef in sync with state
  useEffect(() => {
    streamRef.current = stream;
  }, [stream]);

  // --- Utility for constraints ---
  const getConstraints = useCallback(
    (
      videoState: MediaState = isVidOn,
      audioState: MediaState = isMicOn,
      facing: "user" | "environment" = isFrontCamera ? "user" : "environment"
    ): MediaStreamConstraints => ({
      video:
        videoState === "on"
          ? {
            facingMode: facing,
            frameRate: { ideal: Number(fps) },
            width:
              resolution === "sd"
                ? { ideal: 640 }
                : resolution === "hd"
                  ? { ideal: 1280 }
                  : { ideal: 3840 },
            height:
              resolution === "sd"
                ? { ideal: 480 }
                : resolution === "hd"
                  ? { ideal: 720 }
                  : { ideal: 2160 },
          }
          : false,
      audio: audioState === "on",
    }),
    [isVidOn, isMicOn, isFrontCamera, fps, resolution]
  );


  // --- Clean up utility ---
  const stopAllTracks = useCallback((s: MediaStream | null) => {
    if (!s) return;
    s.getTracks().forEach((track) => track.stop());
  }, []);

  // --- Initial stream setup ---
  const startInitialStream = useCallback(async () => {
    setLoading(true);
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia(
        getConstraints()
      );
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
    async (
      type: "video" | "audio",
      state: MediaState,
      facingOverride?: boolean
    ) => {
      const currentStream = streamRef.current;
      if (!currentStream) return;

      const facingMode: "user" | "environment" =
        facingOverride ?? isFrontCamera ? "user" : "environment";

      const newStream = await navigator.mediaDevices.getUserMedia(
        getConstraints(
          type === "video" ? state : isVidOn,
          type === "audio" ? state : isMicOn,
          facingMode
        )
      );

      // Stop and remove old tracks of this type
      currentStream.getTracks().forEach((track) => {
        if (track.kind === type) {
          track.stop();
          currentStream.removeTrack(track);
        }
      });

      // Add new track(s) of this type
      const newTracks =
        type === "video"
          ? newStream.getVideoTracks()
          : newStream.getAudioTracks();
      newTracks.forEach((track) => currentStream.addTrack(track));

      if (videoRef.current) videoRef.current.srcObject = currentStream;

      if (type === "video") setIsVidOn(newTracks.length ? "on" : "off");
      else setIsMicOn(newTracks.length ? "on" : "off");

      // Clean up extra tracks in newStream
      //   stopAllTracks(newStream);
    },
    [getConstraints, isVidOn, isMicOn, isFrontCamera, stopAllTracks]
  );

  // --- Toggle mic/video/camera (all use stable handlers) ---
  const toggleMic = useCallback(() => {
    const newState: MediaState = isMicOn === "on" ? "off" : "on";
    replaceTrack("audio", newState);
  }, [isMicOn, replaceTrack]);

  const toggleVideo = useCallback(() => {
    const newState: MediaState = isVidOn === "on" ? "off" : "on";
    replaceTrack("video", newState);
  }, [isVidOn, replaceTrack]);

  const flipCamera = useCallback(async (): Promise<MediaStreamTrack | null> => {
    const newFacing = !isFrontCamera;
    setIsFrontCamera(newFacing);

    const newStream = await navigator.mediaDevices.getUserMedia(
      getConstraints("on", isMicOn, newFacing ? "user" : "environment")
    );

    const newVideoTrack = newStream.getVideoTracks()[0];
    if (!newVideoTrack || !streamRef.current) return null;

    // Replace video track in local stream
    streamRef.current.getVideoTracks().forEach((t) => {
      t.stop();
      streamRef.current!.removeTrack(t);
    });
    streamRef.current.addTrack(newVideoTrack);

    if (videoRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }

    return newVideoTrack; // 🔑 IMPORTANT
  }, [getConstraints, isFrontCamera, isMicOn]);

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
    isMicOn,
    isVidOn,
    isFrontCamera,
    loading,
    error,
  };
}
