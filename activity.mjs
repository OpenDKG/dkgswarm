import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";

const allowedTools = new Set(["graph_info", "query_graph", "search_graph", "get_posting_context", "get_swarm_policy", "write_working_memory", "enable_writer_access", "share_to_swm", "list_contexts", "join_context", "list_collective_pushes", "get_network_stats"]);

export function trackToolOutcome(authStore, handler) {
  return async (...args) => {
    const context = authStore.getStore();
    if (context) context.toolOk = false;
    const result = await handler(...args);
    if (context) context.toolOk = result?.isError !== true;
    return result;
  };
}

/** Raw rows are kept this long (covers the 7-day window); older rows are folded into daily roll-ups. */
export const RAW_RETENTION_MS = 8 * 24 * 3600000;
const ROLLUP_EVERY_MS = 3600000;
const SNAPSHOT_TTL_MS = 60000;
const DATA_TOOLS = "('query_graph','search_graph','get_posting_context','write_working_memory')";

export function createActivity(path = process.env.DKG_MCP_ACTIVITY_STORE || "/root/dkg-public-mcp/data/activity.sqlite", options = {}) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, graph TEXT NOT NULL,
      installation TEXT NOT NULL, tool TEXT NOT NULL, ok INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS activity_at ON activity(at);
    CREATE INDEX IF NOT EXISTS activity_installation_at ON activity(installation,at);
    CREATE TABLE IF NOT EXISTS activity_daily (day TEXT NOT NULL, installation TEXT NOT NULL, tool TEXT NOT NULL,
      ok INTEGER NOT NULL, outcome_known INTEGER NOT NULL, calls INTEGER NOT NULL,
      PRIMARY KEY (day, installation, tool, ok, outcome_known));`);
  if (!db.prepare("PRAGMA table_info(activity)").all().some(column => column.name === "outcome_known")) {
    db.exec("ALTER TABLE activity ADD COLUMN outcome_known INTEGER NOT NULL DEFAULT 0");
  }
  const insert = db.prepare("INSERT INTO activity(at,graph,installation,tool,ok,outcome_known) VALUES(?,?,?,?,?,1)");
  const aggregate = `COUNT(DISTINCT installation) AS connectedInstallations, COALESCE(SUM(calls), 0) AS toolCalls,
    SUM(CASE WHEN tool IN ('query_graph','search_graph','get_posting_context') THEN calls ELSE 0 END) AS queries,
    SUM(CASE WHEN tool = 'write_working_memory' THEN calls ELSE 0 END) AS contributionAttempts,
    SUM(CASE WHEN outcome_known = 1 AND ok = 1 THEN calls ELSE 0 END) AS successfulToolCalls,
    SUM(CASE WHEN outcome_known = 1 AND ok = 0 THEN calls ELSE 0 END) AS failedToolCalls,
    SUM(CASE WHEN outcome_known = 0 THEN calls ELSE 0 END) AS unknownOutcomeCalls,
    SUM(CASE WHEN outcome_known = 1 AND ok = 1 AND tool = 'write_working_memory' THEN calls ELSE 0 END) AS successfulDraftSubmissions`;
  const allRows = `(SELECT installation, tool, ok, outcome_known, 1 AS calls, date(at / 1000, 'unixepoch') AS day FROM activity
    UNION ALL SELECT installation, tool, ok, outcome_known, calls, day FROM activity_daily)`;
  const totals = db.prepare(`SELECT ${aggregate} FROM ${allRows}`);
  const recent = db.prepare(`SELECT ${aggregate} FROM (SELECT installation, tool, ok, outcome_known, 1 AS calls FROM activity WHERE at >= ? AND at <= ?)`);
  // "Active" installations: at least one successful data call on at least two distinct days.
  const qualified = db.prepare(`SELECT COUNT(*) AS n FROM (SELECT installation FROM ${allRows}
    WHERE outcome_known = 1 AND ok = 1 AND tool IN ${DATA_TOOLS}
    GROUP BY installation HAVING COUNT(DISTINCT day) >= 2)`);
  const foldOld = db.prepare(`INSERT INTO activity_daily (day, installation, tool, ok, outcome_known, calls)
    SELECT date(at / 1000, 'unixepoch'), installation, tool, ok, outcome_known, COUNT(*) FROM activity WHERE at < ?
    GROUP BY 1, 2, 3, 4, 5
    ON CONFLICT (day, installation, tool, ok, outcome_known) DO UPDATE SET calls = calls + excluded.calls`);
  const deleteOld = db.prepare("DELETE FROM activity WHERE at < ?");
  const normalize = row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value ?? 0]));
  let cached;
  let cachedUntil = 0;
  let lastRollup = 0;

  function rollup(at) {
    const cutoff = at - RAW_RETENTION_MS;
    db.exec("BEGIN IMMEDIATE");
    try {
      foldOld.run(cutoff);
      deleteOld.run(cutoff);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    lastRollup = at;
  }

  return {
    record({ family, tool, graph, ok, at = Date.now() }) {
      if (!family || !allowedTools.has(tool)) return;
      // Writes never invalidate the public snapshot; it refreshes on its own TTL.
      insert.run(at, graph, createHash("sha256").update(family).digest("hex"), tool, ok ? 1 : 0);
    },
    snapshot(at = Date.now()) {
      if (cached && at < cachedUntil) return cached;
      if (at - lastRollup >= ROLLUP_EVERY_MS) rollup(at);
      options.onAggregate?.();
      cached = { period: "since tracking began", updatedAt: new Date(at).toISOString(),
        ...normalize(totals.get()),
        qualifiedInstallations: Number(qualified.get().n ?? 0),
        windows: {
          last24Hours: normalize(recent.get(at - 24 * 3600000, at)),
          last7Days: normalize(recent.get(at - 7 * 24 * 3600000, at)),
        } };
      cachedUntil = at + SNAPSHOT_TTL_MS;
      return cached;
    },
    close() { db.close(); },
  };
}
