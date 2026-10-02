'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');

const nativeModule = require('../src/main/native');
const { ProcessCapabilityRegistry } = require('../src/main/process-capabilities');
const { ISOLATION_STATES } = require('../src/main/roblox-isolation-adapter');
const { SingleClientRobloxIsolationAdapter } = require('../src/main/single-client-roblox-isolation-adapter');

function fixture(options = {}) {
  const executablePath = 'C:\\Users\\Fixture\\AppData\\Local\\Roblox\\Versions\\version-test\\RobloxPlayerBeta.exe';
  const processes = [];
  let nextPid = 400;
  const native = {
    isAvailable: () => options.nativeAvailable !== false,
    getLoadError: () => options.nativeAvailable === false ? 'native unavailable' : '',
    fileIdentityOfPath: () => options.fileIdentity || 'official-file-id',
    listProcesses: () => processes.map(row => Object.assign({}, row)),
    processFingerprintOf(pid) {
      const row = processes.find(item => item.pid === Number(pid));
      if (!row) return { processIdentity: '', executablePath: '', fileIdentity: '' };
      return {
        processIdentity: row.processIdentity,
        executablePath: options.wrongExecutableIdentity ? 'C:\\Other\\RobloxPlayerBeta.exe' : row.executablePath,
        fileIdentity: options.wrongFileIdentity ? 'different-file-id' : row.fileIdentity,
      };
    },
    windowInfoForPids(pids) {
      return new Map(pids.filter(pid => processes.some(row => row.pid === pid)).map(pid => [pid, options.window || {
        title: 'Roblox', className: 'WINDOWSCLIENT', responding: true,
      }]));
    },
    terminateOwned(record) {
      const index = processes.findIndex(row => row.pid === Number(record.pid)
        && row.processIdentity === record.processIdentity
        && row.executablePath.toLowerCase() === String(record.executablePath).toLowerCase());
      if (index < 0) return { ok: false, confirmed: false, reason: 'identity mismatch' };
      processes.splice(index, 1);
      return { ok: true, confirmed: true };
    },
  };
  const monitor = {
    managed: new Map(),
    markManaged(pid, value) { this.managed.set(pid, value); },
    forget(pid) { this.managed.delete(pid); },
  };
  const registry = new ProcessCapabilityRegistry(native);
  if (options.issueFails) registry.issue = () => { throw new Error('synthetic capability failure'); };
  const adapter = new SingleClientRobloxIsolationAdapter({
    platform: 'win32',
    logger: { info() {}, warn() {}, error() {} },
    nativeApi: native,
    processCapabilities: registry,
    ownerId: 'test-owner',
    monitor,
    locateRoblox: () => options.robloxMissing
      ? { found: false, playerPath: null, source: 'none' }
      : { found: true, playerPath: executablePath, source: 'fixture', version: 'version-test' },
    pathValidator: () => !options.robloxMissing,
    spawnProcess(spawnPath) {
      const child = new EventEmitter();
      child.pid = nextPid++;
      child.unref = () => {};
      if (!options.noProcess) processes.push({
        pid: options.childProcess ? child.pid + 1 : child.pid,
        parentPid: options.childProcess ? child.pid : 1,
        processIdentity: `created-${child.pid}`,
        executablePath: spawnPath,
        fileIdentity: 'official-file-id',
      });
      if (options.exitImmediately) setImmediate(() => child.emit('exit', 1, null));
      return child;
    },
    pollMs: 10,
    stableSamples: 1,
    launchTimeoutMs: 120,
    requireWindow: true,
  });
  return { adapter, executablePath, monitor, native, processes, registry };
}

async function launch(adapter, operationId = 'operation-a') {
  const allocated = await adapter.allocateInstance({ operationId, accountId: 'account-a' });
  assert.equal(allocated.ok, true);
  return adapter.launch({
    mode: 'deeplink',
    launchUri: 'roblox-player:synthetic-secret-ticket',
    profileName: 'Fixture account',
  }, { environmentId: allocated.environmentId, operation: { operationId, accountId: 'account-a' } });
}

test('normal single-client adapter launches and controls only the exact owned client', async () => {
  const { adapter, processes, registry, monitor } = fixture();
  const preflight = await adapter.preflight({ plan: { operations: [{}] } });
  assert.equal(preflight.state, ISOLATION_STATES.ACTIVATED);
  const launched = await launch(adapter);
  assert.equal(launched.ok, true);
  assert.equal(launched.status, 'RUNNING');
  assert.equal(processes.length, 1);
  assert.equal(registry.authorize(launched.capability, 'observe', 'test-owner').ok, true);
  assert.equal(monitor.managed.has(launched.pid), true);

  processes.push({
    pid: 999,
    parentPid: 1,
    processIdentity: 'foreign-process',
    executablePath: 'C:\\Roblox\\Versions\\version-other\\RobloxPlayerBeta.exe',
    fileIdentity: 'foreign-file',
  });
  const stopped = await adapter.stop(launched.capability);
  assert.equal(stopped.ok, true);
  assert.equal(stopped.confirmed, true);
  assert.deepEqual(processes.map(row => row.pid), [999]);
});

test('normal adapter accepts an exact direct child transition but never an unrelated process', async () => {
  const { adapter } = fixture({ childProcess: true });
  const launched = await launch(adapter);
  assert.equal(launched.ok, true);
  assert.equal(launched.pid, 401);
});

test('normal adapter refuses multi-client plans and existing foreign Roblox processes', async () => {
  const multi = fixture();
  const multiResult = await multi.adapter.preflight({ plan: { operations: [{}, {}] } });
  assert.equal(multiResult.ok, false);
  assert.equal(multiResult.failureCode, 'MULTI_INSTANCE_DISABLED');

  const foreign = fixture();
  foreign.processes.push({
    pid: 321, parentPid: 1, processIdentity: 'foreign', executablePath: foreign.executablePath, fileIdentity: 'official-file-id',
  });
  const foreignResult = await foreign.adapter.preflight({ plan: { operations: [{}] } });
  assert.equal(foreignResult.ok, false);
  assert.equal(foreignResult.failureCode, 'CLIENT_ALREADY_RUNNING');
});

test('normal adapter reports missing Roblox and native identity failures before spawn', async () => {
  const missing = fixture({ robloxMissing: true });
  const missingResult = await missing.adapter.preflight({ plan: { operations: [{}] } });
  assert.equal(missingResult.failureCode, 'ROBLOX_NOT_FOUND');
  assert.match(missingResult.reason, /Locate it in Settings/);

  const unavailable = fixture({ nativeAvailable: false });
  const unavailableResult = await unavailable.adapter.preflight({ plan: { operations: [{}] } });
  assert.equal(unavailableResult.failureCode, 'PROCESS_IDENTITY_UNAVAILABLE');
});

test('normal adapter rejects wrong executable identity, startup dialogs, and readiness timeouts', async () => {
  const wrongIdentity = fixture({ wrongFileIdentity: true });
  const wrongResult = await launch(wrongIdentity.adapter);
  assert.equal(wrongResult.ok, false);
  assert.equal(wrongResult.failureCode, 'OWNERSHIP_NOT_VERIFIED');

  const dialog = fixture({ window: { title: 'Roblox', className: '#32770', responding: true } });
  const dialogResult = await launch(dialog.adapter);
  assert.equal(dialogResult.ok, false);
  assert.equal(dialogResult.failureCode, 'ROBLOX_STARTUP_ERROR');

  const hung = fixture({ window: { title: 'Roblox', className: 'WINDOWSCLIENT', responding: false } });
  const timeoutResult = await launch(hung.adapter);
  assert.equal(timeoutResult.ok, false);
  assert.equal(timeoutResult.failureCode, 'STARTUP_TIMEOUT');
  assert.equal(hung.processes.length, 0, 'an exact owned process is cleaned up after readiness failure');

  const childHung = fixture({ childProcess: true, window: { title: 'Roblox', className: 'WINDOWSCLIENT', responding: false } });
  const childTimeoutResult = await launch(childHung.adapter);
  assert.equal(childTimeoutResult.failureCode, 'STARTUP_TIMEOUT');
  assert.equal(childHung.processes.length, 0, 'an exact direct child is cleaned up without broad termination');

  const capabilityFailure = fixture({ issueFails: true });
  const capabilityResult = await launch(capabilityFailure.adapter);
  assert.equal(capabilityResult.failureCode, 'OWNERSHIP_NOT_VERIFIED');
  assert.equal(capabilityFailure.processes.length, 0, 'a verified process is cleaned up when capability issuance fails');
});

test('normal adapter performs a capability-bound restart', async () => {
  const { adapter, processes } = fixture();
  const launched = await launch(adapter);
  const restarted = await adapter.restart({
    mode: 'deeplink',
    launchUri: 'roblox-player:fresh-synthetic-secret-ticket',
    profileName: 'Fixture account',
  }, { capability: launched.capability, operation: { operationId: 'operation-a', accountId: 'account-a' } });
  assert.equal(restarted.ok, true);
  assert.notEqual(restarted.pid, launched.pid);
  assert.equal(processes.length, 1);
});

test('native window selection prefers startup errors and responsive Roblox client windows deterministically', () => {
  const titled = { title: 'Roblox splash', className: 'OtherWindow', responding: true };
  const client = { title: 'Roblox', className: 'WINDOWSCLIENT', responding: true };
  const dialog = { title: 'Roblox error', className: '#32770', responding: true };
  assert.equal(nativeModule.preferWindow(titled, client), client);
  assert.equal(nativeModule.preferWindow(client, titled), client);
  assert.equal(nativeModule.preferWindow(client, dialog), dialog);
});
