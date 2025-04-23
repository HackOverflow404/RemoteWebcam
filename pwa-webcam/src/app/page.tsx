"use client";

import { useRouter } from "next/navigation";
import React, { useState } from "react";

const CodeInput = React.lazy(() => import("../../components/CodeInput"));

export default function Home() {
  const [code, setCode] = useState(Array(5).fill(""));
  const [streams, setStreams] = useState({ webcam: true, mic: true });
  const servers = {
    iceServers: [
      {
        urls: ['stun:stun1.1.google.com:19302', 'stun:stun2.1.google.com:19302']
      }
    ]
  };

  const toggleWebcam = () => {
    setStreams((prev) => ({ ...prev, webcam: !prev.webcam }));
  };

  const toggleMic = () => {
    setStreams((prev) => ({ ...prev, mic: !prev.mic }));
  };

  const handleStartStream = async () => {
    const joinedCode = code.join("").trim().toUpperCase();

    if (joinedCode.length !== 5) {
      alert("Please enter a valid 5-character code.");
      return;
    }

    const peer = new RTCPeerConnection(servers);
    const candidates: RTCIceCandidateInit[] = [];

    try {
      const constraints: MediaStreamConstraints = {
        video: streams.webcam,
        audio: streams.mic,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));

      peer.onicecandidate = (event) => {
        if (event.candidate) {
          candidates.push(event.candidate.toJSON());
        }
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);

      // Wait until ICE gathering is complete
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 3000);
        peer.onicegatheringstatechange = () => {
          if (peer.iceGatheringState === "complete") {
            clearTimeout(timeout);
            resolve();
          }
        };
      });

      // Send to Firebase Function
      const response = await fetch("https://retrievecode-qaf2yvcrrq-uc.a.run.app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: joinedCode,
          offer,
          candidates,
          metadata: {
            mic: streams.mic,
            webcam: streams.webcam,
            platform: "mobile",
          }
        })
      });

      const result = await response.json();
      if (!response.ok) {
        console.error("Error:", result.error);
        alert(`Failed to start stream: ${result.error}`);
        return;
      }

      console.log("Sent offer & candidates successfully!", result);
    } catch (error: any) {
      console.error("Error during stream setup:", error);
      alert("Failed to start stream: " + error.message);
    }
  };

  return (
    <section className="flex flex-col w-screen items-center">
      <h1 className="my-10 text-5xl" aria-label="PixelStream">PixelStream</h1>
      <h2 className="my-5 text-4xl" aria-label="Enter Code">Enter Code:</h2>
      <React.Suspense fallback={<div>Loading Code Input...</div>}>
        <CodeInput code={code} setCode={setCode} />
      </React.Suspense>
      <button
        className={`w-9/10 my-5 px-5 py-5 rounded-2xl text-4xl text-center ${streams.webcam ? 
          "bg-blue-500 text-white hover:bg-blue-700" : "bg-white text-blue-500 hover:bg-gray-100"
        }`}
        onClick={toggleWebcam}
        aria-label="Toggle Webcam"
      >
        Stream Webcam
      </button>
      <button
        className={`w-9/10 my-5 px-5 py-5 rounded-2xl text-4xl text-center ${streams.mic ? 
          "bg-blue-500 text-white hover:bg-blue-700" : "bg-white text-blue-500 hover:bg-gray-100"
        }`}
        onClick={toggleMic}
        aria-label="Toggle Microphone"
      >
        Stream Microphone
      </button>
      <button onClick={handleStartStream} className="w-9/10 my-5 px-5 py-5 rounded-2xl text-4xl text-center bg-green-600 text-white hover:bg-green-700" aria-label="Start Stream">
        Start Stream
      </button>
    </section>
  );
}