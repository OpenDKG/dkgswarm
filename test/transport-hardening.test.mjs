import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));

function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

async function withServer(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dkg-transport-hardening-"));
  const port = await freePort();
  const publicUrl = `http://127.0.0.1:${port}`;
  let logs = "";
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      HOME: dir,
      DKG_MCP_HOST: "127.0.0.1",
      DKG_MCP_PORT: String(port),
      DKG_MCP_PUBLIC_URL: publicUrl,
      DKG_PUBLIC_GRAPH_ID: "trac-marketing",
      DKG_API_URL: "http://127.0.0.1:1",
      DKG_API_TOKEN: "isolated-test-token",
      DKG_MCP_OAUTH_STORE: path.join(dir, "oauth.json"),
      DKG_MCP_WRITER_CODES: path.join(dir, "writer-codes.json"),
      DKG_MCP_POLICY_CURRENT: path.join(dir, "policy-current.json"),
      DKG_MCP_ACTIVITY_STORE: path.join(dir, "activity.sqlite"),
      TRAC_CURATOR_INTAKE: path.join(dir, "intake.sqlite"),
      DKG_MCP_ALLOWED_HOSTS: "127.0.0.1,localhost",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => {
    child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (child.exitCode === null) child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    if (child.exitCode !== null) break;
    try { ready = (await fetch(`${publicUrl}/health`)).ok; } catch {}
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(ready, true, `server did not start\n${logs}`);
  return { publicUrl, child, logs: () => logs };
}

async function readToken(publicUrl) {
  const redirect = "https://claude.ai/api/mcp/auth_callback";
  const registration = await fetch(`${publicUrl}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "hardening-test",
    }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();

  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const params = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirect,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "dkg:read",
  });
  const authorization = await fetch(`${publicUrl}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params,
    redirect: "manual",
  });
  assert.equal(authorization.status, 302);
  const code = new URL(authorization.headers.get("location")).searchParams.get("code");
  assert.ok(code);

  const tokenResponse = await fetch(`${publicUrl}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      redirect_uri: redirect,
      code_verifier: verifier,
    }),
  });
  const text = await tokenResponse.text();
  assert.equal(tokenResponse.status, 200, text);
  return JSON.parse(text).access_token;
}

test("gzip body with trailing bytes returns 4xx and the process survives", async (t) => {
  const { publicUrl, child, logs } = await withServer(t);
  const payload = Buffer.concat([zlib.gzipSync(Buffer.from('{"a":1}')), Buffer.alloc(100 * 1024, 0)]);
  const response = await fetch(`${publicUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
    body: payload,
  });
  assert.ok(
    response.status >= 400 && response.status < 500,
    `expected 4xx, got ${response.status}: ${await response.text()}`,
  );
  // The uncaught zlib error used to terminate the process.
  const health = await fetch(`${publicUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal(child.exitCode, null, `server exited\n${logs()}`);
});

test("JSON-RPC batches over the configured bound are rejected with 400", async (t) => {
  const { publicUrl } = await withServer(t);
  const accessToken = await readToken(publicUrl);
  const post = (body) => fetch(`${publicUrl}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body,
  });

  const oversized = await post(JSON.stringify(
    Array.from({ length: 101 }, (_, id) => ({ jsonrpc: "2.0", id, method: "tools/list", params: {} })),
  ));
  assert.equal(oversized.status, 400);
  assert.match(await oversized.text(), /Batch must not exceed 100 messages/);

  const withinBound = await post(JSON.stringify(
    Array.from({ length: 100 }, (_, id) => ({ jsonrpc: "2.0", id, method: "tools/list", params: {} })),
  ));
  assert.ok(withinBound.status < 500, `batch of 100 should be handled, got ${withinBound.status}`);
});
