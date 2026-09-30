'use strict';

const crypto = require('crypto');

const PROTOCOL_VERSION = 1;
const DEFAULT_TTL_MS = 15_000;
const FORBIDDEN_LAUNCH_KEY = /(cookie|password|credential|secret|ticket|deeplink|authentication|authorization)/i;

function rpcError(code, message) {
  const error = new Error(String(message || code));
  error.code = code;
  return error;
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function clean(value, label, max) {
  const result = String(value || '').trim();
  if (!result || result.length > (max || 256)) throw rpcError('ERPCFIELD', `${label} is invalid.`);
  return result;
}

function generation(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw rpcError('ERPCBINDING', 'RPC generation is invalid.');
  return result;
}

function assertNoLaunchSecrets(value, trail) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_LAUNCH_KEY.test(key)) {
      throw rpcError('ERPCSECRET', `Host launch command contains forbidden field ${trail}${key}.`);
    }
    if (nested && typeof nested === 'object') assertNoLaunchSecrets(nested, `${trail}${key}.`);
  }
}

function validateLaunchIntent(value) {
  const body = value && typeof value === 'object' ? value : {};
  assertNoLaunchSecrets(body, 'body.');
  const keys = Object.keys(body).sort();
  if (keys.join(',') !== 'accountHandle,target') {
    throw rpcError('ERPCINTENT', 'Host launch command must contain only accountHandle and target.');
  }
  const accountHandle = clean(body.accountHandle, 'Guest-local account handle', 160);
  const rawTarget = body.target && typeof body.target === 'object' ? body.target : {};
  const type = clean(rawTarget.type || 'HOME', 'Target type', 32).toUpperCase();
  const allowed = new Set(['HOME', 'CLIENT', 'PLACE', 'EXACT_SERVER', 'FOLLOW_PERSON', 'FOLLOW_ACCOUNT']);
  if (!allowed.has(type)) throw rpcError('ERPCINTENT', `Unsupported guest launch target: ${type}`);
  const target = { type };
  const targetKeys = new Set(['type', 'placeId', 'serverId', 'targetUserId', 'targetAccountId', 'name']);
  for (const key of Object.keys(rawTarget)) {
    if (!targetKeys.has(key)) throw rpcError('ERPCINTENT', `Unknown guest launch target field: ${key}`);
  }
  if (rawTarget.placeId != null) {
    target.placeId = clean(rawTarget.placeId, 'Place ID', 40);
    if (!/^\d+$/.test(target.placeId)) throw rpcError('ERPCINTENT', 'Place ID must be numeric.');
  }
  if (rawTarget.serverId != null) target.serverId = clean(rawTarget.serverId, 'Server ID', 160);
  if (rawTarget.targetUserId != null) {
    const id = Number(rawTarget.targetUserId);
    if (!Number.isSafeInteger(id) || id < 1) throw rpcError('ERPCINTENT', 'Target user ID is invalid.');
    target.targetUserId = id;
  }
  if (rawTarget.targetAccountId != null) target.targetAccountId = clean(rawTarget.targetAccountId, 'Target account handle', 160);
  if (rawTarget.name != null) target.name = String(rawTarget.name).slice(0, 80);
  if (type === 'EXACT_SERVER' && (!target.placeId || !target.serverId)) throw rpcError('ERPCINTENT', 'Exact-server target is incomplete.');
  if (type === 'FOLLOW_PERSON' && !target.targetUserId) throw rpcError('ERPCINTENT', 'Follow-person target is incomplete.');
  if (type === 'FOLLOW_ACCOUNT' && !target.targetAccountId) throw rpcError('ERPCINTENT', 'Follow-account target is incomplete.');
  return Object.freeze({ accountHandle, target: Object.freeze(target) });
}

function createSigningIdentity() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

function createSessionKey() {
  return crypto.randomBytes(32);
}

class SecureRpcEndpoint {
  constructor(options) {
    const opts = options || {};
    this.role = clean(opts.role, 'RPC role', 32);
    this.peerRole = clean(opts.peerRole, 'RPC peer role', 32);
    this.privateKey = crypto.createPrivateKey(opts.privateKeyPem);
    this.peerPublicKey = crypto.createPublicKey(opts.peerPublicKeyPem);
    this.encryptionKey = Buffer.from(opts.encryptionKey || []);
    if (this.encryptionKey.length !== 32) throw rpcError('ERPCKEY', 'RPC encryption key must contain 32 bytes.');
    this.binding = Object.freeze({
      environmentId: clean(opts.environmentId, 'RPC environment identity'),
      leaseId: clean(opts.leaseId, 'RPC lease identity'),
      generation: generation(opts.generation),
      agentId: clean(opts.agentId, 'RPC agent identity'),
    });
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.maxTtlMs = Math.max(1000, Math.min(60_000, Number(opts.maxTtlMs) || DEFAULT_TTL_MS));
    this.outboundSequence = 0;
    this.inboundSequence = 0;
    this.seen = new Set();
    this.revoked = false;
  }

  revoke() {
    this.revoked = true;
    this.encryptionKey.fill(0);
  }

  seal(action, body, options) {
    if (this.revoked) throw rpcError('ERPCREVOKED', 'RPC session is revoked.');
    const opts = options || {};
    const now = this.now();
    const ttlMs = Math.max(1, Math.min(this.maxTtlMs, Number(opts.ttlMs) || this.maxTtlMs));
    this.outboundSequence += 1;
    const payload = {
      protocolVersion: PROTOCOL_VERSION,
      messageId: crypto.randomUUID(),
      operationId: clean(opts.operationId, 'RPC operation identity'),
      sender: this.role,
      recipient: this.peerRole,
      environmentId: this.binding.environmentId,
      leaseId: this.binding.leaseId,
      generation: this.binding.generation,
      agentId: this.binding.agentId,
      action: clean(action, 'RPC action', 80).toUpperCase(),
      sequence: this.outboundSequence,
      nonce: crypto.randomBytes(24).toString('base64url'),
      issuedAt: now,
      expiresAt: now + ttlMs,
      body: body == null ? {} : body,
    };
    if (payload.action === 'EXECUTE_LAUNCH_INTENT') payload.body = validateLaunchIntent(payload.body);
    const iv = crypto.randomBytes(12);
    const aad = Buffer.from(`sunday-environment-rpc-v${PROTOCOL_VERSION}`, 'utf8');
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(canonical(payload), 'utf8'), cipher.final()]);
    const unsigned = {
      protocolVersion: PROTOCOL_VERSION,
      algorithm: 'AES-256-GCM+Ed25519',
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
    };
    return Object.freeze(Object.assign({}, unsigned, {
      signature: crypto.sign(null, Buffer.from(canonical(unsigned), 'utf8'), this.privateKey).toString('base64url'),
    }));
  }

  open(envelope) {
    if (this.revoked) throw rpcError('ERPCREVOKED', 'RPC session is revoked.');
    const row = envelope && typeof envelope === 'object' ? envelope : {};
    const unsigned = {
      protocolVersion: row.protocolVersion,
      algorithm: row.algorithm,
      iv: row.iv,
      tag: row.tag,
      ciphertext: row.ciphertext,
    };
    if (row.protocolVersion !== PROTOCOL_VERSION || row.algorithm !== 'AES-256-GCM+Ed25519') {
      throw rpcError('ERPCVERSION', 'RPC envelope version or algorithm is not accepted.');
    }
    let signature;
    try { signature = Buffer.from(clean(row.signature, 'RPC signature'), 'base64url'); } catch (_) { throw rpcError('ERPCSIGNATURE', 'RPC signature is malformed.'); }
    if (!crypto.verify(null, Buffer.from(canonical(unsigned), 'utf8'), this.peerPublicKey, signature)) {
      throw rpcError('ERPCSIGNATURE', 'RPC envelope signature is invalid.');
    }
    let payload;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, Buffer.from(row.iv, 'base64url'));
      decipher.setAAD(Buffer.from(`sunday-environment-rpc-v${PROTOCOL_VERSION}`, 'utf8'));
      decipher.setAuthTag(Buffer.from(row.tag, 'base64url'));
      payload = JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(row.ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8'));
    } catch (_) {
      throw rpcError('ERPCDECRYPT', 'RPC envelope authentication or decryption failed.');
    }
    this._validatePayload(payload);
    this.inboundSequence = payload.sequence;
    this.seen.add(payload.messageId);
    this.seen.add(payload.nonce);
    return payload;
  }

  _validatePayload(payload) {
    if (!payload || payload.protocolVersion !== PROTOCOL_VERSION) throw rpcError('ERPCVERSION', 'RPC payload version is invalid.');
    const fields = {
      environmentId: this.binding.environmentId,
      leaseId: this.binding.leaseId,
      generation: this.binding.generation,
      agentId: this.binding.agentId,
      sender: this.peerRole,
      recipient: this.role,
    };
    for (const [field, expected] of Object.entries(fields)) {
      if (payload[field] !== expected) throw rpcError('ERPCBINDING', `RPC ${field} does not match the authenticated session.`);
    }
    clean(payload.messageId, 'RPC message identity');
    clean(payload.operationId, 'RPC operation identity');
    clean(payload.nonce, 'RPC nonce');
    if (!Number.isSafeInteger(payload.sequence) || payload.sequence !== this.inboundSequence + 1) {
      throw rpcError('ERPCREPLAY', 'RPC sequence is duplicate, stale, or out of order.');
    }
    if (this.seen.has(payload.messageId) || this.seen.has(payload.nonce)) {
      throw rpcError('ERPCREPLAY', 'RPC message identity or nonce was already used.');
    }
    const now = this.now();
    if (!Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt)
        || payload.expiresAt <= now || payload.issuedAt > now + 5000
        || payload.expiresAt - payload.issuedAt > this.maxTtlMs) {
      throw rpcError('ERPCEXPIRED', 'RPC command is expired or has an invalid deadline.');
    }
    if (payload.action === 'EXECUTE_LAUNCH_INTENT') payload.body = validateLaunchIntent(payload.body);
  }
}

module.exports = {
  DEFAULT_TTL_MS,
  PROTOCOL_VERSION,
  SecureRpcEndpoint,
  assertNoLaunchSecrets,
  canonical,
  createSessionKey,
  createSigningIdentity,
  rpcError,
  validateLaunchIntent,
};
