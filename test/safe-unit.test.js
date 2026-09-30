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
const store = require('../src/main/store');

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
