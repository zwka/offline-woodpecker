const CACHE = `woodpecker-generator-v2-${self.registration.scope}`;
const SHELL = [
  "/",
  "/manifest.webmanifest",
  "/favicon-32.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
];
const OPTIONAL_FILES = [
  "/puzzle-index.generated-manifest.json",
  "/puzzle-index.generated.jsonl.gz",
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

function createHeadResponse(response) {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function generatedIndexHeadResponse(url) {
  const request = new Request(url);
  try {
    const cached = await caches.match(request, { ignoreVary: true });
    if (cached) return createHeadResponse(cached);

    const response = await fetch(request);
    const headResponse = createHeadResponse(response);
    if (!response.ok) return headResponse;
    await caches.open(CACHE).then((cache) => cache.put(request, response));
    return headResponse;
  } catch {
    return new Response("Offline", { status: 503 });
  }
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" && event.request.method !== "HEAD") return;
  if (new URL(event.request.url).origin !== self.location.origin) return;
  const isGeneratedIndexHead = event.request.method === "HEAD"
    && new URL(event.request.url).pathname === "/puzzle-index.generated.jsonl.gz";
  event.respondWith((async () => {
    if (isGeneratedIndexHead) return generatedIndexHeadResponse(event.request.url);

    const cacheRequest = event.request.method === "HEAD"
      ? new Request(event.request.url)
      : event.request;
    const fromCache = async () => {
      const cached = await caches.match(cacheRequest, { ignoreVary: true });
      if (!cached || event.request.method !== "HEAD") return cached;
      return createHeadResponse(cached);
    };

    try {
      const response = await fetch(event.request);
      if (response.ok && event.request.method === "GET") {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy)));
      }
      if (!response.ok) return (await fromCache()) ?? response;
      return response;
    } catch {
      const cached = await fromCache();
      if (cached) return cached;
      if (event.request.destination === "document") return (await caches.match("/")) ?? new Response("Offline", { status: 503 });
      return new Response("Offline", { status: 503 });
    }
  })());
});
