import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { decision, isCollectivePush, pushQueueExpired } from "./collector/curator.mjs";

const execute = promisify(execFile);

export const INTAKE_PATH = process.env.TRAC_CURATOR_INTAKE || "/root/dkg-swarm-webhooks/data/curator-intake.sqlite";

export function enqueueCuratorDraft(name, { filename = INTAKE_PATH } = {}) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS drafts (name TEXT PRIMARY KEY, queued_at TEXT NOT NULL, reviewed_at TEXT);`);
    if (!db.prepare("PRAGMA table_info(drafts)").all().some((column) => column.name === "mode")) db.exec("ALTER TABLE drafts ADD COLUMN mode TEXT NOT NULL DEFAULT 'review'");
    db.prepare(`INSERT INTO drafts (name, queued_at, reviewed_at, mode) VALUES (?, ?, NULL, ?)
      ON CONFLICT(name) DO UPDATE SET queued_at = excluded.queued_at, reviewed_at = NULL, mode = excluded.mode`)
      .run(name, new Date().toISOString(), isCollectivePush(name) ? "delivery" : "review");
  } finally { db.close(); }
}

export async function deliverCollectivePush(name, {
  executeFile = execute,
  scriptPath = process.env.TRAC_CURATOR_SCRIPT || "/root/dkg-swarm-webhooks/curator.mjs",
} = {}) {
  if (!isCollectivePush(name) || !/^[a-zA-Z0-9._-]{1,80}$/.test(name)) throw new Error("invalid collective push name");
  const { stdout } = await executeFile("/usr/bin/flock", ["-w", "5", "/run/lock/trac-marketing-curator.lock",
    process.execPath, scriptPath, "promote-community", name], {
    timeout: 180000, maxBuffer: 1024 * 1024,
  });
  const acknowledgment = stdout.trim().split("\n").map((line) => JSON.parse(line)).findLast((row) => row.promoted);
  if (!acknowledgment) throw new Error("delivery acknowledgment missing");
  return acknowledgment;
}

export async function routeDraft(name, { enqueue = enqueueCuratorDraft, deliver = deliverCollectivePush, trigger = triggerCurator } = {}) {
  enqueue(name);
  if (!isCollectivePush(name)) {
    trigger();
    return { curatorReview: "queued" };
  }
  try {
    return { curatorReview: "bypassed", delivery: "confirmed", acknowledgment: await deliver(name) };
  } catch {
    return { curatorReview: "bypassed", delivery: "retry-queued" };
  }
}

/** Safety cap in addition to the expiry window; a push older than its lifetime is never retried. */
export const MAX_PUSH_DELIVERY_ATTEMPTS = 150;

export async function retryCollectivePushes({ filename = INTAKE_PATH, deliver = deliverCollectivePush, at = Date.now(), reviewFilename, onSnapshot } = {}) {
  if (!fs.existsSync(filename)) return;
  const db = new DatabaseSync(filename);
  let names;
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const columns = db.prepare("PRAGMA table_info(drafts)").all().map((column) => column.name);
    if (!columns.includes("delivery_attempt_at")) db.exec("ALTER TABLE drafts ADD COLUMN delivery_attempt_at TEXT");
    if (!columns.includes("delivery_attempts")) db.exec("ALTER TABLE drafts ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0");
    const pending = db.prepare("SELECT name, queued_at, delivery_attempts FROM drafts WHERE reviewed_at IS NULL ORDER BY COALESCE(delivery_attempt_at, ''), queued_at").all()
      .filter((row) => isCollectivePush(row.name));
    // Expired or exhausted pushes become terminal here and are never retried again.
    // Matches only the row as it was read: not one reviewed or queued again since.
    const retire = db.prepare("UPDATE drafts SET reviewed_at = ? WHERE name = ? AND queued_at = ? AND reviewed_at IS NULL");
    onSnapshot?.();
    const live = [];
    for (const row of pending) {
      const reason = pushQueueExpired(row, at) ? "collective push exceeded its queue lifetime"
        : row.delivery_attempts >= MAX_PUSH_DELIVERY_ATTEMPTS ? "collective push reached the delivery attempt cap" : null;
      if (!reason) { live.push(row); continue; }
      // The audit row is written only if this run retires the push. If it cannot be written,
      // the retirement rolls back and the row stays queued (and undelivered) for the next run.
      try {
        db.exec("BEGIN IMMEDIATE");
        if (retire.run(new Date(at).toISOString(), row.name, row.queued_at).changes === 1) {
          decision("community", row.name, "expired", reason, reviewFilename);
        }
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch {} // BEGIN itself may have failed.
        console.error("collective push retirement not recorded", row.name, error.message);
      }
    }
    names = live.slice(0, 10);
    const attempted = db.prepare("UPDATE drafts SET delivery_attempt_at = ?, delivery_attempts = delivery_attempts + 1 WHERE name = ?");
    for (const { name } of names) attempted.run(new Date(at).toISOString(), name);
  } finally { db.close(); }
  for (const { name } of names) {
    try { await deliver(name); } catch {}
  }
}

export function triggerCurator({ spawnProcess = spawn } = {}) {
  // Always signal: suppressing a second trigger can strand a draft after the
  // first curator run exits. systemd coalesces starts while the unit is active.
  const child = spawnProcess("/usr/bin/systemctl", ["start", "--no-block", "trac-marketing-curator.service"], {
    stdio: "ignore",
  });
  child.on?.("error", (error) => console.error("curator trigger failed", error));
  child.unref?.();
}
