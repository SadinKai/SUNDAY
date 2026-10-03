'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ProcessCapabilityRegistry } = require('../src/main/process-capabilities');
const {
  ISOLATION_STATES,
  adapterSelectionDiagnostics,
  legacyCompatRequested,
  selectRobloxIsolationAdapter,
} = require('../src/main/roblox-isolation-adapter');
const { LegacyCloneManager, LegacyRobloxIsolationAdapter } = require('../src/main/legacy-roblox-isolation-adapter');

test('LEGACY_COMPAT must equal 1 before legacy implementation is loaded', async () => {
  let loads = 0;
  for (const [label, environment, observedValue] of [
    ['absent', {}, 'ABSENT'],
    ['zero', { LEGACY_COMPAT: '0' }, '0'],
    ['true', { LEGACY_COMPAT: 'true' }, 'true'],
  ]) {
    const off = selectRobloxIsolationAdapter({
      environment,
      reason: 'safe default',
      unavailableReason: 'multi-instance disabled',
      loadLegacy() { loads += 1; throw new Error('must not load'); },
    });
    assert.equal(loads, 0, `${label} must not load the legacy implementation`);
    assert.equal(off.constructor.name, 'UnavailableRobloxIsolationAdapter');
    assert.equal((await off.preflight()).state, ISOLATION_STATES.UNAVAILABLE);
    assert.deepEqual(adapterSelectionDiagnostics(off), {
      legacyCompatEnabled: false,
      legacyCompatEnvironmentValue: observedValue,
      selectedAdapter: 'UnavailableRobloxIsolationAdapter',
      isolationState: ISOLATION_STATES.UNAVAILABLE,
      reason: 'multi-instance disabled',
    });
  }
  assert.equal(legacyCompatRequested({ LEGACY_COMPAT: 'true' }), false);
  assert.equal(legacyCompatRequested({ LEGACY_COMPAT: '1' }), true);

  class SelectedLegacy {
    constructor(options) { this.options = options; }
  }
  const on = selectRobloxIsolationAdapter({
    environment: { LEGACY_COMPAT: '1' },
    legacyOptions: { marker: 'explicit' },
    loadLegacy() { loads += 1; return SelectedLegacy; },
  });
  assert.equal(loads, 1);
  assert.equal(on instanceof SelectedLegacy, true);
  assert.equal(on.options.marker, 'explicit');
  assert.deepEqual(adapterSelectionDiagnostics(on), {
    legacyCompatEnabled: true,
    legacyCompatEnvironmentValue: '1',
    selectedAdapter: 'SelectedLegacy',
    isolationState: ISOLATION_STATES.LEGACY_COMPAT,
    reason: 'No independently qualified ownership-preserving Roblox isolation environment is activated.',
  });
});

function fixture(options = {}) {
  const processes = [];
  let nextPid = 100;
  const native = {
    isAvailable: () => true,
    getLoadError: () => '',
    listProcesses: () => processes.map(row => Object.assign({}, row)),
    processFingerprintOf(pid) {
      const row = processes.find(item => item.pid === Number(pid));
      return row ? {
        processIdentity: row.processIdentity,
        executablePath: row.executablePath,
        fileIdentity: `file-${row.processIdentity}`,
      } : { processIdentity: '', executablePath: '', fileIdentity: '' };
    },
    processIdentityOf(pid) {
      return (processes.find(item => item.pid === Number(pid)) || {}).processIdentity || '';
    },
    windowInfoForPids(pids) {
      return new Map(pids.filter(pid => processes.some(row => row.pid === pid))
        .map(pid => [pid, options.window || {
          title: 'Roblox',
          className: 'WINDOWSCLIENT',
          responding: true,
        }]));
    },
    terminateOwned(record) {
      const index = processes.findIndex(row => row.pid === record.pid
        && row.processIdentity === record.processIdentity
        && row.executablePath.toLowerCase() === record.executablePath.toLowerCase());
      if (index < 0) return { ok: false, confirmed: false, reason: 'identity mismatch' };
      processes.splice(index, 1);
      return { ok: true, confirmed: true };
    },
  };
  const legacyNative = {
    held: true,
    isAvailable: () => true,
    getLoadError: () => '',
    acquireSingletonNames: () => ({ ok: true, held: 2, total: 2 }),
    singletonNamesOwned() { return this.held; },
    closeGlobalSingletonHandles: () => ({ ok: true, closed: 0, scanned: 0 }),
  };
  const slots = new Map();
  const cloneManager = {
    acquire() {
      const slotId = ['instance-1', 'instance-2', 'instance-3'].find(id => !slots.has(id));
      if (!slotId) throw new Error('full');
      const value = { slotId, executablePath: `C:\\Sunday\\${slotId}\\RobloxPlayerBeta.exe` };
      slots.set(slotId, value);
      return value;
    },
    release(slotId) { slots.delete(slotId); return { ok: true, released: true }; },
  };
  const monitor = new EventEmitter();
  monitor.managed = new Map();
  monitor.markManaged = (pid, metadata) => monitor.managed.set(pid, metadata);
  monitor.forget = pid => monitor.managed.delete(pid);
  const registry = new ProcessCapabilityRegistry(native);
  const adapter = new LegacyRobloxIsolationAdapter({
    logger: { info() {}, warn() {}, error() {} },
    nativeApi: native,
    legacyNativeApi: legacyNative,
    processCapabilities: registry,
    ownerId: 'test-owner',
    monitor,
    cloneManager,
    locateRoblox: () => ({ found: true, playerPath: 'C:\\Roblox\\version-1\\RobloxPlayerBeta.exe' }),
    spawnProcess(executablePath) {
      const pid = nextPid++;
      processes.push({ pid, processIdentity: `created-${pid}`, executablePath });
      return { pid, once() {}, unref() {} };
    },
    pollMs: 10,
    stableSamples: 1,
    launchTimeoutMs: 500,
    requireWindow: true,
    forensicPath: options.forensicPath || '',
  });
  return { adapter, processes, registry, monitor };
}

async function launch(adapter, operationId, accountId) {
  const allocated = await adapter.allocateInstance({ operationId, accountId });
  assert.equal(allocated.state, ISOLATION_STATES.LEGACY_COMPAT);
  return adapter.launch({
    mode: 'deeplink',
    launchUri: 'roblox-player:ephemeral-test-ticket',
    profileName: accountId,
  }, { environmentId: allocated.environmentId, operation: { operationId, accountId } });
}

test('legacy adapter owns exact clients and close/restart leaves siblings alive', async () => {
  const { adapter, processes, registry } = fixture();
  try {
    const preflight = await adapter.preflight();
    assert.equal(preflight.state, ISOLATION_STATES.LEGACY_COMPAT);
    assert.equal(preflight.qualified, false);
    const first = await launch(adapter, 'operation-a', 'account-a');
    const second = await launch(adapter, 'operation-b', 'account-b');
    assert.equal(first.stable, true);
    assert.equal(second.stable, true);
    assert.equal(processes.length, 2);

    const firstRecord = registry.authorize(first.capability, 'observe', 'test-owner');
    const secondRecord = registry.authorize(second.capability, 'observe', 'test-owner');
    assert.equal(firstRecord.ok, true);
    assert.equal(secondRecord.ok, true);
    const stopped = await adapter.stop(first.capability);
    assert.equal(stopped.confirmed, true);
    assert.equal(processes.length, 1);
    assert.equal(processes[0].pid, second.pid);

    const restarted = await adapter.restart({
      mode: 'deeplink',
      launchUri: 'roblox-player:fresh-ephemeral-test-ticket',
      profileName: 'account-b',
    }, { capability: second.capability, operation: { operationId: 'operation-b', accountId: 'account-b' } });
    assert.equal(restarted.ok, true);
    assert.notEqual(restarted.pid, second.pid);
    assert.equal(processes.length, 1);
  } finally {
    adapter.shutdown();
  }
});

test('legacy forensic launch evidence never records the raw launch URI or ticket', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-forensic-redaction-'));
  const forensicPath = path.join(root, 'launch.jsonl');
  const secret = 'synthetic-ticket-MUST-NOT-LEAVE-BOUNDARY';
  const { adapter } = fixture({ forensicPath });
  try {
    await adapter.preflight();
    const allocated = await adapter.allocateInstance({ operationId: 'operation-secret', accountId: 'account-a' });
    const launched = await adapter.launch({
      mode: 'deeplink',
      launchUri: `roblox-player:gameinfo:${secret}`,
      profileName: 'account-a',
    }, { environmentId: allocated.environmentId, operation: { operationId: 'operation-secret', accountId: 'account-a' } });
    assert.equal(launched.ok, true);
    const persisted = fs.readFileSync(forensicPath, 'utf8');
    assert.doesNotMatch(persisted, new RegExp(secret));
    assert.doesNotMatch(persisted, /roblox-player:/i);
    assert.match(persisted, /"hasLaunchUri":true/);
  } finally {
    adapter.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('legacy adapter rejects arbitrary capabilities and never exposes a kill-all operation', async () => {
  const { adapter, processes } = fixture();
  try {
    await adapter.preflight();
    const launched = await launch(adapter, 'operation-a', 'account-a');
    const before = processes.slice();
    const refused = await adapter.stop('user-supplied-pid-or-token');
    assert.equal(refused.ok, false);
    assert.deepEqual(processes, before);
    assert.equal(typeof adapter.killAll, 'undefined');
    assert.equal(typeof adapter.terminateByName, 'undefined');
    assert.equal((await adapter.observe(launched.capability)).status, 'RUNNING');
  } finally {
    adapter.shutdown();
  }
});

test('legacy adapter never promotes a Roblox startup error dialog to RUNNING', async () => {
  const { adapter, registry } = fixture({
    window: {
      title: 'Roblox',
      className: '#32770',
      rect: { left: 0, top: 0, right: 427, bottom: 166, width: 427, height: 166 },
      responding: true,
    },
  });
  try {
    await adapter.preflight();
    const launched = await launch(adapter, 'operation-error-dialog', 'account-a');
    assert.equal(launched.ok, false);
    assert.equal(launched.status, 'FAILED');
    assert.match(launched.reason, /startup error dialog/i);
    assert.equal(registry.records.size, 0);
    assert.equal(adapter.diagnostics().environments[0].state, 'FAILED');
  } finally {
    adapter.shutdown();
  }
});

test('legacy clone builder preserves directory reparse points and rejects content-is-not-a-directory before spawn', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-legacy-clone-'));
  const version = path.join(temporary, 'version-fixture');
  const clones = path.join(temporary, 'legacy-instances');
  try {
    fs.mkdirSync(version);
    fs.writeFileSync(path.join(version, 'RobloxPlayerBeta.exe'), 'synthetic executable');
    fs.writeFileSync(path.join(version, 'AppSettings.xml'), '<Settings/>');
    fs.writeFileSync(path.join(version, 'regular-file.dll'), 'regular file');
    fs.mkdirSync(path.join(version, 'content'));
    fs.writeFileSync(path.join(version, 'content', 'fixture.txt'), 'content');
    fs.mkdirSync(path.join(version, 'normal-directory'));
    fs.writeFileSync(path.join(version, 'normal-directory', 'normal.txt'), 'normal');
    const directoryTarget = path.join(temporary, 'directory-target');
    fs.mkdirSync(directoryTarget);
    fs.writeFileSync(path.join(directoryTarget, 'shared.txt'), 'shared');
    fs.symlinkSync(directoryTarget, path.join(version, 'reparse-directory'), 'junction');

    const fileTarget = path.join(temporary, 'reparse-file-target.bin');
    fs.writeFileSync(fileTarget, 'reparse file');
    let fileReparseSupported = true;
    try { fs.symlinkSync(fileTarget, path.join(version, 'reparse-file.bin'), 'file'); }
    catch (_) { fileReparseSupported = false; }

    const manager = new LegacyCloneManager({ root: clones, logger: { info() {}, warn() {} } });
    const built = manager.acquire(version, []);
    assert.equal(built.slotId, 'instance-1');
    assert.equal(built.validation.ok, true);
    const content = path.join(built.directory, 'content');
    assert.equal(fs.lstatSync(content).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(content).isDirectory(), true);
    assert.equal(fs.statSync(content).isDirectory(), true);
    assert.notEqual(fs.realpathSync(content), fs.realpathSync(path.join(version, 'content')));
    assert.equal(fs.readFileSync(path.join(content, 'fixture.txt'), 'utf8'), 'content');
    assert.equal(fs.lstatSync(path.join(built.directory, 'normal-directory')).isSymbolicLink(), true);
    assert.equal(fs.statSync(path.join(built.directory, 'reparse-directory')).isDirectory(), true);
    assert.equal(fs.lstatSync(path.join(built.directory, 'regular-file.dll')).isFile(), true);
    if (fileReparseSupported) {
      assert.equal(fs.lstatSync(path.join(built.directory, 'reparse-file.bin')).isFile(), true);
      assert.equal(fs.lstatSync(path.join(built.directory, 'reparse-file.bin')).isSymbolicLink(), false);
    }

    fs.unlinkSync(path.join(content, 'fixture.txt'));
    fs.rmdirSync(content);
    fs.writeFileSync(content, 'not a directory');
    assert.throws(
      () => manager.validateSlot('instance-1', version),
      /content .*directory/i,
    );
    assert.equal(fs.statSync(path.join(version, 'content')).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(version, 'content', 'fixture.txt'), 'utf8'), 'content');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('legacy clone launch path is canonical when its logical root is virtualized or redirected', () => {
  const temporary = fs.mkdtempSync(path.join(process.cwd(), '.sunday-legacy-canonical-'));
  const version = path.join(temporary, 'version-fixture');
  const physicalClones = path.join(temporary, 'physical-clones');
  const logicalClones = path.join(temporary, 'logical-clones');
  try {
    fs.mkdirSync(version);
    fs.mkdirSync(physicalClones);
    fs.writeFileSync(path.join(version, 'RobloxPlayerBeta.exe'), 'synthetic executable');
    fs.mkdirSync(path.join(version, 'content'));
    fs.writeFileSync(path.join(version, 'content', 'fixture.txt'), 'content');
    fs.symlinkSync(physicalClones, logicalClones, 'junction');

    const manager = new LegacyCloneManager({ root: logicalClones, logger: { info() {}, warn() {} } });
    const built = manager.acquire(version, []);
    assert.equal(built.executablePath.startsWith(logicalClones + path.sep), true);
    assert.equal(built.launchExecutablePath.startsWith(fs.realpathSync.native(physicalClones) + path.sep), true);
    assert.equal(built.launchExecutablePath, fs.realpathSync.native(built.executablePath));
    assert.equal(fs.statSync(path.join(path.dirname(built.launchExecutablePath), 'content')).isDirectory(), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('legacy slot release defers only directory reclamation while a hard-linked sibling remains live', () => {
  const temporary = fs.mkdtempSync(path.join(process.cwd(), '.sunday-legacy-release-'));
  try {
    const manager = new LegacyCloneManager({ root: temporary, logger: { info() {}, warn() {} } });
    const slotId = 'instance-1';
    const slotDirectory = path.join(temporary, slotId);
    fs.mkdirSync(slotDirectory);
    manager.reserved.add(slotId);
    manager.reclaim = () => ({
      state: 'RELEASABLE_BUT_BUSY',
      ownership: 'RELEASED',
      reclamation: 'BUSY',
      reusable: false,
    });
    const released = manager.release(slotId, [{
      pid: 321,
      processIdentity: 'sibling',
      executablePath: path.join(temporary, 'instance-2', 'RobloxPlayerBeta.exe'),
    }]);
    assert.equal(released.ok, true);
    assert.equal(released.released, true);
    assert.equal(released.deferredReclaim, true);
    assert.equal(manager.reserved.has(slotId), false);
    assert.equal(fs.existsSync(slotDirectory), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('legacy first allocation sweeps stale slots before a live hard-linked sibling can mask them', () => {
  const temporary = fs.mkdtempSync(path.join(process.cwd(), '.sunday-legacy-sweep-'));
  try {
    const manager = new LegacyCloneManager({ root: temporary, logger: { info() {}, warn() {} } });
    const reclaimed = [];
    manager.reclaim = slotId => {
      reclaimed.push(slotId);
      return {
        instanceId: slotId,
        state: 'FREE',
        ownership: 'RELEASED',
        reclamation: 'REMOVED',
        reusable: true,
      };
    };
    manager._build = slotId => ({
      slotId,
      directory: path.join(temporary, slotId),
      executablePath: path.join(temporary, slotId, 'RobloxPlayerBeta.exe'),
      launchExecutablePath: path.join(temporary, slotId, 'RobloxPlayerBeta.exe'),
      validation: { ok: true },
    });
    const built = manager.acquire('C:\\synthetic-roblox-version', [], {
      buildCount: 0,
      validationCount: 0,
      launchCount: 0,
    });
    assert.deepEqual(reclaimed.slice(0, 3), ['instance-1', 'instance-2', 'instance-3']);
    assert.equal(built.slotId, 'instance-1');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('legacy released busy slot is not occupied and restart allocates a fresh slot without touching siblings', () => {
  const temporary = fs.mkdtempSync(path.join(process.cwd(), '.sunday-legacy-restart-reuse-'));
  const version = path.join(temporary, 'version-fixture');
  const clones = path.join(temporary, 'legacy-instances');
  let sharedMappingActive = false;
  try {
    fs.mkdirSync(version);
    fs.writeFileSync(path.join(version, 'RobloxPlayerBeta.exe'), 'synthetic executable');
    fs.writeFileSync(path.join(version, 'AppSettings.xml'), '<Settings/>');
    fs.mkdirSync(path.join(version, 'content'));
    fs.writeFileSync(path.join(version, 'content', 'fixture.txt'), 'content');

    const manager = new LegacyCloneManager({
      root: clones,
      logger: { info() {}, warn() {} },
      reclaimProbe(executablePath, slotId) {
        if (slotId === 'instance-1' && sharedMappingActive) {
          const error = new Error(`EBUSY: shared hard-linked bytes remain mapped, open '${executablePath}'`);
          error.code = 'EBUSY';
          throw error;
        }
        const handle = fs.openSync(executablePath, 'r+');
        fs.closeSync(handle);
      },
    });
    const trace = operationId => ({
      allocationId: operationId,
      operationId,
      instanceId: null,
      allocationCount: 1,
      buildCount: 0,
      validationCount: 0,
      launchCount: 0,
    });
    const first = manager.acquire(version, [], trace('operation-a'));
    const second = manager.acquire(version, [], trace('operation-b'));
    const third = manager.acquire(version, [], trace('operation-c'));
    assert.deepEqual([first.slotId, second.slotId, third.slotId], ['instance-1', 'instance-2', 'instance-3']);

    const liveRows = [
      { pid: 202, processIdentity: 'identity-b', executablePath: second.launchExecutablePath },
      { pid: 303, processIdentity: 'identity-c', executablePath: third.launchExecutablePath },
    ];
    const ownedSlots = new Map([
      ['instance-2', { capability: 'capability-b', pid: 202, processIdentity: 'identity-b', executablePath: second.launchExecutablePath }],
      ['instance-3', { capability: 'capability-c', pid: 303, processIdentity: 'identity-c', executablePath: third.launchExecutablePath }],
    ]);
    sharedMappingActive = true;
    const released = manager.release('instance-1', liveRows, ownedSlots);
    assert.equal(released.ok, true);
    assert.equal(released.released, true);
    assert.equal(released.deferredReclaim, true);
    assert.equal(manager.reserved.has('instance-1'), false);
    assert.equal(manager.getSlotState('instance-1').state, 'RELEASABLE_BUT_BUSY');
    assert.equal(manager.getSlotState('instance-1').ownership, 'RELEASED');
    assert.equal(manager.getSlotState('instance-1').reclamation, 'BUSY');
    assert.equal(manager.getSlotState('instance-2').state, 'OCCUPIED');
    assert.equal(manager.getSlotState('instance-3').state, 'OCCUPIED');

    const restartTrace = trace('operation-a-restart');
    const restarted = manager.acquire(version, liveRows, restartTrace, ownedSlots);
    assert.equal(restarted.slotId, 'instance-4');
    assert.equal(restartTrace.allocationCount, 1);
    assert.equal(restartTrace.buildCount, 1);
    assert.equal(restartTrace.validationCount, 1);
    assert.equal(restartTrace.launchCount, 0);
    assert.equal(fs.existsSync(first.directory), true);
    assert.equal(fs.existsSync(second.directory), true);
    assert.equal(fs.existsSync(third.directory), true);

    sharedMappingActive = false;
    manager.sweep(liveRows, ownedSlots);
    assert.equal(manager.getSlotState('instance-1').state, 'FREE');
    assert.equal(fs.existsSync(first.directory), false);
    assert.equal(fs.existsSync(second.directory), true);
    assert.equal(fs.existsSync(third.directory), true);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
