'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { StateDatabase } = require('../src/main/state-database');
const { EnvironmentBroker } = require('../src/main/environment-broker');
const { BrokeredRobloxIsolationAdapter } = require('../src/main/roblox-isolation-adapter');
const { LaunchCoordinator, LaunchPlanStore } = require('../src/main/launch-orchestration');
const { SyntheticEnvironmentProvider } = require('./support/synthetic-environment-provider');

function participants(count) {
  return Array.from({ length: count }, (_, index) => ({
    accountId: `guest-account-${index + 1}`,
    label: `Synthetic guest ${index + 1}`,
  }));
}

function request(count) {
  return {
    name: `Phase 6 synthetic ${count}`,
    participants: participants(count),
    target: { type: 'EXACT_SERVER', placeId: '12345', serverId: 'synthetic-server' },
    launchDelayMs: 1,
  };
}

function fixture(prefix, providerOptions, coordinatorOptions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const database = new StateDatabase({ path: path.join(dir, 'state.sqlite3'), assertOwner: () => true });
  const provider = new SyntheticEnvironmentProvider(providerOptions);
  const broker = new EnvironmentBroker({ provider, database });
  const adapter = new BrokeredRobloxIsolationAdapter({ broker });
  const coordinator = new LaunchCoordinator(Object.assign({
    adapter,
    store: new LaunchPlanStore({ database }),
    resolveIntent: async operation => ({
      ok: true,
      intent: { accountHandle: operation.accountId, target: operation.target },
    }),
    operationTimeoutMs: 5000,
  }, coordinatorOptions || {}));
  return {
    dir, database, provider, broker, adapter, coordinator,
    async cleanup() {
      await provider.shutdown();
      database.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function stopAndRelease(f, plan) {
  for (const operation of plan.operations) {
    if (operation.state === 'RUNNING') {
      const stopped = await f.coordinator.stop(plan.planId, operation.operationId);
      assert.equal(stopped.ok, true);
    }
  }
}

test('synthetic provider proves protocol-bound 1, 2, and 3 environment orchestration only', async () => {
  for (const count of [1, 2, 3]) {
    const f = fixture(`sunday-phase6-${count}-`);
    try {
      const launched = await f.coordinator.prepare(request(count));
      assert.equal(launched.ok, true);
      assert.equal(launched.launched, count);
      assert.equal(new Set(launched.plan.operations.map(item => item.environmentId)).size, count);
      assert.equal(new Set(launched.plan.operations.map(item => item.pid)).size, count);
      assert.doesNotMatch(JSON.stringify(launched.plan), /guest-local-secret|cookie|password|ticket|deeplink/i);

      const records = launched.plan.operations.map(item => f.provider.recordOf(item.environmentId));
      assert.equal(new Set(records.map(item => item.root)).size, count);
      assert.equal(records.every(item => item.root !== f.provider.baseImageDir), true);
      assert.equal(records.every(item => fs.existsSync(path.join(item.writableDisk, 'RobloxPlayerBetaSingletonMutex'))), true);
      assert.equal(new Set(records.map(item => path.join(item.writableDisk, 'RobloxPlayerBetaSingletonMutex'))).size, count);
      assert.equal(records.every(item => item.localSecrets.size === 1), true);
      await stopAndRelease(f, launched.plan);
      assert.equal(records.every(item => item.destroyed && !fs.existsSync(item.root)), true);
      assert.equal(fs.existsSync(f.provider.baseImageDir), true);
    } finally { await f.cleanup(); }
  }
});

test('partial allocation failure does not disturb other environment leases', async () => {
  const f = fixture('sunday-phase6-partial-', { failAllocationOrders: [2] });
  try {
    const launched = await f.coordinator.prepare(request(3));
    assert.equal(launched.ok, false);
    assert.deepEqual(launched.plan.operations.map(item => item.state), ['RUNNING', 'FAILED', 'RUNNING']);
    assert.equal(f.broker.leases.list().filter(item => item.state === 'ACTIVE').length, 2);
    await stopAndRelease(f, launched.plan);
  } finally { await f.cleanup(); }
});

test('guest launch failure remains local and does not disturb a sibling environment', async () => {
  const f = fixture('sunday-phase6-launch-failure-', { failLaunchOrders: [2] });
  try {
    const launched = await f.coordinator.prepare(request(2));
    assert.equal(launched.ok, false);
    assert.deepEqual(launched.plan.operations.map(item => item.state), ['RUNNING', 'FAILED']);
    assert.equal(launched.plan.operations[1].failureCode, 'LAUNCH_FAILED');
    assert.match(launched.plan.operations[1].reason, /could not be launched/i);
    assert.equal((await f.adapter.observe(launched.plan.operations[0].capability, { operationId: 'sibling-still-running' })).status, 'RUNNING');
    await stopAndRelease(f, launched.plan);
  } finally { await f.cleanup(); }
});

test('guest launch timeout revokes and destroys the exact environment', async () => {
  const f = fixture('sunday-phase6-timeout-', { hangLaunchOrders: [1] }, { operationTimeoutMs: 100 });
  try {
    const launched = await f.coordinator.prepare(request(1));
    assert.equal(launched.ok, false);
    assert.equal(launched.plan.operations[0].state, 'FAILED', JSON.stringify(launched.plan.operations[0]));
    await new Promise(resolve => setTimeout(resolve, 25));
    const record = f.provider.environments.get(launched.plan.operations[0].environmentId);
    assert.equal(record.destroyed, true);
    assert.equal(f.broker.leases.list()[0].state, 'REVOKED');
  } finally { await f.cleanup(); }
});

test('launch cancellation revokes and destroys an in-flight environment', async () => {
  const f = fixture('sunday-phase6-cancel-', { hangLaunchOrders: [1] }, { operationTimeoutMs: 5000 });
  try {
    let planId = null;
    f.coordinator.on('update', plan => { planId = planId || plan.planId; });
    const pending = f.coordinator.prepare(request(1));
    while (!planId || !f.coordinator.active.has(planId)
      || f.coordinator.get(planId).operations[0].state !== 'LAUNCHING') {
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    await f.coordinator.cancel(planId);
    const cancelled = await pending;
    assert.equal(cancelled.plan.state, 'CANCELLED');
    await new Promise(resolve => setTimeout(resolve, 25));
    const environmentId = cancelled.plan.operations[0].environmentId;
    const record = f.provider.environments.get(environmentId);
    assert.equal(record.destroyed, true);
    assert.equal(f.broker.leases.list()[0].state, 'REVOKED');
  } finally { await f.cleanup(); }
});

test('close-one and restart-one preserve the independent sibling environment', async () => {
  const f = fixture('sunday-phase6-control-');
  try {
    const launched = await f.coordinator.prepare(request(2));
    const [first, second] = launched.plan.operations;
    const stopped = await f.coordinator.stop(launched.planId, first.operationId);
    assert.equal(stopped.ok, true);
    assert.equal((await f.adapter.observe(second.capability, { operationId: 'after-close-sibling' })).status, 'RUNNING');
    const restarted = await f.coordinator.restart(launched.planId, second.operationId);
    assert.equal(restarted.ok, true, JSON.stringify(restarted));
    assert.notEqual(restarted.operation.pid, second.pid);
    assert.equal((await f.adapter.observe(restarted.operation.capability, { operationId: 'after-restart' })).status, 'RUNNING');
    await f.coordinator.stop(launched.planId, second.operationId);
  } finally { await f.cleanup(); }
});

test('network loss, agent crash, and process identity replacement fail closed', async () => {
  const f = fixture('sunday-phase6-faults-');
  try {
    const launched = await f.coordinator.prepare(request(3));
    const [networked, crashed, replaced] = launched.plan.operations;

    f.provider.setNetwork(networked.environmentId, false);
    const networkLost = await f.adapter.observe(networked.capability, { operationId: 'network-lost' });
    assert.equal(networkLost.ok, false);
    assert.match(networkLost.reason, /network/i);
    f.provider.setNetwork(networked.environmentId, true);
    assert.equal((await f.adapter.observe(networked.capability, { operationId: 'network-restored' })).status, 'RUNNING');

    f.provider.crashAgent(crashed.environmentId);
    const agentLost = await f.adapter.observe(crashed.capability, { operationId: 'agent-lost' });
    assert.equal(agentLost.ok, false);
    assert.match(agentLost.reason, /agent/i);
    f.provider.restoreAgent(crashed.environmentId);
    assert.equal((await f.adapter.observe(crashed.capability, { operationId: 'agent-restored' })).status, 'RUNNING');

    f.provider.replaceProcessIdentity(replaced.environmentId);
    const identityLost = await f.adapter.observe(replaced.capability, { operationId: 'identity-replaced' });
    assert.equal(identityLost.ok, false);
    assert.equal(identityLost.status, 'UNKNOWN');
  } finally { await f.cleanup(); }
});

test('PID reuse evidence invalidates the guest process capability', async () => {
  const f = fixture('sunday-phase6-pid-');
  try {
    const launched = await f.coordinator.prepare(request(1));
    const operation = launched.plan.operations[0];
    f.provider.replacePid(operation.environmentId);
    const observation = await f.adapter.observe(operation.capability, { operationId: 'pid-reused' });
    assert.equal(observation.ok, false);
    assert.equal(observation.status, 'UNKNOWN');
  } finally { await f.cleanup(); }
});

test('broker restart quarantines durable leases and never adopts existing guests', async () => {
  const f = fixture('sunday-phase6-recovery-');
  try {
    const launched = await f.coordinator.prepare(request(1));
    const secondBroker = new EnvironmentBroker({ provider: f.provider, database: f.database });
    assert.equal(secondBroker.recovered.length, 1);
    assert.equal(secondBroker.leases.list()[0].state, 'RECOVERY_REQUIRED');
    await assert.rejects(
      () => f.adapter.observe(launched.plan.operations[0].capability, { operationId: 'after-restart' }),
      error => ['EENVLEASEREVOKED', 'EENVLEASEEXPIRED', 'EENVLEASESTATE'].includes(error.code),
    );
    const recovery = await f.provider.recover();
    assert.equal(recovery.adopted, false);
    assert.equal(recovery.state, 'QUALIFICATION_REQUIRED');
  } finally { await f.cleanup(); }
});

test('missing guest-local account provisioning blocks launch without host credential fallback', async () => {
  const f = fixture('sunday-phase6-vault-');
  try {
    const allocated = await f.broker.allocate({ operationId: 'vault-operation', accountHandle: 'guest-account-1', order: 1 });
    assert.equal(allocated.ok, true);
    f.provider.recordOf(allocated.environmentId).localSecrets.clear();
    const launched = await f.broker.executeLaunchIntent(
      allocated.environmentCapability,
      { accountHandle: 'guest-account-1', target: { type: 'HOME' } },
      'vault-launch',
    );
    assert.equal(launched.ok, false);
    assert.match(launched.reason, /guest-local account handle is not provisioned/i);
    const released = await f.broker.release(allocated.environmentCapability);
    assert.equal(released.destroyed, true);
  } finally { await f.cleanup(); }
});

test('one-process cap rejects a second launch in the same environment', async () => {
  const f = fixture('sunday-phase6-cap-');
  try {
    const allocated = await f.broker.allocate({ operationId: 'cap-operation', accountHandle: 'guest-account-1', order: 1 });
    const intent = { accountHandle: 'guest-account-1', target: { type: 'HOME' } };
    const first = await f.broker.executeLaunchIntent(allocated.environmentCapability, intent, 'cap-launch-1');
    assert.equal(first.ok, true);
    await assert.rejects(
      () => f.broker.executeLaunchIntent(allocated.environmentCapability, intent, 'cap-launch-2'),
      { code: 'EBROKERCAP' },
    );
    assert.equal((await f.broker.stop(first.processCapability, 'cap-stop')).confirmed, true);
    assert.equal((await f.broker.release(allocated.environmentCapability)).destroyed, true);
  } finally { await f.cleanup(); }
});
