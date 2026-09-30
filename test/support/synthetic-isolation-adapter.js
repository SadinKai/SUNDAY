'use strict';

/**
 * SYNTHETIC / TEST ONLY.
 *
 * This adapter starts ordinary Node.js timer processes. It never discovers,
 * names, launches, observes, or mutates Roblox. Production code does not
 * import this file.
 */

const crypto = require('crypto');
const { spawn } = require('child_process');
const { RobloxIsolationAdapter, ISOLATION_STATES, result } = require('../../src/main/roblox-isolation-adapter');

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason || new Error('Synthetic operation cancelled.'));
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('Synthetic operation cancelled.'));
    }, { once: true });
  });
}

class SyntheticIsolationAdapter extends RobloxIsolationAdapter {
  constructor(options) {
    super();
    const opts = options || {};
    this.syntheticTestOnly = true;
    this.stableMs = Math.max(5, Number(opts.stableMs) || 25);
    this.launchDelayMs = Math.max(0, Number(opts.launchDelayMs) || 0);
    this.failAllocations = new Set(opts.failAllocations || []);
    this.failLaunches = new Set(opts.failLaunches || []);
    this.hangLaunches = new Set(opts.hangLaunches || []);
    this.environments = new Map();
    this.capabilities = new Map();
    this.sequence = [];
  }

  async preflight() {
    return result(ISOLATION_STATES.ACTIVATED, 'SYNTHETIC / TEST ONLY adapter is activated.');
  }

  async allocateInstance(operation) {
    if (this.failAllocations.has(operation.operationId) || this.failAllocations.has(operation.order)) {
      return result(ISOLATION_STATES.ACTIVATED, 'Injected synthetic allocation failure.', { ok: false });
    }
    const environmentId = `synthetic-environment-${crypto.randomUUID()}`;
    this.environments.set(environmentId, { environmentId, operationId: operation.operationId, capability: null, released: false });
    this.sequence.push({ type: 'allocate', operationId: operation.operationId, at: Date.now() });
    return result(ISOLATION_STATES.ACTIVATED, '', { environmentId });
  }

  async launch(intent, context) {
    const operation = context && context.operation || {};
    const environmentId = String(context && context.environmentId || '');
    const environment = this.environments.get(environmentId);
    if (!environment || environment.released) return result(ISOLATION_STATES.ACTIVATED, 'Synthetic environment is missing or released.', { ok: false });
    if (this.failLaunches.has(operation.operationId) || this.failLaunches.has(operation.order)) {
      return result(ISOLATION_STATES.ACTIVATED, 'Injected synthetic launch failure.', { ok: false });
    }
    if (this.hangLaunches.has(operation.operationId) || this.hangLaunches.has(operation.order)) {
      return new Promise((_resolve, reject) => {
        if (context.signal) context.signal.addEventListener('abort', () => reject(context.signal.reason || new Error('Synthetic operation cancelled.')), { once: true });
      });
    }
    if (this.launchDelayMs) await wait(this.launchDelayMs, context.signal);

    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    const capability = `synthetic-capability-${crypto.randomBytes(32).toString('base64url')}`;
    const identity = crypto.randomUUID();
    const record = {
      capability,
      identity,
      child,
      pid: child.pid,
      environmentId,
      operationId: operation.operationId,
      intentSummary: {
        accountHandle: String(intent && intent.accountHandle || ''),
        targetType: String(intent && intent.target && intent.target.type || ''),
      },
      state: 'STARTING',
      exitCode: null,
    };
    this.capabilities.set(capability, record);
    environment.capability = capability;
    child.once('exit', code => { record.state = 'EXITED'; record.exitCode = code; });
    child.once('error', error => { record.state = 'FAILED'; record.error = error.message; });
    this.sequence.push({ type: 'launch', operationId: operation.operationId, pid: child.pid, at: Date.now() });
    await wait(this.stableMs, context.signal);
    if (record.state !== 'STARTING') {
      return result(ISOLATION_STATES.ACTIVATED, 'Synthetic process exited before stable running.', { ok: false });
    }
    record.state = 'RUNNING';
    return result(ISOLATION_STATES.ACTIVATED, '', { capability, pid: child.pid, stable: true });
  }

  _resolve(capability, expectedIdentity) {
    const record = this.capabilities.get(String(capability || ''));
    if (!record) return { ok: false, reason: 'Unknown synthetic process capability.' };
    if (expectedIdentity && record.identity !== expectedIdentity) return { ok: false, reason: 'Synthetic process identity was replaced.' };
    if (!record.child || record.child.pid !== record.pid) return { ok: false, reason: 'Synthetic process capability is stale.' };
    return { ok: true, record };
  }

  async observe(capability, options) {
    const resolved = this._resolve(capability, options && options.expectedIdentity);
    if (!resolved.ok) return result(ISOLATION_STATES.ACTIVATED, resolved.reason, { ok: false, status: 'UNKNOWN' });
    return result(ISOLATION_STATES.ACTIVATED, '', {
      status: resolved.record.state === 'RUNNING' || resolved.record.state === 'STARTING' ? 'RUNNING' : 'EXITED',
      pid: resolved.record.pid,
      identity: resolved.record.identity,
    });
  }

  async stop(capability, options) {
    const resolved = this._resolve(capability, options && options.expectedIdentity);
    if (!resolved.ok) return result(ISOLATION_STATES.ACTIVATED, resolved.reason, { ok: false, confirmed: false });
    const record = resolved.record;
    if (record.state === 'EXITED') return result(ISOLATION_STATES.ACTIVATED, 'Synthetic process already exited.', { ok: false, confirmed: false });
    const exited = new Promise(resolve => record.child.once('exit', () => resolve(true)));
    const signalled = record.child.kill();
    if (!signalled) return result(ISOLATION_STATES.ACTIVATED, 'Synthetic process stop signal was rejected.', { ok: false, confirmed: false });
    const confirmed = await Promise.race([exited, wait(2000).then(() => false)]);
    if (confirmed) record.state = 'EXITED';
    this.sequence.push({ type: 'stop', operationId: record.operationId, pid: record.pid, at: Date.now() });
    return result(ISOLATION_STATES.ACTIVATED, confirmed ? '' : 'Synthetic process exit was not confirmed.', { ok: confirmed, confirmed });
  }

  async restart(intent, context) {
    const resolved = this._resolve(context && context.capability);
    if (!resolved.ok) return result(ISOLATION_STATES.ACTIVATED, resolved.reason, { ok: false });
    const stopped = await this.stop(context.capability);
    if (!stopped.ok || !stopped.confirmed) return result(ISOLATION_STATES.ACTIVATED, stopped.reason, { ok: false });
    return this.launch(intent, context);
  }

  async release(environmentId) {
    const environment = this.environments.get(String(environmentId || ''));
    if (!environment) return result(ISOLATION_STATES.ACTIVATED, 'Unknown synthetic environment.', { ok: false, released: false });
    if (environment.capability) {
      const record = this.capabilities.get(environment.capability);
      if (record && ['RUNNING', 'STARTING'].includes(record.state)) {
        return result(ISOLATION_STATES.ACTIVATED, 'A live owned synthetic process still uses this environment.', { ok: false, released: false });
      }
    }
    environment.released = true;
    return result(ISOLATION_STATES.ACTIVATED, '', { released: true });
  }

  async health() {
    const running = Array.from(this.capabilities.values()).filter(record => record.state === 'RUNNING').length;
    return result(ISOLATION_STATES.ACTIVATED, 'SYNTHETIC / TEST ONLY', { running, environments: this.environments.size });
  }

  identityOf(capability) {
    const record = this.capabilities.get(capability);
    return record && record.identity;
  }

  replaceIdentityForTest(capability) {
    const record = this.capabilities.get(capability);
    if (record) record.identity = crypto.randomUUID();
  }

  async shutdown() {
    for (const record of this.capabilities.values()) {
      if (['RUNNING', 'STARTING'].includes(record.state)) {
        try { await this.stop(record.capability); } catch (_) { try { record.child.kill(); } catch (_) {} }
      }
    }
  }
}

module.exports = { SyntheticIsolationAdapter };
