import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

if (process.env.LEGACY_COMPAT !== '1') {
  console.error('Refusing live Roblox test: set LEGACY_COMPAT=1 explicitly.');
  process.exit(2);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const releaseDirectory = String(process.env.SUNDAY_LEGACY_RELEASE_DIR || '').trim()
  ? path.resolve(process.env.SUNDAY_LEGACY_RELEASE_DIR)
  : '';
const requirePackaged = process.env.SUNDAY_LEGACY_REQUIRE_PACKAGED === '1';
const runtimeRoot = releaseDirectory || root;
const hostScript = path.join(runtimeRoot, 'src', 'main', 'tauri-node-host.js');
const nodeExecutable = releaseDirectory ? path.join(runtimeRoot, 'node.exe') : process.execPath;
const launcherExecutable = releaseDirectory ? path.join(runtimeRoot, 'Sunday.exe') : '';
const userData = process.env.SUNDAY_USER_DATA
  ? path.resolve(process.env.SUNDAY_USER_DATA)
  : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'com.sadinkai.sundaylauncher');
const requestedAccountIds = String(process.env.SUNDAY_LEGACY_TEST_ACCOUNT_IDS || '')
  .split(',').map(value => value.trim()).filter(Boolean);
const placeId = String(process.env.SUNDAY_LEGACY_TEST_PLACE_ID || '').trim();
const twoOnly = process.env.SUNDAY_LEGACY_TWO_ONLY === '1';
const stableWaitMs = Math.max(5000, Number(process.env.SUNDAY_LIVE_WAIT_MS) || 5000);
const cloneRoot = path.join(userData, 'legacy-instances');

const pending = new Map();
const ownedCapabilities = new Map();
const sensitiveValues = new Set([userData, releaseDirectory, ...requestedAccountIds].filter(Boolean));
let sequence = 0;
let child = null;
let rl = null;
let exited = false;
let processProvider = null;

const report = {
  schemaVersion: 2,
  mode: 'LEGACY_COMPAT',
  qualified: false,
  startedAt: new Date().toISOString(),
  sundayVersion: packageJson.version,
  runtime: null,
  preExistingProcesses: { checked: false, count: null, noneManaged: false },
  selectedAccountCount: 0,
  singleAccount: { passed: false },
  twoAccount: { passed: false },
  closeOneKeepOne: { passed: false },
  restartOneKeepOne: { passed: false },
  keeper: { passed: false },
  threeAccount: { passed: false },
  orderedTeardown: { passed: false },
  cloneCleanup: { passed: false },
  ownership: { passed: false },
  failures: [],
};

function fileEvidence(filePath, name) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error(`${name} is not a regular file in the selected runtime.`);
  return {
    name,
    bytes: stat.size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'),
  };
}

function runtimeEvidence() {
  if (requirePackaged && !releaseDirectory) {
    throw new Error('Release qualification requires SUNDAY_LEGACY_RELEASE_DIR.');
  }
  if (!fs.existsSync(hostScript)) throw new Error('The selected SUNDAY backend host is missing.');
  const evidence = {
    kind: releaseDirectory ? 'packaged-release-tree' : 'development-source',
    backendHost: fileEvidence(hostScript, 'src/main/tauri-node-host.js'),
  };
  if (releaseDirectory) {
    if (!fs.existsSync(launcherExecutable) || !fs.existsSync(nodeExecutable)) {
      throw new Error('The packaged release tree must contain Sunday.exe and node.exe.');
    }
    evidence.launcher = fileEvidence(launcherExecutable, 'Sunday.exe');
    evidence.node = fileEvidence(nodeExecutable, 'node.exe');
  }
  return evidence;
}

function sanitizedMessage(value) {
  let text = String(value && value.message || value || 'Unknown qualification failure.');
  for (const sensitive of sensitiveValues) {
    if (sensitive) text = text.split(sensitive).join('[redacted]');
  }
  text = text.replace(/_\|WARNING:-DO-NOT-SHARE-[^\s"']+/gi, '[credential]');
  return text.slice(0, 500);
}

function startBackend() {
  child = spawn(nodeExecutable, [hostScript, packageJson.version, userData], {
    cwd: runtimeRoot,
    env: { ...process.env, LEGACY_COMPAT: '1', SUNDAY_LEGACY_TEST_MODE: '1' },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
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
}

function call(command, payload = {}, timeoutMs = 240000) {
  if (!child || exited) return Promise.reject(new Error('SUNDAY Launcher backend is not running.'));
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

function operations(response) {
  return response && response.plan && Array.isArray(response.plan.operations) ? response.plan.operations : [];
}

function responsiveOwnedInstance(instances, capability) {
  return instances.find(instance => instance.capability === capability
    && instance.source === 'sunday'
    && instance.controllable === true
    && instance.status === 'running');
}

async function waitForCapabilities(capabilities, timeoutMs = 45000) {
  return waitFor(async () => {
    const snapshot = await call('instances_get');
    const instances = snapshot.instances || [];
    return capabilities.every(capability => responsiveOwnedInstance(instances, capability)) ? instances : null;
  }, timeoutMs, 'responsive SUNDAY-owned Roblox clients');
}

async function waitForCapabilityAbsence(capability, timeoutMs = 30000) {
  return waitFor(async () => {
    const snapshot = await call('instances_get');
    return !(snapshot.instances || []).some(instance => instance.capability === capability);
  }, timeoutMs, 'the exact stopped capability to disappear');
}

function existingCloneEntries() {
  if (!fs.existsSync(cloneRoot)) return [];
  return fs.readdirSync(cloneRoot, { withFileTypes: true })
    .filter(entry => /^instance-\d+$/.test(entry.name))
    .map(entry => entry.name)
    .sort();
}

async function waitForCloneCleanup(timeoutMs = 45000) {
  return waitFor(() => existingCloneEntries().length === 0, timeoutMs, 'legacy clone directories to be removed');
}

async function launchAccounts(accountIds) {
  const startedAt = Date.now();
  const response = await call('launch_accounts', { accountIds, placeId }, 300000);
  const rows = operations(response);
  for (const row of rows) {
    if (row.capability) {
      sensitiveValues.add(row.capability);
      ownedCapabilities.set(row.capability, { pid: row.pid, instanceId: row.instanceId || row.environmentId });
    }
  }
  if (!response.ok || rows.length !== accountIds.length || rows.some(row => row.state !== 'RUNNING' || !row.capability || !row.pid)) {
    throw new Error(response.error || `Launch did not produce ${accountIds.length} stable running operations.`);
  }
  const instances = await waitForCapabilities(rows.map(row => row.capability));
  return {
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
  await waitForCapabilityAbsence(capability);
  return result;
}

async function cleanupOwned() {
  for (const capability of Array.from(ownedCapabilities.keys())) {
    try {
      await endCapability(capability);
    } catch (error) {
      report.failures.push(`Capability-bound cleanup failed: ${sanitizedMessage(error)}`);
    }
  }
}

async function verifyOwnershipDiagnostics() {
  const response = await call('diag_get');
  const legacy = response && response.diagnostics && response.diagnostics.legacyCompatibility;
  if (!legacy || legacy.mode !== 'LEGACY_COMPAT') throw new Error('Legacy adapter diagnostics are unavailable.');
  if ((legacy.externalAtStartup || []).length !== 0) {
    throw new Error('A pre-existing Roblox process was observed by the legacy adapter.');
  }
  if ((legacy.crossProcessActions || []).length !== 0) {
    throw new Error('The legacy adapter recorded an action against a process outside SUNDAY ownership.');
  }
  return legacy;
}

let fatal = null;
try {
  report.runtime = runtimeEvidence();

  const runtimeRequire = createRequire(hostScript);
  const nativeProcessApi = runtimeRequire('./native.js');
  if (!nativeProcessApi.init()) {
    throw new Error('Packaged native process inspection is unavailable on the qualification host.');
  }
  processProvider = runtimeRequire('./processes.js');
  const preExisting = await processProvider.list();
  report.preExistingProcesses = { checked: true, count: preExisting.length, noneManaged: preExisting.length === 0 };
  if (preExisting.length) {
    throw new Error(`Refusing live qualification because ${preExisting.length} Roblox process(es) existed before SUNDAY started.`);
  }

  startBackend();
  const status = await call('app_status');
  if (!status.ok || !status.isolationAdapter || status.isolationAdapter.mode !== 'LEGACY_COMPAT') {
    throw new Error('Backend did not enter explicit LEGACY_COMPAT mode.');
  }
  if (!status.robloxFound) throw new Error('Roblox Player was not detected.');
  await verifyOwnershipDiagnostics();

  const accountResult = await call('accounts_list');
  const available = Array.isArray(accountResult.accounts) ? accountResult.accounts : [];
  const selected = requestedAccountIds.length
    ? requestedAccountIds.map(id => available.find(account => String(account.id) === id)).filter(Boolean)
    : available.slice(0, 3);
  if (selected.length < 2) throw new Error(`Two saved authorized Roblox test accounts are required; found ${selected.length}.`);
  const ids = selected.slice(0, 3).map(account => String(account.id));
  for (const id of ids) sensitiveValues.add(id);
  report.selectedAccountCount = ids.length;

  const single = await launchAccounts([ids[0]]);
  await sleep(stableWaitMs);
  await waitForCapabilities([single.rows[0].capability]);
  report.singleAccount = {
    passed: true,
    pid: single.pids[0],
    instanceId: single.instanceIds[0],
    responsiveAfterMs: stableWaitMs,
    durationMs: single.durationMs,
  };
  await endCapability(single.rows[0].capability);
  await waitForCloneCleanup();

  const two = await launchAccounts(ids.slice(0, 2));
  if (twoOnly && JSON.stringify(two.instanceIds) !== JSON.stringify(['instance-1', 'instance-2'])) {
    throw new Error(`Two-account-only evidence requires instance-1 and instance-2; received ${two.instanceIds.join(', ')}.`);
  }
  await sleep(stableWaitMs);
  await waitForCapabilities(two.rows.map(row => row.capability));
  report.twoAccount = {
    passed: true,
    pids: two.pids,
    instanceIds: two.instanceIds,
    durationMs: two.durationMs,
    responsiveAfterMs: stableWaitMs,
  };

  const [first, second] = two.rows;
  if (twoOnly) {
    report.restartOneKeepOne = { passed: false, skipped: true, reason: 'Two-account-only evidence run.' };
    report.closeOneKeepOne = { passed: false, skipped: true, reason: 'Two-account-only evidence run.' };
    report.keeper = { passed: false, skipped: true, reason: 'Two-account-only evidence run.' };
    report.threeAccount = { passed: false, blocked: true, reason: 'Instance-3 was explicitly excluded.' };
    report.orderedTeardown = { passed: false, skipped: true, reason: 'Two-account-only evidence run.' };
  } else {
    await endCapability(first.capability);
    await sleep(stableWaitMs);
    await waitForCapabilities([second.capability]);
    report.closeOneKeepOne = {
      passed: true,
      closedPid: first.pid,
      survivingPid: second.pid,
      siblingResponsiveAfterMs: stableWaitMs,
    };

    const relaunched = await launchAccounts([ids[0]]);
    const relaunchedRow = relaunched.rows[0];
    if (relaunchedRow.capability === first.capability) {
      throw new Error('Relaunch reused a revoked process capability.');
    }
    await sleep(stableWaitMs);
    await waitForCapabilities([relaunchedRow.capability, second.capability]);
    report.restartOneKeepOne = {
      passed: true,
      priorInstanceId: first.instanceId,
      restartedInstanceId: relaunchedRow.instanceId,
      previousPid: first.pid,
      restartedPid: relaunchedRow.pid,
      siblingPid: second.pid,
      capabilityRotated: true,
      bothResponsiveAfterMs: stableWaitMs,
    };

    const keeperCapability = relaunchedRow.capability;
    const armed = await call('keeper_arm', { records: [{ accountId: ids[0], placeId }] });
    if (!armed.ok) throw new Error(armed.error || 'Keeper could not be armed.');
    await waitFor(async () => {
      const state = await call('keeper_status');
      return (state.records || []).some(record => record.accountId === ids[0] && record.capability === keeperCapability);
    }, 30000, 'keeper to bind the exact owned capability');
    const simulated = await call('legacy_test_crash_owned', { capability: keeperCapability });
    if (!simulated.ok || !simulated.keeper || !simulated.keeper.scheduled) {
      throw new Error(simulated.error || 'Keeper crash simulation was not scheduled.');
    }
    ownedCapabilities.delete(keeperCapability);
    const keeperReplacement = await waitFor(async () => {
      const state = await call('keeper_status');
      const record = (state.records || []).find(item => item.accountId === ids[0]);
      return record && record.state === 'running' && record.capability && record.capability !== keeperCapability ? record : null;
    }, 180000, 'keeper relaunch');
    sensitiveValues.add(keeperReplacement.capability);
    ownedCapabilities.set(keeperReplacement.capability, { pid: keeperReplacement.pid, instanceId: keeperReplacement.instanceId });
    await waitForCapabilities([keeperReplacement.capability, second.capability]);
    report.keeper = {
      passed: true,
      capabilityRotated: true,
      siblingPid: second.pid,
      siblingResponsive: true,
    };

    await call('keeper_disarm_all');
    await cleanupOwned();
    await waitForCloneCleanup();

    if (ids.length < 3) {
      report.threeAccount = {
        passed: false,
        blocked: true,
        reason: `Three distinct saved authorized Roblox test accounts are required; found ${ids.length}.`,
      };
    } else {
      const three = await launchAccounts(ids);
      await sleep(stableWaitMs);
      await waitForCapabilities(three.rows.map(row => row.capability));
      report.threeAccount = {
        passed: true,
        pids: three.pids,
        instanceIds: three.instanceIds,
        durationMs: three.durationMs,
        responsiveAfterMs: stableWaitMs,
      };

      const teardownSteps = [];
      for (let index = 0; index < three.rows.length; index += 1) {
        const row = three.rows[index];
        await endCapability(row.capability);
        const remaining = three.rows.slice(index + 1).map(item => item.capability);
        if (remaining.length) await waitForCapabilities(remaining);
        teardownSteps.push({ order: index + 1, stoppedPid: row.pid, remainingResponsive: remaining.length });
      }
      await waitForCloneCleanup();
      report.orderedTeardown = { passed: true, steps: teardownSteps };
    }
  }

  await verifyOwnershipDiagnostics();
  report.ownership = {
    passed: true,
    preExistingCount: 0,
    externalActions: 0,
    processActions: 'capability-bound',
  };
} catch (error) {
  fatal = error;
  report.failures.push(sanitizedMessage(error));
} finally {
  if (child && !exited) {
    await cleanupOwned();
    try { await call('keeper_disarm_all'); } catch (_) {}
  }
  try {
    await waitForCloneCleanup();
    report.cloneCleanup = { passed: true, remaining: 0 };
  } catch (error) {
    report.cloneCleanup = { passed: false, remaining: existingCloneEntries().length };
    report.failures.push(sanitizedMessage(error));
  }
  if (processProvider) {
    const remainingProcesses = await processProvider.list();
    report.ownership.remainingProcessCount = remainingProcesses.length;
    if (remainingProcesses.length) {
      report.ownership.passed = false;
      report.failures.push('Roblox processes remained after capability-bound teardown; no broad cleanup was attempted.');
    }
  }

  report.completedAt = new Date().toISOString();
  report.qualified = !fatal
    && report.failures.length === 0
    && report.preExistingProcesses.noneManaged
    && report.singleAccount.passed
    && report.twoAccount.passed
    && report.cloneCleanup.passed
    && report.ownership.passed
    && (twoOnly || (report.closeOneKeepOne.passed
      && report.restartOneKeepOne.passed
      && report.keeper.passed
      && report.threeAccount.passed
      && report.orderedTeardown.passed));
  report.passed = report.qualified;

  const outputDirectory = path.join(root, 'artifacts');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, 'phase7-legacy-multiclient-result.json');
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
  if (child && !exited) {
    try { await call('shutdown', {}, 10000); } catch (_) {}
    if (!exited) child.kill();
  }
  if (rl) rl.close();
  console.log(JSON.stringify({ passed: report.passed, outputPath, failures: report.failures }, null, 2));
}

if (fatal) throw fatal;
if (!report.passed) process.exitCode = 1;
