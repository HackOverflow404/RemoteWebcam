import { useEffect, useState } from "react";

import {
  createSoundDetector,
  Icon,
  useCallStateHooks,
} from "@stream-io/video-react-sdk";

export default function AudioVolumeIndicator({ isEnabled, mediaStream }: { isEnabled: boolean; mediaStream: MediaStream | null }) {
  const [audioLevel, setAudioLevel] = useState(0);

  useEffect(() => {
    if (!isEnabled || !mediaStream) return;

    const disposeSoundDetector = createSoundDetector(
      mediaStream,
      ({ audioLevel: al }) => setAudioLevel(al),
      { detectionFrequencyInMs: 80, destroyStreamOnStop: false },
    );

    return () => {
      disposeSoundDetector().catch(console.error);
    };
  }, [isEnabled, mediaStream]);

  useEffect(() => {
    console.log(`Audio level is ${audioLevel}`);
  }, [audioLevel])

  if (!isEnabled) return null;

  return (
    <div
      style={{
        width: "100%",
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        padding: "0 1.25rem 1rem",
      }}
    >
      <Icon icon="mic" />
      <div
        style={{
          flex: "1",
          background: "#fff",
          height: "5px",
          borderRadius: "4px",
        }}
      >
        <div
          style={{
            transform: `scaleX(${audioLevel / 100})`,
            transformOrigin: "left center",
            width: "100%",
            height: "100%",
          }}
          className="bg-blue-500"
        />
      </div>
    </div>
  );
};