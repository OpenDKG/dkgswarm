import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStore, secretKey } from "../oauth.mjs";
import { createWindowLimiter, limitRequests } from "../rate-limit.mjs";
import { withFileLock } from "../file-lock.mjs";
import { kaPrefix, publicUrl } from "../public-url.mjs";
import { assertReadSparql } from "../query-guard.mjs";
import { rankPostingContext } from "../posting-context.mjs";
import { deliverCollectivePush, triggerCurator } from "../curator-intake.mjs";

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dkgswarm-hardening-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "oauth.json");
}

test("OAuth codes and tokens are stored only as SHA-256 keys; legacy plaintext keys migrate", (t) => {
  const file = tempStore(t);
  const store = createStore([], file);
  const token = "a".repeat(64);
  const code = "c".repeat(64);
  store.putToken(token, { type: "access", scopes: ["dkg:read"], expiresAt: Date.now() + 60_000 });
  store.putCode(code, { clientId: "x", expiresAt: Date.now() + 60_000 });
  const raw = fs.readFileSync(file, "utf8");
  assert.equal(raw.includes(token), false, "token bytes never hit disk");
  assert.equal(raw.includes(code), false, "code bytes never hit disk");
  assert.ok(JSON.parse(raw).tokens[secretKey(token)]);
  assert.equal(store.getToken(token).type, "access");
  assert.equal(store.takeCode(code).clientId, "x");
  assert.equal(store.takeCode(code), null, "codes stay single-use");

  const legacy = { clients: {}, codes: {}, tokens: { "plain-token": { type: "access", expiresAt: Date.now() + 60_000 } } };
  fs.writeFileSync(file, JSON.stringify(legacy));
  const reopened = createStore([], file);
  assert.equal(reopened.getToken("plain-token").type, "access");
  assert.equal(fs.readFileSync(file, "utf8").includes("plain-token"), false, "migration rewrites the store");
});

test("OAuth store serves reads from memory and reloads only when the file changes", (t) => {
  const file = tempStore(t);
  const store = createStore([], file);
  store.putToken("tok", { type: "access", expiresAt: Date.now() + 60_000 });
  const realRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (...args) => {
    if (args[0] === file) reads += 1;
    return realRead(...args);
  };
  try {
    for (let i = 0; i < 50; i += 1) store.getToken("tok");
    assert.equal(reads, 0, "no re-parse per verified request");
    const db = JSON.parse(realRead(file, "utf8"));
    db.tokens[secretKey("tok")].scopes = ["dkg:read", "dkg:write"];
    fs.writeFileSync(file, JSON.stringify(db));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    assert.deepEqual(store.getToken("tok").scopes, ["dkg:read", "dkg:write"], "external edits are picked up");
    assert.equal(reads, 1);
  } finally {
    fs.readFileSync = realRead;
  }
});

test("dynamic client registration is capped; preloaded clients do not count", async (t) => {
  const store = createStore([{ client_id: "preloaded", redirect_uris: [] }], tempStore(t), { maxClients: 2 });
  const client = (id) => ({ client_id: id, redirect_uris: ["http://127.0.0.1:8787/callback"] });
  await store.registerClient(client("a"));
  await store.registerClient(client("b"));
  await assert.rejects(store.registerClient(client("c")), /registration limit/);
  await store.registerClient(client("a")); // re-registering an existing id is not a new slot
});

test("window limiter and middleware return 429 per client and globally", () => {
  const limiter = createWindowLimiter({ windowMs: 1000, max: 2 });
  assert.equal(limiter.take("k", 0), true);
  assert.equal(limiter.take("k", 1), true);
  assert.equal(limiter.take("k", 2), false);
  assert.equal(limiter.take("k", 1001), true, "new window");

  const mw = limitRequests({
    perClient: createWindowLimiter({ windowMs: 60_000, max: 1 }),
    global: createWindowLimiter({ windowMs: 60_000, max: 2 }),
  });
  const call = (ip) => {
    let status = 200;
    let nextCalled = false;
    mw({ ip }, { set() {}, status(code) { status = code; return { json() {} }; } }, () => { nextCalled = true; });
    return nextCalled ? 200 : status;
  };
  assert.equal(call("1.1.1.1"), 200);
  assert.equal(call("1.1.1.1"), 429, "per-client cap");
  assert.equal(call("2.2.2.2"), 200);
  assert.equal(call("3.3.3.3"), 429, "global cap");
});

test("limiter refuses new callers at capacity and preserves active counters", () => {
  const limiter = createWindowLimiter({ windowMs: 1000, max: 1, maxKeys: 2 });
  assert.equal(limiter.take("first", 0), true);
  assert.equal(limiter.take("second", 500), true);
  assert.equal(limiter.take("overflow", 501), false);
  assert.equal(limiter.take("first", 502), false);
  assert.equal(limiter.take("third", 1000), true);
  assert.equal(limiter.take("second", 1001), false);
  assert.equal(limiter.take("fourth", 1002), false);
});

test("file lock waits without blocking the event loop", async (t) => {
  const target = tempStore(t);
  fs.writeFileSync(`${target}.lock`, "held");
  let ticks = 0;
  const ticker = setInterval(() => { ticks += 1; }, 5);
  setTimeout(() => fs.unlinkSync(`${target}.lock`), 60);
  const result = await withFileLock(target, async () => "done", { attempts: 200, delayMs: 5 });
  clearInterval(ticker);
  assert.equal(result, "done");
  assert.ok(ticks >= 5, `event loop kept running while waiting (ticks=${ticks})`);
  assert.equal(fs.existsSync(`${target}.lock`), false);
  fs.writeFileSync(`${target}.lock`, "held");
  await assert.rejects(withFileLock(target, () => "never", { attempts: 3, delayMs: 1 }), /busy/);
});

test("stale cleanup requires a dead owner and release preserves replacements", async (t) => {
  const file = tempStore(t);
  const lock = `${file}.lock`;
  const stale = () => fs.utimesSync(lock, new Date(0), new Date(0));
  const options = { attempts: 3, delayMs: 1, staleMs: 10 };

  await withFileLock(file, async () => {
    stale();
    await assert.rejects(withFileLock(file, () => assert.fail("live lock was reaped"), options), /busy/);
    assert.ok(fs.existsSync(lock));
  });

  fs.writeFileSync(lock, "no verifiable owner");
  stale();
  await assert.rejects(withFileLock(file, () => assert.fail("unknown lock was reaped"), options), /busy/);
  assert.equal(fs.readFileSync(lock, "utf8"), "no verifiable owner");

  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(child.status, 0);
  fs.writeFileSync(lock, `${child.pid} ${randomUUID()}\n`);
  stale();
  await withFileLock(file, () => "recovered", options);
  assert.equal(fs.existsSync(lock), false);

  await withFileLock(file, async () => {
    fs.renameSync(lock, `${lock}.old`);
    fs.writeFileSync(lock, "replacement");
  });
  assert.equal(fs.readFileSync(lock, "utf8"), "replacement");
});

test("knowledge-asset prefix follows DKG_MCP_PUBLIC_URL", () => {
  assert.equal(kaPrefix({}), "https://www.dkgswarm.com/ka/");
  assert.equal(publicUrl({ DKG_MCP_PUBLIC_URL: "https://swarm.example.org/" }), "https://swarm.example.org");
  const prefix = kaPrefix({ DKG_MCP_PUBLIC_URL: "https://swarm.example.org" });
  assert.equal(prefix, "https://swarm.example.org/ka/");
  const q = `SELECT ?o WHERE { <${prefix}asset-1> <http://www.w3.org/2000/01/rdf-schema#label> ?o } LIMIT 5`;
  assert.equal(assertReadSparql(q, { prefix }), q);
  assert.throws(() => assertReadSparql(q, { prefix: "https://www.dkgswarm.com/ka/" }), /single bounded triple-pattern/);
});

test("avoid filter honours 2-character terms such as ai", () => {
  const rows = [["1", "TRAC graph update about ai agents shipping today with sources."], ["2", "TRAC graph update about provenance shipping today with sources."]];
  const textRows = rows.map(([id, body]) => ({ s: `https://www.dkgswarm.com/ka/${id}`, p: "https://schema.org/articleBody", o: JSON.stringify(body) }));
  const metaRows = rows.flatMap(([id]) => [
    { s: `https://www.dkgswarm.com/ka/${id}`, p: "https://schema.org/url", o: `https://x.com/i/status/${id}` },
    { s: `https://www.dkgswarm.com/ka/${id}`, p: "https://schema.org/datePublished", o: JSON.stringify("2026-10-01T12:00:00Z") },
  ]);
  const packet = rankPostingContext({ topic: "TRAC graph", action: "original", avoid: "ai", textRows, metaRows, now: Date.parse("2026-10-02T00:00:00Z") });
  assert.equal(packet.items.some((item) => /\bai\b/.test(item.claim)), false);
  assert.ok(packet.items.length >= 1);
});

test("curator trigger and lock are configurable for an unprivileged service", async (t) => {
  const triggerFile = path.join(path.dirname(tempStore(t)), "curator.trigger");
  let spawned = false;
  triggerCurator({ triggerFile, spawnProcess: () => { spawned = true; return { on() {}, unref() {} }; } });
  assert.equal(spawned, false, "no systemctl when a trigger file is configured");
  assert.ok(fs.existsSync(triggerFile));

  let invocation;
  await deliverCollectivePush("curator-push-collective-push-demo", {
    lockPath: "/var/lib/dkg/locks/curator.lock",
    scriptPath: "/srv/dkg/webhooks/curator.mjs",
    executeFile: async (...args) => { invocation = args; return { stdout: `${JSON.stringify({ promoted: true })}\n` }; },
  });
  assert.equal(invocation[1][2], "/var/lib/dkg/locks/curator.lock");
});

test("server wires the limits, async lock and configured prefix", () => {
  const src = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /Atomics\.wait/, "no event-loop-blocking lock");
  assert.doesNotMatch(src, /https:\/\/www\.dkgswarm\.com\/ka\//, "no hardcoded KA prefix");
  assert.match(src, /app\.all\("\/authorize", limitRequests\(/);
  assert.match(src, /app\.get\("\/api\/swarm\/memory", limitRequests\(/);
  assert.match(src, /writerAttempts\.take\(/);
  assert.match(src, /await consumeWriterSecret\(/);
  const policy = src.slice(src.indexOf('"get_swarm_policy"'), src.indexOf('"write_working_memory"'));
  assert.match(policy, /reserveQuery\(\)/, "policy reads share the query budget");
  for (const file of ["../query-guard.mjs", "../collector/curator.mjs", "../collective-pushes.mjs"]) {
    assert.doesNotMatch(fs.readFileSync(new URL(file, import.meta.url), "utf8"), /https:\/\/www\.dkgswarm\.com\/ka\//, file);
  }
  const collectorPkg = JSON.parse(fs.readFileSync(new URL("../collector/package.json", import.meta.url), "utf8"));
  assert.ok(collectorPkg.dependencies.viem, "collector declares viem");
});
