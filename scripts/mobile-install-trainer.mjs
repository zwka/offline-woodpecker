import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readlinkSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE = "@offline-woodpecker/trainer";
const HOST = "127.0.0.1";
const PORT = 4174;
const PREVIEW_START_TIMEOUT_MS = 30_000;
const PREVIEW_GROUP_HANDOFF_GRACE_MS = 1_000;
const TUNNEL_START_TIMEOUT_MS = 60_000;
const SHUTDOWN_GRACE_MS = 1_500;
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i;

const paths = {
  stateDirectory: join(ROOT, ".offline-woodpecker"),
  state: join(ROOT, ".offline-woodpecker", "trainer-mobile-session.json"),
  lock: join(ROOT, ".offline-woodpecker", "trainer-mobile.lock"),
};

export async function main(args) {
  if (args.length !== 1 || !["--install-trainer", "--shutdown-trainer"].includes(args[0])) {
    throw new Error("Usage: ./offline-woodpecker --install-trainer | --shutdown-trainer");
  }
  if (!new Set(["darwin", "linux"]).has(process.platform)) {
    throw new Error("The Trainer mobile-install command supports macOS and Linux.");
  }

  const releaseLock = await acquireLock();
  try {
    if (args[0] === "--shutdown-trainer") {
      await shutdownTrainer();
      return;
    }

    await installTrainer();
  } finally {
    releaseLock();
  }
}

async function installTrainer() {
  const existingSession = readSession();
  if (existingSession) {
    if (await isHealthySession(existingSession)) {
      console.log(`Trainer install URL: ${existingSession.url}`);
      return;
    }

    await stopSession(existingSession);
    removeFile(paths.state);
  }

  const session = {
    version: 1,
    id: randomUUID(),
    root: ROOT,
    status: "starting",
    url: null,
    preview: null,
    tunnel: null,
  };

  try {
    assertCloudflaredInstalled();
    await assertPreviewPortAvailable();
    runForeground("npm", ["ci"]);
    runForeground("npm", ["--workspace", WORKSPACE, "run", "build"]);

    session.preview = await startManagedProcess(
      "npm",
      ["--workspace", WORKSPACE, "run", "preview", "--", "--strictPort"],
      "preview",
      sessionLogPath(session, "preview"),
      (identity) => {
        session.preview = identity;
        writeSession(session);
      },
    );
    writeSession(session);
    await waitForPreview(session);

    session.tunnel = await startManagedProcess(
      "cloudflared",
      ["tunnel", "--url", `http://${HOST}:${PORT}`, "--http-host-header", "localhost"],
      "tunnel",
      sessionLogPath(session, "tunnel"),
      (identity) => {
        session.tunnel = identity;
        writeSession(session);
      },
    );
    writeSession(session);
    session.url = await waitForTunnel(session);

    session.status = "active";
    writeSession(session);
    console.log(`Trainer install URL: ${session.url}`);
  } catch (error) {
    if (session.preview || session.tunnel) {
      const startupError = error instanceof Error ? error.message : String(error);
      try {
        await stopSession(session);
      } catch (cleanupError) {
        const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new Error([
          startupError,
          `Cleanup also failed: ${cleanupMessage}`,
          "Retry with ./offline-woodpecker --shutdown-trainer.",
          `Logs: ${sessionLogPath(session, "preview")} and ${sessionLogPath(session, "tunnel")}`,
        ].join("\n"));
      }
      removeFile(paths.state);
      throw new Error(`${startupError}\nLogs: ${sessionLogPath(session, "preview")} and ${sessionLogPath(session, "tunnel")}`);
    }

    removeFile(paths.state);
    throw error;
  }
}

async function shutdownTrainer() {
  const session = readSession();
  if (!session) {
    console.log("No active Trainer mobile-install session.");
    return;
  }

  await stopSession(session);
  removeFile(paths.state);
  console.log("Stopped the Trainer mobile-install session.");
}

async function isHealthySession(session) {
  if (!isValidSession(session) || session.status !== "active" || !QUICK_TUNNEL_URL.test(session.url ?? "")) {
    return false;
  }

  if (!(await refreshManagedGroup(session.preview)) || !(await refreshManagedGroup(session.tunnel))) {
    return false;
  }

  const previewLog = readLog(sessionLogPath(session, "preview"));
  if (!hasPreviewReadyLine(previewLog) || !(await servesTrainerApp())) return false;
  writeSession(session);
  return true;
}

async function waitForPreview(session) {
  const deadline = Date.now() + PREVIEW_START_TIMEOUT_MS;
  let emptyGroupSince = null;
  while (Date.now() < deadline) {
    if (!(await refreshManagedGroup(session.preview))) {
      const leaderAlive = sameManagedLeaderIsAlive(session.preview);
      const groupAlive = managedGroupIsAlive(session.preview);
      if (!leaderAlive && !groupAlive) {
        emptyGroupSince ??= Date.now();
        if (Date.now() - emptyGroupSince >= PREVIEW_GROUP_HANDOFF_GRACE_MS) {
          throw new Error("The managed Trainer preview process exited before becoming ready.");
        }
      } else {
        emptyGroupSince = null;
      }
      writeSession(session);
      await delay(150);
      continue;
    }
    emptyGroupSince = null;

    const ready = hasPreviewReadyLine(readLog(sessionLogPath(session, "preview")));
    if (ready && await servesTrainerApp()) {
      writeSession(session);
      return;
    }
    writeSession(session);
    await delay(150);
  }

  throw new Error(`Trainer preview did not become ready on ${HOST}:${PORT}.`);
}

async function waitForTunnel(session) {
  const deadline = Date.now() + TUNNEL_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!(await refreshManagedGroup(session.tunnel))) {
      if (sameManagedLeaderIsAlive(session.tunnel)) {
        writeSession(session);
        await delay(200);
        continue;
      }
      throw new Error("cloudflared exited before publishing a Quick Tunnel URL.");
    }

    const match = readLog(sessionLogPath(session, "tunnel")).match(QUICK_TUNNEL_URL);
    if (match) return match[0];
    writeSession(session);
    await delay(200);
  }

  throw new Error("cloudflared did not publish a Quick Tunnel URL before the startup timeout.");
}

async function servesTrainerApp() {
  try {
    const response = await fetch(`http://${HOST}:${PORT}/`, { signal: AbortSignal.timeout(1_000) });
    if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) return false;

    const html = await response.text();
    return html.includes("<title>Woodpecker Trainer</title>")
      && /<div\s+id=["']root["']\s*>/i.test(html)
      && /rel=["']manifest["'][^>]+href=["']\/manifest\.webmanifest["']/i.test(html)
      && /<script[^>]+src=["']\/assets\/[^"']+\.js["']/i.test(html);
  } catch {
    return false;
  }
}

function hasPreviewReadyLine(log) {
  return /Local:\s+http:\/\/127\.0\.0\.1:4174\//.test(log);
}

function assertCloudflaredInstalled() {
  const result = spawnSync("cloudflared", ["--version"], {
    cwd: ROOT,
    stdio: "ignore",
  });
  if (result.error || result.status !== 0) {
    throw new Error("cloudflared is required. Install cloudflared, then run this command again.");
  }
}

function runForeground(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit" });
  if (result.error) throw new Error(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const reason = result.signal ? `signal ${result.signal}` : `exit code ${result.status}`;
    throw new Error(`${command} ${args.join(" ")} failed with ${reason}.`);
  }
}

function assertPreviewPortAvailable() {
  return new Promise((resolveResult, rejectResult) => {
    const server = createServer();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        rejectResult(new Error(`Trainer preview port ${PORT} is already in use; no process was stopped and no tunnel was started.`));
      } else {
        rejectResult(error);
      }
    });
    server.listen({ host: HOST, port: PORT, exclusive: true }, () => {
      server.close((error) => error ? rejectResult(error) : resolveResult());
    });
  });
}

async function startManagedProcess(command, args, type, logPath, onIdentityCaptured) {
  const logDescriptor = openSync(logPath, "w", 0o600);
  let child;
  try {
    child = spawn(command, args, {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", logDescriptor, logDescriptor],
      env: process.env,
    });
  } finally {
    closeSync(logDescriptor);
  }

  const spawnedAtMs = await new Promise((resolveSpawn, rejectSpawn) => {
    child.once("spawn", () => resolveSpawn(Date.now()));
    child.once("error", rejectSpawn);
  });
  child.unref();

  return captureManagedGroup(child.pid, type, spawnedAtMs, onIdentityCaptured);
}

async function captureManagedGroup(pid, type, spawnedAtMs, onIdentityCaptured) {
  onIdentityCaptured({
    type,
    pid,
    pgid: pid,
    leaderStartedAt: null,
    spawnedAtMs,
    members: [],
  });

  const deadline = Date.now() + 3_000;
  let inspectionError;
  while (Date.now() < deadline) {
    let processes;
    try {
      processes = listProcesses();
    } catch (error) {
      inspectionError = error;
      await delay(50);
      continue;
    }

    const group = processes.filter((entry) => entry.pgid === pid && isRunningProcess(entry));
    if (group.length > 0) {
      const leader = group.find((entry) => entry.pid === pid);
      const identity = {
        type,
        pid,
        pgid: pid,
        leaderStartedAt: leader?.startedAt ?? null,
        spawnedAtMs,
        members: group.map((entry) => ({ pid: entry.pid, startedAt: entry.startedAt })),
      };
      onIdentityCaptured(identity);
      await refreshManagedGroup(identity);
      return identity;
    }
    await delay(50);
  }

  if (inspectionError) {
    throw new Error(`Could not inspect the managed ${type} process group: ${inspectionError.message}`);
  }
  throw new Error(`Could not verify the managed ${type} process group.`);
}

function refreshManagedGroup(identity) {
  if (!isValidIdentity(identity)) {
    return false;
  }

  const table = listProcesses();
  const group = table.filter((entry) => entry.pgid === identity.pgid && isRunningProcess(entry));
  if (group.length === 0) return false;

  const leader = table.find((entry) => entry.pid === identity.pid);
  let verifiedLeader = false;
  if (leader) {
    if (leader.pgid !== identity.pgid) return false;
    if (identity.leaderStartedAt === null && isRunningProcess(leader)) {
      if (!isExpectedProcess(identity.type, leader.command)
        || !processStartTimeMatches(leader.startedAt, identity.spawnedAtMs)) {
        return false;
      }
      identity.leaderStartedAt = leader.startedAt;
    } else if (identity.leaderStartedAt !== null && leader.startedAt !== identity.leaderStartedAt) {
      return false;
    }
    verifiedLeader = identity.leaderStartedAt !== null
      && isRunningProcess(leader)
      && isExpectedProcess(identity.type, leader.command);
  }

  const fingerprints = group.map((entry) => ({ pid: entry.pid, startedAt: entry.startedAt }));

  for (const fingerprint of fingerprints) {
    if (!fingerprint.startedAt) continue;
    if (!identity.members.some((member) => member.pid === fingerprint.pid && member.startedAt === fingerprint.startedAt)) {
      identity.members.push(fingerprint);
    }
  }

  const verifiedMember = identity.members.some((member) => group.some((entry) => (
    entry.pid === member.pid
      && entry.startedAt === member.startedAt
      && isExpectedProcess(identity.type, entry.command)
  )));
  return verifiedLeader || verifiedMember;
}

function sameManagedLeaderIsAlive(identity) {
  if (!isValidIdentity(identity)) return false;
  const leader = listProcesses().find((entry) => entry.pid === identity.pid);
  return Boolean(leader
    && leader.pgid === identity.pgid
    && (identity.leaderStartedAt === null
      ? processStartTimeMatches(leader.startedAt, identity.spawnedAtMs)
      : leader.startedAt === identity.leaderStartedAt)
    && isRunningProcess(leader));
}

function processStartTimeMatches(startedAt, spawnedAtMs) {
  const processStartedAt = Date.parse(startedAt);
  return Number.isFinite(processStartedAt) && Math.abs(processStartedAt - spawnedAtMs) <= 2_000;
}

function listProcesses() {
  const result = spawnSync("ps", ["-A", "-o", "pid=", "-o", "pgid=", "-o", "stat=", "-o", "lstart=", "-o", "command="], {
    encoding: "utf8",
    maxBuffer: 5 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Could not inspect managed processes with ps: ${result.error?.message ?? result.stderr}`);
  }

  return result.stdout.split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 9 || !/^\d+$/.test(fields[0]) || !/^\d+$/.test(fields[1])) return [];
    return [{
      pid: Number(fields[0]),
      pgid: Number(fields[1]),
      state: fields[2],
      startedAt: fields.slice(3, 8).join(" "),
      command: fields.slice(8).join(" "),
    }];
  });
}

function isRunningProcess(entry) {
  return !entry.state.startsWith("Z");
}

function isExpectedProcess(type, command) {
  if (type === "preview") {
    return /@offline-woodpecker\/trainer run preview\b/.test(command)
      || /\bnpm run preview\b/.test(command)
      || /vite(?:\.js)?\s+preview\b/.test(command);
  }
  return /(?:^|\/)cloudflared(?:\s|$)/.test(command) && /\btunnel\b/.test(command);
}

async function stopSession(session) {
  if (!isValidSession(session)) return;
  const errors = [];
  for (const identity of [session.tunnel, session.preview]) {
    try {
      await stopManagedGroup(identity);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
}

async function stopManagedGroup(identity) {
  const verified = await waitForVerifiedManagedGroup(identity, 3_000);
  if (!verified) {
    if (managedGroupIsAlive(identity)) {
      throw new Error(`Could not verify the managed ${identity.type} process group; no signal was sent.`);
    }
    return;
  }

  signalManagedGroup(identity, "SIGTERM");
  const deadline = Date.now() + SHUTDOWN_GRACE_MS;
  while (Date.now() < deadline && managedGroupIsAlive(identity)) {
    await delay(100);
  }
  if (!managedGroupIsAlive(identity)) return;

  if (!(await waitForVerifiedManagedGroup(identity, 1_000))) {
    throw new Error(`Could not verify the managed ${identity.type} process group after SIGTERM.`);
  }

  signalManagedGroup(identity, "SIGKILL");
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline && managedGroupIsAlive(identity)) await delay(100);
  if (managedGroupIsAlive(identity)) {
    throw new Error(`Could not stop the managed ${identity.type} process group ${identity.pgid} with SIGKILL.`);
  }
}

async function waitForVerifiedManagedGroup(identity, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await refreshManagedGroup(identity)) return true;
    if (!managedGroupIsAlive(identity) || Date.now() >= deadline) return false;
    await delay(100);
  }
}

function managedGroupIsAlive(identity) {
  if (!isValidIdentity(identity)) return false;
  return listProcesses().some((entry) => entry.pgid === identity.pgid && isRunningProcess(entry));
}

function signalManagedGroup(identity, signal) {
  if (!isValidIdentity(identity)) return;
  try {
    process.kill(-identity.pgid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function readSession() {
  if (!existsSync(paths.state)) return null;
  try {
    const session = JSON.parse(readFileSync(paths.state, "utf8"));
    if (isValidSession(session)) return session;
  } catch {
    // An invalid or interrupted state file is never trusted for signaling.
  }
  removeFile(paths.state);
  return null;
}

function isValidSession(session) {
  return session?.version === 1
    && typeof session.id === "string"
    && /^[0-9a-f-]{36}$/i.test(session.id)
    && session.root === ROOT
    && ["starting", "active"].includes(session.status)
    && (session.preview === null || isValidIdentity(session.preview))
    && (session.tunnel === null || isValidIdentity(session.tunnel));
}

function isValidIdentity(identity) {
  return identity
    && ["preview", "tunnel"].includes(identity.type)
    && Number.isInteger(identity.pid)
    && identity.pgid === identity.pid
    && (identity.leaderStartedAt === null || typeof identity.leaderStartedAt === "string")
    && Number.isSafeInteger(identity.spawnedAtMs)
    && Array.isArray(identity.members)
    && identity.members.every((member) => Number.isInteger(member.pid)
      && typeof member.startedAt === "string");
}

function writeSession(session) {
  mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${paths.state}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(session), { flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, paths.state);
  } finally {
    removeFile(temporaryPath);
  }
}

function sessionLogPath(session, type) {
  const suffix = type === "preview" ? "preview" : "cloudflared";
  return join(paths.stateDirectory, `trainer-${session.id}-${suffix}.log`);
}

function readLog(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function removeFile(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function acquireLock() {
  mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
  const processTable = listProcesses();
  const launcherProcess = processTable.find((entry) => entry.pid === process.pid);
  const owner = {
    pid: process.pid,
    startedAt: launcherProcess?.startedAt,
  };
  if (!owner.startedAt) {
    throw new Error(`Could not identify launcher process ${process.pid} with ps (${processTable.length} process records).`);
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      symlinkSync(JSON.stringify(owner), paths.lock);
      return () => releaseLock(owner);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await delay(50);
      const existing = readLockOwner();
      if (!existing) throw new Error(`Cannot verify the existing Trainer launcher lock at ${paths.lock}.`);
      if (listProcesses().some((entry) => entry.pid === existing.pid && entry.startedAt === existing.startedAt)) {
        throw new Error("Another Trainer mobile-install command is already running in this workspace.");
      }
      removeFile(paths.lock);
    }
  }

  throw new Error("Could not acquire the Trainer mobile-install workspace lock.");
}

function readLockOwner() {
  try {
    const owner = JSON.parse(readlinkSync(paths.lock, "utf8"));
    if (Number.isInteger(owner.pid) && typeof owner.startedAt === "string") return owner;
  } catch {
    return null;
  }
  return null;
}

function releaseLock(owner) {
  const current = readLockOwner();
  if (current?.pid === owner.pid && current.startedAt === owner.startedAt) removeFile(paths.lock);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
