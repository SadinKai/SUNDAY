import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

if (process.env.LEGACY_COMPAT !== '1') {
  console.error('Refusing live Roblox test: set LEGACY_COMPAT=1 explicitly.');
  process.exit(2);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const userData = process.env.SUNDAY_USER_DATA
  ? path.resolve(process.env.SUNDAY_USER_DATA)
  : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'com.sadinkai.sundaylauncher');
const child = spawn(process.execPath, [path.join(root, 'src', 'main', 'tauri-node-host.js'), packageJson.version, userData], {
  cwd: root,
  env: { ...process.env, LEGACY_COMPAT: '1' },
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'inherit'],
});
const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const pending = new Map();
let nextId = 0;
rl.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch (_) { return; }
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  clearTimeout(waiter.timer);
  if (message.ok) waiter.resolve(message.result);
  else waiter.reject(new Error(message.error || 'Backend request failed.'));
});
child.on('exit', code => {
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(`SUNDAY Launcher backend exited unexpectedly (${code}).`));
  }
  pending.clear();
});

function call(command, payload = {}, timeoutMs = 180000) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${command} timed out.`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, command, payload }) + '\n');
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stableWaitMs = Math.max(5000, Number(process.env.SUNDAY_LIVE_WAIT_MS) || 5000);
const report = {
  schemaVersion: 1,
  mode: 'LEGACY_COMPAT',
  qualified: false,
  sundayVersion: packageJson.version,
  startedAt: new Date().toISOString(),
  passed: false,
  failure: null,
};
let capability = '';
try {
  const status = await call('app_status');
  if (!status.robloxFound) throw new Error('Roblox Player was not detected.');
  report.robloxVersion = status.version;
  report.robloxPath = status.playerPath;
  const listed = await call('accounts_list');
  const account = listed.accounts && listed.accounts[0];
  if (!account) throw new Error('One saved Roblox account is required.');
  report.accountId = account.id;
  const launched = await call('launch_accounts', { accountIds: [account.id], placeId: '' }, 240000);
  const operation = launched && launched.plan && launched.plan.operations && launched.plan.operations[0];
  if (!launched.ok || !operation || operation.state !== 'RUNNING' || !operation.capability || !operation.pid) {
    throw new Error(launched.error || (operation && operation.reason) || 'Instance-1 did not reach stable running.');
  }
  capability = operation.capability;
  if (operation.instanceId !== 'instance-1') throw new Error(`Expected instance-1, received ${operation.instanceId || 'unknown'}.`);
  await sleep(stableWaitMs);
  const observed = await call('instances_get');
  const row = (observed.instances || []).find(instance => instance.capability === capability && instance.pid === operation.pid);
  if (!row || row.source !== 'sunday') throw new Error('Instance-1 was not still represented as a SUNDAY-owned live client.');
  report.instanceId = operation.instanceId;
  report.pid = operation.pid;
  report.executablePath = row.executablePath;
  report.stableAfterMs = stableWaitMs;
  report.passed = true;
} catch (error) {
  report.failure = error.message;
} finally {
  if (capability) {
    try {
      const stopped = await call('instance_kill', { capability }, 30000);
      report.cleanupConfirmed = !!stopped.ok;
      if (!stopped.ok && !report.failure) report.failure = stopped.error || 'Exact cleanup failed.';
    } catch (error) {
      report.cleanupConfirmed = false;
      report.failure = report.failure || error.message;
    }
  }
  report.completedAt = new Date().toISOString();
  report.passed = report.passed && report.cleanupConfirmed === true;
  const outputDirectory = path.join(root, 'artifacts');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, 'phase7-legacy-singleclient-result.json');
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  try { await call('shutdown', {}, 10000); } catch (_) {}
  console.log(JSON.stringify({ passed: report.passed, outputPath, failure: report.failure }, null, 2));
}

if (!report.passed) process.exitCode = 1;
