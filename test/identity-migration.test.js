'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { StateDatabase } = require('../src/main/state-database');
const {
  CURRENT_STATE_DATABASE,
  LEGACY_STATE_DATABASE,
  MIGRATION_MARKER,
  migrateLegacyUserData,
} = require('../src/main/legacy-identity-compat');

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-identity-migration-'));
}

test('pre-SUNDAY durable state is copied, verified, readable, and left recoverable', () => {
  const root = temporaryRoot();
  const legacyRoot = path.join(root, 'previous');
  const currentRoot = path.join(root, 'current');
  fs.mkdirSync(legacyRoot);
  const legacyDatabase = path.join(legacyRoot, LEGACY_STATE_DATABASE);
  const database = new StateDatabase({ path: legacyDatabase, assertOwner() {} });
  database.put('settings', 'document', { theme: 'dark', migrated: true });
  database.close();
  fs.writeFileSync(path.join(legacyRoot, 'accounts.json'), JSON.stringify({ version: 1, accounts: [] }));

  const result = migrateLegacyUserData(currentRoot, { legacyRoot });
  assert.equal(result.migrated, true);
  assert.equal(result.sourcePreserved, true);
  assert.equal(fs.existsSync(legacyDatabase), true);
  assert.equal(fs.existsSync(path.join(currentRoot, CURRENT_STATE_DATABASE)), true);
  assert.equal(fs.existsSync(path.join(currentRoot, MIGRATION_MARKER)), true);

  const migrated = new StateDatabase({
    path: path.join(currentRoot, CURRENT_STATE_DATABASE),
    assertOwner() {},
  });
  assert.deepEqual(migrated.get('settings', 'document').value, { theme: 'dark', migrated: true });
  migrated.close();
  assert.equal(migrateLegacyUserData(currentRoot, { legacyRoot }).reason, 'already-migrated');
  fs.rmSync(root, { recursive: true, force: true });
});

test('identity migration never overwrites current state and refuses active SQLite sidecars', () => {
  const root = temporaryRoot();
  const legacyRoot = path.join(root, 'previous');
  const currentRoot = path.join(root, 'current');
  fs.mkdirSync(legacyRoot);
  fs.mkdirSync(currentRoot);
  fs.writeFileSync(path.join(legacyRoot, LEGACY_STATE_DATABASE), 'legacy');
  fs.writeFileSync(path.join(currentRoot, CURRENT_STATE_DATABASE), 'current');
  assert.equal(migrateLegacyUserData(currentRoot, { legacyRoot }).reason, 'current-state-exists');
  assert.equal(fs.readFileSync(path.join(currentRoot, CURRENT_STATE_DATABASE), 'utf8'), 'current');

  fs.unlinkSync(path.join(currentRoot, CURRENT_STATE_DATABASE));
  fs.writeFileSync(`${path.join(legacyRoot, LEGACY_STATE_DATABASE)}-wal`, 'active');
  assert.throws(
    () => migrateLegacyUserData(currentRoot, { legacyRoot }),
    /active SQLite sidecars/,
  );
  assert.equal(fs.existsSync(path.join(currentRoot, CURRENT_STATE_DATABASE)), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('browser storage migration moves previous keys once and preserves canonical values', () => {
  const values = new Map([
    ['fleet-theme', 'dark'],
    ['fleet-sessions', '[{"id":"old"}]'],
    ['sunday-sessions', '[{"id":"current"}]'],
    ['fleet-notifs-v1', '["retired"]'],
  ]);
  const storage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  const window = {};
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'legacy-identity-compat.js'), 'utf8');
  vm.runInNewContext(source, { window });
  window.SundayLegacyIdentityCompat.migrateStorage(storage);

  assert.equal(values.get('sunday-theme'), 'dark');
  assert.equal(values.has('fleet-theme'), false);
  assert.equal(values.get('sunday-sessions'), '[{"id":"current"}]');
  assert.equal(values.get('fleet-sessions'), '[{"id":"old"}]');
  assert.equal(values.has('fleet-notifs-v1'), false);
});
