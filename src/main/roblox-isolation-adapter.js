'use strict';

const ISOLATION_STATES = Object.freeze({
  UNAVAILABLE: 'UNAVAILABLE',
  LEGACY_COMPAT: 'LEGACY_COMPAT',
  QUALIFIED: 'QUALIFIED',
  ACTIVATED: 'ACTIVATED',
});

const { PROVIDER_STATES } = require('./environment-provider');
const { validateLaunchIntent } = require('./environment-rpc');

const DEFAULT_REASON = 'No independently qualified ownership-preserving Roblox isolation environment is activated.';
const adapterSelections = new WeakMap();

function result(state, reason, extra) {
  return Object.assign({
    ok: state === ISOLATION_STATES.ACTIVATED || state === ISOLATION_STATES.LEGACY_COMPAT,
    state,
    reason: String(reason || ''),
  }, extra || {});
}

/**
 * Narrow environment boundary for Roblox process isolation.
 *
 * Implementations, rather than accounts, renderers, keepers, or launch
 * planners, own every environment-specific allocation and process action.
 * A QUALIFIED adapter has evidence but is not allowed to create a process
 * until it reports ACTIVATED for the current operation.
 */
class RobloxIsolationAdapter {
  async preflight() { throw new Error('RobloxIsolationAdapter.preflight() is not implemented.'); }
  async allocateInstance() { throw new Error('RobloxIsolationAdapter.allocateInstance() is not implemented.'); }
  async launch() { throw new Error('RobloxIsolationAdapter.launch() is not implemented.'); }
  async observe() { throw new Error('RobloxIsolationAdapter.observe() is not implemented.'); }
  async stop() { throw new Error('RobloxIsolationAdapter.stop() is not implemented.'); }
  async restart() { throw new Error('RobloxIsolationAdapter.restart() is not implemented.'); }
  async release() { throw new Error('RobloxIsolationAdapter.release() is not implemented.'); }
  async health() { throw new Error('RobloxIsolationAdapter.health() is not implemented.'); }
}

/** Production adapter for the current host. It has no launch fallback. */
class UnavailableRobloxIsolationAdapter extends RobloxIsolationAdapter {
  constructor(reason) {
    super();
    this.reason = String(reason || DEFAULT_REASON);
  }

  async preflight() { return result(ISOLATION_STATES.UNAVAILABLE, this.reason); }
  async allocateInstance() { return result(ISOLATION_STATES.UNAVAILABLE, this.reason); }
  async launch() { return result(ISOLATION_STATES.UNAVAILABLE, this.reason); }
  async observe() { return result(ISOLATION_STATES.UNAVAILABLE, this.reason, { status: 'UNKNOWN' }); }
  async stop() { return result(ISOLATION_STATES.UNAVAILABLE, this.reason, { confirmed: false }); }
  async restart() { return result(ISOLATION_STATES.UNAVAILABLE, this.reason); }
  async release() { return result(ISOLATION_STATES.UNAVAILABLE, this.reason, { released: false }); }
  async health() { return result(ISOLATION_STATES.UNAVAILABLE, this.reason); }
}

/**
 * Adapter from Phase 5 launch orchestration to the Phase 6 environment broker.
 * Construction does not activate it: provider preflight must independently
 * report ACTIVATED for every operation.
 */
class BrokeredRobloxIsolationAdapter extends RobloxIsolationAdapter {
  constructor(options) {
    super();
    const opts = options || {};
    if (!opts.broker) throw new Error('BrokeredRobloxIsolationAdapter requires an EnvironmentBroker.');
    this.broker = opts.broker;
    this.environments = new Map();
  }

  _state(providerState) {
    if (providerState === PROVIDER_STATES.ACTIVATED) return ISOLATION_STATES.ACTIVATED;
    if (providerState === PROVIDER_STATES.QUALIFIED) return ISOLATION_STATES.QUALIFIED;
    return ISOLATION_STATES.UNAVAILABLE;
  }

  _result(value, extra) {
    const row = value || {};
    return result(this._state(row.state), row.reason, Object.assign({ ok: !!row.ok }, extra || {}));
  }

  async preflight() {
    const value = await this.broker.preflight();
    return this._result(value);
  }

  async allocateInstance(operation, context) {
    const value = await this.broker.allocate({
      operationId: operation.operationId,
      accountHandle: operation.accountId,
      order: operation.order,
    }, { signal: context && context.signal });
    if (value && value.ok && value.environmentId && value.environmentCapability) {
      this.environments.set(value.environmentId, value.environmentCapability);
    }
    return this._result(value, { environmentId: value && value.environmentId });
  }

  _environment(environmentId) {
    const capability = this.environments.get(String(environmentId || ''));
    if (!capability) throw new Error('No broker-owned environment matches this operation.');
    return capability;
  }

  async launch(rawIntent, context) {
    const intent = validateLaunchIntent(rawIntent);
    const value = await this.broker.executeLaunchIntent(
      this._environment(context && context.environmentId),
      intent,
      context && context.operation && context.operation.operationId,
      { signal: context && context.signal },
    );
    return this._result(value, {
      capability: value && value.processCapability,
      pid: value && value.pid,
      stable: value && value.status === 'RUNNING',
    });
  }

  async observe(capability, options) {
    const value = await this.broker.observe(capability, options && options.operationId);
    return this._result(value, { status: value && value.status, pid: value && value.pid });
  }

  async stop(capability, options) {
    const value = await this.broker.stop(capability, options && options.operationId);
    return this._result(value, { confirmed: !!(value && value.confirmed) });
  }

  async restart(rawIntent, context) {
    const intent = validateLaunchIntent(rawIntent);
    const value = await this.broker.restart(
      context && context.capability,
      intent,
      context && context.operation && `restart-${context.operation.operationId}`,
    );
    return this._result(value, { capability: value && value.processCapability, pid: value && value.pid });
  }

  async release(environmentId) {
    const capability = this._environment(environmentId);
    const value = await this.broker.release(capability);
    if (value && value.ok && value.released) this.environments.delete(String(environmentId));
    return this._result(value, { released: !!(value && value.released) });
  }

  async health(options) {
    if (!options || !options.environmentId) return this.preflight();
    const value = await this.broker.health(this._environment(options.environmentId));
    return this._result(value, { status: value && value.status });
  }
}

function isActivated(value) {
  return !!value && isExecutionEnabledState(value.state);
}

function isExecutionEnabledState(state) {
  return state === ISOLATION_STATES.ACTIVATED || state === ISOLATION_STATES.LEGACY_COMPAT;
}

function legacyCompatRequested(environment) {
  const env = environment || process.env;
  return env.LEGACY_COMPAT === '1';
}

function environmentValue(environment) {
  const env = environment || process.env;
  return Object.prototype.hasOwnProperty.call(env, 'LEGACY_COMPAT')
    ? String(env.LEGACY_COMPAT)
    : 'ABSENT';
}

function recordSelection(adapter, environment, legacyCompatEnabled, reason) {
  const selection = Object.freeze({
    legacyCompatEnabled,
    legacyCompatEnvironmentValue: environmentValue(environment),
    selectedAdapter: adapter && adapter.constructor && adapter.constructor.name
      ? adapter.constructor.name
      : 'UnknownRobloxIsolationAdapter',
    isolationState: legacyCompatEnabled
      ? ISOLATION_STATES.LEGACY_COMPAT
      : ISOLATION_STATES.UNAVAILABLE,
    reason: String(reason || DEFAULT_REASON),
  });
  adapterSelections.set(adapter, selection);
  return adapter;
}

function adapterSelectionDiagnostics(adapter) {
  const selection = adapterSelections.get(adapter);
  if (!selection) throw new Error('Roblox isolation adapter was not created by the runtime selector.');
  return Object.assign({}, selection);
}

/**
 * Keep the legacy implementation entirely unloaded unless the exact local
 * opt-in is present. Merely having the compatibility source in an artifact
 * cannot activate it or change the production default.
 */
function selectRobloxIsolationAdapter(options) {
  const opts = options || {};
  const environment = opts.environment || process.env;
  const enabled = legacyCompatRequested(environment);
  if (!enabled) {
    const adapter = new UnavailableRobloxIsolationAdapter(opts.reason);
    return recordSelection(adapter, environment, false, adapter.reason);
  }
  const loadLegacy = opts.loadLegacy || (() => require('./legacy-roblox-isolation-adapter').LegacyRobloxIsolationAdapter);
  const LegacyRobloxIsolationAdapter = loadLegacy();
  const adapter = new LegacyRobloxIsolationAdapter(opts.legacyOptions || {});
  return recordSelection(adapter, environment, true, opts.reason);
}

module.exports = {
  DEFAULT_REASON,
  BrokeredRobloxIsolationAdapter,
  ISOLATION_STATES,
  RobloxIsolationAdapter,
  UnavailableRobloxIsolationAdapter,
  adapterSelectionDiagnostics,
  isActivated,
  isExecutionEnabledState,
  legacyCompatRequested,
  result,
  selectRobloxIsolationAdapter,
};
