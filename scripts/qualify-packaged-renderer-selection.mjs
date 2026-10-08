import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.SUNDAY_TEST_EXE ? path.resolve(process.env.SUNDAY_TEST_EXE) : '';
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

if (process.env.SUNDAY_PACKAGED_RENDERER_SELECTION !== '1') {
  throw new Error('Refusing packaged renderer qualification without SUNDAY_PACKAGED_RENDERER_SELECTION=1.');
}
if (process.platform !== 'win32') throw new Error('Packaged renderer qualification is Windows-only.');
if (!executable || !fs.existsSync(executable)) {
  throw new Error('SUNDAY_TEST_EXE must name the exact packaged Sunday.exe candidate.');
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase();
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  await new Promise(resolve => server.close(resolve));
  if (!port) throw new Error('Could not reserve a renderer debugging port.');
  return port;
}

function cdp(socket) {
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

async function connect(port, timeoutMs = 30000) {
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
      const send = cdp(socket);
      await send('Runtime.enable');
      const evaluate = async expression => {
        const response = await send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
        });
        if (response.exceptionDetails) {
          throw new Error(response.exceptionDetails.exception?.description
            || response.exceptionDetails.text
            || 'Renderer evaluation failed.');
        }
        return response.result.value;
      };
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await evaluate(`Boolean(window.sunday && typeof state !== 'undefined' && state.status && document.querySelector('#content'))`)) {
          return { socket, evaluate };
        }
        await wait(100);
      }
      socket.close();
      throw new Error('SUNDAY renderer did not become ready.');
    } catch (error) {
      lastError = error;
      await wait(150);
    }
  }
  throw new Error(`Could not connect to the packaged renderer: ${lastError && lastError.message}`);
}

const port = await freePort();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-packaged-renderer-'));
const userData = path.join(tempRoot, 'profile');
const webviewData = path.join(tempRoot, 'webview');
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(webviewData, { recursive: true });

const environment = {
  ...process.env,
  SUNDAY_USER_DATA: userData,
  WEBVIEW2_USER_DATA_FOLDER: webviewData,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`,
};
delete environment.LEGACY_COMPAT;

const child = spawn(executable, [], {
  cwd: path.dirname(executable),
  env: environment,
  stdio: 'ignore',
  windowsHide: true,
});
let connection = null;
const report = {
  schemaVersion: 1,
  expectedVersion,
  executable,
  executableSha256: sha256(executable),
  mockedBackend: true,
  firstResponseDelayMs: 15500,
  realRobloxLaunchCalls: 0,
  passed: false,
};

try {
  connection = await connect(port);
  const result = await connection.evaluate(`(async () => {
    const account = id => ({ id, username: 'account-' + id.toLowerCase(), sessionExpired: false });
    const allAccounts = ['A', 'B', 'C', 'D'].map(account);
    const calls = [];
    const trace = [];
    let mockInstances = [];
    let mockAccounts = allAccounts.slice();
    const original = {
      accountsLaunch: window.sunday.launch.accounts,
      joinLaunch: window.sunday.launch.join,
      instancesGet: window.sunday.instances.get,
      accountsList: window.sunday.accounts.list,
    };
    const completed = ids => ({
      ok: true,
      prepared: false,
      state: 'LEGACY_COMPAT',
      selectedCount: ids.length,
      launched: ids.length,
      failed: 0,
      plan: {
        planId: 'mock-plan-' + (calls.length + 1),
        state: 'COMPLETED',
        operations: ids.map((accountId, index) => ({
          operationId: 'mock-' + accountId,
          accountId,
          state: 'RUNNING',
          pid: 8800 + calls.length * 10 + index,
        })),
      },
      results: ids.map(accountId => ({ accountId, ok: true, state: 'RUNNING' })),
    });
    const selected = label => trace.push({ label, selected: Array.from(state.selected || []) });
    const waitFor = async (predicate, label, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Timed out waiting for ' + label);
    };
    const click = async (action, id = '', expectedCalls = null) => {
      const button = document.createElement('button');
      button.dataset.action = action;
      if (id) button.dataset.id = id;
      document.body.appendChild(button);
      button.click();
      if (expectedCalls != null) await waitFor(() => calls.length === expectedCalls, action + ' call');
      else await new Promise(resolve => setTimeout(resolve, 30));
      button.remove();
    };

    window.sunday.launch.accounts = async ids => {
      const participants = Array.from(ids || [], String);
      calls.push(participants);
      if (calls.length === 1) await new Promise(resolve => setTimeout(resolve, 15500));
      return completed(participants);
    };
    window.sunday.launch.join = async () => { throw new Error('Unexpected join launch path.'); };
    window.sunday.instances.get = async () => ({ ok: true, instances: mockInstances });
    window.sunday.accounts.list = async () => ({ ok: true, accounts: mockAccounts });

    try {
      state.view = 'help';
      state.placeId = '';
      state.accounts = allAccounts.slice();
      state.instances = [];
      state.selected = new Set(['A', 'B']);
      selected('A+B selected');

      await click('launch-accounts', '', 1);
      await waitFor(() => state.selected.size === 0, 'A+B selection clear', 20000);
      selected('A+B completed');

      mockInstances = [
        { source: 'sunday', accountId: 'A', state: 'RUNNING', pid: 8800, capability: 'mock-a' },
        { source: 'sunday', accountId: 'B', state: 'RUNNING', pid: 8801, capability: 'mock-b' },
      ];
      await loadInstances();
      selected('A+B active refresh');

      mockAccounts = [account('A'), account('B')];
      await loadAccounts();
      selected('A+B account refresh');

      await click('toggle-account', 'A');
      selected('active A toggle rejected');

      state.accounts = allAccounts.slice();
      await click('toggle-account', 'C');
      selected('C selected');
      await click('launch-accounts', '', 2);
      await waitFor(() => state.selected.size === 0, 'C selection clear');
      selected('C completed');

      mockInstances = mockInstances.concat([
        { source: 'sunday', accountId: 'C', state: 'RUNNING', pid: 8810, capability: 'mock-c' },
      ]);
      await loadInstances();
      mockAccounts = allAccounts.slice();
      await loadAccounts();
      selected('A+B+C refresh');

      await click('toggle-account', 'D');
      selected('D selected');
      await click('launch-accounts', '', 3);
      await waitFor(() => state.selected.size === 0, 'D selection clear');
      selected('D completed');

      const status = await window.sunday.status();
      return {
        calls,
        trace,
        finalSelection: Array.from(state.selected || []),
        appVersion: status && status.appVersion,
        maxConcurrent: status && status.legacyManagedClients && status.legacyManagedClients.maxConcurrent,
        selectionHelperPresent: Boolean(window.SundayModel && window.SundayModel.selectionAfterLaunch),
        scripts: Array.from(document.scripts).map(script => String(script.src || '')).filter(Boolean),
      };
    } finally {
      window.sunday.launch.accounts = original.accountsLaunch;
      window.sunday.launch.join = original.joinLaunch;
      window.sunday.instances.get = original.instancesGet;
      window.sunday.accounts.list = original.accountsList;
    }
  })()`);

  assert(result.appVersion === expectedVersion,
    `Packaged version mismatch: expected ${expectedVersion}, received ${result.appVersion}.`);
  assert(Number(result.maxConcurrent) === 6, 'Packaged backend did not expose six-client capacity.');
  assert(result.selectionHelperPresent, 'Packaged renderer does not expose selectionAfterLaunch.');
  assert(JSON.stringify(result.calls) === JSON.stringify([['A', 'B'], ['C'], ['D']]),
    `Unexpected packaged launch participants: ${JSON.stringify(result.calls)}.`);
  assert(Array.isArray(result.finalSelection) && result.finalSelection.length === 0,
    'Packaged renderer retained a pending selection after D completed.');
  for (const checkpoint of ['A+B completed', 'A+B active refresh', 'A+B account refresh', 'active A toggle rejected', 'C completed', 'A+B+C refresh', 'D completed']) {
    const row = result.trace.find(item => item.label === checkpoint);
    assert(row && Array.isArray(row.selected) && row.selected.length === 0,
      `Selection was not empty at checkpoint: ${checkpoint}.`);
  }
  report.renderer = result;
  report.passed = true;
} catch (error) {
  report.failure = error && error.message ? error.message : String(error);
} finally {
  if (connection) {
    try { await connection.evaluate('window.sunday.ui.window.close()'); } catch (_) {}
    try { connection.socket.close(); } catch (_) {}
  }
  const exitDeadline = Date.now() + 5000;
  while (child.exitCode == null && Date.now() < exitDeadline) await wait(50);
  if (child.exitCode == null) {
    try { child.kill(); } catch (_) {}
  }
  await wait(500);
  const resolvedTemp = path.resolve(tempRoot);
  const resolvedSystemTemp = path.resolve(os.tmpdir()) + path.sep;
  if (resolvedTemp.startsWith(resolvedSystemTemp) && path.basename(resolvedTemp).startsWith('sunday-packaged-renderer-')) {
    fs.rmSync(resolvedTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  report.completedAt = new Date().toISOString();
  const reportDirectory = path.join(root, 'artifacts');
  fs.mkdirSync(reportDirectory, { recursive: true });
  const reportPath = path.join(reportDirectory, `packaged-renderer-selection-v${expectedVersion}.json`);
  report.reportPath = path.relative(root, reportPath).split(path.sep).join('/');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (!report.passed) process.exitCode = 1;
