'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('release secret audit suppresses synthetic credential values', () => {
  const directory = fs.mkdtempSync(path.join(root, '.sunday-release-secret-test-'));
  const secret = ['_|WARNING:', '-DO-NOT-SHARE-', 'THIS.synthetic-test-value'].join('');
  const fixture = path.join(directory, 'fixture.txt');
  try {
    fs.writeFileSync(fixture, `${secret}${os.EOL}`, 'utf8');
    const result = spawnSync(process.execPath, [
      path.join(root, 'scripts', 'audit-release-secrets.mjs'),
      path.relative(root, directory),
    ], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Roblox authentication cookie/);
    assert.doesNotMatch(result.stderr, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(result.stdout, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
