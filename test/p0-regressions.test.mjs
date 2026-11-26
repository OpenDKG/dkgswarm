import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("site/swarm-stats.js null-guards [data-stat-note] queries", () => {
  const src = fs.readFileSync(path.join(rootDir, "site", "swarm-stats.js"), "utf8");
  assert.doesNotMatch(src, /querySelector\('\[data-stat-note\]'\)\.(remove|textContent)/);
  assert.match(src, /querySelector\('\[data-stat-note\]'\)\?\.remove\(\)/);
});

test("server.mjs write_working_memory literal helper uses JSON.stringify to escape CR and control chars", () => {
  const src = fs.readFileSync(path.join(rootDir, "server.mjs"), "utf8");
  assert.match(src, /const lit = \(value\) => JSON\.stringify\(String\(value \?\? ""\)\);/);
});
