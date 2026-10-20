import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmod, copyFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const previewPort = 4174;
const canUsePreviewPort = await isPortAvailable(previewPort);

async function createHarness({
  tunnelFails = false,
  tunnelIgnoresTerm = false,
  tunnelBecomesUnrecognized = false,
  cloudflaredAvailable = true,
  normalizedPreviewCommand = false,
  transientPreviewCommand = false,
  unrecognizedPreviewCommand = false,
  psFailureOnCall = null,
  psFailureForCaptureMs = 0,
  npmExitsAfterPreviewSpawn = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "woodpecker-mobile-install-"));

  try {
    const bin = join(root, "bin");
    const scripts = join(root, "scripts");
    const callerDirectory = join(root, "caller");
    await Promise.all([
      mkdir(bin),
      mkdir(scripts),
      mkdir(callerDirectory),
    ]);

    const command = join(root, "offline-woodpecker");
    const implementation = join(scripts, "mobile-install-trainer.mjs");
    await copyFile(join(repoRoot, "offline-woodpecker"), command);
    await copyFile(join(repoRoot, "scripts/mobile-install-trainer.mjs"), implementation);
    await chmod(command, 0o755);

    const eventsFile = join(root, "events.log");
    const psCallsFile = join(root, "ps.calls");
    const psCaptureStartedFile = join(root, "ps-capture-started-at");
    const npmPidFile = join(root, "npm.pid");
    const previewPidFile = join(root, "preview.pid");
    const tunnelPidFile = join(root, "tunnel.pid");
    const previewServer = join(root, "fake-vite-preview.mjs");
    await writeFile(previewServer, `
import http from "node:http";
import { writeFileSync } from "node:fs";
process.title = "vite preview";
writeFileSync(process.env.FAKE_PREVIEW_PID_FILE, String(process.pid));
const html = '<!doctype html><html><head><title>Woodpecker Trainer</title><link rel="manifest" href="/manifest.webmanifest"><script type="module" src="/assets/trainer.js"></script></head><body><div id="root"></div></body></html>';
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
});
server.listen(${previewPort}, "127.0.0.1", () => console.log("  Local: http://127.0.0.1:${previewPort}/"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`);

    const npm = join(bin, "npm");
    await writeFile(npm, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { writeFileSync } = require("node:fs");
const { spawn } = require("node:child_process");

const args = process.argv.slice(2);
const event = args.includes("ci") ? "ci" : args.includes("build") ? "build" : args.includes("preview") ? "preview" : "unknown";
appendFileSync(process.env.FAKE_EVENTS, JSON.stringify({ command: "npm", event, args, cwd: process.cwd() }) + "\\n");
if (event !== "preview") process.exit(event === "unknown" ? 64 : 0);
writeFileSync(process.env.FAKE_NPM_PID_FILE, String(process.pid));
if (Number(process.env.FAKE_PS_FAIL_FOR_CAPTURE_MS) > 0) {
  writeFileSync(process.env.FAKE_PS_CAPTURE_STARTED_FILE, String(Date.now()));
}
if (process.env.FAKE_NORMALIZED_PREVIEW_COMMAND === "1") process.title = "npm run preview --strictPort";
if (process.env.FAKE_UNRECOGNIZED_PREVIEW_COMMAND === "1") process.title = "npm preview bootstrap";

function startPreview() {
  const child = spawn(process.execPath, [process.env.FAKE_PREVIEW_SERVER, "vite", "preview"], { stdio: "inherit" });
  child.on("error", () => process.exit(1));
  child.on("exit", (code) => process.exit(code ?? 1));
  if (process.env.FAKE_NPM_EXITS_AFTER_PREVIEW_SPAWN === "1") {
    child.unref();
    process.exit(0);
  }
}
if (process.env.FAKE_TRANSIENT_PREVIEW_COMMAND === "1" || process.env.FAKE_UNRECOGNIZED_PREVIEW_COMMAND === "1") {
  if (process.env.FAKE_TRANSIENT_PREVIEW_COMMAND === "1") {
    setTimeout(() => { process.title = "npm preview transition"; }, 500);
  }
  setTimeout(startPreview, 1_000);
} else {
  startPreview();
}
    `);
    await chmod(npm, 0o755);

    if (psFailureOnCall !== null || psFailureForCaptureMs > 0) {
      const fakePs = join(bin, "ps");
      await writeFile(fakePs, `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
let count = 0;
try { count = Number(readFileSync(process.env.FAKE_PS_CALLS_FILE, "utf8")); } catch {}
count += 1;
writeFileSync(process.env.FAKE_PS_CALLS_FILE, String(count));
let captureStartedAt = 0;
try { captureStartedAt = Number(readFileSync(process.env.FAKE_PS_CAPTURE_STARTED_FILE, "utf8")); } catch {}
const captureStillBlocked = captureStartedAt > 0
  && Date.now() - captureStartedAt < Number(process.env.FAKE_PS_FAIL_FOR_CAPTURE_MS);
if (count === Number(process.env.FAKE_PS_FAIL_ON_CALL) || captureStillBlocked) {
  process.stderr.write("simulated ps outage\\n");
  process.exit(1);
}
const result = spawnSync("/bin/ps", process.argv.slice(2), { encoding: "utf8" });
process.stdout.write(result.stdout ?? "");
process.stderr.write(result.stderr ?? "");
process.exitCode = result.status ?? 1;
`);
      await chmod(fakePs, 0o755);
    }

    const cloudflared = join(bin, "cloudflared");
    await writeFile(cloudflared, `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { writeFileSync } = require("node:fs");

const args = process.argv.slice(2);
if (args[0] === "--version") {
  if (process.env.FAKE_CLOUDFLARED_AVAILABLE !== "1") process.exit(1);
  process.stdout.write("cloudflared test\\n");
  process.exit(0);
}
appendFileSync(process.env.FAKE_EVENTS, JSON.stringify({ command: "cloudflared", args, cwd: process.cwd() }) + "\\n");
writeFileSync(process.env.FAKE_TUNNEL_PID_FILE, String(process.pid));
if (process.env.FAKE_TUNNEL_FAIL === "1") {
  process.stderr.write("simulated cloudflared startup failure\\n");
  process.exit(23);
}
if (process.env.FAKE_TUNNEL_IGNORES_TERM === "1") process.on("SIGTERM", () => {});
process.stdout.write("https://trainer-test.trycloudflare.com\\n");
if (process.env.FAKE_TUNNEL_UNRECOGNIZED === "1") {
  setTimeout(() => { process.title = "cloudflared reconnecting"; }, 500);
}
setInterval(() => {}, 1000);
`);
    await chmod(cloudflared, 0o755);

    return {
      root: await realpath(root),
      command,
      callerDirectory,
      eventsFile,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_EVENTS: eventsFile,
        FAKE_PS_CALLS_FILE: psCallsFile,
        FAKE_PS_CAPTURE_STARTED_FILE: psCaptureStartedFile,
        FAKE_PS_FAIL_ON_CALL: psFailureOnCall === null ? "0" : String(psFailureOnCall),
        FAKE_PS_FAIL_FOR_CAPTURE_MS: String(psFailureForCaptureMs),
        FAKE_NPM_EXITS_AFTER_PREVIEW_SPAWN: npmExitsAfterPreviewSpawn ? "1" : "0",
        FAKE_NPM_PID_FILE: npmPidFile,
        FAKE_PREVIEW_SERVER: previewServer,
        FAKE_PREVIEW_PID_FILE: previewPidFile,
        FAKE_TUNNEL_PID_FILE: tunnelPidFile,
        FAKE_TUNNEL_FAIL: tunnelFails ? "1" : "0",
        FAKE_TUNNEL_IGNORES_TERM: tunnelIgnoresTerm ? "1" : "0",
        FAKE_TUNNEL_UNRECOGNIZED: tunnelBecomesUnrecognized ? "1" : "0",
        FAKE_CLOUDFLARED_AVAILABLE: cloudflaredAvailable ? "1" : "0",
        FAKE_NORMALIZED_PREVIEW_COMMAND: normalizedPreviewCommand ? "1" : "0",
        FAKE_TRANSIENT_PREVIEW_COMMAND: transientPreviewCommand ? "1" : "0",
        FAKE_UNRECOGNIZED_PREVIEW_COMMAND: unrecognizedPreviewCommand ? "1" : "0",
      },
      dispose: async () => {
        for (const pidFile of [npmPidFile, tunnelPidFile]) {
          try {
            const pid = Number(await readFile(pidFile, "utf8"));
            process.kill(-pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
          }
        }
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function runCli(harness, args) {
  return new Promise((resolveResult) => {
    const child = spawn(harness.command, args, {
      cwd: harness.callerDirectory,
      env: harness.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 20_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolveResult({ code, stdout, stderr, timedOut });
    });
  });
}

function listen(server, port) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });
}

function close(server) {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

function isPortAvailable(port) {
  const server = createServer();
  return new Promise((resolveAvailable) => {
    server.once("error", () => resolveAvailable(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolveAvailable(true)));
  });
}

async function waitForTrainerPreview() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${previewPort}/`);
      if (response.ok) return response;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  throw new Error("Trainer preview did not become reachable");
}

async function waitForPreviewToStop() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${previewPort}/`, { signal: AbortSignal.timeout(250) });
    } catch {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("Trainer preview remained reachable after shutdown");
}

async function waitForProcessToStop(pid) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`Managed process ${pid} remained alive after shutdown`);
}

async function readEvents(harness) {
  const contents = await readFile(harness.eventsFile, "utf8");
  return contents.trim().split("\n").map((line) => JSON.parse(line));
}

function expectedLaunchEvents(root) {
  return [
    { command: "npm", event: "ci", args: ["ci"], cwd: root },
    { command: "npm", event: "build", args: ["--workspace", "@offline-woodpecker/trainer", "run", "build"], cwd: root },
    { command: "npm", event: "preview", args: ["--workspace", "@offline-woodpecker/trainer", "run", "preview", "--", "--strictPort"], cwd: root },
    { command: "cloudflared", args: ["tunnel", "--url", "http://127.0.0.1:4174", "--http-host-header", "localhost"], cwd: root },
  ];
}

it.skipIf(!canUsePreviewPort)("prints the Quick Tunnel URL and leaves the Trainer preview running", async () => {
  const harness = await createHarness();
  try {
    const result = await runCli(harness, ["--install-trainer"]);

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("https://trainer-test.trycloudflare.com");

    const response = await waitForTrainerPreview();
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("<title>Woodpecker Trainer</title>");
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(await readEvents(harness)).toEqual(expectedLaunchEvents(harness.root));
  } finally {
    await runCli(harness, ["--shutdown-trainer"]);
    await harness.dispose();
  }
}, 30_000);

it("prints the supported Trainer command flags for an unknown action", async () => {
  const harness = await createHarness();
  try {
    const result = await runCli(harness, ["--install-mobile"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Usage: ./offline-woodpecker --install-trainer | --shutdown-trainer");
  } finally {
    await harness.dispose();
  }
}, 30_000);

it.skipIf(!canUsePreviewPort)("recognizes npm's normalized preview process command", async () => {
  const harness = await createHarness({ normalizedPreviewCommand: true });
  try {
    const start = await runCli(harness, ["--install-trainer"]);
    expect(start.code, start.stderr).toBe(0);
    expect(start.stdout).toContain("https://trainer-test.trycloudflare.com");
    expect((await waitForTrainerPreview()).status).toBe(200);

    const shutdown = await runCli(harness, ["--shutdown-trainer"]);
    expect(shutdown.code).toBe(0);
    await waitForPreviewToStop();
  } finally {
    await runCli(harness, ["--shutdown-trainer"]);
    await harness.dispose();
  }
}, 30_000);

it.skipIf(!canUsePreviewPort)("waits through npm's transient preview command transition", async () => {
  const harness = await createHarness({ transientPreviewCommand: true });
  try {
    const start = await runCli(harness, ["--install-trainer"]);
    expect(start.code, start.stderr).toBe(0);
    expect(start.stdout).toContain("https://trainer-test.trycloudflare.com");
    expect((await waitForTrainerPreview()).status).toBe(200);

    const shutdown = await runCli(harness, ["--shutdown-trainer"]);
    expect(shutdown.code).toBe(0);
    await waitForPreviewToStop();
  } finally {
    await runCli(harness, ["--shutdown-trainer"]);
    await harness.dispose();
  }
}, 30_000);

it.skipIf(!canUsePreviewPort)("tracks a launched process group before its command is recognizable", async () => {
  const harness = await createHarness({ unrecognizedPreviewCommand: true });
  try {
    const start = await runCli(harness, ["--install-trainer"]);
    expect(start.code, start.stderr).toBe(0);
    expect(start.stdout).toContain("https://trainer-test.trycloudflare.com");
    expect((await waitForTrainerPreview()).status).toBe(200);

    const shutdown = await runCli(harness, ["--shutdown-trainer"]);
    expect(shutdown.code).toBe(0);
    await waitForPreviewToStop();
  } finally {
    await runCli(harness, ["--shutdown-trainer"]);
    await harness.dispose();
  }
}, 30_000);

it.skipIf(!canUsePreviewPort)("tracks a surviving Vite child when npm exits before capture", async () => {
  const harness = await createHarness({ npmExitsAfterPreviewSpawn: true });
  try {
    const start = await runCli(harness, ["--install-trainer"]);
    expect(start.code, start.stderr).toBe(0);
    expect(start.stdout).toContain("https://trainer-test.trycloudflare.com");
    expect((await waitForTrainerPreview()).status).toBe(200);

    const previewPid = Number(await readFile(join(dirname(harness.command), "preview.pid"), "utf8"));
    const shutdown = await runCli(harness, ["--shutdown-trainer"]);
    expect(shutdown.code).toBe(0);
    await waitForPreviewToStop();
    await waitForProcessToStop(previewPid);
  } finally {
    await runCli(harness, ["--shutdown-trainer"]);
    await harness.dispose();
  }
}, 30_000);

it.skipIf(!canUsePreviewPort)("reuses a healthy Trainer session without starting another tunnel", async () => {
  const harness = await createHarness();
  try {
    const first = await runCli(harness, ["--install-trainer"]);
    const second = await runCli(harness, ["--install-trainer"]);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("https://trainer-test.trycloudflare.com");
    expect(await readEvents(harness)).toEqual(expectedLaunchEvents(harness.root));
    expect((await waitForTrainerPreview()).status).toBe(200);
  } finally {
    await runCli(harness, ["--shutdown-trainer"]);
    await harness.dispose();
  }
}, 30_000);

it.skipIf(!canUsePreviewPort)("stops the preview and tunnel, and treats repeated shutdown as a no-op", async () => {
  const harness = await createHarness({ tunnelIgnoresTerm: true });
  try {
    const start = await runCli(harness, ["--install-trainer"]);
    expect(start.code).toBe(0);

    const previewPid = Number(await readFile(join(dirname(harness.command), "preview.pid"), "utf8"));
    const tunnelPid = Number(await readFile(join(dirname(harness.command), "tunnel.pid"), "utf8"));
    const stop = await runCli(harness, ["--shutdown-trainer"]);
    expect(stop.code).toBe(0);
    expect(stop.stdout).toContain("Stopped the Trainer mobile-install session.");

    await waitForPreviewToStop();
    await waitForProcessToStop(previewPid);
    await waitForProcessToStop(tunnelPid);

    const repeatedStop = await runCli(harness, ["--shutdown-trainer"]);
    expect(repeatedStop.code).toBe(0);
    expect(repeatedStop.stdout).toContain("No active Trainer mobile-install session.");
  } finally {
    await runCli(harness, ["--shutdown-trainer"]);
    await harness.dispose();
  }
}, 30_000);

it.skipIf(!canUsePreviewPort)("stops the preview even when the tunnel group cannot be verified", async () => {
  const harness = await createHarness({ tunnelBecomesUnrecognized: true });
  try {
    const start = await runCli(harness, ["--install-trainer"]);
    expect(start.code).toBe(0);
    const previewPid = Number(await readFile(join(dirname(harness.command), "preview.pid"), "utf8"));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));

    const shutdown = await runCli(harness, ["--shutdown-trainer"]);
    expect(shutdown.code).not.toBe(0);
    expect(shutdown.stderr).toContain("Could not verify the managed tunnel process group");
    await waitForPreviewToStop();
    await waitForProcessToStop(previewPid);
    await expect(readFile(join(harness.root, ".offline-woodpecker/trainer-mobile-session.json"), "utf8"))
      .resolves.toContain('"status":"active"');
  } finally {
    await runCli(harness, ["--shutdown-trainer"]);
    await harness.dispose();
  }
}, 30_000);

it.skipIf(!canUsePreviewPort)("refuses an occupied preview port without stopping or tunneling to its listener", async () => {
  const harness = await createHarness();
  const html = '<!doctype html><html><head><title>Woodpecker Trainer</title><link rel="manifest" href="/manifest.webmanifest"><script type="module" src="/assets/trainer.js"></script></head><body><div id="root"></div></body></html>';
  const unrelatedListener = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });

  await listen(unrelatedListener, previewPort);
  try {
    const result = await runCli(harness, ["--install-trainer"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`port ${previewPort} is already in use`);

    const response = await fetch(`http://127.0.0.1:${previewPort}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>Woodpecker Trainer</title>");
    await expect(readFile(harness.eventsFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await close(unrelatedListener);
    await runCli(harness, ["--shutdown-trainer"]);
    await harness.dispose();
  }
}, 30_000);

it.skipIf(!canUsePreviewPort)("cleans up the preview when cloudflared fails after launch", async () => {
  const harness = await createHarness({ tunnelFails: true });
  try {
    const result = await runCli(harness, ["--install-trainer"]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Logs:");
    expect(result.stderr).toContain(".offline-woodpecker");
    expect(result.stderr).toContain("-preview.log");
    expect(result.stderr).toContain("-cloudflared.log");
    expect(await readEvents(harness)).toEqual(expectedLaunchEvents(harness.root));

    const previewPid = Number(await readFile(join(dirname(harness.command), "preview.pid"), "utf8"));
    const tunnelPid = Number(await readFile(join(dirname(harness.command), "tunnel.pid"), "utf8"));
    await waitForPreviewToStop();
    await waitForProcessToStop(previewPid);
    await waitForProcessToStop(tunnelPid);

    const stop = await runCli(harness, ["--shutdown-trainer"]);
    expect(stop.stdout).toContain("No active Trainer mobile-install session.");
  } finally {
    await runCli(harness, ["--shutdown-trainer"]);
    await harness.dispose();
  }
}, 30_000);

it.skipIf(!canUsePreviewPort)("cleans a launched preview if process-group capture fails", async () => {
  const harness = await createHarness({ psFailureOnCall: 3 });
  try {
    const result = await runCli(harness, ["--install-trainer"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("simulated ps outage");
    await waitForPreviewToStop();
  } finally {
    await runCli(harness, ["--shutdown-trainer"]);
    await harness.dispose();
  }
}, 30_000);

it.skipIf(!canUsePreviewPort)("retries a transient process-table failure during launch capture", async () => {
  const harness = await createHarness({ psFailureOnCall: 2 });
  try {
    const start = await runCli(harness, ["--install-trainer"]);
    expect(start.code, start.stderr).toBe(0);
    expect(start.stdout).toContain("https://trainer-test.trycloudflare.com");

    const shutdown = await runCli(harness, ["--shutdown-trainer"]);
    expect(shutdown.code).toBe(0);
    await waitForPreviewToStop();
  } finally {
    await runCli(harness, ["--shutdown-trainer"]);
    await harness.dispose();
  }
}, 30_000);

it.skipIf(!canUsePreviewPort)("retains a pending session when process inspection stays unavailable", async () => {
  const harness = await createHarness({ psFailureForCaptureMs: 5_000 });
  try {
    const start = await runCli(harness, ["--install-trainer"]);
    expect(start.code).not.toBe(0);
    expect(start.stderr).toContain("Cleanup also failed");
    const statePath = join(harness.root, ".offline-woodpecker/trainer-mobile-session.json");
    await expect(readFile(statePath, "utf8")).resolves.toContain('"status":"starting"');

    const captureStartedAt = Number(await readFile(join(harness.root, "ps-capture-started-at"), "utf8"));
    const waitForPsRecovery = Math.max(0, 5_100 - (Date.now() - captureStartedAt));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, waitForPsRecovery));
    const shutdown = await runCli(harness, ["--shutdown-trainer"]);
    expect(shutdown.code, shutdown.stderr).toBe(0);
    await waitForPreviewToStop();
  } finally {
    await runCli(harness, ["--shutdown-trainer"]);
    await harness.dispose();
  }
}, 30_000);

it("checks for cloudflared before installing or building dependencies", async () => {
  const harness = await createHarness({ cloudflaredAvailable: false });
  try {
    const result = await runCli(harness, ["--install-trainer"]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("cloudflared is required");
    await expect(readFile(harness.eventsFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await runCli(harness, ["--shutdown-trainer"]);
    await harness.dispose();
  }
}, 30_000);

it.skipIf(!canUsePreviewPort)("cleans a stale partial session before starting a fresh one", async () => {
  const harness = await createHarness();
  try {
    const first = await runCli(harness, ["--install-trainer"]);
    expect(first.code).toBe(0);
    const firstTunnelPid = Number(await readFile(join(dirname(harness.command), "tunnel.pid"), "utf8"));
    process.kill(firstTunnelPid, "SIGTERM");
    await waitForProcessToStop(firstTunnelPid);

    const second = await runCli(harness, ["--install-trainer"]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("https://trainer-test.trycloudflare.com");
    const events = await readEvents(harness);
    expect(events).toEqual([
      ...expectedLaunchEvents(harness.root),
      ...expectedLaunchEvents(harness.root),
    ]);
    expect((await waitForTrainerPreview()).status).toBe(200);
  } finally {
    await runCli(harness, ["--shutdown-trainer"]);
    await harness.dispose();
  }
}, 30_000);
