import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const origin = "https://trainer.example";

function createFetchHandler(networkFetch, cacheMatch) {
  const listeners = new Map();
  runInNewContext(source, {
    URL,
    Response,
    self: {
      registration: { scope: `${origin}/` },
      location: { origin },
      clients: { claim: async () => {} },
      addEventListener: (type, listener) => listeners.set(type, listener),
      skipWaiting: async () => {},
    },
    caches: {
      open: async () => ({ put: async () => {} }),
      match: cacheMatch,
    },
    fetch: networkFetch,
  });
  return listeners.get("fetch");
}

function dispatchFetch(handler, request) {
  let responsePromise;
  handler({
    request,
    waitUntil: () => {},
    respondWith: (response) => { responsePromise = response; },
  });
  return responsePromise;
}

describe("Trainer service worker", () => {
  it("declares browser and Apple touch icons", () => {
    expect(html).toContain('rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"');
    expect(html).toContain('rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png"');

    for (const [name, dimension] of [["favicon-32.png", 32], ["apple-touch-icon.png", 180]]) {
      const icon = readFileSync(new URL(`../public/${name}`, import.meta.url));
      expect(icon.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(icon.readUInt32BE(16)).toBe(dimension);
      expect(icon.readUInt32BE(20)).toBe(dimension);
    }
  });

  it("declares raster icons for Android app surfaces", () => {
    for (const size of ["192x192", "512x512"]) {
      expect(manifest.icons).toContainEqual(expect.objectContaining({ sizes: size, type: "image/png", purpose: "any" }));
      const icon = readFileSync(new URL(`../public/icon-${size.split("x")[0]}.png`, import.meta.url));
      const dimension = Number.parseInt(size, 10);
      expect(icon.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(icon.readUInt32BE(16)).toBe(dimension);
      expect(icon.readUInt32BE(20)).toBe(dimension);
    }

    expect(manifest.icons).toContainEqual(expect.objectContaining({
      src: "/icon-maskable-512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    }));
    const maskable = readFileSync(new URL("../public/icon-maskable-512.png", import.meta.url));
    expect(maskable.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(maskable.readUInt32BE(16)).toBe(512);
    expect(maskable.readUInt32BE(20)).toBe(512);
  });

  it("serves the cached app shell when the stopped tunnel returns an HTTP error", async () => {
    const cachedShell = new Response("cached Trainer shell", { status: 200 });
    const handler = createFetchHandler(
      async () => new Response("Cloudflare Tunnel error", { status: 530 }),
      async (request) => request === "/" || request.url === `${origin}/` ? cachedShell : undefined,
    );

    const response = await dispatchFetch(handler, {
      method: "GET",
      url: `${origin}/`,
      destination: "document",
    });

    await expect(response.text()).resolves.toBe("cached Trainer shell");
  });

  it("serves cached app assets when the stopped tunnel returns an HTTP error", async () => {
    const cachedAsset = new Response("cached Trainer bundle", { status: 200 });
    const assetUrl = `${origin}/assets/index.js`;
    const handler = createFetchHandler(
      async () => new Response("Cloudflare Tunnel error", { status: 530 }),
      async (request) => request.url === assetUrl ? cachedAsset : undefined,
    );

    const response = await dispatchFetch(handler, {
      method: "GET",
      url: assetUrl,
      destination: "script",
    });

    await expect(response.text()).resolves.toBe("cached Trainer bundle");
  });
});
