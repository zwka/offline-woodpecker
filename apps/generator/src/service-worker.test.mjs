import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
const origin = "https://generator.example";

function createFetchHandler(networkFetch, cachedEntries) {
  const listeners = new Map();
  runInNewContext(source, {
    Request,
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
      match: async (request) => {
        if (typeof request !== "string" && request.method !== "GET") return undefined;
        return cachedEntries.get(typeof request === "string" ? request : request.url);
      },
    },
    fetch: networkFetch,
  });
  return listeners.get("fetch");
}

function dispatchFetch(handler, request, networkFetch) {
  let responsePromise;
  handler({
    request,
    waitUntil: () => {},
    respondWith: (response) => { responsePromise = response; },
  });
  return responsePromise ?? networkFetch(request);
}

describe("Generator service worker", () => {
  it("declares raster icons for Android app surfaces", () => {
    for (const size of ["192x192", "512x512"]) {
      expect(manifest.icons).toContainEqual(expect.objectContaining({ sizes: size, type: "image/png" }));
      const icon = readFileSync(new URL(`../public/icon-${size.split("x")[0]}.png`, import.meta.url));
      const dimension = Number.parseInt(size, 10);
      expect(icon.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(icon.readUInt32BE(16)).toBe(dimension);
      expect(icon.readUInt32BE(20)).toBe(dimension);
    }
  });

  it("serves cached app files when the stopped tunnel returns an HTTP error", async () => {
    const cachedShell = new Response("cached Generator shell", { status: 200 });
    const handler = createFetchHandler(
      async () => new Response("Cloudflare Tunnel error", { status: 530 }),
      new Map([[`${origin}/`, cachedShell]]),
    );

    const response = await dispatchFetch(handler, {
      method: "GET",
      url: `${origin}/`,
      destination: "document",
    }, async () => new Response("Cloudflare Tunnel error", { status: 530 }));

    await expect(response.text()).resolves.toBe("cached Generator shell");
  });

  it("answers the offline index HEAD check from the cached GET response", async () => {
    const indexUrl = `${origin}/puzzle-index.jsonl`;
    const cachedIndex = new Response("cached puzzle index", { status: 200 });
    const offlineFetch = async () => { throw new TypeError("Failed to fetch"); };
    const handler = createFetchHandler(offlineFetch, new Map([[indexUrl, cachedIndex]]));

    const response = await dispatchFetch(handler, {
      method: "HEAD",
      url: indexUrl,
      destination: "",
    }, offlineFetch);

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("");
  });
});
