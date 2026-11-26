import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { RESERVED_DRAFT_PREFIXES, isReservedDraftName, safeSourceIri } from "../draft-guards.mjs";

test("sourceUrl must be an IRI-safe http(s) URL and is emitted canonicalized", () => {
  assert.equal(safeSourceIri("https://Example.org/a/../b?x=1"), "https://example.org/b?x=1");
  for (const bad of [
    "https://example.org/a b",
    'https://example.org/"x"',
    "https://example.org/a>b",
    "https://example.org/{x}",
    "https://example.org/a|b",
    "https://example.org/a`b",
    "https://example.org/a\\b",
    "javascript:alert(1)",
    "ftp://example.org/file",
    "https://user:pass@example.org/",
    `https://example.org/${"a".repeat(2050)}`,
  ]) {
    assert.throws(() => safeSourceIri(bad), /sourceUrl/, bad);
  }
});

test("system draft prefixes are reserved for collector and curator", () => {
  assert.deepEqual(RESERVED_DRAFT_PREFIXES, ["curator-", "raw-x-post-", "x-insight-", "collective-push-x-"]);
  for (const name of ["curator-push-collective-push-demo", "Raw-X-Post-123", "x-insight-123", "collective-push-x-999", "CURATOR-x-post-1"]) {
    assert.equal(isReservedDraftName(name), true, name);
  }
  for (const name of ["campaign-brief", "collective-push-demo", "my-curator-notes"]) {
    assert.equal(isReservedDraftName(name), false, name);
  }
});

test("write_working_memory bounds metadata and applies both guards before creating the draft", () => {
  const source = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const handler = source.slice(source.indexOf("async ({ name, text, sourceUrl"), source.indexOf('"share_to_swm"'));
  const creation = handler.indexOf('dkgFetch("/api/knowledge-assets"');
  assert.ok(handler.indexOf("isReservedDraftName(slug)") >= 0 && handler.indexOf("isReservedDraftName(slug)") < creation);
  assert.ok(handler.indexOf("safeSourceIri(sourceUrl)") >= 0 && handler.indexOf("safeSourceIri(sourceUrl)") < creation);
  assert.match(handler, /object: iriSourceUrl/);
  assert.doesNotMatch(handler, /object: sourceUrl \}/);
  assert.match(source, /publisher: z\.string\(\)\.max\(80\)/);
  assert.match(source, /angle: z\.string\(\)\.max\(280\)/);
  assert.match(source, /sourceUrl: z\.string\(\)\.max\(2048\)/);
});

test("write_working_memory literals escape carriage returns and control characters without relying on another change", () => {
  const source = fs.readFileSync(new URL("../server.mjs", import.meta.url), "utf8");
  const definition = source.match(/const lit = \(value\) => .*;$/m)?.[0];
  assert.ok(definition, "literal helper not found");
  const lit = new Function(`${definition} return lit;`)();
  const hostile = 'a\r\n" . <urn:x> <urn:y> "\u0000\u0008\u001f\\';
  const literal = lit(hostile);
  assert.doesNotMatch(literal, /[\u0000-\u001f]/);
  assert.equal(JSON.parse(literal), hostile);
});
