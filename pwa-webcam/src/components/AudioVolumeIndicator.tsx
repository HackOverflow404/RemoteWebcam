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

  if (!isEnabled) return null;

  return (
    <div
      className="w-full flex items-center justify-center px-5 my-8"
    >
      <Icon icon="mic" />
      <div
        className="relative flex-1 h-2 bg-gray-200 rounded-full overflow-hidden"
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