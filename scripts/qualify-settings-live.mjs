import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const processes = require('../src/main/processes');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.SUNDAY_TEST_EXE ? path.resolve(process.env.SUNDAY_TEST_EXE) : '';
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const port = Number(process.env.SUNDAY_LIVE_SETTINGS_PORT || 9448);
const stableWaitMs = Math.max(8000, Number(process.env.SUNDAY_LIVE_WAIT_MS) || 12000);
const userData = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'com.sadinkai.sundaylauncher');
const cloneRoot = path.join(userData, 'legacy-instances');
const webviewRoot = path.join(os.tmpdir(), `sunday-settings-live-${process.pid}`);

if (process.env.SUNDAY_LIVE_SETTINGS_QUALIFICATION !== '1') {
  throw new Error('Refusing live Roblox qualification without SUNDAY_LIVE_SETTINGS_QUALIFICATION=1.');
}
if (!executable || !fs.existsSync(executable)) {
  throw new Error('SUNDAY_TEST_EXE must name the exact packaged Sunday.exe candidate.');
}
if (process.platform !== 'win32') throw new Error('Packaged Settings qualification is Windows-only.');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function startPackaged(legacyCompatValue) {
  fs.mkdirSync(webviewRoot, { recursive: true });
  const environment = { ...process.env };
  delete environment.SUNDAY_USER_DATA;
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
      .filter(entry => entry.isDirectory() && /^instance-[1-3]$/.test(entry.name));
    return slots.length === 0;
  }, timeoutMs, 'legacy clone slot cleanup', 1000);
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
  packagedExecutable: path.basename(executable),
  startedAt: new Date().toISOString(),
  default: null,
  settingsEnable: null,
  singleClient: null,
  multiClient: null,
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
  child = startPackaged(undefined);
  connection = await connectPackaged();

  let initial = await selection(connection);
  if (initial.settingEnabled || initial.enabled) {
    connection = await restartFromSettings(connection, false);
    initial = await selection(connection);
  }
  assert(initial.appVersion === expectedVersion, `Expected packaged ${expectedVersion}, received ${initial.appVersion}.`);
  assert(!initial.enabled && initial.environmentValue === 'ABSENT' && initial.activationSource === 'none', 'Default startup did not remain fail closed.');
  assert(initial.adapter === 'UnavailableRobloxIsolationAdapter' && initial.isolationState === 'UNAVAILABLE', 'Default adapter was not unavailable.');
  await wait(1500);
  const afterDefaultProcesses = await robloxSnapshot();
  const defaultNewProcesses = afterDefaultProcesses.filter(row => !baseline.some(before => identity(before) === identity(row)));
  assert(defaultNewProcesses.length === 0, 'Default packaged startup spawned Roblox unexpectedly.');
  const accounts = await connection.evaluate('window.sunday.accounts.list()');
  const usableAccounts = (accounts.accounts || []).filter(account => account.sessionExpired !== true).slice(0, 3);
  assert(usableAccounts.length >= 2, `At least two non-expired saved accounts are required; found ${usableAccounts.length}.`);
  report.default = {
    ...initial,
    accountCount: (accounts.accounts || []).length,
    usableAccountCount: usableAccounts.length,
    automaticRobloxSpawns: defaultNewProcesses.length,
  };

  connection = await restartFromSettings(connection, true);
  const enabled = await selection(connection);
  await connection.evaluate(`document.querySelector('[data-view="instances"]').click(); true`);
  const legacyBannerVisible = await waitFor(
    () => connection.evaluate(`/LEGACY MULTI-INSTANCE MODE/.test(document.body.innerText)`),
    10000,
    'legacy mode banner on the Launch screen',
  );
  assert(enabled.enabled && !enabled.environmentEnabled && enabled.environmentValue === 'ABSENT', 'Settings enablement incorrectly depended on LEGACY_COMPAT.');
  assert(enabled.settingEnabled && enabled.activationSource === 'settings', 'Settings activation source was not reported.');
  assert(enabled.adapter === 'LegacyRobloxIsolationAdapter' && enabled.isolationState === 'LEGACY_COMPAT', 'Settings did not select the legacy adapter.');
  assert(enabled.robloxFound, 'Roblox Player was not detected.');
  assert(legacyBannerVisible, 'The packaged UI did not show LEGACY MULTI-INSTANCE MODE.');
  report.settingsEnable = { ...enabled, legacyBannerVisible };

  const accountIds = usableAccounts.map(account => String(account.id));
  const single = await launchAccounts(connection, accountIds.slice(0, 1));
  const singleObserved = await waitOwned(connection, 1);
  await wait(stableWaitMs);
  const stableSingle = await waitOwned(connection, 1, 30000);
  const singleRow = stableSingle.rows[0];
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
  await stopExact(connection, singleRow.capability);
  await waitOwned(connection, 0, 60000);
  await waitNoCloneSlots();

  const selectedAccountIds = accountIds.slice(0, Math.min(3, accountIds.length));
  const multiple = await launchAccounts(connection, selectedAccountIds);
  const multiObserved = await waitOwned(connection, selectedAccountIds.length);
  await wait(stableWaitMs);
  const stableMulti = await waitOwned(connection, selectedAccountIds.length, 30000);
  const initialMultiRows = stableMulti.rows;
  assert(new Set(initialMultiRows.map(row => row.accountId)).size === selectedAccountIds.length, 'Account-to-instance mapping was not one-to-one.');
  assert(new Set(initialMultiRows.map(row => row.pid)).size === selectedAccountIds.length, 'Multi-client PIDs were not distinct.');
  const instanceIds = multiple.operations.map(operation => operation.instanceId || operation.environmentId);
  assert(new Set(instanceIds).size === selectedAccountIds.length, 'Legacy slot allocation was not distinct.');
  report.multiClient = {
    passed: true,
    count: selectedAccountIds.length,
    pids: initialMultiRows.map(row => row.pid),
    instanceIds,
    uniqueAccountMapping: true,
    stableAfterMs: stableWaitMs,
  };

  const target = initialMultiRows[0];
  const siblings = initialMultiRows.slice(1);
  const restarted = await connection.evaluate(`window.sunday.instances.restart(${JSON.stringify(target.capability)})`);
  assert(restarted && restarted.ok && restarted.operation && restarted.operation.capability, restarted && restarted.error || 'Owned restart failed.');
  assert(Number(restarted.operation.pid) !== Number(target.pid), 'Restart did not create a new process identity.');
  const afterRestart = await waitOwned(connection, selectedAccountIds.length);
  assert(siblings.every(sibling => afterRestart.rows.some(row => Number(row.pid) === Number(sibling.pid))), 'A sibling did not survive exact restart.');
  await stopExact(connection, restarted.operation.capability);
  const afterCloseOne = await waitOwned(connection, selectedAccountIds.length - 1);
  assert(siblings.every(sibling => afterCloseOne.rows.some(row => Number(row.pid) === Number(sibling.pid))), 'A sibling did not survive exact teardown.');

  const relaunched = await launchAccounts(connection, selectedAccountIds.slice(0, 1));
  const afterReuse = await waitOwned(connection, selectedAccountIds.length);
  assert(afterReuse.rows.some(row => Number(row.pid) === Number(relaunched.operations[0].pid)), 'Relaunched client was not observed after slot reuse.');
  report.restartReuse = {
    passed: true,
    previousPid: target.pid,
    restartedPid: restarted.operation.pid,
    relaunchedPid: relaunched.operations[0].pid,
    siblingPids: siblings.map(row => row.pid),
    siblingsSurvivedRestart: true,
    siblingsSurvivedTeardown: true,
    slotReusedWithoutFalseOccupied: true,
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
    preserved: baselinePreserved,
    notAdopted: baselineNotAdopted,
    notTerminated: baselinePreserved,
  };

  connection = await restartFromSettings(connection, false);
  const disabled = await selection(connection);
  assert(!disabled.enabled && !disabled.settingEnabled && disabled.activationSource === 'none', 'Settings disablement did not persist.');
  assert(disabled.adapter === 'UnavailableRobloxIsolationAdapter' && disabled.isolationState === 'UNAVAILABLE', 'Disable restart did not return to the unavailable adapter.');
  const disabledLaunch = await connection.evaluate(`window.sunday.launch.accounts(${JSON.stringify(accountIds.slice(0, 1))}, '')`);
  assert(disabledLaunch && disabledLaunch.prepared === true && disabledLaunch.ok === false, 'Unavailable mode did not remain planning-only.');
  await wait(1500);
  const disabledProcesses = await robloxSnapshot();
  assert(disabledProcesses.every(row => baseline.some(before => identity(before) === identity(row))), 'Disabled mode spawned an unexpected Roblox process.');
  report.disable = { ...disabled, planningOnly: true, automaticRobloxSpawns: 0 };
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
    assert(invalid.adapter === 'UnavailableRobloxIsolationAdapter', `LEGACY_COMPAT=${value} did not fail closed.`);
    report.backwardCompatibility[value] = { enabled: false, activationSource: invalid.activationSource, adapter: invalid.adapter };
    await closePackaged(connection);
    connection = null;
  }

  report.passed = true;
} catch (error) {
  report.failure = error && error.message ? error.message : String(error);
} finally {
  await cleanupOwned(connection);
  if (connection) {
    try { await connection.evaluate(`window.sunday.settings.save({ multiInstanceMode: false })`); } catch (_) {}
    await closePackaged(connection);
  }
  if (child && child.exitCode == null) {
    try { child.kill(); } catch (_) {}
  }
  await wait(1000);
  if (fs.existsSync(webviewRoot)) fs.rmSync(webviewRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  report.completedAt = new Date().toISOString();
  const reportDirectory = path.join(root, 'artifacts');
  fs.mkdirSync(reportDirectory, { recursive: true });
  const reportPath = path.join(reportDirectory, `settings-live-qualification-v${expectedVersion}.json`);
  report.reportPath = path.relative(root, reportPath).split(path.sep).join('/');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (!report.passed) process.exitCode = 1;
