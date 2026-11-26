// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, root), 'utf8');
const publicCopy = ['README.md', 'site/index.html', 'site/contexts.html', 'site/llms.txt'];

test('public copy records the completed OpenDKG move without endorsement claims', () => {
  for (const file of publicCopy) {
    const text = read(file);
    assert.match(text, /OpenDKG/, file);
    assert.match(text, /(?:transfer(?:red)?|moved)/i, file);
    assert.doesNotMatch(text, /OpenDKG (?:has )?endorsed|endorsed by (?:OpenDKG|OriginTrail)|official OpenDKG (?:project|marketing)|production source of record/i, file);
  }
});

test('status copy records the completed transfer with no stale pending wording', () => {
  for (const file of [...publicCopy, 'docs/platform-campaigns.md']) {
    assert.doesNotMatch(read(file), /transfer (?:is |was )?(?:not executed|pending|not yet executed)|not yet executed|approved-move, transfer-pending/i, file);
  }
  const platform = read('docs/platform-campaigns.md');
  assert.match(platform, /repository move is complete/);
  assert.match(platform, /70b2cb2e408b1b00e167b01aee5fee4dfef3c896/);
  assert.match(platform, /PR #3/);
});

test('public vision preserves the existing mission and permission boundaries', () => {
  const readme = read('README.md');
  for (const term of ['OriginTrail', 'TRAC', 'Umanitek']) assert.match(readme, new RegExp(term), 'README');

  const index = read('site/index.html');
  assert.match(index, /OriginTrail/i);
  assert.match(index, /Umanitek/i);
  assert.match(index, /opt-in/i);
  assert.doesNotMatch(index, /autonomous posting (?:is|will be) (?:enabled|active)/i);

  assert.match(read('site/llms.txt'), /trac-marketing[\s\S]*only live (?:context|graph)/i);
});

test('OpenDKG references point to the public organization and local integration docs', () => {
  for (const file of ['README.md', 'site/index.html', 'site/contexts.html']) {
    assert.match(read(file), /https:\/\/github\.com\/OpenDKG/, file);
  }
  assert.equal(fs.existsSync(new URL('docs/opendkg-umbrella.md', root)), true);
  assert.match(read('README.md'), /docs\/opendkg-umbrella\.md/);
});

test('project license is declared consistently as GPL-3.0-or-later', () => {
  assert.match(read('LICENSE'), /GNU GENERAL PUBLIC LICENSE\s+Version 3, 29 June 2007/);
  assert.match(read('NOTICE'), /either version 3 of the License, or\s+\(at your option\) any later version/);
  for (const file of ['package.json', 'collector/package.json']) {
    assert.equal(JSON.parse(read(file)).license, 'GPL-3.0-or-later', file);
  }
  for (const file of ['package-lock.json', 'collector/package-lock.json']) {
    assert.equal(JSON.parse(read(file)).packages[''].license, 'GPL-3.0-or-later', file);
  }
});

test('the earlier MIT notice stays with the project', () => {
  assert.match(read('NOTICE'), /Copyright \(c\) 2025 BRX/);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /Those versions stay available under it/);
  assert.match(notices, /MIT License\s+Copyright \(c\) 2025 BRX\s+Permission is hereby granted/);
});

test('current repository pointers use the OpenDKG namespace', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.repository, 'https://github.com/OpenDKG/dkgswarm');
  assert.equal(pkg.bugs, 'https://github.com/OpenDKG/dkgswarm/issues');
  assert.equal(pkg.homepage, 'https://www.dkgswarm.com');
  for (const file of publicCopy) {
    assert.doesNotMatch(read(file), /github\.com\/brxtrac\/dkgswarm/, file);
  }
});

test('third-party notices preserve the PR #1 ISC basis', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(read('README.md'), /THIRD_PARTY_NOTICES\.md/);
  assert.match(notices, /https:\/\/github\.com\/brxtrac\/dkgswarm\/pull\/1/);
  assert.match(notices, /87059a5b38e9f693121009d2b21f43b652b7b3f8/);
  assert.match(notices, /DeFine/);
  for (const file of ['activity.mjs', 'server.mjs', 'test/activity.test.mjs']) {
    assert.ok(notices.includes(file), file);
  }
  assert.match(notices, /ISC/);
  assert.match(notices, /does not relicense/);
});
