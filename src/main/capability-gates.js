'use strict';

const STATES = Object.freeze({
  UNAVAILABLE: 'UNAVAILABLE',
  PREPARING: 'PREPARING',
  QUALIFIED: 'QUALIFIED',
  ACTIVE: 'ACTIVE',
  FAILED: 'FAILED',
});

const VALID = new Set(Object.values(STATES));

class CapabilityGates {
  constructor(initial) {
    this._entries = new Map();
    for (const [name, value] of Object.entries(initial || {})) {
      const entry = typeof value === 'string' ? { state: value } : value;
      this.set(name, entry.state, entry.reason, entry.evidence);
    }
  }

  set(name, state, reason, evidence) {
    if (!name || !VALID.has(state)) throw new Error('Invalid capability state.');
    const prior = this._entries.get(name);
    const entry = Object.freeze({
      name,
      state,
      reason: String(reason || ''),
      evidence: evidence || null,
      changedAt: new Date().toISOString(),
      previous: prior ? prior.state : null,
    });
    this._entries.set(name, entry);
    return entry;
  }

  get(name) {
    return this._entries.get(name) || Object.freeze({
      name,
      state: STATES.UNAVAILABLE,
      reason: 'Capability was not registered.',
      evidence: null,
      changedAt: null,
      previous: null,
    });
  }

  permits(name) {
    const state = this.get(name).state;
    return state === STATES.QUALIFIED || state === STATES.ACTIVE;
  }

  require(name) {
    const entry = this.get(name);
    if (!this.permits(name)) {
      const err = new Error(entry.reason || `${name} is ${entry.state}.`);
      err.code = 'ECAPABILITY';
      err.capability = entry;
      throw err;
    }
    return entry;
  }

  snapshot() {
    return Object.fromEntries(Array.from(this._entries, ([name, entry]) => [name, entry]));
  }
}

module.exports = { CapabilityGates, STATES };
