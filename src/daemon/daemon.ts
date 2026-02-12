#!/usr/bin/env node
/**
 * Spawner daemon entry point — runs as a detached background process.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { startSpawner, stopSpawner } from "./spawner.js";

const pidDir = path.join(os.homedir(), ".openclaw", "antfarm");
const pidFile = path.join(pidDir, "spawner.pid");

fs.mkdirSync(pidDir, { recursive: true });
fs.writeFileSync(pidFile, String(process.pid));

process.on("SIGTERM", () => {
  stopSpawner();
  try { fs.unlinkSync(pidFile); } catch {}
  process.exit(0);
});

process.on("SIGINT", () => {
  stopSpawner();
  try { fs.unlinkSync(pidFile); } catch {}
  process.exit(0);
});

startSpawner();
