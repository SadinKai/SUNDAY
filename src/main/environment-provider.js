'use strict';

const PROVIDER_STATES = Object.freeze({
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROVIDER_READY: 'PROVIDER_READY',
  QUALIFICATION_REQUIRED: 'QUALIFICATION_REQUIRED',
  QUALIFIED: 'QUALIFIED',
  ACTIVATED: 'ACTIVATED',
  FAILED: 'FAILED',
});

const OPERATIONS = Object.freeze([
  'discover',
  'preflight',
  'provision',
  'allocate',
  'start',
  'connect',
  'health',
  'executeLaunchIntent',
  'observe',
  'stop',
  'restart',
  'release',
  'destroy',
  'recover',
]);

function providerError(code, message) {
  const error = new Error(String(message || code));
  error.code = code;
  return error;
}

function text(value, label, max) {
  const result = String(value || '').trim();
  if (!result || result.length > (max || 256)) {
    throw providerError('EPROVIDERIDENTITY', `${label} is invalid.`);
  }
  return result;
}

function positiveInteger(value, label) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) {
    throw providerError('EPROVIDERIDENTITY', `${label} is invalid.`);
  }
  return result;
}

function validateImageIdentity(value) {
  const row = value && typeof value === 'object' ? value : {};
  const digest = text(row.digest, 'Immutable image digest', 160).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw providerError('EPROVIDERIMAGE', 'Immutable image digest must be a SHA-256 value.');
  }
  return Object.freeze({
    digest,
    windowsVersion: text(row.windowsVersion, 'Guest Windows version'),
    guestAgentBuild: text(row.guestAgentBuild, 'Guest-agent build identity'),
    guestAgentSignature: text(row.guestAgentSignature, 'Guest-agent signature identity'),
    webView2Version: text(row.webView2Version, 'Guest WebView2 version'),
    robloxVersion: text(row.robloxVersion, 'Guest Roblox version'),
    generation: positiveInteger(row.generation, 'Image generation'),
    createdAt: text(row.createdAt, 'Image creation time'),
    providerId: text(row.providerId, 'Image provider identity'),
  });
}

function validateEnvironmentIdentity(value) {
  const row = value && typeof value === 'object' ? value : {};
  return Object.freeze({
    environmentId: text(row.environmentId, 'Environment identity'),
    providerId: text(row.providerId, 'Provider identity'),
    guestId: text(row.guestId, 'Guest identity'),
    vmId: text(row.vmId, 'VM identity'),
    hostId: text(row.hostId, 'Host identity'),
    generation: positiveInteger(row.generation, 'Environment generation'),
    agentId: text(row.agentId, 'Guest-agent identity'),
    image: validateImageIdentity(row.image),
  });
}

function providerResult(state, reason, extra) {
  if (!Object.values(PROVIDER_STATES).includes(state)) {
    throw providerError('EPROVIDERSTATE', `Unknown environment-provider state: ${state}`);
  }
  return Object.assign({
    ok: state === PROVIDER_STATES.ACTIVATED,
    state,
    reason: String(reason || ''),
  }, extra || {});
}

class EnvironmentProvider {
  constructor(options) {
    const opts = options || {};
    this.providerId = text(opts.providerId || 'unconfigured-provider', 'Provider identity');
  }
}

for (const operation of OPERATIONS) {
  EnvironmentProvider.prototype[operation] = async function notImplemented() {
    throw providerError('EPROVIDERNOTIMPLEMENTED', `EnvironmentProvider.${operation}() is not implemented.`);
  };
}

module.exports = {
  EnvironmentProvider,
  OPERATIONS,
  PROVIDER_STATES,
  providerError,
  providerResult,
  validateEnvironmentIdentity,
  validateImageIdentity,
};
