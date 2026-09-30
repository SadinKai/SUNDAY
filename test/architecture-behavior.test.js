'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { StateDatabase } = require('../src/main/state-database');
const { STATES, ProcessLifecycleController } = require('../src/main/process-lifecycle');
const { DurableJobSystem, JOB_STATES } = require('../src/main/durable-jobs');
const { ProcessCapabilityRegistry } = require('../src/main/process-capabilities');
const { canonicalize, unsignedManifest, parseAndVerifyManifest, verifyArtifactBuffer } = require('../src/main/release-trust');
const { VersionStore, atomicJson } = require('../src/main/version-store');
const { UpdateCoordinator } = require('../src/main/update-coordinator');
const { registerUpdateJobs, startUpdateCheck } = require('../src/main/update-jobs');
const { SlotLeaseManager } = require('../src/main/slot-leases');
const native = require('../src/main/native');
const processes = require('../src/main/processes');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        const value = predicate();
        if (value) return resolve(value);
      } catch (error) {
        return reject(error);
      }
      if (Date.now() >= deadline) return reject(new Error('Timed out waiting for condition.'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

test('transactional state enforces ownership, CAS revisions, rollback, and verified backup', () => {
  const dir = tempDir('sunday-sqlite-');
  let owner = true;
  try {
    const db = new StateDatabase({
      path: path.join(dir, 'sunday-state.sqlite3'),
      assertOwner: () => { if (!owner) { const error = new Error('not owner'); error.code = 'ENOTOWNER'; throw error; } },
    });
    const first = db.put('settings', 'main', { value: 1 }, { expectedRevision: 0 });
    assert.equal(first.revision, 1);
    assert.throws(() => db.put('settings', 'main', { value: 2 }, { expectedRevision: 0 }), error => error.code === 'ESTALEWRITE');
    assert.throws(() => db.transaction(() => {
      db.put('settings', 'main', { value: 3 }, { expectedRevision: 1 });
      throw new Error('injected commit failure');
    }), /injected commit failure/);
    assert.deepEqual(db.get('settings', 'main').value, { value: 1 });
    const backup = db.backupTo(path.join(dir, 'backups', 'state-1.sqlite3'));
    assert.equal(fs.existsSync(backup), true);
    owner = false;
    assert.throws(() => db.put('settings', 'main', { value: 4 }), error => error.code === 'ENOTOWNER');
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('transactional state preserves every multi-process writer update', async () => {
  const dir = tempDir('sunday-sqlite-multiprocess-');
  const dbPath = path.join(dir, 'state.sqlite3');
  try {
    const db = new StateDatabase({ path: dbPath, assertOwner: () => true });
    db.put('multiprocess', 'counter', { count: 0 }, { expectedRevision: 0 });
    const worker = path.join(__dirname, 'workers', 'sqlite-writer.js');
    const children = Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [worker, dbPath, '25'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`SQLite worker exited ${code}: ${stderr}`)));
    }));
    await Promise.all(children);
    const final = db.get('multiprocess', 'counter');
    assert.equal(final.value.count, 100);
    assert.equal(final.revision, 101);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('native process actions reject a mismatched capability before terminating an owned test child', {
  skip: process.platform !== 'win32',
}, async () => {
  assert.equal(native.init(), true, native.getLoadError());
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  try {
    const fingerprint = await waitFor(() => {
      const current = native.processFingerprintOf(child.pid);
      return current.processIdentity && current.executablePath && current.fileIdentity ? current : null;
    }, 2000);
    const registry = new ProcessCapabilityRegistry(native, { ttlMs: 5000 });
    const token = registry.issue(child.pid, {
      executablePath: fingerprint.executablePath,
      ownerId: 'test-owner',
      instanceId: 'test-instance',
      slotId: 'test-slot',
    });
    const authorized = registry.authorize(token, 'kill', 'test-owner');
    assert.equal(authorized.ok, true);
    const tampered = Object.assign({}, authorized.record, { processIdentity: 'reused-pid' });
    assert.equal(processes.terminateOwned(tampered).ok, false);
    assert.doesNotThrow(() => process.kill(child.pid, 0));
    const terminated = processes.terminateOwned(authorized.record);
    assert.equal(terminated.ok, true);
    assert.equal(terminated.confirmed, true);
    await new Promise(resolve => child.once('exit', resolve));
  } finally {
    try { child.kill(); } catch (_) {}
  }
});

test('lifecycle rejects async spawn failure and immediate exit as RUNNING', async () => {
  let now = 0;
  const asyncFailure = new ProcessLifecycleController({
    instanceId: 'async-failure', now: () => now, sleep: async ms => { now += ms; },
    validate: async () => ({ ok: true }), prepare: async () => ({ ok: true }),
    spawn: async () => { throw new Error('spawn event failed'); },
    inspect: async () => ({ status: 'UNKNOWN' }), stopOwned: async () => ({ ok: true, confirmed: true }),
  });
  const failed = await asyncFailure.launch({});
  assert.equal(failed.state, STATES.FAILED);
  assert.match(failed.reason, /spawn event failed/);

  const immediateExit = new ProcessLifecycleController({
    instanceId: 'immediate-exit', now: () => now, sleep: async ms => { now += ms; },
    validate: async () => ({ ok: true }), prepare: async () => ({ ok: true }),
    spawn: async () => ({ ok: true, pid: 40, capability: 'opaque' }),
    inspect: async () => ({ status: 'EXITED' }), stopOwned: async () => ({ ok: true, confirmed: true }),
  });
  const exited = await immediateExit.launch({});
  assert.equal(exited.state, STATES.FAILED);
  assert.match(exited.reason, /exited before/);
});

test('lifecycle requires stable running and confirmed stop, then performs bounded restart', async () => {
  let now = 0;
  let spawnCount = 0;
  const lifecycle = new ProcessLifecycleController({
    instanceId: 'stable', now: () => now, sleep: async ms => { now += ms; },
    stableRunningMs: 20, pollMs: 10, startupTimeoutMs: 100, maxRestarts: 1,
    validate: async () => ({ ok: true }), prepare: async () => ({ ok: true }),
    spawn: async () => ({ ok: true, pid: 50 + spawnCount++, capability: `cap-${spawnCount}` }),
    inspect: async () => ({ status: 'RUNNING' }),
    stopOwned: async () => ({ ok: true, confirmed: true }),
  });
  assert.equal((await lifecycle.launch({})).state, STATES.RUNNING);
  assert.equal((await lifecycle.restart({})).state, STATES.RUNNING);
  const bounded = await lifecycle.restart({});
  assert.equal(bounded.state, STATES.FAILED);
  assert.match(bounded.reason, /restart limit/i);
});

test('durable jobs deduplicate retries, persist progress, and ignore late attempts', async () => {
  const dir = tempDir('sunday-jobs-');
  try {
    const db = new StateDatabase({ path: path.join(dir, 'state.sqlite3'), assertOwner: () => true });
    const jobs = new DurableJobSystem({ database: db });
    let calls = 0;
    jobs.register('launch', async (input, context) => {
      calls += 1;
      context.reportProgress(1, 2, 'Prepared');
      if (calls === 1) throw new Error('transient');
      return { clientId: input.clientId };
    }, { maxAttempts: 2 });
    const first = jobs.start('launch', { clientId: 'client-1' }, { idempotencyKey: 'launch-1' });
    const duplicate = jobs.start('launch', { clientId: 'client-1' }, { idempotencyKey: 'launch-1' });
    assert.equal(duplicate.operationId, first.operationId);
    const finished = await waitFor(() => {
      const current = jobs.get(first.operationId);
      return current && current.state === JOB_STATES.SUCCEEDED ? current : null;
    }, 1000);
    assert.equal(calls, 2);
    assert.deepEqual(finished.result, { clientId: 'client-1' });
    assert.equal(finished.attempt, 2);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('durable jobs preserve cancellation as a reconnect-visible final state', async () => {
  const dir = tempDir('sunday-job-cancel-');
  try {
    const db = new StateDatabase({ path: path.join(dir, 'state.sqlite3'), assertOwner: () => true });
    const queue = [];
    const jobs = new DurableJobSystem({ database: db, schedule: fn => queue.push(fn) });
    jobs.register('slow', async () => ({ shouldNotRun: true }));
    const job = jobs.start('slow', {}, { idempotencyKey: 'cancel-me' });
    assert.equal(jobs.cancel(job.operationId).state, JOB_STATES.CANCEL_REQUESTED);
    await queue.shift()();
    const final = jobs.get(job.operationId);
    assert.equal(final.state, JOB_STATES.CANCELLED);
    assert.equal(final.result, null);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('durable jobs abort an active operation and suppress its late result', async () => {
  const dir = tempDir('sunday-job-active-cancel-');
  try {
    const db = new StateDatabase({ path: path.join(dir, 'state.sqlite3'), assertOwner: () => true });
    const jobs = new DurableJobSystem({ database: db });
    let observedAbort = false;
    jobs.register('network-check', async (_input, context) => new Promise(resolve => {
      context.signal.addEventListener('abort', () => {
        observedAbort = true;
        setTimeout(() => resolve({ late: true }), 5);
      }, { once: true });
    }));
    const job = jobs.start('network-check', {}, { idempotencyKey: 'active-cancel-1' });
    await waitFor(() => jobs.get(job.operationId).state === JOB_STATES.RUNNING, 1000);
    assert.equal(jobs.cancel(job.operationId).state, JOB_STATES.CANCEL_REQUESTED);
    const final = await waitFor(() => {
      const current = jobs.get(job.operationId);
      return current.state === JOB_STATES.CANCELLED ? current : null;
    }, 1000);
    assert.equal(observedAbort, true);
    assert.equal(final.result, null);
    assert.equal(jobs.start('network-check', {}, { idempotencyKey: 'active-cancel-1' }).operationId, job.operationId);
    db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('durable jobs recover an interrupted running attempt without duplicate work', async () => {
  const dir = tempDir('sunday-job-reconnect-');
  let db = null;
  try {
    db = new StateDatabase({ path: path.join(dir, 'state.sqlite3'), assertOwner: () => true });
    const abandonedQueue = [];
    const beforeRestart = new DurableJobSystem({ database: db, schedule: fn => abandonedQueue.push(fn) });
    beforeRestart.register('reconnect', async () => ({ from: 'abandoned-owner' }));
    const created = beforeRestart.start('reconnect', {}, { idempotencyKey: 'reconnect-operation-1' });
    db.update('jobs', created.operationId, null, job => Object.assign(job, {
      state: JOB_STATES.RUNNING,
      attempt: 1,
      attemptId: 'abandoned-attempt',
    }));

    const resumedQueue = [];
    let executions = 0;
    const afterRestart = new DurableJobSystem({ database: db, schedule: fn => resumedQueue.push(fn) });
    afterRestart.register('reconnect', async () => {
      executions += 1;
      return { recovered: true };
    });
    assert.deepEqual(afterRestart.resumePending(), [created.operationId]);
    assert.equal(
      afterRestart.start('reconnect', {}, { idempotencyKey: 'reconnect-operation-1' }).operationId,
      created.operationId,
    );
    assert.equal(resumedQueue.length, 1);
    await resumedQueue.shift()();
    const final = afterRestart.get(created.operationId);
    assert.equal(final.state, JOB_STATES.SUCCEEDED);
    assert.equal(final.attempt, 2);
    assert.equal(executions, 1);
    assert.deepEqual(final.result, { recovered: true });
  } finally {
    if (db) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('signed update checks run through durable idempotent jobs', async () => {
  const dir = tempDir('sunday-update-job-');
  let db = null;
  try {
    db = new StateDatabase({ path: path.join(dir, 'state.sqlite3'), assertOwner: () => true });
    const jobs = new DurableJobSystem({ database: db });
    let calls = 0;
    let receivedSignal = null;
    const updater = {
      async check(signal) {
        calls += 1;
        receivedSignal = signal;
        return { state: 'current', acceptedReleaseSequence: 7 };
      },
    };
    registerUpdateJobs(jobs, updater);
    const first = startUpdateCheck(jobs, 'update-check:test-1');
    const duplicate = startUpdateCheck(jobs, 'update-check:test-1');
    assert.equal(duplicate.operationId, first.operationId);
    const final = await waitFor(() => {
      const current = jobs.get(first.operationId);
      return current && current.state === JOB_STATES.SUCCEEDED ? current : null;
    }, 1000);
    assert.equal(calls, 1);
    assert.equal(receivedSignal instanceof AbortSignal, true);
    assert.deepEqual(final.result, { state: 'current', acceptedReleaseSequence: 7 });
  } finally {
    if (db) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('release trust rejects tampering, rollback, wrong publisher, and artifact changes', () => {
  const { publicKey, privateKey } = require('crypto').generateKeyPairSync('ed25519');
  const artifactBytes = Buffer.from('signed artifact fixture');
  const fileBytes = Buffer.from('sunday executable fixture');
  const manifest = {
    schemaVersion: 1,
    product: 'SUNDAY Launcher',
    version: '2.0.0',
    releaseSequence: 42,
    artifacts: [{
      name: 'SundayPortable_2.0.0_x64.zip',
      url: 'https://github.com/SadinKai/SUNDAY/releases/download/v2.0.0/SundayPortable_2.0.0_x64.zip',
      sha256: require('crypto').createHash('sha256').update(artifactBytes).digest('hex'),
      size: artifactBytes.length,
      allowedFiles: [{
        path: 'Sunday.exe',
        size: fileBytes.length,
        sha256: require('crypto').createHash('sha256').update(fileBytes).digest('hex'),
      }],
    }],
    signing: { algorithm: 'Ed25519', keyId: 'test-key', publisher: 'CN=SUNDAY Test Publisher' },
    signature: '',
  };
  manifest.signature = require('crypto').sign(null, Buffer.from(canonicalize(unsignedManifest(manifest))), privateKey).toString('base64');
  const opts = {
    publicKeySpkiBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    publisher: 'CN=SUNDAY Test Publisher',
    minimumSequence: 41,
  };
  const verified = parseAndVerifyManifest(manifest, opts);
  assert.equal(verified.releaseSequence, 42);
  assert.equal(verifyArtifactBuffer(artifactBytes, verified.artifacts[0]), true);
  assert.throws(() => verifyArtifactBuffer(Buffer.from('changed'), verified.artifacts[0]), /size|hash/);
  assert.throws(() => parseAndVerifyManifest(manifest, Object.assign({}, opts, { minimumSequence: 42 })), /not newer/);
  assert.throws(() => parseAndVerifyManifest(manifest, Object.assign({}, opts, { publisher: 'CN=Other' })), /publisher/);
  const tampered = JSON.parse(JSON.stringify(manifest));
  tampered.version = '2.0.1';
  assert.throws(() => parseAndVerifyManifest(tampered, opts), /signature/);
});

test('side-by-side activation requires an owned health handshake and rolls back on failure', async () => {
  const dir = tempDir('sunday-version-store-');
  let db = null;
  try {
    db = new StateDatabase({ path: path.join(dir, 'state.sqlite3'), assertOwner: () => true });
    const source = path.join(dir, 'candidate-source');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'Sunday.exe'), 'sunday-v2');
    fs.writeFileSync(path.join(source, 'node.exe'), 'node-v2');
    const allowed = ['Sunday.exe', 'node.exe'].map(name => {
      const bytes = fs.readFileSync(path.join(source, name));
      return { path: name, size: bytes.length, sha256: require('crypto').createHash('sha256').update(bytes).digest('hex') };
    });
    const versions = new VersionStore({ root: path.join(dir, 'install'), database: db });
    versions.stageCandidate('2.0.0', source, allowed);
    const activated = await versions.activate('2.0.0', 2, {
      verifyCandidate: async () => ({ ok: true }),
      startCandidate: async (_candidate, expected) => ({ capability: 'owned-capability', expected }),
      awaitHealth: async started => ({ ok: true, version: started.expected.version, nonce: started.expected.nonce }),
      stopCandidate: async () => ({ ok: true }),
    });
    assert.equal(activated.ok, true);
    assert.equal(versions.active().version, '2.0.0');

    fs.writeFileSync(path.join(source, 'Sunday.exe'), 'sunday-v3');
    fs.writeFileSync(path.join(source, 'node.exe'), 'node-v3');
    const nextAllowed = ['Sunday.exe', 'node.exe'].map(name => {
      const bytes = fs.readFileSync(path.join(source, name));
      return { path: name, size: bytes.length, sha256: require('crypto').createHash('sha256').update(bytes).digest('hex') };
    });
    versions.stageCandidate('3.0.0', source, nextAllowed);
    await assert.rejects(() => versions.activate('3.0.0', 2, {
      verifyCandidate: async () => ({ ok: true }),
      startCandidate: async () => ({ capability: 'must-not-start' }),
      awaitHealth: async () => ({ ok: true }),
    }), /not newer/);
    let stopped = false;
    const rejected = await versions.activate('3.0.0', 3, {
      verifyCandidate: async () => ({ ok: true }),
      startCandidate: async () => ({ capability: 'owned-v3' }),
      awaitHealth: async () => ({ ok: true, version: 'wrong', nonce: 'wrong' }),
      stopCandidate: async () => { stopped = true; return { ok: true }; },
    });
    assert.equal(rejected.ok, false);
    assert.equal(stopped, true);
    assert.equal(versions.active().version, '2.0.0');
    assert.equal(db.get('update-journal', 'current').value.state, 'ROLLED_BACK');

    fs.writeFileSync(path.join(source, 'Sunday.exe'), 'sunday-v4');
    fs.writeFileSync(path.join(source, 'node.exe'), 'node-v4');
    const tamperAllowed = ['Sunday.exe', 'node.exe'].map(name => {
      const bytes = fs.readFileSync(path.join(source, name));
      return { path: name, size: bytes.length, sha256: require('crypto').createHash('sha256').update(bytes).digest('hex') };
    });
    const candidate4 = versions.stageCandidate('4.0.0', source, tamperAllowed);
    const tampered = await versions.activate('4.0.0', 4, {
      verifyCandidate: async () => ({ ok: true }),
      startCandidate: async (_candidate, expected) => ({ capability: 'owned-v4', expected }),
      awaitHealth: async started => {
        fs.writeFileSync(path.join(candidate4, 'Sunday.exe'), 'tampered-after-start');
        return { ok: true, version: started.expected.version, nonce: started.expected.nonce };
      },
      stopCandidate: async () => ({ ok: true }),
    });
    assert.equal(tampered.ok, false);
    assert.match(tampered.error, /activation verification failed|changed after staging/);
    assert.equal(versions.active().version, '2.0.0');
    assert.equal(fs.existsSync(path.join(dir, 'install', 'health', '4.0.0.json')), false);

    fs.writeFileSync(path.join(source, 'Sunday.exe'), 'sunday-v5');
    fs.writeFileSync(path.join(source, 'node.exe'), 'node-v5');
    const rollbackAllowed = ['Sunday.exe', 'node.exe'].map(name => {
      const bytes = fs.readFileSync(path.join(source, name));
      return { path: name, size: bytes.length, sha256: require('crypto').createHash('sha256').update(bytes).digest('hex') };
    });
    const faulting = new VersionStore({
      root: path.join(dir, 'install'),
      database: db,
      faultInjector(point) { if (point === 'activate:after-pointer') throw new Error('injected activation crash'); },
    });
    faulting.stageCandidate('5.0.0', source, rollbackAllowed);
    const rolledBack = await faulting.activate('5.0.0', 5, {
      verifyCandidate: async () => ({ ok: true }),
      startCandidate: async (_candidate, expected) => ({ capability: 'owned-v5', expected }),
      awaitHealth: async started => ({ ok: true, version: started.expected.version, nonce: started.expected.nonce }),
      stopCandidate: async () => ({ ok: true }),
    });
    assert.equal(rolledBack.ok, false);
    assert.match(rolledBack.error, /injected activation crash/);
    assert.equal(faulting.active().version, '2.0.0');
    assert.equal(db.get('update-state', 'accepted').value.releaseSequence, 2);
    assert.equal(db.get('update-journal', 'current').value.state, 'ROLLED_BACK');

    const stagingFault = new VersionStore({
      root: path.join(dir, 'install'),
      database: db,
      faultInjector(point) { if (point === 'stage:after-rename') throw new Error('injected stage crash'); },
    });
    assert.throws(() => stagingFault.stageCandidate('6.0.0', source, rollbackAllowed), /injected stage crash/);
    assert.equal(fs.existsSync(path.join(dir, 'install', 'versions', '6.0.0')), false);
    assert.equal(db.get('update-candidates', '6.0.0', null).found, false);
  } finally {
    if (db) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('version staging cleans partial state across copy, permission, disk, and rename faults', () => {
  const dir = tempDir('sunday-version-faults-');
  let db = null;
  try {
    db = new StateDatabase({ path: path.join(dir, 'state.sqlite3'), assertOwner: () => true });
    const source = path.join(dir, 'source');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'Sunday.exe'), 'candidate');
    const bytes = fs.readFileSync(path.join(source, 'Sunday.exe'));
    const files = [{
      path: 'Sunday.exe',
      size: bytes.length,
      sha256: require('crypto').createHash('sha256').update(bytes).digest('hex'),
    }];
    const cases = [
      ['6.1.0', 'stage:before-copy', 'copy failure'],
      ['6.2.0', 'stage:after-copy', 'disk full'],
      ['6.3.0', 'stage:before-rename', 'permission denial'],
      ['6.4.0', 'stage:before-rename', 'AV-style lock'],
    ];
    for (const [version, point, message] of cases) {
      const store = new VersionStore({
        root: path.join(dir, 'install'),
        database: db,
        faultInjector(current) { if (current === point) throw new Error(message); },
      });
      assert.throws(() => store.stageCandidate(version, source, files), new RegExp(message));
      assert.equal(fs.existsSync(path.join(dir, 'install', 'versions', version)), false);
      assert.equal(db.get('update-candidates', version, null).found, false);
      assert.deepEqual(
        fs.readdirSync(path.join(dir, 'install', 'versions')).filter(name => name.startsWith('.staging-')),
        [],
      );
    }
  } finally {
    if (db) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('version store deterministically recovers a crash after pointer activation', () => {
  const dir = tempDir('sunday-version-recovery-');
  let db = null;
  try {
    db = new StateDatabase({ path: path.join(dir, 'state.sqlite3'), assertOwner: () => true });
    const store = new VersionStore({ root: path.join(dir, 'install'), database: db });
    const previous = { version: '2.0.0', releaseSequence: 2, activatedAt: '2026-01-01T00:00:00.000Z' };
    atomicJson(store.pointer, { version: '7.0.0', releaseSequence: 7, activatedAt: '2026-01-02T00:00:00.000Z' });
    atomicJson(path.join(store.health, '7.0.0.json'), { version: '7.0.0' });
    db.put('update-state', 'accepted', { version: '2.0.0', releaseSequence: 2 });
    db.put('update-journal', 'current', {
      operationId: 'crashed-operation',
      state: 'ACTIVATING',
      previous,
      candidate: { version: '7.0.0', releaseSequence: 7 },
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    const recovered = store.recoverInterruptedActivation();
    assert.equal(recovered.recovered, true);
    assert.equal(store.active().version, '2.0.0');
    assert.equal(db.get('update-state', 'accepted').value.releaseSequence, 2);
    assert.equal(db.get('update-journal', 'current').value.state, 'ROLLED_BACK');
    assert.equal(fs.existsSync(path.join(store.health, '7.0.0.json')), false);
  } finally {
    if (db) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('update coordinator never treats a public key alone as apply authority', async () => {
  const dir = tempDir('sunday-updater-gate-');
  let db = null;
  try {
    db = new StateDatabase({ path: path.join(dir, 'state.sqlite3'), assertOwner: () => true });
    const coordinator = new UpdateCoordinator({
      currentVersion: '1.8.14',
      database: db,
      publicKeySpkiBase64: 'configured-public-value',
      publisher: 'CN=SUNDAY',
      manifestUrl: 'https://github.com/SadinKai/SUNDAY/releases/latest/download/sunday-release.json',
    });
    assert.equal(coordinator.trustConfigured(), true);
    assert.equal(coordinator.applyConfigured(), false);
    await assert.rejects(coordinator.install(), /not configured/);
  } finally {
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('slot leases survive restart, reject foreign owners, and recover only proven-stale bindings', () => {
  const dir = tempDir('sunday-slot-leases-');
  let db = null;
  try {
    let now = 100_000;
    let inspection = { status: 'MATCH', executablePath: 'C:\\SundaySlots\\slot-001\\RobloxPlayerBeta.exe' };
    db = new StateDatabase({ path: path.join(dir, 'state.sqlite3'), assertOwner: () => true, now: () => now });
    const options = {
      database: db,
      now: () => now,
      ttlMs: 5000,
      maxSlots: 1,
      inspectProcess: () => inspection,
    };
    const leases = new SlotLeaseManager(options);
    const reserved = leases.reserve('owner-a', 'account-a');
    assert.equal(reserved.slotId, 'slot-001');
    assert.ok(reserved.token);
    assert.equal(leases.list()[0].token, undefined);
    assert.notEqual(db.get('slot-leases', 'slot-001').value.tokenHash, reserved.token);
    assert.throws(() => leases.reserve('owner-b', 'account-b'), err => err.code === 'ELEASEBUSY');
    assert.throws(() => leases.bind('owner-b', reserved.token, {
      pid: 123,
      processIdentity: 'created-1',
      fileIdentity: 'file-1',
      executablePath: 'C:\\SundaySlots\\slot-001\\RobloxPlayerBeta.exe',
    }), err => err.code === 'ELEASEAUTH');
    leases.bind('owner-a', reserved.token, {
      pid: 123,
      processIdentity: 'created-1',
      fileIdentity: 'file-1',
      executablePath: 'C:\\SundaySlots\\slot-001\\RobloxPlayerBeta.exe',
    });
    assert.throws(() => leases.release('owner-a', reserved.token), err => err.code === 'ELEASEACTIVE');

    now += 6000;
    assert.deepEqual(leases.recoverExpired(), []);
    inspection = { status: 'UNKNOWN' };
    assert.deepEqual(leases.recoverExpired(), []);
    inspection = { status: 'MISMATCH', executablePath: 'C:\\SundaySlots\\slot-001\\RobloxPlayerBeta.exe' };
    assert.deepEqual(leases.recoverExpired(), []);

    inspection = { status: 'MISMATCH', executablePath: 'C:\\Windows\\System32\\notepad.exe' };
    const restarted = new SlotLeaseManager(options);
    assert.deepEqual(restarted.recoverExpired(), ['slot-001']);
    const replacement = restarted.reserve('owner-b', 'account-b');
    assert.equal(replacement.slotId, 'slot-001');
    assert.throws(() => restarted.release('owner-a', replacement.token), err => err.code === 'ELEASEAUTH');
    assert.equal(restarted.release('owner-b', replacement.token).released, true);

    const crashLease = restarted.reserve('owner-c', 'account-c');
    restarted.bind('owner-c', crashLease.token, {
      pid: 456,
      processIdentity: 'created-2',
      fileIdentity: 'file-2',
      executablePath: 'C:\\SundaySlots\\slot-001\\RobloxPlayerBeta.exe',
    });
    now += 6000;
    inspection = { status: 'ABSENT' };
    const afterCrash = new SlotLeaseManager(options);
    assert.deepEqual(afterCrash.recoverExpired(), ['slot-001']);
  } finally {
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('slot reservation remains single-winner across competing processes', async () => {
  const dir = tempDir('sunday-slot-contention-');
  const dbPath = path.join(dir, 'state.sqlite3');
  let db = null;
  try {
    db = new StateDatabase({ path: dbPath, assertOwner: () => true });
    const worker = path.join(__dirname, 'workers', 'slot-reserver.js');
    const attempts = Array.from({ length: 4 }, (_, index) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [worker, dbPath, `owner-${index}`], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
      child.once('error', reject);
      child.once('exit', code => {
        if (code !== 0) return reject(new Error(`Slot worker exited ${code}: ${stderr}`));
        try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
      });
    }));
    const results = await Promise.all(attempts);
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.equal(results.filter(result => result.code === 'ELEASEBUSY').length, 3);
    assert.equal(db.list('slot-leases').length, 1);
  } finally {
    db?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
