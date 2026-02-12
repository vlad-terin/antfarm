/**
 * Event-driven session spawner daemon.
 *
 * Polls the Antfarm SQLite DB every 30s for pending steps in running runs.
 * When work is found, spawns an isolated OpenClaw agent session via the
 * gateway HTTP API — no LLM cost for polling.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDb } from "../db.js";
import { resolveAntfarmCli } from "../installer/paths.js";

const POLL_INTERVAL_MS = 30_000;

interface PendingStep {
  id: string;
  agent_id: string;
  step_id: string;
  run_id: string;
}

interface GatewayConfig {
  url: string;
  token?: string;
}

/** Active sessions keyed by step id to avoid double-spawning. */
const activeSessions = new Map<string, { sessionId?: string; spawnedAt: number }>();

/** Session TTL — clear tracking after 20 minutes (step will be reclaimed by abandoned cleanup). */
const SESSION_TTL_MS = 20 * 60 * 1000;

function log(msg: string): void {
  const ts = new Date().toISOString();
  process.stdout.write(`[${ts}] ${msg}\n`);
}

function readGatewayConfig(): GatewayConfig {
  const configPath = path.join(os.homedir(), ".openclaw", "openclaw.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const port = config.gateway?.port ?? 18789;
    return {
      url: `http://127.0.0.1:${port}`,
      token: config.gateway?.auth?.token,
    };
  } catch {
    return { url: "http://127.0.0.1:18789" };
  }
}

function buildAgentPrompt(workflowId: string, agentId: string): string {
  const fullAgentId = `${workflowId}/${agentId}`;
  const cli = resolveAntfarmCli();

  return `You are an Antfarm workflow agent. Check for pending work and execute it.

⚠️ CRITICAL: You MUST call "step complete" or "step fail" before ending your session. If you don't, the workflow will be stuck forever. This is non-negotiable.

Step 1 — Check for pending work:
\`\`\`
node ${cli} step claim "${fullAgentId}"
\`\`\`

If output is "NO_WORK", reply HEARTBEAT_OK and stop.

Step 2 — If JSON is returned, it contains: {"stepId": "...", "runId": "...", "input": "..."}
Save the stepId — you'll need it to report completion.
The "input" field contains your FULLY RESOLVED task instructions. Read it carefully and DO the work.

Step 3 — Do the work described in the input. Format your output with KEY: value lines as specified.

Step 4 — MANDATORY: Report completion (do this IMMEDIATELY after finishing the work):
\`\`\`
cat <<'ANTFARM_EOF' > /tmp/antfarm-step-output.txt
STATUS: done
CHANGES: what you did
TESTS: what tests you ran
ANTFARM_EOF
cat /tmp/antfarm-step-output.txt | node ${cli} step complete "<stepId>"
\`\`\`

If the work FAILED:
\`\`\`
node ${cli} step fail "<stepId>" "description of what went wrong"
\`\`\`

RULES:
1. NEVER end your session without calling step complete or step fail
2. Write output to a file first, then pipe via stdin (shell escaping breaks direct args)
3. If you're unsure whether to complete or fail, call step fail with an explanation

The workflow cannot advance until you report. Your session ending without reporting = broken pipeline.`;
}

/**
 * Query the DB for pending steps that need work.
 */
function findPendingSteps(): PendingStep[] {
  const db = getDb();
  return db.prepare(
    `SELECT s.id, s.agent_id, s.step_id, s.run_id
     FROM steps s
     JOIN runs r ON s.run_id = r.id
     WHERE s.status = 'pending' AND r.status = 'running'`
  ).all() as unknown as PendingStep[];
}

/**
 * Run abandoned step cleanup (imported logic).
 * We call claimStep with a dummy to trigger cleanup, but that's wasteful.
 * Instead, replicate the cleanup inline from step-ops.
 */
function cleanupAbandonedSteps(): void {
  const ABANDONED_THRESHOLD_MS = 15 * 60 * 1000;
  const db = getDb();
  const cutoff = new Date(Date.now() - ABANDONED_THRESHOLD_MS).toISOString();

  const abandonedSteps = db.prepare(
    "SELECT id, step_id, run_id, retry_count, max_retries FROM steps WHERE status = 'running' AND updated_at < ?"
  ).all(cutoff) as { id: string; step_id: string; run_id: string; retry_count: number; max_retries: number }[];

  for (const step of abandonedSteps) {
    const newRetry = step.retry_count + 1;
    if (newRetry >= step.max_retries) {
      db.prepare(
        "UPDATE steps SET status = 'failed', output = 'Agent abandoned step without completing', retry_count = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(newRetry, step.id);
      db.prepare(
        "UPDATE runs SET status = 'failed', updated_at = datetime('now') WHERE id = ?"
      ).run(step.run_id);
      log(`Step ${step.step_id} (${step.id.slice(0, 8)}) failed — retries exhausted`);
    } else {
      db.prepare(
        "UPDATE steps SET status = 'pending', retry_count = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(newRetry, step.id);
      log(`Step ${step.step_id} (${step.id.slice(0, 8)}) reset to pending (retry ${newRetry})`);
    }
  }

  // Also reset abandoned stories
  const abandonedStories = db.prepare(
    "SELECT id, retry_count, max_retries FROM stories WHERE status = 'running' AND updated_at < ?"
  ).all(cutoff) as { id: string; retry_count: number; max_retries: number }[];

  for (const story of abandonedStories) {
    const newRetry = story.retry_count + 1;
    if (newRetry >= story.max_retries) {
      db.prepare("UPDATE stories SET status = 'failed', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, story.id);
    } else {
      db.prepare("UPDATE stories SET status = 'pending', retry_count = ?, updated_at = datetime('now') WHERE id = ?").run(newRetry, story.id);
    }
  }
}

/**
 * Spawn an OpenClaw agent session via the gateway HTTP API.
 */
async function spawnSession(step: PendingStep): Promise<void> {
  const gateway = readGatewayConfig();

  // Derive workflow ID from agent_id (format: workflowId/agentId)
  const parts = step.agent_id.split("/");
  const workflowId = parts.slice(0, -1).join("/");
  const agentShortId = parts[parts.length - 1];

  const prompt = buildAgentPrompt(workflowId, agentShortId);

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (gateway.token) headers["Authorization"] = `Bearer ${gateway.token}`;

  try {
    // Use chatCompletions endpoint — fire-and-forget
    // The session will run the agent prompt, which calls `step claim` then does work
    const response = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4-20250514",
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      log(`Failed to spawn session for ${step.agent_id} (step ${step.id.slice(0, 8)}): ${response.status} ${text}`);
      activeSessions.delete(step.id);
      return;
    }

    // Consume response body (we don't need it, session already ran)
    await response.text();
    log(`Session completed for ${step.agent_id} step=${step.id.slice(0, 8)}`);
  } catch (err) {
    log(`Error spawning session for ${step.agent_id}: ${err}`);
  }
}

/**
 * Expire stale session tracking entries.
 */
function expireStaleTracking(): void {
  const now = Date.now();
  for (const [stepId, info] of activeSessions) {
    if (now - info.spawnedAt > SESSION_TTL_MS) {
      activeSessions.delete(stepId);
    }
  }
}

/**
 * Single poll cycle.
 */
async function pollCycle(): Promise<void> {
  try {
    // 1. Cleanup abandoned steps
    cleanupAbandonedSteps();

    // 2. Expire stale tracking
    expireStaleTracking();

    // 3. Find pending steps
    const pending = findPendingSteps();

    if (pending.length === 0) return;

    log(`Found ${pending.length} pending step(s)`);

    // 4. Spawn sessions for steps not already tracked
    for (const step of pending) {
      if (activeSessions.has(step.id)) continue;

      // Mark as tracked immediately to prevent double-spawn on next cycle
      activeSessions.set(step.id, { spawnedAt: Date.now() });
      await spawnSession(step);
    }
  } catch (err) {
    log(`Poll cycle error: ${err}`);
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function startSpawner(): void {
  log("Spawner daemon started (polling every 30s)");

  // Run immediately, then on interval
  pollCycle();
  pollTimer = setInterval(pollCycle, POLL_INTERVAL_MS);
}

export function stopSpawner(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  log("Spawner daemon stopped");
}
