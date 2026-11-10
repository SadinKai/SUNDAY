'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { StateDatabase } = require('../src/main/state-database');
const {
  LaunchCoordinator,
  LaunchPlanStore,
  PLAN_STATES,
} = require('../src/main/launch-orchestration');
const {
  ISOLATION_STATES,
  UnavailableRobloxIsolationAdapter,
} = require('../src/main/roblox-isolation-adapter');
const { planServerFill } = require('../src/main/server-fill-planner');
const { InstanceKeeper } = require('../src/main/keeper');
const { SyntheticIsolationAdapter } = require('./support/synthetic-isolation-adapter');

function fixture(prefix, adapterOptions, coordinatorOptions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const database = new StateDatabase({ path: path.join(dir, 'state.sqlite3'), assertOwner: () => true });
  const adapter = new SyntheticIsolationAdapter(adapterOptions);
  const store = new LaunchPlanStore({ database });
  const coordinator = new LaunchCoordinator(Object.assign({
    adapter,
    store,
    resolveIntent: async operation => ({
      ok: true,
      intent: { accountHandle: operation.accountId, target: operation.target },
    }),
  }, coordinatorOptions || {}));
  return {
    dir, database, adapter, store, coordinator,
    async cleanup() {
      await adapter.shutdown();
      database.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function participants(count) {
  return Array.from({ length: count }, (_, index) => ({ accountId: `account-${index + 1}`, label: `Account ${index + 1}` }));
}

function request(count, extra) {
  return Object.assign({
    name: `Synthetic ${count}`,
    participants: participants(count),
    target: { type: 'EXACT_SERVER', placeId: '12345', serverId: 'synthetic-server' },
    launchDelayMs: 5,
  }, extra || {});
}

test('UNAVAILABLE prepares a complete 6-account plan without resolving tickets or creating processes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-phase5-unavailable-'));
  const database = new StateDatabase({ path: path.join(dir, 'state.sqlite3'), assertOwner: () => true });
  try {
    let ticketCalls = 0;
    const coordinator = new LaunchCoordinator({
      adapter: new UnavailableRobloxIsolationAdapter('No qualified environment.'),
      store: new LaunchPlanStore({ database }),
      resolveIntent: async () => { ticketCalls += 1; throw new Error('must not run'); },
    });
    const response = await coordinator.prepare(request(6));
    assert.equal(response.ok, false);
    assert.equal(response.prepared, true);
    assert.equal(response.state, ISOLATION_STATES.UNAVAILABLE);
    assert.equal(response.selectedCount, 6);
    assert.equal(ticketCalls, 0);
    assert.equal(response.plan.state, PLAN_STATES.BLOCKED);
    assert.equal(response.plan.operations.every(operation => operation.state === 'UNAVAILABLE'), true);
    assert.equal(new Set(response.plan.operations.map(operation => operation.operationId)).size, 6);
    assert.equal(coordinator.list().length, 1);
    assert.doesNotMatch(JSON.stringify(response.plan), /cookie|ticket|deeplink|password/i);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('QUALIFIED but not ACTIVATED remains blocked before intent resolution', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-phase5-qualified-'));
  const database = new StateDatabase({ path: path.join(dir, 'state.sqlite3'), assertOwner: () => true });
  try {
    let resolverCalls = 0;
    const adapter = {
      async preflight() { return { ok: false, state: ISOLATION_STATES.QUALIFIED, reason: 'Evidence exists, activation does not.' }; },
      async allocateInstance() { throw new Error('must not allocate'); },
    };
    const coordinator = new LaunchCoordinator({
      adapter,
      store: new LaunchPlanStore({ database }),
      resolveIntent: async () => { resolverCalls += 1; throw new Error('must not resolve'); },
    });
    const response = await coordinator.prepare(request(2));
    assert.equal(response.state, ISOLATION_STATES.QUALIFIED);
    assert.equal(response.prepared, true);
    assert.equal(response.plan.operations.every(operation => operation.state === 'BLOCKED'), true);
    assert.equal(resolverCalls, 0);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SYNTHETIC / TEST ONLY adapter proves stable 1 through 6 instance orchestration', async () => {
  for (const count of [1, 2, 3, 4, 5, 6]) {
    const f = fixture(`sunday-phase5-${count}-`, { stableMs: 15 });
    try {
      const response = await f.coordinator.prepare(request(count));
      assert.equal(response.ok, true);
      assert.equal(response.plan.state, PLAN_STATES.COMPLETED);
      assert.equal(response.launched, count);
      assert.equal(response.plan.operations.every(operation => operation.state === 'RUNNING' && operation.capability && operation.pid), true);
      assert.equal(new Set(response.plan.operations.map(operation => operation.operationId)).size, count);
      assert.equal(new Set(response.plan.operations.map(operation => operation.pid)).size, count);
      assert.equal((await f.adapter.health()).running, count);
      assert.deepEqual(
        f.adapter.sequence.filter(entry => entry.type === 'launch').map(entry => entry.operationId),
        response.plan.operations.map(operation => operation.operationId),
      );
    } finally { await f.cleanup(); }
  }
});

test('additive plans launch 2 then 3 through 6 without relaunching existing operations', async () => {
  const f = fixture('sunday-phase5-incremental-', { stableMs: 10 });
  try {
    const plans = [];
    plans.push(await f.coordinator.prepare(request(2)));
    for (let index = 3; index <= 6; index += 1) {
      plans.push(await f.coordinator.prepare(request(1, {
        name: `Incremental ${index}`,
        participants: [{ accountId: `account-${index}`, label: `Account ${index}` }],
      })));
    }
    assert.equal(plans.every(response => response.ok), true);
    assert.deepEqual(plans.map(response => response.selectedCount), [2, 1, 1, 1, 1]);
    const operations = plans.flatMap(response => response.plan.operations);
    assert.equal(new Set(operations.map(operation => operation.operationId)).size, 6);
    assert.equal(new Set(operations.map(operation => operation.pid)).size, 6);
    assert.equal((await f.adapter.health()).running, 6);
    assert.deepEqual(
      f.adapter.sequence.filter(entry => entry.type === 'launch').map(entry => entry.operationId),
      operations.map(operation => operation.operationId),
    );
  } finally { await f.cleanup(); }
});

test('cancelling a later additive plan cannot stop clients from an earlier completed plan', async () => {
  const f = fixture('sunday-phase5-additive-cancel-', { stableMs: 10, hangLaunches: [1] }, { operationTimeoutMs: 5000 });
  try {
    f.adapter.hangLaunches.clear();
    const first = await f.coordinator.prepare(request(2));
    const originalPids = first.plan.operations.map(operation => operation.pid);
    f.adapter.hangLaunches.add(1);
    let laterPlanId = '';
    const onUpdate = plan => {
      if (plan.name === 'Later C') laterPlanId = plan.planId;
    };
    f.coordinator.on('update', onUpdate);
    const pending = f.coordinator.prepare(request(1, {
      name: 'Later C',
      participants: [{ accountId: 'account-3', label: 'Account 3' }],
    }));
    while (!laterPlanId || !f.coordinator.active.has(laterPlanId)) await new Promise(resolve => setTimeout(resolve, 5));
    await f.coordinator.cancel(laterPlanId);
    const cancelled = await pending;
    assert.equal(cancelled.plan.state, PLAN_STATES.CANCELLED);
    assert.equal((await f.adapter.health()).running, 2);
    const stillRunning = Array.from(f.adapter.capabilities.values())
      .filter(record => record.state === 'RUNNING').map(record => record.pid).sort((a, b) => a - b);
    assert.deepEqual(stillRunning, originalPids.sort((a, b) => a - b));
  } finally { await f.cleanup(); }
});

test('synthetic partial allocation failure does not disturb independently owned instances', async () => {
  const f = fixture('sunday-phase5-partial-', { failAllocations: [2], stableMs: 10 });
  try {
    const response = await f.coordinator.prepare(request(3));
    assert.equal(response.ok, false);
    assert.equal(response.plan.state, PLAN_STATES.PARTIAL);
    assert.deepEqual(response.plan.operations.map(operation => operation.state), ['RUNNING', 'FAILED', 'RUNNING']);
    assert.equal((await f.adapter.health()).running, 2);
    const failed = response.plan.operations[1];
    assert.equal(failed.failureCode, 'LAUNCH_FAILED');
    assert.match(failed.reason, /could not be launched/);
  } finally { await f.cleanup(); }
});

test('cancelling a terminal partial plan preserves its running and failed evidence', async () => {
  const f = fixture('sunday-phase5-terminal-cancel-', { failAllocations: [2], stableMs: 10 });
  try {
    const response = await f.coordinator.prepare(request(2));
    assert.equal(response.plan.state, PLAN_STATES.PARTIAL);
    const statesBefore = response.plan.operations.map(operation => operation.state);
    const cancelled = await f.coordinator.cancel(response.plan.planId);
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.plan.state, PLAN_STATES.PARTIAL);
    assert.deepEqual(cancelled.plan.operations.map(operation => operation.state), statesBefore);
    assert.equal((await f.adapter.health()).running, 1);
  } finally { await f.cleanup(); }
});

test('close-one and restart-one are capability-bound and leave sibling instances running', async () => {
  const f = fixture('sunday-phase5-control-', { stableMs: 10 });
  try {
    const launched = await f.coordinator.prepare(request(3));
    const [first, second, third] = launched.plan.operations;
    const stopped = await f.coordinator.stop(launched.planId, first.operationId);
    assert.equal(stopped.ok, true);
    assert.equal(stopped.plan.operations[0].state, 'STOPPED');
    const restarted = await f.coordinator.restart(launched.planId, second.operationId);
    assert.equal(restarted.ok, true);
    assert.notEqual(restarted.operation.pid, second.pid);
    assert.notEqual(restarted.operation.capability, second.capability);
    assert.equal((await f.adapter.observe(third.capability)).status, 'RUNNING');
    assert.equal((await f.adapter.health()).running, 2);
  } finally { await f.cleanup(); }
});

test('restart persistence failure rolls back the exact replacement process', async () => {
  const f = fixture('sunday-phase5-restart-persist-', { stableMs: 10 });
  try {
    const launched = await f.coordinator.prepare(request(1));
    const operation = launched.plan.operations[0];
    const originalUpdate = f.store.update.bind(f.store);
    let failNextUpdate = true;
    f.store.update = (planId, mutator) => {
      if (failNextUpdate) {
        failNextUpdate = false;
        throw new Error('Injected restart persistence failure.');
      }
      return originalUpdate(planId, mutator);
    };

    const restarted = await f.coordinator.restart(launched.planId, operation.operationId);
    assert.equal(restarted.ok, false);
    assert.equal(restarted.plan.operations[0].state, 'STOPPED');
    assert.match(restarted.error, /restart state.*could not be recorded/i);
    assert.equal((await f.adapter.health()).running, 0);
    assert.equal(f.coordinator.capabilityForOperation(operation.operationId), '');
    assert.equal(Array.from(f.adapter.environments.values()).every(environment => environment.released), true);
  } finally { await f.cleanup(); }
});

test('restart persistence failure preserves replacement authority when rollback is unconfirmed', async () => {
  const f = fixture('sunday-phase5-restart-recovery-', { stableMs: 10 });
  const originalStop = f.adapter.stop.bind(f.adapter);
  try {
    const launched = await f.coordinator.prepare(request(1));
    const operation = launched.plan.operations[0];
    const originalUpdate = f.store.update.bind(f.store);
    let failNextUpdate = true;
    let stopCalls = 0;
    f.store.update = (planId, mutator) => {
      if (failNextUpdate) {
        failNextUpdate = false;
        throw new Error('Injected restart persistence failure.');
      }
      return originalUpdate(planId, mutator);
    };
    f.adapter.stop = async (...args) => {
      stopCalls += 1;
      if (stopCalls === 2) {
        return { ok: false, confirmed: false, reason: 'Injected replacement cleanup uncertainty.' };
      }
      return originalStop(...args);
    };

    const restarted = await f.coordinator.restart(launched.planId, operation.operationId);
    assert.equal(restarted.ok, false);
    assert.equal(restarted.plan.state, PLAN_STATES.RECOVERY_REQUIRED);
    assert.equal(restarted.plan.operations[0].state, 'UNKNOWN');
    assert.equal(restarted.plan.operations[0].failureCode, 'CLEANUP_UNCONFIRMED');
    assert.notEqual(restarted.plan.operations[0].capability, operation.capability);
    assert.equal(f.coordinator.capabilityForOperation(operation.operationId), restarted.plan.operations[0].capability);
    assert.equal((await f.adapter.health()).running, 1);
  } finally {
    f.adapter.stop = originalStop;
    await f.cleanup();
  }
});

test('concurrent restart and stop requests cannot mutate the same operation twice', async () => {
  const f = fixture('sunday-phase5-lifecycle-race-', { stableMs: 10 });
  let releaseRestart;
  let restartReached;
  try {
    const launched = await f.coordinator.prepare(request(1));
    const operation = launched.plan.operations[0];
    const originalRestart = f.adapter.restart.bind(f.adapter);
    const restartGate = new Promise(resolve => { releaseRestart = resolve; });
    const entered = new Promise(resolve => { restartReached = resolve; });
    let restartCalls = 0;
    f.adapter.restart = async (...args) => {
      restartCalls += 1;
      restartReached();
      await restartGate;
      return originalRestart(...args);
    };

    const firstPending = f.coordinator.restart(launched.planId, operation.operationId);
    await entered;
    const secondPending = f.coordinator.stop(launched.planId, operation.operationId);
    const callsBeforeRelease = restartCalls;
    releaseRestart();
    const [first, second] = await Promise.all([firstPending, secondPending]);

    assert.equal(callsBeforeRelease, 1);
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.match(second.error, /lifecycle action.*already in progress/i);
  } finally {
    if (releaseRestart) releaseRestart();
    await f.cleanup();
  }
});

test('plan cancellation does not claim an in-flight restart was rolled back', async () => {
  const f = fixture('sunday-phase5-restart-cancel-', { stableMs: 10 });
  let releaseRestart;
  try {
    const launched = await f.coordinator.prepare(request(1));
    const operation = launched.plan.operations[0];
    const originalRestart = f.adapter.restart.bind(f.adapter);
    const restartGate = new Promise(resolve => { releaseRestart = resolve; });
    let restartReached;
    const entered = new Promise(resolve => { restartReached = resolve; });
    f.adapter.restart = async (...args) => {
      restartReached();
      await restartGate;
      return originalRestart(...args);
    };

    const restarting = f.coordinator.restart(launched.planId, operation.operationId);
    await entered;
    const cancellation = await f.coordinator.cancel(launched.planId);
    assert.equal(cancellation.ok, true);
    assert.equal(cancellation.plan.state, PLAN_STATES.COMPLETED);
    assert.notEqual(cancellation.plan.state, PLAN_STATES.CANCELLED);
    releaseRestart();
    const restarted = await restarting;
    assert.equal(restarted.ok, true);
  } finally {
    if (releaseRestart) releaseRestart();
    await f.cleanup();
  }
});

test('stop clears stale authority when environment release throws after confirmed exit', async () => {
  const f = fixture('sunday-phase5-stop-release-throw-', { stableMs: 10 });
  try {
    const launched = await f.coordinator.prepare(request(1));
    const operation = launched.plan.operations[0];
    f.adapter.release = async () => { throw new Error('Injected release exception.'); };
    const stopped = await f.coordinator.stop(launched.planId, operation.operationId);
    assert.equal(stopped.ok, false);
    assert.equal(stopped.plan.state, PLAN_STATES.RECOVERY_REQUIRED);
    assert.equal(stopped.plan.operations[0].state, 'UNKNOWN');
    assert.equal(stopped.plan.operations[0].failureCode, 'CLEANUP_UNCONFIRMED');
    assert.equal(stopped.plan.operations[0].capability, null);
    assert.equal(stopped.plan.operations[0].pid, null);
    assert.equal(f.coordinator.capabilityForOperation(operation.operationId), '');
    assert.match(stopped.error, /release.*not confirmed/i);
  } finally {
    await f.cleanup();
  }
});

test('restart propagates release-only cleanup uncertainty to the plan', async () => {
  const f = fixture('sunday-phase5-restart-release-unknown-', { stableMs: 10 });
  try {
    const launched = await f.coordinator.prepare(request(1));
    const operation = launched.plan.operations[0];
    f.adapter.restart = async (_intent, context) => {
      const stopped = await f.adapter.stop(context.capability);
      assert.equal(stopped.confirmed, true);
      return {
        ok: false,
        state: ISOLATION_STATES.ACTIVATED,
        previousStopped: true,
        status: 'UNKNOWN',
        environmentId: context.environmentId,
        reason: 'Injected restart environment release uncertainty.',
      };
    };

    const restarted = await f.coordinator.restart(launched.planId, operation.operationId);
    assert.equal(restarted.ok, false);
    assert.equal(restarted.plan.state, PLAN_STATES.RECOVERY_REQUIRED);
    assert.equal(restarted.plan.operations[0].state, 'UNKNOWN');
    assert.equal(restarted.plan.operations[0].failureCode, 'CLEANUP_UNCONFIRMED');
    assert.equal(restarted.plan.operations[0].capability, null);
    assert.equal(f.coordinator.capabilityForOperation(operation.operationId), '');
    assert.equal(f.coordinator.operationEnvironments.get(operation.operationId), operation.environmentId);
    assert.equal((await f.adapter.health()).running, 0);
  } finally {
    await f.cleanup();
  }
});

test('shutdown drains in-flight launch compensation before the database closes and preserves completed clients', async () => {
  const f = fixture('sunday-shutdown-launch-', { stableMs: 5 }, { operationTimeoutMs: 5000 });
  try {
    const completed = await f.coordinator.prepare(request(1));
    assert.equal(completed.ok, true);
    f.coordinator.resolveIntent = async () => new Promise(() => {});
    const pending = f.coordinator.prepare(request(1, { participants: [{ accountId: 'other-account', label: 'Other' }] }));
    while (![...f.coordinator.active.values()].some(runtime => runtime.environments.size > 0)) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await f.coordinator.shutdown();
    const cancelled = await pending;
    assert.equal(cancelled.plan.state, PLAN_STATES.CANCELLED);
    assert.equal(f.coordinator.active.size, 0);
    assert.equal((await f.adapter.health()).running, 1, 'completed clients must survive application shutdown');
    assert.equal(f.coordinator.get(completed.planId).operations[0].state, 'RUNNING');
    await assert.rejects(f.coordinator.prepare(request(1)), /closing/);
  } finally { await f.cleanup(); }
});

test('cancellation and timeout become visible final operation states', async () => {
  const cancelFixture = fixture('sunday-phase5-cancel-', { hangLaunches: [1] }, { operationTimeoutMs: 5000 });
  try {
    let planId = null;
    cancelFixture.coordinator.on('update', plan => { planId = planId || plan.planId; });
    const pending = cancelFixture.coordinator.prepare(request(2));
    while (!planId || !cancelFixture.coordinator.active.has(planId)) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await cancelFixture.coordinator.cancel(planId)).ok, true);
    const cancelled = await pending;
    assert.equal(cancelled.plan.state, PLAN_STATES.CANCELLED);
    assert.equal(cancelled.plan.operations.some(operation => operation.state === 'CANCELLED'), true);
    assert.equal((await cancelFixture.adapter.health()).running, 0);
  } finally { await cancelFixture.cleanup(); }

  const timeoutFixture = fixture('sunday-phase5-timeout-', { hangLaunches: [1], stableMs: 10 }, { operationTimeoutMs: 50 });
  try {
    const timedOut = await timeoutFixture.coordinator.prepare(request(2));
    assert.equal(timedOut.plan.state, PLAN_STATES.PARTIAL);
    assert.match(timedOut.plan.operations[0].reason, /timed out/);
    assert.equal(timedOut.plan.operations[1].state, 'RUNNING');
  } finally { await timeoutFixture.cleanup(); }
});

test('cancellation requires recovery when an allocated environment cannot be released', async () => {
  const f = fixture('sunday-cancel-release-', {}, {
    resolveIntent: async () => new Promise(() => {}),
  });
  const originalAllocate = f.adapter.allocateInstance.bind(f.adapter);
  let allocationReached;
  const allocated = new Promise(resolve => { allocationReached = resolve; });
  try {
    f.adapter.allocateInstance = async (...args) => {
      const result = await originalAllocate(...args);
      allocationReached();
      return result;
    };
    f.adapter.release = async () => ({
      ok: false,
      released: false,
      state: ISOLATION_STATES.ACTIVATED,
      reason: 'Injected release uncertainty.',
    });
    const plan = f.store.create(f.coordinator.planner.create(request(1)));
    const running = f.coordinator.run(plan.planId);
    await allocated;
    assert.equal(f.adapter.environments.size, 1);
    await f.coordinator.cancel(plan.planId);
    const response = await running;
    assert.equal(response.plan.state, PLAN_STATES.RECOVERY_REQUIRED);
    assert.equal(response.plan.operations[0].state, 'UNKNOWN');
    assert.equal(response.plan.operations[0].failureCode, 'CLEANUP_UNCONFIRMED');
    assert.match(response.plan.operations[0].reason, /cleanup.*recovery is required/i);
  } finally {
    await f.cleanup();
  }
});

test('failed intent requires recovery when allocated environment cleanup is uncertain', async () => {
  const f = fixture('sunday-intent-release-', {}, {
    resolveIntent: async () => ({ ok: false, reason: 'Injected authentication failure.' }),
  });
  try {
    f.adapter.release = async () => ({
      ok: false,
      released: false,
      state: ISOLATION_STATES.ACTIVATED,
      reason: 'Injected release uncertainty.',
    });
    const response = await f.coordinator.prepare(request(1));
    assert.equal(response.plan.state, PLAN_STATES.RECOVERY_REQUIRED);
    assert.equal(response.plan.operations[0].state, 'UNKNOWN');
    assert.equal(response.plan.operations[0].failureCode, 'CLEANUP_UNCONFIRMED');
    assert.equal(response.plan.operations[0].failureStage, 'cleanup');
    assert.match(response.plan.operations[0].reason, /cleanup.*recovery is required/i);
  } finally {
    await f.cleanup();
  }
});

test('post-launch plan persistence failure rolls back the exact owned process and environment', async () => {
  const f = fixture('sunday-post-launch-persist-', { stableMs: 10 });
  const originalUpdate = f.store.update.bind(f.store);
  let updates = 0;
  f.store.update = (planId, mutator) => {
    updates += 1;
    if (updates === 5) {
      const error = new Error('Injected plan RUNNING persistence failure.');
      error.code = 'ESTATEWRITE';
      throw error;
    }
    return originalUpdate(planId, mutator);
  };
  try {
    const response = await f.coordinator.prepare(request(1));
    const health = await f.adapter.health();
    assert.equal(response.ok, false);
    assert.equal(response.plan.state, PLAN_STATES.FAILED);
    assert.equal(response.plan.operations[0].state, 'FAILED');
    assert.equal(response.plan.operations[0].pid, null);
    assert.equal(health.running, 0);
    assert.equal(f.coordinator.operationCapabilities.size, 0);
    assert.equal(Array.from(f.adapter.environments.values()).every(environment => environment.released), true);
  } finally {
    await f.cleanup();
  }
});

test('post-launch plan persistence failure requires recovery when exact process rollback is unconfirmed', async () => {
  const f = fixture('sunday-post-launch-cleanup-', { stableMs: 10 });
  const originalUpdate = f.store.update.bind(f.store);
  const originalStop = f.adapter.stop.bind(f.adapter);
  let updates = 0;
  f.store.update = (planId, mutator) => {
    updates += 1;
    if (updates === 5) throw new Error('Injected plan RUNNING persistence failure.');
    return originalUpdate(planId, mutator);
  };
  f.adapter.stop = async () => ({
    ok: false,
    confirmed: false,
    reason: 'Injected exact-process cleanup uncertainty.',
  });
  try {
    const response = await f.coordinator.prepare(request(1));
    assert.equal(response.ok, false);
    assert.equal(response.plan.state, PLAN_STATES.RECOVERY_REQUIRED);
    assert.equal(response.plan.operations[0].state, 'UNKNOWN');
    assert.equal(response.plan.operations[0].failureCode, 'CLEANUP_UNCONFIRMED');
    assert.equal(response.plan.operations[0].failureStage, 'cleanup');
    assert.match(response.plan.operations[0].reason, /cleanup.*recovery is required/i);
    assert.equal((await f.adapter.health()).running, 1);
    assert.equal(f.coordinator.operationCapabilities.size, 1);
    assert.equal(Array.from(f.adapter.environments.values()).some(environment => !environment.released), true);
  } finally {
    f.adapter.stop = originalStop;
    await f.cleanup();
  }
});

test('double persistence failure retains usable exact authority until cleanup succeeds', async () => {
  const f = fixture('sunday-post-launch-double-persist-', { stableMs: 10 });
  const originalUpdate = f.store.update.bind(f.store);
  const originalStop = f.adapter.stop.bind(f.adapter);
  let updates = 0;
  let allowStop = false;
  f.store.update = (planId, mutator) => {
    updates += 1;
    if (updates === 5) throw new Error('Injected plan RUNNING persistence failure.');
    if (updates === 6) throw new Error('Injected recovery persistence failure.');
    return originalUpdate(planId, mutator);
  };
  f.adapter.stop = async (...args) => allowStop
    ? originalStop(...args)
    : { ok: false, confirmed: false, reason: 'Injected exact-process cleanup uncertainty.' };
  try {
    await assert.rejects(f.coordinator.prepare(request(1)), /Injected recovery persistence failure/);
    const persisted = f.store.list(1)[0];
    const operation = persisted.operations[0];
    assert.equal(operation.state, 'LAUNCHING');
    assert.notEqual(f.coordinator.capabilityForOperation(operation.operationId), '');
    assert.equal((await f.adapter.health()).running, 1);

    allowStop = true;
    const stopped = await f.coordinator.stop(persisted.planId, operation.operationId);
    assert.equal(stopped.ok, true);
    assert.equal(stopped.plan.operations[0].state, 'STOPPED');
    assert.equal((await f.adapter.health()).running, 0);
    assert.equal(f.coordinator.capabilityForOperation(operation.operationId), '');
  } finally {
    f.adapter.stop = originalStop;
    await f.cleanup();
  }
});

test('restored exact ownership for a pre-final operation remains recoverable and stoppable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-pre-final-owned-recovery-'));
  const database = new StateDatabase({ path: path.join(dir, 'state.sqlite3'), assertOwner: () => true });
  const store = new LaunchPlanStore({ database });
  const planner = new (require('../src/main/launch-orchestration').LaunchPlanner)();
  const plan = store.create(planner.create(request(1)));
  const operationId = plan.operations[0].operationId;
  store.update(plan.planId, current => {
    current.state = PLAN_STATES.RUNNING;
    current.operations[0].state = 'LAUNCHING';
    current.operations[0].environmentId = 'old-environment';
    current.operations[0].instanceId = 'owned-instance';
    return current;
  });
  const stoppedCapabilities = [];
  const releasedEnvironments = [];
  const adapter = {
    restoredOwnership() {
      return [{
        operationId,
        accountId: 'account-1',
        instanceId: 'owned-instance',
        environmentId: 'replacement-environment',
        capability: 'restored-exact-capability',
        pid: 8123,
      }];
    },
    async stop(capability) {
      stoppedCapabilities.push(capability);
      return { ok: true, confirmed: true };
    },
    async release(environmentId) {
      releasedEnvironments.push(environmentId);
      return { ok: true, released: true };
    },
  };
  try {
    const coordinator = new LaunchCoordinator({ adapter, store });
    const recovered = coordinator.get(plan.planId);
    assert.equal(recovered.state, PLAN_STATES.RECOVERY_REQUIRED);
    assert.equal(recovered.operations[0].state, 'UNKNOWN');
    assert.equal(recovered.operations[0].pid, 8123);
    assert.equal(recovered.operations[0].environmentId, 'replacement-environment');
    assert.equal(coordinator.capabilityForOperation(operationId), 'restored-exact-capability');

    const stopped = await coordinator.stop(plan.planId, operationId);
    assert.equal(stopped.ok, true);
    assert.deepEqual(stoppedCapabilities, ['restored-exact-capability']);
    assert.deepEqual(releasedEnvironments, ['replacement-environment']);
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('synthetic capabilities reject stale and replacement identities', async () => {
  const f = fixture('sunday-phase5-identity-', { stableMs: 10 });
  try {
    const response = await f.coordinator.prepare(request(1));
    const operation = response.plan.operations[0];
    const originalIdentity = f.adapter.identityOf(operation.capability);
    f.adapter.replaceIdentityForTest(operation.capability);
    const observed = await f.adapter.observe(operation.capability, { expectedIdentity: originalIdentity });
    assert.equal(observed.ok, false);
    assert.match(observed.reason, /replaced/);
    const rejectedStop = await f.adapter.stop(operation.capability, { expectedIdentity: originalIdentity });
    assert.equal(rejectedStop.confirmed, false);
    assert.equal((await f.adapter.health()).running, 1);
    const unknown = await f.adapter.stop(`stale-${operation.capability}`);
    assert.equal(unknown.confirmed, false);
  } finally { await f.cleanup(); }
});

test('plan reconnect requires adapter-specific exact ownership evidence after restart', async () => {
  const f = fixture('sunday-phase5-recovery-', { stableMs: 10 });
  try {
    const complete = await f.coordinator.prepare(request(2));
    const reconnected = new LaunchCoordinator({
      adapter: f.adapter,
      store: f.store,
      resolveIntent: async operation => ({ ok: true, intent: { accountHandle: operation.accountId, target: operation.target } }),
    });
    assert.equal(reconnected.get(complete.planId).state, PLAN_STATES.RECOVERY_REQUIRED);

    f.store.update(complete.planId, plan => {
      plan.state = PLAN_STATES.RUNNING;
      plan.operations[0].state = 'LAUNCHING';
      plan.operations[1].state = 'RUNNING';
      return plan;
    });
    const afterRestart = new LaunchCoordinator({
      adapter: f.adapter,
      store: f.store,
      resolveIntent: async () => { throw new Error('must not resume automatically'); },
    });
    const recovered = afterRestart.get(complete.planId);
    assert.equal(recovered.state, PLAN_STATES.RECOVERY_REQUIRED);
    assert.equal(recovered.operations.every(operation => operation.state === 'UNKNOWN'), true);
    assert.equal(recovered.operations.every(operation => operation.capability === null && operation.pid === null), true);
  } finally { await f.cleanup(); }
});

test('restart recovers a plan interrupted before any operation reached RUNNING', async () => {
  const f = fixture('sunday-phase5-recovery-pre-running-', { stableMs: 10 });
  try {
    const plan = f.coordinator.planner.create(request(1));
    f.store.create(plan);
    f.store.update(plan.planId, current => {
      current.state = PLAN_STATES.RUNNING;
      current.operations[0].state = 'LAUNCHING';
      current.operations[0].environmentId = 'interrupted-environment';
      current.operations[0].instanceId = 'interrupted-instance';
      return current;
    });

    const recoveredCoordinator = new LaunchCoordinator({
      adapter: f.adapter,
      store: f.store,
      resolveIntent: async () => { throw new Error('must not resume automatically'); },
    });
    const recovered = recoveredCoordinator.get(plan.planId);
    assert.equal(recovered.state, PLAN_STATES.RECOVERY_REQUIRED);
    assert.equal(recovered.operations[0].state, 'UNKNOWN');
    assert.equal(recovered.operations[0].pid, null);
  } finally { await f.cleanup(); }
});

test('cancellation reports UNKNOWN when an owned client stop is not confirmed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-phase5-cancel-unknown-'));
  const database = new StateDatabase({ path: path.join(dir, 'state.sqlite3'), assertOwner: () => true });
  let planId = '';
  try {
    const adapter = {
      async preflight() { return { ok: true, state: ISOLATION_STATES.ACTIVATED }; },
      async allocateInstance(operation) {
        return { ok: true, state: ISOLATION_STATES.ACTIVATED, environmentId: `environment-${operation.accountId}`, instanceId: `instance-${operation.accountId}` };
      },
      async launch(_intent, context) {
        return { ok: true, state: ISOLATION_STATES.ACTIVATED, capability: `capability-${context.operation.accountId}`, pid: 900 };
      },
      async stop() { return { ok: false, confirmed: false, reason: 'Synthetic termination was not confirmed.' }; },
      async release() { throw new Error('release must not run after an unconfirmed stop'); },
    };
    const coordinator = new LaunchCoordinator({
      adapter,
      store: new LaunchPlanStore({ database }),
      resolveIntent: async operation => ({ ok: true, intent: { accountHandle: operation.accountId } }),
    });
    coordinator.on('update', plan => { planId = plan.planId; });
    const pending = coordinator.prepare(Object.assign(request(2), { launchDelayMs: 5000 }));
    while (!planId || coordinator.get(planId).operations[0].state !== 'RUNNING') {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await coordinator.cancel(planId);
    const cancelled = await pending;
    assert.equal(cancelled.plan.operations[0].state, 'UNKNOWN');
    assert.match(cancelled.plan.operations[0].reason, /not confirmed/i);
    assert.equal(cancelled.plan.operations[0].capability, 'capability-account-1');
  } finally {
    database.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('keeper relaunches only after matching confirmed owned exit and activated isolation', async () => {
  const queue = [];
  let relaunches = 0;
  const keeper = new InstanceKeeper({
    settingsProvider: () => ({ autoRejoinDelaySec: 0, autoRejoinMaxAttempts: 3 }),
    isolationStateProvider: () => ISOLATION_STATES.ACTIVATED,
    schedule: fn => { queue.push(fn); return queue.length; },
    cancelSchedule: () => {},
    requestRelaunch: async record => {
      relaunches += 1;
      return {
        ok: true,
        plan: { operations: [{ state: 'RUNNING', capability: `replacement-${record.accountId}` }] },
      };
    },
  });
  keeper.arm({ accountId: 'account-1', username: 'One', capability: 'owned-capability', placeId: '123' });
  assert.equal(keeper.onOwnedExit({ accountId: 'account-1', capability: 'owned-capability', ownership: 'UNKNOWN', confirmed: true }).ignored, true);
  assert.equal(keeper.onOwnedExit({ accountId: 'account-1', capability: 'other-capability', ownership: 'OWNED', confirmed: true }).ignored, true);
  assert.equal(relaunches, 0);
  assert.equal(keeper.onOwnedExit({ accountId: 'account-1', capability: 'owned-capability', ownership: 'OWNED', confirmed: true }).scheduled, true);
  await queue.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(relaunches, 1);
  assert.equal(keeper.status().records[0].state, 'running');
  assert.equal(keeper.status().records[0].capability, 'replacement-account-1');

  const blockedQueue = [];
  const blocked = new InstanceKeeper({
    settingsProvider: () => ({ autoRejoinDelaySec: 0 }),
    isolationStateProvider: () => ISOLATION_STATES.UNAVAILABLE,
    schedule: fn => { blockedQueue.push(fn); return blockedQueue.length; },
    cancelSchedule: () => {},
    requestRelaunch: async () => { throw new Error('must not run'); },
  });
  blocked.arm({ accountId: 'account-2', capability: 'owned-2' });
  blocked.onOwnedExit({ accountId: 'account-2', capability: 'owned-2', ownership: 'OWNED', confirmed: true });
  await blockedQueue.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(blocked.status().records[0].state, 'blocked');
});

test('keeper does not persist unchanged running snapshots', () => {
  let writes = 0;
  const keeper = new InstanceKeeper({
    store: { writeJson() { writes += 1; } },
  });
  keeper.arm({ accountId: 'account-1', capability: 'capability-1', username: 'One' });
  writes = 0;
  const snapshot = [{
    source: 'sunday', controllable: true, accountId: 'account-1', capability: 'capability-1',
  }];
  keeper.onInstances(snapshot);
  keeper.onInstances(snapshot);
  assert.equal(writes, 0);
});

test('keeper reschedules after a relaunch callback throws', async () => {
  const queue = [];
  const keeper = new InstanceKeeper({
    settingsProvider: () => ({ autoRejoinDelaySec: 0, autoRejoinMaxAttempts: 3 }),
    isolationStateProvider: () => ISOLATION_STATES.ACTIVATED,
    schedule: fn => { queue.push(fn); return queue.length; },
    cancelSchedule: () => {},
    requestRelaunch: async () => { throw new Error('synthetic coordinator failure'); },
  });
  keeper.arm({ accountId: 'account-1', capability: 'capability-1' });
  keeper.onOwnedExit({
    accountId: 'account-1', capability: 'capability-1', ownership: 'OWNED', confirmed: true,
  });
  await queue.shift()();
  const record = keeper.status().records[0];
  assert.equal(record.state, 'rejoining');
  assert.equal(record.attempts, 2);
  assert.match(record.lastReason, /synthetic coordinator failure/);
  assert.equal(queue.length, 1);
});

test('keeper rejoin traverses the synthetic coordinator and creates a new owned child', async () => {
  const f = fixture('sunday-phase5-keeper-synthetic-', { stableMs: 10 });
  const queue = [];
  try {
    const first = await f.coordinator.prepare(request(1));
    const original = first.plan.operations[0];
    const keeper = new InstanceKeeper({
      settingsProvider: () => ({ autoRejoinDelaySec: 0, autoRejoinMaxAttempts: 3 }),
      isolationStateProvider: () => ISOLATION_STATES.ACTIVATED,
      schedule: fn => { queue.push(fn); return queue.length; },
      cancelSchedule: () => {},
      requestRelaunch: record => f.coordinator.prepare(request(1, {
        name: `Keeper ${record.accountId}`,
        participants: [{ accountId: record.accountId, label: record.accountId }],
      })),
    });
    keeper.arm({ accountId: 'account-1', capability: original.capability, placeId: '12345', gameInstanceId: 'synthetic-server' });
    assert.equal((await f.adapter.stop(original.capability)).confirmed, true);
    assert.equal(keeper.onOwnedExit({
      accountId: 'account-1', capability: original.capability, ownership: 'OWNED', confirmed: true,
    }).scheduled, true);
    queue.shift()();
    const deadline = Date.now() + 2000;
    while (keeper.status().records[0].state !== 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const replaced = keeper.status().records[0];
    assert.equal(replaced.state, 'running');
    assert.notEqual(replaced.capability, original.capability);
    const observation = await f.adapter.observe(replaced.capability);
    assert.equal(observation.status, 'RUNNING');
    assert.notEqual(observation.pid, original.pid);
  } finally { await f.cleanup(); }
});

test('server-fill planning is deterministic for together and spread modes', () => {
  const servers = [
    { id: 'busy', maxPlayers: 10, playing: 9, ping: 10 },
    { id: 'roomy', maxPlayers: 10, playing: 4, ping: 80 },
    { id: 'medium', maxPlayers: 10, playing: 7, ping: 30 },
  ];
  const together = planServerFill({ accountIds: ['a', 'b', 'c'], servers, spread: false });
  assert.equal(together.ok, true);
  assert.deepEqual(together.assignments.map(item => item.serverId), ['roomy', 'roomy', 'roomy']);
  assert.equal(together.serverCount, 1);

  const spread = planServerFill({ accountIds: ['a', 'b', 'c'], servers: [
    { id: 'one', maxPlayers: 2, playing: 1, ping: 20 },
    { id: 'two', maxPlayers: 3, playing: 1, ping: 30 },
  ], spread: true });
  assert.deepEqual(spread.assignments.map(item => item.serverId), ['two', 'two', 'one']);
  assert.equal(spread.serverCount, 2);
  assert.equal(planServerFill({ accountIds: ['a', 'b', 'c', 'd', 'e', 'f'], servers, spread: true }).ok, true);
  assert.equal(planServerFill({ accountIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], servers, spread: true }).ok, false);
});
