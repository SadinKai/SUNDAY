'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const root = path.resolve(__dirname, '..');
const host = path.join(root, 'src', 'main', 'tauri-node-host.js');

function request(child, messages, id, command) {
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
    child.stdin.write(JSON.stringify({ id, command, payload: {} }) + '\n');
  });
}

test('actual backend host selects the legacy adapter when LEGACY_COMPAT=1', async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-runtime-selector-'));
  const environment = Object.assign({}, process.env, { LEGACY_COMPAT: '1' });
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

  try {
    const diagnostic = await request(child, messages, 1, 'adapter_selection_status');
    assert.deepEqual(diagnostic.adapterSelection, {
      legacyCompatEnabled: true,
      legacyCompatEnvironmentValue: '1',
      selectedAdapter: 'LegacyRobloxIsolationAdapter',
      isolationState: 'LEGACY_COMPAT',
      reason: "LEGACY MULTI-INSTANCE MODE: Uses SUNDAY Launcher's legacy compatibility mechanism. This is not vendor supported isolation.",
    });

    const status = await request(child, messages, 2, 'app_status');
    assert.deepEqual(status.adapterSelection, diagnostic.adapterSelection);
    assert.equal(status.isolationAdapter.implementation, 'LegacyRobloxIsolationAdapter');
    assert.equal(status.isolationAdapter.mode, 'LEGACY_COMPAT');

    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Backend did not exit after shutdown')), 5000);
      child.once('exit', code => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Backend exited with ${code}: ${stderr.join('')}`));
      });
    });
    await request(child, messages, 3, 'shutdown');
    await exited;
  } finally {
    if (child.exitCode == null) child.kill();
    lines.close();
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
