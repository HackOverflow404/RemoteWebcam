const CACHE_NAME = "pixelstreamer-v2";
const STATIC_ASSETS = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png",
];

const BYPASS_CACHE_PATTERNS = [
  /\.a\.run\.app/,
  /updateoffer/i,
  /getturncredentials/i,
  /submitoffer/i,
  /validatecode/i,
  /checkoffer/i,
  /generatecode/i,
  /submitanswer/i,
  /deletecode/i,
  /checkanswer/i,
  /firestore\.googleapis\.com/,
  /firebaseio\.com/,
  /googleapis\.com.*firebase/,
  /\/stream/,
  /fonts\.gstatic\.com/,
  /fonts\.googleapis\.com/,
];

// Helper: Should a request bypass the cache?
const shouldBypassCache = (request) =>
  BYPASS_CACHE_PATTERNS.some((pattern) => pattern.test(request.url));

// Install: Cache static assets
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const asset of STATIC_ASSETS) {
        try {
          await cache.add(new Request(asset, { redirect: "follow" }));
        } catch (err) {
          console.warn("[SW] Failed to cache:", asset, err);
        }
      }
    })
  );
});

// Activate: Clean old caches and take control
self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys.map((key) => (key !== CACHE_NAME ? caches.delete(key) : null))
          )
        ),
      self.clients.claim(),
    ])
  );
});

// Fetch: Caching strategy
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  console.log("[SW] Fetching:", req.url, "| bypass?", shouldBypassCache(req));

  event.respondWith(
    (async () => {
      try {
        if (shouldBypassCache(req)) return await fetch(req);

        if (req.mode === "navigate") {
          try {
            const response = await fetch(req, { cache: "no-cache" });
            if (response.ok) return response;
            throw new Error("Bad response");
          } catch {
            return await serveOfflinePage();
          }
        }

        const cached = await caches.match(req);
        if (cached) return cached;

        const netRes = await fetch(req);
        if (
          netRes.ok &&
          req.url.startsWith(self.location.origin) &&
          !shouldBypassCache(req)
        ) {
          try {
            const cache = await caches.open(CACHE_NAME);
            cache.put(req, netRes.clone());
          } catch {}
        }

        return netRes;
      } catch {
        if (req.mode === "navigate") return await serveOfflinePage();
        const fallback = await caches.match(req);
        return (
          fallback ||
          new Response("Resource not available offline", {
            status: 503,
            headers: { "Content-Type": "text/plain" },
          })
        );
      }
    })()
  );
});

// Serve offline fallback HTML page
async function serveOfflinePage() {
  return new Response(
    `<!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <title>You are offline</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <style>
          body {
            margin: 0;
            font-family: "Courier New", Courier, monospace, system-ui, -apple-system, BlinkMacSystemFont;
            background-color: #0a0a0a;
            color: white;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            text-align: center;
            padding: 1.5rem;
            height: 100vh;
            position: fixed;
            inset: 0;
            z-index: 9999;
          }
          h1 {
            font-size: 1.5rem; /* text-2xl */
            font-weight: 700; /* font-bold */
            margin-bottom: 0.5rem; /* mb-2 */
          }
          p {
            margin-bottom: 1rem; /* mb-4 */
          }
          button {
            padding: 0.5rem 1rem; /* py-2 px-4 */
            background-color: #ffffff;
            color: #dc2626;
            border: none;
            border-radius: 0.25rem; /* rounded */
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(0, 0, 0, 0.06); /* shadow */
            transition: background-color 0.3s ease;
            cursor: pointer;
            font-weight: 600;
            font-size: 1rem; /* text-base */
            padding: 0.75rem 1.25rem; /* py-2 px-4 */
          }
          button:hover {
            background-color: #e5e7eb; /* hover:bg-gray-200 */
          }
        </style>
      </head>
      <body>
        <div>
          <h1>Error Occurred</h1>
          <p>Internet connection or server is unreachable.</p>
          <button onclick="window.location.reload()">Retry</button>
        </div>
      </body>
    </html>`,
    {
      status: 200,
      headers: {
        "Content-Type": "text/html",
        "Cache-Control": "no-cache",
      },
    }
  );
}

// Background sync
self.addEventListener("sync", (event) => {
  if (event.tag === "reconnect-streaming") {
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        for (const client of clients) {
          client.postMessage({
            type: "CONNECTION_RESTORED",
            timestamp: Date.now(),
          });
        }
      })
    );
  }
});

// Message handling
self.addEventListener("message", (event) => {
  const { type, state } = event.data || {};
  if (type === "SKIP_WAITING") self.skipWaiting();
  if (type === "STREAMING_STATE_CHANGE") {
    console.log("[SW] Streaming state changed to:", state);
  }
});
