'use strict';

const STATES = Object.freeze({
  REQUESTED: 'REQUESTED',
  VALIDATING: 'VALIDATING',
  PREPARING: 'PREPARING',
  LAUNCHING: 'LAUNCHING',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  STOPPING: 'STOPPING',
  STOPPED: 'STOPPED',
  RESTARTING: 'RESTARTING',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
});

const ALLOWED = Object.freeze({
  REQUESTED: new Set(['VALIDATING', 'FAILED']),
  VALIDATING: new Set(['PREPARING', 'FAILED']),
  PREPARING: new Set(['LAUNCHING', 'FAILED']),
  LAUNCHING: new Set(['STARTING', 'FAILED']),
  STARTING: new Set(['RUNNING', 'STOPPING', 'FAILED', 'UNKNOWN']),
  RUNNING: new Set(['STOPPING', 'RESTARTING', 'FAILED', 'UNKNOWN']),
  STOPPING: new Set(['STOPPED', 'FAILED', 'UNKNOWN']),
  STOPPED: new Set(['RESTARTING']),
  RESTARTING: new Set(['VALIDATING', 'FAILED']),
  FAILED: new Set(['RESTARTING']),
  UNKNOWN: new Set(['STOPPING', 'STOPPED', 'RESTARTING', 'FAILED']),
});

class LifecycleMachine {
  constructor(options) {
    const opts = options || {};
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.instanceId = String(opts.instanceId || '');
    this.state = STATES.REQUESTED;
    this.revision = 1;
    this.reason = '';
    this.result = null;
    this.history = [{ revision: 1, state: this.state, at: new Date(this.now()).toISOString(), reason: '' }];
  }

  transition(next, details) {
    if (!Object.prototype.hasOwnProperty.call(STATES, next)) throw new Error(`Unknown lifecycle state: ${next}`);
    if (!ALLOWED[this.state].has(next)) throw new Error(`Invalid lifecycle transition: ${this.state} -> ${next}`);
    this.state = next;
    this.revision += 1;
    this.reason = String(details && details.reason || '');
    if (details && Object.prototype.hasOwnProperty.call(details, 'result')) this.result = details.result;
    this.history.push({
      revision: this.revision,
      state: next,
      at: new Date(this.now()).toISOString(),
      reason: this.reason,
    });
    return this.snapshot();
  }

  snapshot() {
    return {
      instanceId: this.instanceId,
      state: this.state,
      revision: this.revision,
      reason: this.reason,
      result: this.result,
      history: this.history.map(entry => Object.assign({}, entry)),
    };
  }
}

class ProcessLifecycleController {
  constructor(options) {
    const opts = options || {};
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.sleep = typeof opts.sleep === 'function' ? opts.sleep : ms => new Promise(resolve => setTimeout(resolve, ms));
    this.validate = opts.validate;
    this.prepare = opts.prepare;
    this.spawn = opts.spawn;
    this.inspect = opts.inspect;
    this.stopOwned = opts.stopOwned;
    this.startupTimeoutMs = Math.max(1, Number(opts.startupTimeoutMs) || 15000);
    this.stableRunningMs = Math.max(1, Number(opts.stableRunningMs) || 1500);
    this.pollMs = Math.max(1, Number(opts.pollMs) || 100);
    this.maxRestarts = Math.max(0, Number(opts.maxRestarts) || 2);
    this.restarts = 0;
    this.machine = new LifecycleMachine({ instanceId: opts.instanceId, now: this.now });
    this.owned = null;
    for (const [name, value] of Object.entries({
      validate: this.validate,
      prepare: this.prepare,
      spawn: this.spawn,
      inspect: this.inspect,
      stopOwned: this.stopOwned,
    })) {
      if (typeof value !== 'function') throw new Error(`Lifecycle dependency ${name} is required.`);
    }
  }

  async launch(spec, restarting) {
    if (restarting) this.machine.transition(STATES.VALIDATING);
    else this.machine.transition(STATES.VALIDATING);
    try {
      const validation = await this.validate(spec);
      if (!validation || validation.ok !== true) return this._fail(validation && validation.reason || 'Launch validation failed.');
      this.machine.transition(STATES.PREPARING);
      const prepared = await this.prepare(spec, validation);
      if (!prepared || prepared.ok !== true) return this._fail(prepared && prepared.reason || 'Launch preparation failed.');
      this.machine.transition(STATES.LAUNCHING);
      const spawned = await this.spawn(spec, prepared);
      if (!spawned || spawned.ok !== true || !spawned.capability) return this._fail(spawned && spawned.reason || 'Process spawn failed.');
      this.owned = { capability: spawned.capability, pid: spawned.pid || null };
      this.machine.transition(STATES.STARTING);
      const deadline = this.now() + this.startupTimeoutMs;
      let stableSince = null;
      while (this.now() < deadline) {
        let observation;
        try {
          observation = await this.inspect(this.owned.capability);
        } catch (error) {
          observation = { status: 'UNKNOWN', reason: error.message };
        }
        if (observation && observation.status === 'EXITED') {
          return this._fail('Owned process exited before reaching stable running state.');
        }
        if (observation && observation.status === 'RUNNING') {
          if (stableSince == null) stableSince = this.now();
          if (this.now() - stableSince >= this.stableRunningMs) {
            return this.machine.transition(STATES.RUNNING, { result: { ok: true, owned: this.owned } });
          }
        } else {
          stableSince = null;
        }
        await this.sleep(this.pollMs);
      }
      const stopped = await this._stopAfterFailedStart();
      if (!stopped) {
        this.machine.transition(STATES.UNKNOWN, { reason: 'Startup timed out and owned-process termination was not confirmed.' });
        return this.machine.snapshot();
      }
      return this._fail('Startup timed out before stable-running verification.');
    } catch (error) {
      return this._fail(`Lifecycle operation failed: ${error.message}`);
    }
  }

  async _stopAfterFailedStart() {
    if (!this.owned) return true;
    try {
      const result = await this.stopOwned(this.owned.capability);
      return !!(result && result.ok && result.confirmed);
    } catch (_) {
      return false;
    }
  }

  _fail(reason) {
    if (this.machine.state === STATES.UNKNOWN) return this.machine.snapshot();
    this.machine.transition(STATES.FAILED, { reason: String(reason || 'Lifecycle failed.'), result: { ok: false } });
    return this.machine.snapshot();
  }

  async stop() {
    if (![STATES.RUNNING, STATES.STARTING, STATES.UNKNOWN].includes(this.machine.state)) {
      throw new Error(`Cannot stop lifecycle from ${this.machine.state}.`);
    }
    this.machine.transition(STATES.STOPPING);
    try {
      const result = await this.stopOwned(this.owned && this.owned.capability);
      if (result && result.ok && result.confirmed) {
        this.owned = null;
        return this.machine.transition(STATES.STOPPED, { result });
      }
      return this.machine.transition(STATES.UNKNOWN, { reason: result && result.reason || 'Termination was not confirmed.', result });
    } catch (error) {
      return this.machine.transition(STATES.UNKNOWN, { reason: error.message, result: { ok: false } });
    }
  }

  async restart(spec) {
    if (this.restarts >= this.maxRestarts) return this._fail('Bounded restart limit reached.');
    if ([STATES.RUNNING, STATES.STARTING, STATES.UNKNOWN].includes(this.machine.state)) {
      const stopped = await this.stop();
      if (stopped.state !== STATES.STOPPED) return stopped;
    }
    if (![STATES.STOPPED, STATES.FAILED].includes(this.machine.state)) {
      throw new Error(`Cannot restart lifecycle from ${this.machine.state}.`);
    }
    this.restarts += 1;
    this.machine.transition(STATES.RESTARTING, { reason: `Restart attempt ${this.restarts} of ${this.maxRestarts}.` });
    return this.launch(spec, true);
  }
}

module.exports = { STATES, ALLOWED, LifecycleMachine, ProcessLifecycleController };
