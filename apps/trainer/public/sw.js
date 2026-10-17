const CACHE = `woodpecker-trainer-v2-${self.registration.scope}`;
const SHELL = ["/", "/manifest.webmanifest", "/demo-set.json", "/icon.svg", "/icon-192.png", "/icon-512.png"];

async function cacheAppAssets(cache) {
  const shell = await fetch("/");
  const html = await shell.clone().text();
  const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((url) => url.startsWith("/"));
  await Promise.all([...new Set([...SHELL, ...assets])].map(async (url) => {
    try {
      const response = await fetch(url);
      if (response.ok) await cache.put(url, response);
    } catch {
      // A local optional asset should not prevent the app shell from installing.
    }
  }));
}

async function cachedResponseFor(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  if (request.destination === "document") return caches.match("/");
  return undefined;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cacheAppAssets(cache);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  if (new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (!response.ok) return (await cachedResponseFor(event.request)) ?? response;
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy)));
      return response;
    } catch {
      const cached = await cachedResponseFor(event.request);
      if (cached) return cached;
      return new Response("Offline", { status: 503 });
    }
  })());
});
