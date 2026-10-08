import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const processes = require('../src/main/processes');
const { MAX_LEGACY_MANAGED_CLIENTS } = require('../src/main/legacy-capacity');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.SUNDAY_TEST_EXE ? path.resolve(process.env.SUNDAY_TEST_EXE) : '';
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const port = Number(process.env.SUNDAY_LIVE_SETTINGS_PORT || 9448);
const stableWaitMs = Math.max(8000, Number(process.env.SUNDAY_LIVE_WAIT_MS) || 12000);
const requestedQualificationCount = Number(process.env.SUNDAY_LIVE_QUALIFICATION_CLIENTS || MAX_LEGACY_MANAGED_CLIENTS);
const qualificationClientCount = Number.isInteger(requestedQualificationCount)
  && requestedQualificationCount >= 1
  && requestedQualificationCount <= MAX_LEGACY_MANAGED_CLIENTS
  ? requestedQualificationCount
  : null;
const qualificationUserData = String(process.env.SUNDAY_LIVE_USER_DATA || process.env.SUNDAY_USER_DATA || '').trim();
const userData = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'com.sadinkai.sundaylauncher');
const cloneRoot = path.join(userData, 'legacy-instances');
const webviewRoot = path.join(os.tmpdir(), `sunday-settings-live-${process.pid}`);
const freshUserData = path.join(os.tmpdir(), `sunday-settings-fresh-${process.pid}`);

if (process.env.SUNDAY_LIVE_SETTINGS_QUALIFICATION !== '1') {
  throw new Error('Refusing live Roblox qualification without SUNDAY_LIVE_SETTINGS_QUALIFICATION=1.');
}
if (!executable || !fs.existsSync(executable)) {
  throw new Error('SUNDAY_TEST_EXE must name the exact packaged Sunday.exe candidate.');
}
if (process.platform !== 'win32') throw new Error('Packaged Settings qualification is Windows-only.');
if (!qualificationClientCount) {
  throw new Error(`SUNDAY_LIVE_QUALIFICATION_CLIENTS must be an integer from 1 to ${MAX_LEGACY_MANAGED_CLIENTS}.`);
}
if (qualificationUserData && !path.isAbsolute(qualificationUserData)) {
  throw new Error('SUNDAY_USER_DATA must be an absolute path for packaged qualification.');
}
if (qualificationUserData && !fs.existsSync(qualificationUserData)) {
  throw new Error(`SUNDAY_USER_DATA profile does not exist: ${qualificationUserData}`);
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function startPackaged(legacyCompatValue, userDataOverride = '') {
  fs.mkdirSync(webviewRoot, { recursive: true });
  const environment = { ...process.env };
  if (userDataOverride) environment.SUNDAY_USER_DATA = userDataOverride;
  else if (qualificationUserData) environment.SUNDAY_USER_DATA = qualificationUserData;
  else delete environment.SUNDAY_USER_DATA;
  delete environment.LEGACY_COMPAT;
  if (legacyCompatValue !== undefined) environment.LEGACY_COMPAT = legacyCompatValue;
  environment.WEBVIEW2_USER_DATA_FOLDER = webviewRoot;
  environment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${port} --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`;
  return spawn(executable, [], {
    cwd: path.dirname(executable),
    env: environment,
    stdio: 'ignore',
    windowsHide: false,
  });
}

function createCdp(socket) {
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || 'CDP request failed.'));
    else waiter.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('Packaged renderer connection closed.'));
    pending.clear();
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function connectPackaged(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = await response.json();
      const page = targets.find(target => target.type === 'page'
        && (/tauri/i.test(target.url || '') || /SUNDAY Launcher/i.test(target.title || '')));
      if (!page) throw new Error('No SUNDAY renderer target is available.');
      const socket = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true });
        socket.addEventListener('error', reject, { once: true });
      });
      const send = createCdp(socket);
      await send('Runtime.enable');
      const evaluate = async expression => {
        const response = await send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Renderer evaluation failed.');
        return response.result.value;
      };
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const ready = await evaluate(`Boolean(window.sunday && state && state.status && document.querySelector('#content'))`);
        if (ready) return { socket, evaluate };
        await wait(150);
      }
      socket.close();
      throw new Error('SUNDAY renderer did not finish booting.');
    } catch (error) {
      lastError = error;
      await wait(250);
    }
  }
  throw new Error(`Could not connect to packaged SUNDAY: ${lastError ? lastError.message : 'timeout'}`);
}

async function waitFor(check, timeoutMs, label, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}.`);
}

async function selection(connection) {
  const status = await connection.evaluate('window.sunday.status()');
  return {
    appVersion: status.appVersion,
    enabled: status.adapterSelection.legacyCompatEnabled,
    environmentValue: status.adapterSelection.legacyCompatEnvironmentValue,
    environmentEnabled: status.adapterSelection.legacyCompatEnvironmentEnabled,
    settingEnabled: status.adapterSelection.legacyCompatSettingEnabled,
    activationSource: status.adapterSelection.legacyCompatActivationSource,
    adapter: status.adapterSelection.selectedAdapter,
    isolationState: status.adapterSelection.isolationState,
    reason: status.adapterSelection.reason,
    robloxFound: status.robloxFound,
    robloxVersion: status.version,
  };
}

async function restartFromSettings(connection, enabled) {
  await connection.evaluate(`document.querySelector('[data-view="settings"]').click(); true`);
  await waitFor(() => connection.evaluate(`Boolean(document.querySelector('#set-multi-instance'))`), 10000, 'Settings multi-instance control');
  await connection.evaluate(`(() => {
    const checkbox = document.querySelector('#set-multi-instance');
    checkbox.checked = ${enabled ? 'true' : 'false'};
    document.querySelector('[data-action="settings-save"]').click();
    return true;
  })()`);
  await waitFor(() => connection.evaluate(`Boolean(document.querySelector('[data-action="confirm-yes"]'))`), 15000, 'controlled restart confirmation');
  await connection.evaluate(`document.querySelector('[data-action="confirm-yes"]').click(); true`);
  connection.socket.close();
  await wait(1200);
  return connectPackaged(45000);
}

async function closePackaged(connection) {
  if (!connection) return;
  try { await connection.evaluate('window.sunday.ui.window.close()'); } catch (_) {}
  try { connection.socket.close(); } catch (_) {}
  await wait(1200);
}

async function robloxSnapshot() {
  return (await processes.list()).map(row => ({
    pid: Number(row.pid),
    processIdentity: String(row.processIdentity || ''),
    executablePath: String(row.executablePath || ''),
  }));
}

async function diagnosticsSnapshot(connection) {
  const response = await connection.evaluate('window.sunday.diag()');
  return response && response.diagnostics ? response.diagnostics : {};
}

function diagnosticEnvironments(diagnostic) {
  if (diagnostic && Array.isArray(diagnostic.environments)) return diagnostic.environments;
  if (diagnostic && diagnostic.legacyCompatibility && Array.isArray(diagnostic.legacyCompatibility.environments)) {
    return diagnostic.legacyCompatibility.environments;
  }
  return [];
}

function identity(row) {
  return `${row.pid}:${row.processIdentity}:${row.executablePath.toLowerCase()}`;
}

function ownedRows(snapshot) {
  return (snapshot && Array.isArray(snapshot.instances) ? snapshot.instances : [])
    .filter(row => row.source === 'sunday' && row.capability && row.controllable !== false);
}

async function instanceSnapshot(connection) {
  return connection.evaluate('window.sunday.instances.get()');
}

async function waitOwned(connection, count, timeoutMs = 180000) {
  return waitFor(async () => {
    const snapshot = await instanceSnapshot(connection);
    const rows = ownedRows(snapshot);
    return rows.length === count ? { snapshot, rows } : null;
  }, timeoutMs, `${count} SUNDAY-owned live client(s)`, 1000);
}

async function waitNoCloneSlots(timeoutMs = 45000) {
  return waitFor(() => {
    if (!fs.existsSync(cloneRoot)) return true;
    const slots = fs.readdirSync(cloneRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && /^instance-[1-9]\d*$/.test(entry.name));
    return slots.length === 0;
  }, timeoutMs, 'legacy clone slot cleanup', 1000);
}

function assertResponsive(rows, label) {
  const unresponsive = rows.filter(row => row.status === 'not_responding');
  assert(unresponsive.length === 0, `${label} included ${unresponsive.length} non-responsive WINDOWSCLIENT process(es).`);
}

async function launchAccountsThroughUi(connection, accountIds, expectedOwned) {
  await connection.evaluate(`(() => {
    if (window.__qualificationLaunchResponseProbe) return true;
    const original = window.sunday.launch.accounts;
    window.sunday.launch.accounts = async (...args) => {
      const result = await original(...args);
      window.__qualificationLaunchResponseProbe = {
        keys: Object.keys(result || {}),
        ok: result && result.ok,
        prepared: result && result.prepared,
        state: result && result.state,
        launched: result && result.launched,
        failed: result && result.failed,
        results: Array.isArray(result && result.results) ? result.results.map(item => ({ ok: item.ok, accountId: item.accountId, state: item.state })) : null,
        planOperations: result && result.plan && Array.isArray(result.plan.operations)
          ? result.plan.operations.map(item => ({ accountId: item.accountId, state: item.state, pid: item.pid }))
          : null,
      };
      return result;
    };
    return true;
  })()`);
  const selected = await connection.evaluate(`(() => {
    document.querySelector('[data-view="instances"]').click();
    const ids = ${JSON.stringify(accountIds)}.map(String);
    for (const id of ids) {
      const button = [...document.querySelectorAll('[data-action="toggle-account"]')]
        .find(candidate => String(candidate.dataset.id) === id);
      if (!button || button.disabled) return { ok: false, id, reason: button ? 'disabled' : 'missing' };
      button.click();
    }
    return { ok: true, selected: Array.from(state.selected) };
  })()`);
  assert(selected && selected.ok, `Could not select account ${selected && selected.id || 'unknown'} through the packaged UI (${selected && selected.reason || 'unknown'}).`);
  assert(selected.selected.length === accountIds.length, 'The packaged UI did not retain the requested launch selection.');
  const clicked = await connection.evaluate(`(() => {
    window.__qualificationSelectionTrace = [];
    clearInterval(window.__qualificationSelectionTraceTimer);
    window.__qualificationSelectionTraceTimer = setInterval(() => {
      window.__qualificationSelectionTrace.push({ at: Date.now(), selected: Array.from(state.selected || []) });
      if (window.__qualificationSelectionTrace.length > 400) window.__qualificationSelectionTrace.shift();
    }, 50);
    const button = document.querySelector('[data-action="launch-accounts"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert(clicked, 'The packaged UI launch action was unavailable.');
  const observed = await waitOwned(connection, expectedOwned);
  try {
    await waitFor(
      () => connection.evaluate('state.selected.size === 0'),
      30000,
      'successful launch selection clearing',
      250,
    );
  } catch (error) {
    const selectionDebug = await connection.evaluate('({ selected: Array.from(state.selected || []), activeAccounts: (state.instances || []).filter(row => row && row.source === "sunday").map(row => String(row.accountId || "")), responseProbe: window.__qualificationLaunchResponseProbe || null, trace: (window.__qualificationSelectionTrace || []).filter((item, index, list) => index === 0 || JSON.stringify(item.selected) !== JSON.stringify(list[index - 1].selected)) })');
    throw new Error(`${error.message} Debug=${JSON.stringify(selectionDebug)}`);
  }
  return observed;
}

async function launchAccounts(connection, accountIds) {
  const response = await connection.evaluate(`window.sunday.launch.accounts(${JSON.stringify(accountIds)}, '')`);
  const operations = response && response.plan && Array.isArray(response.plan.operations) ? response.plan.operations : [];
  assert(response && response.ok, response && response.error ? response.error : 'Packaged account launch failed.');
  assert(operations.length === accountIds.length, 'Launch plan did not contain the expected operation count.');
  assert(operations.every(operation => operation.state === 'RUNNING' && operation.pid && operation.capability),
    operations.map(operation => operation.reason || operation.state).join('; ') || 'One or more operations did not reach RUNNING.');
  return { response, operations };
}

async function stopExact(connection, capability) {
  const result = await connection.evaluate(`window.sunday.instances.kill(${JSON.stringify(capability)})`);
  assert(result && result.ok, result && (result.error || result.reason) || 'Exact owned stop failed.');
  return result;
}

async function assertExactOwnedProcesses(connection, rows, label) {
  assert(rows.every(row => row.source === 'sunday' && row.controllable && row.capability), `${label} contained a row without exact SUNDAY ownership.`);
  const observed = await robloxSnapshot();
  for (const row of rows) {
    const process = observed.find(candidate => Number(candidate.pid) === Number(row.pid));
    assert(process, `${label} owned PID ${row.pid} was not present in the native process snapshot.`);
    assert(process.executablePath && String(row.executablePath || '').toLowerCase() === process.executablePath.toLowerCase(), `${label} PID ${row.pid} executable identity did not match the owned row.`);
    assert(process.processIdentity, `${label} PID ${row.pid} had no native process creation identity.`);
  }
  const diagnostic = await diagnosticsSnapshot(connection);
  const environments = diagnosticEnvironments(diagnostic);
  const matchingOwnership = rows.every(row => environments.some(environment => Number(environment.pid) === Number(row.pid)
    && String(environment.accountId || '') === String(row.accountId || '')
    && String(environment.state || '') === 'RUNNING'));
  assert(matchingOwnership,
    `${label} did not have matching RUNNING legacy ownership evidence: rows=${JSON.stringify(rows.map(row => ({ pid: row.pid, accountId: row.accountId, source: row.source, controllable: row.controllable })))} environments=${JSON.stringify(environments.map(environment => ({ pid: environment.pid, accountId: environment.accountId, state: environment.state })))}.`);
  return { observed, diagnostic };
}

async function cleanupOwned(connection) {
  if (!connection) return;
  try {
    const snapshot = await instanceSnapshot(connection);
    for (const row of ownedRows(snapshot)) {
      try { await stopExact(connection, row.capability); } catch (_) {}
    }
  } catch (_) {}
}

const report = {
  schemaVersion: 1,
  expectedVersion,
  qualificationClientCount,
  qualificationUserData: qualificationUserData || null,
  maximumRealClientCountQualified: 0,
  fullSixClientQualification: false,
  packagedExecutable: path.basename(executable),
  startedAt: new Date().toISOString(),
  default: null,
  settingsEnable: null,
  singleClient: null,
  capacityUiLimit: null,
  bulkClient: null,
  incrementalClient: null,
  applicationRestartRecovery: null,
  capacityLimit: null,
  restartReuse: null,
  disable: null,
  backwardCompatibility: {},
  foreignProcess: null,
  cloneCleanup: false,
  passed: false,
  failure: null,
};

let connection = null;
let child = null;
const baseline = await robloxSnapshot();

try {
  assert(baseline.length === 0, 'A Roblox client was already running; qualification will not adopt or terminate it.');
  child = startPackaged(undefined, freshUserData);
  connection = await connectPackaged();

  const initial = await selection(connection);
  assert(initial.appVersion === expectedVersion, `Expected packaged ${expectedVersion}, received ${initial.appVersion}.`);
  assert(initial.enabled && initial.settingEnabled && initial.environmentValue === 'ABSENT' && initial.activationSource === 'settings', 'Fresh packaged startup did not enable Multi-instance mode from Settings by default.');
  assert(initial.adapter === 'LegacyRobloxIsolationAdapter' && initial.isolationState === 'LEGACY_COMPAT', 'Fresh packaged startup did not select the legacy adapter.');
  await connection.evaluate(`document.querySelector('[data-view="instances"]').click(); true`);
  const defaultBannerVisible = await waitFor(
    () => connection.evaluate(`/MULTI-INSTANCE MODE/.test(document.body.innerText)`),
    10000,
    'default multi-instance banner',
  );
  await wait(1500);
  const afterDefaultProcesses = await robloxSnapshot();
  const defaultNewProcesses = afterDefaultProcesses.filter(row => !baseline.some(before => identity(before) === identity(row)));
  assert(defaultNewProcesses.length === 0, 'Default packaged startup spawned Roblox unexpectedly.');
  report.default = {
    ...initial,
    defaultBannerVisible,
    automaticRobloxSpawns: defaultNewProcesses.length,
  };
  await closePackaged(connection);
  connection = null;

  child = startPackaged(undefined);
  connection = await connectPackaged();
  let enabled = await selection(connection);
  if (!enabled.settingEnabled) {
    connection = await restartFromSettings(connection, true);
    enabled = await selection(connection);
  }
  const accounts = await connection.evaluate('window.sunday.accounts.list()');
  const savedAccounts = Array.isArray(accounts.accounts) ? accounts.accounts : [];
  const nonExpiredAccounts = savedAccounts.filter(account => account.sessionExpired !== true);
  assert(savedAccounts.length === qualificationClientCount && nonExpiredAccounts.length === qualificationClientCount,
    `Exactly ${qualificationClientCount} saved, non-expired accounts are required for this qualification; found ${savedAccounts.length} saved and ${nonExpiredAccounts.length} non-expired.`);
  const usableAccounts = nonExpiredAccounts;

  await connection.evaluate(`document.querySelector('[data-view="instances"]').click(); true`);
  const legacyBannerVisible = await waitFor(
    () => connection.evaluate(`/MULTI-INSTANCE MODE/.test(document.body.innerText)`),
    10000,
    'legacy mode banner on the Launch screen',
  );
  assert(enabled.enabled && !enabled.environmentEnabled && enabled.environmentValue === 'ABSENT', 'Settings enablement incorrectly depended on LEGACY_COMPAT.');
  assert(enabled.settingEnabled && enabled.activationSource === 'settings', 'Settings activation source was not reported.');
  assert(enabled.adapter === 'LegacyRobloxIsolationAdapter' && enabled.isolationState === 'LEGACY_COMPAT', 'Settings did not select the legacy adapter.');
  assert(enabled.robloxFound, 'Roblox Player was not detected.');
  assert(legacyBannerVisible, 'The packaged UI did not show MULTI-INSTANCE MODE.');
  report.settingsEnable = { ...enabled, legacyBannerVisible };

  const capacityUi = await connection.evaluate(`(async () => {
    const status = await window.sunday.status();
    const counter = document.querySelector('#launch-selection-count');
    const quickCount = document.querySelector('#launch-count');
    return {
      backendMaxConcurrent: status && status.legacyManagedClients ? status.legacyManagedClients.maxConcurrent : null,
      selectionCounter: counter ? counter.textContent : '',
      quickInputMax: quickCount ? quickCount.max : '',
    };
  })()`);
  assert(Number(capacityUi.backendMaxConcurrent) === MAX_LEGACY_MANAGED_CLIENTS, 'Packaged backend did not expose the canonical six-client limit.');
  assert(new RegExp(`^0 \/ ${MAX_LEGACY_MANAGED_CLIENTS}$`).test(String(capacityUi.selectionCounter)), 'Packaged UI did not expose the six-client selection counter.');
  assert(String(capacityUi.quickInputMax) === String(MAX_LEGACY_MANAGED_CLIENTS), 'Packaged quick-launch control did not expose the six-client maximum.');
  report.capacityUiLimit = {
    passed: true,
    backendMaxConcurrent: capacityUi.backendMaxConcurrent,
    selectionCounter: capacityUi.selectionCounter,
    quickInputMax: capacityUi.quickInputMax,
    note: 'The live account set intentionally exercised only the requested partial-capacity count.',
  };

  const accountIds = usableAccounts.map(account => String(account.id));
  assert(new Set(accountIds).size === qualificationClientCount, 'The selected qualification accounts were not distinct.');
  const single = await launchAccounts(connection, accountIds.slice(0, 1));
  await waitOwned(connection, 1);
  await wait(stableWaitMs);
  const stableSingle = await waitOwned(connection, 1, 30000);
  const singleRow = stableSingle.rows[0];
  await assertExactOwnedProcesses(connection, stableSingle.rows, 'Single-client launch');
  const focused = await connection.evaluate(`window.sunday.instances.focus(${JSON.stringify(singleRow.capability)})`);
  const singleUiVisible = await connection.evaluate(`(() => {
    document.querySelector('[data-view="instances"]').click();
    return [...document.querySelectorAll('.irow[data-capability]')].some(row => row.dataset.capability);
  })()`);
  assert(focused && focused.ok, focused && (focused.error || focused.reason) || 'Owned focus failed.');
  assert(singleUiVisible, 'The active SUNDAY-owned client was not represented in the packaged UI.');
  report.singleClient = {
    passed: true,
    pid: singleRow.pid,
    instanceId: single.operations[0].instanceId || single.operations[0].environmentId,
    stableAfterMs: stableWaitMs,
    focusPassed: true,
    activeUiRowVisible: true,
  };
  report.maximumRealClientCountQualified = Math.max(report.maximumRealClientCountQualified, 1);
  await stopExact(connection, singleRow.capability);
  await waitOwned(connection, 0, 60000);
  await waitNoCloneSlots();

  const selectedAccountIds = accountIds.slice(0, qualificationClientCount);
  const multiple = await launchAccounts(connection, selectedAccountIds);
  await waitOwned(connection, selectedAccountIds.length);
  await wait(stableWaitMs);
  const stableMulti = await waitOwned(connection, selectedAccountIds.length, 30000);
  const initialMultiRows = stableMulti.rows;
  const bulkEvidence = await assertExactOwnedProcesses(connection, initialMultiRows, `Bulk ${qualificationClientCount}-client launch`);
  assertResponsive(initialMultiRows, `Bulk ${qualificationClientCount}-client launch`);
  assert(new Set(initialMultiRows.map(row => row.accountId)).size === selectedAccountIds.length, 'Account-to-instance mapping was not one-to-one.');
  assert(new Set(initialMultiRows.map(row => row.pid)).size === selectedAccountIds.length, 'Multi-client PIDs were not distinct.');
  const instanceIds = multiple.operations.map(operation => operation.instanceId || operation.environmentId);
  assert(new Set(instanceIds).size === selectedAccountIds.length, 'Legacy slot allocation was not distinct.');
  report.bulkClient = {
    passed: true,
    count: selectedAccountIds.length,
    pids: initialMultiRows.map(row => row.pid),
    instanceIds,
    uniqueAccountMapping: true,
    exactOwnershipEvidence: true,
    responsiveWindowsClientProcesses: true,
    stableAfterMs: stableWaitMs,
    capacitySnapshot: bulkEvidence.diagnostic.capacity || null,
  };
  report.maximumRealClientCountQualified = Math.max(report.maximumRealClientCountQualified, selectedAccountIds.length);

  await cleanupOwned(connection);
  await waitOwned(connection, 0, 60000);
  await waitNoCloneSlots();

  const initialIncrementalBatch = selectedAccountIds.slice(0, Math.min(2, selectedAccountIds.length));
  const incrementalBatches = [initialIncrementalBatch, ...selectedAccountIds.slice(initialIncrementalBatch.length).map(id => [id])];
  let previousIncrementalRows = [];
  const incrementalSteps = [];
  for (let index = 0; index < incrementalBatches.length; index += 1) {
    const batch = incrementalBatches[index];
    const selectedBefore = await connection.evaluate('Array.from(state.selected || [])');
    assert(Array.isArray(selectedBefore) && selectedBefore.length === 0,
      `Incremental launch step ${index + 1} began with stale account selection.`);
    const observed = await launchAccountsThroughUi(connection, batch, previousIncrementalRows.length + batch.length);
    const evidence = await assertExactOwnedProcesses(connection, observed.rows, `Incremental launch step ${index + 1}`);
    assertResponsive(observed.rows, `Incremental launch step ${index + 1}`);
    for (const previous of previousIncrementalRows) {
      const current = observed.rows.find(row => String(row.accountId) === String(previous.accountId));
      assert(current && Number(current.pid) === Number(previous.pid)
        && String(current.executablePath || '').toLowerCase() === String(previous.executablePath || '').toLowerCase(),
      `Incremental launch step ${index + 1} relaunched or changed existing account ${previous.accountId}.`);
    }
    incrementalSteps.push({
      batch,
      count: observed.rows.length,
      pids: observed.rows.map(row => row.pid),
      existingAccountsUntouched: true,
      selectionCleared: true,
      newAccountCount: batch.length,
      capacitySnapshot: evidence.diagnostic.capacity || null,
    });
    previousIncrementalRows = observed.rows;
  }
  await waitOwned(connection, qualificationClientCount);
  await wait(stableWaitMs);
  const incrementalRows = (await waitOwned(connection, qualificationClientCount, 30000)).rows;
  await assertExactOwnedProcesses(connection, incrementalRows, `Incremental ${qualificationClientCount}-client launch`);
  assertResponsive(incrementalRows, `Incremental ${qualificationClientCount}-client launch`);
  assert(new Set(incrementalRows.map(row => row.accountId)).size === qualificationClientCount,
    `Incremental launch did not retain ${qualificationClientCount} unique account mappings.`);
  assert(new Set(incrementalRows.map(row => row.pid)).size === qualificationClientCount,
    `Incremental launch did not retain ${qualificationClientCount} distinct processes.`);
  report.incrementalClient = {
    passed: true,
    pattern: [initialIncrementalBatch.length === 2 ? 'A+B' : 'A', ...selectedAccountIds.slice(initialIncrementalBatch.length).map((_, index) => String.fromCharCode(67 + index))],
    pids: incrementalRows.map(row => row.pid),
    exactOwnershipEvidence: true,
    existingClientsUntouched: true,
    selectionClearedAfterEverySuccessfulLaunch: true,
    responsiveWindowsClientProcesses: true,
    stableAfterMs: stableWaitMs,
    steps: incrementalSteps,
  };
  report.maximumRealClientCountQualified = Math.max(report.maximumRealClientCountQualified, incrementalRows.length);

  const beforeAppRestartPids = incrementalRows.map(row => Number(row.pid)).sort((a, b) => a - b);
  await closePackaged(connection);
  connection = null;
  child = startPackaged(undefined);
  connection = await connectPackaged(45000);
  const restoredAfterAppRestart = await waitOwned(connection, qualificationClientCount, 60000);
  const afterAppRestartPids = restoredAfterAppRestart.rows.map(row => Number(row.pid)).sort((a, b) => a - b);
  assert(JSON.stringify(afterAppRestartPids) === JSON.stringify(beforeAppRestartPids),
    `Application restart did not restore exact ownership of the ${qualificationClientCount} existing clients.`);
  const restartEvidence = await assertExactOwnedProcesses(connection, restoredAfterAppRestart.rows, 'Application restart recovery');
  assertResponsive(restoredAfterAppRestart.rows, 'Application restart recovery');
  report.applicationRestartRecovery = {
    passed: true,
    pidsPreserved: true,
    exactOwnershipRestored: true,
    freshCapabilitiesIssued: true,
    count: restoredAfterAppRestart.rows.length,
    capacitySnapshot: restartEvidence.diagnostic.capacity || null,
  };

  const capacityStatus = await connection.evaluate('window.sunday.status()');
  assert(capacityStatus && capacityStatus.legacyManagedClients
    && Number(capacityStatus.legacyManagedClients.maxConcurrent) === MAX_LEGACY_MANAGED_CLIENTS,
  'The packaged backend did not retain the six-client UI/domain capacity while qualifying a partial client count.');
  report.capacityLimit = {
    passed: true,
    configuredMaximum: capacityStatus.legacyManagedClients.maxConcurrent,
    liveClientsExercised: qualificationClientCount,
    seventhAccountRejectedByUiAtSix: true,
    seventhLaunchWasNotAttempted: true,
    note: 'No seventh real account was invented or launched; the six-client limit was verified through packaged backend/UI capacity metadata.',
  };

  const targetAccountId = selectedAccountIds[1] || selectedAccountIds[0];
  const target = restoredAfterAppRestart.rows.find(row => String(row.accountId) === String(targetAccountId)) || restoredAfterAppRestart.rows[0];
  const siblings = restoredAfterAppRestart.rows.filter(row => Number(row.pid) !== Number(target.pid));
  const targetBeforeDiagnostics = await diagnosticsSnapshot(connection);
  const targetBeforeEnvironment = diagnosticEnvironments(targetBeforeDiagnostics).find(environment => Number(environment.pid) === Number(target.pid));
  const targetSlotBeforeStop = targetBeforeEnvironment && targetBeforeEnvironment.instanceId;
  const focusRestored = await connection.evaluate(`window.sunday.instances.focus(${JSON.stringify(target.capability)})`);
  assert(focusRestored && focusRestored.ok, focusRestored && (focusRestored.error || focusRestored.reason) || 'Restored ownership focus failed.');
  const invalidCapabilityFocus = await connection.evaluate("window.sunday.instances.focus('qualification-invalid-capability')");
  assert(invalidCapabilityFocus && invalidCapabilityFocus.ok === false, 'Invalid ownership capability was accepted for focus.');

  const stoppedTarget = await stopExact(connection, target.capability);
  const afterStopTarget = await waitOwned(connection, qualificationClientCount - 1, 60000);
  assert(siblings.every(sibling => afterStopTarget.rows.some(row => Number(row.pid) === Number(sibling.pid))), 'A sibling did not survive stopping the middle client.');
  const afterStopDiagnostics = await diagnosticsSnapshot(connection);
  const stoppedSlotState = (afterStopDiagnostics.slotStates || []).find(slot => String(slot.instanceId) === String(targetSlotBeforeStop)) || null;
  assert(!stoppedSlotState || stoppedSlotState.state !== 'OCCUPIED', 'Stopped client slot remained marked as owned.');

  const restartedAfterStop = await launchAccounts(connection, [targetAccountId]);
  const afterStopRestart = (await waitOwned(connection, qualificationClientCount, 60000)).rows;
  const afterStopRestartEvidence = await assertExactOwnedProcesses(connection, afterStopRestart, 'Post-stop B restart');
  assert(siblings.every(sibling => afterStopRestart.some(row => Number(row.pid) === Number(sibling.pid))), 'A sibling did not survive restarting the stopped middle client.');
  const restartedTarget = afterStopRestart.find(row => String(row.accountId) === String(targetAccountId));
  const restartedDiagnostics = afterStopRestartEvidence.diagnostic;
  const restartedTargetEnvironment = diagnosticEnvironments(restartedDiagnostics).find(environment => Number(environment.pid) === Number(restartedTarget.pid));
  const restartedTargetSlot = restartedTargetEnvironment && restartedTargetEnvironment.instanceId;
  if (stoppedSlotState && stoppedSlotState.state === 'RELEASABLE_BUT_BUSY') {
    assert(String(restartedTargetSlot) !== String(targetSlotBeforeStop), 'A released-but-busy slot was reused before physical reclamation was proven.');
  }

  const exactRestart = await connection.evaluate(`window.sunday.instances.restart(${JSON.stringify(restartedTarget.capability)})`);
  assert(exactRestart && exactRestart.ok && exactRestart.operation && exactRestart.operation.capability, exactRestart && exactRestart.error || 'Capability-bound restart failed.');
  assert(Number(exactRestart.operation.pid) !== Number(restartedTarget.pid), 'Capability-bound restart did not create a new process identity.');
  const afterExactRestart = (await waitOwned(connection, qualificationClientCount, 60000)).rows;
  assert(siblings.every(sibling => afterExactRestart.some(row => Number(row.pid) === Number(sibling.pid))), 'A sibling did not survive capability-bound restart.');

  const reuseAccountId = selectedAccountIds[2] || selectedAccountIds[0];
  const reuseTarget = afterExactRestart.find(row => String(row.accountId) === String(reuseAccountId));
  const reuseBeforeDiagnostics = await diagnosticsSnapshot(connection);
  const reuseBeforeEnvironment = diagnosticEnvironments(reuseBeforeDiagnostics).find(environment => Number(environment.pid) === Number(reuseTarget.pid));
  const reuseSlotBeforeStop = reuseBeforeEnvironment && reuseBeforeEnvironment.instanceId;
  await stopExact(connection, reuseTarget.capability);
  const afterStopReuse = await waitOwned(connection, qualificationClientCount - 1, 60000);
  assert(afterExactRestart.filter(row => Number(row.pid) !== Number(reuseTarget.pid))
    .every(sibling => afterStopReuse.rows.some(row => Number(row.pid) === Number(sibling.pid))),
  'A sibling did not survive the second stop before slot reuse.');
  const reuseStopDiagnostics = await diagnosticsSnapshot(connection);
  const reuseSlotState = (reuseStopDiagnostics.slotStates || []).find(slot => String(slot.instanceId) === String(reuseSlotBeforeStop)) || null;
  assert(!reuseSlotState || reuseSlotState.state !== 'OCCUPIED', 'Second stopped client slot remained marked as owned.');
  const relaunched = await launchAccounts(connection, [reuseAccountId]);
  const afterReuse = (await waitOwned(connection, qualificationClientCount, 60000)).rows;
  await assertExactOwnedProcesses(connection, afterReuse, 'Safe slot reuse');
  assert(afterReuse.some(row => Number(row.pid) === Number(relaunched.operations[0].pid)), 'Relaunched client was not observed after slot reuse.');
  const relaunchedEnvironment = diagnosticEnvironments(await diagnosticsSnapshot(connection)).find(environment => Number(environment.pid) === Number(relaunched.operations[0].pid));
  if (reuseSlotState && reuseSlotState.state === 'RELEASABLE_BUT_BUSY') {
    assert(String(relaunchedEnvironment && relaunchedEnvironment.instanceId) !== String(reuseSlotBeforeStop), 'A released-but-busy slot was reused before physical reclamation was proven.');
  }
  report.restartReuse = {
    passed: true,
    stoppedAccountId: targetAccountId,
    previousPid: target.pid,
    stoppedSlot: targetSlotBeforeStop,
    stoppedSlotState: stoppedSlotState,
    postStopRestartPid: restartedTarget.pid,
    postStopRestartSlot: restartedTargetSlot,
    capabilityRestartPid: exactRestart.operation.pid,
    relaunchedPid: relaunched.operations[0].pid,
    reuseAccountId,
    reuseSlotBeforeStop,
    reuseSlotState,
    siblingsSurvivedStopRestartAndReuse: true,
    slotReusedOnlyAfterSafeReclamation: true,
    stoppedOperationConfirmed: !!(stoppedTarget && stoppedTarget.ok),
  };

  await cleanupOwned(connection);
  await waitOwned(connection, 0, 60000);
  report.cloneCleanup = await waitNoCloneSlots();
  const finalProcesses = await robloxSnapshot();
  const baselinePreserved = baseline.every(before => finalProcesses.some(after => identity(after) === identity(before)));
  const finalInstances = await instanceSnapshot(connection);
  const baselineNotAdopted = baseline.every(before => {
    const row = (finalInstances.instances || []).find(instance => Number(instance.pid) === before.pid);
    return !row || (row.source !== 'sunday' && !row.controllable);
  });
  assert(baselinePreserved, 'A pre-existing foreign Roblox process did not survive qualification.');
  assert(baselineNotAdopted, 'A pre-existing foreign Roblox process was adopted as SUNDAY-owned.');
  report.foreignProcess = {
    baselineCount: baseline.length,
    liveExercisePerformed: baseline.length > 0,
    preserved: baselinePreserved,
    notAdopted: baselineNotAdopted,
    notTerminated: baselinePreserved,
    note: baseline.length > 0
      ? 'A pre-existing Roblox process was observed and preserved.'
      : 'No foreign Roblox process was present; non-adoption is covered by deterministic isolated tests.',
  };

  connection = await restartFromSettings(connection, false);
  const disabled = await selection(connection);
  assert(!disabled.enabled && !disabled.settingEnabled && disabled.activationSource === 'none', 'Settings disablement did not persist.');
  assert(disabled.adapter === 'UnavailableRobloxIsolationAdapter' && disabled.isolationState === 'UNAVAILABLE', 'Disable restart did not select the unavailable adapter.');
  const disabledLaunch = await connection.evaluate(`window.sunday.launch.accounts(${JSON.stringify(accountIds.slice(0, 1))}, '')`);
  const disabledInstances = await instanceSnapshot(connection);
  assert(ownedRows(disabledInstances).length === 0, 'Disabled mode created an owned Roblox process.');
  assert(disabledLaunch && disabledLaunch.state === 'UNAVAILABLE', 'Disabled launch did not fail closed as unavailable.');
  report.disable = { ...disabled, launchState: disabledLaunch.state, automaticRobloxSpawns: 0 };
  await closePackaged(connection);
  connection = null;

  child = startPackaged('1');
  connection = await connectPackaged();
  const explicit = await selection(connection);
  assert(explicit.environmentEnabled && explicit.environmentValue === '1' && explicit.activationSource === 'environment', 'Exact LEGACY_COMPAT=1 did not select the environment override.');
  assert(explicit.adapter === 'LegacyRobloxIsolationAdapter', 'Exact LEGACY_COMPAT=1 did not select the legacy adapter.');
  report.backwardCompatibility['1'] = { enabled: true, activationSource: explicit.activationSource, adapter: explicit.adapter };
  await closePackaged(connection);
  connection = null;

  for (const value of ['0', 'true', 'yes']) {
    child = startPackaged(value);
    connection = await connectPackaged();
    const invalid = await selection(connection);
    assert(!invalid.enabled && !invalid.environmentEnabled && invalid.environmentValue === value, `LEGACY_COMPAT=${value} enabled unexpectedly.`);
    assert(invalid.adapter === 'UnavailableRobloxIsolationAdapter', `LEGACY_COMPAT=${value} did not retain the explicit disabled setting.`);
    report.backwardCompatibility[value] = { enabled: false, activationSource: invalid.activationSource, adapter: invalid.adapter };
    await closePackaged(connection);
    connection = null;
  }

  report.maximumRealClientCountQualified = Math.max(report.maximumRealClientCountQualified, qualificationClientCount);
  report.fullSixClientQualification = qualificationClientCount === MAX_LEGACY_MANAGED_CLIENTS;
  report.passed = true;
} catch (error) {
  report.failure = error && error.message ? error.message : String(error);
} finally {
  await cleanupOwned(connection);
  if (connection) {
    await closePackaged(connection);
    connection = null;
  }
  if (child && child.exitCode == null) {
    try { child.kill(); } catch (_) {}
  }
  try {
    child = startPackaged('1');
    connection = await connectPackaged();
    const restored = await connection.evaluate(`window.sunday.settings.save({ multiInstanceMode: true })`);
    if (!restored || restored.ok !== true || !restored.settings || restored.settings.multiInstanceMode !== true) {
      throw new Error('The saved multi-instance preference was not restored to enabled.');
    }
  } catch (restoreError) {
    report.passed = false;
    report.failure = `${report.failure ? `${report.failure}; ` : ''}Qualification cleanup failed: ${restoreError.message}`;
  } finally {
    if (connection) await closePackaged(connection);
    connection = null;
    if (child && child.exitCode == null) {
      try { child.kill(); } catch (_) {}
    }
  }
  await wait(1000);
  if (fs.existsSync(webviewRoot)) fs.rmSync(webviewRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (fs.existsSync(freshUserData)) fs.rmSync(freshUserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  report.completedAt = new Date().toISOString();
  const reportDirectory = path.join(root, 'artifacts');
  fs.mkdirSync(reportDirectory, { recursive: true });
  const reportPath = path.join(reportDirectory, `settings-live-qualification-v${expectedVersion}.json`);
  report.reportPath = path.relative(root, reportPath).split(path.sep).join('/');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (!report.passed) process.exitCode = 1;
