import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const processes = require('../src/main/processes');
const { MAX_LEGACY_MANAGED_CLIENTS } = require('../src/main/legacy-capacity');

if (process.env.LEGACY_COMPAT !== '1') {
  console.error('Refusing live Roblox test: set LEGACY_COMPAT=1 explicitly.');
  process.exit(2);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const hostScript = path.join(root, 'src', 'main', 'tauri-node-host.js');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const userData = process.env.SUNDAY_USER_DATA
  ? path.resolve(process.env.SUNDAY_USER_DATA)
  : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'com.sadinkai.sundaylauncher');
const requestedAccountIds = String(process.env.SUNDAY_LEGACY_TEST_ACCOUNT_IDS || '')
  .split(',').map(value => value.trim()).filter(Boolean);
const placeId = String(process.env.SUNDAY_LEGACY_TEST_PLACE_ID || '').trim();
const twoOnly = process.env.SUNDAY_LEGACY_TWO_ONLY === '1';
const stableWaitMs = Math.max(5000, Number(process.env.SUNDAY_LIVE_WAIT_MS) || 5000);

const child = spawn(process.execPath, [hostScript, packageJson.version, userData], {
  cwd: root,
  env: { ...process.env, LEGACY_COMPAT: '1', SUNDAY_LEGACY_TEST_MODE: '1' },
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'inherit'],
});

const pending = new Map();
let sequence = 0;
let exited = false;
const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch (_) { return; }
  if (message.id == null) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  clearTimeout(waiter.timer);
  if (message.ok) waiter.resolve(message.result);
  else waiter.reject(new Error(message.error || 'Backend request failed.'));
});
child.on('exit', code => {
  exited = true;
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(`SUNDAY Launcher backend exited unexpectedly (${code}).`));
  }
  pending.clear();
});

function call(command, payload = {}, timeoutMs = 240000) {
  if (exited) return Promise.reject(new Error('SUNDAY Launcher backend is not running.'));
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${command} timed out.`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, command, payload }) + '\n');
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

const ownedCapabilities = new Set();
const report = {
  schemaVersion: 1,
  mode: 'LEGACY_COMPAT',
  qualified: false,
  startedAt: new Date().toISOString(),
  userData,
  sundayVersion: packageJson.version,
  robloxVersion: null,
  accountIds: [],
  twoAccount: { passed: false },
  closeOneKeepOne: { passed: false },
  restartOneKeepOne: { passed: false },
  keeper: { passed: false },
  sixAccount: { passed: false },
  failures: [],
};

function operations(response) {
  return response && response.plan && Array.isArray(response.plan.operations) ? response.plan.operations : [];
}

async function waitForCapabilities(capabilities, timeoutMs = 30000) {
  return waitFor(async () => {
    const snapshot = await call('instances_get');
    const instances = snapshot.instances || [];
    return capabilities.every(capability => instances.some(instance => instance.capability === capability && instance.source === 'sunday'))
      ? instances : null;
  }, timeoutMs, 'SUNDAY-owned Roblox clients to remain observable');
}

async function launchAccounts(accountIds) {
  const startedAt = Date.now();
  const response = await call('launch_accounts', { accountIds, placeId }, 300000);
  const rows = operations(response);
  if (!response.ok || rows.length !== accountIds.length || rows.some(row => row.state !== 'RUNNING' || !row.capability || !row.pid)) {
    throw new Error(response.error || `Launch did not produce ${accountIds.length} stable running operations.`);
  }
  for (const row of rows) ownedCapabilities.add(row.capability);
  const instances = await waitForCapabilities(rows.map(row => row.capability));
  return {
    response,
    rows,
    instances,
    durationMs: Date.now() - startedAt,
    pids: rows.map(row => row.pid),
    instanceIds: rows.map(row => row.instanceId || row.environmentId),
  };
}

async function endCapability(capability) {
  const result = await call('instance_kill', { capability });
  if (!result.ok) throw new Error(result.error || 'Exact owned client stop failed.');
  ownedCapabilities.delete(capability);
  return result;
}

async function cleanupOwned() {
  for (const capability of Array.from(ownedCapabilities)) {
    try { await endCapability(capability); } catch (error) { report.failures.push(`Cleanup ${capability.slice(0, 8)}: ${error.message}`); }
  }
}

let fatal = null;
try {
  const baseline = await processes.list();
  if (baseline.length) {
    throw new Error('A Roblox client was already running; qualification refuses to adopt or terminate it.');
  }
  const status = await call('app_status');
  if (!status.ok || !status.isolationAdapter || status.isolationAdapter.mode !== 'LEGACY_COMPAT') {
    throw new Error('Backend did not enter explicit LEGACY_COMPAT mode.');
  }
  if (!status.robloxFound) throw new Error('Roblox Player was not detected.');
  report.robloxVersion = status.version;
  report.robloxPath = status.playerPath;

  const accountResult = await call('accounts_list');
  const available = Array.isArray(accountResult.accounts) ? accountResult.accounts : [];
  const selected = requestedAccountIds.length
    ? requestedAccountIds.map(id => available.find(account => String(account.id) === id)).filter(Boolean)
    : available.slice(0, MAX_LEGACY_MANAGED_CLIENTS);
  if (selected.length < 2) throw new Error(`Two saved Roblox accounts are required; found ${selected.length}.`);
  const ids = selected.slice(0, MAX_LEGACY_MANAGED_CLIENTS).map(account => String(account.id));
  if (!twoOnly && ids.length !== MAX_LEGACY_MANAGED_CLIENTS) {
    throw new Error(`${MAX_LEGACY_MANAGED_CLIENTS} distinct saved Roblox accounts are required; found ${ids.length}.`);
  }
  report.accountIds = ids;

  const two = await launchAccounts(ids.slice(0, 2));
  if (twoOnly && JSON.stringify(two.instanceIds) !== JSON.stringify(['instance-1', 'instance-2'])) {
    throw new Error(`Two-account-only evidence requires instance-1 and instance-2; received ${two.instanceIds.join(', ')}.`);
  }
  report.twoAccount = {
    passed: true,
    pids: two.pids,
    instanceIds: two.instanceIds,
    durationMs: two.durationMs,
    bothRemainedAlive: true,
  };

  const [first, second] = two.rows;
  if (twoOnly) {
    await sleep(stableWaitMs);
    await waitForCapabilities([first.capability, second.capability]);
    report.twoAccount.stableAfterMs = stableWaitMs;
    report.restartOneKeepOne = { passed: false, skipped: true, reason: 'Two-account-only evidence run.' };
    report.closeOneKeepOne = { passed: false, skipped: true, reason: 'Two-account-only evidence run.' };
    report.keeper = { passed: false, skipped: true, reason: 'Two-account-only evidence run.' };
    report.sixAccount = { passed: false, blocked: true, reason: 'The full six-client gate was explicitly excluded.' };
  } else {
  const restarted = await call('instance_restart', { capability: first.capability }, 180000);
  const restartedOperation = restarted && restarted.operation;
  if (!restarted.ok || !restartedOperation || !restartedOperation.capability || restartedOperation.pid === first.pid) {
    throw new Error(restarted.error || 'Restart did not produce a new exact owned process.');
  }
  ownedCapabilities.delete(first.capability);
  ownedCapabilities.add(restartedOperation.capability);
  await waitForCapabilities([restartedOperation.capability, second.capability]);
  report.restartOneKeepOne = {
    passed: true,
    previousPid: first.pid,
    restartedPid: restartedOperation.pid,
    siblingPid: second.pid,
    siblingRemainedAlive: true,
  };

  await endCapability(restartedOperation.capability);
  await waitForCapabilities([second.capability]);
  report.closeOneKeepOne = {
    passed: true,
    closedPid: restartedOperation.pid,
    survivingPid: second.pid,
    siblingRemainedAlive: true,
  };

  const relaunchedA = await launchAccounts([ids[0]]);
  const keeperCapability = relaunchedA.rows[0].capability;
  const armed = await call('keeper_arm', { records: [{ accountId: ids[0], placeId }] });
  if (!armed.ok) throw new Error(armed.error || 'Keeper could not be armed.');
  await waitFor(async () => {
    const state = await call('keeper_status');
    return (state.records || []).some(record => record.accountId === ids[0] && record.capability === keeperCapability);
  }, 30000, 'keeper to bind the exact owned capability');
  const simulated = await call('legacy_test_crash_owned', { capability: keeperCapability });
  if (!simulated.ok || !simulated.keeper || !simulated.keeper.scheduled) throw new Error(simulated.error || 'Keeper crash simulation was not scheduled.');
  ownedCapabilities.delete(keeperCapability);
  const keeperReplacement = await waitFor(async () => {
    const state = await call('keeper_status');
    const record = (state.records || []).find(item => item.accountId === ids[0]);
    return record && record.state === 'running' && record.capability && record.capability !== keeperCapability ? record : null;
  }, 180000, 'keeper relaunch');
  ownedCapabilities.add(keeperReplacement.capability);
  await waitForCapabilities([keeperReplacement.capability, second.capability]);
  report.keeper = {
    passed: true,
    previousCapability: keeperCapability.slice(0, 12),
    replacementCapability: keeperReplacement.capability.slice(0, 12),
    siblingPid: second.pid,
  };

  await cleanupOwned();
  await call('keeper_disarm_all');

  if (ids.length < MAX_LEGACY_MANAGED_CLIENTS) {
    report.sixAccount = {
      passed: false,
      blocked: true,
      reason: `${MAX_LEGACY_MANAGED_CLIENTS} distinct saved Roblox accounts are required; found ${ids.length}.`,
    };
  } else {
    const six = await launchAccounts(ids);
    report.sixAccount = {
      passed: true,
      pids: six.pids,
      instanceIds: six.instanceIds,
      durationMs: six.durationMs,
      allRemainedAlive: true,
    };
    await sleep(5000);
    await waitForCapabilities(six.rows.map(row => row.capability));
  }
  }
} catch (error) {
  fatal = error;
  report.failures.push(error.message);
} finally {
  await cleanupOwned();
  report.completedAt = new Date().toISOString();
  report.passed = !fatal && report.failures.length === 0 && report.twoAccount.passed && (twoOnly
    || (report.closeOneKeepOne.passed
      && report.restartOneKeepOne.passed
      && report.keeper.passed
      && report.sixAccount.passed));
  const outputDirectory = path.join(root, 'artifacts');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, 'phase7-legacy-multiclient-result.json');
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  try { await call('shutdown', {}, 10000); } catch (_) {}
  if (!exited) child.kill();
  console.log(JSON.stringify({ passed: report.passed, outputPath, failures: report.failures }, null, 2));
}

if (fatal) throw fatal;
if (!report.passed) process.exitCode = 1;
