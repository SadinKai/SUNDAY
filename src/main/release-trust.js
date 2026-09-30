'use strict';

const crypto = require('crypto');
const { validateUrl, POLICIES } = require('./http-policy');
const { LEGACY_RELEASE_PRODUCT } = require('./legacy-identity-compat');

function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON cannot contain a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new Error(`Canonical JSON cannot encode ${typeof value}.`);
}

function exactKeys(value, required, optional, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const allowed = new Set(required.concat(optional || []));
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} contains an unknown field: ${key}`);
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`${label} is missing ${key}.`);
}

function validSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validVersion(value) {
  return typeof value === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function validateAllowedPath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.includes('\\')) throw new Error('Manifest file path is invalid.');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes(':') || /[. ]$/.test(part))) {
    throw new Error('Manifest file path is unsafe.');
  }
  return value;
}

function unsignedManifest(manifest) {
  const copy = Object.assign({}, manifest);
  delete copy.signature;
  return copy;
}

function parseAndVerifyManifest(input, options) {
  const opts = options || {};
  if (!opts.publicKeySpkiBase64) throw new Error('The embedded release public key is not configured.');
  const manifest = typeof input === 'string' ? JSON.parse(input) : JSON.parse(JSON.stringify(input));
  exactKeys(manifest,
    ['schemaVersion', 'product', 'version', 'releaseSequence', 'artifacts', 'signing', 'signature'],
    [], 'Release manifest');
  // Accept the former product marker only for already-published signed manifests.
  // Newly generated manifests identify the rebranded product as SUNDAY Launcher.
  if (manifest.schemaVersion !== 1 || !['SUNDAY Launcher', LEGACY_RELEASE_PRODUCT].includes(manifest.product) || !validVersion(manifest.version)) {
    throw new Error('Release manifest identity or version is invalid.');
  }
  if (!Number.isSafeInteger(manifest.releaseSequence) || manifest.releaseSequence <= 0) {
    throw new Error('Release sequence must be a positive safe integer.');
  }
  const minimumSequence = Number(opts.minimumSequence) || 0;
  if (manifest.releaseSequence <= minimumSequence) throw new Error('Release sequence is not newer than the accepted release.');
  exactKeys(manifest.signing, ['algorithm', 'keyId', 'publisher'], [], 'Manifest signing metadata');
  if (manifest.signing.algorithm !== 'Ed25519' || !/^[A-Za-z0-9._-]{1,80}$/.test(manifest.signing.keyId)) {
    throw new Error('Manifest signing metadata is invalid.');
  }
  if (!opts.publisher || manifest.signing.publisher !== opts.publisher) {
    throw new Error('Release publisher does not match the embedded publisher identity.');
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length < 1 || manifest.artifacts.length > 16) {
    throw new Error('Release manifest artifact count is invalid.');
  }
  const artifactNames = new Set();
  for (const artifact of manifest.artifacts) {
    exactKeys(artifact, ['name', 'url', 'sha256', 'size', 'allowedFiles'], [], 'Release artifact');
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(artifact.name) || artifactNames.has(artifact.name)) {
      throw new Error('Release artifact name is invalid or duplicated.');
    }
    artifactNames.add(artifact.name);
    validateUrl(artifact.url, POLICIES.updateArtifact);
    if (!validSha256(artifact.sha256) || !Number.isSafeInteger(artifact.size)
        || artifact.size <= 0 || artifact.size > POLICIES.updateArtifact.maxBytes) {
      throw new Error('Release artifact size or hash is invalid.');
    }
    if (!Array.isArray(artifact.allowedFiles) || !artifact.allowedFiles.length || artifact.allowedFiles.length > 20000) {
      throw new Error('Release artifact allowed-file list is invalid.');
    }
    const paths = new Set();
    for (const file of artifact.allowedFiles) {
      exactKeys(file, ['path', 'size', 'sha256'], [], 'Release artifact file');
      const normalized = validateAllowedPath(file.path).toLowerCase();
      if (paths.has(normalized) || !Number.isSafeInteger(file.size) || file.size < 0 || !validSha256(file.sha256)) {
        throw new Error('Release artifact file metadata is invalid or duplicated.');
      }
      paths.add(normalized);
    }
  }
  let publicKey;
  try {
    publicKey = crypto.createPublicKey({
      key: Buffer.from(opts.publicKeySpkiBase64, 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch (_) {
    throw new Error('The embedded release public key is invalid.');
  }
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('The embedded release key is not Ed25519.');
  let signature;
  try { signature = Buffer.from(manifest.signature, 'base64'); }
  catch (_) { throw new Error('Release manifest signature encoding is invalid.'); }
  if (signature.length !== 64 || !crypto.verify(null, Buffer.from(canonicalize(unsignedManifest(manifest))), publicKey, signature)) {
    throw new Error('Release manifest signature verification failed.');
  }
  return deepFreeze(manifest);
}

function verifyArtifactBuffer(buffer, artifact) {
  if (!Buffer.isBuffer(buffer)) throw new Error('Artifact verification requires a buffer.');
  if (buffer.length !== artifact.size) throw new Error('Downloaded artifact size does not match the signed manifest.');
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(digest, 'ascii'), Buffer.from(artifact.sha256, 'ascii'))) {
    throw new Error('Downloaded artifact hash does not match the signed manifest.');
  }
  return true;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

module.exports = {
  canonicalize,
  unsignedManifest,
  parseAndVerifyManifest,
  verifyArtifactBuffer,
  validateAllowedPath,
};
