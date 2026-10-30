import { useCallback, useEffect, useRef, useState } from "react";

export type MediaState = "on" | "off" | "error";

interface UseMediaStreamOptions {
  initialAudio?: boolean;
  initialVideo?: boolean;
  initialFacingMode?: "user" | "environment";
  fps?: "30" | "60";
  resolution?: "sd" | "hd" | "4k";
}

const DIMS = {
  sd: { width: 640, height: 480 },
  hd: { width: 1280, height: 720 },
  "4k": { width: 3840, height: 2160 },
};

export default function useMediaStream({
  initialAudio = true,
  initialVideo = true,
  initialFacingMode = "user",
  fps = "60",
  resolution = "hd",
}: UseMediaStreamOptions = {}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const requestIdRef = useRef(0);

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isMicOn, setIsMicOn] = useState<MediaState>(initialAudio ? "on" : "off");
  const [isVidOn, setIsVidOn] = useState<MediaState>(initialVideo ? "on" : "off");
  const [isFrontCamera, setIsFrontCamera] = useState(initialFacingMode === "user");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs mirror state so callbacks stay stable and never act on stale values
  // (they're also invoked from WebRTC data-channel handlers).
  const micRef = useRef(isMicOn);
  const vidRef = useRef(isVidOn);
  const frontRef = useRef(isFrontCamera);
  micRef.current = isMicOn;
  vidRef.current = isVidOn;
  frontRef.current = isFrontCamera;

  const videoConstraints = useCallback(
    (front: boolean): MediaTrackConstraints => ({
      facingMode: front ? "user" : "environment",
      frameRate: { ideal: Number(fps) },
      width: { ideal: DIMS[resolution].width },
      height: { ideal: DIMS[resolution].height },
    }),
    [fps, resolution]
  );

  const audioConstraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  const stopAllTracks = (s: MediaStream | null) => {
    s?.getTracks().forEach((track) => track.stop());
  };

  // Always capture both tracks and use track.enabled for on/off, so toggling
  // later never needs a new getUserMedia call or WebRTC renegotiation. If one
  // device is denied/missing, fall back to whatever is available.
  const startInitialStream = useCallback(async () => {
    if (streamRef.current) return;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    const video = videoConstraints(frontRef.current);
    const attempts: MediaStreamConstraints[] = [
      { video, audio: audioConstraints },
      { video, audio: false },
      { video: false, audio: audioConstraints },
    ];
    let mediaStream: MediaStream | null = null;
    let lastErr: any = null;
    for (const constraints of attempts) {
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
        break;
      } catch (err: any) {
        lastErr = err;
        // Only retry with fewer devices for permission/availability errors.
        if (!["NotAllowedError", "NotFoundError", "NotReadableError", "OverconstrainedError"].includes(err?.name)) break;
      }
    }

    // Superseded (StrictMode double-mount, unmount, or stop()) while waiting.
    if (requestId !== requestIdRef.current) {
      stopAllTracks(mediaStream);
      return;
    }
    setLoading(false);

    if (!mediaStream) {
      const denied = lastErr?.name === "NotAllowedError";
      setError(denied
        ? "Camera/microphone access was denied. Allow it in your browser settings and reload."
        : lastErr?.message || "Could not start camera");
      setIsMicOn("error");
      setIsVidOn("error");
      console.error("MediaStream error:", lastErr);
      return;
    }

    const audio = mediaStream.getAudioTracks();
    const videoTracks = mediaStream.getVideoTracks();
    audio.forEach((t) => (t.enabled = micRef.current === "on"));
    videoTracks.forEach((t) => (t.enabled = vidRef.current === "on"));
    setIsMicOn(audio.length ? (micRef.current === "on" ? "on" : "off") : "error");
    setIsVidOn(videoTracks.length ? (vidRef.current === "on" ? "on" : "off") : "error");

    streamRef.current = mediaStream;
    if (videoRef.current) videoRef.current.srcObject = mediaStream;
    setStream(mediaStream);
    setError(null);
  }, [videoConstraints]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleMic = useCallback(() => {
    if (micRef.current === "error") return;
    const next: MediaState = micRef.current === "on" ? "off" : "on";
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = next === "on"));
    micRef.current = next;
    setIsMicOn(next);
  }, []);

  const toggleVid = useCallback(() => {
    if (vidRef.current === "error") return;
    const next: MediaState = vidRef.current === "on" ? "off" : "on";
    streamRef.current?.getVideoTracks().forEach((t) => (t.enabled = next === "on"));
    vidRef.current = next;
    setIsVidOn(next);
  }, []);

  const toggleMedia = useCallback(() => {
    // Both off → turn both on; otherwise turn everything that's on off.
    if (micRef.current !== "on" && vidRef.current !== "on") {
      toggleMic();
      toggleVid();
      return;
    }
    if (micRef.current === "on") toggleMic();
    if (vidRef.current === "on") toggleVid();
  }, [toggleMic, toggleVid]);

  const flipCamera = useCallback(async (): Promise<MediaStreamTrack | null> => {
    const s = streamRef.current;
    if (!s || !s.getVideoTracks().length) return null;

    // Request video only: asking for audio again would steal (and on iOS,
    // mute) the microphone track that is already being streamed.
    const request = async (front: boolean) =>
      (await navigator.mediaDevices.getUserMedia({ video: videoConstraints(front), audio: false }))
        .getVideoTracks()[0];

    // iOS allows only one camera capture at a time, so release the current
    // one before opening the other.
    const oldTracks = s.getVideoTracks();
    oldTracks.forEach((t) => t.stop());

    let front = !frontRef.current;
    let newTrack: MediaStreamTrack | undefined;
    try {
      newTrack = await request(front);
    } catch (err) {
      console.error("flipCamera failed, restoring previous camera:", err);
      front = frontRef.current;
      try { newTrack = await request(front); } catch {}
    }
    if (!newTrack) return null;
    if (streamRef.current !== s) {
      newTrack.stop();
      return null;
    }

    oldTracks.forEach((t) => s.removeTrack(t));
    newTrack.enabled = vidRef.current === "on";
    s.addTrack(newTrack);
    frontRef.current = front;
    setIsFrontCamera(front);
    if (videoRef.current) videoRef.current.srcObject = s;
    return newTrack;
  }, [videoConstraints]);

  const stop = useCallback(() => {
    requestIdRef.current++;
    stopAllTracks(streamRef.current);
    streamRef.current = null;
    setStream(null);
    setLoading(false);
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => () => stop(), [stop]);

  return {
    videoRef,
    stream,
    start: startInitialStream,
    stop,
    toggleMic,
    toggleVid,
    toggleMedia,
    flipCamera,
    isMicOn,
    isVidOn,
    isFrontCamera,
    loading,
    error,
  };
}
