import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { loadPuzzleIndex } from "./load-puzzle-index.ts";

const serviceWorkerSource = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const sampleManifest = readFileSync(new URL("../public/puzzle-index-manifest.json", import.meta.url), "utf8");
const origin = "https://generator.example";

function createOfflineIndexLoop() {
  const listeners = new Map();
  const cacheEntries = new Map();
  const assets = new Map([
    ["/", '<html><link href="/assets/app.css"><script src="/assets/app.js"></script></html>'],
    ["/manifest.webmanifest", "{}"],
    ["/favicon-32.png", "icon"],
    ["/apple-touch-icon.png", "icon"],
    ["/icon-192.png", "icon"],
    ["/icon-512.png", "icon"],
    ["/icon-maskable-512.png", "icon"],
    ["/assets/app.css", "body {}"],
    ["/assets/app.js", "app"],
    ["/puzzle-index.generated-manifest.json", sampleManifest],
    ["/puzzle-index-manifest.json", sampleManifest],
    ["/puzzle-index.jsonl", "sample puzzle"],
    ["/puzzle-index.generated.jsonl.gz", "full puzzle index"],
  ]);
  let online = true;
  let generatedIndexFailures = 0;
  const absoluteUrl = (request) => new URL(typeof request === "string" ? request : request.url, origin).href;
  const cache = {
    put: async (request, response) => cacheEntries.set(absoluteUrl(request), response.clone()),
  };
  const networkFetch = async (request, init = {}) => {
    if (!online) throw new TypeError("Failed to fetch");
    const url = new URL(typeof request === "string" ? request : request.url, origin);
    if (url.pathname === "/puzzle-index.generated.jsonl.gz" && generatedIndexFailures > 0) {
      generatedIndexFailures -= 1;
      throw new TypeError("Failed to fetch");
    }
    const body = assets.get(url.pathname);
    if (body === undefined) return new Response("Not found", { status: 404 });
    return new Response((typeof request === "string" ? init.method : request.method) === "HEAD" ? null : body, { status: 200 });
  };

  runInNewContext(serviceWorkerSource, {
    Request,
    Response,
    URL,
    self: {
      registration: { scope: `${origin}/` },
      location: { origin },
      clients: { claim: async () => {} },
      addEventListener: (type, listener) => listeners.set(type, listener),
      skipWaiting: async () => {},
    },
    caches: {
      open: async () => cache,
      match: async (request) => cacheEntries.get(absoluteUrl(request))?.clone(),
      keys: async () => [],
      delete: async () => true,
    },
    fetch: networkFetch,
  });

  async function install() {
    let installPromise;
    listeners.get("install")({ waitUntil: (promise) => { installPromise = promise; } });
    await installPromise;
  }

  async function controlledFetch(input, init) {
    const request = new Request(new URL(input, origin), init);
    let responsePromise;
    const backgroundTasks = [];
    listeners.get("fetch")({
      request,
      waitUntil: (promise) => backgroundTasks.push(promise),
      respondWith: (promise) => { responsePromise = promise; },
    });
    const response = await responsePromise;
    await Promise.all(backgroundTasks);
    return response;
  }

  return {
    install,
    loadPuzzleIndex: () => loadPuzzleIndex(controlledFetch),
    failNextGeneratedIndexFetch: () => { generatedIndexFailures = 1; },
    goOffline: () => { online = false; },
  };
}

describe("Generator offline index loading", () => {
  it("loads the generated index offline after repeated online opens", async () => {
    const loop = createOfflineIndexLoop();
    await loop.install();
    await loop.loadPuzzleIndex();
    await loop.loadPuzzleIndex();
    await loop.loadPuzzleIndex();
    loop.goOffline();

    await expect(loop.loadPuzzleIndex()).resolves.toMatchObject({ index: "/puzzle-index.generated.jsonl.gz" });
  });

  it("retries caching on an online open when install-time caching failed", async () => {
    const loop = createOfflineIndexLoop();
    loop.failNextGeneratedIndexFetch();
    await loop.install();
    await loop.loadPuzzleIndex();
    loop.goOffline();

    await expect(loop.loadPuzzleIndex()).resolves.toMatchObject({ index: "/puzzle-index.generated.jsonl.gz" });
  });
});
