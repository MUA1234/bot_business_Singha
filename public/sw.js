/**
 * Singha Central service worker (MOB-002).
 *
 * Offline-safe behaviour:
 *   - Static shell assets are cached on install so the app opens on poor/no network.
 *   - Navigation requests are served cache-first with a network fallback, so a weak
 *     connection never blocks the shell.
 *   - API/data requests are always network-first; if the network fails, a safe
 *     synthetic 503 response is returned. The SW NEVER fabricates or replays a
 *     durable write, and never caches POST/PUT/DELETE/PATCH bodies.
 */

const SHELL_CACHE = "singha-shell-v1";
const STATIC_CACHE = "singha-static-v1";

const SHELL_URLS = ["/", "/login", "/app"];

const STATIC_ASSET_PATTERNS = [
  /\.(?:js|css|svg|png|jpg|jpeg|webp|ico|woff2?|ttf)$/,
  /\/_next\/static\//,
];

const isStaticAsset = (url) => STATIC_ASSET_PATTERNS.some((re) => re.test(url));

const isNavigation = (request) => request.mode === "navigate";

const isApiOrData = (request) => {
  const url = new URL(request.url);
  return url.pathname.startsWith("/api/") || url.pathname.startsWith("/app/");
};

const isWrite = (request) =>
  ["POST", "PUT", "DELETE", "PATCH"].includes(request.method);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== STATIC_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Same-origin only.
  if (url.origin !== self.location.origin) return;

  // Writes must always reach the network. Never cache or replay.
  if (isWrite(request)) return; // writes pass through

  // API/data reads: network-first; fail safely if offline.
  if (isApiOrData(request)) {
    event.respondWith(
      fetch(request)
        .then((response) => response)
        .catch(() => {
          return new Response(
            JSON.stringify({ ok: false, error: "offline", retryable: true }),
            {
              status: 503,
              statusText: "Service Unavailable",
              headers: { "Content-Type": "application/json" },
            },
          );
        }),
    );
    return;
  }

  // Static assets: cache-first, network fallback, then cache the fresh copy.
  if (isStaticAsset(request.url)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request)
          .then((response) => {
            const clone = response.clone();
            caches.open(STATIC_CACHE).then((cache) => cache.put(request, clone));
            return response;
          })
          .catch(() => {
            // A failed static fetch is non-fatal; the shell can still render.
            return new Response("", { status: 204 });
          });
      }),
    );
    return;
  }

  // Navigation: serve the cached shell; update from network in the background.
  if (isNavigation(request)) {
    event.respondWith(
      caches.match("/app").then((cached) => {
        const network = fetch(request)
          .then((response) => {
            const clone = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put("/app", clone));
            return response;
          })
          .catch(() => cached);
        return cached || network;
      }),
    );
  }
});
