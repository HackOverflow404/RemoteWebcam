import { useCallback, useEffect, useRef, useState } from "react";

export type MediaState = "on" | "off" | "error";

interface UseMediaStreamOptions {
  initialAudio?: boolean;
  initialVideo?: boolean;
  initialFacingMode?: "user" | "environment";
  fps?: "30" | "60";
  resolution?: "sd" | "hd" | "4k";
}

export default function useMediaStream({ initialAudio = true, initialVideo = true, initialFacingMode = "user", fps = "60", resolution = "hd"}: UseMediaStreamOptions = {}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isMicOn, setIsMicOn] = useState<MediaState>(initialAudio ? "on" : "off");
  const [isVidOn, setIsVidOn] = useState<MediaState>(initialVideo ? "on" : "off");
  const [isFrontCamera, setIsFrontCamera] = useState(initialFacingMode === "user");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getConstraints = useCallback(
    (overrideVideo?: MediaState, overrideAudio?: MediaState, overrideFacing?: boolean): MediaStreamConstraints => {
      const useVid = overrideVideo ?? isVidOn;
      const useMic = overrideAudio ?? isMicOn;
      const useFacing = overrideFacing ?? isFrontCamera;
  
      return {
        video:
          useVid === "on"
            ? {
                facingMode: useFacing ? "user" : "environment",
                frameRate: { ideal: parseInt(fps) },
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
        audio: useMic === "on",
      };
    },
    [isVidOn, isMicOn, isFrontCamera, fps, resolution]
  );
  

  const start = useCallback(
    async (overrideVideo?: MediaState, overrideAudio?: MediaState, overrideFacing?: boolean) => {
      setLoading(true);
      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia(
          getConstraints(overrideVideo, overrideAudio, overrideFacing)
        );
  
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
        }
  
        setStream(mediaStream);
        setIsMicOn(mediaStream.getAudioTracks().length > 0 ? "on" : "off");
        setIsVidOn(mediaStream.getVideoTracks().length > 0 ? "on" : "off");
        setError(null);
      } catch (err: any) {
        console.error("getUserMedia error", err);
        setError(err.message || "Media error");
        setIsMicOn("error");
        setIsVidOn("error");
      } finally {
        setLoading(false);
      }
    },
    [getConstraints]
  );  

  const stop = useCallback(() => {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      setStream(null);
      if (videoRef.current) videoRef.current.srcObject = null;
    }
    setIsMicOn("off");
    setIsVidOn("off");
  }, [stream]);

  const restart = useCallback(
    (overrideVideo?: MediaState, overrideAudio?: MediaState, overrideFacing?: boolean) => {
      stop();
      start(overrideVideo, overrideAudio, overrideFacing);
    },
    [stop, start]
  );  

  const toggleMic = useCallback(() => {
    const newState: MediaState = isMicOn === "on" ? "off" : "on";
    restart(isVidOn, newState);
  }, [isMicOn, isVidOn, restart]);
  
  const toggleVideo = useCallback(() => {
    const newState: MediaState = isVidOn === "on" ? "off" : "on";
    restart(newState, isMicOn);
  }, [isVidOn, isMicOn, restart]);  

  const flipCamera = useCallback(() => {
    const newFacing = !isFrontCamera;
    setIsFrontCamera(newFacing);
    restart(isVidOn, isMicOn, newFacing);
  }, [isVidOn, isMicOn, isFrontCamera, restart]);  

  useEffect(() => {
    start();
    return () => stop();
  }, []);

  return {
    videoRef,
    stream,
    start,
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