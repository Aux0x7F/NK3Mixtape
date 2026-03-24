const CACHE_NAME = "nk3-shell-v18";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./styles/styles.css",
  "./styles/fonts/bowlby-one-sc-latin-400.woff2",
  "./styles/fonts/epilogue-latin-var.woff2",
  "./styles/fonts/ibm-plex-mono-latin-400.woff2",
  "./styles/fonts/ibm-plex-mono-latin-600.woff2",
  "./styles/fonts/teko-latin-var.woff2",
  "./app.js",
  "./shared-cache-worker.js",
  "./vendor/event-tools.bundle.js",
  "./vendor/event-tools-shim.js",
  "./assets/nk3-favicon.ico",
  "./assets/nk3-icon-192.png",
  "./assets/nk3-icon-512.png",
  "./assets/nk3-logo-stacked.png",
  "./assets/nk3-paper-v3.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
  })());
});

self.addEventListener("message", (event) => {
  const msg = event?.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req));
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const fresh = await fetch(req);
    cache.put(req, fresh.clone()).catch(() => {});
    return fresh;
  } catch {
    return (await cache.match(req)) || cache.match("./index.html");
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  const network = fetch(req).then((res) => {
    cache.put(req, res.clone()).catch(() => {});
    return res;
  }).catch(() => null);
  return cached || (await network) || new Response("", { status: 504 });
}
