/**
 * Spawner daemon lifecycle management (start/stop/status).
 * Mirrors the pattern from src/server/daemonctl.ts.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getSpawnerPidFile(): string {
  return path.join(os.homedir(), ".openclaw", "antfarm", "spawner.pid");
}

export function getSpawnerLogFile(): string {
  return path.join(os.homedir(), ".openclaw", "antfarm", "spawner.log");
}

export function isSpawnerRunning(): { running: true; pid: number } | { running: false } {
  const pidFile = getSpawnerPidFile();
  if (!fs.existsSync(pidFile)) return { running: false };
  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  if (isNaN(pid)) return { running: false };
  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    try { fs.unlinkSync(pidFile); } catch {}
    return { running: false };
  }
}

export async function startSpawnerDaemon(): Promise<{ pid: number }> {
  const status = isSpawnerRunning();
  if (status.running) {
    return { pid: status.pid };
  }

  const logFile = getSpawnerLogFile();
  const pidDir = path.dirname(getSpawnerPidFile());
  fs.mkdirSync(pidDir, { recursive: true });

  const out = fs.openSync(logFile, "a");
  const err = fs.openSync(logFile, "a");

  const daemonScript = path.resolve(__dirname, "daemon.js");
  const child = spawn("node", [daemonScript], {
    detached: true,
    stdio: ["ignore", out, err],
  });
  child.unref();

  // Wait 1s then confirm
  await new Promise((r) => setTimeout(r, 1000));

  const check = isSpawnerRunning();
  if (!check.running) {
    throw new Error("Spawner daemon failed to start. Check " + logFile);
  }
  return { pid: check.pid };
}

export function stopSpawnerDaemon(): boolean {
  const status = isSpawnerRunning();
  if (!status.running) return false;
  try {
    process.kill(status.pid, "SIGTERM");
  } catch {}
  try { fs.unlinkSync(getSpawnerPidFile()); } catch {}
  return true;
}

export function getSpawnerStatus(): { running: boolean; pid?: number } {
  const status = isSpawnerRunning();
  if (!status.running) return { running: false };
  return { running: true, pid: status.pid };
}
