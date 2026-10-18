#!/usr/bin/env node
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { closeSync, existsSync, openSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const feature = process.argv[2];
const features = ["generator-export", "trainer-import", "trainer-run", "trainer-history", "trainer-library"];
let interruptedSignal;
const chromeCandidates = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").toLocaleLowerCase();
}

async function waitFor(predicate, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (interruptedSignal) fail(`Interrupted by ${interruptedSignal}`);
    const result = await predicate();
    if (result) return result;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  fail(`Timed out waiting for ${description}`);
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const { port } = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function connectToPage(url) {
  return new Promise((resolveConnect, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const eventWaiters = new Map();
    let nextId = 0;

    socket.addEventListener("open", () => {
      resolveConnect({
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
            const waiter = { resolve: resolveEvent };
            const timer = setTimeout(() => {
              const current = eventWaiters.get(method) ?? [];
              const index = current.indexOf(waiter);
              if (index >= 0) current.splice(index, 1);
              rejectEvent(new Error(`Timed out waiting for Chrome event ${method}`));
            }, timeoutMs);
            waiter.resolve = (params) => {
              clearTimeout(timer);
              resolveEvent(params);
            };
            waiter.reject = (error) => {
              clearTimeout(timer);
              rejectEvent(error);
            };
            waiters.push(waiter);
            eventWaiters.set(method, waiters);
          });
        },
        close() {
          socket.close();
        },
      });
    }, { once: true });

    socket.addEventListener("error", (event) => reject(event.error ?? new Error("Chrome DevTools connection failed")), { once: true });
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
      if (message.method) {
        const waiters = eventWaiters.get(message.method) ?? [];
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(message.params);
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const request of pending.values()) request.reject(new Error("Chrome DevTools connection closed"));
      pending.clear();
      for (const waiters of eventWaiters.values()) {
        for (const waiter of waiters.splice(0)) waiter.reject(new Error("Chrome DevTools connection closed"));
      }
    });
  });
}

async function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const waitForExit = (timeoutMs) => new Promise((resolveExit) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolveExit(true);
    const timeout = setTimeout(() => resolveExit(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit(true);
    });
  });
  child.kill("SIGTERM");
  if (await waitForExit(2_000)) return;
  child.kill("SIGKILL");
  if (!(await waitForExit(2_000))) fail(`Could not stop launched process ${child.pid}`);
}

async function main() {
  if (!features.includes(feature)) {
    process.stderr.write(`Usage: node .claude/skills/verify/scripts/drive.mjs <feature>\nFeatures: ${features.join(", ")}\n`);
    process.exitCode = 2;
    return;
  }

  const runId = `${new Date().toISOString().replace(/[-:.]/g, "")}-${process.pid}`;
  const evidenceDir = join(root, ".artifacts", "verify-woodpecker", runId, feature);
  const downloadsDir = join(evidenceDir, "downloads");
  await mkdir(downloadsDir, { recursive: true });

  const processes = [];
  const servers = [];
  const actions = [];
  const evidenceFiles = [];
  const doctor = [];
  const results = {};
  let profile;
  let fixtureDir;
  let cdp;
  let failure;
  let cleanupFailure;

  const interrupt = (signal) => {
    interruptedSignal ??= signal;
    cdp?.close();
  };
  process.once("SIGINT", () => interrupt("SIGINT"));
  process.once("SIGTERM", () => interrupt("SIGTERM"));

  const recordAction = (action, target, before, after, details = {}) => {
    actions.push({ at: new Date().toISOString(), action, target, before, after, ...details });
  };

  async function startServer(app, label = app, configFile) {
    const port = await reservePort();
    const origin = `http://127.0.0.1:${port}`;
    const vite = join(root, "node_modules", "vite", "bin", "vite.js");
    const logPath = join(evidenceDir, `${label}.log`);
    const logFd = openSync(logPath, "a");
    const args = [vite, ...(configFile ? ["--config", configFile] : []), "--host", "127.0.0.1", "--port", String(port), "--strictPort"];
    const child = spawn(process.execPath, args, {
      cwd: join(root, "apps", app),
      env: process.env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    closeSync(logFd);
    child.spawnError = undefined;
    child.once("error", (error) => { child.spawnError = error; });
    processes.push({ child, label, kind: "vite", port });
    const server = { app, label, origin, port, child };
    servers.push(server);

    await waitFor(async () => {
      if (child.spawnError) throw child.spawnError;
      if (child.exitCode !== null) fail(`${label} Vite process exited with code ${child.exitCode}; see ${logPath}`);
      try {
        const response = await fetch(origin);
        return response.ok ? true : undefined;
      } catch {
        return undefined;
      }
    }, `${label} development server at ${origin}`);
    return server;
  }

  async function evaluate(expression, awaitPromise = false) {
    const response = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails) {
      fail(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Browser evaluation failed");
    }
    return response.result?.value;
  }

  async function pageState() {
    return evaluate(`(() => ({
      url: location.href,
      title: document.title,
      text: document.body?.innerText ?? "",
      controls: Array.from(document.querySelectorAll("button, a, input, select"))
        .filter(element => element.getClientRects().length > 0)
        .map(element => ({
          tag: element.tagName.toLowerCase(),
          text: (element.getAttribute("aria-label") || element.innerText || element.labels?.[0]?.innerText || "").replace(/\\s+/g, " ").trim(),
          type: element.getAttribute("type"),
          value: element.value ?? null,
          disabled: Boolean(element.disabled),
        })),
    }))()`);
  }

  async function capture(label) {
    const statePath = join(evidenceDir, `${label}.state.json`);
    const imagePath = join(evidenceDir, `${label}.png`);
    await writeFile(statePath, `${JSON.stringify(await pageState(), null, 2)}\n`);
    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true });
    await writeFile(imagePath, Buffer.from(screenshot.data, "base64"));
    evidenceFiles.push(statePath, imagePath);
    return statePath;
  }

  async function navigate(server) {
    const loaded = cdp.waitForEvent("Page.loadEventFired", 20_000);
    await cdp.send("Page.navigate", { url: server.origin });
    await loaded;
    const expectedSection = server.app === "generator" ? "Generator" : "Trainer";
    const state = await waitFor(async () => {
      const current = await pageState();
      if (current.url.startsWith(server.origin) && current.text.includes("Woodpecker") && current.text.includes(expectedSection)) return current;
      return undefined;
    }, `${server.label} app shell at ${server.origin}`, 30_000);
    return state;
  }

  async function waitReady(server) {
    try {
      return await waitFor(async () => {
        const state = await pageState();
        if (server.app === "generator") {
          const ready = state.text.includes("local records") && state.controls.some((control) => control.text === "Generate puzzle set" && !control.disabled);
          return ready ? state : undefined;
        }
        const hasSet = state.text.includes("Warm-up tactics") && state.text.includes("Your Puzzle Sets");
        const loading = state.text.includes("Opening local Trainer storage...");
        return hasSet && !loading ? state : undefined;
      }, `${server.label} usable UI and local data seed`, 30_000);
    } catch (error) {
      const state = await pageState().catch(() => undefined);
      if (state) {
        try { await capture(`${server.label}-doctor-not-ready`); } catch {}
      }
      throw new Error(`${error instanceof Error ? error.message : String(error)}; current app text: ${state?.text.slice(0, 1800) ?? "unavailable"}`);
    }
  }

  async function clickAt(expression, description) {
    const box = await evaluate(`(() => {
      const element = ${expression};
      if (!element || !element.getClientRects().length) return null;
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    assert(box, `Could not find visible ${description}`);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
  }

  async function clickButton(name, scopeSelector) {
    const nameValue = JSON.stringify(name);
    const scopeValue = JSON.stringify(scopeSelector ?? "body");
    const before = (await pageState()).text.slice(0, 2500);
    const expression = `(() => {
      const scope = document.querySelector(${scopeValue});
      if (!scope) return null;
      return Array.from(scope.querySelectorAll("button")).find(button => {
        const label = (button.getAttribute("aria-label") || button.innerText || "").replace(/\\s+/g, " ").trim();
        return label === ${nameValue};
      });
    })()`;
    await clickAt(expression, `button named "${name}"`);
    const after = (await pageState()).text.slice(0, 2500);
    recordAction(`Click ${name}`, `button: ${name}`, before, after);
  }

  async function clickSetCardButton(setName, buttonName) {
    const before = (await pageState()).text.slice(0, 2500);
    const expression = `(() => {
      const card = Array.from(document.querySelectorAll(".set-card")).find(element => element.querySelector("h3")?.innerText.trim() === ${JSON.stringify(setName)});
      if (!card) return null;
      return Array.from(card.querySelectorAll("button")).find(button => (button.getAttribute("aria-label") || button.innerText || "").replace(/\\s+/g, " ").trim() === ${JSON.stringify(buttonName)}) || null;
    })()`;
    await clickAt(expression, `button "${buttonName}" on Puzzle Set "${setName}"`);
    recordAction(`Click ${buttonName} for ${setName}`, `.set-card h3=${setName} -> button: ${buttonName}`, before, (await pageState()).text.slice(0, 2500));
  }

  async function fillInput(selector, value) {
    const before = (await pageState()).text.slice(0, 2500);
    const actual = await evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input) return null;
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
      if (!setter) return null;
      setter.call(input, ${JSON.stringify(String(value))});
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${JSON.stringify(String(value))} }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return input.value;
    })()`);
    assert(actual === String(value), `Could not enter "${value}" in ${selector}`);
    const after = (await pageState()).text.slice(0, 2500);
    recordAction(`Enter ${value}`, `input ${selector}`, before, after, { value: actual });
  }

  async function clickTheme(labelText) {
    const before = (await pageState()).text.slice(0, 2500);
    const expression = `(() => Array.from(document.querySelectorAll("label.theme-chip")).find(label => label.innerText.replace(/\\s+/g, " ").trim() === ${JSON.stringify(labelText)}) || null)()`;
    await clickAt(expression, `theme checkbox "${labelText}"`);
    const after = (await pageState()).text.slice(0, 2500);
    recordAction(`Select theme ${labelText}`, `label.theme-chip: ${labelText}`, before, after);
  }

  async function selectThemes(wanted) {
    const labels = await evaluate(`Array.from(document.querySelectorAll("label.theme-chip")).map(label => ({
      name: label.innerText.replace(/\\s+/g, " ").trim(),
      checked: Boolean(label.querySelector("input")?.checked),
    }))`);
    for (const theme of labels) {
      const shouldCheck = wanted.includes(theme.name);
      if (theme.checked !== shouldCheck) await clickTheme(theme.name);
    }
    for (const name of wanted) assert(labels.some((theme) => theme.name === name), `Theme "${name}" is unavailable in this local index`);
  }

  async function pageTextContains(text, timeout = 15_000) {
    return waitFor(async () => {
      const state = await pageState();
      return normalizeText(state.text).includes(normalizeText(text)) ? state : undefined;
    }, `page text "${text}"`, timeout);
  }

  async function waitForDownload(directory, previousNames) {
    return waitFor(async () => {
      const names = await readdir(directory);
      const candidate = names.find((name) => !previousNames.has(name) && name.endsWith(".json") && !name.endsWith(".crdownload"));
      if (!candidate) return undefined;
      const path = join(directory, candidate);
      try {
        JSON.parse(await readFile(path, "utf8"));
        return path;
      } catch (error) {
        if (error instanceof SyntaxError && error.message === "Unexpected end of JSON input") return undefined;
        throw error;
      }
    }, "completed JSON download", 20_000);
  }

  async function exportFile(buttonName) {
    const index = actions.filter((action) => action.action.startsWith("Download ")).length + 1;
    const directory = join(downloadsDir, `export-${String(index).padStart(2, "0")}`);
    await mkdir(directory, { recursive: true });
    await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: directory });
    const previousNames = new Set(await readdir(directory));
    await clickButton(buttonName);
    const path = await waitForDownload(directory, previousNames);
    const value = JSON.parse(await readFile(path, "utf8"));
    evidenceFiles.push(path);
    recordAction(`Download ${buttonName}`, `button: ${buttonName}`, "Download initiated from app UI", `Saved ${path}`, { file: path });
    return { path, value };
  }

  async function selectLocalFile(buttonName, path) {
    const chooser = cdp.waitForEvent("Page.fileChooserOpened", 10_000);
    await clickButton(buttonName);
    const opened = await chooser;
    await cdp.send("DOM.setFileInputFiles", { backendNodeId: opened.backendNodeId, files: [path] });
    recordAction(`Choose ${path.split("/").at(-1)}`, `button: ${buttonName} -> file chooser`, "File picker opened from app UI", `Selected ${path}`);
  }

  async function readTrainerDb() {
    const snapshot = await evaluate(`(async () => {
      const request = indexedDB.open("offline-woodpecker-trainer");
      const database = await new Promise((resolve, reject) => {
        request.onupgradeneeded = () => {
          request.transaction?.abort();
          reject(new Error("Trainer database was absent during read-only verification"));
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Could not read Trainer database"));
      });
      if (!database.objectStoreNames.contains("puzzle-sets") || !database.objectStoreNames.contains("runs")) {
        database.close();
        throw new Error("Trainer database stores are not initialized");
      }
      const transaction = database.transaction(["puzzle-sets", "runs"], "readonly");
      const read = store => new Promise((resolve, reject) => {
        const getAll = transaction.objectStore(store).getAll();
        getAll.onsuccess = () => resolve(getAll.result);
        getAll.onerror = () => reject(getAll.error || new Error("Could not read " + store));
      });
      const [sets, runs] = await Promise.all([read("puzzle-sets"), read("runs")]);
      database.close();
      return { sets, runs };
    })()`, true);
    return snapshot;
  }

  async function importSet(path, name) {
    const before = (await pageState()).text.slice(0, 2500);
    await selectLocalFile("Import set", path);
    const state = await waitFor(async () => {
      const current = await pageState();
      return current.text.includes(name) && current.text.includes("Puzzle Set imported and ready to run.") ? current : undefined;
    }, `import of Puzzle Set "${name}"`);
    const db = await readTrainerDb();
    assert(db.sets.some((record) => record.set?.name === name && !record.archived), `Imported Puzzle Set "${name}" is not in IndexedDB`);
    recordAction(`Import Puzzle Set ${name}`, "button: Import set and the browser file chooser", before, state.text.slice(0, 2500), { indexedDbSetCount: db.sets.length });
    return db;
  }

  async function generateSet(name, count, themeName = "Short") {
    await navigate(servers.find((server) => server.app === "generator"));
    const generator = servers.find((server) => server.app === "generator");
    await waitReady(generator);
    const nameSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    await capture(`${nameSlug}-00-generator-ready`);
    await fillInput("#set-name", name);
    await fillInput("#puzzle-count", count);
    await selectThemes([themeName]);
    await clickButton("Generate puzzle set");
    const generated = await waitFor(async () => {
      const state = await pageState();
      const ready = state.text.includes(name) && new RegExp(`${count} puzzles selected from \\d+ matches\\.`).test(state.text)
        && state.controls.some((control) => control.text === "Export JSON");
      return ready ? state : undefined;
    }, `Generator result for ${name}`, 120_000);
    recordAction(`Generate ${count}-puzzle Puzzle Set`, "button: Generate puzzle set", "Selection form is ready", generated.text.slice(0, 2500), { name, theme: themeName, count });
    await capture(`${nameSlug}-10-generator-generated`);
    const download = await exportFile("Export JSON");
    assert(download.value.kind === "puzzle-set", "Generator download is not a Puzzle Set JSON document");
    assert(download.value.name === name, `Expected downloaded set "${name}", received "${download.value.name}"`);
    assert(download.value.puzzles?.length === count, `Expected ${count} puzzles in the downloaded Puzzle Set`);
    assert(download.value.puzzles.every((puzzle) => puzzle.moves.length >= 2), "Downloaded Puzzle Set has an incomplete solution line");
    return { ...download, set: download.value };
  }

  async function checkPortOwner(server) {
    let pids;
    try {
      const output = execFileSync("lsof", ["-nP", `-iTCP:${server.port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      pids = output.trim().split(/\s+/).filter(Boolean).map(Number);
    } catch (error) {
      if (error.status === 1) pids = [];
      else throw new Error("The read-only port-ownership check requires lsof");
    }
    assert(pids.includes(server.child.pid), `${server.label} port ${server.port} is not owned by the process this verification run launched (owner PIDs: ${pids.join(",") || "none"})`);
    return pids;
  }

  async function runDoctor() {
    const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert(rootPackage.version === "0.1.0", `Unexpected workspace version ${rootPackage.version}`);
    for (const server of servers) {
      assert(server.child.exitCode === null && !server.child.spawnError, `${server.label} process is not running`);
      const appPackage = JSON.parse(await readFile(join(root, "apps", server.app, "package.json"), "utf8"));
      assert(appPackage.name === `@offline-woodpecker/${server.app}`, `${server.label} package identity is ${appPackage.name}`);
      assert(appPackage.version === rootPackage.version, `${server.label} package version ${appPackage.version} does not match workspace ${rootPackage.version}`);
      const ownerPids = await checkPortOwner(server);
      const response = await fetch(server.origin);
      assert(response.ok && (await response.text()).includes("id=\"root\""), `${server.label} does not serve the expected app shell`);
      const state = await navigate(server);
      const ready = await waitReady(server);
      const expectedSection = server.app === "generator" ? "Generator" : "Trainer";
      assert(state.text.includes("Woodpecker") && state.text.includes(expectedSection), `${server.label} rendered the wrong app identity`);
      assert(state.title === `Woodpecker ${expectedSection}`, `${server.label} document title is ${state.title}`);
      doctor.push({
        app: server.app,
        origin: server.origin,
        processId: server.child.pid,
        portOwnerPids: ownerPids,
        packageName: appPackage.name,
        packageVersion: appPackage.version,
        documentTitle: state.title,
        uiReady: true,
        auth: "not applicable; both apps are offline browser applications without accounts",
        readyEvidence: ready.text.split("\n").filter((line) => line.includes("local records") || line.includes("Warm-up tactics")).slice(0, 4),
      });
    }
    const doctorPath = join(evidenceDir, "doctor.json");
    await writeFile(doctorPath, `${JSON.stringify({ checkedAt: new Date().toISOString(), checks: doctor }, null, 2)}\n`);
    evidenceFiles.push(doctorPath);
    process.stdout.write(`Doctor passed: ${doctor.map((item) => `${item.app} ${item.origin} (PID ${item.processId})`).join("; ")}\n`);
  }

  async function prepareGeneratorFixture() {
    fixtureDir = await mkdtemp(join(tmpdir(), "woodpecker-verify-generator-"));
    const publicDir = join(fixtureDir, "public");
    await mkdir(publicDir);
    const sourcePublicDir = join(root, "apps", "generator", "public");
    const entries = await readdir(sourcePublicDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && !entry.name.startsWith("puzzle-index.generated")) {
        await copyFile(join(sourcePublicDir, entry.name), join(publicDir, entry.name));
      }
    }
    for (const name of ["puzzle-index.jsonl", "puzzle-index-manifest.json", "sw.js", "manifest.webmanifest"]) {
      assert(existsSync(join(publicDir, name)), `Checked-in Generator fixture is missing ${name}`);
    }
    await copyFile(join(publicDir, "puzzle-index-manifest.json"), join(publicDir, "puzzle-index.generated-manifest.json"));
    await writeFile(join(publicDir, "puzzle-index.generated.jsonl.gz"), gzipSync(await readFile(join(publicDir, "puzzle-index.jsonl"))));
    const configPath = join(fixtureDir, "vite.config.mjs");
    const sourceConfig = pathToFileURL(join(root, "apps", "generator", "vite.config.ts")).href;
    await writeFile(configPath, `import appConfig from ${JSON.stringify(sourceConfig)};\nexport default { ...appConfig, publicDir: ${JSON.stringify(publicDir)} };\n`);
    results.generatorIndexMode = "checked-in sample compressed as a generated-index fixture in an isolated scratch public directory";
    return configPath;
  }

  async function driveGeneratorExport() {
    const { path, set } = await generateSet("Verification tactics", 3);
    assert(set.selection.themes.includes("short"), "Downloaded selection did not retain the Short theme");
    await capture("20-generator-exported");
    results.puzzleSet = { name: set.name, puzzleCount: set.puzzles.length, path };
  }

  async function driveTrainerImport() {
    const { path, set } = await generateSet("Verification import", 3);
    const trainer = servers.find((server) => server.app === "trainer" && server.label === "trainer");
    await navigate(trainer);
    await waitReady(trainer);
    await capture("20-trainer-before-import");
    const db = await importSet(path, set.name);
    await capture("30-trainer-after-import");
    results.importedSet = { name: set.name, puzzleCount: set.puzzles.length, indexedDbSetCount: db.sets.length };
  }

  async function createAndImportMateSet(name) {
    const { path, set } = await generateSet(name, 1, "Mate In1");
    assert(set.puzzles[0]?.moves.length >= 2, "Selected Mate In1 Puzzle has no player move");
    const trainer = servers.find((server) => server.app === "trainer" && server.label === "trainer");
    await navigate(trainer);
    await waitReady(trainer);
    await importSet(path, name);
    return set;
  }

  async function completeRun(set, name) {
    const before = (await pageState()).text.slice(0, 2500);
    const card = await evaluate(`Array.from(document.querySelectorAll(".set-card")).find(element => element.querySelector("h3")?.innerText.trim() === ${JSON.stringify(name)}) !== undefined`);
    assert(card, `Trainer library does not show "${name}"`);
    const runButton = await evaluate(`(() => Array.from(document.querySelectorAll(".set-card")).find(element => element.querySelector("h3")?.innerText.trim() === ${JSON.stringify(name)})?.querySelector("button.primary-button")?.innerText.replace(/\\s+/g, " ").trim())()`);
    assert(runButton === "Start new Run", `Expected a Start new Run action for "${name}"`);
    await clickSetCardButton(name, "Start new Run");
    const startState = await waitFor(async () => {
      const current = await pageState();
      return current.text.includes("Find the best move.") && current.text.includes(name) ? current : undefined;
    }, `Run for ${name} to open`);
    recordAction(`Start Run for ${name}`, `.set-card h3=${name} -> button: Start new Run`, before, startState.text.slice(0, 2500));
    await capture("20-trainer-run-started");

    const userMoves = set.puzzles[0].moves.filter((_, index) => index % 2 === 1);
    assert(set.puzzles[0].themes.includes("mateIn1") && userMoves.length === 1, `Puzzle Set "${name}" is not a single-move Mate In1 precondition`);
    for (const uci of userMoves) {
      const from = uci.slice(0, 2);
      const to = uci.slice(2, 4);
      const moveBefore = (await pageState()).text.slice(0, 2500);
      await clickAt(`document.querySelector('[data-square="${from}"]')`, `chessboard square ${from}`);
      const selectedSquare = await evaluate(`(() => {
        const square = document.querySelector('[data-square="${from}"]');
        return square ? { style: square.getAttribute("style"), rect: square.getBoundingClientRect().toJSON() } : null;
      })()`);
      recordAction(`Select chessboard square ${from}`, `[data-square="${from}"]`, "Puzzle is active", JSON.stringify(selectedSquare));
      await capture("25-trainer-source-square-selected");
      await clickAt(`document.querySelector('[data-square="${to}"]')`, `chessboard square ${to}`);
      await capture("26-trainer-destination-square-clicked");
      const moveResult = await waitFor(async () => {
        const current = await pageState();
        const text = normalizeText(current.text);
        return text.includes("run complete") || text.includes("first try missed") ? current : undefined;
      }, `board move ${from}-${to} to produce a visible result`, 10_000);
      recordAction(`Play ${from}-${to}`, `chessboard [data-square="${from}"] then [data-square="${to}"]`, moveBefore, moveResult.text.slice(0, 2500), { uci });
      if (!normalizeText(moveResult.text).includes("run complete")) {
        await capture("30-trainer-run-move-failed");
        fail(`Move ${from}-${to} reached an error state: ${moveResult.text.slice(-1000)}`);
      }
    }
    const summary = await pageTextContains("Run complete", 20_000);
    assert(summary.text.includes("100%") && summary.text.includes(name), `Run summary does not show a 100% first-try score for ${name}`);
    const db = await readTrainerDb();
    const run = db.runs.find((candidate) => candidate.setId === db.sets.find((record) => record.set.name === name)?.set.id);
    assert(run?.status === "completed" && run.results[0]?.status === "first-try-solved", "Completed Run or first-try Puzzle Result was not persisted in IndexedDB");
    return { db, run };
  }

  async function driveTrainerRun(openHistory) {
    const name = openHistory ? "Verification history" : "Verification Run";
    const set = await createAndImportMateSet(name);
    const { db, run } = await completeRun(set, name);
    if (openHistory) {
      await capture("30-trainer-run-summary");
      await clickButton("Inspect results");
      const history = await waitFor(async () => {
        const current = await pageState();
        const text = normalizeText(current.text);
        return text.includes("run history") && text.includes("first-try solve") && text.includes("1/1 first-try score") ? current : undefined;
      }, "Run history detail for the completed Run");
      await capture("40-trainer-history-detail");
      recordAction("Inspect completed Run results", "button: Inspect results", "Run complete summary is visible", history.text.slice(0, 2500));
      await clickButton("History");
      const historyNav = await waitFor(async () => {
        const current = await pageState();
        const text = normalizeText(current.text);
        return text.includes("run history") && text.includes("first-try solve") ? current : undefined;
      }, "Run history opened from primary navigation");
      recordAction("Open Run history from primary navigation", "nav[aria-label=Primary navigation] button: History", "Trainer is showing the completed Run detail", historyNav.text.slice(0, 2500));
      await capture("50-trainer-history-navigation");
    } else {
      await capture("30-trainer-run-summary");
    }
    results.run = { name, runId: run.id, status: run.status, resultStatus: run.results[0].status, indexedDbRunCount: db.runs.length };
  }

  async function waitDialog() {
    return cdp.waitForEvent("Page.javascriptDialogOpening", 10_000);
  }

  async function driveTrainerLibrary() {
    const primary = servers.find((server) => server.app === "trainer" && server.label === "trainer");
    const secondary = servers.find((server) => server.app === "trainer" && server.label === "trainer-restore");
    await navigate(primary);
    await waitReady(primary);
    await capture("00-trainer-library");
    const initialBackup = await exportFile("Export backup");
    assert(initialBackup.value.kind === "trainer-backup" && initialBackup.value.puzzleSets.some((item) => item.set.name === "Warm-up tactics"), "Trainer backup does not contain the seeded Puzzle Set");

    const transfer = await generateSet("Verification Transfer", 1);
    await navigate(primary);
    await waitReady(primary);
    await importSet(transfer.path, transfer.set.name);
    const backup = await exportFile("Export backup");
    assert(backup.value.kind === "trainer-backup" && backup.value.puzzleSets.some((item) => item.set.name === transfer.set.name), "Exported Trainer backup omitted the imported Puzzle Set");

    await navigate(secondary);
    await waitReady(secondary);
    await capture("20-trainer-restore-before");
    await selectLocalFile("Restore backup", backup.path);
    await pageTextContains("Backup merged with local sets and Run history.");
    let db = await readTrainerDb();
    assert(db.sets.some((record) => record.set.name === transfer.set.name && !record.archived), "Restored Puzzle Set was not written to the second Trainer origin");
    recordAction("Restore Trainer backup", "button: Restore backup and the browser file chooser", "Second Trainer origin has its own seeded library", (await pageState()).text.slice(0, 2500), { indexedDbSetCount: db.sets.length });
    await capture("30-trainer-restore-after");

    await clickButton(`Archive ${transfer.set.name}`);
    await waitFor(async () => {
      const current = await pageState();
      return !current.text.includes(transfer.set.name) ? current : undefined;
    }, `archived ${transfer.set.name} to leave the active library`);
    db = await readTrainerDb();
    assert(db.sets.some((record) => record.set.name === transfer.set.name && record.archived), "Archive action did not persist the Archived Puzzle Set state");

    const deletion = await generateSet("Verification Delete", 1, "Mate In1");
    await navigate(secondary);
    await waitReady(secondary);
    await importSet(deletion.path, deletion.set.name);
    const dialog = waitDialog();
    const deleteClick = clickSetCardButton(deletion.set.name, "Delete set and history");
    const opened = await dialog;
    assert(opened.message.includes("Delete this Puzzle Set and every Run attached to it?"), "Delete confirmation does not name the destructive action");
    await cdp.send("Page.handleJavaScriptDialog", { accept: true });
    await deleteClick;
    await waitFor(async () => {
      const current = await pageState();
      return !current.text.includes(deletion.set.name) && current.text.includes("Puzzle Set and its history were deleted.") ? current : undefined;
    }, `deletion of ${deletion.set.name}`);
    db = await readTrainerDb();
    assert(!db.sets.some((record) => record.set.name === deletion.set.name), "Deleted Puzzle Set remains in IndexedDB");
    await capture("40-trainer-library-after");
    results.library = {
      backupContains: backup.value.puzzleSets.map((item) => item.set.name),
      restoredSet: transfer.set.name,
      archivedSet: transfer.set.name,
      deletedSet: deletion.set.name,
      remainingIndexedDbSetCount: db.sets.length,
    };
  }

  try {
    const generatorConfig = await prepareGeneratorFixture();
    await startServer("generator", "generator", generatorConfig);
    await startServer("trainer");
    if (feature === "trainer-library") await startServer("trainer", "trainer-restore");
    profile = await mkdtemp(join(tmpdir(), "woodpecker-verify-chrome-"));
    const chromePath = chromeCandidates.find((path) => existsSync(path));
    assert(chromePath, `Chrome was not found. Set CHROME_BIN to a Chrome executable. Checked: ${chromeCandidates.join(", ")}`);
    const chromeLog = openSync(join(evidenceDir, "chrome.log"), "a");
    const chrome = spawn(chromePath, [
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      "--no-sandbox",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ], { detached: true, stdio: ["ignore", chromeLog, chromeLog] });
    closeSync(chromeLog);
    chrome.spawnError = undefined;
    chrome.once("error", (error) => { chrome.spawnError = error; });
    processes.push({ child: chrome, label: "chrome", kind: "chrome" });

    const portFile = join(profile, "DevToolsActivePort");
    const debugPort = await waitFor(async () => {
      if (chrome.spawnError) throw chrome.spawnError;
      if (chrome.exitCode !== null) fail(`Chrome exited with code ${chrome.exitCode}`);
      try {
        return Number((await readFile(portFile, "utf8")).split("\n")[0]);
      } catch {
        return undefined;
      }
    }, "Chrome DevTools startup");
    const targets = await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const pages = await response.json();
      return pages.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
    }, "isolated Chrome page target");
    cdp = await connectToPage(targets.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("DOM.enable");
    await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });
    await cdp.send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadsDir });
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1600, deviceScaleFactor: 1, mobile: false });

    await runDoctor();
    if (feature === "generator-export") await driveGeneratorExport();
    if (feature === "trainer-import") await driveTrainerImport();
    if (feature === "trainer-run") await driveTrainerRun(false);
    if (feature === "trainer-history") await driveTrainerRun(true);
    if (feature === "trainer-library") await driveTrainerLibrary();
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    const cleanupErrors = [];
    try { cdp?.close(); } catch (error) { cleanupErrors.push(error); }
    for (const { child } of [...processes].reverse()) {
      try { await stopProcess(child); } catch (error) { cleanupErrors.push(error); }
    }
    if (profile) {
      try { await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { cleanupErrors.push(error); }
    }
    if (fixtureDir) {
      try { await rm(fixtureDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) {
      cleanupFailure = new Error(`Cleanup failed: ${cleanupErrors.map((error) => error instanceof Error ? error.message : String(error)).join("; ")}`);
    }
  }

  try {
    const actionsPath = join(evidenceDir, "actions.jsonl");
    await writeFile(actionsPath, actions.map((action) => JSON.stringify(action)).join("\n") + (actions.length ? "\n" : ""));
    evidenceFiles.push(actionsPath);
    const cleanupPath = join(evidenceDir, "cleanup.json");
    const processSummary = processes.map(({ child, label, kind, port }) => ({ label, kind, pid: child.pid ?? null, port: port ?? null, stopped: child.exitCode !== null || child.signalCode !== null }));
    await writeFile(cleanupPath, `${JSON.stringify({ completedAt: new Date().toISOString(), processes: processSummary, chromeProfileRemoved: !profile || !existsSync(profile), generatorFixtureRemoved: !fixtureDir || !existsSync(fixtureDir), evidenceDirectoryRetained: existsSync(evidenceDir) }, null, 2)}\n`);
    evidenceFiles.push(cleanupPath);
    for (const path of evidenceFiles) {
      await stat(path);
    }
    const summaryPath = join(evidenceDir, "run-summary.json");
    await writeFile(summaryPath, `${JSON.stringify({ runId, feature, outcome: failure || cleanupFailure ? "failed" : "passed", failure: failure?.message ?? cleanupFailure?.message ?? null, origins: servers.map(({ app, label, origin, port, child }) => ({ app, label, origin, port, pid: child.pid })), results, evidenceDir }, null, 2)}\n`);
  } catch (error) {
    cleanupFailure ??= error instanceof Error ? error : new Error(String(error));
  }

  process.stdout.write(`Evidence: ${evidenceDir}\n`);
  if (results.puzzleSet) process.stdout.write(`Puzzle Set: ${results.puzzleSet.name} (${results.puzzleSet.puzzleCount} puzzles)\n`);
  if (results.importedSet) process.stdout.write(`Imported: ${results.importedSet.name}; IndexedDB sets: ${results.importedSet.indexedDbSetCount}\n`);
  if (results.run) process.stdout.write(`Run: ${results.run.status}; Puzzle Result: ${results.run.resultStatus}; ID ${results.run.runId}\n`);
  if (results.library) process.stdout.write(`Library: backup restored, ${results.library.archivedSet} archived, ${results.library.deletedSet} deleted\n`);
  if (failure || cleanupFailure) {
    process.stderr.write(`Verification failed: ${failure?.stack ?? cleanupFailure?.stack}\n`);
    process.stderr.write(`Cleanup ran; inspect ${join(evidenceDir, "cleanup.json")} and the retained logs/evidence.\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Verification passed; launched processes and scratch state were cleaned up.\n");
  }
}

await main();
