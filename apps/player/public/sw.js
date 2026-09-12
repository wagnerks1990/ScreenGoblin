const SHELL_CACHE_PREFIX = "screengoblin-shell-";
const SHELL_CACHE = "__SCREEN_GOBLIN_SHELL_CACHE__";
const SHELL = ["__SCREEN_GOBLIN_SHELL_ASSETS__"];
const SHELL_PATHS = new Set(SHELL);

function isShellRequest(request) {
  if (request.method !== "GET") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.search) return false;
  return SHELL_PATHS.has(url.pathname);
}

function hasExpectedContentType(pathname, response) {
  const contentType = response.headers
    .get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (pathname === "/") return contentType === "text/html";
  if (pathname === "/manifest.webmanifest")
    return (
      contentType === "application/manifest+json" ||
      contentType === "application/json"
    );
  if (pathname.endsWith(".js"))
    return (
      contentType === "text/javascript" ||
      contentType === "application/javascript"
    );
  if (pathname.endsWith(".css")) return contentType === "text/css";
  if (pathname.endsWith(".svg")) return contentType === "image/svg+xml";
  if (pathname.endsWith(".webp")) return contentType === "image/webp";
  if (pathname.endsWith(".png")) return contentType === "image/png";
  if (pathname.endsWith(".woff2")) return contentType === "font/woff2";
  if (pathname.endsWith(".woff")) return contentType === "font/woff";
  return false;
}

function isCacheableShellResponse(request, response) {
  return (
    response.status === 200 &&
    !response.redirected &&
    response.type === "basic" &&
    response.url === request.url &&
    hasExpectedContentType(new URL(request.url).pathname, response)
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      try {
        const entries = await Promise.all(
          SHELL.map(async (path) => {
            const request = new Request(new URL(path, self.location.origin), {
              cache: "reload",
              credentials: "same-origin",
              redirect: "error",
            });
            const response = await fetch(request);
            if (!isCacheableShellResponse(request, response))
              throw new Error(`Invalid shell response for ${path}`);
            return [request, response];
          }),
        );
        await Promise.all(
          entries.map(([request, response]) => cache.put(request, response)),
        );
        await self.skipWaiting();
      } catch (error) {
        await caches.delete(SHELL_CACHE);
        throw error;
      }
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) =>
              name.startsWith(SHELL_CACHE_PREFIX) && name !== SHELL_CACHE,
          )
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  if (!isShellRequest(event.request)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      if (event.request.mode === "navigate") {
        const root = await cache.match("/");
        if (root) return root;
      }
      try {
        // Installed generations are immutable. A network response may keep a
        // cache-evicted client alive, but only the next worker install writes it.
        return await fetch(event.request, { redirect: "error" });
      } catch {
        return new Response("Offline", { status: 503, statusText: "Offline" });
      }
    })(),
  );
});
