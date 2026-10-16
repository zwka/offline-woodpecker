const CACHE = `woodpecker-generator-v2-${self.registration.scope}`;
const SHELL = ["/", "/manifest.webmanifest"];
const OPTIONAL_FILES = [
  "/puzzle-index.generated-manifest.json",
  "/puzzle-index-manifest.json",
  "/puzzle-index.jsonl",
];

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

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cacheAppAssets(cache);
    await Promise.all(OPTIONAL_FILES.map(async (url) => {
      try {
        const response = await fetch(url);
        if (response.ok) await cache.put(url, response);
      } catch {
        // The generated index is optional in development.
      }
    }));
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
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy)));
      }
      return response;
    } catch {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      if (event.request.destination === "document") return (await caches.match("/")) ?? new Response("Offline", { status: 503 });
      return new Response("Offline", { status: 503 });
    }
  })());
});
