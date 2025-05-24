"use client";

import { useRouter } from "next/navigation";
import React, { useState } from "react";

const CodeInput = React.lazy(() => import("../../components/CodeInput"));

export default function Home() {
  const router = useRouter();
  const [code, setCode] = useState(Array(5).fill(""));
  const [streams, setStreams] = useState({ webcam: true, mic: true });
  const [isLoading, setIsLoading] = useState(false);

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

    setIsLoading(true);

    try {
      // Validate the code exists in Firestore via your Firebase Function
      const response = await fetch("https://validatecode-qaf2yvcrrq-uc.a.run.app", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: joinedCode
        })
      });

      const result = await response.json();
      
      if (!(response.ok && result.success && result.valid)) {
        console.error("Error:", result.error);
        alert(`Invalid code: ${result.error}`);
        setIsLoading(false);
        return;
      }

      // Navigate to the stream page with parameters
      router.push(`/stream?code=${joinedCode}&webcam=${streams.webcam}&mic=${streams.mic}`);
      
    } catch (error: any) {
      console.error("Error validating code:", error);
      alert("Failed to validate code: " + error.message);
      setIsLoading(false);
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
      <button 
        onClick={handleStartStream} 
        disabled={isLoading}
        className={`w-9/10 my-5 px-5 py-5 rounded-2xl text-4xl text-center ${
          isLoading ? "bg-gray-400" : "bg-green-600 hover:bg-green-700"
        } text-white`} 
        aria-label="Start Stream"
      >
        {isLoading ? "Connecting..." : "Start Stream"}
      </button>
    </section>
  );
}