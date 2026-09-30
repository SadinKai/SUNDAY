'use strict';

const EventEmitter = require('events');
const { ISOLATION_STATES, isExecutionEnabledState } = require('./roblox-isolation-adapter');

const PERSIST_KEY = 'keeper.json';
const MAX_RECORDS = 20;
const STABLE_MS = 300000;
const BACKOFF_CAP_MS = 300000;
const RESTART_BLIND_MS = 20000;

function baseDelayMs(settings) {
  const sec = Math.max(0, Math.min(300, Number(settings && settings.autoRejoinDelaySec) || 0));
  return sec * 1000;
}
function maxAttempts(settings) {
  return Math.max(1, Math.min(20, Number(settings && settings.autoRejoinMaxAttempts) || 5));
}
function publicRecord(record) {
  return {
    accountId: record.accountId,
    userId: record.userId,
    username: record.username,
    name: record.name,
    placeId: record.placeId,
    gameInstanceId: record.gameInstanceId,
    targetUserId: record.targetUserId,
    state: record.state,
    paused: !!record.paused,
    capability: record.capability || null,
    attempts: record.attempts,
    nextAt: record.state === 'rejoining' ? record.nextAt : 0,
    lastReason: record.lastReason || '',
  };
}

/**
 * Product state machine for auto-rejoin.
 *
 * It cannot spawn or stop a process. The only mutation callback is a launch
 * plan request into the coordinator, and that callback is reached solely
 * after a confirmed exit for the exact owned capability plus an ACTIVATED
 * isolation environment. Missing observations, presence changes, UNKNOWN
 * ownership, and restored records never cause replacement.
 */
class InstanceKeeper extends EventEmitter {
  constructor(options) {
    super();
    const opts = options || {};
    this.logger = opts.logger || { info() {}, warn() {}, error() {} };
    this.now = opts.now || (() => Date.now());
    this.store = opts.store || null;
    this.settingsProvider = opts.settingsProvider || (() => ({}));
    this.isolationStateProvider = opts.isolationStateProvider || (() => ISOLATION_STATES.UNAVAILABLE);
    this.requestRelaunch = opts.requestRelaunch || null;
    this.scheduleFn = opts.schedule || ((fn, delay) => setTimeout(fn, delay));
    this.cancelScheduleFn = opts.cancelSchedule || (timer => clearTimeout(timer));
    this.records = new Map();
    this.timers = new Map();
    this.busy = new Set();
    this.on('change', () => this.persist());
  }

  arm(input) {
    const accountId = String(input && input.accountId || '').trim();
    if (!accountId) return { ok: false, error: 'No account to watch.' };
    if (!this.records.has(accountId) && this.records.size >= MAX_RECORDS) return { ok: false, error: `Watchdog limit reached (${MAX_RECORDS} accounts).` };
    const prior = this.records.get(accountId) || {};
    const record = {
      accountId,
      userId: Number(input.userId) || prior.userId || null,
      username: String(input.username || prior.username || '').slice(0, 40),
      placeId: String(input.placeId || prior.placeId || '').trim(),
      gameInstanceId: String(input.gameInstanceId || prior.gameInstanceId || '').trim(),
      targetUserId: Number(input.targetUserId) || prior.targetUserId || null,
      name: String(input.name || prior.name || 'the game').slice(0, 80),
      state: input.paused ? 'paused' : (input.capability ? 'running' : 'armed'),
      capability: String(input.capability || prior.capability || '') || null,
      attempts: Number(prior.attempts) || 0,
      stableAt: input.capability ? this.now() : 0,
      nextAt: 0,
      lastReason: '',
      blindUntil: 0,
      paused: !!input.paused,
      presence: String(prior.presence || ''),
    };
    this.records.set(accountId, record);
    this._clearTimer(accountId);
    this.emit('change', this.status());
    return { ok: true, record: publicRecord(record) };
  }

  armMany(input) {
    let armed = 0;
    for (const item of (Array.isArray(input) ? input : [])) if (this.arm(item).ok) armed += 1;
    return { ok: armed > 0, armed };
  }

  disarm(accountId, reason) {
    const key = String(accountId || '');
    const record = this.records.get(key);
    if (!record) return { ok: false };
    this._clearTimer(key);
    this.records.delete(key);
    this.logger.info(`Watchdog disarmed for ${record.username || key}${reason ? ` - ${reason}` : ''}`);
    this.emit('change', this.status());
    return { ok: true };
  }

  disarmAll(reason) {
    const count = this.records.size;
    for (const accountId of this.records.keys()) this._clearTimer(accountId);
    this.records.clear();
    if (count) this.logger.info(`Watchdog disarmed for all accounts${reason ? ` - ${reason}` : ''}`);
    this.emit('change', this.status());
    return { ok: true, disarmed: count };
  }

  /** Live rows can confirm running/stability, but absence is never an exit. */
  onInstances(instances) {
    const byAccount = new Map();
    for (const row of (Array.isArray(instances) ? instances : [])) {
      if (row && row.source === 'sunday' && row.controllable && row.accountId && row.capability) byAccount.set(String(row.accountId), row);
    }
    let changed = false;
    for (const record of this.records.values()) {
      const row = byAccount.get(record.accountId);
      if (!row) continue;
      if (record.capability && record.capability !== row.capability) continue;
      record.capability = row.capability;
      record.state = 'running';
      record.paused = false;
      record.stableAt = record.stableAt || this.now();
      if (record.attempts > 0 && this.now() - record.stableAt >= STABLE_MS) {
        record.attempts = 0;
        record.lastReason = '';
      }
      changed = true;
    }
    if (changed) this.emit('change', this.status());
  }

  /** Presence is UI context only; it cannot prove process ownership or exit. */
  onPresence(userId, status) {
    for (const record of this.records.values()) {
      if (record.userId === Number(userId)) record.presence = String(status || '');
    }
  }

  /**
   * The lifecycle owner calls this only after exact capability observation has
   * proved EXITED. UNKNOWN, mismatched, or unconfirmed signals are ignored.
   */
  onOwnedExit(evidence) {
    const input = evidence || {};
    if (input.confirmed !== true || input.ownership !== 'OWNED' || !input.capability) {
      return { ok: false, ignored: true, reason: 'Confirmed owned-process exit evidence is required.' };
    }
    const record = this.records.get(String(input.accountId || ''));
    if (!record || record.paused || record.capability !== String(input.capability)) {
      return { ok: false, ignored: true, reason: 'Exit evidence does not match an active owned watch.' };
    }
    if (record.blindUntil && this.now() < record.blindUntil) return { ok: false, ignored: true, reason: 'Manual restart suppression is active.' };
    record.capability = null;
    record.stableAt = 0;
    return this._scheduleRejoin(record, String(input.reason || 'owned client exited'));
  }

  onManualKill(value) {
    const capability = typeof value === 'string' ? value : value && value.capability;
    const record = Array.from(this.records.values()).find(item => item.capability === capability);
    if (!record) return null;
    this.disarm(record.accountId, 'ended by user');
    return publicRecord(record);
  }

  onManualKillAll() { return this.disarmAll('ended by user'); }

  onManualRestart(value) {
    const capability = typeof value === 'string' ? value : value && value.capability;
    const record = Array.from(this.records.values()).find(item => item.capability === capability);
    if (record) record.blindUntil = this.now() + RESTART_BLIND_MS;
    return record ? publicRecord(record) : null;
  }

  updateSettings() { this.emit('change', this.status()); }

  _scheduleRejoin(record, reason) {
    const settings = this.settingsProvider();
    const maximum = maxAttempts(settings);
    if (record.attempts >= maximum) {
      record.state = 'gaveup';
      record.lastReason = reason;
      record.nextAt = 0;
      this.emit('gaveup', publicRecord(record));
      this.emit('change', this.status());
      return { ok: false, gaveUp: true };
    }
    record.attempts += 1;
    record.lastReason = reason;
    const delayMs = Math.min(baseDelayMs(settings) * Math.pow(2, record.attempts - 1), BACKOFF_CAP_MS);
    record.state = 'rejoining';
    record.nextAt = this.now() + delayMs;
    this._clearTimer(record.accountId);
    const timer = this.scheduleFn(() => {
      this.timers.delete(record.accountId);
      this._rejoin(record).catch(error => this.logger.error('Watchdog rejoin failed', error && error.message));
    }, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    this.timers.set(record.accountId, timer);
    this.emit('rejoin', Object.assign(publicRecord(record), { delayMs }));
    this.emit('change', this.status());
    return { ok: true, scheduled: true, delayMs };
  }

  async _rejoin(record) {
    if (!this.records.has(record.accountId) || this.busy.has(record.accountId)) return;
    if (!isExecutionEnabledState(this.isolationStateProvider())) {
      record.state = 'blocked';
      record.nextAt = 0;
      record.lastReason = 'Auto-rejoin is waiting for an activated isolation environment.';
      this.emit('change', this.status());
      return;
    }
    if (typeof this.requestRelaunch !== 'function') {
      record.state = 'blocked';
      record.nextAt = 0;
      record.lastReason = 'No launch coordinator is configured.';
      this.emit('change', this.status());
      return;
    }
    this.busy.add(record.accountId);
    try {
      const response = await this.requestRelaunch({
        accountId: record.accountId,
        placeId: record.placeId,
        gameInstanceId: record.gameInstanceId,
        targetUserId: record.targetUserId,
        name: record.name,
      });
      const operation = response && response.plan && response.plan.operations && response.plan.operations[0];
      if (response && response.ok && operation && operation.state === 'RUNNING' && operation.capability) {
        record.capability = operation.capability;
        record.state = 'running';
        record.stableAt = this.now();
        record.nextAt = 0;
        record.lastReason = '';
      } else {
        this._scheduleRejoin(record, response && (response.error || response.reason) || 'rejoin plan failed');
      }
      this.emit('change', this.status());
    } finally {
      this.busy.delete(record.accountId);
    }
  }

  status() {
    const records = Array.from(this.records.values()).map(publicRecord);
    return {
      ok: true,
      records,
      summary: {
        armed: records.length,
        running: records.filter(record => record.state === 'running').length,
        rejoining: records.filter(record => record.state === 'rejoining').length,
        blocked: records.filter(record => record.state === 'blocked' || record.state === 'paused').length,
        gaveUp: records.filter(record => record.state === 'gaveup').length,
      },
    };
  }

  persist() {
    if (!this.store || typeof this.store.writeJson !== 'function') return;
    const records = Array.from(this.records.values()).filter(record => record.state !== 'gaveup').map(record => ({
      accountId: record.accountId,
      userId: record.userId,
      username: record.username,
      placeId: record.placeId,
      gameInstanceId: record.gameInstanceId,
      targetUserId: record.targetUserId,
      name: record.name,
    }));
    try { this.store.writeJson(PERSIST_KEY, { records }); }
    catch (error) { this.logger.warn('Could not save watchdog state', error && error.message); }
  }

  restore() {
    if (!this.store || typeof this.store.readJson !== 'function') return { ok: true, restored: 0 };
    let data;
    try { data = this.store.readJson(PERSIST_KEY, { records: [] }); }
    catch (_) { data = { records: [] }; }
    let restored = 0;
    for (const record of (Array.isArray(data && data.records) ? data.records : []).slice(0, MAX_RECORDS)) {
      if (record && record.accountId && this.arm(Object.assign({}, record, { paused: true })).ok) restored += 1;
    }
    return { ok: true, restored };
  }

  _clearTimer(accountId) {
    const timer = this.timers.get(String(accountId));
    if (timer != null) this.cancelScheduleFn(timer);
    this.timers.delete(String(accountId));
  }

  stop() {
    for (const accountId of this.timers.keys()) this._clearTimer(accountId);
    this.busy.clear();
  }
}

module.exports = { InstanceKeeper, PERSIST_KEY, STABLE_MS };
