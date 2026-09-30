'use strict';

const crypto = require('crypto');
const path = require('path');

function normalized(value) {
  try { return path.win32.normalize(String(value || '')).replace(/[\\/]+$/, '').toLowerCase(); }
  catch (_) { return ''; }
}

class ProcessCapabilityRegistry {
  constructor(nativeApi, options) {
    this.native = nativeApi;
    this.records = new Map();
    this.now = options && typeof options.now === 'function' ? options.now : () => Date.now();
    this.ttlMs = Math.max(1000, Number(options && options.ttlMs) || 24 * 60 * 60 * 1000);
    this.maxRecords = Math.max(32, Number(options && options.maxRecords) || 2048);
  }

  _fingerprint(pid) {
    if (typeof this.native.processFingerprintOf === 'function') {
      const value = this.native.processFingerprintOf(pid) || {};
      return {
        processIdentity: String(value.processIdentity || ''),
        executablePath: normalized(value.executablePath),
        fileIdentity: String(value.fileIdentity || ''),
      };
    }
    return {
      processIdentity: String(this.native.processIdentityOf(pid) || ''),
      executablePath: normalized(this.native.executablePathOf(pid)),
      fileIdentity: typeof this.native.fileIdentityOfPath === 'function'
        ? String(this.native.fileIdentityOfPath(this.native.executablePathOf(pid)) || '')
        : '',
    };
  }

  _transition(record, state, reason) {
    if (record.state === 'ACTIVE') {
      record.state = state;
      record.stateChangedAt = new Date(this.now()).toISOString();
      record.reason = reason || '';
    }
  }

  _prune() {
    if (this.records.size <= this.maxRecords) return;
    for (const [token, record] of this.records) {
      if (record.state !== 'ACTIVE') this.records.delete(token);
      if (this.records.size <= this.maxRecords) return;
    }
  }

  issue(pid, metadata) {
    const numericPid = Number(pid);
    const expectedPath = normalized(metadata && metadata.executablePath);
    if (!Number.isInteger(numericPid) || numericPid <= 0 || !expectedPath) {
      throw new Error('A process capability requires a PID and canonical executable path.');
    }
    const fingerprint = this._fingerprint(numericPid);
    if (!fingerprint.processIdentity || fingerprint.executablePath !== expectedPath) {
      throw new Error('The launched process identity could not be proven.');
    }
    const now = this.now();
    const token = crypto.randomBytes(32).toString('base64url');
    this.records.set(token, {
      token,
      pid: numericPid,
      processIdentity: fingerprint.processIdentity,
      executablePath: fingerprint.executablePath,
      fileIdentity: fingerprint.fileIdentity,
      ownerId: String(metadata.ownerId || ''),
      instanceId: String(metadata.instanceId || ''),
      accountId: String(metadata.accountId || ''),
      profileName: String(metadata.profileName || ''),
      slotId: String(metadata.slotId || ''),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      state: 'ACTIVE',
      stateChangedAt: new Date(now).toISOString(),
      reason: '',
    });
    this._prune();
    return token;
  }

  resolve(token, options) {
    const record = this.records.get(String(token || ''));
    if (!record) return { ok: false, state: 'UNKNOWN', reason: 'Unknown process capability.' };
    if (record.state !== 'ACTIVE') return { ok: false, state: record.state, reason: record.reason || `Process capability is ${record.state.toLowerCase()}.` };
    if (this.now() >= Date.parse(record.expiresAt)) {
      this._transition(record, 'EXPIRED', 'Process capability expired.');
      return { ok: false, state: record.state, reason: record.reason };
    }
    const expectedOwner = options && options.ownerId != null ? String(options.ownerId) : null;
    if (expectedOwner !== null && record.ownerId !== expectedOwner) {
      return { ok: false, state: record.state, reason: 'Process capability belongs to a different SUNDAY Launcher owner.' };
    }
    const fingerprint = this._fingerprint(record.pid);
    const fileChanged = !!record.fileIdentity && fingerprint.fileIdentity !== record.fileIdentity;
    if (!fingerprint.processIdentity || fingerprint.processIdentity !== record.processIdentity
        || fingerprint.executablePath !== record.executablePath || fileChanged) {
      this._transition(record, 'STALE', 'The process capability no longer identifies the owned process.');
      return { ok: false, reason: 'The process capability is stale or no longer identifies the owned process.' };
    }
    return { ok: true, state: record.state, action: String(options && options.action || 'observe'), record: Object.freeze(Object.assign({}, record)) };
  }

  authorize(token, action, ownerId) {
    const allowed = new Set(['observe', 'focus', 'stop', 'kill', 'restart', 'arrange']);
    const normalizedAction = String(action || '');
    if (!allowed.has(normalizedAction)) return { ok: false, state: 'DENIED', reason: 'Unknown process capability action.' };
    return this.resolve(token, { action: normalizedAction, ownerId });
  }

  revoke(token, reason) {
    const record = this.records.get(String(token || ''));
    if (!record) return false;
    this._transition(record, 'REVOKED', String(reason || 'Process capability revoked.'));
    return true;
  }

  revokeByPid(pid) {
    for (const record of this.records.values()) {
      if (record.pid === Number(pid)) this._transition(record, 'REVOKED', 'Process exited or was forgotten.');
    }
  }
}

module.exports = { ProcessCapabilityRegistry, normalized };
