"use client";

import { useRouter } from "next/navigation";
import React, { useState } from "react";

const CodeInput = React.lazy(() => import("../../components/CodeInput"));

export default function Home() {
  const [code, setCode] = useState(Array(5).fill(""));
  const [streams, setStreams] = useState({ webcam: true, mic: true });

  const toggleWebcam = () => {
    setStreams((prev) => ({ ...prev, webcam: !prev.webcam }));
  };

  const toggleMic = () => {
    setStreams((prev) => ({ ...prev, mic: !prev.mic }));
  };

  const handleStartStream = () => {
    const joinedCode = code.join("").trim();

    if (joinedCode.length !== 5) {
      alert("Please enter a valid 5-character code.");
      return;
    }

    
  }

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