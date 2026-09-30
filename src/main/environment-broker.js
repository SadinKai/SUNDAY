'use strict';

const crypto = require('crypto');
const {
  PROVIDER_STATES,
  providerError,
  validateEnvironmentIdentity,
} = require('./environment-provider');
const { EnvironmentLeaseManager } = require('./environment-leases');
const { validateLaunchIntent } = require('./environment-rpc');

function brokerError(code, message) {
  const error = new Error(String(message || code));
  error.code = code;
  return error;
}

function token() { return crypto.randomBytes(32).toString('base64url'); }
function tokenDigest(value) { return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex'); }
function sameDigest(left, right) {
  const a = Buffer.from(String(left || ''), 'ascii');
  const b = Buffer.from(String(right || ''), 'ascii');
  return a.length === 64 && b.length === 64 && crypto.timingSafeEqual(a, b);
}

class EnvironmentBroker {
  constructor(options) {
    const opts = options || {};
    if (!opts.provider || !opts.database) throw brokerError('EBROKERCONFIG', 'Environment broker requires a provider and transactional state.');
    this.provider = opts.provider;
    this.leases = opts.leases || new EnvironmentLeaseManager({ database: opts.database, now: opts.now, ttlMs: opts.leaseTtlMs });
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.environments = new Map();
    this.processes = new Map();
    this.recovered = this.leases.recoverInterrupted();
  }

  async preflight() {
    const result = await this.provider.preflight();
    if (!result || !Object.values(PROVIDER_STATES).includes(result.state)) {
      throw providerError('EPROVIDERSTATE', 'Environment provider returned an invalid preflight state.');
    }
    return result;
  }

  _await(promise, signal, reason) {
    if (!signal) return Promise.resolve(promise);
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(brokerError('EBROKERABORTED', reason));
      const abort = () => reject(brokerError('EBROKERABORTED', reason));
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(promise).then(
        value => { signal.removeEventListener('abort', abort); resolve(value); },
        error => { signal.removeEventListener('abort', abort); reject(error); },
      );
    });
  }

  async allocate(operation, options) {
    const preflight = await this.preflight();
    if (preflight.state !== PROVIDER_STATES.ACTIVATED) return preflight;
    const accountHandle = String(operation && (operation.accountHandle || operation.accountId) || '').trim();
    const operationId = String(operation && operation.operationId || '').trim();
    if (!accountHandle || !operationId) throw brokerError('EBROKEROPERATION', 'Environment allocation requires account and operation identities.');
    let environment;
    let lease;
    try {
      const allocated = await this._await(this.provider.allocate({
        operationId,
        accountHandle,
        order: Number(operation.order) || 0,
        signal: options && options.signal,
      }), options && options.signal, 'Environment allocation was cancelled or timed out.');
      if (!allocated || !allocated.ok || !allocated.environment) return allocated;
      environment = validateEnvironmentIdentity(allocated.environment);
      lease = this.leases.reserve({ environment, accountHandle, operationId });
      const started = await this._await(
        this.provider.start({ environment, leaseId: lease.leaseId, signal: options && options.signal }),
        options && options.signal,
        'Environment start was cancelled or timed out.',
      );
      if (!started || !started.ok) throw brokerError('EBROKERSTART', started && started.reason || 'Environment did not start.');
      const connected = await this._await(
        this.provider.connect({ environment, leaseId: lease.leaseId, signal: options && options.signal }),
        options && options.signal,
        'Guest-agent connection was cancelled or timed out.',
      );
      if (!connected || !connected.ok || connected.authenticated !== true
          || connected.encrypted !== true || connected.replayProtected !== true) {
        throw brokerError('EBROKERAUTH', connected && connected.reason || 'Guest-agent connection did not prove authentication, encryption, and replay protection.');
      }
      const authenticated = validateEnvironmentIdentity(connected.environment);
      const environmentCapability = `env_${token()}`;
      const capabilityDigest = tokenDigest(environmentCapability);
      this.leases.activate(lease.leaseId, lease.leaseToken, { environment: authenticated, capabilityDigest });
      const health = await this._await(this.provider.health({
        environment,
        leaseId: lease.leaseId,
        operationId: `health-${operationId}`,
        signal: options && options.signal,
      }), options && options.signal, 'Guest-agent health check was cancelled or timed out.');
      if (!health || !health.ok || health.status !== 'READY') {
        throw brokerError('EBROKERHEALTH', health && health.reason || 'Guest agent did not report READY.');
      }
      this.environments.set(environmentCapability, {
        capabilityDigest,
        environment,
        leaseId: lease.leaseId,
        leaseToken: lease.leaseToken,
        accountHandle,
        operationId,
        processCapabilities: new Set(),
      });
      return {
        ok: true,
        state: PROVIDER_STATES.ACTIVATED,
        environmentId: environment.environmentId,
        environmentCapability,
        environment,
      };
    } catch (error) {
      if (lease) {
        try { this.leases.revoke(lease.leaseId, lease.leaseToken, error.message); } catch (_) {}
      }
      if (environment) {
        try { await this.provider.destroy({ environment }); } catch (_) {}
      } else {
        try { await this.provider.recover({ operationId, disposition: 'DESTROY_UNCERTAIN_ALLOCATION' }); } catch (_) {}
      }
      return { ok: false, state: PROVIDER_STATES.FAILED, reason: String(error.message || error) };
    }
  }

  _environment(capability, allowDisposed) {
    const record = this.environments.get(String(capability || ''));
    if (!record || !sameDigest(record.capabilityDigest, tokenDigest(capability))) {
      throw brokerError('EBROKERCAPABILITY', 'Environment capability is unknown.');
    }
    if (record.disposed) {
      if (allowDisposed) return record;
      throw brokerError('EBROKERDISPOSED', 'Environment capability refers to a revoked and destroyed environment.');
    }
    this.leases.authorize(record.leaseId, record.leaseToken, {
      environmentId: record.environment.environmentId,
      generation: record.environment.generation,
      agentId: record.environment.agentId,
      operationId: record.operationId,
      capabilityDigest: record.capabilityDigest,
    });
    return record;
  }

  _process(capability) {
    const record = this.processes.get(String(capability || ''));
    if (!record || !sameDigest(record.capabilityDigest, tokenDigest(capability))) {
      throw brokerError('EBROKERCAPABILITY', 'Process capability is unknown.');
    }
    const environment = this._environment(record.environmentCapability);
    if (record.environmentId !== environment.environment.environmentId
        || record.generation !== environment.environment.generation
        || record.agentId !== environment.environment.agentId
        || record.leaseId !== environment.leaseId) {
      throw brokerError('EBROKERBINDING', 'Process capability is not bound to the active environment lease.');
    }
    return { record, environment };
  }

  async executeLaunchIntent(environmentCapability, rawIntent, operationId, options) {
    const environmentRecord = this._environment(environmentCapability);
    const intent = validateLaunchIntent(rawIntent);
    if (intent.accountHandle !== environmentRecord.accountHandle) {
      throw brokerError('EBROKERACCOUNT', 'Launch account handle does not match the environment lease.');
    }
    if (environmentRecord.processCapabilities.size >= 1) {
      throw brokerError('EBROKERCAP', 'Environment process cap is one.');
    }
    let response;
    try {
      response = await this._await(this.provider.executeLaunchIntent({
        environment: environmentRecord.environment,
        leaseId: environmentRecord.leaseId,
        operationId: String(operationId || environmentRecord.operationId),
        intent,
        ttlMs: 15_000,
      }), options && options.signal, 'Guest launch command was cancelled or timed out.');
    } catch (error) {
      try { this.leases.revoke(environmentRecord.leaseId, environmentRecord.leaseToken, error.message); } catch (_) {}
      try {
        const destroyed = await this.provider.destroy({ environment: environmentRecord.environment, leaseId: environmentRecord.leaseId });
        environmentRecord.disposed = !!(destroyed && destroyed.ok && destroyed.destroyed);
      } catch (_) { environmentRecord.disposed = false; }
      throw error;
    }
    if (!response || !response.ok || response.status !== 'RUNNING' || !response.processCapability) return response;
    const processCapability = `proc_${token()}`;
    const record = {
      capabilityDigest: tokenDigest(processCapability),
      environmentCapability,
      environmentId: environmentRecord.environment.environmentId,
      leaseId: environmentRecord.leaseId,
      generation: environmentRecord.environment.generation,
      agentId: environmentRecord.environment.agentId,
      guestProcessCapability: response.processCapability,
      pid: Number(response.pid) || null,
      processIdentity: String(response.processIdentity || ''),
      fileIdentity: String(response.fileIdentity || ''),
      processOwner: String(response.processOwner || ''),
      intent,
    };
    if (!record.pid || !record.processIdentity || !record.fileIdentity || !record.processOwner) {
      throw brokerError('EBROKERPROCESS', 'Guest process evidence is incomplete.');
    }
    this.processes.set(processCapability, record);
    environmentRecord.processCapabilities.add(processCapability);
    return {
      ok: true,
      state: PROVIDER_STATES.ACTIVATED,
      status: 'RUNNING',
      processCapability,
      pid: record.pid,
    };
  }

  async observe(processCapability, operationId) {
    const resolved = this._process(processCapability);
    return this.provider.observe({
      environment: resolved.environment.environment,
      leaseId: resolved.environment.leaseId,
      operationId: String(operationId || `observe-${crypto.randomUUID()}`),
      processCapability: resolved.record.guestProcessCapability,
    });
  }

  async stop(processCapability, operationId) {
    const resolved = this._process(processCapability);
    const result = await this.provider.stop({
      environment: resolved.environment.environment,
      leaseId: resolved.environment.leaseId,
      operationId: String(operationId || `stop-${crypto.randomUUID()}`),
      processCapability: resolved.record.guestProcessCapability,
    });
    if (result && result.ok && result.confirmed) {
      this.processes.delete(processCapability);
      resolved.environment.processCapabilities.delete(processCapability);
    }
    return result;
  }

  async restart(processCapability, rawIntent, operationId) {
    const resolved = this._process(processCapability);
    const intent = validateLaunchIntent(rawIntent);
    if (intent.accountHandle !== resolved.environment.accountHandle) {
      throw brokerError('EBROKERACCOUNT', 'Restart account handle does not match the environment lease.');
    }
    const result = await this.provider.restart({
      environment: resolved.environment.environment,
      leaseId: resolved.environment.leaseId,
      operationId: String(operationId || `restart-${crypto.randomUUID()}`),
      processCapability: resolved.record.guestProcessCapability,
      intent,
    });
    if (!result || !result.ok || result.status !== 'RUNNING' || !result.processCapability) return result;
    resolved.record.guestProcessCapability = result.processCapability;
    resolved.record.pid = Number(result.pid) || null;
    resolved.record.processIdentity = String(result.processIdentity || '');
    resolved.record.fileIdentity = String(result.fileIdentity || '');
    resolved.record.processOwner = String(result.processOwner || '');
    resolved.record.intent = intent;
    return { ok: true, state: PROVIDER_STATES.ACTIVATED, status: 'RUNNING', processCapability, pid: resolved.record.pid };
  }

  async release(environmentCapability) {
    const record = this._environment(environmentCapability, true);
    if (record.disposed) {
      this.environments.delete(environmentCapability);
      return { ok: true, state: PROVIDER_STATES.ACTIVATED, released: true, destroyed: true };
    }
    if (record.processCapabilities.size) {
      return { ok: false, state: PROVIDER_STATES.FAILED, released: false, reason: 'Environment still owns a process capability.' };
    }
    const released = await this.provider.release({ environment: record.environment, leaseId: record.leaseId });
    if (!released || !released.ok || !released.released) return released;
    const destroyed = await this.provider.destroy({ environment: record.environment, leaseId: record.leaseId });
    if (!destroyed || !destroyed.ok || !destroyed.destroyed) return destroyed;
    this.leases.release(record.leaseId, record.leaseToken);
    this.environments.delete(environmentCapability);
    return { ok: true, state: PROVIDER_STATES.ACTIVATED, released: true, destroyed: true };
  }

  async health(environmentCapability, operationId) {
    const record = this._environment(environmentCapability);
    return this.provider.health({
      environment: record.environment,
      leaseId: record.leaseId,
      operationId: String(operationId || `health-${crypto.randomUUID()}`),
    });
  }
}

module.exports = { EnvironmentBroker, brokerError };
