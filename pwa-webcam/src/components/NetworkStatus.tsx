'use client';
import { useEffect, useState } from 'react';

export default function NetworkStatus() {
  const [isOnline, setIsOnline] = useState(true);
  const [showOverlay, setShowOverlay] = useState(false);

  useEffect(() => {
    const updateStatus = () => {
      const online = navigator.onLine;
      setIsOnline(online);
      setShowOverlay(!online);
    };

    // Initial check
    updateStatus();

    // Listen for online/offline changes
    window.addEventListener('online', updateStatus);
    window.addEventListener('offline', updateStatus);

    return () => {
      window.removeEventListener('online', updateStatus);
      window.removeEventListener('offline', updateStatus);
    };
  }, []);

  const handleRetry = () => {
    // Recheck network status
    if (navigator.onLine) {
      setIsOnline(true);
      setShowOverlay(false);
    }
  };

  if (!showOverlay) return null;

  return (
    <div className="fixed inset-0 z-50 bg-[#0a0a0a] text-white flex flex-col items-center justify-center text-center p-6">
      <h1 className="text-2xl font-bold mb-2">You are offline</h1>
      <p className="mb-4">PixelStreamer requires an internet connection to function.</p>
      <button
        onClick={handleRetry}
        className="px-4 py-2 bg-white text-red-600 rounded font-semibold shadow hover:bg-gray-200 transition"
      >
        Retry
      </button>
    </div>
  );
}