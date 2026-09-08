const STORAGE_KEY = "webrtc-session";
const MAX_LOGS = 2000;
// Distinguishes page-local session IDs across reloads and tabs.
const pageId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
type SessionLog = {
  pageId: string;
  sessionId: number;
  event: string;
  [key: string]: unknown;
};
let memoryLogs: SessionLog[] = [];

function readLogs(): SessionLog[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (Array.isArray(parsed)) {
      const saved = parsed.filter((entry): entry is SessionLog =>
        entry !== null && typeof entry === "object" &&
        typeof entry.pageId === "string" && typeof entry.sessionId === "number" &&
        typeof entry.event === "string"
      );
      const merged = new Map<string, SessionLog>();
      for (const entry of [...saved, ...memoryLogs]) {
        merged.set(JSON.stringify(entry), entry);
      }
      memoryLogs = [...merged.values()].slice(-MAX_LOGS);
    }
  } catch {
    // Storage can be disabled, full, or contain invalid JSON.
  }
  return memoryLogs;
}

function persistLog(entry: SessionLog) {
  memoryLogs = [...readLogs(), entry].slice(-MAX_LOGS);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(memoryLogs));
  } catch {
    // Keep diagnostics available in memory without interrupting the stream.
  }
}

/** Latest complete record for every retained session, plus its event history. */
export function getSessionStatsSummary(): string {
  const logs = readLogs();
  const sessions = new Map<string, SessionLog>();
  for (const entry of logs) sessions.set(`${entry.pageId}:${entry.sessionId}`, entry);
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    retentionLimit: MAX_LOGS,
    sessions: [...sessions.values()],
    logs,
  }, null, 2);
}

// Counts live for this page load, including across hook remounts.
const counts = { started: 0, connected: 0, ended: 0, active: 0 };

const validSeconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** One session per peer connection; averages weight each stream/poll equally. */
export function startSessionStats(pc: RTCPeerConnection) {
  const sessionId = ++counts.started;
  counts.active++;
  const startedAt = Date.now();
  let ended = false;
  let connected = false;
  let pending = false;
  let statsErrors = 0;
  let rttTotal = 0;
  let rttSamples = 0;
  let jitterTotal = 0;
  let jitterSamples = 0;

  const emit = (event: string, reason?: string) => {
    const entry = {
      pageId,
      event,
      sessionId,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      connected,
      reason,
      averageRttMs: rttSamples ? rttTotal * 1000 / rttSamples : null,
      averageJitterMs: jitterSamples ? jitterTotal * 1000 / jitterSamples : null,
      rttSamples,
      jitterSamples,
      statsErrors,
      counts: { ...counts },
    };
    console.log("[webrtc-session]", JSON.stringify(entry));
    persistLog(entry);
  };

  const sample = async () => {
    if (ended || pending) return;
    pending = true;
    try {
      const report = await pc.getStats();
      if (ended) return; // A closing peer must not update a finished session.
      report.forEach((stat) => {
        if (stat.type === "outbound-rtp" && stat.kind === "video") {
          console.log("[stats] outbound video:", stat.frameWidth, stat.frameHeight);
        }
        // The PWA sends media; RTCP reports describe reception at the remote peer.
        if (stat.type !== "remote-inbound-rtp") return;
        if (validSeconds(stat.roundTripTime)) {
          rttTotal += stat.roundTripTime;
          rttSamples++;
        }
        if (validSeconds(stat.jitter)) {
          jitterTotal += stat.jitter;
          jitterSamples++;
        }
      });
      emit("session-stats");
    } catch {
      if (!ended) {
        statsErrors++;
        emit("stats-error");
      }
    } finally {
      pending = false;
    }
  };

  emit("session-start");
  const timer = setInterval(() => { void sample(); }, 1000);
  void sample();

  return {
    markConnected() {
      if (ended || connected) return;
      connected = true;
      counts.connected++;
      emit("session-connected");
    },
    stop(reason = "cleanup") {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      counts.ended++;
      counts.active--;
      emit("session-end", reason);
    },
  };
}
