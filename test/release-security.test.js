'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.resolve(__dirname, '..');

test('CI failure annotations expose locations and codes while suppressing assertion values', async () => {
  const { failureAnnotations } = await import('../scripts/run-ci-tests.mjs');
  const canary = 'synthetic-private-value-never-report';
  const output = `not ok 1 - ${canary}\n  ---\n  location: 'D:\\\\a\\\\repo\\\\test\\\\safe-unit.test.js:15:1'\n  error: '${canary}'\n  code: 'ERR_ASSERTION'\n  actual: '${canary}'\n  ...\n1..1`;
  const annotations = failureAnnotations(output);
  assert.deepEqual(annotations, ['::error file=test/safe-unit.test.js,line=15,title=JavaScript test failed::ERR_ASSERTION; inspect this regression locally.']);
  assert.equal(annotations.join('').includes(canary), false);
});

test('release version agrees across JavaScript, Rust, locks, and the Windows shell', () => {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  assert.equal(lock.version, version); assert.equal(lock.packages[''].version, version);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'))).version, version);
  for (const [directory, crate] of [['src-tauri', 'sunday-launcher'], ['installer', 'sunday-setup']]) {
    assert.equal(fs.readFileSync(path.join(root, directory, 'Cargo.toml'), 'utf8').match(/^version = "([^"]+)"/m)[1], version);
    const cargoLock = fs.readFileSync(path.join(root, directory, 'Cargo.lock'), 'utf8');
    assert.equal(cargoLock.match(new RegExp(`name = "${crate}"\\r?\\nversion = "([^"]+)"`))[1], version);
  }
});

test('pair qualification refuses to start without explicit live authorization', () => {
  const environment = { ...process.env }; delete environment.SUNDAY_RELEASE_PAIR_QUALIFICATION;
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'qualify-release-pair.mjs')], {
    env: environment, encoding: 'utf8', windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Explicit two-account live qualification authorization is required/);
});

test('production runtime allowlist excludes recovery tooling and contains all local dependencies', () => {
  const files = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'runtime-files.json'), 'utf8'));
  assert.equal(new Set(files).size, files.length);
  assert.ok(files.includes('tauri-node-host.js'));
  assert.ok(!files.includes('launch-plan-recovery.js'));
  const builder = fs.readFileSync(path.join(root, 'scripts', 'build-portable.ps1'), 'utf8');
  assert.match(builder, /runtime-files\.json/);
  assert.doesNotMatch(builder, /robocopy[^\r\n]*src\\main/);
  for (const file of files) {
    assert.match(file, /^[a-z][a-z0-9-]*\.js$/);
    const source = fs.readFileSync(path.join(root, 'src', 'main', file), 'utf8');
    for (const match of source.matchAll(/require\(['"]\.\/([a-z0-9-]+)(?:\.js)?['"]\)/g)) {
      assert.ok(files.includes(`${match[1]}.js`), `${file} requires a module outside the production allowlist`);
    }
  }
  const recovery = require('../src/main/launch-plan-recovery');
  assert.ok(Object.keys(recovery).every(key => !key.startsWith('APPROVED_REAL_')));
});

test('secret audit detects escaped and forward-slash profile paths without disclosing values', () => {
  const directory = fs.mkdtempSync(path.join(root, '.sunday-release-path-test-'));
  const privatePath = ['C:', 'Users', 'Private Audit Person', 'example.txt'].join('\\');
  const variants = [privatePath, JSON.stringify(privatePath), JSON.stringify(JSON.stringify(privatePath)), privatePath.replace(/\\/g, '/')];
  try {
    variants.forEach((value, index) => fs.writeFileSync(path.join(directory, `fixture-${index}.txt`), value));
    const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'audit-release-secrets.mjs'), path.relative(root, directory)], {
      cwd: root, encoding: 'utf8', windowsHide: true,
    });
    assert.notEqual(result.status, 0);
    variants.forEach((_value, index) => assert.ok(result.stderr.includes(`fixture-${index}.txt:`)));
    assert.match(result.stderr, /Personal Windows profile path/);
    assert.equal((result.stdout + result.stderr).includes('Private Audit Person'), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

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
