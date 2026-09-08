"use client";

import { useState } from "react";
import { getSessionStatsSummary } from "@/lib/webrtcSessionStats";

export default function CopySessionStats() {
  const [status, setStatus] = useState("");
  const [copying, setCopying] = useState(false);

  const copy = async () => {
    setCopying(true);
    setStatus("");
    try {
      await navigator.clipboard.writeText(getSessionStatsSummary());
      setStatus("Session stats copied.");
    } catch {
      setStatus("Could not copy stats. Allow clipboard access and try again.");
    } finally {
      setCopying(false);
    }
  };

  return (
    <div className="flex flex-col items-center px-4 py-2 text-center" onDoubleClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        onClick={copy}
        disabled={copying}
        className="rounded-lg bg-black/60 px-4 py-2 text-sm text-white hover:bg-black/80 disabled:opacity-50"
      >
        {copying ? "Copying…" : "Copy session stats"}
      </button>
      <p role="status" className="mt-1 text-xs">{status}</p>
    </div>
  );
}
