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
const port = Number(process.env.SUNDAY_LIVE_SINGLECLIENT_PORT || 9451);
const webviewRoot = path.join(os.tmpdir(), `sunday-singleclient-live-${process.pid}`);
const reportPath = path.join(root, 'artifacts', `singleclient-live-qualification-v${expectedVersion}.json`);

if (process.env.SUNDAY_LIVE_SINGLECLIENT_QUALIFICATION !== '1') {
  throw new Error('Refusing live Roblox qualification without SUNDAY_LIVE_SINGLECLIENT_QUALIFICATION=1.');
}
if (process.platform !== 'win32') throw new Error('Packaged single-client qualification is Windows-only.');
if (!executable || !fs.existsSync(executable) || path.basename(executable).toLowerCase() !== 'sunday.exe') {
  throw new Error('SUNDAY_TEST_EXE must name the exact packaged Sunday.exe candidate.');
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function assert(condition, message) { if (!condition) throw new Error(message); }
function redact(message) {
  return String(message || 'Qualification failed.')
    .replace(/[A-Za-z]:\\[^\r\n;]+/g, '[local path omitted]')
    .replace(/roblox-player:[^\s]+/gi, '[launch URI omitted]')
    .replace(/(?:ticket|cookie|token|capability)[=:]\s*[^\s,;]+/gi, '$1=[omitted]')
    .slice(0, 500);
}

function startPackaged() {
  fs.mkdirSync(webviewRoot, { recursive: true });
  const environment = { ...process.env };
  delete environment.SUNDAY_USER_DATA;
  delete environment.LEGACY_COMPAT;
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

async function connectPackaged(timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
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
        const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || 'Renderer evaluation failed.');
        return response.result.value;
      };
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (await evaluate('Boolean(window.sunday && state && state.status && document.querySelector("#content"))')) {
          return { socket, evaluate };
        }
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
    } catch (error) { lastError = error; }
    await wait(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}.`);
}

function ownedRows(snapshot) {
  return (snapshot && Array.isArray(snapshot.instances) ? snapshot.instances : [])
    .filter(row => row.source === 'sunday' && row.capability && row.controllable !== false);
}

async function instanceSnapshot(connection) {
  return connection.evaluate('window.sunday.instances.get()');
}

async function waitOwned(connection, count, timeoutMs = 120000) {
  return waitFor(async () => {
    const snapshot = await instanceSnapshot(connection);
    const rows = ownedRows(snapshot);
    if (rows.length === count) return rows;
    const plans = await connection.evaluate('window.sunday.launch.plans()');
    const latest = plans && Array.isArray(plans.plans) ? plans.plans[0] : null;
    if (count > 0 && latest && latest.state === 'FAILED') {
      const operation = Array.isArray(latest.operations) ? latest.operations.find(item => item.state === 'FAILED') : null;
      throw new Error(`${operation && operation.failureCode || 'LAUNCH_FAILED'}: ${operation && operation.reason || latest.reason || 'Launch failed.'}`);
    }
    return null;
  }, timeoutMs, `${count} SUNDAY-owned Roblox client(s)`, 750);
}

async function stopExact(connection, capability) {
  const stopped = await connection.evaluate(`window.sunday.instances.kill(${JSON.stringify(capability)})`);
  assert(stopped && stopped.ok, stopped && (stopped.error || stopped.reason) || 'Exact owned stop failed.');
}

async function closePackaged(connection, child) {
  if (connection) {
    try { await connection.evaluate('window.sunday.ui.window.close()'); } catch (_) {}
    try { connection.socket.close(); } catch (_) {}
  }
  await wait(1200);
  if (child && child.exitCode == null) {
    try { child.kill(); } catch (_) {}
  }
}

async function cleanupOwned(connection) {
  if (!connection) return;
  try {
    const rows = ownedRows(await instanceSnapshot(connection));
    for (const row of rows) {
      try { await stopExact(connection, row.capability); } catch (_) {}
    }
  } catch (_) {}
}

async function launchFromAccountPage(connection, accountId) {
  const clicked = await connection.evaluate(`(() => {
    setView('accounts');
    const button = [...document.querySelectorAll('[data-action="launch-account"]')]
      .find(item => item.dataset.id === ${JSON.stringify(accountId)});
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert(clicked, 'The Accounts page did not expose Launch for the authorized test account.');
  return (await waitOwned(connection, 1))[0];
}

async function launchFromMainPage(connection, accountId, placeId) {
  const clicked = await connection.evaluate(`(() => {
    setView('instances');
    for (const row of document.querySelectorAll('.launch-account-row')) {
      const selected = row.getAttribute('aria-pressed') === 'true';
      if ((row.dataset.id === ${JSON.stringify(accountId)}) !== selected) row.click();
    }
    const input = document.querySelector('#lp-place');
    if (!input) return false;
    input.value = ${JSON.stringify(placeId)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const button = document.querySelector('[data-action="launch-accounts"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  assert(clicked, 'The main Launch page did not expose an enabled normal launch action.');
  return (await waitOwned(connection, 1))[0];
}

async function browsePublicGame(connection) {
  let lastError = 'No public Roblox destination was returned.';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await connection.evaluate('window.sunday.games.browse()');
    const game = response && Array.isArray(response.games)
      ? response.games.find(item => /^\d+$/.test(String(item.placeId || '')))
      : null;
    if (game) return game;
    lastError = response && response.error || lastError;
    if (attempt < 2) await wait(1000);
  }
  throw new Error(lastError);
}

const report = {
  schemaVersion: 1,
  expectedVersion,
  packagedExecutable: path.basename(executable),
  environment: { type: os.type(), release: os.release(), arch: os.arch() },
  startedAt: new Date().toISOString(),
  adapter: null,
  accountPageLaunch: null,
  mainGameLaunch: null,
  diagnosticsSanitized: false,
  foreignProcessBaseline: null,
  passed: false,
  failure: null,
};

let child = null;
let connection = null;
try {
  const baseline = await processes.list();
  assert(baseline.length === 0, 'A Roblox client was already running; live qualification will not adopt or terminate it.');
  report.foreignProcessBaseline = { count: 0, adopted: false, terminated: false };

  child = startPackaged();
  connection = await connectPackaged();
  const settings = await connection.evaluate('window.sunday.settings.get()');
  if (settings && settings.settings && settings.settings.multiInstanceMode === true) {
    await connection.evaluate('window.sunday.settings.save({ multiInstanceMode: false })');
    await closePackaged(connection, child);
    connection = null;
    child = startPackaged();
    connection = await connectPackaged();
  }

  const status = await connection.evaluate('window.sunday.status()');
  assert(status.appVersion === expectedVersion, `Expected packaged ${expectedVersion}, received ${status.appVersion}.`);
  assert(status.robloxFound, 'Roblox Player was not detected by the packaged candidate.');
  assert(status.adapterSelection
    && status.adapterSelection.legacyCompatEnabled === false
    && status.adapterSelection.selectedAdapter === 'SingleClientRobloxIsolationAdapter'
    && status.adapterSelection.isolationState === 'ACTIVATED', 'The packaged process did not select normal single-client mode.');
  report.adapter = {
    selected: status.adapterSelection.selectedAdapter,
    state: status.adapterSelection.isolationState,
    activationSource: status.adapterSelection.legacyCompatActivationSource,
    legacyCompatEnabled: status.adapterSelection.legacyCompatEnabled,
    robloxDetected: status.robloxFound,
    robloxBuild: status.version,
  };

  const accounts = await connection.evaluate('window.sunday.accounts.list()');
  const usable = (accounts && Array.isArray(accounts.accounts) ? accounts.accounts : [])
    .filter(account => account.sessionExpired !== true);
  assert(usable.length >= 1, 'At least one authorized, non-expired saved test account is required.');
  const accountId = String(usable[0].id);

  let row = await launchFromAccountPage(connection, accountId);
  const activeVisible = await connection.evaluate(`(() => {
    setView('instances');
    return [...document.querySelectorAll('.irow[data-capability]')].some(item => item.dataset.capability);
  })()`);
  const focused = await connection.evaluate(`window.sunday.instances.focus(${JSON.stringify(row.capability)})`);
  assert(activeVisible, 'The packaged Active Clients view did not show the owned Roblox client.');
  assert(focused && focused.ok, focused && (focused.error || focused.reason) || 'Exact owned focus failed.');
  const restarted = await connection.evaluate(`window.sunday.instances.restart(${JSON.stringify(row.capability)})`);
  assert(restarted && restarted.ok && restarted.operation && restarted.operation.capability, restarted && restarted.error || 'Exact owned restart failed.');
  row = (await waitOwned(connection, 1))[0];
  assert(row.capability === restarted.operation.capability, 'Active Clients did not converge on the restarted owned capability.');
  await stopExact(connection, row.capability);
  await waitOwned(connection, 0, 60000);
  report.accountPageLaunch = { launched: true, activeClientsVisible: true, focus: true, restart: true, stop: true, remainingClients: 0 };

  const game = await browsePublicGame(connection);
  row = await launchFromMainPage(connection, accountId, String(game.placeId));
  await stopExact(connection, row.capability);
  await waitOwned(connection, 0, 60000);
  report.mainGameLaunch = { launched: true, destinationType: 'public-game-place', tracked: true, stop: true, remainingClients: 0 };

  const diagnostics = await connection.evaluate('window.sunday.diag()');
  const sanitized = JSON.stringify(diagnostics && diagnostics.diagnostics
    && diagnostics.diagnostics.sanitizedLaunchDiagnostics || {});
  assert(sanitized.length > 20, 'Sanitized launch diagnostics were unavailable.');
  assert(!/roblox-player:|gameinfo:|\.ROBLOSECURITY|private key|capability-[a-z0-9]|[A-Za-z]:\\/i.test(sanitized),
    'Sanitized launch diagnostics contained credential, capability, or local-path material.');
  report.diagnosticsSanitized = true;

  const finalProcesses = await processes.list();
  assert(finalProcesses.length === 0, 'A Roblox process remained after exact owned teardown.');
  report.passed = true;
} catch (error) {
  report.failure = redact(error && error.message ? error.message : error);
} finally {
  await cleanupOwned(connection);
  await closePackaged(connection, child);
  if (fs.existsSync(webviewRoot)) fs.rmSync(webviewRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  report.completedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (!report.passed) process.exitCode = 1;
