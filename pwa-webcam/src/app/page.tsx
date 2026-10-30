"use client";

import { useRouter } from "next/navigation";
import React, { useEffect, useState } from "react";
import CopySessionStats from "@/components/CopySessionStats";
import CodeInput from "@/components/CodeInput";
import { validateCode, warmUpSignaling } from "@/lib/signaling";
import { unlockAudioContext } from "@/lib/audioContext";

export default function Home() {
  const router = useRouter();
  const [code, setCode] = useState(Array(5).fill(""));
  const [streams, setStreams] = useState({ webcam: true, mic: true });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wake the signaling functions (cold starts) while the user types.
  useEffect(() => {
    warmUpSignaling();
  }, []);

  const toggleWebcam = () => {
    setStreams((prev) => ({ ...prev, webcam: !prev.webcam }));
  };

  const toggleMic = () => {
    setStreams((prev) => ({ ...prev, mic: !prev.mic }));
  };

  const handleStartStream = async () => {
    if (isLoading) return;
    // Must run synchronously inside the tap: iOS only lets audio start from a
    // user gesture, and the stream page's mic meter reuses this context.
    unlockAudioContext();
    const joinedCode = code.join("").trim().toUpperCase();

    if (joinedCode.length !== 5) {
      setError("Please enter the 5-character code shown on your computer.");
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      await validateCode(joinedCode);
      router.push(
        `/stream?webcam=${streams.webcam}&mic=${streams.mic}&code=${joinedCode}`
      );
    } catch (err: any) {
      console.error("Error validating code:", err);
      setError(
        err?.status
          ? `${err.message}. Generate a new code on your computer.`
          : "Couldn't reach the server. Check your connection and try again."
      );
      setIsLoading(false);
    }
  };

  return (
    <section className="flex flex-col w-screen items-center">
      <h1 className="my-10 text-5xl" aria-label="PixelStreamer">
        PixelStreamer
      </h1>
      <h2 className="my-5 text-4xl" aria-label="Enter Code">
        Enter Code:
      </h2>
      <CodeInput code={code} setCode={setCode} onSubmit={handleStartStream} />
      {error && (
        <p role="alert" className="w-9/10 text-center text-red-400 text-lg">
          {error}
        </p>
      )}
      <button
        className={`w-9/10 my-5 px-5 py-5 rounded-2xl text-3xl text-center ${
          streams.webcam
            ? "bg-blue-500 text-white hover:bg-blue-700"
            : "bg-white text-blue-500 hover:bg-gray-100"
        }`}
        onClick={toggleWebcam}
        aria-label="Toggle Webcam"
      >
        Stream Webcam
      </button>
      <button
        className={`w-9/10 my-5 px-5 py-5 rounded-2xl text-3xl text-center ${
          streams.mic
            ? "bg-blue-500 text-white hover:bg-blue-700"
            : "bg-white text-blue-500 hover:bg-gray-100"
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
      <CopySessionStats />
    </section>
  );
}
