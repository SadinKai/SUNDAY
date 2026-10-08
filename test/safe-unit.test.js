'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CapabilityGates, STATES } = require('../src/main/capability-gates');
const { ProcessCapabilityRegistry } = require('../src/main/process-capabilities');
const { validateUrl, fetchWithPolicy } = require('../src/main/http-policy');
const { InstanceKeeper } = require('../src/main/keeper');
const { ProcessMonitor } = require('../src/main/monitor');
const processes = require('../src/main/processes');
const { StateDatabase } = require('../src/main/state-database');
const accounts = require('../src/main/accounts');
const people = require('../src/main/people');
const store = require('../src/main/store');
const { parseRobloxTarget } = require('../src/renderer/model');

test('explicit clipboard target parsing accepts Roblox links and rejects unrelated text harmlessly', () => {
  assert.deepEqual(parseRobloxTarget('https://www.roblox.com/games/920587237/Test'), {
    placeId: '920587237', gameId: '', invalid: false,
  });
  assert.deepEqual(parseRobloxTarget('not a Roblox destination'), {
    placeId: '', gameId: '', invalid: true,
  });
});

test('capability gates fail closed and preserve explicit lifecycle states', () => {
  const gates = new CapabilityGates({ launch: { state: STATES.UNAVAILABLE, reason: 'not qualified' } });
  assert.equal(gates.permits('launch'), false);
  assert.throws(() => gates.require('launch'), err => err.code === 'ECAPABILITY');
  gates.set('launch', STATES.QUALIFIED, 'isolated evidence');
  assert.equal(gates.permits('launch'), true);
  assert.equal(gates.get('missing').state, STATES.UNAVAILABLE);
});

test('process capabilities bind PID, creation identity, and canonical image path', () => {
  let identity = 'creation:100';
  let image = 'C:\\Owned\\SundayChild.exe';
  let fileIdentity = 'volume:file:100';
  let clock = 1000;
  const registry = new ProcessCapabilityRegistry({
    processFingerprintOf: () => ({ processIdentity: identity, executablePath: image, fileIdentity }),
  }, { now: () => clock, ttlMs: 5000 });
  const token = registry.issue(42, {
    executablePath: image,
    ownerId: 'owner',
    instanceId: 'instance',
    accountId: 'account',
    profileName: 'profile',
    slotId: 'slot',
  });
  assert.match(token, /^[A-Za-z0-9_-]{40,}$/);
  const valid = registry.authorize(token, 'focus', 'owner');
  assert.equal(valid.ok, true);
  assert.equal(valid.record.fileIdentity, 'volume:file:100');
  assert.equal(valid.record.slotId, 'slot');
  assert.equal(registry.authorize(token, 'kill', 'other-owner').ok, false);
  fileIdentity = 'volume:file:replacement';
  assert.equal(registry.authorize(token, 'kill', 'owner').ok, false);
  assert.equal(registry.resolve(token).state, 'STALE');

  fileIdentity = 'volume:file:200';
  identity = 'creation:200';
  const expiring = registry.issue(43, { executablePath: image, ownerId: 'owner', instanceId: 'instance-2' });
  clock = 6001;
  assert.equal(registry.authorize(expiring, 'stop', 'owner').state, 'EXPIRED');

  clock = 7000;
  const revoked = registry.issue(44, { executablePath: image, ownerId: 'owner', instanceId: 'instance-3' });
  assert.equal(registry.revoke(revoked, 'test revocation'), true);
  assert.equal(registry.authorize(revoked, 'focus', 'owner').state, 'REVOKED');

  clock = 8000;
  const reused = registry.issue(45, { executablePath: image, ownerId: 'owner', instanceId: 'instance-4' });
  identity = 'creation:101';
  assert.equal(registry.authorize(reused, 'kill', 'owner').ok, false);
  assert.equal(registry.authorize(reused, 'kill', 'owner').state, 'STALE');
});

test('active process capabilities renew only after exact identity revalidation', () => {
  let clock = 1000;
  let identity = 'creation:long-running';
  const image = 'C:\\Owned\\RobloxPlayerBeta.exe';
  const registry = new ProcessCapabilityRegistry({
    processFingerprintOf: () => ({
      processIdentity: identity,
      executablePath: image,
      fileIdentity: 'volume:file:long-running',
    }),
  }, { now: () => clock, ttlMs: 5000 });
  const token = registry.issue(77, { executablePath: image, ownerId: 'owner' });

  clock = 5000;
  assert.equal(registry.authorize(token, 'observe', 'owner').ok, true);
  clock = 9000;
  assert.equal(registry.authorize(token, 'stop', 'owner').ok, true);
  identity = 'creation:replacement';
  assert.equal(registry.authorize(token, 'stop', 'owner').ok, false);
  assert.equal(registry.resolve(token).state, 'STALE');
});

test('process observation failure preserves the last monitor snapshot', async () => {
  let fail = false;
  const monitor = new ProcessMonitor({
    processProvider: {
      async list() {
        if (fail) {
          const error = new Error('enumeration unavailable');
          error.code = 'EPROCESSOBSERVATION';
          throw error;
        }
        return [{
          pid: 4242,
          memBytes: 10,
          status: 'running',
          windowTitle: 'Roblox',
          executablePath: '',
          verifiedPath: false,
          expectedLayout: false,
          windowVerified: true,
          processIdentity: 'creation:4242',
        }];
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  await monitor.poll();
  await monitor.poll();
  assert.equal(monitor.snapshot().length, 1);
  fail = true;
  await monitor.poll();
  assert.equal(monitor.snapshot().length, 1);
  assert.equal(monitor.snapshot()[0].pid, 4242);
});

test('tasklist fallback distinguishes enumeration failure from an empty process set', async () => {
  await assert.rejects(
    processes.__test.tasklistList(async () => ({ err: new Error('unavailable'), stdout: '', stderr: '' })),
    error => error && error.code === 'EPROCESSOBSERVATION',
  );
  const empty = await processes.__test.tasklistList(async () => ({
    err: null,
    stdout: 'INFO: No tasks are running which match the specified criteria.\r\n',
    stderr: '',
  }));
  assert.deepEqual(empty, []);
});

test('keeper is coordinator-only and ignores unowned exits', () => {
  const keeper = new InstanceKeeper();
  assert.equal(keeper.arm({ accountId: 'safe-account' }).ok, true);
  assert.equal(keeper.onOwnedExit({
    accountId: 'safe-account', capability: 'unknown', ownership: 'UNKNOWN', confirmed: false,
  }).ignored, true);
  assert.equal(keeper.restore().restored, 0);
  assert.equal(keeper.status().records[0].state, 'armed');
});

test('state corruption is quarantined and never silently overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-state-test-'));
  try {
    store.configure(dir, { error() {}, warn() {} }, { assertOwner: () => true });
    const saved = store.saveSettings({ launchDelayMs: 1234 });
    assert.equal(saved.launchDelayMs, 1234);
    const record = store.database().get('documents', 'settings.json');
    assert.equal(record.revision, 1);
    assert.equal(record.value.launchDelayMs, 1234);

    fs.writeFileSync(path.join(dir, 'profiles.json'), '{not-json', 'utf8');
    assert.throws(() => store.getProfiles(), err => err.code === 'ESTATECORRUPT');
    assert.equal(fs.existsSync(path.join(dir, 'profiles.json')), false);
    assert.equal(fs.readdirSync(dir).filter(name => name.startsWith('profiles.json.corrupt.')).length, 1);
  } finally {
    store.close();
    const resolved = path.resolve(dir);
    assert.equal(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep), true);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('legacy account credentials are DPAPI-protected before the first SQLite commit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-account-migration-'));
  const dbPath = path.join(dir, 'sunday-state.sqlite3');
  const database = new StateDatabase({ path: dbPath, assertOwner: () => true });
  const plaintext = 'synthetic-session-material-'.repeat(8);
  const secondPlaintext = 'second-synthetic-session-'.repeat(8);
  const legacyValue = Buffer.from(plaintext, 'utf8').toString('base64');
  const secondLegacyValue = Buffer.from(secondPlaintext, 'utf8').toString('base64');
  fs.writeFileSync(path.join(dir, 'accounts.json'), JSON.stringify([
    { id: 'legacy-account', userId: 42, username: 'legacy', cookie: `b64:${legacyValue}` },
    { id: 'legacy-account-2', userId: 43, username: 'legacy2', cookie: `b64:${secondLegacyValue}` },
  ]));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) { return Buffer.concat([Buffer.from('protected:'), Buffer.from(value)]); },
    decryptString(value) { return Buffer.from(value).subarray(Buffer.byteLength('protected:')).toString('utf8'); },
  };
  try {
    accounts.configure({ baseDir: dir, database, safeStorage, logger: { info() {}, warn() {}, error() {} } });
    const stored = database.get('documents', 'accounts.json', []).value;
    assert.equal(stored.every(record => /^enc:/.test(record.cookie)), true);
    assert.equal(fs.existsSync(path.join(dir, 'accounts.json')), false);
    assert.equal(fs.readdirSync(dir).some(name => name.includes('.migrated.') && name.endsWith('.bak')), false);

    const liveDatabaseBytes = fs.readdirSync(dir)
      .filter(name => name.startsWith('sunday-state.sqlite3'))
      .map(name => fs.readFileSync(path.join(dir, name)).toString('latin1'))
      .join('');
    assert.equal(liveDatabaseBytes.includes(`b64:${legacyValue}`), false);
    assert.equal(liveDatabaseBytes.includes(`b64:${secondLegacyValue}`), false);
    assert.equal(liveDatabaseBytes.includes(plaintext), false);
    assert.equal(liveDatabaseBytes.includes(secondPlaintext), false);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('failed account import commit leaves the original legacy source recoverable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-account-import-fault-'));
  const dbPath = path.join(dir, 'sunday-state.sqlite3');
  const legacyPath = path.join(dir, 'accounts.json');
  const plaintext = 'recoverable-synthetic-session-material';
  fs.writeFileSync(legacyPath, JSON.stringify([
    { id: 'legacy-recoverable', userId: 84, username: 'recoverable', cookie: `b64:${Buffer.from(plaintext).toString('base64')}` },
  ]));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) { return Buffer.concat([Buffer.from('protected:'), Buffer.from(value)]); },
    decryptString(value) { return Buffer.from(value).subarray(Buffer.byteLength('protected:')).toString('utf8'); },
  };
  let inject = true;
  const first = new StateDatabase({
    path: dbPath,
    assertOwner: () => true,
    faultInjector(stage) {
      if (inject && stage === 'before-commit') {
        inject = false;
        throw new Error('synthetic commit interruption');
      }
    },
  });
  try {
    accounts.configure({ baseDir: dir, database: first, safeStorage, logger: { info() {}, warn() {}, error() {} } });
    assert.equal(fs.existsSync(legacyPath), true);
    assert.equal(first.get('documents', 'accounts.json', []).found, false);
  } finally {
    first.close();
  }

  const second = new StateDatabase({ path: dbPath, assertOwner: () => true });
  try {
    accounts.configure({ baseDir: dir, database: second, safeStorage, logger: { info() {}, warn() {}, error() {} } });
    assert.equal(accounts.list().length, 1);
    assert.equal(fs.existsSync(legacyPath), false);
  } finally {
    second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stopping account polling cancels both recurring and delayed startup work', () => {
  const original = {
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
    setTimeout: global.setTimeout,
    clearTimeout: global.clearTimeout,
  };
  const interval = { type: 'interval' };
  const timeout = { type: 'timeout' };
  const cleared = [];
  try {
    global.setInterval = () => interval;
    global.setTimeout = () => timeout;
    global.clearInterval = handle => cleared.push(handle);
    global.clearTimeout = handle => cleared.push(handle);
    accounts.startPolling({ intervalMs: 12000 });
    accounts.stopPolling();
    assert.deepEqual(cleared, [interval, timeout]);
  } finally {
    accounts.stopPolling();
    global.setInterval = original.setInterval;
    global.clearInterval = original.clearInterval;
    global.setTimeout = original.setTimeout;
    global.clearTimeout = original.clearTimeout;
  }
});

test('people friend cache invalidation reflects account membership changes', async () => {
  const original = {
    fetch: global.fetch,
    list: accounts.list,
    hasSession: accounts.hasSession,
    presenceForIds: accounts.presenceForIds,
  };
  let saved = [{ id: 'account-a', userId: 7001, username: 'a', displayName: 'A' }];
  try {
    accounts.list = () => saved;
    accounts.hasSession = () => false;
    accounts.presenceForIds = async () => new Map();
    global.fetch = async url => {
      const value = String(url);
      let body = {};
      if (value.includes('/users/7001/friends')) body = { data: [{ id: 7101, name: 'friend-a', displayName: 'Friend A' }] };
      else if (value.includes('/users/7002/friends')) body = { data: [{ id: 7102, name: 'friend-b', displayName: 'Friend B' }] };
      else if (value.includes('/v1/users/7101')) body = { id: 7101, name: 'friend-a', displayName: 'Friend A' };
      else if (value.includes('/v1/users/7102')) body = { id: 7102, name: 'friend-b', displayName: 'Friend B' };
      else if (value.includes('thumbnails.roblox.com')) body = { data: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    people.invalidateFriends();
    assert.equal((await people.listFriends(0, 9, false)).total, 1);
    saved = saved.concat({ id: 'account-b', userId: 7002, username: 'b', displayName: 'B' });
    assert.equal((await people.listFriends(0, 9, false)).total, 1);
    people.invalidateFriends();
    assert.equal((await people.listFriends(0, 9, false)).total, 2);
  } finally {
    people.invalidateFriends();
    accounts.list = original.list;
    accounts.hasSession = original.hasSession;
    accounts.presenceForIds = original.presenceForIds;
    global.fetch = original.fetch;
  }
});

test('people invalidation during an in-flight load returns the current account-derived list', async () => {
  const original = {
    fetch: global.fetch,
    list: accounts.list,
    hasSession: accounts.hasSession,
    presenceForIds: accounts.presenceForIds,
  };
  let saved = [{ id: 'account-a', userId: 7201, username: 'a', displayName: 'A' }];
  let releaseFirst;
  let firstPending = true;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  try {
    accounts.list = () => saved;
    accounts.hasSession = () => false;
    accounts.presenceForIds = async () => new Map();
    global.fetch = async url => {
      const value = String(url);
      if (value.includes('/users/7201/friends') && firstPending) {
        firstPending = false;
        await firstGate;
      }
      let body = {};
      if (value.includes('/users/7201/friends')) body = { data: [{ id: 7301, name: 'friend-a', displayName: 'Friend A' }] };
      else if (value.includes('/users/7202/friends')) body = { data: [{ id: 7302, name: 'friend-b', displayName: 'Friend B' }] };
      else if (value.includes('/v1/users/7301')) body = { id: 7301, name: 'friend-a', displayName: 'Friend A' };
      else if (value.includes('/v1/users/7302')) body = { id: 7302, name: 'friend-b', displayName: 'Friend B' };
      else if (value.includes('thumbnails.roblox.com')) body = { data: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    people.invalidateFriends();
    const pending = people.listFriends(0, 9, false);
    await new Promise(resolve => setImmediate(resolve));
    saved = saved.concat({ id: 'account-b', userId: 7202, username: 'b', displayName: 'B' });
    people.invalidateFriends();
    releaseFirst();
    const result = await pending;
    assert.equal(result.total, 2);
    assert.deepEqual(result.people.map(item => item.userId).sort(), [7301, 7302]);
  } finally {
    releaseFirst();
    people.invalidateFriends();
    accounts.list = original.list;
    accounts.hasSession = original.hasSession;
    accounts.presenceForIds = original.presenceForIds;
    global.fetch = original.fetch;
  }
});

test('HTTP policy rejects downgrade, credentials, and non-allowlisted hosts', () => {
  assert.throws(() => validateUrl('http://users.roblox.com/v1/x', { hosts: ['roblox.com'] }), /HTTPS/);
  assert.throws(() => validateUrl('https://user:pass@users.roblox.com/v1/x', { hosts: ['roblox.com'] }), /credentials/);
  assert.throws(() => validateUrl('https://roblox.com.evil.example/v1/x', { hosts: ['roblox.com'] }), /allowlisted/);
});

test('HTTP policy revalidates redirects and bounds streamed bodies', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('', {
      status: 302,
      headers: { location: 'https://evil.example/payload' },
    });
    await assert.rejects(
      fetchWithPolicy('https://users.roblox.com/v1/x', {}, 'robloxApi'),
      /allowlisted/,
    );

    globalThis.fetch = async () => new Response('', {
      status: 302,
      headers: { location: 'https://games.roblox.com/v1/x' },
    });
    await assert.rejects(
      fetchWithPolicy('https://users.roblox.com/v1/x', {}, 'robloxApi'),
      /Cross-host/,
    );

    globalThis.fetch = async () => new Response(Buffer.alloc(2 * 1024 * 1024 + 1), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const response = await fetchWithPolicy('https://users.roblox.com/v1/x', {}, 'robloxApi');
    await assert.rejects(response.arrayBuffer(), /size limit/);
  } finally {
    globalThis.fetch = original;
  }
});

test('HTTP policy releases redirect response bodies before following', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  let cancelled = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          status: 302,
          headers: new Headers({ location: 'https://users.roblox.com/v1/final' }),
          body: { async cancel(reason) { assert.equal(reason, 'redirect'); cancelled += 1; } },
        };
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const response = await fetchWithPolicy('https://users.roblox.com/v1/start', {}, 'robloxApi');
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(calls, 2);
    assert.equal(cancelled, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('HTTP policy enforces media type, cancellation, redaction, and method-aware retries', async () => {
  const original = globalThis.fetch;
  try {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return calls === 1
        ? new Response('', { status: 503, headers: { 'content-type': 'application/json' } })
        : new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const retried = await fetchWithPolicy('https://users.roblox.com/v1/test', {}, 'robloxApi');
    assert.deepEqual(await retried.json(), { ok: true });
    assert.equal(calls, 2);

    calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response('', { status: 503, headers: { 'content-type': 'application/json' } });
    };
    await fetchWithPolicy('https://users.roblox.com/v1/test', { method: 'POST' }, 'robloxApi');
    assert.equal(calls, 1);

    globalThis.fetch = async () => new Response('{"not":"an image"}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    await assert.rejects(
      fetchWithPolicy('https://tr.rbxcdn.com/avatar.png', {}, 'robloxImage'),
      /content type/,
    );

    const cancelled = new AbortController();
    cancelled.abort();
    globalThis.fetch = async (_url, options) => {
      if (options.signal.aborted) throw options.signal.reason;
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    };
    await assert.rejects(
      fetchWithPolicy('https://users.roblox.com/v1/private?ticket=secret-value', { signal: cancelled.signal }, 'robloxApi'),
      error => /cancelled/.test(error.message) && !error.message.includes('secret-value'),
    );

    calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      const error = new Error('failed https://users.roblox.com/v1/private?ticket=secret-value');
      error.code = 'ECONNRESET';
      throw error;
    };
    await assert.rejects(
      fetchWithPolicy('https://users.roblox.com/v1/private?ticket=secret-value', {}, 'robloxApi'),
      error => /allowlisted host users\.roblox\.com/.test(error.message) && !error.message.includes('secret-value'),
    );
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = original;
  }
});
