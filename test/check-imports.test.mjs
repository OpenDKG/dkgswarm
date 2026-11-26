import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractSpecifiers, findMissing } from '../scripts/check-imports.mjs';

test('extracts static, side-effect and dynamic import specifiers', () => {
  const specs = extractSpecifiers(`
    import fs from 'node:fs';
    import './side-effect.mjs';
    export { x } from './re-export.mjs';
    const later = await import('./dynamic.mjs');
  `);
  assert.deepEqual(specs.sort(), ['./dynamic.mjs', './re-export.mjs', './side-effect.mjs', 'node:fs'].sort());
});

test('fails on missing relative and package imports but tolerates optional viem', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'import-check-'));
  try {
    writeFileSync(`${root}/dep.mjs`, 'export const x = 1;\n');
    writeFileSync(`${root}/good.mjs`, `import './dep.mjs';\nimport fs from 'node:fs';\n`);
    writeFileSync(`${root}/bad.mjs`, `import './nope.mjs';\nimport 'definitely-not-installed-pkg';\nconst later = await import('./nope.mjs');\n`);
    writeFileSync(`${root}/optional.mjs`, `const viem = await import('viem');\n`);
    const result = findMissing(root);
    assert.deepEqual(result.missing.map((item) => item.specifier).sort(), ['./nope.mjs', 'definitely-not-installed-pkg']);
    assert.deepEqual(result.warnings.map((item) => item.specifier), ['viem']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validates the configured viem integration by actual runtime import', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'viem-check-'));
  try {
    mkdirSync(`${root}/collector`, { recursive: true });
    writeFileSync(`${root}/collector/network-stats.mjs`, `const moduleName = process.env.TRAC_VIEM_MODULE || 'viem';
export async function loadViem() { return import(moduleName); }
`);
    const env = { ...process.env, TRAC_VIEM_MODULE: '' };
    const absent = findMissing(root, env);
    assert.deepEqual(absent.missing, []);
    assert.deepEqual(absent.warnings.map((item) => item.specifier), ['viem']);

    const fixture = `${root}/fake-viem.mjs`;
    writeFileSync(fixture, 'export const ready = true;\n');
    const file = findMissing(root, { ...env, TRAC_VIEM_MODULE: fixture });
    assert.deepEqual(file.missing, []);
    assert.deepEqual(file.warnings, []);

    mkdirSync(`${root}/collector/node_modules/viem`, { recursive: true });
    writeFileSync(`${root}/collector/node_modules/viem/package.json`, JSON.stringify({ name: 'viem', version: '0.0.0', type: 'module', exports: './index.js' }));
    writeFileSync(`${root}/collector/node_modules/viem/index.js`, 'export const ready = true;\n');
    const pkg = findMissing(root, { ...env, TRAC_VIEM_MODULE: 'viem' });
    assert.deepEqual(pkg.missing, []);
    assert.deepEqual(pkg.warnings, []);

    const badFile = findMissing(root, { ...env, TRAC_VIEM_MODULE: `${root}/missing-viem.mjs` });
    assert.deepEqual(badFile.missing.map((item) => item.specifier), [`${root}/missing-viem.mjs`]);
    const badPkg = findMissing(root, { ...env, TRAC_VIEM_MODULE: 'not-a-real-viem-package' });
    assert.deepEqual(badPkg.missing.map((item) => item.specifier), ['not-a-real-viem-package']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('this checkout resolves every tracked source import', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = findMissing(root, { ...process.env, TRAC_VIEM_MODULE: '' });
  assert.deepEqual(result.missing, []);
});

test('reviewed deployment files resolve in separate MCP and collector runtime roots', () => {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const docs = readFileSync(path.join(repo, 'docs/deployment.md'), 'utf8');
  const copy = docs.split('## Copy reviewed files')[1].split('## Install dependencies')[0];
  const mcpFiles = /for f in ([\s\S]*?); do/.exec(copy)[1].replaceAll('\\', '').trim().split(/\s+/);
  const nestedFiles = /for f in ([^\n]*); do\n  install -m 0644 "\$RELEASE\/collector/.exec(copy)?.[1].split(/\s+/) ?? ['curator.mjs'];
  const stage = mkdtempSync(path.join(os.tmpdir(), 'deploy-imports-'));
  try {
    const mcp = path.join(stage, 'mcp');
    const collector = path.join(stage, 'collector');
    mkdirSync(path.join(mcp, 'collector'), { recursive: true });
    for (const file of mcpFiles) cpSync(path.join(repo, file), path.join(mcp, file));
    for (const file of nestedFiles) cpSync(path.join(repo, 'collector', file), path.join(mcp, 'collector', file));
    cpSync(path.join(repo, 'collector'), collector, { recursive: true, filter: (file) => path.basename(file) !== 'node_modules' });
    symlinkSync(path.join(repo, 'node_modules'), path.join(mcp, 'node_modules'), 'dir');
    symlinkSync(path.join(repo, 'collector/node_modules'), path.join(collector, 'node_modules'), 'dir');
    assert.deepEqual(findMissing(mcp).missing, []);
    assert.deepEqual(findMissing(collector).missing, []);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});
