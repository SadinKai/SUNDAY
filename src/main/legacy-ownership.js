'use strict';

const NAMESPACE = 'legacy-process-ownership-v1';
const SLOT_ID = /^instance-[1-9]\d*$/;
const SECRET_KEY = /(capability|cookie|password|secret|ticket|token)/i;

function copy(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

function withoutSecrets(value) {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (!value || typeof value !== 'object') return value;
  const clean = {};
  for (const [key, nested] of Object.entries(value)) {
    if (!SECRET_KEY.test(key)) clean[key] = withoutSecrets(nested);
  }
  return clean;
}

function sanitize(record) {
  const value = record && typeof record === 'object' ? record : {};
  const pid = Number(value.pid);
  const slotId = String(value.slotId || value.instanceId || '');
  const normalized = {
    schemaVersion: 1,
    operationId: String(value.operationId || '').slice(0, 160),
    accountId: String(value.accountId || '').slice(0, 160),
    profileName: String(value.profileName || '').slice(0, 160),
    environmentId: String(value.environmentId || '').slice(0, 160),
    instanceId: slotId,
    slotId,
    pid,
    processIdentity: String(value.processIdentity || '').slice(0, 240),
    executablePath: String(value.executablePath || '').slice(0, 2048),
    fileIdentity: String(value.fileIdentity || '').slice(0, 240),
    sourcePlayerPath: String(value.sourcePlayerPath || '').slice(0, 2048),
    startedAt: String(value.startedAt || ''),
    updatedAt: new Date().toISOString(),
  };
  if (!normalized.operationId || !normalized.environmentId || !SLOT_ID.test(slotId)
      || !Number.isInteger(pid) || pid <= 0 || !normalized.processIdentity
      || !normalized.executablePath || !normalized.fileIdentity) {
    throw new Error('Legacy ownership evidence is incomplete.');
  }
  return normalized;
}

class LegacyOwnershipStore {
  constructor(options) {
    const opts = options || {};
    if (!opts.database) throw new Error('LegacyOwnershipStore requires transactional state storage.');
    this.database = opts.database;
  }

  put(record) {
    const normalized = sanitize(record);
    const current = this.database.get(NAMESPACE, normalized.operationId, null);
    if (current.found && Number(current.value && current.value.schemaVersion || 1) > 1) {
      throw new Error('Legacy ownership evidence was written by a newer SUNDAY version.');
    }
    // Preserve additive non-secret fields written by a compatible future
    // build, but never carry a capability or credential-like field forward.
    const value = Object.assign({}, withoutSecrets(current.value || {}), normalized);
    return this.database.put(NAMESPACE, value.operationId, value, {
      expectedRevision: current.revision,
    }).value;
  }

  delete(operationId) {
    return this.database.delete(NAMESPACE, String(operationId || '')).deleted;
  }

  list() {
    return this.database.list(NAMESPACE).map(row => copy(row.value));
  }
}

module.exports = { LegacyOwnershipStore, NAMESPACE, sanitize };
