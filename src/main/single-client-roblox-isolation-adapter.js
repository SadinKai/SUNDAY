'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { ISOLATION_STATES, RobloxIsolationAdapter, result } = require('./roblox-isolation-adapter');

const PLAYER_EXE = 'RobloxPlayerBeta.exe';
const NORMAL_REASON = 'Normal single-client launch is active.';

function normalize(value) {
  try { return path.win32.normalize(String(value || '')).replace(/[\\/]+$/, '').toLowerCase(); }
  catch (_) { return ''; }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason || new Error('Launch cancelled.'));
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('Launch cancelled.'));
    }, { once: true });
  });
}

function defaultPathValidator(playerPath) {
  try {
    return path.win32.basename(String(playerPath || '')).toLowerCase() === PLAYER_EXE.toLowerCase()
      && fs.statSync(playerPath).isFile();
  } catch (_) { return false; }
}

class SingleClientRobloxIsolationAdapter extends RobloxIsolationAdapter {
  constructor(options) {
    super();
    const opts = options || {};
    this.logger = opts.logger || { info() {}, warn() {}, error() {} };
    this.native = opts.nativeApi || require('./native');
    this.platform = String(opts.platform || process.platform);
    this.processCapabilities = opts.processCapabilities;
    this.ownerId = String(opts.ownerId || '');
    this.monitor = opts.monitor || null;
    this.locateRoblox = opts.locateRoblox || (() => ({ found: false }));
    this.pathValidator = opts.pathValidator || defaultPathValidator;
    this.spawnProcess = opts.spawnProcess || ((executable, args) => spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    }));
    this.pollMs = Math.max(10, Number(opts.pollMs) || 500);
    this.stableSamples = Math.max(1, Number(opts.stableSamples) || 3);
    this.launchTimeoutMs = Math.max(100, Number(opts.launchTimeoutMs) || 60000);
    this.requireWindow = opts.requireWindow !== false;
    this.environments = new Map();
    this.capabilityToEnvironment = new Map();
    this.lastFailure = null;
    if (!this.processCapabilities) throw new Error('SingleClientRobloxIsolationAdapter requires a ProcessCapabilityRegistry.');
    if (!this.ownerId) throw new Error('SingleClientRobloxIsolationAdapter requires a SUNDAY Launcher owner ID.');
  }

  _rows() {
    try {
      const rows = this.native.listProcesses(PLAYER_EXE);
      return Array.isArray(rows) ? rows : [];
    } catch (_) { return []; }
  }

  _identity(row) {
    return `${Number(row && row.pid) || 0}:${String(row && row.processIdentity || '')}:${normalize(row && row.executablePath)}`;
  }

  _failure(code, reason, stage) {
    this.lastFailure = Object.freeze({
      at: new Date().toISOString(),
      code: String(code || 'LAUNCH_FAILED'),
      stage: String(stage || 'launch'),
      reason: String(reason || 'Roblox could not be launched.'),
    });
    return result(ISOLATION_STATES.ACTIVATED, this.lastFailure.reason, {
      ok: false,
      status: 'FAILED',
      failureCode: this.lastFailure.code,
      failureStage: this.lastFailure.stage,
      mode: 'NORMAL_SINGLE_CLIENT',
    });
  }

  _activeEnvironment() {
    return Array.from(this.environments.values()).find(environment =>
      ['ALLOCATED', 'STARTING', 'LAUNCHING', 'RUNNING'].includes(environment.state));
  }

  async preflight(context) {
    if (this.platform !== 'win32') {
      return result(ISOLATION_STATES.UNAVAILABLE, 'Normal Roblox launch is available only on Windows.', {
        ok: false, failureCode: 'WINDOWS_REQUIRED', failureStage: 'preflight',
      });
    }
    if (!this.native.isAvailable()) {
      return result(ISOLATION_STATES.UNAVAILABLE, this.native.getLoadError() || 'Windows process identity verification is unavailable.', {
        ok: false, failureCode: 'PROCESS_IDENTITY_UNAVAILABLE', failureStage: 'preflight',
      });
    }
    const plan = context && context.plan;
    if (plan && Array.isArray(plan.operations) && plan.operations.length > 1) {
      return result(ISOLATION_STATES.UNAVAILABLE, 'Normal mode launches one client. Enable Multi-instance mode in Settings to launch multiple accounts.', {
        ok: false, failureCode: 'MULTI_INSTANCE_DISABLED', failureStage: 'preflight',
      });
    }
    const located = this.locateRoblox();
    if (!located || !located.found || !located.playerPath || !this.pathValidator(located.playerPath)) {
      return result(ISOLATION_STATES.UNAVAILABLE, 'RobloxPlayerBeta.exe was not found. Locate it in Settings.', {
        ok: false, failureCode: 'ROBLOX_NOT_FOUND', failureStage: 'preflight',
      });
    }
    const active = this._activeEnvironment();
    const restartOperation = String(context && context.operationId || '');
    if (active && restartOperation && active.operationId === restartOperation && active.state === 'RUNNING') {
      return result(ISOLATION_STATES.ACTIVATED, NORMAL_REASON, { mode: 'NORMAL_SINGLE_CLIENT', qualified: true });
    }
    if (active || this._rows().length) {
      return result(ISOLATION_STATES.UNAVAILABLE, 'A Roblox client is already running. Normal mode will not adopt or replace it.', {
        ok: false, failureCode: 'CLIENT_ALREADY_RUNNING', failureStage: 'preflight',
      });
    }
    return result(ISOLATION_STATES.ACTIVATED, NORMAL_REASON, { mode: 'NORMAL_SINGLE_CLIENT', qualified: true });
  }

  async allocateInstance(operation) {
    if (this._activeEnvironment() || this._rows().length) {
      return this._failure('CLIENT_ALREADY_RUNNING', 'A Roblox client is already running. Normal mode will not adopt or replace it.', 'allocation');
    }
    const located = this.locateRoblox();
    if (!located || !located.found || !located.playerPath || !this.pathValidator(located.playerPath)) {
      return this._failure('ROBLOX_NOT_FOUND', 'RobloxPlayerBeta.exe was not found. Locate it in Settings.', 'allocation');
    }
    let executablePath = String(located.playerPath);
    try { executablePath = fs.realpathSync.native(executablePath); } catch (_) { /* validated logical path remains authoritative */ }
    const fileIdentity = typeof this.native.fileIdentityOfPath === 'function'
      ? String(this.native.fileIdentityOfPath(executablePath) || '')
      : '';
    if (!fileIdentity) {
      return this._failure('EXECUTABLE_IDENTITY_UNAVAILABLE', 'SUNDAY could not verify the Roblox executable identity. Re-detect Roblox in Settings.', 'allocation');
    }
    const environmentId = `single-${crypto.randomUUID()}`;
    const environment = {
      environmentId,
      instanceId: environmentId,
      operationId: String(operation && operation.operationId || ''),
      accountId: String(operation && operation.accountId || ''),
      executablePath,
      fileIdentity,
      state: 'ALLOCATED',
      pid: null,
      processIdentity: '',
      capability: null,
    };
    this.environments.set(environmentId, environment);
    return result(ISOLATION_STATES.ACTIVATED, NORMAL_REASON, {
      environmentId,
      instanceId: environment.instanceId,
      mode: 'NORMAL_SINGLE_CLIENT',
      qualified: true,
    });
  }

  _environment(environmentId) {
    const environment = this.environments.get(String(environmentId || ''));
    if (!environment) throw new Error('No SUNDAY-owned single-client environment matches this operation.');
    return environment;
  }

  _currentFingerprint(pid) {
    return typeof this.native.processFingerprintOf === 'function'
      ? this.native.processFingerprintOf(Number(pid))
      : null;
  }

  _cleanupLaunchProcesses(environment) {
    const candidates = [];
    if (environment.lastCandidate) candidates.push(environment.lastCandidate);
    if (environment.spawnPid) {
      const fingerprint = this._currentFingerprint(environment.spawnPid) || {};
      candidates.push(Object.assign({ pid: environment.spawnPid }, fingerprint));
    }
    const seen = new Set();
    for (const candidate of candidates) {
      const pid = Number(candidate && candidate.pid);
      if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
      seen.add(pid);
      const current = this._currentFingerprint(pid) || {};
      const exact = current.processIdentity
        && String(current.processIdentity) === String(candidate.processIdentity || '')
        && normalize(current.executablePath) === normalize(environment.executablePath)
        && String(current.fileIdentity || '') === environment.fileIdentity;
      if (!exact) continue;
      try {
        this.native.terminateOwned(Object.assign({ pid }, current));
      } catch (_) { /* never broaden cleanup beyond a verified exact process */ }
    }
  }

  async _waitForStable(environment, initialIdentities, signal) {
    const deadline = Date.now() + this.launchTimeoutMs;
    let candidateIdentity = '';
    let consecutive = 0;
    let sawOwnedCandidate = false;
    let sawWrongIdentity = false;
    while (Date.now() < deadline) {
      if (signal && signal.aborted) throw signal.reason || new Error('Launch cancelled.');
      const rows = this._rows().filter(row => row.processIdentity && !initialIdentities.has(this._identity(row)));
      const row = rows.find(item => Number(item.pid) === Number(environment.spawnPid))
        || rows.find(item => Number(item.parentPid) === Number(environment.spawnPid));
      if (!row) {
        if (environment.spawnExited) {
          const error = new Error('Roblox exited during startup.');
          error.code = 'PROCESS_EXITED';
          throw error;
        }
        candidateIdentity = '';
        consecutive = 0;
        await delay(this.pollMs, signal);
        continue;
      }
      sawOwnedCandidate = true;
      const fingerprint = this._currentFingerprint(row.pid) || {};
      const exactIdentity = String(fingerprint.processIdentity || '') === String(row.processIdentity || '')
        && normalize(fingerprint.executablePath) === normalize(environment.executablePath)
        && String(fingerprint.fileIdentity || '') === environment.fileIdentity;
      if (!exactIdentity) {
        sawWrongIdentity = true;
        candidateIdentity = '';
        consecutive = 0;
        await delay(this.pollMs, signal);
        continue;
      }
      environment.lastCandidate = Object.assign({}, row, fingerprint);
      const identity = this._identity(row);
      if (identity === candidateIdentity) consecutive += 1;
      else { candidateIdentity = identity; consecutive = 1; }
      let windowReady = !this.requireWindow;
      let windowEvidence = null;
      if (this.requireWindow && typeof this.native.windowInfoForPids === 'function') {
        const windows = this.native.windowInfoForPids([row.pid]);
        const window = windows && windows.get(Number(row.pid));
        windowEvidence = window || null;
        if (window && String(window.className || '').toLowerCase() === '#32770') {
          const error = new Error('Roblox opened a startup error dialog.');
          error.code = 'ROBLOX_STARTUP_ERROR';
          throw error;
        }
        windowReady = !!(window
          && window.responding !== false
          && String(window.className || '').toUpperCase() === 'WINDOWSCLIENT');
      }
      if (windowReady && consecutive >= this.stableSamples) {
        environment.acceptedWindow = windowEvidence;
        return Object.assign({}, row, fingerprint);
      }
      await delay(this.pollMs, signal);
    }
    const error = new Error(sawWrongIdentity
      ? 'SUNDAY could not verify ownership of the launched Roblox process.'
      : (sawOwnedCandidate
        ? 'Roblox started but did not become ready before the launch timeout.'
        : 'Roblox did not create an owned client process before the launch timeout.'));
    error.code = sawWrongIdentity ? 'OWNERSHIP_NOT_VERIFIED' : 'STARTUP_TIMEOUT';
    throw error;
  }

  async _launchInEnvironment(rawIntent, environment, context) {
    const intent = rawIntent || {};
    const args = [];
    if (intent.mode !== 'client') {
      const launchUri = String(intent.launchUri || '');
      if (!/^roblox-player:/i.test(launchUri)) {
        return this._failure('AUTHENTICATION_FAILED', 'SUNDAY could not create a fresh Roblox sign-in for this account.', 'intent');
      }
      args.push(launchUri);
    }
    const currentFileIdentity = typeof this.native.fileIdentityOfPath === 'function'
      ? String(this.native.fileIdentityOfPath(environment.executablePath) || '')
      : '';
    if (!currentFileIdentity || currentFileIdentity !== environment.fileIdentity) {
      return this._failure('EXECUTABLE_CHANGED', 'Your Roblox installation changed. Re-detect Roblox in Settings.', 'spawn');
    }
    const initialRows = this._rows();
    if (initialRows.length) {
      return this._failure('CLIENT_ALREADY_RUNNING', 'A Roblox client is already running. Normal mode will not adopt or replace it.', 'spawn');
    }
    const initialIdentities = new Set(initialRows.map(row => this._identity(row)));
    environment.state = 'STARTING';
    let child;
    try { child = this.spawnProcess(environment.executablePath, args); }
    catch (_) { return this._failure('SPAWN_FAILED', 'Windows could not start Roblox.', 'spawn'); }
    if (!child || !Number.isInteger(Number(child.pid)) || Number(child.pid) <= 0) {
      return this._failure('SPAWN_FAILED', 'Windows could not start Roblox.', 'spawn');
    }
    environment.spawnPid = Number(child.pid);
    environment.state = 'LAUNCHING';
    environment.spawnExited = false;
    environment.spawnError = false;
    if (typeof child.once === 'function') {
      child.once('exit', () => { environment.spawnExited = true; });
      child.once('error', () => { environment.spawnError = true; });
    }
    if (typeof child.unref === 'function') child.unref();
    let row;
    try { row = await this._waitForStable(environment, initialIdentities, context && context.signal); }
    catch (error) {
      this._cleanupLaunchProcesses(environment);
      return this._failure(error.code || 'STARTUP_TIMEOUT', error.message, 'readiness');
    }
    if (environment.spawnError) {
      this._cleanupLaunchProcesses(environment);
      return this._failure('SPAWN_FAILED', 'Windows could not start Roblox.', 'spawn');
    }
    let capability;
    try {
      capability = this.processCapabilities.issue(row.pid, {
        executablePath: row.executablePath,
        ownerId: this.ownerId,
        instanceId: environment.instanceId,
        accountId: environment.accountId,
        profileName: String(intent.profileName || environment.accountId || environment.instanceId),
        slotId: '',
      });
    } catch (_) {
      this._cleanupLaunchProcesses(environment);
      return this._failure('OWNERSHIP_NOT_VERIFIED', 'SUNDAY could not verify ownership of the launched Roblox process.', 'capability');
    }
    environment.pid = Number(row.pid);
    environment.processIdentity = String(row.processIdentity || '');
    environment.capability = capability;
    environment.lastCandidate = null;
    environment.state = 'RUNNING';
    environment.startedAt = new Date().toISOString();
    this.capabilityToEnvironment.set(capability, environment.environmentId);
    this.lastFailure = null;
    if (this.monitor) this.monitor.markManaged(environment.pid, {
      profileName: String(intent.profileName || environment.accountId || environment.instanceId),
      mode: intent.mode === 'client' ? 'client' : 'deeplink',
      playerPath: environment.executablePath,
      exePath: environment.executablePath,
      accountId: environment.accountId,
      capability,
      instanceId: environment.instanceId,
      operationId: environment.operationId,
      processIdentity: environment.processIdentity,
    });
    return result(ISOLATION_STATES.ACTIVATED, NORMAL_REASON, {
      capability,
      pid: environment.pid,
      stable: true,
      status: 'RUNNING',
      instanceId: environment.instanceId,
      mode: 'NORMAL_SINGLE_CLIENT',
      qualified: true,
    });
  }

  async launch(rawIntent, context) {
    const environment = this._environment(context && context.environmentId);
    if (environment.state !== 'ALLOCATED') {
      return this._failure('INVALID_ENVIRONMENT_STATE', 'The normal Roblox launch is not ready. Retry the launch.', 'launch');
    }
    return this._launchInEnvironment(rawIntent, environment, context);
  }

  _ownedEnvironment(capability) {
    const environmentId = this.capabilityToEnvironment.get(String(capability || ''));
    const environment = environmentId && this.environments.get(environmentId);
    return environment && environment.capability === String(capability || '') ? environment : null;
  }

  async observe(capability) {
    const environment = this._ownedEnvironment(capability);
    if (!environment) return result(ISOLATION_STATES.ACTIVATED, 'Unknown single-client process capability.', { ok: false, status: 'UNKNOWN' });
    const authorized = this.processCapabilities.authorize(capability, 'observe', this.ownerId);
    if (!authorized.ok) {
      environment.state = 'UNKNOWN';
      return result(ISOLATION_STATES.ACTIVATED, authorized.reason, { ok: false, status: 'UNKNOWN' });
    }
    const row = this._rows().find(item => Number(item.pid) === Number(environment.pid));
    if (!row) {
      environment.state = 'EXITED';
      this.processCapabilities.revoke(capability, 'Owned Roblox process exit was confirmed.');
      return result(ISOLATION_STATES.ACTIVATED, 'Owned Roblox process exit was confirmed.', { status: 'EXITED', confirmed: true, ownership: 'OWNED' });
    }
    if (String(row.processIdentity || '') !== environment.processIdentity
        || normalize(row.executablePath) !== normalize(environment.executablePath)) {
      environment.state = 'UNKNOWN';
      return result(ISOLATION_STATES.ACTIVATED, 'Process identity no longer matches the SUNDAY launch record.', { ok: false, status: 'UNKNOWN' });
    }
    return result(ISOLATION_STATES.ACTIVATED, NORMAL_REASON, { status: 'RUNNING', pid: environment.pid, stable: true });
  }

  async stop(capability) {
    const environment = this._ownedEnvironment(capability);
    if (!environment) return result(ISOLATION_STATES.ACTIVATED, 'Unknown single-client process capability.', { ok: false, confirmed: false });
    const authorized = this.processCapabilities.authorize(capability, 'stop', this.ownerId);
    if (!authorized.ok) return result(ISOLATION_STATES.ACTIVATED, authorized.reason, { ok: false, confirmed: false });
    const terminated = this.native.terminateOwned(authorized.record);
    if (!terminated || !terminated.ok || !terminated.confirmed) {
      return result(ISOLATION_STATES.ACTIVATED, terminated && terminated.reason || 'Owned termination was not confirmed.', { ok: false, confirmed: false });
    }
    this.processCapabilities.revoke(capability, 'Owned Roblox process termination was confirmed.');
    this.capabilityToEnvironment.delete(capability);
    if (this.monitor) this.monitor.forget(environment.pid);
    environment.state = 'STOPPED';
    environment.pid = null;
    environment.processIdentity = '';
    environment.capability = null;
    return result(ISOLATION_STATES.ACTIVATED, NORMAL_REASON, { confirmed: true, status: 'STOPPED' });
  }

  async restart(rawIntent, context) {
    const environment = this._ownedEnvironment(context && context.capability);
    if (!environment) return result(ISOLATION_STATES.ACTIVATED, 'Unknown single-client process capability.', { ok: false });
    const stopped = await this.stop(context.capability);
    if (!stopped.ok || !stopped.confirmed) return stopped;
    environment.state = 'ALLOCATED';
    return this._launchInEnvironment(rawIntent, environment, context);
  }

  async release(environmentId) {
    const environment = this._environment(environmentId);
    if (environment.state === 'RUNNING') {
      return result(ISOLATION_STATES.ACTIVATED, 'A running single-client environment cannot be released.', { ok: false, released: false });
    }
    if (environment.capability) this.capabilityToEnvironment.delete(environment.capability);
    this.environments.delete(environment.environmentId);
    return result(ISOLATION_STATES.ACTIVATED, NORMAL_REASON, { released: true });
  }

  async health() {
    const running = [];
    for (const environment of this.environments.values()) {
      if (environment.state !== 'RUNNING' || !environment.capability) continue;
      const observed = await this.observe(environment.capability);
      if (observed.status === 'RUNNING') running.push({
        environmentId: environment.environmentId,
        instanceId: environment.instanceId,
        operationId: environment.operationId,
        accountId: environment.accountId,
        pid: environment.pid,
      });
    }
    return result(ISOLATION_STATES.ACTIVATED, NORMAL_REASON, {
      running,
      count: running.length,
      mode: 'NORMAL_SINGLE_CLIENT',
      qualified: true,
    });
  }

  async reconcile() {
    const exits = [];
    for (const environment of this.environments.values()) {
      if (environment.state !== 'RUNNING' || !environment.capability) continue;
      const capability = environment.capability;
      const observed = await this.observe(capability);
      if (observed.status === 'EXITED' && observed.confirmed) exits.push({
        accountId: environment.accountId,
        operationId: environment.operationId,
        instanceId: environment.instanceId,
        capability,
        confirmed: true,
        ownership: 'OWNED',
        reason: observed.reason,
      });
    }
    return exits;
  }

  diagnostics() {
    return {
      mode: 'NORMAL_SINGLE_CLIENT',
      qualified: true,
      activeCount: Array.from(this.environments.values()).filter(item => item.state === 'RUNNING').length,
      lastFailure: this.lastFailure,
      environments: Array.from(this.environments.values()).map(environment => ({
        environmentId: environment.environmentId,
        operationId: environment.operationId,
        state: environment.state,
        pid: environment.pid,
      })),
    };
  }

  shutdown() {
    // A backend shutdown never broad-terminates or adopts Roblox processes.
  }
}

module.exports = { NORMAL_REASON, SingleClientRobloxIsolationAdapter };
