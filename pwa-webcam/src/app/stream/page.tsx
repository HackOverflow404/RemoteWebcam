"use client";

import { useRouter, useSearchParams } from "next/navigation";
import React, { useState, useCallback, useRef, useEffect } from "react";
const AudioVolumeIndicator = React.lazy(() => import("../../../components/AudioVolumeIndicator"));
import useMediaStream from "../../../components/useMediaStream";

type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

const icons = {
  fps: { "30": "30fps", "60": "60fps" } as const,
  resolution: { sd: "sd", hd: "hd", "4k": "4k" } as const,
  microphone: { on: "mic", off: "mic_off", error: "mic_alert" } as const,
  video: { on: "videocam", off: "videocam_off", error: "videocam_alert" } as const,
  connection: { connecting: "cloud_sync", connected: "cloud_done", disconnected: "cloud_off", error: "cloud_error" } as const,
};

export default function StreamPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionCode = searchParams.get("code") || "";
  const initialWebcam = searchParams.get("webcam") === "true";
  const initialMic = searchParams.get("mic") === "true";

  const {
    videoRef,
    stream: media,
    start: startMedia,
    stop: stopMedia,
    toggleMic,
    toggleVideo,
    flipCamera,
    isMicOn,
    isVidOn,
    isFrontCamera,
    loading: isLoadingMedia,
    error: mediaStreamError,
  } = useMediaStream({
    initialAudio: initialMic,
    initialVideo: initialWebcam,
  });
  
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);

  const [fps, setFps] = useState<"30" | "60">("60");
  const [resolution, setResolution] = useState<"sd" | "hd" | "4k">("hd");
  const [exposure, setExposure] = useState(0);
  const [isStreamOn, setIsStreamOn] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionState>("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // TODO: setupWebRTC, renegotiateConnection, toggleStream, handBack, toggleVideo, toggleMic, handleCameraFlip
  
  useEffect(() => {
    if (!isLoadingMedia && media) {
      startStream();
    }
    
    return (() => {
      stopStream();
      stopMedia()
    })
  }, []);
  
  useEffect(() => {
    setErrorMessage(mediaStreamError)
  }, [mediaStreamError]);

  const startStream = () => {
    const peerConnection = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });
    peerConnectionRef.current = peerConnection;
    let sdpOffer: RTCSessionDescription | null = null;
    let backoffDelay = 2000;
  
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
      if (!media) {
        console.error("No media stream available");
        setErrorMessage("No media stream available");
        return;
      }
  
      media.getTracks().forEach((track) => {
        peerConnection.addTransceiver(track.kind, {
          direction: "sendonly",
          streams: [media],
        });
      });
    };
  
    const createOffer = async () => {
      peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          console.log("ICE candidate:", event.candidate);
        }
      };

      if (!media || media.getTracks().length === 0) {
        console.error("No media tracks to offer. Did startMedia() complete?");
        return;
      }      
  
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      await waitForIceGathering();
  
      sdpOffer = peerConnection.localDescription;
      console.log("SDP offer created:", sdpOffer);
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

      console.log("Offer submitted:", sdpOffer);
      console.log("Response:", response);
  
      if (!response.ok) {
        throw new Error("Failed to submit offer");
      } else {
        console.log("✅ Offer submitted successfully");
      }
    };
  
    const addAnswer = async (answer: string) => {
      const parsed = JSON.parse(answer);
      if (!peerConnection.currentRemoteDescription) {
        await peerConnection.setRemoteDescription(parsed);
        console.log("✅ Remote SDP answer set");
        setConnectionStatus("connected");
        setIsStreamOn(true);
      }
    };
  
    const pollForAnswer = async () => {
      const response = await fetch("https://checkanswer-qaf2yvcrrq-uc.a.run.app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: sessionCode }),
      });
  
      if (response.ok) {
        const data = await response.json();
        if (data.answer) {
          await addAnswer(JSON.stringify(data.answer));
          return true;
        }
      }
      return false;
    };
  
    const pollTimer = async () => {
      while (true) {
        const gotAnswer = await pollForAnswer();
        if (gotAnswer) break;
  
        await new Promise((r) => setTimeout(r, backoffDelay));
        backoffDelay = Math.min(backoffDelay * 2, 30000);
      }
    };
  
    (async () => {
      try {
        await init();
        await createOffer();
        await submitOffer();
        await pollTimer();
      } catch (err) {
        console.error("WebRTC sendonly setup error:", err);
      }
    })();
  };

  const stopStream = useCallback(() => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
  
    if (media) {
      stopMedia();
    }
  
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  
    setIsStreamOn(false);
    setConnectionStatus("disconnected");
  }, [media, peerConnectionRef, videoRef, setIsStreamOn, setConnectionStatus]);

  const toggleStream = useCallback(() => {
    if (isStreamOn) {
      stopStream();
    } else {
      setConnectionStatus("connecting");
      stopMedia();
      startMedia();
      startStream();
    }
  }, [isStreamOn, isVidOn, isMicOn, stopStream, setConnectionStatus, startMedia, startStream]);

  const handleBack = useCallback(() => {
    stopStream();
    router.push("/");
  }, [stopStream, router]);
  
  return (
    <section className="relative w-screen h-screen">
      {isLoadingMedia && (
        <div className="absolute inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50">
          <div className="text-white text-2xl">Loading Media...</div>
        </div>
      )}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        controls={false}
        onDoubleClick={flipCamera}
        style={{ transform: isFrontCamera ? "scaleX(-1)" : "scaleX(1)", transition: "opacity 0.3s ease" }}
        className="absolute inset-0 w-full h-full object-cover z-0"
      />

      {errorMessage && (
        <div className="absolute top-24 left-0 right-0 flex justify-center animate-pulse z-20">
          <div className="bg-red-500 text-white px-4 py-2 rounded-md flex items-center">
            <span>{errorMessage}</span>
            <button className="ml-2" onClick={() => setErrorMessage(null)}>
              ✕
            </button>
          </div>
        </div>
      )}

      <div className={`absolute top-16 right-4 flex items-center ${connectionStatus === "connected" ? "text-green-500" : connectionStatus === "connecting" ? "text-yellow-500" : connectionStatus === "disconnected" ? "text-gray-500" : "text-red-500"}`}>
        <span className="material-symbols-outlined">{icons.connection[connectionStatus]}</span>
        <span className="ml-2">{connectionStatus.charAt(0).toUpperCase() + connectionStatus.slice(1)}</span>
      </div>

      {sessionCode && (
        <div className="absolute top-16 left-4 bg-black bg-opacity-50 text-white px-3 py-1 rounded-md">
          Code: {sessionCode}
        </div>
      )}
      {/* Overlay setting buttons */}
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
            onClick={() => {
              setFps((prev) => (prev === "30" ? "60" : "30"));
              if (isVidOn && media) {
                // Restart video with new FPS
                setTimeout(toggleVideo, 100);
              }
            }}
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
            onClick={() => setExposure((prev) => (prev + 1) % 3)}
            className="p-3"
            aria-label="Adjust Exposure"
          >
            <span className="material-symbols-outlined">exposure</span>
          </button>
          {/* Resolution Button */}
          <button
            onClick={() => {
              setResolution((prev) =>
                prev === "sd" ? "hd" : prev === "hd" ? "4k" : "sd"
              );
              if (isVidOn && media) {
                // Restart video with new resolution
                setTimeout(toggleVideo, 100);
              }
            }}
            className="p-3"
            aria-label="Toggle Resolution"
          >
            <span className="material-symbols-outlined">{icons.resolution[resolution]}</span>
          </button>
        </header>      
        {/* Bottom settings */}
        <footer className="flex flex-col fixed bottom-0 w-screen py-10 justify-evenly z-1">
          {/* Noise Level Indicator */}
          {isMicOn === "on" && media && media.getAudioTracks().length > 0 && (
              <React.Suspense fallback={<div>Loading Mic Volume...</div>}>
                <AudioVolumeIndicator isEnabled={true} mediaStream={media} />
              </React.Suspense>
            )}  
          <div className="flex flex-row w-full justify-evenly">
            {/* Mic Button */}
            <button
              onClick={toggleMic}
              className="p-3 w-15 h-15 flex items-center justify-center"
              aria-label={isMicOn ? "Mute Microphone" : "Unmute Microphone"}>
              <span className="material-symbols-outlined" style={{fontSize: "40px"}}>
                {icons.microphone[isMicOn]}
              </span>
            </button>          
            {/* Stream Button */}
            <button
              onClick={toggleStream}
              className={`p-3 w-15 h-15 flex items-center justify-center ${
                isStreamOn ? 'text-red-500' : 'text-green-500'
              }`}
              aria-label={isStreamOn ? "Stop Streaming" : "Start Streaming"}>
              <span className="material-symbols-outlined" style={{fontSize: "80px"}}>
                {isStreamOn ? "radio_button_checked" : "radio_button_unchecked"}
              </span>
            </button>          
            {/* Video Button */}
            <button
              onClick={toggleVideo}
              className="p-3 w-15 h-15 flex items-center justify-center"
              aria-label={isVidOn ? "Stop Video" : "Start Video"}>
              <span className="material-symbols-outlined" style={{fontSize: "40px"}}>
                {icons.video[isVidOn]}
              </span>
            </button>
          </div>
        </footer>
      </div>
    </section>
  );
}