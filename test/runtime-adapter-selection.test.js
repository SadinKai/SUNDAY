'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const store = require('../src/main/store');
const { resolveLegacyCompatibility } = require('../src/main/tauri-backend');

const root = path.resolve(__dirname, '..');
const host = path.join(root, 'src', 'main', 'tauri-node-host.js');

function request(child, messages, id, command, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      messages.delete(id);
      reject(new Error(`Timed out waiting for backend command ${command}`));
    }, 15000);
    messages.set(id, envelope => {
      clearTimeout(timer);
      if (envelope.ok === true) resolve(envelope.result);
      else reject(new Error(envelope.error || `Backend command ${command} failed`));
    });
    child.stdin.write(JSON.stringify({ id, command, payload: payload || {} }) + '\n');
  });
}

function startBackend(userData, legacyCompatValue) {
  const environment = Object.assign({}, process.env);
  delete environment.LEGACY_COMPAT;
  if (legacyCompatValue !== undefined) environment.LEGACY_COMPAT = legacyCompatValue;
  const child = spawn(process.execPath, [host, 'runtime-selector-test', userData, '', '', ''], {
    cwd: root,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const messages = new Map();
  const stderr = [];
  child.stderr.on('data', chunk => stderr.push(chunk.toString('utf8')));
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    let envelope;
    try { envelope = JSON.parse(line); } catch (_) { return; }
    if (envelope && envelope.id != null && messages.has(envelope.id)) {
      const settle = messages.get(envelope.id);
      messages.delete(envelope.id);
      settle(envelope);
    }
  });
  return { child, messages, stderr, lines };
}

async function shutdownBackend(runtime, id) {
  const { child, messages, stderr, lines } = runtime;
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Backend did not exit after shutdown')), 5000);
    child.once('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Backend exited with ${code}: ${stderr.join('')}`));
    });
  });
  await request(child, messages, id, 'shutdown');
  await exited;
  lines.close();
}

test('effective legacy compatibility defaults on when missing and preserves explicit choices', () => {
  assert.deepEqual(resolveLegacyCompatibility({}, {}), {
    enabled: true,
    environmentEnabled: false,
    environmentValue: 'ABSENT',
    settingEnabled: true,
    activationSource: 'settings',
    selectorEnvironment: { LEGACY_COMPAT: '1' },
  });
  for (const value of ['0', 'true']) {
    const result = resolveLegacyCompatibility({ multiInstanceMode: false }, { LEGACY_COMPAT: value });
    assert.equal(result.enabled, false);
    assert.equal(result.environmentValue, value);
    assert.equal(result.activationSource, 'none');
  }
  assert.equal(resolveLegacyCompatibility({}, { LEGACY_COMPAT: '1' }).activationSource, 'environment');
  assert.equal(resolveLegacyCompatibility({ multiInstanceMode: true }, {}).activationSource, 'settings');
});

test('actual backend host selects the legacy adapter when LEGACY_COMPAT=1', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-runtime-selector-'));
  const runtime = startBackend(userData, '1');
  const { child, messages, lines } = runtime;

  try {
    const diagnostic = await request(child, messages, 1, 'adapter_selection_status');
    assert.deepEqual(diagnostic.adapterSelection, {
      legacyCompatEnabled: true,
      legacyCompatEnvironmentValue: '1',
      legacyCompatEnvironmentEnabled: true,
      legacyCompatSettingEnabled: true,
      legacyCompatActivationSource: 'environment',
      selectedAdapter: 'LegacyRobloxIsolationAdapter',
      isolationState: 'LEGACY_COMPAT',
      reason: "MULTI-INSTANCE MODE: Enabled. Uses SUNDAY's legacy Roblox compatibility path. This is not vendor-supported isolation.",
    });

    const status = await request(child, messages, 2, 'app_status');
    assert.deepEqual(status.adapterSelection, diagnostic.adapterSelection);
    assert.equal(status.isolationAdapter.implementation, 'LegacyRobloxIsolationAdapter');
    assert.equal(status.isolationAdapter.mode, 'LEGACY_COMPAT');

    await shutdownBackend(runtime, 3);
  } finally {
    if (child.exitCode == null) child.kill();
    try { lines.close(); } catch (_) {}
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('actual backend startup reads the persisted multi-instance preference and disabling persists', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-runtime-setting-'));
  store.configure(userData, null, { assertOwner: () => true });
  assert.equal(store.getSettings().multiInstanceMode, true);
  store.close();

  let runtime = startBackend(userData);
  try {
    const enabled = await request(runtime.child, runtime.messages, 1, 'app_status');
    assert.equal(enabled.adapterSelection.legacyCompatEnabled, true);
    assert.equal(enabled.adapterSelection.legacyCompatSettingEnabled, true);
    assert.equal(enabled.adapterSelection.legacyCompatEnvironmentValue, 'ABSENT');
    assert.equal(enabled.adapterSelection.legacyCompatActivationSource, 'settings');
    assert.equal(enabled.adapterSelection.selectedAdapter, 'LegacyRobloxIsolationAdapter');

    const saved = await request(runtime.child, runtime.messages, 2, 'settings_save', {
      partial: { multiInstanceMode: false },
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.settings.multiInstanceMode, false);
    assert.equal(saved.restartRequired, true);
    const stillActive = await request(runtime.child, runtime.messages, 3, 'app_status');
    assert.equal(stillActive.adapterSelection.legacyCompatEnabled, true, 'adapter selection is immutable until restart');
    await shutdownBackend(runtime, 4);

    runtime = startBackend(userData);
    const disabled = await request(runtime.child, runtime.messages, 5, 'app_status');
    assert.equal(disabled.adapterSelection.legacyCompatEnabled, false);
    assert.equal(disabled.adapterSelection.legacyCompatSettingEnabled, false);
    assert.equal(disabled.adapterSelection.legacyCompatActivationSource, 'none');
    assert.equal(disabled.adapterSelection.selectedAdapter, 'UnavailableRobloxIsolationAdapter');
    assert.equal(disabled.adapterSelection.isolationState, 'UNAVAILABLE');
    const diagnostics = await request(runtime.child, runtime.messages, 6, 'diag_get');
    const sanitized = diagnostics.diagnostics.sanitizedLaunchDiagnostics;
    assert.equal(sanitized.adapter.selected, 'UnavailableRobloxIsolationAdapter');
    assert.equal(sanitized.adapter.multiInstanceEnabled, false);
    assert.equal(typeof sanitized.roblox.detected, 'boolean');
    const serialized = JSON.stringify(sanitized);
    assert.doesNotMatch(serialized, /runtime-setting-|sunday-state\.sqlite3|capability\":\"|roblox-player:|gameinfo:/i);
    await shutdownBackend(runtime, 7);
  } finally {
    if (runtime && runtime.child.exitCode == null) runtime.child.kill();
    if (runtime) try { runtime.lines.close(); } catch (_) {}
    try { store.close(); } catch (_) {}
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
