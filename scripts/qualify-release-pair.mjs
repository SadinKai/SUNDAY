import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const native = require('../src/main/native');
const { DatabaseSync } = require('node:sqlite');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
const executable = path.resolve(process.env.SUNDAY_TEST_EXE || path.join(root, 'dist/Sunday/Sunday.exe'));
const profile = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'com.sadinkai.sundaylauncher');
const databasePath = path.join(profile, 'sunday-state.sqlite3');
const cloneRoot = path.join(profile, 'legacy-instances');
const reportPath = path.join(root, 'artifacts', `release-pair-${version}-${Date.now()}.json`);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const identity = row => `${row.pid}:${row.processIdentity}:${String(row.executablePath).toLowerCase()}`;
const reconcileOnly = process.argv.length === 3 && process.argv[2] === '--reconcile-only';
assert.ok(process.argv.length === 2 || reconcileOnly, 'Unsupported qualification argument.');

if (process.env.SUNDAY_RELEASE_PAIR_QUALIFICATION !== '1') throw new Error('Explicit two-account live qualification authorization is required.');
assert.equal(process.platform, 'win32');
assert.ok(fs.existsSync(executable));
assert.ok(native.init() && native.isAvailable(), 'Native observation must be available.');
assert.match(String(process.env.SUNDAY_TEST_SHA256 || ''), /^[a-f0-9]{64}$/, 'Pin the exact approved candidate SHA-256.');
assert.equal(digest(fs.readFileSync(executable)), process.env.SUNDAY_TEST_SHA256);

function processes() {
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process -Filter \"Name LIKE 'Roblox%' OR Name LIKE 'Sunday%' OR Name = 'node.exe'\" | Select-Object Name,ProcessId,CreationDate,ExecutablePath); [pscustomobject]@{ok=$true;rows=$rows} | ConvertTo-Json -Compress -Depth 4"],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const observation = JSON.parse(output);
  assert.equal(observation.ok, true, 'Process observation failed.');
  const players = native.listProcesses('RobloxPlayerBeta.exe');
  assert.ok(Array.isArray(players), 'Native process observation failed.');
  return { sunday: observation.rows.filter(row => /^sunday/i.test(row.Name)
      || (row.Name.toLowerCase() === 'node.exe' && /[\\/]sunday[^\\/]*[\\/]node\.exe$/i.test(String(row.ExecutablePath)))),
    roblox: observation.rows.filter(row => /^roblox/i.test(row.Name)), players };
}

function managedPath(value) {
  const roots = [cloneRoot];
  if (fs.existsSync(cloneRoot)) roots.push(fs.realpathSync.native(cloneRoot));
  if (roots.some(directory => String(value).toLowerCase().startsWith(directory.toLowerCase() + path.sep))) return true;
  // MSIX virtualization may report a LocalCache path while JavaScript retains
  // the logical Roaming path. Prove aliasing by file identity, never suffixes.
  const fileIdentity = native.fileIdentityOfPath(value);
  if (!fileIdentity) return false;
  for (let slot = 1; slot <= 24; slot++) {
    if (native.fileIdentityOfPath(path.join(cloneRoot, `instance-${slot}`, 'RobloxPlayerBeta.exe')) === fileIdentity) return true;
  }
  return false;
}

function durable() {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(Object.values(db.prepare('PRAGMA quick_check').get())[0], 'ok');
    const counts = { ownership: 0, running: 0, inFlight: 0, slots: 0, leases: 0 };
    const rows = db.prepare('SELECT namespace, value_json FROM records WHERE namespace IN (?, ?, ?, ?)')
      .all('launch-plans-v1', 'legacy-process-ownership-v1', 'slot-leases', 'environment-leases-v1');
    for (const row of rows) {
      const value = JSON.parse(row.value_json);
      if (row.namespace === 'legacy-process-ownership-v1') counts.ownership++;
      if (row.namespace === 'launch-plans-v1') for (const op of value.operations || []) {
        if (op.state === 'RUNNING') counts.running++;
        if (['ALLOCATED', 'STARTING', 'LAUNCHING'].includes(op.state)) counts.inFlight++;
      }
      if (row.namespace === 'slot-leases' && ['RESERVED', 'BOUND'].includes(value.state)) counts.slots++;
      if (row.namespace === 'environment-leases-v1' && !['REVOKED', 'RELEASED'].includes(value.state)) counts.leases++;
    }
    return counts;
  } finally { db.close(); }
}

function protectedFingerprint() {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    // Hash protected ciphertext only. Never decrypt, return, or copy sessions.
    db.function('protected_digest', value => digest(String(value || '')));
    const rows = db.prepare(`SELECT protected_digest(json_extract(item.value, '$.cookie')) AS digest,
      substr(json_extract(item.value, '$.cookie'), 1, 4) = 'enc:' AS protected
      FROM records AS document, json_each(document.value_json) AS item
      WHERE document.namespace = 'documents' AND document.record_key = 'accounts.json'`).all();
    assert.ok(rows.length >= 2 && rows.every(row => row.protected === 1), 'Saved sessions must remain protected.');
    return digest(rows.map(row => row.digest).sort().join('\n'));
  } finally { db.close(); }
}

function verifyOwned(row) {
  assert.ok(row.source === 'sunday' && row.controllable === true && row.capability && selected.includes(String(row.accountId)), 'Account lacks managed ownership.');
  const fingerprint = native.processFingerprintOf(row.pid);
  assert.ok(fingerprint.fileIdentity && fingerprint.processIdentity, 'Process fingerprint is unavailable.');
  assert.ok(managedPath(fingerprint.executablePath), 'Managed process is outside the clone root.');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const records = db.prepare('SELECT value_json FROM records WHERE namespace = ?').all('legacy-process-ownership-v1').map(value => JSON.parse(value.value_json));
    const matches = records.filter(value => Number(value.pid) === Number(row.pid) && String(value.accountId) === String(row.accountId)
      && value.processIdentity === fingerprint.processIdentity && value.fileIdentity === fingerprint.fileIdentity
      && String(value.executablePath).toLowerCase() === fingerprint.executablePath.toLowerCase());
    assert.equal(matches.length, 1, 'Exact durable ownership could not be proven.');
  } finally { db.close(); }
  return { ...row, ...fingerprint };
}

function logOffsets() {
  const directory = path.join(profile, 'logs');
  return new Map(fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => [entry.name, fs.statSync(path.join(directory, entry.name)).size]) : []);
}

function newLogEvidence(offsets) {
  let bytesScanned = 0;
  const events = [];
  const directory = path.join(profile, 'logs');
  for (const [name, size] of logOffsets()) {
    const start = offsets.get(name) || 0;
    assert.ok(size >= start, 'Log rotation prevents a bounded new-log audit.');
    if (size === start) continue;
    const bytes = Buffer.alloc(size - start);
    const fd = fs.openSync(path.join(directory, name), 'r');
    try { assert.equal(fs.readSync(fd, bytes, 0, bytes.length, start), bytes.length); } finally { fs.closeSync(fd); }
    const text = bytes.toString('utf8'); bytesScanned += bytes.length;
    assert.ok(!/\.ROBLOSECURITY|authenticationticket|authorization\s*:|roblox-player:|"(?:capability|token)"\s*:\s*"[^"\r\n]+"/i.test(text), 'Sensitive material detected in new log bytes; values suppressed.');
    if (name === 'phase7-live-runtime-forensic.jsonl') for (const line of text.split(/\r?\n/).filter(Boolean)) {
      const value = JSON.parse(line);
      if (['allocation_start', 'allocation_complete', 'launch_spawn_request', 'launch_spawned', 'launch_marked_running', 'launch_failed'].includes(value.event)) {
        events.push({ event: value.event, at: value.at });
      }
    }
    bytes.fill(0);
  }
  return { bytesScanned, sensitiveMarkers: 0, events };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function until(check, timeout, message) {
  const end = Date.now() + timeout;
  do { const value = await check(); if (value) return value; await wait(250); } while (Date.now() < end);
  throw new Error(message);
}

async function connect(port) {
  return until(async () => {
    let targets;
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { return null; }
    const target = targets.find(row => row.type === 'page' && /tauri|SUNDAY Launcher/i.test(`${row.url} ${row.title}`));
    if (!target) return null;
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let next = 0; const pending = new Map();
    socket.addEventListener('message', event => { const value = JSON.parse(event.data); if (pending.has(value.id)) { pending.get(value.id)(value); pending.delete(value.id); } });
    const evaluate = async expression => {
      const id = ++next;
      let timer;
      let response;
      try {
        response = await Promise.race([
          new Promise(resolve => { pending.set(id, resolve); socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); }),
          new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Packaged response timed out; no retry permitted.')), 180000); }),
        ]);
      } finally { clearTimeout(timer); pending.delete(id); }
      assert.ok(!response.error && !response.result.exceptionDetails, 'Packaged evaluation failed; details suppressed.');
      return response.result.result.value;
    };
    return { socket, evaluate };
  }, 45000, 'Packaged renderer did not become available.');
}

const report = { version, mode: reconcileOnly ? 'STARTUP_RECONCILIATION_ONLY' : 'TWO_ACCOUNT_QUALIFICATION', executableSha256: digest(fs.readFileSync(executable)), decision: 'BLOCKED', gates: {}, attemptCount: 0, liveQualifiedCount: 0, currentGate: 'baseline' };
let connection; let child; let selected = []; let owned = [];
const initialOffsets = logOffsets();
let protectedBefore;
try {
  const baseline = processes();
  assert.equal(baseline.sunday.length, 0); assert.equal(baseline.roblox.length, 0);
  const before = durable();
  assert.deepEqual(before, { ownership: 0, running: 0, inFlight: reconcileOnly ? 1 : 0, slots: 0, leases: 0 });
  report.durableBefore = before;
  protectedBefore = protectedFingerprint();
  report.gates.baseline = 'PASS';
  const space = fs.statfsSync(root);
  assert.ok(space.bavail * space.bsize >= 1024 * 1024 * 1024, 'At least 1 GB free is required before live qualification.');
  report.currentGate = 'packaged-startup';
  const port = await freePort();
  const environment = { ...process.env, WEBVIEW2_USER_DATA_FOLDER: path.join(os.tmpdir(), `sunday-release-pair-${process.pid}`),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` };
  delete environment.LEGACY_COMPAT; delete environment.SUNDAY_USER_DATA;
  const start = async overrides => {
    child = spawn(executable, [], { cwd: path.dirname(executable), env: { ...environment, ...overrides }, stdio: 'ignore', windowsHide: true });
    child.once('error', () => { report.gates.packagedStartup = 'FAIL'; });
    const connected = await connect(port);
    await until(() => connected.evaluate('Boolean(window.sunday && state.status && state.accounts)'), 30000, 'Packaged state did not initialize.');
    return connected;
  };
  const close = async () => {
    await connection.evaluate('window.sunday.ui.window.close(); true').catch(() => {});
    connection.socket.close(); connection = null;
    await until(() => processes().sunday.length === 0, 30000, 'SUNDAY did not exit normally.');
  };
  connection = await start({ SUNDAY_USER_DATA: path.join(os.tmpdir(), `sunday-pair-fresh-${process.pid}`) });
  const fresh = await connection.evaluate('({ multi:state.settings.multiInstanceMode, autoDetect:state.settings.autoDetect, accounts:state.accounts.length })');
  assert.equal(fresh.multi, true); assert.equal(fresh.autoDetect, true); assert.equal(fresh.accounts, 0);
  assert.equal(processes().roblox.length, 0);
  report.gates.freshProfileDefaults = 'PASS';
  await close();
  connection = await start({});
  await until(() => connection.evaluate('Boolean(window.sunday && state.status && state.accounts)'), 30000, 'Packaged state did not initialize.');
  const startup = await connection.evaluate(`(async () => {
    await loadAccounts();
    const status = await window.sunday.status(); const diagnostics = (await window.sunday.diag()).diagnostics;
    return { version: status.appVersion, autoDetect: state.settings.autoDetect, multi: state.settings.multiInstanceMode,
      source: status.adapterSelection.legacyCompatActivationSource, adapter: status.adapterSelection.selectedAdapter,
      observationFailed: Boolean(diagnostics.legacyCompatibility.processObservationFailure),
      accounts: state.accounts.filter(row => !row.sessionExpired).map(row => String(row.id)), selected: state.selected.size };
  })()`);
  assert.equal(startup.version, version); assert.equal(startup.multi, true); assert.equal(startup.autoDetect, true);
  assert.equal(startup.adapter, 'LegacyRobloxIsolationAdapter'); assert.equal(startup.source, 'settings'); assert.equal(startup.observationFailed, false);
  assert.equal(startup.selected, 0); assert.ok(startup.accounts.length >= 2);
  selected = startup.accounts.slice(0, 2);
  report.gates.packagedDefaults = 'PASS';
  assert.deepEqual(durable(), { ownership: 0, running: 0, inFlight: 0, slots: 0, leases: 0 });
  if (reconcileOnly) {
    // Normal startup reconciles interrupted operations. No direct database
    // writes, account launches, or historical evidence edits occur here.
    await close();
    assert.equal(processes().roblox.length, 0);
    assert.equal(protectedFingerprint(), protectedBefore);
    report.gates.normalStartupReconciliation = 'PASS';
    report.logs = newLogEvidence(initialOffsets);
    report.decision = 'PASS';
  } else {
  report.currentGate = 'two-account-launch';
  // Exactly one UI submission. Raw responses and capabilities stay in memory.
  await connection.evaluate(`(() => { window.__releasePair = { done:false }; const original = window.sunday.launch.accounts;
    window.sunday.launch.accounts = async (...args) => { const response = await original(...args); window.__releasePair.response = response; window.__releasePair.done = true; return response; };
    document.querySelector('[data-view="instances"]').click(); return true; })()`);
  await until(() => connection.evaluate('Boolean(document.querySelector("[data-action=launch-accounts]"))'), 10000, 'Launch page unavailable.');
  await connection.evaluate(`(() => { for (const id of ${JSON.stringify(selected)}) {
    const button = [...document.querySelectorAll('[data-action="toggle-account"]')].find(row => row.dataset.id === id);
    if (!button || button.disabled) throw new Error('Account unavailable'); button.click(); }
    document.querySelector('[data-action="launch-accounts"]').click(); return true; })()`);
  report.attemptCount = 1;
  await until(async () => {
    const observed = processes();
    assert.ok(observed.players.every(row => managedPath(row.executablePath))
      && observed.roblox.filter(row => row.Name.toLowerCase() === 'robloxplayerbeta.exe').every(row => managedPath(row.ExecutablePath)), 'Unexpected unowned canonical-path process appeared.');
    return connection.evaluate('window.__releasePair.done');
  }, 180000, 'Launch timed out; no retry permitted.');
  const response = await connection.evaluate('window.__releasePair.response');
  assert.equal(response.ok, true, 'Launch failed; inspect sanitized stage evidence.');
  assert.equal(response.launched, 2); assert.equal(response.failed, 0);
  report.currentGate = 'ownership-and-window-verification';
  await until(async () => (await connection.evaluate('window.sunday.instances.get()')).instances.filter(row => row.source === 'sunday').length === 2,
    15000, 'Managed client observation did not converge.');
  owned = (await connection.evaluate('window.sunday.instances.get()')).instances.filter(row => row.source === 'sunday').map(verifyOwned);
  assert.equal(owned.length, 2);
  const observed = processes(); assert.equal(observed.players.length, 2);
  const windows = native.windowInfoForPids(owned.map(row => row.pid));
  for (const row of owned) {
    assert.ok(selected.includes(String(row.accountId)) && row.capability && row.controllable === true);
    assert.equal(String(windows.get(row.pid)?.className).toUpperCase(), 'WINDOWSCLIENT');
    assert.equal(windows.get(row.pid)?.responding, true);
  }
  assert.equal(durable().ownership, 2); assert.equal(durable().running, 2);
  report.gates.twoResponsiveOwnedClients = 'PASS'; report.liveQualifiedCount = 2;
  report.clients = owned.map((row, index) => ({ alias: index ? 'B' : 'A', pid: row.pid, processIdentity: row.processIdentity,
    fileIdentity: row.fileIdentity, clonePath: path.relative(cloneRoot, row.executablePath), responsiveWindowsClient: true }));
  report.currentGate = 'selection-refresh';
  await until(() => connection.evaluate('state.selected.size === 0'), 10000, 'Successful selections did not clear.');
  assert.equal(await connection.evaluate('(async () => { await loadInstances(); await loadAccounts(); return state.selected.size; })()'), 0);
  report.gates.selectionRefresh = 'PASS';
  report.currentGate = 'application-restart';
  const beforeRestart = owned.map(identity).sort();
  await close();
  assert.deepEqual(processes().players.map(identity).sort(), beforeRestart);
  connection = await start({});
  await until(async () => (await connection.evaluate('window.sunday.instances.get()')).instances.filter(row => row.source === 'sunday').length === 2,
    30000, 'Exact client ownership was not restored after application restart.');
  owned = (await connection.evaluate('window.sunday.instances.get()')).instances.filter(row => row.source === 'sunday').map(verifyOwned);
  assert.deepEqual(owned.map(identity).sort(), beforeRestart);
  assert.equal(await connection.evaluate('state.selected.size'), 0);
  report.gates.applicationRestartPreservesClients = 'PASS';
  report.currentGate = 'exact-stop';
  for (const row of owned) {
    assert.ok(processes().players.some(current => identity(current) === identity(row)), 'Exact process identity changed before stop.');
    const stopped = await connection.evaluate(`window.sunday.instances.kill(${JSON.stringify(row.capability)})`);
    assert.equal(stopped.ok, true);
    await until(() => !processes().players.some(current => identity(current) === identity(row)), 30000, 'Exact process did not exit.');
  }
  owned = [];
  await until(() => Object.values(durable()).every(value => value === 0), 30000, 'Durable ownership did not clear.');
  report.gates.exactStopAndDurableCleanup = 'PASS';
  report.currentGate = 'final-cleanup';
  await connection.evaluate('window.sunday.ui.window.close(); true').catch(() => {});
  connection.socket.close(); connection = null;
  await until(() => processes().sunday.length === 0 && processes().roblox.length === 0, 30000, 'Processes remain after normal close.');
  assert.equal(protectedFingerprint(), protectedBefore);
  report.gates.protectedSessionsUnchanged = 'PASS';
  report.logs = newLogEvidence(initialOffsets); report.gates.newLogs = 'PASS'; report.decision = 'PASS';
  }
} catch {
  report.gates.current = 'BLOCKED';
  report.failure = 'Qualification stopped at the first failed gate. No launch retry or foreign-process action was performed.';
  // Keep diagnostic channels intact; do not stop anything without proven ownership.
  if (connection) {
    report.diagnostics = await connection.evaluate('(async () => (await window.sunday.diag()).diagnostics.sanitizedLaunchDiagnostics)()').catch(() => null);
    // Cancel this test's in-flight plan and await compensation before closing
    // the backend. Do not close it in the middle of process creation.
    await connection.evaluate(`(async () => {
      for (const plan of (await window.sunday.launch.plans()).plans || []) {
        if (['RUNNING','CANCEL_REQUESTED','PREPARED'].includes(plan.state)
          && (plan.operations || []).some(op => ${JSON.stringify(selected)}.includes(String(op.accountId)))) {
          await window.sunday.launch.cancelPlan(plan.planId);
        }
      }
      return true;
    })()`).catch(() => {});
    await until(async () => {
      const d = (await connection.evaluate('window.sunday.diag()')).diagnostics;
      return d.legacyManagedCapacity.inFlightLaunchCount === 0;
    }, 30000, 'In-flight compensation did not finish.').catch(() => {});
    const rows = await connection.evaluate('window.sunday.instances.get()').catch(() => null);
    for (const row of rows?.instances || []) if (row.source === 'sunday' && row.capability && selected.includes(String(row.accountId))) {
      try {
        verifyOwned(row);
        await connection.evaluate(`window.sunday.instances.kill(${JSON.stringify(row.capability)})`).catch(() => {});
      } catch { /* Unproven ownership never grants cleanup authority. */ }
    }
    await connection.evaluate('window.sunday.ui.window.close(); true').catch(() => {}); connection.socket.close();
  }
  try { report.logs = newLogEvidence(initialOffsets); } catch { report.gates.newLogs = 'UNKNOWN'; }
  process.exitCode = 1;
} finally {
  try {
    const final = processes(); report.final = { sunday: final.sunday.length, roblox: final.roblox.length, durable: durable() };
    if (report.final.sunday || report.final.roblox || Object.values(report.final.durable).some(value => value !== 0)) {
      report.gates.finalCleanup = 'BLOCKED'; report.decision = 'BLOCKED'; process.exitCode = 1;
    }
  }
  catch { report.gates.finalObservation = 'UNKNOWN'; report.decision = 'BLOCKED'; process.exitCode = 1; }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ decision: report.decision, gates: report.gates, liveQualifiedCount: report.liveQualifiedCount, report: path.basename(reportPath) }));
}
