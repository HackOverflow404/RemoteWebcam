// Client for the Firebase signaling functions.

const URLS = {
  validateCode: "https://validatecode-qaf2yvcrrq-uc.a.run.app",
  submitOffer: "https://submitoffer-qaf2yvcrrq-uc.a.run.app",
  checkAnswer: "https://checkanswer-qaf2yvcrrq-uc.a.run.app",
  getTurn: "https://getturncredentials-qaf2yvcrrq-uc.a.run.app",
};

const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

// Server holds checkAnswer open up to this long; older deployments ignore it
// and reply immediately, in which case we fall back to short polling.
const LONG_POLL_MS = 25_000;

export class SignalingError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

async function post(
  url: string,
  body: unknown,
  { timeoutMs = 10_000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function errorMessage(resp: Response, fallback: string) {
  try {
    const data = await resp.json();
    return data.message || data.error || fallback;
  } catch {
    return fallback;
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

/**
 * Each function is its own Cloud Run service and cold-starts independently
 * (1-3 s each). Poke the ones the stream page will need while the user is
 * still typing the code, so they're warm by the time they matter.
 * Invalid bodies are rejected before touching Firestore, so this is cheap.
 */
export function warmUpSignaling() {
  for (const url of [URLS.validateCode, URLS.submitOffer, URLS.checkAnswer]) {
    post(url, {}, { timeoutMs: 15_000 }).catch(() => {});
  }
  void getIceServers();
}

let iceServersPromise: Promise<RTCIceServer[]> | null = null;
let iceServersFetchedAt = 0;
const ICE_CACHE_MS = 60 * 60 * 1000;

/** TURN credentials, fetched once and shared (start it early to hide latency). */
export function getIceServers(): Promise<RTCIceServer[]> {
  if (iceServersPromise && Date.now() - iceServersFetchedAt < ICE_CACHE_MS) {
    return iceServersPromise;
  }
  iceServersFetchedAt = Date.now();
  iceServersPromise = (async () => {
    try {
      const resp = await post(URLS.getTurn, {}, { timeoutMs: 6_000 });
      const raw = await resp.json();
      if (!resp.ok || !Array.isArray(raw) || raw.length === 0) throw new Error("bad response");
      return raw.map((s: { urls?: string | string[]; url?: string; username?: string; credential?: string }) => ({
        urls: s.urls ?? s.url ?? [],
        username: s.username,
        credential: s.credential,
      }));
    } catch (e) {
      console.warn("[signaling] TURN credentials unavailable, using STUN only:", e);
      iceServersPromise = null; // retry next time
      return FALLBACK_ICE_SERVERS;
    }
  })();
  return iceServersPromise;
}

export async function validateCode(code: string): Promise<void> {
  const resp = await post(URLS.validateCode, { code });
  if (resp.ok) {
    const data = await resp.json();
    if (data.valid) return;
  }
  throw new SignalingError(await errorMessage(resp, "Invalid code"), resp.status);
}

export async function submitOffer(code: string, offer: RTCSessionDescriptionInit, signal?: AbortSignal) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await post(URLS.submitOffer, { code, offer: { type: offer.type, sdp: offer.sdp } }, { signal });
      if (resp.ok) return;
      if (resp.status < 500) {
        throw new SignalingError(await errorMessage(resp, "Code rejected"), resp.status);
      }
      lastError = new SignalingError(`Server error (${resp.status})`, resp.status);
    } catch (e) {
      if (e instanceof SignalingError || signal?.aborted) throw e;
      lastError = e;
    }
    await sleep(500 * 2 ** attempt, signal);
  }
  console.error("[signaling] submitOffer failed:", lastError);
  throw new SignalingError("Couldn't reach the server. Check your connection and try again.");
}

/** Wait for the desktop's answer; throws on deadline, deleted code, or abort. */
export async function waitForAnswer(
  code: string,
  { signal, deadlineMs = 45_000 }: { signal?: AbortSignal; deadlineMs?: number } = {}
): Promise<RTCSessionDescriptionInit> {
  const deadline = Date.now() + deadlineMs;
  let backoff = 500;
  while (!signal?.aborted) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const started = Date.now();
    try {
      const waitMs = Math.min(LONG_POLL_MS, remaining);
      const resp = await post(URLS.checkAnswer, { code, waitMs }, { signal, timeoutMs: waitMs + 10_000 });
      if (resp.status === 200) {
        const data = await resp.json();
        if (data.answer?.sdp) return data.answer;
      } else if (resp.status === 404 || resp.status === 410) {
        throw new SignalingError("The desktop app cancelled this code", resp.status);
      } else if (resp.status !== 204) {
        throw new Error(`Server error (${resp.status})`);
      }
      backoff = 500;
      if (Date.now() - started < 1000) await sleep(400, signal); // server didn't long-poll
    } catch (e) {
      if (e instanceof SignalingError || signal?.aborted) throw e;
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, 4000);
    }
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  throw new SignalingError("The desktop app didn't respond. Is PixelStreamer running?");
}
