"use client";

import { useRouter } from "next/navigation";
import { useState, useCallback, useRef, useEffect } from "react";

export default function StreamPage() {
  // Navigation router
  const router = useRouter();
  
  // References for video and audio elements
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataArrayRef = useRef<Uint8Array | null>(null);
  const shouldUpdateRef = useRef(false);
  const tapTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Options to select from
  const options = {
    fps: ["30", "60"] as const,
    resolution: ["sd", "hd", "4k"] as const,
  };

  // States
  const [fps, setFps] = useState<(typeof options.fps)[number]>("60");
  const [exposure, setExposure] = useState(0);
  const [resolution, setResolution] = useState<(typeof options.resolution)[number]>("hd");
  const [isMicOn, setIsMicOn] = useState<boolean | undefined>(false);
  const [isVidOn, setIsVidOn] = useState<boolean | undefined>(false);
  const [isFrontCamera, setIsFrontCamera] = useState<boolean>(true);
  const [isStreamOn, setIsStreamOn] = useState<boolean>(false);
  const [videoStream, setVideoStream] = useState<MediaStream | null>(null);
  const [audioStream, setAudioStream] = useState<MediaStream | null>(null);
  const [volumeLevel, setVolumeLevel] = useState(0);

  // Google material icon names for each setting
  const icons = {
    fps: { "30": "30fps", "60": "60fps" } as const,
    resolution: { sd: "sd", hd: "hd", "4k": "4k" } as const,
    microphone: {on: "mic", off: "mic_off", error: "mic_alert"},
    video: {on: "videocam", off: "videocam_off", error: "videocam_alert"}
  };
  
  // Start video media stream logic
  const startVideo = useCallback(async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
      });
      setVideoStream(mediaStream);
      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
      }
      setIsVidOn((prev) => !prev);
    } catch (error) {
      setIsVidOn((prev) => undefined);
    }
  }, []);
  
  // Start audio media stream logic
  const startMic = useCallback(async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      setAudioStream(mediaStream);
      if (audioRef.current) {
        audioRef.current.srcObject = mediaStream;
      }
      setIsMicOn((prev) => !prev);
      shouldUpdateRef.current = true;
      
      // Web Audio API setup
      if (!audioContextRef.current) {
        const audioContext = new AudioContext();
        audioContextRef.current = audioContext;
        
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyserRef.current = analyser;

        const source = audioContext.createMediaStreamSource(mediaStream);
        source.connect(analyser);

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        dataArrayRef.current = dataArray;

        // Recursive function to update noise level
        const updateVolume = () => {
          if (!shouldUpdateRef.current) {
            return;
          }
          if (analyserRef.current && dataArrayRef.current) {
            analyserRef.current.getByteFrequencyData(dataArrayRef.current);
            const avgVolume = dataArrayRef.current.reduce((a, b) => a + b, 0) / dataArrayRef.current.length;
            setVolumeLevel(avgVolume);
            requestAnimationFrame(updateVolume);
          }
        };
        updateVolume();
      }
    } catch (error) {
      setIsMicOn((prev) => undefined);
    }
  }, []);
  
  // Stop video media stream logic
  const stopVideo = () => {
    if (videoStream) {
      videoStream.getTracks().forEach((track) => track.stop());
      setVideoStream(null);
      setIsVidOn((prev) => !prev);
    }
  };
  
  // Stop audio media stream logic
  const stopMic = () => {
    if (audioStream) {
      audioStream.getTracks().forEach((track) => track.stop());
      setAudioStream(null);
      setIsMicOn((prev) => !prev);
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setVolumeLevel((prev) => 0);
    shouldUpdateRef.current = false;
  };
  
  // Toggle Logic for video
  const toggleVideo = () => {
    if (isVidOn) {
      stopVideo();
    } else {
      startVideo();
    }
  };
  
  // Toggle Logic for microphone
  const toggleMic = () => {
    if (isMicOn) {
      stopMic();
    } else {
      startMic();
    }
  };

  const handleCameraFlip = useCallback(async () => {
    try {
      if (videoStream) {
        videoStream.getTracks().forEach(track => track.stop());
      }
      
      const newMediaStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: isFrontCamera ? "environment" : "user" },
      });

      setVideoStream(newMediaStream);
      setIsFrontCamera(prev => !prev);
  
      if (videoRef.current) {
        videoRef.current.srcObject = newMediaStream;
      }
    } catch (error) {
      console.error("Error flipping camera:", error);
      setIsVidOn(prev => undefined);
    }
  }, [isFrontCamera, videoStream]);
  
  // On page load establish WebRTC connection
  useEffect(() => {
    // TODO: Add WebRTC logic

    // Stop streams on component offload
    return () => {
      stopVideo();
      stopMic();
    };
  }, []);

  // Return to previous page logic
  const handleBack = useCallback(() => {
    // TODO: Add WebRTC disconnection logic here before navigating back
    router.back();
  }, [router]);
  
  return (
    <section className="relative w-screen h-screen">
      {/* Background video */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        webkit-playsinline="true"
        controls={false}
        muted={true}
        onDoubleClick={handleCameraFlip}
        onTouchStart={(e) => {
          if (e.touches.length === 1) {
            if (tapTimeoutRef.current) {
              clearTimeout(tapTimeoutRef.current);
              tapTimeoutRef.current = null;
              handleCameraFlip();
            } else {
              tapTimeoutRef.current = setTimeout(() => {
                tapTimeoutRef.current = null;
              }, 300);
            }
          }
        }}
        style={{ transform: videoStream?.getVideoTracks()[0].getSettings().facingMode == "user" ? "scaleX(-1)" : "scaleX(1)" }}
        className="absolute inset-0 w-full h-full object-cover z-0"
      />

      {/* Audio Stream */}
      <audio ref={audioRef} muted></audio>

      {/* Overlay setting buttons */}
      {/* TODO: Create setting change animation and logic */}
      <div className="flex flex-col items-center inset-0 z-1">
        {/* Top settings */}
        <header className="flex fixed top-0 w-screen py-5 justify-evenly z-1">
          {/* Back Button */}
          <button
            onClick={handleBack}
            className="p-3"
            aria-label="Return"
          >
            <span className="material-symbols-outlined">keyboard_return</span>
          </button>

          {/* FPS Button */}
          <button
            onClick={() => setFps((prev) => (prev === "30" ? "60" : "30"))}
            className="p-3"
            aria-label="Toggle FPS"
          >
            <span className="material-symbols-outlined">{icons.fps[fps]}</span>
          </button>

          {/* Portrait Mode Button */}
          <button
            className="p-3"
            aria-label="Portrait Mode"
          >
            <span className="material-symbols-outlined">frame_person</span>
          </button>

          {/* Exposure Button */}
          <button
            onClick={() => setExposure((prev) => prev + 1)} // TODO: Create exposure logic
            className="p-3"
            aria-label="Adjust Exposure"
          >
            <span className="material-symbols-outlined">exposure</span>
          </button>

          {/* Resolution Button */}
          <button
            onClick={() =>
              setResolution((prev) =>
                prev === "sd" ? "hd" : prev === "hd" ? "4k" : "sd"
              )
            }
            className="p-3"
            aria-label="Toggle Resolution"
          >
            <span className="material-symbols-outlined">{icons.resolution[resolution]}</span>
          </button>
        </header>
        
        {/* Bottom settings */}
        <footer className="flex flex-col fixed bottom-0 w-screen py-10 justify-evenly z-1">
          {/* Noise Level Indicator */}
          <div className="flex flex-row w-full my-10 justify-evenly">
            <span className="text-sm mt-1">Mic Level: {Math.round(volumeLevel)}</span>
            <div className="w-40 h-5 bg-gray-800 rounded-full overflow-hidden mt-2">
              <div
                className="h-full bg-green-400 transition-all"
                style={{ width: `${Math.min(volumeLevel, 100)}%` }}
              ></div>
            </div>
          </div>
           
          <div className="flex flex-row w-full justify-evenly">
            {/* Mic Button */}
            <button
              onClick={() => toggleMic()}
              className="p-3 w-15 h-15 flex items-center justify-center"
              aria-label={isMicOn ? "Mute Microphone" : "Unmute Microphone"}>
              <span className="material-symbols-outlined" style={{fontSize: "40px"}}>
                {isMicOn === undefined ? icons.microphone.error : (isMicOn ? icons.microphone.on : icons.microphone.off)}
              </span>
            </button>
            {/* Stream Button */}
            <button
              onClick={() => setIsStreamOn((prev) => !prev)}
              className="p-3 w-15 h-15 flex items-center justify-center"
              aria-label="Pause and Play">
              <span className="material-symbols-outlined" style={{fontSize: "80px"}}>
                radio_button_checked
              </span>
            </button>
            {/* Video Button */}
            <button
              onClick={() => toggleVideo()}
              className="p-3 w-15 h-15 flex items-center justify-center"
              aria-label={isVidOn ? "Stop Video" : "Start Video"}>
              <span className="material-symbols-outlined" style={{fontSize: "40px"}}>
                {isVidOn === undefined ? icons.video.error : (isVidOn ? icons.video.on : icons.video.off)}
              </span>
            </button>
          </div>
        </footer>
      </div>
    </section>
  );
}