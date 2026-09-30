'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SecureRpcEndpoint,
  createSessionKey,
  createSigningIdentity,
} = require('../src/main/environment-rpc');
const { GuestLocalCredentialVault, WindowsGuestAgent } = require('../src/guest/windows-guest-agent');

function endpoints(options) {
  const opts = options || {};
  const hostIdentity = createSigningIdentity();
  const guestIdentity = createSigningIdentity();
  const encryptionKey = createSessionKey();
  let now = opts.now || 1_800_000_000_000;
  const common = {
    environmentId: opts.environmentId || 'environment-1',
    leaseId: opts.leaseId || 'lease-1',
    generation: opts.generation || 1,
    agentId: opts.agentId || 'agent-1',
    encryptionKey,
    now: () => now,
    maxTtlMs: 15_000,
  };
  return {
    host: new SecureRpcEndpoint(Object.assign({}, common, {
      role: 'HOST_BROKER', peerRole: 'GUEST_AGENT',
      privateKeyPem: hostIdentity.privateKeyPem, peerPublicKeyPem: guestIdentity.publicKeyPem,
    })),
    guest: new SecureRpcEndpoint(Object.assign({}, common, {
      role: 'GUEST_AGENT', peerRole: 'HOST_BROKER',
      privateKeyPem: guestIdentity.privateKeyPem, peerPublicKeyPem: hostIdentity.publicKeyPem,
    })),
    guestIdentity,
    hostIdentity,
    encryptionKey,
    common,
    advance(ms) { now += ms; },
  };
}

const intent = {
  accountHandle: 'guest-account-handle-1',
  target: { type: 'EXACT_SERVER', placeId: '12345', serverId: 'server-abc' },
};

test('RPC commands are encrypted, signed, bound, and reject tampering and replay', () => {
  const pair = endpoints();
  const envelope = pair.host.seal('EXECUTE_LAUNCH_INTENT', intent, { operationId: 'operation-1' });
  const serialized = JSON.stringify(envelope);
  assert.doesNotMatch(serialized, /guest-account-handle|12345|server-abc/);
  const opened = pair.guest.open(envelope);
  assert.equal(opened.environmentId, 'environment-1');
  assert.deepEqual(opened.body, intent);
  assert.throws(() => pair.guest.open(envelope), { code: 'ERPCREPLAY' });

  const second = pair.host.seal('HEALTH', {}, { operationId: 'operation-2' });
  const tampered = Object.assign({}, second, { ciphertext: `${second.ciphertext.slice(0, -2)}aa` });
  assert.throws(() => pair.guest.open(tampered), { code: 'ERPCSIGNATURE' });
});

test('RPC rejects expired commands and wrong environment, lease, generation, or agent bindings', () => {
  const expiry = endpoints();
  const expired = expiry.host.seal('HEALTH', {}, { operationId: 'expiry', ttlMs: 1000 });
  expiry.advance(1001);
  assert.throws(() => expiry.guest.open(expired), { code: 'ERPCEXPIRED' });

  for (const override of [
    { environmentId: 'wrong-environment' },
    { leaseId: 'wrong-lease' },
    { generation: 2 },
    { agentId: 'wrong-agent' },
  ]) {
    const pair = endpoints();
    const wrong = new SecureRpcEndpoint(Object.assign({}, pair.common, override, {
      role: 'GUEST_AGENT', peerRole: 'HOST_BROKER',
      privateKeyPem: pair.guestIdentity.privateKeyPem,
      peerPublicKeyPem: pair.hostIdentity.publicKeyPem,
    }));
    const envelope = pair.host.seal('HEALTH', {}, { operationId: `wrong-${Object.keys(override)[0]}` });
    assert.throws(() => wrong.open(envelope), { code: 'ERPCBINDING' });
  }
});

test('host launch schema rejects raw credentials, tickets, deep links, and ambiguous fields', () => {
  const pair = endpoints();
  for (const body of [
    { accountHandle: 'a', target: { type: 'HOME' }, cookie: 'raw' },
    { accountHandle: 'a', target: { type: 'HOME', deeplink: 'roblox-player:1' } },
    { accountHandle: 'a', target: { type: 'HOME' }, password: 'raw' },
    { accountHandle: 'a', target: { type: 'HOME' }, ticket: 'raw' },
    { accountHandle: 'a', target: { type: 'HOME' }, extra: true },
  ]) {
    assert.throws(
      () => pair.host.seal('EXECUTE_LAUNCH_INTENT', body, { operationId: `secret-${Math.random()}` }),
      error => ['ERPCSECRET', 'ERPCINTENT'].includes(error.code),
    );
  }
});

test('guest agent provides operation idempotency but rejects reused identities with different commands', async () => {
  const pair = endpoints();
  const agent = new WindowsGuestAgent({
    endpoint: pair.guest,
    binding: { environmentId: 'environment-1', leaseId: 'lease-1', generation: 1, agentId: 'agent-1' },
    credentialVault: new GuestLocalCredentialVault({ guestLocal: true, resolve: async () => 'local-only-secret' }),
    launcher: {
      async spawn() { throw new Error('not used'); },
      async inspect() { return { status: 'UNKNOWN' }; },
      async stop() { return { ok: false, confirmed: false }; },
    },
    syntheticTestOnly: true,
  });
  const first = pair.host.seal('HEALTH', {}, { operationId: 'same-operation' });
  const firstReply = pair.host.open(await agent.handle(first));
  const retry = pair.host.seal('HEALTH', {}, { operationId: 'same-operation' });
  const retryReply = pair.host.open(await agent.handle(retry));
  assert.deepEqual(retryReply.body, firstReply.body);

  const changed = pair.host.seal('OBSERVE', { processCapability: 'different' }, { operationId: 'same-operation' });
  const changedReply = pair.host.open(await agent.handle(changed));
  assert.equal(changedReply.body.ok, false);
  assert.equal(changedReply.body.code, 'EAGENTIDEMPOTENCY');
});

test('revoked sessions cannot seal or open further commands', () => {
  const pair = endpoints();
  const envelope = pair.host.seal('HEALTH', {}, { operationId: 'before-revoke' });
  pair.guest.revoke();
  assert.throws(() => pair.guest.open(envelope), { code: 'ERPCREVOKED' });
  assert.throws(() => pair.guest.seal('RESPONSE', {}, { operationId: 'after-revoke' }), { code: 'ERPCREVOKED' });
});
