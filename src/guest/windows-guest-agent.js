'use strict';

const crypto = require('crypto');
const { ProcessLifecycleController, STATES } = require('../main/process-lifecycle');
const { canonical, validateLaunchIntent } = require('../main/environment-rpc');

function agentError(code, message) {
  const error = new Error(String(message || code));
  error.code = code;
  return error;
}

function processIdentity(value) {
  const row = value && typeof value === 'object' ? value : {};
  const required = ['processIdentity', 'fileIdentity', 'executablePath', 'processOwner'];
  if (!Number.isSafeInteger(Number(row.pid)) || Number(row.pid) < 1) {
    throw agentError('EAGENTPROCESS', 'Guest launch did not return a valid PID.');
  }
  for (const field of required) {
    if (!String(row[field] || '').trim()) throw agentError('EAGENTPROCESS', `Guest process ${field} is missing.`);
  }
  return {
    pid: Number(row.pid),
    processIdentity: String(row.processIdentity),
    fileIdentity: String(row.fileIdentity),
    executablePath: String(row.executablePath),
    processOwner: String(row.processOwner),
  };
}

class GuestLocalCredentialVault {
  constructor(options) {
    const opts = options || {};
    if (opts.guestLocal !== true || typeof opts.resolve !== 'function') {
      throw agentError('EAGENTVAULT', 'Credential vault must be guest-local and expose resolve(accountHandle).');
    }
    this.guestLocal = true;
    this.resolve = opts.resolve;
  }
}

class WindowsGuestAgent {
  constructor(options) {
    const opts = options || {};
    if (!opts.endpoint || !opts.binding || !opts.launcher || !opts.credentialVault) {
      throw agentError('EAGENTCONFIG', 'Guest agent requires an authenticated endpoint, binding, launcher, and guest-local vault.');
    }
    if (!opts.syntheticTestOnly && (!opts.buildIdentity || opts.buildIdentity.signatureStatus !== 'VALID')) {
      throw agentError('EAGENTSIGNATURE', 'Production guest agent requires a validated signed build identity.');
    }
    if (opts.credentialVault.guestLocal !== true) {
      throw agentError('EAGENTVAULT', 'Host credential stores cannot be attached to the guest agent.');
    }
    this.endpoint = opts.endpoint;
    this.binding = Object.freeze(Object.assign({}, opts.binding));
    this.launcher = opts.launcher;
    this.vault = opts.credentialVault;
    this.buildIdentity = Object.freeze(Object.assign({}, opts.buildIdentity || {
      buildId: 'SYNTHETIC-TEST-ONLY', signatureStatus: 'TEST_ONLY',
    }));
    this.syntheticTestOnly = opts.syntheticTestOnly === true;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.processes = new Map();
    this.operations = new Map();
    this.revoked = false;
  }

  async handle(envelope) {
    if (this.revoked) throw agentError('EAGENTREVOKED', 'Guest-agent lease is revoked.');
    const command = this.endpoint.open(envelope);
    const operationKey = command.operationId;
    const commandDigest = crypto.createHash('sha256').update(canonical({ action: command.action, body: command.body })).digest('hex');
    const prior = this.operations.get(operationKey);
    if (prior) {
      if (prior.commandDigest !== commandDigest) {
        return this._reply(command, { ok: false, code: 'EAGENTIDEMPOTENCY', reason: 'Operation identity was reused for a different command.' });
      }
      return this._reply(command, prior.response);
    }
    let response;
    try {
      response = await this._dispatch(command);
    } catch (error) {
      response = { ok: false, code: String(error.code || 'EAGENTCOMMAND'), reason: String(error.message || error) };
    }
    this.operations.set(operationKey, { commandDigest, response });
    return this._reply(command, response);
  }

  _reply(command, response) {
    return this.endpoint.seal('RESPONSE', response, {
      operationId: command.operationId,
      ttlMs: Math.max(1, command.expiresAt - this.now()),
    });
  }

  async _dispatch(command) {
    switch (command.action) {
      case 'HEALTH': return this._health();
      case 'EXECUTE_LAUNCH_INTENT': return this._launch(command.body, command.operationId);
      case 'OBSERVE': return this._observe(command.body && command.body.processCapability);
      case 'STOP': return this._stop(command.body && command.body.processCapability);
      case 'RESTART': return this._restart(command.body, command.operationId);
      case 'REVOKE': return this._revoke();
      default: throw agentError('EAGENTACTION', `Guest agent rejected unknown action ${command.action}.`);
    }
  }

  _health() {
    return {
      ok: true,
      status: 'READY',
      environmentId: this.binding.environmentId,
      leaseId: this.binding.leaseId,
      generation: this.binding.generation,
      agentId: this.binding.agentId,
      buildIdentity: this.buildIdentity,
      processCount: Array.from(this.processes.values()).filter(row => row.state === 'RUNNING').length,
    };
  }

  async _launch(rawIntent, operationId) {
    const intent = validateLaunchIntent(rawIntent);
    if (Array.from(this.processes.values()).some(row => row.state === 'RUNNING')) {
      throw agentError('EAGENTCAP', 'Guest process cap is one and this environment already owns a running process.');
    }
    let preparedCredential = null;
    const processCapability = `gpc_${crypto.randomBytes(32).toString('base64url')}`;
    const controller = new ProcessLifecycleController({
      instanceId: operationId,
      now: this.now,
      startupTimeoutMs: 2000,
      stableRunningMs: this.syntheticTestOnly ? 10 : 1500,
      pollMs: this.syntheticTestOnly ? 2 : 100,
      maxRestarts: 2,
      validate: async () => ({ ok: true }),
      prepare: async () => {
        preparedCredential = await this.vault.resolve(intent.accountHandle);
        if (!preparedCredential) return { ok: false, reason: 'Guest-local account handle is not provisioned.' };
        return { ok: true };
      },
      spawn: async () => {
        const launched = await this.launcher.spawn({
          credential: preparedCredential,
          target: intent.target,
          operationId,
          environment: this.binding,
        });
        preparedCredential = null;
        if (!launched || launched.ok !== true) {
          return { ok: false, reason: launched && launched.reason || 'Guest-local launch failed.' };
        }
        const identity = processIdentity(launched);
        const record = {
          processCapability,
          operationId,
          environmentId: this.binding.environmentId,
          agentId: this.binding.agentId,
          leaseId: this.binding.leaseId,
          generation: this.binding.generation,
          state: 'STARTING',
          identity,
          intent,
          controller: null,
        };
        this.processes.set(processCapability, record);
        return { ok: true, capability: processCapability, pid: identity.pid };
      },
      inspect: async capability => this._inspectOwned(capability),
      stopOwned: async capability => this._stopOwned(capability),
    });
    const result = await controller.launch({ operationId });
    preparedCredential = null;
    const record = this.processes.get(processCapability);
    if (!record || result.state !== STATES.RUNNING) {
      if (record) record.state = result.state;
      throw agentError('EAGENTLAUNCH', result.reason || 'Guest process did not reach stable running.');
    }
    record.controller = controller;
    record.state = 'RUNNING';
    return {
      ok: true,
      status: 'RUNNING',
      processCapability,
      pid: record.identity.pid,
      processIdentity: record.identity.processIdentity,
      fileIdentity: record.identity.fileIdentity,
      processOwner: record.identity.processOwner,
      generation: record.generation,
    };
  }

  _record(capability) {
    const record = this.processes.get(String(capability || ''));
    if (!record) throw agentError('EAGENTCAPABILITY', 'Guest process capability is unknown.');
    if (record.environmentId !== this.binding.environmentId || record.agentId !== this.binding.agentId
        || record.leaseId !== this.binding.leaseId || record.generation !== this.binding.generation) {
      throw agentError('EAGENTBINDING', 'Guest process capability binding is invalid.');
    }
    return record;
  }

  async _inspectOwned(capability) {
    const record = this._record(capability);
    const observation = await this.launcher.inspect(record.identity);
    if (!observation || !['RUNNING', 'EXITED', 'UNKNOWN'].includes(observation.status)) return { status: 'UNKNOWN' };
    if (observation.status === 'RUNNING') {
      const actual = processIdentity(observation);
      for (const field of ['pid', 'processIdentity', 'fileIdentity', 'executablePath', 'processOwner']) {
        if (actual[field] !== record.identity[field]) return { status: 'UNKNOWN', reason: 'Guest process identity was replaced.' };
      }
    }
    return observation;
  }

  async _observe(capability) {
    const record = this._record(capability);
    const observation = await this._inspectOwned(capability);
    if (observation.status !== 'RUNNING') record.state = observation.status;
    return {
      ok: observation.status !== 'UNKNOWN',
      status: observation.status,
      pid: record.identity.pid,
      processIdentity: record.identity.processIdentity,
      generation: record.generation,
      reason: observation.reason || '',
    };
  }

  async _stopOwned(capability) {
    const record = this._record(capability);
    const result = await this.launcher.stop(record.identity);
    if (result && result.ok && result.confirmed) record.state = 'STOPPED';
    return result;
  }

  async _stop(capability) {
    const record = this._record(capability);
    const result = record.controller ? await record.controller.stop() : null;
    const confirmed = !!(result && result.state === STATES.STOPPED);
    return { ok: confirmed, confirmed, status: confirmed ? 'STOPPED' : 'UNKNOWN', reason: result && result.reason || '' };
  }

  async _restart(body, operationId) {
    const input = body && typeof body === 'object' ? body : {};
    const record = this._record(input.processCapability);
    const intent = validateLaunchIntent(input.intent);
    const stopped = await this._stop(record.processCapability);
    if (!stopped.ok) return stopped;
    return this._launch(intent, operationId);
  }

  async _revoke() {
    const active = Array.from(this.processes.values()).filter(row => row.state === 'RUNNING');
    for (const record of active) await this._stop(record.processCapability);
    this.revoked = true;
    return { ok: true, revoked: true };
  }
}

module.exports = {
  GuestLocalCredentialVault,
  WindowsGuestAgent,
  agentError,
  processIdentity,
};
