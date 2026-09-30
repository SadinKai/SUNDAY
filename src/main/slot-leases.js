'use strict';

const crypto = require('crypto');
const path = require('path');

const NAMESPACE = 'slot-leases';
const STATES = Object.freeze({
  RESERVED: 'RESERVED',
  BOUND: 'BOUND',
});

function leaseError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizePath(value) {
  const input = String(value || '');
  if (!path.win32.isAbsolute(input)) return '';
  return path.win32.normalize(input).replace(/[\\/]+$/, '').toLowerCase();
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function sameHash(left, right) {
  const a = Buffer.from(String(left || ''), 'ascii');
  const b = Buffer.from(String(right || ''), 'ascii');
  return a.length === 64 && b.length === 64 && crypto.timingSafeEqual(a, b);
}

function cleanIdentity(value, label) {
  const result = String(value || '').trim();
  if (!result || result.length > 256) throw leaseError('ELEASEIDENTITY', `${label} is invalid.`);
  return result;
}

class SlotLeaseManager {
  constructor(options) {
    const opts = options || {};
    if (!opts.database) throw leaseError('ELEASECONFIG', 'Slot leases require transactional state.');
    if (typeof opts.inspectProcess !== 'function') {
      throw leaseError('ELEASECONFIG', 'Slot leases require a process identity inspector.');
    }
    this.db = opts.database;
    this.inspectProcess = opts.inspectProcess;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.ttlMs = Math.max(5000, Number(opts.ttlMs) || 60_000);
    this.maxSlots = Math.min(128, Math.max(1, Number(opts.maxSlots) || 8));
  }

  _slotKey(index) {
    return `slot-${String(index).padStart(3, '0')}`;
  }

  _public(record, token) {
    if (!record) return null;
    const result = {
      leaseId: record.leaseId,
      slotId: record.slotId,
      ownerId: record.ownerId,
      accountId: record.accountId,
      state: record.state,
      reservedAt: record.reservedAt,
      expiresAt: record.expiresAt,
      process: record.process || null,
    };
    if (token) result.token = token;
    return result;
  }

  _assertRecord(record) {
    if (!record || !Object.values(STATES).includes(record.state)
        || !record.leaseId || !record.slotId || !record.ownerId || !record.accountId
        || !Number.isSafeInteger(record.expiresAt) || !/^[a-f0-9]{64}$/.test(String(record.tokenHash || ''))) {
      throw leaseError('ELEASECORRUPT', 'Persistent slot lease evidence is invalid.');
    }
    if (record.state === STATES.BOUND) this._validateFingerprint(record.process);
  }

  _validateFingerprint(process) {
    if (!process || !Number.isSafeInteger(process.pid) || process.pid <= 0
        || !normalizePath(process.executablePath)) {
      throw leaseError('ELEASEPROCESS', 'Slot binding requires PID, creation identity, file identity, and an absolute image path.');
    }
    const processIdentity = cleanIdentity(process.processIdentity, 'Process creation identity');
    const fileIdentity = cleanIdentity(process.fileIdentity, 'Process file identity');
    return {
      pid: process.pid,
      processIdentity,
      fileIdentity,
      executablePath: normalizePath(process.executablePath),
    };
  }

  _inspection(record) {
    try {
      const result = this.inspectProcess(Object.assign({}, record.process)) || {};
      const status = String(result.status || 'UNKNOWN').toUpperCase();
      if (!['MATCH', 'ABSENT', 'MISMATCH', 'UNKNOWN'].includes(status)) {
        return { status: 'UNKNOWN', executablePath: '' };
      }
      return { status, executablePath: normalizePath(result.executablePath) };
    } catch (_) {
      return { status: 'UNKNOWN', executablePath: '' };
    }
  }

  _recoverable(record, now) {
    this._assertRecord(record);
    if (record.expiresAt > now) return false;
    if (record.state === STATES.RESERVED) return true;
    const inspection = this._inspection(record);
    if (inspection.status === 'ABSENT') return true;
    if (inspection.status === 'MISMATCH'
        && inspection.executablePath
        && inspection.executablePath !== record.process.executablePath) {
      return true;
    }
    return false;
  }

  _authorize(record, ownerId, token) {
    this._assertRecord(record);
    if (record.ownerId !== ownerId || !sameHash(record.tokenHash, tokenHash(token))) {
      throw leaseError('ELEASEAUTH', 'Slot lease owner or token does not match.');
    }
  }

  reserve(ownerId, accountId) {
    const owner = cleanIdentity(ownerId, 'Lease owner');
    const account = cleanIdentity(accountId, 'Account identity');
    const now = this.now();
    const token = crypto.randomBytes(32).toString('base64url');
    const hash = tokenHash(token);
    return this.db.transaction(() => {
      const existing = this.db.list(NAMESPACE);
      for (const row of existing) {
        this._assertRecord(row.value);
        if (row.value.ownerId === owner && row.value.accountId === account
            && !this._recoverable(row.value, now)) {
          throw leaseError('ELEASEDUPLICATE', 'This owner already holds a live slot lease for the account.');
        }
      }
      for (let index = 1; index <= this.maxSlots; index += 1) {
        const slotId = this._slotKey(index);
        const current = this.db.get(NAMESPACE, slotId, null);
        if (current.found && !this._recoverable(current.value, now)) continue;
        if (current.found) this.db.delete(NAMESPACE, slotId, { expectedRevision: current.revision });
        const record = {
          leaseId: crypto.randomUUID(),
          slotId,
          ownerId: owner,
          accountId: account,
          tokenHash: hash,
          state: STATES.RESERVED,
          reservedAt: new Date(now).toISOString(),
          expiresAt: now + this.ttlMs,
          process: null,
        };
        this.db.put(NAMESPACE, slotId, record, { expectedRevision: 0 });
        return this._public(record, token);
      }
      throw leaseError('ELEASEBUSY', 'No safely recoverable slot is available.');
    });
  }

  bind(ownerId, token, fingerprint) {
    const owner = cleanIdentity(ownerId, 'Lease owner');
    const process = this._validateFingerprint(fingerprint);
    const now = this.now();
    const leaseHash = tokenHash(token);
    return this.db.transaction(() => {
      const row = this.db.list(NAMESPACE).find(item => sameHash(item.value.tokenHash, leaseHash));
      if (!row) throw leaseError('ELEASEAUTH', 'Slot lease token is unknown.');
      this._authorize(row.value, owner, token);
      if (row.value.state !== STATES.RESERVED || row.value.expiresAt <= now) {
        throw leaseError('ELEASESTATE', 'Only a live reservation can be bound to a process.');
      }
      const record = Object.assign({}, row.value, {
        state: STATES.BOUND,
        process,
        expiresAt: now + this.ttlMs,
      });
      this.db.put(NAMESPACE, row.key, record, { expectedRevision: row.revision });
      return this._public(record);
    });
  }

  renew(ownerId, token) {
    const owner = cleanIdentity(ownerId, 'Lease owner');
    const now = this.now();
    const leaseHash = tokenHash(token);
    return this.db.transaction(() => {
      const row = this.db.list(NAMESPACE).find(item => sameHash(item.value.tokenHash, leaseHash));
      if (!row) throw leaseError('ELEASEAUTH', 'Slot lease token is unknown.');
      this._authorize(row.value, owner, token);
      if (row.value.expiresAt <= now) {
        throw leaseError('ELEASESTATE', 'An expired slot lease cannot be renewed.');
      }
      if (row.value.state === STATES.BOUND && this._inspection(row.value).status !== 'MATCH') {
        throw leaseError('ELEASEPROCESS', 'Bound process identity could not be revalidated; the lease was not renewed.');
      }
      const record = Object.assign({}, row.value, { expiresAt: now + this.ttlMs });
      this.db.put(NAMESPACE, row.key, record, { expectedRevision: row.revision });
      return this._public(record);
    });
  }

  release(ownerId, token) {
    const owner = cleanIdentity(ownerId, 'Lease owner');
    const leaseHash = tokenHash(token);
    return this.db.transaction(() => {
      const row = this.db.list(NAMESPACE).find(item => sameHash(item.value.tokenHash, leaseHash));
      if (!row) throw leaseError('ELEASEAUTH', 'Slot lease token is unknown.');
      this._authorize(row.value, owner, token);
      if (row.value.state === STATES.BOUND && !this._recoverable(Object.assign({}, row.value, { expiresAt: 0 }), this.now())) {
        throw leaseError('ELEASEACTIVE', 'The bound process is still present or its identity is unknown.');
      }
      this.db.delete(NAMESPACE, row.key, { expectedRevision: row.revision });
      return { released: true, slotId: row.key };
    });
  }

  recoverExpired() {
    const now = this.now();
    return this.db.transaction(() => {
      const recovered = [];
      for (const row of this.db.list(NAMESPACE)) {
        if (!this._recoverable(row.value, now)) continue;
        this.db.delete(NAMESPACE, row.key, { expectedRevision: row.revision });
        recovered.push(row.key);
      }
      return recovered;
    });
  }

  list() {
    return this.db.list(NAMESPACE).map(row => this._public(row.value));
  }
}

module.exports = { SlotLeaseManager, STATES, NAMESPACE, normalizePath };
