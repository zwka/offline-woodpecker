import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const chromePath = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const cloudflaredPath = process.env.CLOUDFLARED_BIN ?? "cloudflared";
const apps = ["generator", "trainer"];
const runMode = process.argv.includes("--dev-offline") ? "dev" : "preview";

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function spawnTracked(command, args, options) {
  const child = spawn(command, args, options);
  child.spawnError = undefined;
  child.once("error", (error) => { child.spawnError = error; });
  return child;
}

function stopProcess(child) {
  if (!child || child.exitCode !== null || child.pid === undefined) return Promise.resolve();
  return new Promise((resolveStop) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolveStop();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}

async function startPreview(app) {
  let preview;
  let tunnel;
  try {
    const port = await freePort();
    const vite = resolve(root, "node_modules/vite/bin/vite.js");
    const command = runMode === "dev" ? ["--host"] : ["preview", "--host"];
    preview = spawnTracked(process.execPath, [vite, ...command, "127.0.0.1", "--port", String(port), "--strictPort"], {
      cwd: resolve(root, "apps", app),
      stdio: "ignore",
    });
    const localUrl = `http://127.0.0.1:${port}`;
    await waitFor(async () => {
      if (preview.spawnError) throw preview.spawnError;
      if (preview.exitCode !== null) throw new Error(`${app} Vite server exited with code ${preview.exitCode}`);
      try {
        const response = await fetch(localUrl);
        return response.ok;
      } catch {
        return undefined;
      }
    }, `${app} ${runMode === "dev" ? "development server" : "production preview"}`);

    let tunnelOutput = "";
    tunnel = spawnTracked(cloudflaredPath, ["tunnel", "--url", localUrl], { stdio: ["ignore", "pipe", "pipe"] });
    tunnel.stdout.setEncoding("utf8").on("data", (chunk) => { tunnelOutput += chunk; });
    tunnel.stderr.setEncoding("utf8").on("data", (chunk) => { tunnelOutput += chunk; });
    const origin = await waitFor(() => {
      if (tunnel.spawnError) throw tunnel.spawnError;
      if (tunnel.exitCode !== null) throw new Error(`Cloudflare Quick Tunnel exited with code ${tunnel.exitCode}`);
      return tunnelOutput.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
    }, `${app} HTTPS tunnel`);

    return { app, origin, processes: [preview, tunnel] };
  } catch (error) {
    await Promise.all([preview, tunnel].filter(Boolean).map(stopProcess));
    throw error;
  }
}

async function waitFor(predicate, description, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function connectToPage(pageUrl) {
  const socket = new WebSocket(pageUrl);
  const pending = new Map();
  const eventWaiters = new Map();
  let nextId = 0;
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method) {
      const waiters = eventWaiters.get(message.method) ?? [];
      const waiterIndex = waiters.findIndex(({ predicate }) => predicate(message.params));
      if (waiterIndex >= 0) {
        const [{ resolve: resolveEvent }] = waiters.splice(waiterIndex, 1);
        resolveEvent(message.params);
      }
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });

  return {
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolveCommand, rejectCommand) => {
        pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    waitForEvent(method, timeoutMs = 15_000) {
      return new Promise((resolveEvent, rejectEvent) => {
        const waiters = eventWaiters.get(method) ?? [];
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === resolveEvent);
          if (index >= 0) waiters.splice(index, 1);
          rejectEvent(new Error(`Timed out waiting for Chrome event ${method}`));
        }, timeoutMs);
        waiters.push({
          predicate: () => true,
          resolve: (params) => {
            clearTimeout(timer);
            resolveEvent(params);
          },
        });
        eventWaiters.set(method, waiters);
      });
    },
    close: () => socket.close(),
  };
}

async function checkOfflineReload(cdp, origin, app, mode) {
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  if (mode === "mobile") {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await cdp.send("Emulation.setUserAgentOverride", {
      userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36",
      platform: "Android",
    });
  } else {
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await cdp.send("Emulation.setUserAgentOverride", { userAgent: "" });
  }
  await cdp.send("Page.navigate", { url: origin });
  const onlineState = await waitFor(async () => {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `({origin: location.origin, title: document.title, content: document.querySelector("#root")?.innerText.trim() ?? ""})`,
      returnByValue: true,
    });
    return result.value?.origin === origin && result.value?.content ? result.value : undefined;
  }, `${app} app to render while online`, 30_000);

  const { result: workerResult } = await cdp.send("Runtime.evaluate", {
    expression: `Promise.race([navigator.serviceWorker.ready.then(async () => {
      const deadline = Date.now() + 5000;
      while (!navigator.serviceWorker.controller && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return Boolean(navigator.serviceWorker.controller);
    }), new Promise(resolve => setTimeout(() => resolve(false), 6000))])`,
    awaitPromise: true,
    returnByValue: true,
  });
  const controlled = workerResult.value === true;

  let offlineState;
  try {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
      connectionType: "none",
    });
    const loadEvent = cdp.waitForEvent("Page.loadEventFired");
    await cdp.send("Page.navigate", { url: origin });
    await loadEvent;
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `({origin: location.origin, title: document.title, content: document.querySelector("#root")?.innerText.trim() ?? "", body: document.body?.innerText ?? ""})`,
      returnByValue: true,
    });
    offlineState = result.value;
  } finally {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
      connectionType: "none",
    });
  }

  const renderedOffline = offlineState?.origin === origin && Boolean(offlineState.content);
  console.log(`${app} ${mode} offline reload: ${renderedOffline ? "app rendered from offline cache" : `FAILED; ${offlineState?.body?.slice(0, 120) || "app shell did not render"}`}; service worker ${controlled ? "controlled page" : "did not control page"}`);
  if (!renderedOffline) throw new Error(`${app} ${mode} did not render after Chrome went offline; online page title was ${onlineState.title}`);
}

async function inspectPage(cdp, origin, mode) {
  if (mode === "mobile") {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
    });
    await cdp.send("Emulation.setUserAgentOverride", {
      userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36",
      platform: "Android",
    });
  } else {
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await cdp.send("Emulation.setUserAgentOverride", { userAgent: "" });
  }

  await cdp.send("Page.navigate", { url: origin });
  const pageState = await waitFor(async () => {
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: `Promise.race([navigator.serviceWorker.ready.then(async () => {
        const deadline = Date.now() + 5000;
        while (!navigator.serviceWorker.controller && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return { controller: Boolean(navigator.serviceWorker.controller), title: document.title, origin: location.origin };
      }), new Promise(resolve => setTimeout(() => resolve({ controller: false, title: document.title, origin: location.origin }), 7000))])`,
      awaitPromise: true,
      returnByValue: true,
    });
    return result.value?.origin === origin && result.value?.title ? result.value : undefined;
  }, "app load and service worker registration");

  const { manifest } = await cdp.send("Page.getAppManifest");
  const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
  return { mode, title: pageState.title, controlled: pageState.controller, manifest, installabilityErrors };
}

const previews = [];
let chrome;
let profile;
let cdp;
try {
  for (const app of apps) previews.push(await startPreview(app));
  profile = await mkdtemp(join(tmpdir(), "woodpecker-pwa-chrome-"));
  chrome = spawnTracked(chromePath, [
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--no-sandbox",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: "ignore" });

  const portFile = join(profile, "DevToolsActivePort");
  const port = await waitFor(async () => {
    if (chrome.spawnError) throw chrome.spawnError;
    if (chrome.exitCode !== null) throw new Error(`Chrome exited with code ${chrome.exitCode}`);
    try {
      return Number((await readFile(portFile, "utf8")).split("\n")[0]);
    } catch {
      return undefined;
    }
  }, "Chrome DevTools startup");
  const targets = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  }, "Chrome page target");
  cdp = await connectToPage(targets.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  if (runMode === "dev") {
    const failures = [];
    for (const mode of ["desktop", "mobile"]) {
      for (const { app, origin } of previews) {
        try {
          await checkOfflineReload(cdp, origin, app, mode);
        } catch (error) {
          failures.push(error.message);
        }
      }
    }
    if (failures.length) throw new Error(failures.join("\n"));
  } else {
    for (const mode of ["desktop", "mobile"]) {
      for (const { app, origin } of previews) {
        const result = await inspectPage(cdp, origin, mode);
        const errors = result.installabilityErrors.map(({ errorId }) => errorId);
        const label = `${app} ${mode}`;
        console.log(`${label}: ${errors.length ? `NOT INSTALLABLE (${errors.join(", ")})` : "installability checks passed"}; service worker ${result.controlled ? "controls page" : "does not control page"}; HTTPS origin verified`);
        if (!result.manifest) throw new Error(`${label}: Chrome did not load an app manifest`);
        if (!result.controlled) throw new Error(`${label}: service worker did not control the app page`);
        if (errors.length) throw new Error(`${label}: Chrome reports installability errors: ${errors.join(", ")}`);
      }
    }
  }
} finally {
  cdp?.close();
  if (chrome) await stopProcess(chrome);
  await Promise.all(previews.flatMap(({ processes }) => processes.map(stopProcess)));
  if (profile) await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
