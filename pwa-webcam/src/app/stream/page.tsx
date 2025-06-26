"use client";

import { useRouter, useSearchParams } from "next/navigation";
import React, { useState, useCallback, useRef, useEffect } from "react";
const AudioVolumeIndicator = React.lazy(() => import("@/components/AudioVolumeIndicator"));
import useMediaStream from "@/components/useMediaStream";
import useWebRTCStream from "@/components/useWebRTCStream";

const icons = {
    fps: { "30": "30fps", "60": "60fps" } as const,
    resolution: { sd: "sd", hd: "hd", "4k": "4k" } as const,
    microphone: { on: "mic", off: "mic_off", error: "mic_alert" } as const,
    video: { on: "videocam", off: "videocam_off", error: "videocam_alert" } as const,
    connection: { connecting: "cloud_sync", connected: "cloud_done", disconnected: "cloud_off", error: "cloud_alert" } as const,
};

function StreamPage() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const sessionCode = searchParams.get("code") || "";
    const initialWebcam = searchParams.get("webcam") === "true";
    const initialMic = searchParams.get("mic") === "true";
    
    const [fps, setFps] = useState<"30" | "60">("60");
    const [resolution, setResolution] = useState<"sd" | "hd" | "4k">("hd");
    const [exposure, setExposure] = useState(0);

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
        fps,
        resolution,
    });
    
    const {
        startStream,
        stopStream,
        toggleStream,
        isStreamOn,
        connectionStatus,
        error: RTCStreamError,
    } = useWebRTCStream({
        videoRef,
        media,
        sessionCode,
        isMicOn,
        isVidOn,
        isFrontCamera,
        resolution,
        fps: Number(fps),
        exposure,
        startMedia,
        stopMedia,
    });
    
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    // TODO: setupWebRTC, renegotiateConnection
    
    useEffect(() => {
        startMedia();
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
    
    useEffect(() => {
        setErrorMessage(RTCStreamError)
    }, [RTCStreamError]);

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

import { Suspense } from "react";

export default function Page() {
  return (
    <Suspense fallback={<div>Loading stream...</div>}>
      <StreamPage />
    </Suspense>
  );
}