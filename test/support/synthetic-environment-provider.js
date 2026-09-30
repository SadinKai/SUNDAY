'use strict';

/**
 * SYNTHETIC / TEST ONLY.
 *
 * Ordinary Node child processes and temporary directories exercise the SUNDAY Launcher
 * environment protocol. They are not VMs and cannot qualify Roblox.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const {
  EnvironmentProvider,
  PROVIDER_STATES,
  providerResult,
  validateEnvironmentIdentity,
} = require('../../src/main/environment-provider');
const {
  SecureRpcEndpoint,
  createSessionKey,
  createSigningIdentity,
} = require('../../src/main/environment-rpc');
const { GuestLocalCredentialVault } = require('../../src/guest/windows-guest-agent');
const { SyntheticGuestAgent } = require('./synthetic-guest-agent');

const TEST_IMAGE_DIGEST = crypto.createHash('sha256').update('sunday-synthetic-image-v1').digest('hex');

function waitForExit(child, timeoutMs) {
  return new Promise(resolve => {
    if (child.exitCode != null) return resolve(true);
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

class SyntheticEnvironmentProvider extends EnvironmentProvider {
  constructor(options) {
    const opts = options || {};
    super({ providerId: 'synthetic-test-provider' });
    this.syntheticTestOnly = true;
    this.baseDir = opts.baseDir || fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-synthetic-environments-'));
    this.hostId = opts.hostId || `synthetic-host-${crypto.randomUUID()}`;
    this.failAllocationOrders = new Set(opts.failAllocationOrders || []);
    this.failConnectOrders = new Set(opts.failConnectOrders || []);
    this.failLaunchOrders = new Set(opts.failLaunchOrders || []);
    this.hangLaunchOrders = new Set(opts.hangLaunchOrders || []);
    this.environments = new Map();
    this.sequence = [];
    this.closed = false;
    this.baseImageDir = path.join(this.baseDir, 'immutable-base');
    fs.mkdirSync(this.baseImageDir, { recursive: true });
    fs.writeFileSync(path.join(this.baseImageDir, 'IMAGE-DIGEST'), TEST_IMAGE_DIGEST, { flag: 'wx' });
  }

  _image(generation) {
    return {
      digest: TEST_IMAGE_DIGEST,
      windowsVersion: 'SYNTHETIC-WINDOWS-TEST-ONLY',
      guestAgentBuild: 'synthetic-agent-v1',
      guestAgentSignature: 'TEST_ONLY_NOT_A_PRODUCTION_SIGNATURE',
      webView2Version: 'synthetic-webview2',
      robloxVersion: 'SYNTHETIC_NO_ROBLOX',
      generation,
      createdAt: '2026-09-29T00:00:00.000Z',
      providerId: this.providerId,
    };
  }

  async discover() {
    return providerResult(PROVIDER_STATES.ACTIVATED, 'SYNTHETIC / TEST ONLY provider.', {
      providerId: this.providerId,
      syntheticTestOnly: true,
    });
  }

  async preflight() { return this.discover(); }
  async provision() { return providerResult(PROVIDER_STATES.ACTIVATED, 'Synthetic immutable base exists.', { image: this._image(1) }); }

  async allocate(request) {
    if (request && request.signal && request.signal.aborted) {
      return providerResult(PROVIDER_STATES.FAILED, 'Synthetic allocation was cancelled.', { ok: false });
    }
    const order = Number(request && request.order) || 0;
    if (this.failAllocationOrders.has(order)) {
      return providerResult(PROVIDER_STATES.ACTIVATED, 'Injected synthetic allocation failure.', { ok: false });
    }
    const environmentId = `synenv-${crypto.randomUUID()}`;
    const root = path.join(this.baseDir, environmentId);
    const writableDisk = path.join(root, 'writable-disk');
    fs.mkdirSync(writableDisk, { recursive: true });
    const environment = validateEnvironmentIdentity({
      environmentId,
      providerId: this.providerId,
      guestId: `guest-${crypto.randomUUID()}`,
      vmId: `synthetic-vm-${crypto.randomUUID()}`,
      hostId: this.hostId,
      generation: 1,
      agentId: `agent-${crypto.randomUUID()}`,
      image: this._image(1),
    });
    this.environments.set(environmentId, {
      environment,
      root,
      writableDisk,
      order,
      state: 'ALLOCATED',
      child: null,
      processIdentity: null,
      session: null,
      agent: null,
      networkAvailable: true,
      agentAvailable: true,
      destroyed: false,
      localSecrets: new Map([[String(request.accountHandle), `guest-local-secret-${crypto.randomUUID()}`]]),
    });
    this.sequence.push({ type: 'allocate', environmentId, order });
    return providerResult(PROVIDER_STATES.ACTIVATED, '', { environment });
  }

  _environment(value) {
    const environmentId = typeof value === 'string'
      ? value
      : String(value && value.environment && value.environment.environmentId || value && value.environmentId || '');
    const record = this.environments.get(environmentId);
    if (!record || record.destroyed) throw new Error('Synthetic environment is unknown or destroyed.');
    return record;
  }

  async start(request) {
    const record = this._environment(request);
    record.state = 'STARTED';
    record.leaseId = String(request.leaseId || '');
    this.sequence.push({ type: 'start', environmentId: record.environment.environmentId });
    return providerResult(PROVIDER_STATES.ACTIVATED, '', { environment: record.environment });
  }

  async connect(request) {
    const record = this._environment(request);
    if (this.failConnectOrders.has(record.order)) {
      return providerResult(PROVIDER_STATES.ACTIVATED, 'Injected synthetic authenticated-connect failure.', { ok: false });
    }
    const leaseId = String(request.leaseId || '');
    if (!leaseId || leaseId !== record.leaseId) throw new Error('Synthetic lease binding is missing.');
    const hostIdentity = createSigningIdentity();
    const agentIdentity = createSigningIdentity();
    const sessionKey = createSessionKey();
    const endpointOptions = {
      environmentId: record.environment.environmentId,
      leaseId,
      generation: record.environment.generation,
      agentId: record.environment.agentId,
      encryptionKey: sessionKey,
    };
    const hostEndpoint = new SecureRpcEndpoint(Object.assign({}, endpointOptions, {
      role: 'HOST_BROKER', peerRole: 'GUEST_AGENT',
      privateKeyPem: hostIdentity.privateKeyPem, peerPublicKeyPem: agentIdentity.publicKeyPem,
    }));
    const guestEndpoint = new SecureRpcEndpoint(Object.assign({}, endpointOptions, {
      role: 'GUEST_AGENT', peerRole: 'HOST_BROKER',
      privateKeyPem: agentIdentity.privateKeyPem, peerPublicKeyPem: hostIdentity.publicKeyPem,
    }));
    const vault = new GuestLocalCredentialVault({
      guestLocal: true,
      resolve: async accountHandle => record.localSecrets.get(String(accountHandle)) || null,
    });
    const launcher = this._launcher(record);
    const agent = new SyntheticGuestAgent({
      endpoint: guestEndpoint,
      binding: Object.assign({}, record.environment, { leaseId }),
      launcher,
      credentialVault: vault,
    });
    record.session = { hostEndpoint, guestEndpoint };
    record.agent = agent;
    record.state = 'CONNECTED';
    this.sequence.push({ type: 'connect', environmentId: record.environment.environmentId });
    return providerResult(PROVIDER_STATES.ACTIVATED, '', {
      authenticated: true,
      encrypted: true,
      replayProtected: true,
      environment: record.environment,
    });
  }

  _launcher(record) {
    return {
      spawn: async request => {
        if (this.hangLaunchOrders.has(record.order)) return new Promise(() => {});
        if (this.failLaunchOrders.has(record.order)) {
          return { ok: false, reason: 'Injected synthetic guest launch failure.' };
        }
        if (!request.credential || record.child && record.child.exitCode == null && !record.exitObserved) {
          return { ok: false, reason: 'Synthetic guest launch rejected.' };
        }
        const mutexPath = path.join(record.writableDisk, 'RobloxPlayerBetaSingletonMutex');
        fs.writeFileSync(mutexPath, record.environment.environmentId, { flag: 'w' });
        const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          cwd: record.writableDisk,
          windowsHide: true,
          stdio: 'ignore',
        });
        const stat = fs.statSync(process.execPath);
        record.child = child;
        record.exitObserved = false;
        record.processIdentity = {
          pid: child.pid,
          processIdentity: crypto.randomUUID(),
          fileIdentity: `${stat.dev}:${stat.ino}:${stat.size}`,
          executablePath: process.execPath,
          processOwner: `synthetic-guest-owner-${record.environment.guestId}`,
        };
        child.once('exit', () => { record.exitObserved = true; });
        return Object.assign({ ok: true }, record.processIdentity);
      },
      inspect: async expected => {
        if (!record.child || record.child.exitCode != null || record.exitObserved) return { status: 'EXITED' };
        return Object.assign({ status: 'RUNNING' }, record.processIdentity, expected && expected.replacedForTest ? { processIdentity: crypto.randomUUID() } : {});
      },
      stop: async expected => {
        if (!record.child || record.child.exitCode != null || record.exitObserved) return { ok: false, confirmed: false, reason: 'Synthetic guest process is absent.' };
        if (expected.processIdentity !== record.processIdentity.processIdentity) return { ok: false, confirmed: false, reason: 'Synthetic process identity mismatch.' };
        const signalled = record.child.kill();
        const confirmed = signalled && await waitForExit(record.child, 2000);
        return { ok: confirmed, confirmed };
      },
    };
  }

  async _request(request, action, body) {
    const record = this._environment(request);
    if (!record.networkAvailable) return providerResult(PROVIDER_STATES.ACTIVATED, 'Synthetic network is unavailable.', { ok: false });
    if (!record.agentAvailable || !record.agent || !record.session) return providerResult(PROVIDER_STATES.ACTIVATED, 'Synthetic guest agent is unavailable.', { ok: false });
    const envelope = record.session.hostEndpoint.seal(action, body || {}, {
      operationId: String(request.operationId || crypto.randomUUID()),
      ttlMs: Number(request.ttlMs) || 5000,
    });
    const encryptedReply = await record.agent.handle(envelope);
    const reply = record.session.hostEndpoint.open(encryptedReply);
    return providerResult(PROVIDER_STATES.ACTIVATED, reply.body.reason || '', Object.assign({}, reply.body));
  }

  async health(request) { return this._request(request, 'HEALTH', {}); }
  async executeLaunchIntent(request) { return this._request(request, 'EXECUTE_LAUNCH_INTENT', request.intent); }
  async observe(request) { return this._request(request, 'OBSERVE', { processCapability: request.processCapability }); }
  async stop(request) { return this._request(request, 'STOP', { processCapability: request.processCapability }); }
  async restart(request) {
    return this._request(request, 'RESTART', {
      processCapability: request.processCapability,
      intent: request.intent,
    });
  }

  async release(request) {
    const record = this._environment(request);
    if (record.child && record.child.exitCode == null && !record.exitObserved) {
      return providerResult(PROVIDER_STATES.ACTIVATED, 'Synthetic environment still owns a running process.', { ok: false, released: false });
    }
    record.state = 'RELEASED';
    return providerResult(PROVIDER_STATES.ACTIVATED, '', { released: true });
  }

  async destroy(request) {
    const record = this._environment(request);
    if (record.child && record.child.exitCode == null && !record.exitObserved) {
      record.child.kill();
      await waitForExit(record.child, 2000);
    }
    const resolved = path.resolve(record.root);
    const prefix = path.resolve(this.baseDir) + path.sep;
    if (!resolved.startsWith(prefix) || path.basename(resolved) !== record.environment.environmentId) {
      throw new Error('Refusing to destroy an unexpected synthetic environment path.');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
    record.destroyed = true;
    record.state = 'DESTROYED';
    return providerResult(PROVIDER_STATES.ACTIVATED, '', { destroyed: true });
  }

  async recover() {
    return providerResult(PROVIDER_STATES.QUALIFICATION_REQUIRED, 'Synthetic broker restart never adopts an existing environment.', { adopted: false });
  }

  setNetwork(environmentId, available) { this._environment(environmentId).networkAvailable = !!available; }
  crashAgent(environmentId) { this._environment(environmentId).agentAvailable = false; }
  restoreAgent(environmentId) { this._environment(environmentId).agentAvailable = true; }
  replaceProcessIdentity(environmentId) {
    const record = this._environment(environmentId);
    if (record.processIdentity) record.processIdentity.processIdentity = crypto.randomUUID();
  }
  replacePid(environmentId) {
    const record = this._environment(environmentId);
    if (record.processIdentity) record.processIdentity.pid += 100000;
  }

  recordOf(environmentId) { return this._environment(environmentId); }

  async shutdown() {
    for (const record of this.environments.values()) {
      if (!record.destroyed && record.child && record.child.exitCode == null && !record.exitObserved) {
        record.child.kill();
        await waitForExit(record.child, 2000);
      }
    }
    if (!this.closed) {
      const resolved = path.resolve(this.baseDir);
      const tempPrefix = path.resolve(os.tmpdir()) + path.sep;
      if (resolved.startsWith(tempPrefix) && path.basename(resolved).startsWith('sunday-synthetic-environments-')) {
        fs.rmSync(resolved, { recursive: true, force: true });
      }
      this.closed = true;
    }
  }
}

module.exports = { SyntheticEnvironmentProvider, TEST_IMAGE_DIGEST };
