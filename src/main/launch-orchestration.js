'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');
const { ISOLATION_STATES, isActivated } = require('./roblox-isolation-adapter');
const { MAX_LEGACY_MANAGED_CLIENTS } = require('./legacy-capacity');

const PLAN_NAMESPACE = 'launch-plans-v1';
const PLAN_STATES = Object.freeze({
  PREPARED: 'PREPARED',
  BLOCKED: 'BLOCKED',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
  CANCEL_REQUESTED: 'CANCEL_REQUESTED',
  CANCELLED: 'CANCELLED',
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
});
const OP_FINAL = new Set(['RUNNING', 'BLOCKED', 'UNAVAILABLE', 'FAILED', 'CANCELLED', 'STOPPED', 'UNKNOWN']);
const PLAN_TERMINAL = new Set([
  PLAN_STATES.BLOCKED,
  PLAN_STATES.COMPLETED,
  PLAN_STATES.PARTIAL,
  PLAN_STATES.FAILED,
  PLAN_STATES.CANCELLED,
  PLAN_STATES.RECOVERY_REQUIRED,
]);
const SENSITIVE_KEY = /(cookie|ticket|credential|password|secret|deeplink|auth)/i;

function classifyLaunchFailure(input) {
  const raw = String(input || '');
  const value = raw.toLowerCase();
  if (/robloxplayerbeta\.exe was not found|roblox player was not found|roblox not found/.test(value)) {
    return { code: 'ROBLOX_NOT_FOUND', reason: 'Roblox Player was not found. Re-detect it or choose RobloxPlayerBeta.exe in Settings.', actions: ['REDETECT_ROBLOX', 'OPEN_SETTINGS', 'VIEW_DIAGNOSTICS'] };
  }
  if (/microsoft store roblox|store app|classic roblox player/.test(value) && /legacy|multi-instance|not compatible|supports/.test(value)) {
    return { code: 'STORE_LEGACY_UNSUPPORTED', reason: 'Microsoft Store Roblox is not available for SUNDAY Multi-instance mode. Install the classic Roblox Player from roblox.com, then re-detect.', actions: ['REDETECT_ROBLOX', 'OPEN_SETTINGS', 'VIEW_DIAGNOSTICS'] };
  }
  if (/normal mode launches one client|multi-instance mode/.test(value) && /enable/.test(value)) {
    return { code: 'MULTI_INSTANCE_DISABLED', reason: 'Multi-instance mode is disabled. Enable it in Settings and restart SUNDAY.', actions: ['OPEN_SETTINGS'] };
  }
  if (/already running|will not adopt/.test(value)) {
    return { code: 'CLIENT_ALREADY_RUNNING', reason: 'A Roblox client is already running. SUNDAY will not adopt or replace it.', actions: ['RETRY', 'VIEW_DIAGNOSTICS'] };
  }
  if (/capacity reached|active or in-flight managed clients|safety ceiling/.test(value)) {
    return { code: 'CAPACITY_REACHED', reason: `SUNDAY supports up to ${MAX_LEGACY_MANAGED_CLIENTS} simultaneous managed clients. Stop a managed client or wait for an in-flight launch to finish.`, actions: ['VIEW_DIAGNOSTICS'] };
  }
  if (/already has an active or in-flight sunday-managed client/.test(value)) {
    return { code: 'DUPLICATE_ACCOUNT_OPERATION', reason: 'That account already has an active or in-flight SUNDAY-managed client.', actions: ['VIEW_DIAGNOSTICS'] };
  }
  if (/startup error dialog/.test(value)) {
    return { code: 'ROBLOX_STARTUP_ERROR', reason: 'Roblox opened a startup error dialog.', actions: ['RETRY', 'VIEW_DIAGNOSTICS'] };
  }
  if (/exited during startup|exited before reaching/.test(value)) {
    return { code: 'PROCESS_EXITED', reason: 'Roblox exited during startup.', actions: ['RETRY', 'VIEW_DIAGNOSTICS'] };
  }
  if (/singleton event|singleton names|singleton ownership/.test(value)) {
    return {
      code: 'SINGLETON_GUARD_UNAVAILABLE',
      reason: "Multi-instance compatibility could not reserve Roblox's singleton event. Close Roblox Player and other multi-instance launchers, then retry.",
      actions: ['RETRY', 'VIEW_DIAGNOSTICS'],
    };
  }
  if (/ownership|identity|could not be proven/.test(value)) {
    return { code: 'OWNERSHIP_NOT_VERIFIED', reason: 'SUNDAY could not verify ownership of the launched Roblox process.', actions: ['RETRY', 'VIEW_DIAGNOSTICS'] };
  }
  if (/changed.*roblox|roblox installation changed|executable changed/.test(value)) {
    return { code: 'EXECUTABLE_CHANGED', reason: 'Your Roblox installation changed. Re-detect Roblox in Settings.', actions: ['OPEN_SETTINGS', 'VIEW_DIAGNOSTICS'] };
  }
  if (/timed out|timeout|did not become ready|did not reach a stable running window/.test(value)) {
    return { code: 'STARTUP_TIMEOUT', reason: 'Roblox startup timed out before a stable running state was verified.', actions: ['RETRY', 'VIEW_DIAGNOSTICS'] };
  }
  if (/fresh roblox authentication|fresh roblox sign-in|launch intent could not be resolved|session expired/.test(value)) {
    return { code: 'AUTHENTICATION_FAILED', reason: 'SUNDAY could not create a fresh Roblox sign-in for this account. Sign in again and retry.', actions: ['OPEN_ACCOUNTS', 'RETRY'] };
  }
  if (/slot|clone|legacy environment/.test(value)) {
    return { code: 'SLOT_PREPARATION_FAILED', reason: 'Multi-instance compatibility could not prepare a safe client slot.', actions: ['RETRY', 'VIEW_DIAGNOSTICS'] };
  }
  if (/windows could not start roblox|process creation did not return a pid|spawn/.test(value)) {
    return { code: 'SPAWN_FAILED', reason: 'Windows could not start Roblox.', actions: ['RETRY', 'OPEN_SETTINGS', 'VIEW_DIAGNOSTICS'] };
  }
  if (/environment release was not confirmed|cleanup.*not confirmed/.test(value)) {
    return {
      code: 'CLEANUP_UNCONFIRMED',
      reason: 'SUNDAY could not confirm allocated environment cleanup. Recovery is required before this slot can be reused.',
      actions: ['VIEW_DIAGNOSTICS'],
    };
  }
  if (/cancel/.test(value)) {
    return { code: 'CANCELLED', reason: 'Launch was cancelled.', actions: [] };
  }
  return { code: 'LAUNCH_FAILED', reason: 'Roblox could not be launched. Retry, then view Diagnostics if it continues.', actions: ['RETRY', 'VIEW_DIAGNOSTICS'] };
}

function copy(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function nowIso(now) { return new Date(now()).toISOString(); }
function id(prefix) { return `${prefix}-${crypto.randomUUID()}`; }

function assertNoSecrets(value, trail) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`Launch plans cannot persist sensitive field ${trail}${key}.`);
    if (nested && typeof nested === 'object') assertNoSecrets(nested, `${trail}${key}.`);
  }
}

function sanitizeTarget(input) {
  const raw = input && typeof input === 'object' ? input : {};
  assertNoSecrets(raw, 'target.');
  const type = String(raw.type || 'HOME').toUpperCase();
  const allowed = new Set(['HOME', 'CLIENT', 'PLACE', 'EXACT_SERVER', 'FOLLOW_PERSON', 'FOLLOW_ACCOUNT']);
  if (!allowed.has(type)) throw new Error(`Unsupported launch target: ${type}`);
  const target = { type };
  if (raw.placeId != null && String(raw.placeId).trim()) {
    target.placeId = String(raw.placeId).trim();
    if (!/^\d+$/.test(target.placeId)) throw new Error('Place ID must be numeric.');
  }
  if (raw.serverId != null && String(raw.serverId).trim()) target.serverId = String(raw.serverId).trim().slice(0, 160);
  if (raw.targetUserId != null) {
    const numeric = Number(raw.targetUserId);
    if (!Number.isSafeInteger(numeric) || numeric <= 0) throw new Error('Target user ID is invalid.');
    target.targetUserId = numeric;
  }
  if (raw.targetAccountId != null && String(raw.targetAccountId).trim()) {
    target.targetAccountId = String(raw.targetAccountId).trim().slice(0, 160);
  }
  if (raw.name != null) target.name = String(raw.name).slice(0, 80);
  if (type === 'EXACT_SERVER' && (!target.placeId || !target.serverId)) throw new Error('Exact-server targets require place and server IDs.');
  if (type === 'FOLLOW_PERSON' && !target.targetUserId) throw new Error('Follow-person targets require a user ID.');
  if (type === 'FOLLOW_ACCOUNT' && !target.targetAccountId) throw new Error('Follow-account targets require an account ID.');
  return target;
}

function sanitizeParticipants(input) {
  const seen = new Set();
  const rows = [];
  for (const item of (Array.isArray(input) ? input : [])) {
    const accountId = String(item && item.accountId || '').trim();
    if (!accountId || seen.has(accountId)) continue;
    seen.add(accountId);
    rows.push({ accountId: accountId.slice(0, 160), label: String(item.label || item.username || accountId).slice(0, 80) });
  }
  if (!rows.length) throw new Error('Choose at least one account.');
  if (rows.length > MAX_LEGACY_MANAGED_CLIENTS) {
    throw new Error(`SUNDAY Launcher launch plans support at most ${MAX_LEGACY_MANAGED_CLIENTS} accounts.`);
  }
  return rows;
}

class LaunchPlanner {
  constructor(options) {
    this.now = options && options.now || (() => Date.now());
  }

  create(input) {
    const participants = sanitizeParticipants(input && input.participants);
    const defaultTarget = sanitizeTarget(input && input.target);
    const targetsByAccount = input && input.targetsByAccount || {};
    assertNoSecrets(targetsByAccount, 'targetsByAccount.');
    const createdAt = nowIso(this.now);
    return {
      schemaVersion: 1,
      planId: id('plan'),
      name: String(input && input.name || 'Launch plan').slice(0, 80),
      state: PLAN_STATES.PREPARED,
      reason: '',
      failureCode: '',
      createdAt,
      updatedAt: createdAt,
      launchDelayMs: Math.max(0, Math.min(20000, Number(input && input.launchDelayMs) || 0)),
      keepAlive: !!(input && input.keepAlive),
      operations: participants.map((participant, index) => ({
        operationId: id('operation'),
        order: index + 1,
        accountId: participant.accountId,
        label: participant.label,
        target: sanitizeTarget(targetsByAccount[participant.accountId] || defaultTarget),
        state: 'PREPARED',
        reason: '',
        failureCode: '',
        failureStage: '',
        environmentId: null,
        instanceId: null,
        capability: null,
        pid: null,
        updatedAt: createdAt,
      })),
    };
  }
}

class LaunchPlanStore {
  constructor(options) {
    const opts = options || {};
    if (!opts.database) throw new Error('LaunchPlanStore requires transactional state storage.');
    this.database = opts.database;
    this.now = opts.now || (() => Date.now());
  }

  create(plan) {
    const persisted = this._persistable(plan);
    assertNoSecrets(persisted, 'plan.');
    return this.database.put(PLAN_NAMESPACE, plan.planId, persisted, { expectedRevision: 0 }).value;
  }

  get(planId) {
    const row = this.database.get(PLAN_NAMESPACE, String(planId || ''), null);
    return row.found ? row.value : null;
  }

  list(limit) {
    const max = Math.max(1, Math.min(200, Number(limit) || 30));
    return this.database.list(PLAN_NAMESPACE)
      .map(row => row.value)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, max);
  }

  update(planId, mutator) {
    return this.database.update(PLAN_NAMESPACE, String(planId || ''), null, current => {
      if (!current) throw new Error('Unknown launch plan.');
      const next = mutator(copy(current)) || current;
      next.updatedAt = nowIso(this.now);
      const persisted = this._persistable(next);
      assertNoSecrets(persisted, 'plan.');
      return persisted;
    }).value;
  }

  _persistable(plan) {
    const persisted = copy(plan);
    for (const operation of (persisted.operations || [])) operation.capability = null;
    return persisted;
  }

  recoverInterrupted(restoredOwnership) {
    const restored = new Map((Array.isArray(restoredOwnership) ? restoredOwnership : [])
      .map(item => [String(item && item.operationId || ''), item]));
    const recovered = [];
    for (const plan of this.list(200)) {
      const interrupted = (plan.operations || []).some(operation =>
        operation.state === 'RUNNING' || !OP_FINAL.has(operation.state));
      if (!interrupted) continue;
      this.update(plan.planId, current => {
        let rebound = 0;
        let unknown = 0;
        for (const operation of current.operations) {
          if (operation.state === 'RUNNING') {
            const evidence = restored.get(operation.operationId);
            const matches = evidence
              && String(evidence.accountId || '') === String(operation.accountId || '')
              && String(evidence.instanceId || '') === String(operation.instanceId || '');
            if (matches) {
              operation.state = 'RUNNING';
              operation.environmentId = evidence.environmentId;
              operation.instanceId = evidence.instanceId;
              operation.pid = Number(evidence.pid) || null;
              operation.reason = '';
              rebound += 1;
            } else {
              unknown += 1;
              operation.state = 'UNKNOWN';
              operation.reason = 'Persisted ownership evidence did not match a live Roblox process.';
              operation.pid = null;
            }
            operation.capability = null;
            operation.updatedAt = nowIso(this.now);
          } else if (!OP_FINAL.has(operation.state)) {
            unknown += 1;
            operation.state = 'UNKNOWN';
            operation.reason = 'SUNDAY restarted before this launch operation reached a final state.';
            operation.capability = null;
            operation.pid = null;
            operation.updatedAt = nowIso(this.now);
          }
        }
        if (unknown) {
          current.state = PLAN_STATES.RECOVERY_REQUIRED;
          current.reason = 'SUNDAY restarted and one or more operations could not be rebound to exact persisted ownership evidence.';
        } else if (rebound === current.operations.length) {
          current.state = PLAN_STATES.COMPLETED;
          current.reason = '';
        } else if (rebound) {
          current.state = PLAN_STATES.PARTIAL;
          current.reason = '';
        }
        return current;
      });
      recovered.push(plan.planId);
    }
    return recovered;
  }
}

class LaunchCoordinator extends EventEmitter {
  constructor(options) {
    super();
    const opts = options || {};
    if (!opts.adapter || !opts.store) throw new Error('LaunchCoordinator requires an adapter and plan store.');
    this.adapter = opts.adapter;
    this.store = opts.store;
    this.planner = opts.planner || new LaunchPlanner({ now: opts.now });
    this.resolveIntent = opts.resolveIntent || (async operation => ({
      ok: true,
      intent: { accountHandle: operation.accountId, target: operation.target },
    }));
    this.sleep = opts.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = opts.now || (() => Date.now());
    this.operationTimeoutMs = Math.max(100, Number(opts.operationTimeoutMs) || 30000);
    this.active = new Map();
    this.operationCapabilities = new Map();
    this.lifecycleActions = new Map();
    const restoredOwnership = typeof this.adapter.restoredOwnership === 'function'
      ? this.adapter.restoredOwnership()
      : [];
    this.recovered = this.store.recoverInterrupted(restoredOwnership);
    for (const evidence of restoredOwnership) {
      const plan = this.store.list(200).find(item => (item.operations || [])
        .some(operation => operation.operationId === evidence.operationId && operation.state === 'RUNNING'));
      if (plan && evidence.capability) this.operationCapabilities.set(evidence.operationId, evidence.capability);
    }
  }

  _emit(plan) {
    const snapshot = copy(plan);
    this.emit('update', snapshot);
    return snapshot;
  }

  _update(planId, mutator) { return this._emit(this.store.update(planId, mutator)); }

  get(planId) { return this.store.get(planId); }
  list(limit) { return this.store.list(limit); }

  findOperationByCapability(capability) {
    const token = String(capability || '');
    const operationId = Array.from(this.operationCapabilities.entries())
      .find(([, value]) => value === token)?.[0];
    if (!operationId) return null;
    for (const plan of this.store.list(200)) {
      const operation = (plan.operations || []).find(item => item.operationId === operationId);
      if (operation) return { plan, operation };
    }
    return null;
  }

  capabilityForOperation(operationId) {
    return this.operationCapabilities.get(String(operationId || '')) || '';
  }

  _withRuntimeCapabilities(plan) {
    const materialized = copy(plan);
    for (const operation of (materialized && materialized.operations || [])) {
      operation.capability = this.capabilityForOperation(operation.operationId) || null;
    }
    return materialized;
  }

  async prepare(input) {
    const plan = this.store.create(this.planner.create(input));
    this._emit(plan);
    return this.run(plan.planId);
  }

  async run(planId) {
    let plan = this.store.get(planId);
    if (!plan) throw new Error('Unknown launch plan.');
    if (this.active.has(plan.planId)) return this._response(this.store.get(plan.planId));

    const controller = new AbortController();
    const runtime = { controller, environments: new Map(), capabilities: new Map() };
    this.active.set(plan.planId, runtime);
    try {
      const preflight = await this.adapter.preflight({ plan: copy(plan), signal: controller.signal });
      if (!isActivated(preflight)) {
        const state = preflight && preflight.state === ISOLATION_STATES.QUALIFIED ? 'BLOCKED' : 'UNAVAILABLE';
        const failure = classifyLaunchFailure(preflight && preflight.reason || 'The isolation environment is unavailable.');
        plan = this._update(plan.planId, current => {
          current.state = PLAN_STATES.BLOCKED;
          current.reason = failure.reason;
          current.failureCode = String(preflight && preflight.failureCode || failure.code);
          for (const operation of current.operations) {
            operation.state = state;
            operation.reason = failure.reason;
            operation.failureCode = current.failureCode;
            operation.failureStage = String(preflight && preflight.failureStage || 'preflight');
            operation.updatedAt = nowIso(this.now);
          }
          return current;
        });
        return this._response(plan, preflight && preflight.state || ISOLATION_STATES.UNAVAILABLE);
      }

      plan = this._update(plan.planId, current => { current.state = PLAN_STATES.RUNNING; current.reason = ''; return current; });
      try {
        for (let index = 0; index < plan.operations.length; index += 1) {
          if (controller.signal.aborted) break;
          const operationId = plan.operations[index].operationId;
          await this._runOperation(plan.planId, operationId, runtime);
          plan = this.store.get(plan.planId);
          if (index < plan.operations.length - 1 && !controller.signal.aborted && plan.launchDelayMs) {
            await this._abortableDelay(plan.launchDelayMs, controller.signal);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      }

      plan = this.store.get(plan.planId);
      if (controller.signal.aborted || plan.state === PLAN_STATES.CANCEL_REQUESTED) {
        const stopOutcomes = await this._stopRuntime(runtime);
        plan = this._update(plan.planId, current => {
          let recoveryRequired = false;
          for (const operation of current.operations) {
            if (operation.state === 'UNKNOWN') {
              recoveryRequired = true;
            } else if (operation.state === 'RUNNING') {
              const outcome = stopOutcomes.get(operation.operationId);
              operation.state = outcome && outcome.state || 'UNKNOWN';
              operation.reason = outcome && outcome.reason || 'Cancellation could not confirm the owned client stopped.';
              if (outcome && outcome.processExited) operation.pid = null;
              if (operation.state === 'UNKNOWN') recoveryRequired = true;
              operation.updatedAt = nowIso(this.now);
            } else if (!OP_FINAL.has(operation.state)) {
              operation.state = 'CANCELLED';
              operation.reason = 'Launch plan was cancelled.';
              operation.updatedAt = nowIso(this.now);
            }
          }
          current.state = recoveryRequired ? PLAN_STATES.RECOVERY_REQUIRED : PLAN_STATES.CANCELLED;
          current.reason = recoveryRequired
            ? 'Cancellation could not confirm cleanup for one or more owned clients.'
            : 'Launch plan was cancelled.';
          return current;
        });
      } else {
        const running = plan.operations.filter(operation => operation.state === 'RUNNING').length;
        const recoveryRequired = plan.operations.some(operation => operation.state === 'UNKNOWN');
        plan = this._update(plan.planId, current => {
          current.state = recoveryRequired
            ? PLAN_STATES.RECOVERY_REQUIRED
            : running === current.operations.length
            ? PLAN_STATES.COMPLETED
            : (running ? PLAN_STATES.PARTIAL : PLAN_STATES.FAILED);
          const firstFailure = current.operations.find(operation => operation.state !== 'RUNNING');
          current.reason = running === current.operations.length ? '' : (firstFailure && firstFailure.reason || 'Roblox could not be launched.');
          current.failureCode = running === current.operations.length ? '' : (firstFailure && firstFailure.failureCode || 'LAUNCH_FAILED');
          return current;
        });
      }
      return this._response(plan, ISOLATION_STATES.ACTIVATED);
    } finally {
      this.active.delete(plan.planId);
    }
  }

  async _runOperation(planId, operationId, runtime) {
    const operationSignal = AbortSignal.any([
      runtime.controller.signal,
      // Abort dependencies slightly before the outer operation deadline so a
      // provider can revoke/destroy its exact environment before the
      // coordinator records the final result.
      AbortSignal.timeout(Math.max(1, this.operationTimeoutMs
        - Math.min(250, Math.floor(this.operationTimeoutMs / 4)))),
    ]);
    let plan = this._update(planId, current => {
      const operation = current.operations.find(item => item.operationId === operationId);
      operation.state = 'ALLOCATING'; operation.reason = ''; operation.updatedAt = nowIso(this.now);
      return current;
    });
    let operation = plan.operations.find(item => item.operationId === operationId);
    try {
      const allocated = await this._bounded(
        this.adapter.allocateInstance(copy(operation), { signal: operationSignal }),
        operationSignal,
        'Isolation allocation timed out.',
      );
      if (!isActivated(allocated) || !allocated.environmentId) {
        return this._failOperation(planId, operationId, allocated && allocated.reason || 'Isolation allocation failed.', null, {
          failureCode: allocated && allocated.failureCode,
          failureStage: allocated && allocated.failureStage || 'allocation',
        });
      }
      runtime.environments.set(operationId, allocated.environmentId);
      plan = this._update(planId, current => {
        const currentOperation = current.operations.find(item => item.operationId === operationId);
        currentOperation.environmentId = allocated.environmentId;
        currentOperation.instanceId = allocated.instanceId || null;
        currentOperation.state = 'RESOLVING_INTENT';
        currentOperation.updatedAt = nowIso(this.now);
        return current;
      });
      operation = plan.operations.find(item => item.operationId === operationId);

      // The host resolves only a non-secret account handle and target. Raw
      // cookies, passwords, authentication tickets, and deep-link secrets are
      // guest-local and are never requested by the host coordinator.
      const resolved = await this._bounded(
        this.resolveIntent(copy(operation), { signal: operationSignal }),
        operationSignal,
        'Launch intent resolution timed out.',
      );
      if (!resolved || resolved.ok !== true || !resolved.intent) {
        return this._failAndRelease(planId, operationId, runtime, resolved && resolved.reason || 'Launch intent could not be resolved.', null, {
          failureCode: 'AUTHENTICATION_FAILED', failureStage: 'intent',
        });
      }

      this._update(planId, current => {
        const currentOperation = current.operations.find(item => item.operationId === operationId);
        currentOperation.state = 'LAUNCHING'; currentOperation.updatedAt = nowIso(this.now); return current;
      });
      const launched = await this._bounded(
        this.adapter.launch(resolved.intent, {
          environmentId: allocated.environmentId,
          operation: copy(operation),
          signal: operationSignal,
        }),
        operationSignal,
        'Launch timed out before stable running.',
      );
      if (!isActivated(launched) || !launched.capability) {
        return this._failAndRelease(planId, operationId, runtime, launched && launched.reason || 'Launch did not reach stable running.', null, {
          failureCode: launched && launched.failureCode,
          failureStage: launched && launched.failureStage || 'launch',
        });
      }
      runtime.capabilities.set(operationId, launched.capability);
      this.operationCapabilities.set(operationId, launched.capability);
      return this._update(planId, current => {
        const currentOperation = current.operations.find(item => item.operationId === operationId);
        currentOperation.state = 'RUNNING';
        currentOperation.capability = null;
        currentOperation.pid = Number(launched.pid) || null;
        currentOperation.reason = '';
        currentOperation.updatedAt = nowIso(this.now);
        return current;
      });
    } catch (error) {
      if (runtime.controller.signal.aborted) return this._failAndRelease(planId, operationId, runtime, 'Launch operation was cancelled.', 'CANCELLED');
      return this._failAndRelease(planId, operationId, runtime, error.message, null, {
        failureCode: error && error.code,
        failureStage: 'launch',
      });
    }
  }

  async _failAndRelease(planId, operationId, runtime, reason, state, metadata) {
    const environmentId = runtime.environments.get(operationId);
    if (environmentId && !runtime.capabilities.has(operationId)) {
      const cleanupMetadata = Object.assign({}, metadata, {
        failureCode: 'CLEANUP_UNCONFIRMED',
        failureStage: 'cleanup',
      });
      try {
        const released = await this.adapter.release(environmentId);
        if (released && released.ok && released.released) {
          runtime.environments.delete(operationId);
        } else {
          return this._failOperation(
            planId,
            operationId,
            `${reason} Environment release was not confirmed: ${released && released.reason || 'unknown release result'}`,
            'UNKNOWN', cleanupMetadata,
          );
        }
      } catch (error) {
        return this._failOperation(planId, operationId, `${reason} Environment release was not confirmed: ${error.message}`, 'UNKNOWN', cleanupMetadata);
      }
    }
    return this._failOperation(planId, operationId, reason, state, metadata);
  }

  _failOperation(planId, operationId, reason, state, metadata) {
    const failure = classifyLaunchFailure(reason);
    return this._update(planId, current => {
      const operation = current.operations.find(item => item.operationId === operationId);
      operation.state = state || 'FAILED';
      operation.reason = failure.reason;
      operation.failureCode = String(metadata && metadata.failureCode || failure.code);
      operation.failureStage = String(metadata && metadata.failureStage || 'launch');
      operation.updatedAt = nowIso(this.now);
      return current;
    });
  }

  async cancel(planId) {
    let plan = this.store.get(planId);
    if (!plan) return { ok: false, error: 'Unknown launch plan.' };
    if (PLAN_TERMINAL.has(plan.state)) {
      return { ok: true, plan };
    }
    plan = this._update(planId, current => { current.state = PLAN_STATES.CANCEL_REQUESTED; current.reason = 'Cancellation requested.'; return current; });
    const runtime = this.active.get(planId);
    if (runtime) runtime.controller.abort(new Error('Launch plan cancelled.'));
    else {
      plan = this._update(planId, current => {
        current.state = PLAN_STATES.CANCELLED;
        for (const operation of current.operations) {
          if (!OP_FINAL.has(operation.state)) operation.state = 'CANCELLED';
        }
        return current;
      });
    }
    return { ok: true, plan };
  }

  async stop(planId, operationId) {
    const plan = this.store.get(planId);
    const operation = plan && plan.operations.find(item => item.operationId === operationId);
    const capability = this.operationCapabilities.get(operationId);
    if (!operation || operation.state !== 'RUNNING' || !capability) return { ok: false, error: 'No running owned operation matches that request.' };
    if (this.lifecycleActions.has(operationId)) {
      return { ok: false, error: `A lifecycle action is already in progress for this client.` };
    }
    this.lifecycleActions.set(operationId, 'stop');
    try {
      const stopped = await this.adapter.stop(capability, { environmentId: operation.environmentId });
      if (!(stopped && stopped.ok && stopped.confirmed)) return { ok: false, error: stopped && stopped.reason || 'Owned stop was not confirmed.' };
      let released;
      try {
        released = await this.adapter.release(operation.environmentId);
      } catch (error) {
        released = {
          ok: false,
          released: false,
          reason: `Owned process stopped, but environment release was not confirmed: ${error && error.message || 'unknown error'}`,
        };
      }
      if (!(released && released.ok && released.released)) {
        const updated = this._update(planId, current => {
          const item = current.operations.find(value => value.operationId === operationId);
          item.state = 'UNKNOWN'; item.reason = released && released.reason || 'Owned process stopped, but environment release was not confirmed.';
          item.capability = null; item.pid = null; item.updatedAt = nowIso(this.now); return current;
        });
        this.operationCapabilities.delete(operationId);
        return { ok: false, error: updated.operations.find(item => item.operationId === operationId).reason, plan: updated };
      }
      const updated = this._update(planId, current => {
        const item = current.operations.find(value => value.operationId === operationId);
        item.state = 'STOPPED';
        item.capability = null; item.pid = null; item.updatedAt = nowIso(this.now); return current;
      });
      this.operationCapabilities.delete(operationId);
      return { ok: true, plan: updated };
    } finally {
      this.lifecycleActions.delete(operationId);
    }
  }

  async restart(planId, operationId) {
    const plan = this.store.get(planId);
    const operation = plan && plan.operations.find(item => item.operationId === operationId);
    const capability = this.operationCapabilities.get(operationId);
    if (!operation || operation.state !== 'RUNNING' || !capability) return { ok: false, error: 'No running owned operation matches that request.' };
    if (this.lifecycleActions.has(operationId)) {
      return { ok: false, error: `A lifecycle action is already in progress for this client.` };
    }
    this.lifecycleActions.set(operationId, 'restart');
    try {
      const preflight = await this.adapter.preflight({ planId, operationId });
      if (!isActivated(preflight)) return { ok: false, state: preflight.state, error: preflight.reason };
      const resolved = await this.resolveIntent(copy(operation), {});
      if (!resolved || !resolved.ok || !resolved.intent) return { ok: false, error: resolved && resolved.reason || 'Launch intent could not be resolved.' };
      const restarted = await this.adapter.restart(resolved.intent, {
        environmentId: operation.environmentId,
        capability,
        operation: copy(operation),
      });
      if (!isActivated(restarted) || !restarted.capability) {
        if (restarted && restarted.previousStopped) {
          const updated = this._update(planId, current => {
            const item = current.operations.find(value => value.operationId === operationId);
            item.state = restarted.status === 'UNKNOWN' ? 'UNKNOWN' : 'STOPPED';
            item.reason = restarted.reason || 'Restart failed after the previous owned process stopped.';
            item.capability = null;
            item.pid = null;
            item.updatedAt = nowIso(this.now);
            return current;
          });
          this.operationCapabilities.delete(operationId);
          return { ok: false, error: restarted.reason || 'Restart failed after the previous owned process stopped.', plan: updated };
        }
        return { ok: false, error: restarted && restarted.reason || 'Restart failed.' };
      }
      const updated = this._update(planId, current => {
        const item = current.operations.find(value => value.operationId === operationId);
        item.state = 'RUNNING'; item.capability = null; item.pid = Number(restarted.pid) || null;
        item.environmentId = restarted.environmentId || item.environmentId;
        item.instanceId = restarted.instanceId || item.instanceId;
        item.updatedAt = nowIso(this.now); return current;
      });
      this.operationCapabilities.set(operationId, restarted.capability);
      const materialized = this._withRuntimeCapabilities(updated);
      return { ok: true, plan: materialized, operation: materialized.operations.find(item => item.operationId === operationId) };
    } finally {
      this.lifecycleActions.delete(operationId);
    }
  }

  async _stopRuntime(runtime) {
    const outcomes = new Map();
    await Promise.all(Array.from(runtime.capabilities.entries()).map(async ([operationId, capability]) => {
      try {
        const stopped = await this.adapter.stop(capability, { operationId, environmentId: runtime.environments.get(operationId) });
        if (!(stopped && stopped.ok && stopped.confirmed)) {
          outcomes.set(operationId, {
            state: 'UNKNOWN',
            processExited: false,
            reason: stopped && stopped.reason || 'Owned client termination was not confirmed.',
          });
          return;
        }
        this.operationCapabilities.delete(operationId);
        runtime.capabilities.delete(operationId);
        const released = await this.adapter.release(runtime.environments.get(operationId));
        if (released && released.ok && released.released) {
          runtime.environments.delete(operationId);
          outcomes.set(operationId, {
            state: 'STOPPED', processExited: true, reason: 'Launch plan was cancelled.',
          });
        } else {
          outcomes.set(operationId, {
            state: 'UNKNOWN',
            processExited: true,
            reason: released && released.reason || 'Owned client stopped, but environment release was not confirmed.',
          });
        }
      } catch (error) {
        outcomes.set(operationId, {
          state: 'UNKNOWN', processExited: false,
          reason: `Cancellation cleanup failed: ${error && error.message || 'unknown error'}`,
        });
      }
    }));
    return outcomes;
  }

  _abortableDelay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason || new Error('Cancelled.'));
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason || new Error('Cancelled.')); }, { once: true });
    });
  }

  _bounded(promise, signal, message) {
    return new Promise((resolve, reject) => {
      const abortReason = () => signal && signal.reason && signal.reason.name === 'TimeoutError'
        ? new Error(message)
        : (signal && signal.reason || new Error('Cancelled.'));
      if (signal && signal.aborted) return reject(abortReason());
      // Dependencies receive the earlier operation abort. This outer grace is
      // only for providers that fail to settle after bounded revocation and
      // exact-environment cleanup have been requested.
      const timer = setTimeout(() => reject(new Error(message)), this.operationTimeoutMs + 2000);
      Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => {
        clearTimeout(timer);
        reject(error && error.name === 'TimeoutError' ? new Error(message) : error);
      });
      if (signal) signal.addEventListener('abort', () => {
        if (signal.reason && signal.reason.name === 'TimeoutError') return;
        clearTimeout(timer);
        reject(abortReason());
      }, { once: true });
    });
  }

  _response(plan, isolationState) {
    const launched = plan.operations.filter(operation => operation.state === 'RUNNING').length;
    const failed = plan.operations.length - launched;
    const prepared = plan.state === PLAN_STATES.BLOCKED || plan.state === PLAN_STATES.PREPARED;
    const failure = plan.reason ? classifyLaunchFailure(plan.reason) : null;
    const materialized = this._withRuntimeCapabilities(plan);
    return {
      ok: plan.state === PLAN_STATES.COMPLETED,
      prepared,
      planId: plan.planId,
      state: isolationState || plan.state,
      plan: materialized,
      selectedCount: plan.operations.length,
      launched,
      failed,
      error: plan.reason || '',
      failureCode: plan.failureCode || (failure && failure.code) || '',
      actions: failure ? failure.actions.slice() : [],
      results: plan.operations.map(operation => ({
        ok: operation.state === 'RUNNING',
        operationId: operation.operationId,
        accountId: operation.accountId,
        state: operation.state,
        reason: operation.reason,
        failureCode: operation.failureCode || '',
        failureStage: operation.failureStage || '',
        pid: operation.pid,
        instanceId: operation.instanceId || null,
      })),
    };
  }
}

module.exports = {
  LaunchCoordinator,
  LaunchPlanner,
  LaunchPlanStore,
  PLAN_NAMESPACE,
  PLAN_STATES,
  classifyLaunchFailure,
  sanitizeTarget,
};
