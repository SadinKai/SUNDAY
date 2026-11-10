'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const vm = require('vm');
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

test('multi-instance defaults survive older settings and malformed preferences without overriding an explicit opt-out', () => {
  for (const value of [undefined, null, '', 'false', 'true', 0, 1, {}, []]) {
    const settings = { pollIntervalMs: 3000, multiInstanceMode: value };
    assert.equal(store.normalizeSettings(settings).multiInstanceMode, true);
    assert.equal(resolveLegacyCompatibility(settings, {}).enabled, true);
    assert.equal(resolveLegacyCompatibility(settings, {}).settingEnabled, true);
  }
  assert.equal(store.normalizeSettings({ pollIntervalMs: 3000 }).multiInstanceMode, true);
  assert.equal(store.normalizeSettings({ multiInstanceMode: false }).multiInstanceMode, false);
  assert.equal(resolveLegacyCompatibility({ multiInstanceMode: false }, {}).enabled, false);

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-default-preference-'));
  try {
    store.configure(userData, null, { assertOwner: () => true });
    store.database().put('documents', 'settings.json', { pollIntervalMs: 3000 });
    assert.equal(store.getSettings().multiInstanceMode, true);
    assert.equal(store.saveSettings({ historyLimit: 100 }).multiInstanceMode, true);
    assert.equal(store.saveSettings({ multiInstanceMode: false }).multiInstanceMode, false);
    store.close();
    store.configure(userData, null, { assertOwner: () => true });
    assert.equal(store.getSettings().multiInstanceMode, false);
    assert.equal(store.resetSettings().multiInstanceMode, true);
  } finally {
    store.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('older profiles automatically receive the launch defaults once without changing unrelated state', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-upgrade-defaults-'));
  try {
    store.configure(userData, null, { assertOwner: () => true });
    const old = {
      multiInstanceMode: false, autoDetect: false,
      robloxPath: 'old-player-path', robloxInstallationId: 'old-installation',
      pollIntervalMs: 3000, historyLimit: 123, futureSetting: { preserved: true },
    };
    store.database().put('documents', 'settings.json', old);
    store.database().put('documents', 'profiles.json', [{ id: 'synthetic-profile' }]);
    store.database().put('documents', 'history.json', [{ result: 'synthetic-history' }]);
    const profilesBefore = store.database().get('documents', 'profiles.json');
    const historyBefore = store.database().get('documents', 'history.json');
    const migrated = store.getSettings();
    assert.equal(migrated.launchDefaultsVersion, store.DEFAULT_SETTINGS.launchDefaultsVersion);
    assert.equal(migrated.multiInstanceMode, true);
    assert.equal(migrated.autoDetect, true);
    assert.equal(migrated.robloxPath, '');
    assert.equal(migrated.robloxDiscoveryPath, old.robloxPath);
    assert.equal(migrated.robloxInstallationId, '');
    assert.equal(migrated.pollIntervalMs, old.pollIntervalMs);
    assert.equal(migrated.historyLimit, old.historyLimit);
    assert.deepEqual(migrated.futureSetting, old.futureSetting);
    const migratedRow = store.database().get('documents', 'settings.json');
    assert.equal(migratedRow.revision, 2);
    assert.deepEqual(store.getSettings(), migrated);
    assert.deepEqual(store.database().get('documents', 'settings.json'), migratedRow);
    assert.deepEqual(store.database().get('documents', 'profiles.json'), profilesBefore);
    assert.deepEqual(store.database().get('documents', 'history.json'), historyBefore);

    store.saveSettings({ multiInstanceMode: false, autoDetect: false, robloxPath: 'new-manual-choice' });
    store.close();
    store.configure(userData, null, { assertOwner: () => true });
    const savedChoice = store.getSettings();
    assert.equal(savedChoice.multiInstanceMode, false);
    assert.equal(savedChoice.autoDetect, false);
    assert.equal(savedChoice.robloxPath, 'new-manual-choice');
  } finally {
    store.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('launch-default migration rolls back on storage failure and a partial save also migrates old profiles', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-upgrade-rollback-'));
  try {
    store.configure(userData, null, { assertOwner: () => true });
    store.database().put('documents', 'settings.json', {
      multiInstanceMode: false, autoDetect: false, robloxInstallationId: 'old-installation',
    });
    const before = store.database().get('documents', 'settings.json');
    store.database().fault = point => { if (point === 'before-commit') throw new Error('Synthetic settings commit failure'); };
    assert.throws(() => store.getSettings(), /Synthetic settings commit failure/);
    assert.deepEqual(store.database().get('documents', 'settings.json'), before);
    store.database().fault = () => {};
    const saved = store.saveSettings({ historyLimit: 123 });
    assert.equal(saved.multiInstanceMode, true);
    assert.equal(saved.autoDetect, true);
    assert.equal(saved.robloxInstallationId, '');
    assert.equal(saved.historyLimit, 123);
  } finally {
    store.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test('saving automatic settings keeps installation discovery unpinned', () => {
  const settings = store.normalizeSettings({});
  const controls = {
    '#set-detect': { dataset: { auto: 'true' } },
    '#set-path': { value: '' },
    '#set-multi-instance': { checked: true },
    '#set-confirm': { checked: true },
    ...Object.fromEntries([
      ['poll', 'pollIntervalMs'], ['delay', 'launchDelayMs'], ['warn', 'warnInstanceCount'],
      ['historylimit', 'historyLimit'], ['rejoin-delay', 'autoRejoinDelaySec'],
      ['rejoin-tries', 'autoRejoinMaxAttempts'], ['hung', 'autoRestartHungSec'],
    ].map(([id, setting]) => [`#set-${id}`, { value: String(settings[setting]) }])),
  };
  const context = vm.createContext({
    views: {}, state: { settings },
    $: selector => controls[selector],
    document: { querySelector: () => ({ value: '' }) },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'renderer', 'views', 'settings.js'), 'utf8'), context);
  const draft = context.currentSettingsDraft();
  assert.equal(draft.autoDetect, true);
  assert.equal(draft.robloxInstallationId, '');
  assert.equal(draft.multiInstanceMode, true);
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
  store.database().put('documents', 'settings.json', {
    multiInstanceMode: false, autoDetect: false,
    robloxInstallationId: 'synthetic-old-installation', robloxPath: 'synthetic-old-path',
  });
  store.close();

  let runtime = startBackend(userData);
  try {
    const enabled = await request(runtime.child, runtime.messages, 1, 'app_status');
    assert.equal(enabled.adapterSelection.legacyCompatEnabled, true);
    assert.equal(enabled.adapterSelection.legacyCompatSettingEnabled, true);
    assert.equal(enabled.adapterSelection.legacyCompatEnvironmentValue, 'ABSENT');
    assert.equal(enabled.adapterSelection.legacyCompatActivationSource, 'settings');
    assert.equal(enabled.adapterSelection.selectedAdapter, 'LegacyRobloxIsolationAdapter');
    assert.equal(enabled.settings.autoDetect, true);
    assert.equal(enabled.settings.robloxPath, '');
    assert.equal(enabled.settings.robloxInstallationId, '');
    assert.equal(enabled.settings.multiInstanceMode, true);

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
