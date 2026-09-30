'use strict';

const crypto = require('crypto');
const { validateEnvironmentIdentity } = require('./environment-provider');

const NAMESPACE = 'environment-leases-v1';
const LEASE_STATES = Object.freeze({
  ALLOCATED: 'ALLOCATED',
  ACTIVE: 'ACTIVE',
  REVOKED: 'REVOKED',
  RELEASED: 'RELEASED',
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
});
const FINAL_STATES = new Set([LEASE_STATES.REVOKED, LEASE_STATES.RELEASED]);

function leaseError(code, message) {
  const error = new Error(String(message || code));
  error.code = code;
  return error;
}

function digest(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function sameDigest(left, right) {
  const a = Buffer.from(String(left || ''), 'ascii');
  const b = Buffer.from(String(right || ''), 'ascii');
  return a.length === 64 && b.length === 64 && crypto.timingSafeEqual(a, b);
}

function identity(value, label) {
  const result = String(value || '').trim();
  if (!result || result.length > 256) throw leaseError('EENVLEASEIDENTITY', `${label} is invalid.`);
  return result;
}

class EnvironmentLeaseManager {
  constructor(options) {
    const opts = options || {};
    if (!opts.database) throw leaseError('EENVLEASECONFIG', 'Environment leases require transactional state.');
    this.database = opts.database;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.ttlMs = Math.max(5000, Number(opts.ttlMs) || 120_000);
  }

  _public(record, token) {
    const output = {
      leaseId: record.leaseId,
      state: record.state,
      environment: record.environment,
      accountHandle: record.accountHandle,
      operationId: record.operationId,
      maxProcessCount: record.maxProcessCount,
      capabilityIdentity: record.capabilityDigest || null,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      activatedAt: record.activatedAt || null,
      reason: record.reason || '',
    };
    if (token) output.leaseToken = token;
    return output;
  }

  _validate(record) {
    if (!record || !Object.values(LEASE_STATES).includes(record.state)
        || !record.leaseId || !/^[a-f0-9]{64}$/.test(String(record.tokenDigest || ''))
        || !Number.isSafeInteger(record.expiresAt) || record.maxProcessCount !== 1
        || (record.state === LEASE_STATES.ACTIVE && !/^[a-f0-9]{64}$/.test(String(record.capabilityDigest || '')))) {
      throw leaseError('EENVLEASECORRUPT', 'Persistent environment lease evidence is invalid.');
    }
    validateEnvironmentIdentity(record.environment);
    identity(record.accountHandle, 'Account handle');
    identity(record.operationId, 'Operation identity');
    return record;
  }

  _authorize(record, token) {
    this._validate(record);
    if (!sameDigest(record.tokenDigest, digest(token))) {
      throw leaseError('EENVLEASEAUTH', 'Environment lease token does not match.');
    }
    if (FINAL_STATES.has(record.state)) {
      throw leaseError('EENVLEASEREVOKED', 'Environment lease is no longer active.');
    }
    if (record.expiresAt <= this.now()) {
      throw leaseError('EENVLEASEEXPIRED', 'Environment lease has expired.');
    }
  }

  reserve(input) {
    const environment = validateEnvironmentIdentity(input && input.environment);
    const accountHandle = identity(input && input.accountHandle, 'Account handle');
    const operationId = identity(input && input.operationId, 'Operation identity');
    const leaseToken = crypto.randomBytes(32).toString('base64url');
    const now = this.now();
    return this.database.transaction(() => {
      for (const row of this.database.list(NAMESPACE)) {
        const record = this._validate(row.value);
        if (FINAL_STATES.has(record.state)) continue;
        if (record.environment.environmentId === environment.environmentId
            || record.operationId === operationId) {
          throw leaseError('EENVLEASEDUPLICATE', 'Environment or operation already has a non-final lease.');
        }
      }
      const record = {
        leaseId: crypto.randomUUID(),
        tokenDigest: digest(leaseToken),
        state: LEASE_STATES.ALLOCATED,
        environment,
        accountHandle,
        operationId,
        maxProcessCount: 1,
        capabilityDigest: null,
        createdAt: new Date(now).toISOString(),
        activatedAt: null,
        expiresAt: now + this.ttlMs,
        reason: '',
      };
      this.database.put(NAMESPACE, record.leaseId, record, { expectedRevision: 0 });
      return this._public(record, leaseToken);
    });
  }

  activate(leaseId, token, evidence) {
    const key = identity(leaseId, 'Lease identity');
    const expected = validateEnvironmentIdentity(evidence && evidence.environment);
    return this.database.update(NAMESPACE, key, null, record => {
      this._authorize(record, token);
      if (record.state !== LEASE_STATES.ALLOCATED) {
        throw leaseError('EENVLEASESTATE', 'Only an allocated environment lease can be activated.');
      }
      const actual = record.environment;
      for (const field of ['environmentId', 'providerId', 'guestId', 'vmId', 'hostId', 'generation', 'agentId']) {
        if (actual[field] !== expected[field]) {
          throw leaseError('EENVLEASEBINDING', `Authenticated environment ${field} does not match the lease.`);
        }
      }
      if (actual.image.digest !== expected.image.digest || actual.image.generation !== expected.image.generation) {
        throw leaseError('EENVLEASEBINDING', 'Authenticated immutable image identity does not match the lease.');
      }
      if (!/^[a-f0-9]{64}$/.test(String(evidence && evidence.capabilityDigest || ''))) {
        throw leaseError('EENVLEASEBINDING', 'Environment capability identity is invalid.');
      }
      record.state = LEASE_STATES.ACTIVE;
      record.capabilityDigest = evidence.capabilityDigest;
      record.activatedAt = new Date(this.now()).toISOString();
      record.expiresAt = this.now() + this.ttlMs;
      return record;
    }).value;
  }

  authorize(leaseId, token, expected) {
    const row = this.database.get(NAMESPACE, identity(leaseId, 'Lease identity'), null);
    if (!row.found) throw leaseError('EENVLEASEAUTH', 'Environment lease is unknown.');
    this._authorize(row.value, token);
    if (row.value.state !== LEASE_STATES.ACTIVE) {
      throw leaseError('EENVLEASESTATE', 'Environment lease is not active.');
    }
    const checks = expected || {};
    for (const [field, value] of Object.entries(checks)) {
      if (value != null && row.value.environment[field] !== value && row.value[field] !== value) {
        throw leaseError('EENVLEASEBINDING', `Environment lease ${field} does not match.`);
      }
    }
    return this._public(row.value);
  }

  renew(leaseId, token) {
    const key = identity(leaseId, 'Lease identity');
    return this.database.update(NAMESPACE, key, null, record => {
      this._authorize(record, token);
      if (record.state !== LEASE_STATES.ACTIVE) throw leaseError('EENVLEASESTATE', 'Only an active environment lease can be renewed.');
      record.expiresAt = this.now() + this.ttlMs;
      return record;
    }).value;
  }

  revoke(leaseId, token, reason) {
    const key = identity(leaseId, 'Lease identity');
    return this.database.update(NAMESPACE, key, null, record => {
      this._authorize(record, token);
      record.state = LEASE_STATES.REVOKED;
      record.reason = String(reason || 'Environment lease revoked.');
      record.expiresAt = this.now();
      return record;
    }).value;
  }

  release(leaseId, token) {
    const key = identity(leaseId, 'Lease identity');
    return this.database.update(NAMESPACE, key, null, record => {
      this._authorize(record, token);
      record.state = LEASE_STATES.RELEASED;
      record.reason = 'Environment writable state was released.';
      record.expiresAt = this.now();
      return record;
    }).value;
  }

  recoverInterrupted() {
    const recovered = [];
    this.database.transaction(() => {
      for (const row of this.database.list(NAMESPACE)) {
        const record = this._validate(row.value);
        if (FINAL_STATES.has(record.state) || record.state === LEASE_STATES.RECOVERY_REQUIRED) continue;
        record.state = LEASE_STATES.RECOVERY_REQUIRED;
        record.reason = 'Broker restarted; the environment was not adopted and requires explicit reconciliation.';
        record.expiresAt = this.now();
        this.database.put(NAMESPACE, row.key, record, { expectedRevision: row.revision });
        recovered.push(row.key);
      }
    });
    return recovered;
  }

  list() {
    return this.database.list(NAMESPACE).map(row => this._public(this._validate(row.value)));
  }
}

module.exports = {
  EnvironmentLeaseManager,
  LEASE_STATES,
  NAMESPACE,
  leaseError,
};
