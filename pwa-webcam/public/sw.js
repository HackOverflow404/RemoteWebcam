
const CACHE_NAME = "pixelstreamer-cache-v1";
const urlsToCache = ["/", "/offline.html"];

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            return cache.addAll(urlsToCache);
        })
    );
});

self.addEventListener("fetch", event => {
    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
    );
});

self.addEventListener('activate', (event) => {
    console.log('Service Worker activating.');
});