'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { StateDatabase } = require('../src/main/state-database');
const { ProcessCapabilityRegistry } = require('../src/main/process-capabilities');
const { LegacyOwnershipStore, NAMESPACE: LEGACY_OWNERSHIP_NAMESPACE } = require('../src/main/legacy-ownership');
const { MAX_LEGACY_MANAGED_CLIENTS, MAX_LEGACY_PHYSICAL_SLOTS } = require('../src/main/legacy-capacity');
const { LaunchCoordinator, LaunchPlanStore, PLAN_STATES } = require('../src/main/launch-orchestration');
const { LegacyCloneManager, LegacyRobloxIsolationAdapter, SLOT_STATES } = require('../src/main/legacy-roblox-isolation-adapter');
const { ISOLATION_STATES } = require('../src/main/roblox-isolation-adapter');
const model = require('../src/renderer/model');

test('canonical legacy capacity is six with bounded multi-generation physical headroom', () => {
  assert.equal(MAX_LEGACY_MANAGED_CLIENTS, 6);
  assert.ok(MAX_LEGACY_PHYSICAL_SLOTS > MAX_LEGACY_MANAGED_CLIENTS + 1);
  assert.equal(model.managedClientCapacity({ legacyManagedClients: { maxConcurrent: 6 } }, true), 6);
  assert.equal(model.managedClientCapacity({ legacyManagedClients: { maxConcurrent: 6 } }, false), 1);
});

test('completed launch selection removes only successful participants', () => {
  const selected = new Set(['a', 'b', 'c']);
  assert.deepEqual(model.selectionAfterLaunch(selected, {
    results: [
      { accountId: 'a', ok: true },
      { accountId: 'b', ok: true },
      { accountId: 'c', ok: false },
    ],
  }), ['c']);
  assert.deepEqual(Array.from(selected), ['a', 'b', 'c']);
});

test('renderer clears completed A+B through refreshes and the next plan contains only C', async () => {
  const launches = [];
  const callTimeouts = [];
  const state = {
    selected: new Set(['A', 'B']),
    instances: [],
    accounts: [
      { id: 'A', username: 'account-a' },
      { id: 'B', username: 'account-b' },
      { id: 'C', username: 'account-c' },
    ],
    view: 'instances',
    placeId: '',
    settings: {},
    logs: [],
  };
  let refreshedInstances = [];
  let refreshedAccounts = state.accounts.slice();
  let clickHandler = null;
  const completedResponse = accountIds => ({
    ok: true,
    state: ISOLATION_STATES.LEGACY_COMPAT,
    launched: accountIds.length,
    failed: 0,
    plan: {
      state: PLAN_STATES.COMPLETED,
      operations: accountIds.map((accountId, index) => ({
        accountId,
        state: 'RUNNING',
        pid: 800 + index,
      })),
    },
    results: accountIds.map(accountId => ({ accountId, ok: true, state: 'RUNNING' })),
  });
  const api = {
    launch: {
      async accounts(accountIds) {
        const ids = Array.from(accountIds, String);
        launches.push(ids);
        return completedResponse(ids);
      },
    },
    instances: { async get() { return { instances: refreshedInstances }; } },
    accounts: { async list() { return { accounts: refreshedAccounts }; } },
    onInstances() {},
    onLog() {},
    onAccountUpdate() {},
    onAccountExpired() {},
    onAccountAdded() {},
    onKeeperStatus() {},
    onKeeperRejoin() {},
    onKeeperGaveup() {},
    onLaunchPlan() {},
    onUpdaterStatus() {},
  };
  const document = {
    addEventListener(type, handler) { if (type === 'click') clickHandler = handler; },
    getElementById() { return null; },
    querySelector() { return null; },
  };
  const context = vm.createContext({
    Array,
    Date,
    JSON,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    api,
    armWatchdog() {},
    call: async (operation, _fallback, timeoutMs) => {
      callTimeouts.push(timeoutMs);
      return operation();
    },
    capabilityAvailable: () => true,
    clearLaunchFailure() {},
    content: { addEventListener() {} },
    document,
    findAllByData: () => [],
    handlePreparedPlan: () => false,
    parseRobloxTarget: () => ({ invalid: false, gameId: '', placeId: '' }),
    refreshInstanceElapsedTimes() {},
    refreshVisiblePeoplePresence() {},
    renderInstanceList() {},
    requestAnimationFrame(callback) { callback(); return 1; },
    setInterval: () => 0,
    state,
    toast() {},
    updateAccountsCount() {},
    updateAccountsLaunchButton() {},
    updateLaunchCount() {},
    updateNavCount() {},
    views: { accounts() {}, instances() {} },
    window: {},
    $: selector => selector === '#lp-place' ? { value: '' } : null,
  });
  context.activeManagedAccountIds = () => new Set((state.instances || [])
    .filter(instance => instance && instance.source === 'sunday' && instance.accountId)
    .map(instance => String(instance.accountId)));
  context.applyLaunchSelectionResult = response => {
    state.selected = new Set(model.selectionAfterLaunch(state.selected, response));
  };
  context.legacyManagedClientLimit = () => MAX_LEGACY_MANAGED_CLIENTS;

  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'actions.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'runtime.js'), 'utf8'), context);
  assert.equal(typeof clickHandler, 'function');

  const dispatch = (action, id = '') => clickHandler({
    target: { closest: () => ({ dataset: { action, id }, disabled: false }) },
  });

  await dispatch('launch-accounts');
  assert.deepEqual(launches, [['A', 'B']]);
  assert.equal(callTimeouts[0], 0);
  assert.equal(state.selected.size, 0);

  refreshedInstances = [
    { source: 'sunday', accountId: 'A', state: 'RUNNING', pid: 800 },
    { source: 'sunday', accountId: 'B', state: 'RUNNING', pid: 801 },
  ];
  await vm.runInContext('loadInstances()', context);
  assert.equal(state.selected.size, 0);

  refreshedAccounts = state.accounts.slice();
  await vm.runInContext('loadAccounts()', context);
  assert.equal(state.selected.size, 0);

  await dispatch('toggle-account', 'C');
  assert.deepEqual(Array.from(state.selected), ['C']);
  await dispatch('launch-accounts');
  assert.deepEqual(launches, [['A', 'B'], ['C']]);
  assert.equal(callTimeouts.at(-1), 0);
});

test('legacy ownership persistence preserves additive metadata but strips capability-like fields', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-ownership-store-'));
  const database = new StateDatabase({ path: path.join(dir, 'state.sqlite3'), assertOwner: () => true });
  try {
    database.put(LEGACY_OWNERSHIP_NAMESPACE, 'operation-1', {
      schemaVersion: 1,
      operationId: 'operation-1',
      futureHint: 'preserve-me',
      capability: 'must-not-survive',
      future: { safe: 'preserve-me-too', token: 'must-not-survive' },
    }, { expectedRevision: 0 });
    const store = new LegacyOwnershipStore({ database });
    const persisted = store.put({
      operationId: 'operation-1',
      accountId: 'account-1',
      profileName: 'Account 1',
      environmentId: 'environment-1',
      instanceId: 'instance-1',
      slotId: 'instance-1',
      pid: 501,
      processIdentity: 'created-501',
      executablePath: 'C:\\Sunday\\legacy-instances\\instance-1\\RobloxPlayerBeta.exe',
      fileIdentity: 'file-created-501',
      sourcePlayerPath: 'C:\\Roblox\\RobloxPlayerBeta.exe',
      startedAt: new Date().toISOString(),
    });
    assert.equal(persisted.futureHint, 'preserve-me');
    assert.equal(persisted.future.safe, 'preserve-me-too');
    assert.equal(persisted.capability, undefined);
    assert.equal(persisted.future.token, undefined);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('coordinator drops a stale capability when restart fails after the old client stopped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-restart-failure-'));
  const database = new StateDatabase({ path: path.join(dir, 'state.sqlite3'), assertOwner: () => true });
  try {
    const adapter = {
      async preflight() { return { ok: true, state: ISOLATION_STATES.ACTIVATED }; },
      async allocateInstance() { return { ok: true, state: ISOLATION_STATES.ACTIVATED, environmentId: 'environment-1', instanceId: 'instance-1' }; },
      async launch() { return { ok: true, state: ISOLATION_STATES.ACTIVATED, capability: 'runtime-capability', pid: 701 }; },
      async restart() {
        return {
          ok: false,
          state: ISOLATION_STATES.LEGACY_COMPAT,
          previousStopped: true,
          status: 'FAILED',
          reason: 'No safe replacement slot is available.',
        };
      },
    };
    const coordinator = new LaunchCoordinator({
      adapter,
      store: new LaunchPlanStore({ database }),
      resolveIntent: async () => ({ ok: true, intent: { mode: 'client' } }),
    });
    const launched = await coordinator.prepare({ participants: participants(1, 1), target: { type: 'HOME' } });
    const operation = launched.plan.operations[0];
    const restarted = await coordinator.restart(launched.planId, operation.operationId);
    assert.equal(restarted.ok, false);
    assert.equal(restarted.plan.operations[0].state, 'STOPPED');
    assert.equal(coordinator.findOperationByCapability('runtime-capability'), null);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('allocator skips multiple released-but-busy histories, prefers a proven reusable slot, and admits six active reservations', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-six-allocator-'));
  try {
    for (const slotId of ['instance-1', 'instance-2', 'instance-3']) {
      fs.mkdirSync(path.join(root, slotId));
    }
    const manager = new LegacyCloneManager({ root });
    const busy = new Set(['instance-1', 'instance-2']);
    manager.reclaim = function reclaim(slotId) {
      if (busy.has(slotId)) {
        return Object.assign({ reusable: false }, this._setSlotState(slotId, SLOT_STATES.RELEASABLE_BUT_BUSY, {
          ownership: 'RELEASED', reclamation: 'BUSY', reservation: 'NONE', reason: 'synthetic busy history',
        }));
      }
      return Object.assign({ reusable: true }, this._setSlotState(slotId, SLOT_STATES.FREE, {
        ownership: 'RELEASED', reclamation: 'READY', reservation: 'NONE', reason: 'synthetic reusable slot',
      }));
    };
    manager._build = slotId => ({
      slotId,
      executablePath: path.join(root, slotId, 'RobloxPlayerBeta.exe'),
      launchExecutablePath: path.join(root, slotId, 'RobloxPlayerBeta.exe'),
    });
    const allocated = Array.from({ length: 6 }, () => manager.acquire('C:\\Roblox', [{ executablePath: 'C:\\Foreign\\RobloxPlayerBeta.exe' }], null, new Map()));
    assert.deepEqual(allocated.map(item => item.slotId), [
      'instance-3', 'instance-4', 'instance-5', 'instance-6', 'instance-7', 'instance-8',
    ]);
    assert.equal(manager.capacitySnapshot().releasedButBusySlotCount, 2);
    assert.throws(
      () => manager.acquire('C:\\Roblox', [], null, new Map()),
      /6 active or in-flight managed clients/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('allocator chooses the lowest-numbered safe slot even when a higher existing directory is reusable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-lowest-safe-slot-'));
  try {
    fs.mkdirSync(path.join(root, 'instance-8'));
    const manager = new LegacyCloneManager({ root });
    manager.reclaim = function reclaim(slotId) {
      if (slotId === 'instance-1' || slotId === 'instance-2') {
        return Object.assign({ reusable: false }, this._setSlotState(slotId, SLOT_STATES.RELEASABLE_BUT_BUSY, {
          ownership: 'RELEASED', reclamation: 'BUSY', reservation: 'NONE', reason: 'synthetic busy history',
        }));
      }
      return Object.assign({ reusable: true }, this._setSlotState(slotId, SLOT_STATES.FREE, {
        ownership: 'RELEASED', reclamation: 'READY', reservation: 'NONE', reason: 'synthetic safe slot',
      }));
    };
    manager._build = slotId => ({
      slotId,
      executablePath: path.join(root, slotId, 'RobloxPlayerBeta.exe'),
      launchExecutablePath: path.join(root, slotId, 'RobloxPlayerBeta.exe'),
    });
    const allocated = manager.acquire('C:\\Roblox', [], null, new Map());
    assert.equal(allocated.slotId, 'instance-3');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

class FakeCloneManager {
  constructor(physicalSlots) {
    this.physicalSlots = physicalSlots;
    this.reserved = new Set();
    this.busy = new Set();
    this.lastAllocationDecision = null;
    this.capacityReachedReason = '';
  }

  acquire() {
    if (this.reserved.size >= MAX_LEGACY_MANAGED_CLIENTS) {
      throw new Error(`SUNDAY Launcher legacy compatibility already has ${MAX_LEGACY_MANAGED_CLIENTS} active or in-flight managed clients.`);
    }
    for (let index = 1; index <= MAX_LEGACY_PHYSICAL_SLOTS; index += 1) {
      const slotId = `instance-${index}`;
      if (this.reserved.has(slotId) || this.busy.has(slotId)) continue;
      this.reserved.add(slotId);
      this.physicalSlots.add(slotId);
      this.lastAllocationDecision = { slotId, decision: 'ALLOCATED' };
      const executablePath = `C:\\Sunday\\legacy-instances\\${slotId}\\RobloxPlayerBeta.exe`;
      return { slotId, executablePath, launchExecutablePath: executablePath };
    }
    throw new Error('No safe legacy compatibility slot is available within the bounded safety ceiling.');
  }

  release(slotId) {
    if (!this.reserved.has(slotId)) return { ok: false, released: false, reason: 'Unknown slot.' };
    this.reserved.delete(slotId);
    this.busy.add(slotId);
    return { ok: true, released: true, deferredReclaim: true };
  }

  reserveRestored(slotId) {
    if (!this.physicalSlots.has(slotId) || this.reserved.size >= MAX_LEGACY_MANAGED_CLIENTS) return false;
    this.reserved.add(slotId);
    return true;
  }

  slotOwnsExecutable(slotId, executablePath) {
    return String(executablePath || '').toLowerCase().includes(`\\legacy-instances\\${String(slotId).toLowerCase()}\\`);
  }

  markOccupied() {}
  markReleased() {}
  getSlotState() { return null; }
  slotStateSnapshot() { return []; }

  capacitySnapshot() {
    return {
      maxConcurrent: MAX_LEGACY_MANAGED_CLIENTS,
      maxPhysicalSlots: MAX_LEGACY_PHYSICAL_SLOTS,
      activeOrInFlight: this.reserved.size,
      available: Math.max(0, MAX_LEGACY_MANAGED_CLIENTS - this.reserved.size),
      reusableSlotCount: MAX_LEGACY_PHYSICAL_SLOTS - this.reserved.size - this.busy.size,
      releasedButBusySlotCount: this.busy.size,
      allocatorDecision: this.lastAllocationDecision,
      capacityReachedReason: this.capacityReachedReason,
    };
  }
}

function legacyRuntimeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-six-restart-'));
  const database = new StateDatabase({ path: path.join(dir, 'state.sqlite3'), assertOwner: () => true });
  const ownershipStore = new LegacyOwnershipStore({ database });
  const processes = [];
  let processObservationAvailable = true;
  const physicalSlots = new Set();
  let nextPid = 500;
  const normalized = value => path.win32.normalize(String(value || '')).toLowerCase();
  const native = {
    isAvailable: () => true,
    getLoadError: () => '',
    listProcesses: () => processObservationAvailable
      ? processes.map(row => Object.assign({}, row))
      : null,
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
        .map(pid => [pid, { title: 'Roblox', className: 'WINDOWSCLIENT', responding: true }]));
    },
    terminateOwned(record) {
      const index = processes.findIndex(row => row.pid === Number(record.pid)
        && row.processIdentity === record.processIdentity
        && normalized(row.executablePath) === normalized(record.executablePath));
      if (index < 0) return { ok: false, confirmed: false, reason: 'identity mismatch' };
      processes.splice(index, 1);
      return { ok: true, confirmed: true };
    },
  };
  const legacyNative = {
    isAvailable: () => true,
    getLoadError: () => '',
    acquireSingletonNames: () => ({ ok: true, held: 2, total: 2 }),
    singletonNamesOwned: () => true,
    closeGlobalSingletonHandles: () => ({ ok: true, closed: 0, scanned: 0 }),
  };

  function createRuntime(ownerId, overrides) {
    const runtimeOverrides = overrides || {};
    const monitor = new EventEmitter();
    monitor.managed = new Map();
    monitor.markManaged = (pid, metadata) => monitor.managed.set(pid, metadata);
    monitor.forget = pid => monitor.managed.delete(pid);
    const cloneManager = new FakeCloneManager(physicalSlots);
    const registry = new ProcessCapabilityRegistry(native);
    const adapter = new LegacyRobloxIsolationAdapter({
      logger: { info() {}, warn() {}, error() {} },
      nativeApi: native,
      legacyNativeApi: legacyNative,
      processCapabilities: registry,
      ownershipStore: runtimeOverrides.ownershipStore || ownershipStore,
      ownerId,
      monitor,
      cloneManager,
      locateRoblox: () => ({ found: true, playerPath: 'C:\\Roblox\\version-1\\RobloxPlayerBeta.exe' }),
      spawnProcess(executablePath) {
        const pid = nextPid++;
        processes.push({ pid, processIdentity: `created-${pid}`, executablePath });
        return { pid, once() {}, unref() {} };
      },
      pollMs: 1,
      stableSamples: 1,
      launchTimeoutMs: 500,
      releaseTimeoutMs: 20,
      requireWindow: true,
    });
    const store = new LaunchPlanStore({ database });
    const coordinator = new LaunchCoordinator({
      adapter,
      store,
      operationTimeoutMs: 1000,
      resolveIntent: async operation => ({
        ok: true,
        intent: {
          accountHandle: operation.accountId,
          profileName: operation.label,
          target: operation.target,
          launchUri: 'roblox-player:synthetic-authorized-test',
        },
      }),
    });
    return { adapter, cloneManager, coordinator, monitor, registry, store };
  }

  return {
    database,
    ownershipStore,
    processes,
    physicalSlots,
    setProcessObservationAvailable(value) { processObservationAvailable = !!value; },
    createRuntime,
    cleanup() {
      database.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function participants(start, count) {
  return Array.from({ length: count }, (_, index) => {
    const number = start + index;
    return { accountId: `account-${number}`, label: `Account ${number}` };
  });
}

test('legacy runtime launches six, rejects a seventh, restores exact ownership, and restarts one into safe headroom', async () => {
  const f = legacyRuntimeFixture();
  try {
    const firstRuntime = f.createRuntime('owner-before-restart');
    const launched = await firstRuntime.coordinator.prepare({
      name: 'Bulk six',
      participants: participants(1, 6),
      target: { type: 'HOME' },
    });
    assert.equal(launched.ok, true);
    assert.equal((await firstRuntime.adapter.health()).count, 6);
    assert.deepEqual(launched.plan.operations.map(operation => operation.instanceId), [
      'instance-1', 'instance-2', 'instance-3', 'instance-4', 'instance-5', 'instance-6',
    ]);
    const originalPids = launched.plan.operations.map(operation => operation.pid);
    assert.equal(firstRuntime.store.get(launched.planId).operations.every(operation => operation.capability === null), true);
    assert.equal(f.ownershipStore.list().every(record => record.capability === undefined), true);

    const seventh = await firstRuntime.coordinator.prepare({
      name: 'Seventh', participants: participants(7, 1), target: { type: 'HOME' },
    });
    assert.equal(seventh.ok, false);
    assert.equal(seventh.plan.state, PLAN_STATES.BLOCKED);
    assert.equal(seventh.failureCode, 'CAPACITY_REACHED');
    assert.equal(f.processes.length, 6);

    f.processes.push({
      pid: 9999,
      processIdentity: 'foreign-process',
      executablePath: 'C:\\Roblox\\Versions\\foreign\\RobloxPlayerBeta.exe',
    });
    firstRuntime.adapter.shutdown();

    const secondRuntime = f.createRuntime('owner-after-restart');
    assert.equal(secondRuntime.adapter.restoredOwnership().length, 6);
    assert.equal((await secondRuntime.adapter.health()).count, 6);
    assert.equal(secondRuntime.monitor.managed.has(9999), false);
    const restoredPlan = secondRuntime.coordinator.get(launched.planId);
    assert.equal(restoredPlan.state, PLAN_STATES.COMPLETED);
    assert.equal(restoredPlan.operations.every(operation => operation.state === 'RUNNING' && operation.capability === null), true);

    const target = restoredPlan.operations[1];
    const restarted = await secondRuntime.coordinator.restart(restoredPlan.planId, target.operationId);
    assert.equal(restarted.ok, true);
    assert.equal(restarted.operation.instanceId, 'instance-7');
    assert.notEqual(restarted.operation.pid, target.pid);
    assert.equal(secondRuntime.cloneManager.busy.has('instance-2'), true);
    const siblingPids = (await secondRuntime.adapter.health()).running
      .filter(row => row.operationId !== target.operationId).map(row => row.pid);
    assert.deepEqual(siblingPids.sort((a, b) => a - b), originalPids.filter(pid => pid !== target.pid).sort((a, b) => a - b));
    assert.equal(f.processes.some(row => row.pid === 9999 && row.processIdentity === 'foreign-process'), true);

    const stopped = await secondRuntime.coordinator.stop(restoredPlan.planId, target.operationId);
    assert.equal(stopped.ok, true);
    assert.equal((await secondRuntime.adapter.health()).count, 5);
    const duplicate = await secondRuntime.coordinator.prepare({
      name: 'Duplicate account', participants: participants(1, 1), target: { type: 'HOME' },
    });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.failureCode, 'DUPLICATE_ACCOUNT_OPERATION');
    const replacement = await secondRuntime.coordinator.prepare({
      name: 'Reuse freed capacity', participants: participants(2, 1), target: { type: 'HOME' },
    });
    assert.equal(replacement.ok, true);
    assert.equal((await secondRuntime.adapter.health()).count, 6);
    assert.notEqual(replacement.plan.operations[0].pid, target.pid);
    assert.equal(f.processes.some(row => row.pid === 9999), true);
    secondRuntime.adapter.shutdown();
  } finally {
    f.cleanup();
  }
});

test('a durable ownership write failure rolls back the exact launched process', async () => {
  const f = legacyRuntimeFixture();
  try {
    const runtime = f.createRuntime('owner-persistence-failure', {
      ownershipStore: {
        list: () => [],
        put() { throw new Error('synthetic durable write failure'); },
        delete() { return false; },
      },
    });
    const response = await runtime.coordinator.prepare({
      name: 'Persistence failure', participants: participants(1, 1), target: { type: 'HOME' },
    });
    assert.equal(response.ok, false);
    assert.equal(response.results[0].failureStage, 'launch');
    assert.equal(f.processes.length, 0);
    assert.equal((await runtime.adapter.health()).count, 0);
    runtime.adapter.shutdown();
  } finally {
    f.cleanup();
  }
});

test('concurrent plans atomically reject a duplicate account before a second allocation', async () => {
  const f = legacyRuntimeFixture();
  try {
    const runtime = f.createRuntime('owner-concurrent-duplicate');
    const input = {
      name: 'Concurrent duplicate',
      participants: participants(1, 1),
      target: { type: 'HOME' },
    };
    const responses = await Promise.all([
      runtime.coordinator.prepare(input),
      runtime.coordinator.prepare(input),
    ]);
    assert.equal(responses.filter(response => response.ok).length, 1);
    assert.equal(responses.filter(response => response.failureCode === 'DUPLICATE_ACCOUNT_OPERATION').length, 1);
    assert.equal(f.processes.length, 1);
    runtime.adapter.shutdown();
  } finally {
    f.cleanup();
  }
});

test('unavailable process observation never proves exit or deletes durable ownership', async () => {
  const f = legacyRuntimeFixture();
  try {
    const runtime = f.createRuntime('owner-observation-failure');
    const launched = await runtime.coordinator.prepare({
      name: 'Observation failure', participants: participants(1, 1), target: { type: 'HOME' },
    });
    const operation = launched.plan.operations[0];
    assert.equal(f.ownershipStore.list().length, 1);
    f.setProcessObservationAvailable(false);

    const observed = await runtime.adapter.observe(operation.capability);
    assert.equal(observed.ok, false);
    assert.equal(observed.status, 'UNKNOWN');
    assert.equal(f.ownershipStore.list().length, 1);
    assert.equal(f.processes.length, 1);
    runtime.adapter.shutdown();
  } finally {
    f.cleanup();
  }
});
