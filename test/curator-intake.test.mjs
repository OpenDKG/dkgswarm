import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { enqueueCuratorDraft, triggerCurator, routeDraft, deliverCollectivePush, retryCollectivePushes, MAX_PUSH_DELIVERY_ATTEMPTS } from "../curator-intake.mjs";
import { decision } from "../collector/curator.mjs";

test("curator intake records each draft once and requeues updated drafts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-intake-"));
  const filename = path.join(dir, "intake.sqlite");
  enqueueCuratorDraft("collective-push-123", { filename });
  const db = new DatabaseSync(filename);
  db.prepare("UPDATE drafts SET reviewed_at = '2026-01-01' WHERE name = 'collective-push-123'").run();
  db.close();
  enqueueCuratorDraft("collective-push-123", { filename });
  const result = new DatabaseSync(filename, { readOnly: true });
  assert.deepEqual(result.prepare("SELECT name, reviewed_at FROM drafts").all().map((row) => ({ ...row })), [{ name: "collective-push-123", reviewed_at: null }]);
  result.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("routing bypasses review only for collective pushes and keeps errors queued", async () => {
  const events = [];
  const dependencies = { enqueue: (name) => events.push(["enqueue", name]),
    trigger: () => events.push(["review"]), deliver: async (name) => { events.push(["deliver", name]); return { promoted: name }; } };
  assert.deepEqual(await routeDraft("ordinary-draft", dependencies), { curatorReview: "queued" });
  assert.deepEqual(events, [["enqueue", "ordinary-draft"], ["review"]]);
  events.length = 0;
  const result = await routeDraft("COLLECTIVE_PUSH-demo", dependencies);
  assert.equal(result.delivery, "confirmed");
  assert.equal(result.curatorReview, "bypassed");
  assert.deepEqual(events, [["enqueue", "COLLECTIVE_PUSH-demo"], ["deliver", "COLLECTIVE_PUSH-demo"]]);
  assert.deepEqual(await routeDraft("collective-push-demo", { ...dependencies, deliver: async () => { throw new Error("DKG unavailable"); } }),
    { curatorReview: "bypassed", delivery: "retry-queued" });
});

test("deterministic delivery uses existing lock without shell or agent", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-script-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scriptPath = path.join(dir, "curator.mjs");
  fs.writeFileSync(scriptPath, "process.exit(0);\n");
  let invocation;
  const result = await deliverCollectivePush("collective-push-demo", { scriptPath, executeFile: async (...args) => {
    invocation = args;
    return { stdout: '{"name":"collective-push-demo"}\n{"promoted":"curator-push-demo","recovered":true}\n' };
  } });
  assert.equal(result.recovered, true);
  assert.equal(invocation[0], "/usr/bin/flock");
  assert.deepEqual(invocation[1], ["-w", "5", "/run/lock/trac-marketing-curator.lock", process.execPath,
    scriptPath, "promote-community", "collective-push-demo"]);
  assert.equal(invocation[1][4], scriptPath);
  await assert.rejects(deliverCollectivePush("collective-push-;bad"), /invalid/);
  await assert.rejects(deliverCollectivePush("collective-push-demo", { executeFile: async () => ({ stdout: '{}' }) }), /acknowledgment/);
});

test("durable retry selects pushes without reviewing ordinary drafts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-retry-"));
  const filename = path.join(dir, "intake.sqlite");
  try {
    enqueueCuratorDraft("ordinary-draft", { filename });
    enqueueCuratorDraft("collective-push-demo", { filename });
    const db = new DatabaseSync(filename);
    assert.equal(db.prepare("SELECT mode FROM drafts WHERE name = ?").get("collective-push-demo").mode, "delivery");
    db.close();
    const delivered = [];
    await retryCollectivePushes({ filename, deliver: async (name) => { delivered.push(name); throw new Error("temporary"); } });
    await retryCollectivePushes({ filename, deliver: async (name) => delivered.push(name) });
    assert.deepEqual(delivered, ["collective-push-demo", "collective-push-demo"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("retry rotates failed pushes so older errors cannot starve later delivery", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-fair-retry-"));
  const filename = path.join(dir, "intake.sqlite");
  try {
    for (let i = 0; i < 11; i++) enqueueCuratorDraft(`collective-push-${i}`, { filename });
    const delivered = [];
    const deliver = async (name) => { delivered.push(name); throw new Error("temporary"); };
    await retryCollectivePushes({ filename, deliver });
    assert.equal(delivered.length, 10);
    assert.equal(delivered.includes("collective-push-10"), false);
    await retryCollectivePushes({ filename, deliver });
    assert.equal(delivered[10], "collective-push-10");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const decisions = (filename) => {
  const db = new DatabaseSync(filename);
  try { return db.prepare("SELECT kind, id, status, reason FROM decisions ORDER BY id").all().map((row) => ({ ...row })); }
  finally { db.close(); }
};

test("expired collective pushes leave the retry queue without another delivery attempt", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-expired-retry-"));
  const filename = path.join(dir, "intake.sqlite");
  try {
    enqueueCuratorDraft("collective-push-stale", { filename });
    enqueueCuratorDraft("collective-push-fresh", { filename });
    const db = new DatabaseSync(filename);
    db.prepare("UPDATE drafts SET queued_at = ? WHERE name = ?").run(new Date(Date.now() - 3 * 3600000).toISOString(), "collective-push-stale");
    db.close();
    const delivered = [];
    const deliver = async (name) => { delivered.push(name); throw new Error("temporary"); };
    const reviewFilename = path.join(dir, "review.sqlite");
    await retryCollectivePushes({ filename, deliver, reviewFilename });
    await retryCollectivePushes({ filename, deliver, reviewFilename });
    assert.deepEqual(delivered, ["collective-push-fresh", "collective-push-fresh"]);
    assert.deepEqual(decisions(reviewFilename), [
      { kind: "community", id: "collective-push-stale", status: "expired", reason: "collective push exceeded its queue lifetime" },
    ]);
    const check = new DatabaseSync(filename);
    try {
      assert.ok(check.prepare("SELECT reviewed_at FROM drafts WHERE name = ?").get("collective-push-stale").reviewed_at);
      assert.equal(check.prepare("SELECT reviewed_at FROM drafts WHERE name = ?").get("collective-push-fresh").reviewed_at, null);
    } finally { check.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("server retains writer, policy and validation gates before draft creation", () => {
  const source = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("async ({ name, text, sourceUrl"), source.indexOf('"share_to_swm"'));
  const creation = handler.indexOf('dkgFetch("/api/knowledge-assets"');
  for (const gate of ["requireWrite();", "Writer installation unavailable", "Owner policy names are reserved", "validateCollectivePush("]) {
    assert.ok(handler.indexOf(gate) >= 0 && handler.indexOf(gate) < creation);
  }
  assert.ok(handler.indexOf("await routeDraft(slug)") > creation);
  assert.match(handler, /finalize: false/);
  assert.match(handler, /alsoShareSwm: false/);
});

test("trigger queues nonblocking systemd start", () => {
  let called;
  triggerCurator({ spawnProcess: (...args) => {
    called = args;
    return { on() {}, unref() {} };
  } });
  assert.deepEqual(called.slice(0, 2), ["/usr/bin/systemctl", ["start", "--no-block", "trac-marketing-curator.service"]]);
});

test("a push at the attempt cap is retired with an audit decision and keeps an earlier promotion", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-cap-"));
  const filename = path.join(dir, "intake.sqlite");
  const reviewFilename = path.join(dir, "review.sqlite");
  try {
    enqueueCuratorDraft("collective-push-capped", { filename });
    enqueueCuratorDraft("collective-push-delivered", { filename });
    await retryCollectivePushes({ filename, reviewFilename, deliver: async () => {} });
    const db = new DatabaseSync(filename);
    db.prepare("UPDATE drafts SET delivery_attempts = ?").run(MAX_PUSH_DELIVERY_ATTEMPTS);
    db.close();
    decision("community", "collective-push-delivered", "promoted", "", reviewFilename);
    await retryCollectivePushes({ filename, reviewFilename, deliver: async () => assert.fail("retired pushes are not delivered") });
    assert.deepEqual(decisions(reviewFilename), [
      { kind: "community", id: "collective-push-capped", status: "expired", reason: "collective push reached the delivery attempt cap" },
      { kind: "community", id: "collective-push-delivered", status: "promoted", reason: "" },
    ]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a push is not retired or delivered while its audit decision cannot be written", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "curator-audit-fail-"));
  const filename = path.join(dir, "intake.sqlite");
  const errors = t.mock.method(console, "error", () => {});
  const queued = () => {
    const db = new DatabaseSync(filename);
    try { return db.prepare("SELECT reviewed_at FROM drafts WHERE name = ?").get("collective-push-stale").reviewed_at; }
    finally { db.close(); }
  };
  try {
    enqueueCuratorDraft("collective-push-stale", { filename });
    const at = Date.now() + 3 * 3600000;
    const deliver = async () => assert.fail("an expired push is never delivered");
    await retryCollectivePushes({ filename, deliver, at, reviewFilename: path.join(dir, "missing", "review.sqlite") });
    assert.equal(queued(), null);
    assert.equal(errors.mock.callCount(), 1);
    await retryCollectivePushes({ filename, deliver, at, reviewFilename: path.join(dir, "review.sqlite") });
    assert.ok(queued());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
