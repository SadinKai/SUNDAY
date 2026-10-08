import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.SUNDAY_TEST_EXE ? path.resolve(process.env.SUNDAY_TEST_EXE) : '';
const userData = process.env.SUNDAY_USER_DATA ? path.resolve(process.env.SUNDAY_USER_DATA) : '';
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const profileLabel = String(process.env.SUNDAY_NAVIGATION_PROFILE_LABEL || '').trim().replace(/[^a-z0-9_-]/gi, '');
const profileCredentialSetting = String(process.env.SUNDAY_NAVIGATION_PROFILE_CONTAINS_CREDENTIALS || '').trim();

if (process.env.SUNDAY_PACKAGED_NAVIGATION_PROFILE !== '1') {
  throw new Error('Refusing packaged navigation profiling without SUNDAY_PACKAGED_NAVIGATION_PROFILE=1.');
}
if (process.platform !== 'win32') throw new Error('Packaged navigation profiling is Windows-only.');
if (!executable || !fs.existsSync(executable)) {
  throw new Error('SUNDAY_TEST_EXE must name the exact packaged Sunday.exe candidate.');
}
if (!userData || !path.isAbsolute(userData) || !fs.existsSync(userData)) {
  throw new Error('SUNDAY_USER_DATA must name an existing absolute profile directory.');
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

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

async function connect(port, startedAt, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`);
      const targets = await response.json();
      const page = targets.find(target => target.type === 'page'
        && (/tauri/i.test(target.url || '') || /SUNDAY Launcher/i.test(target.title || '')));
      if (!page) throw new Error('No SUNDAY renderer target is available.');
      const targetReadyMs = Date.now() - startedAt;
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
      return { socket, evaluate, targetReadyMs };
    } catch (error) {
      lastError = error;
      await wait(100);
    }
  }
  throw new Error(`Could not connect to the packaged renderer: ${lastError && lastError.message}`);
}

async function waitRendererReady(evaluate, startedAt, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let domReadyMs = null;
  let shellReadyMs = null;
  let shellHeading = '';
  while (Date.now() < deadline) {
    const state = await evaluate(`(() => ({
      dom: Boolean(document.querySelector('#nav') && document.querySelector('#content')),
      shellReady: Boolean(typeof state !== 'undefined' && document.querySelector('#content .view')),
      statusReady: Boolean(typeof state !== 'undefined' && state.status && state.statusLoading === false),
      heading: (document.querySelector('#content h1') || {}).textContent || ''
    }))()`);
    if (domReadyMs == null && state.dom) domReadyMs = Date.now() - startedAt;
    if (shellReadyMs == null && state.shellReady) {
      shellReadyMs = Date.now() - startedAt;
      shellHeading = state.heading.trim();
    }
    if (state.statusReady) {
      return {
        domReadyMs,
        shellReadyMs,
        statusReadyMs: Date.now() - startedAt,
        heading: shellHeading || state.heading.trim(),
      };
    }
    await wait(50);
  }
  throw new Error('Packaged renderer did not finish startup.');
}

const port = await freePort();
const webviewData = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-navigation-webview-'));
const environment = {
  ...process.env,
  SUNDAY_USER_DATA: userData,
  WEBVIEW2_USER_DATA_FOLDER: webviewData,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`,
};
delete environment.LEGACY_COMPAT;

const startedAt = Date.now();
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
  profileContainsCredentials: profileCredentialSetting === '1' ? true : (profileCredentialSetting === '0' ? false : null),
  credentialValuesLogged: false,
  startedAt: new Date(startedAt).toISOString(),
  passed: false,
};

try {
  connection = await connect(port, startedAt);
  report.startup = await waitRendererReady(connection.evaluate, startedAt);
  await connection.evaluate(`(() => {
    const calls = [];
    const wrap = (owner, key, label) => {
      const original = owner && owner[key];
      if (typeof original !== 'function') return;
      owner[key] = async (...args) => {
        const started = performance.now();
        const row = { label, started, ended: null, durationMs: null, ok: null };
        calls.push(row);
        try {
          const value = await original(...args);
          row.ok = !value || value.ok !== false;
          return value;
        } finally {
          row.ended = performance.now();
          row.durationMs = Math.round((row.ended - row.started) * 10) / 10;
        }
      };
    };
    window.__sundayNavigationCalls = calls;
    wrap(window.sunday, 'status', 'status');
    wrap(window.sunday, 'adapterSelection', 'adapterSelection');
    wrap(window.sunday.instances, 'get', 'instances.get');
    wrap(window.sunday.accounts, 'list', 'accounts.list');
    wrap(window.sunday.keeper, 'status', 'keeper.status');
    wrap(window.sunday.launch, 'plans', 'launch.plans');
    wrap(window.sunday.games, 'browse', 'games.browse');
    wrap(window.sunday.playtime, 'stats', 'playtime.stats');
    wrap(window.sunday.people, 'list', 'people.list');
    wrap(window.sunday.people, 'presence', 'people.presence');
    return true;
  })()`);

  report.bootRpcProbe = await connection.evaluate(`(async () => {
    const time = async (label, work) => {
      const started = performance.now();
      try { await work(); return { label, durationMs: Math.round((performance.now() - started) * 10) / 10, ok: true }; }
      catch (_) { return { label, durationMs: Math.round((performance.now() - started) * 10) / 10, ok: false }; }
    };
    const started = performance.now();
    const operations = await Promise.all([
      time('status', () => window.sunday.status()),
      time('adapterSelection', () => window.sunday.adapterSelection()),
      time('instances.get', () => window.sunday.instances.get()),
      time('accounts.list', () => window.sunday.accounts.list()),
      time('keeper.status', () => window.sunday.keeper.status()),
      time('launch.plans', () => window.sunday.launch.plans()),
    ]);
    return { totalMs: Math.round((performance.now() - started) * 10) / 10, operations };
  })()`);

  report.navigation = await connection.evaluate(`(async () => {
    const waitFor = async (predicate, timeoutMs, label) => {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        if (predicate()) return performance.now();
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
      throw new Error('Timed out waiting for ' + label);
    };
    const neutral = async () => {
      document.querySelector('button[data-view="help"]').click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    };
    const measure = async ({ view, heading, first, final, timeoutMs = 30000 }) => {
      await neutral();
      const callIndex = window.__sundayNavigationCalls.length;
      const started = performance.now();
      document.querySelector('button[data-view="' + view + '"]').click();
      const shellAt = await waitFor(() => {
        const h = document.querySelector('#content h1');
        return h && h.textContent.trim() === heading;
      }, 5000, view + ' shell');
      const firstAt = await waitFor(first, timeoutMs, view + ' first content');
      const finalAt = await waitFor(final, timeoutMs, view + ' final content');
      return {
        clickToShellMs: Math.round((shellAt - started) * 10) / 10,
        clickToFirstContentMs: Math.round((firstAt - started) * 10) / 10,
        clickToFinalContentMs: Math.round((finalAt - started) * 10) / 10,
        calls: window.__sundayNavigationCalls.slice(callIndex).map(row => ({
          label: row.label,
          startAfterClickMs: Math.round((row.started - started) * 10) / 10,
          durationMs: row.durationMs,
          ok: row.ok,
        })),
      };
    };

    state.games = {
      list: [], query: '', nextPageToken: null, loading: false, error: null, loaded: false,
      sort: 'players', hideEmpty: false, categories: [], category: 'All', requestId: state.games.requestId + 1, refreshedAt: 0,
    };
    state.people.route = 'home';
    state.people.list = [];
    state.people.loaded = false;
    state.people.loading = false;
    state.people.error = null;
    state.people.requestId += 1;

    const launchCold = await measure({
      view: 'instances', heading: 'Launch',
      first: () => Boolean(document.querySelector('.launch-workflow')),
      final: () => Boolean(document.querySelector('.launch-workflow')),
    });
    const launchWarm = await measure({
      view: 'instances', heading: 'Launch',
      first: () => Boolean(document.querySelector('.launch-workflow')),
      final: () => Boolean(document.querySelector('.launch-workflow')),
    });
    const accountsCold = await measure({
      view: 'accounts', heading: 'Accounts',
      first: () => Boolean(document.querySelector('.acct, .identity-empty')),
      final: () => Boolean(document.querySelector('.acct, .identity-empty')),
    });
    const accountsWarm = await measure({
      view: 'accounts', heading: 'Accounts',
      first: () => Boolean(document.querySelector('.acct, .identity-empty')),
      final: () => Boolean(document.querySelector('.acct, .identity-empty')),
    });
    const peopleCold = await measure({
      view: 'people', heading: 'People',
      first: () => Boolean(document.querySelector('.people-entry')),
      final: () => Boolean(document.querySelector('.people-entry')),
    });
    const friendsStarted = performance.now();
    const friendsCallIndex = window.__sundayNavigationCalls.length;
    document.querySelector('[data-action="open-friends"]').click();
    const friendsShellAt = await waitFor(() => {
      const h = document.querySelector('#content h1');
      return h && h.textContent.trim() === 'Friends';
    }, 5000, 'friends shell');
    const friendsFirstAt = await waitFor(() => Boolean(document.querySelector('#people-grid')), 5000, 'friends first content');
    const friendsFinalAt = await waitFor(() => state.people.loaded && !state.people.loading, 30000, 'friends final content');
    const friendsCold = {
      clickToShellMs: Math.round((friendsShellAt - friendsStarted) * 10) / 10,
      clickToFirstContentMs: Math.round((friendsFirstAt - friendsStarted) * 10) / 10,
      clickToFinalContentMs: Math.round((friendsFinalAt - friendsStarted) * 10) / 10,
      calls: window.__sundayNavigationCalls.slice(friendsCallIndex).map(row => ({ label: row.label, startAfterClickMs: Math.round((row.started - friendsStarted) * 10) / 10, durationMs: row.durationMs, ok: row.ok })),
    };
    const peopleWarm = await measure({
      view: 'people', heading: 'People',
      first: () => Boolean(document.querySelector('.people-entry')),
      final: () => Boolean(document.querySelector('.people-entry')),
    });
    const friendsWarmStarted = performance.now();
    const friendsWarmCallIndex = window.__sundayNavigationCalls.length;
    document.querySelector('[data-action="open-friends"]').click();
    const friendsWarmShellAt = await waitFor(() => Boolean(document.querySelector('#people-grid')), 5000, 'warm friends shell');
    const friendsWarmContentAt = await waitFor(() => Boolean(document.querySelector('#people-grid .person, #people-grid .card, #people-grid .games-end')), 5000, 'warm friends content');
    const friendsWarm = {
      clickToShellMs: Math.round((friendsWarmShellAt - friendsWarmStarted) * 10) / 10,
      clickToFirstContentMs: Math.round((friendsWarmContentAt - friendsWarmStarted) * 10) / 10,
      clickToFinalContentMs: Math.round((friendsWarmContentAt - friendsWarmStarted) * 10) / 10,
      calls: window.__sundayNavigationCalls.slice(friendsWarmCallIndex).map(row => ({ label: row.label, startAfterClickMs: Math.round((row.started - friendsWarmStarted) * 10) / 10, durationMs: row.durationMs, ok: row.ok })),
    };
    const gamesCold = await measure({
      view: 'games', heading: 'Games',
      first: () => Boolean(document.querySelector('#games-grid .game')),
      final: () => state.games.loaded && !state.games.loading,
      timeoutMs: 45000,
    });
    const gamesWarm = await measure({
      view: 'games', heading: 'Games',
      first: () => Boolean(document.querySelector('#games-grid .game')),
      final: () => state.games.loaded && !state.games.loading,
    });
    return { launchCold, launchWarm, accountsCold, accountsWarm, peopleCold, peopleWarm, friendsCold, friendsWarm, gamesCold, gamesWarm };
  })()`);

  report.appVersion = await connection.evaluate(`state.status && state.status.appVersion`);
  report.accountCount = await connection.evaluate(`Array.isArray(state.accounts) ? state.accounts.length : 0`);
  report.passed = report.appVersion === expectedVersion;
  report.completedAt = new Date().toISOString();
  const suffix = profileLabel ? `-${profileLabel}` : '';
  const reportPath = path.join(root, 'artifacts', `packaged-navigation-profile-v${expectedVersion}${suffix}.json`);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  report.reportPath = path.relative(root, reportPath).replaceAll('\\', '/');
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (connection) {
    try { await connection.evaluate(`window.sunday.ui.window.close()`); } catch (_) {}
    try { connection.socket.close(); } catch (_) {}
  }
  await wait(1000);
  if (child.exitCode == null) {
    try { child.kill(); } catch (_) {}
  }
  try { fs.rmSync(webviewData, { recursive: true, force: true }); } catch (_) {}
}
