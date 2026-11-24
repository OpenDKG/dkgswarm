import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAssets, classifyPost, matchesDerivedQuads } from "../watcher.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const collectorDir = path.resolve(__dirname, "..");

test("classifyPost & buildAssets sanitize unsafe IRI characters and escape CR/control chars", () => {
  const post = {
    post_id: "1234567890123456789",
    account: "origin_trail",
    summary:
      "OriginTrail DKG v10 update\r\nline two — check https://origintrail.io/blog?q=ok&bad={inject}|^`\" and https://valid.example/docs).",
  };
  const cls = classifyPost(post, ["origin_trail"]);
  assert.ok(cls.relationships.links.length >= 1);
  for (const link of cls.relationships.links) {
    assert.doesNotMatch(link, /[<>"\\{}|^`\s]/);
  }
  assert.ok(cls.relationships.links.includes("https://valid.example/docs"));

  const assets = buildAssets(post, cls, "2026-11-23T00:00:00.000Z");
  const bodyQuad = assets.raw.quads.find((q) => q.predicate === "https://schema.org/articleBody");
  assert.ok(bodyQuad);
  assert.doesNotMatch(bodyQuad.object, /\r|\n/);

  const bindings = assets.derived.quads.map((q) => {
    const obj = String(q.object);
    if (!obj.startsWith('"')) {
      return {
        s: { type: "uri", value: q.subject },
        p: { type: "uri", value: q.predicate },
        o: { type: "uri", value: obj },
      };
    }
    const match = /^("(?:\\.|[^"\\])*")(?:\^\^<([^>]+)>)?$/.exec(obj);
    return {
      s: { type: "uri", value: q.subject },
      p: { type: "uri", value: q.predicate },
      o: {
        type: "literal",
        value: JSON.parse(match[1]),
        ...(match[2] ? { datatype: match[2] } : {}),
      },
    };
  });
  assert.equal(matchesDerivedQuads({ result: { type: "bindings", bindings } }, assets.derived.quads), true);
});

test("collector/curator.mjs reads DKG_PUBLIC_GRAPH_ID and skips undefined optional push quads", () => {
  const src = fs.readFileSync(path.join(collectorDir, "curator.mjs"), "utf8");
  assert.match(src, /process\.env\.DKG_PUBLIC_GRAPH_ID\s*\|\|\s*"trac-marketing"/);
  assert.match(src, /postId\s*\?\s*\[quad\(subject,\s*"https:\/\/schema\.org\/identifier"/);
  assert.match(src, /angle\s*\?\s*\[quad\(subject,\s*`\$\{ns\}proposedAngle`/);
});

test("collector/server.mjs uses dynamic STORE dirname with 0o600 atomic write, timingSafeEqual, and cached scrypt key", () => {
  const src = fs.readFileSync(path.join(collectorDir, "server.mjs"), "utf8");
  assert.doesNotMatch(src, /fs\.mkdirSync\("\/root\/dkg-swarm-webhooks\/data"/);
  assert.match(src, /path\.dirname\(STORE\)/);
  assert.match(src, /mode:\s*0o600/);
  assert.match(src, /crypto\.timingSafeEqual/);
  assert.match(src, /const DERIVED_KEY\s*=\s*crypto\.scryptSync/);
  assert.match(src, /"value" in rawBinding/);
});
