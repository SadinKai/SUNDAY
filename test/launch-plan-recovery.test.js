'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const { StateDatabase } = require('../src/main/state-database');
const { PLAN_NAMESPACE } = require('../src/main/launch-orchestration');
const {
  ReadOnlyRecoveryDatabase,
  applyLaunchPlanRecovery,
  assertSyntheticMutation,
  buildSyntheticRecoverySpec,
  createExactMutationAuthority,
  fileFingerprint,
  inspectLaunchPlanRecovery,
  sha256,
} = require('../src/main/launch-plan-recovery');

const FIXED_NOW = Date.parse('2026-10-10T00:00:00.000Z');
const COOKIE_CANARY = 'synthetic-cookie-value-must-never-be-reported';
const CAPABILITY_CANARY = 'synthetic-capability-value-must-never-be-reported';

function operation(planIndex, operationIndex, state) {
  const unresolved = ['UNKNOWN', 'LAUNCHING'].includes(state);
  return {
    operationId: `operation-${planIndex}-${operationIndex}`,
    order: operationIndex + 1,
    accountId: `account-${(operationIndex % 4) + 1}`,
    label: `Synthetic ${operationIndex + 1}`,
    target: { type: 'HOME' },
    state,
    reason: '',
    failureCode: '',
    failureStage: '',
    environmentId: unresolved || state === 'STOPPED' ? `environment-${planIndex}-${operationIndex}` : null,
    instanceId: unresolved || state === 'STOPPED' ? `instance-${operationIndex + 1}` : null,
    capability: null,
    pid: null,
    updatedAt: `2026-09-${String((planIndex % 20) + 1).padStart(2, '0')}T00:00:00.000Z`,
    futureOperationField: { preserved: true, index: operationIndex },
  };
}

function plan(planIndex, state, childStates) {
  const timestamp = `2026-09-${String((planIndex % 20) + 1).padStart(2, '0')}T00:00:00.000Z`;
  return {
    schemaVersion: 1,
    planId: `plan-${planIndex}`,
    name: `Synthetic plan ${planIndex}`,
    state,
    reason: '',
    failureCode: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    launchDelayMs: 0,
    keepAlive: false,
    operations: childStates.map((child, index) => operation(planIndex, index, child)),
    futurePlanField: { preserved: true, index: planIndex },
  };
}

function fixture(prefix = 'sunday-launch-recovery-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const databasePath = path.join(root, 'state.sqlite3');
  const database = new StateDatabase({
    path: databasePath,
    assertOwner() {},
    now: () => FIXED_NOW,
  });
  database.put('documents', 'accounts.json', Array.from({ length: 4 }, (_, index) => ({
    id: `account-${index + 1}`,
    cookie: `${COOKIE_CANARY}-${index}`,
  })));

  const r0 = [
    plan(1, 'RECOVERY_REQUIRED', ['UNKNOWN']),
    plan(2, 'RECOVERY_REQUIRED', ['UNKNOWN', 'UNKNOWN']),
    plan(3, 'RECOVERY_REQUIRED', ['UNKNOWN']),
    plan(4, 'RECOVERY_REQUIRED', ['UNKNOWN']),
    plan(5, 'RECOVERY_REQUIRED', ['UNKNOWN']),
    plan(6, 'RECOVERY_REQUIRED', ['UNKNOWN', 'UNKNOWN', 'UNKNOWN']),
    plan(7, 'RECOVERY_REQUIRED', ['UNKNOWN', 'FAILED']),
  ];
  const r1 = [
    plan(8, 'COMPLETED', ['UNKNOWN', 'STOPPED']),
    plan(9, 'COMPLETED', ['UNKNOWN', 'STOPPED']),
    plan(10, 'COMPLETED', ['UNKNOWN', 'STOPPED']),
    plan(11, 'COMPLETED', ['UNKNOWN', 'STOPPED']),
    plan(12, 'COMPLETED', ['UNKNOWN', 'STOPPED']),
    plan(13, 'FAILED', ['FAILED', 'UNKNOWN']),
    plan(14, 'FAILED', ['UNKNOWN']),
  ];
  const r2 = plan(15, 'RUNNING', ['LAUNCHING']);
  const unrelated = [
    plan(16, 'BLOCKED', ['UNAVAILABLE']),
    plan(17, 'COMPLETED', ['STOPPED']),
    plan(18, 'PARTIAL', ['STOPPED', 'FAILED']),
  ];
  for (const value of [...r0, ...r1, r2, ...unrelated]) {
    database.put(PLAN_NAMESPACE, value.planId, value, { expectedRevision: 0 });
  }
  const spec = buildSyntheticRecoverySpec(database, {
    r0: r0.map(value => value.planId),
    r1: r1.map(value => value.planId),
    r2: { planId: r2.planId, operationId: r2.operations[0].operationId },
  });
  return {
    root,
    databasePath,
    database,
    r0,
    r1,
    r2,
    unrelated,
    spec,
    cleanup() {
      try { database.close(); } catch (_) {}
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function snapshot(database, namespace = PLAN_NAMESPACE) {
  return database.list(namespace).map(row => ({
    key: row.key,
    revision: row.revision,
    updatedAt: row.updatedAt,
    value: row.value,
  }));
}

function rowByKey(database, key) {
  return database.get(PLAN_NAMESPACE, key, null);
}

function apply(f, options) {
  return applyLaunchPlanRecovery(f.database, f.spec, Object.assign({
    authorizeMutation: assertSyntheticMutation,
  }, options));
}

test('synthetic recovery changes exactly seven R1 parents and the R2 parent/operation atomically', () => {
  const f = fixture();
  try {
    const beforePlans = snapshot(f.database);
    const beforeDocuments = snapshot(f.database, 'documents');
    const beforeByKey = new Map(beforePlans.map(row => [row.key, row]));
    const beforeReport = inspectLaunchPlanRecovery(f.database, f.spec);
    assert.equal(beforeReport.status, 'ORIGINAL');
    assert.equal(beforeReport.safeToApply, true);

    const result = apply(f);
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.writes, 8);
    assert.equal(result.report.status, 'COMPLETE');
    assert.equal(result.report.inventory.planCount, beforePlans.length);
    assert.deepEqual(result.report.inventory.plans, f.spec.expectedAfter.plans);
    assert.deepEqual(result.report.inventory.operations, f.spec.expectedAfter.operations);

    for (const value of f.r1) {
      const row = rowByKey(f.database, value.planId);
      assert.equal(row.value.state, 'RECOVERY_REQUIRED');
      assert.deepEqual(row.value.operations, value.operations);
      assert.equal(row.value.updatedAt, value.updatedAt);
      assert.deepEqual(row.value.futurePlanField, value.futurePlanField);
      assert.equal(row.revision, beforeByKey.get(value.planId).revision + 1);
      assert.equal(row.updatedAt, beforeByKey.get(value.planId).updatedAt);
    }
    const recoveredR2 = rowByKey(f.database, f.r2.planId);
    assert.equal(recoveredR2.value.state, 'RECOVERY_REQUIRED');
    assert.equal(recoveredR2.value.operations[0].state, 'UNKNOWN');
    assert.equal(recoveredR2.value.operations[0].environmentId, f.r2.operations[0].environmentId);
    assert.equal(recoveredR2.value.operations[0].instanceId, f.r2.operations[0].instanceId);
    assert.equal(recoveredR2.value.operations[0].updatedAt, f.r2.operations[0].updatedAt);
    assert.deepEqual(recoveredR2.value.operations[0].futureOperationField, f.r2.operations[0].futureOperationField);

    for (const value of [...f.r0, ...f.unrelated]) {
      assert.deepEqual(rowByKey(f.database, value.planId), {
        found: true,
        revision: beforeByKey.get(value.planId).revision,
        value: beforeByKey.get(value.planId).value,
        updatedAt: beforeByKey.get(value.planId).updatedAt,
      });
    }
    assert.deepEqual(snapshot(f.database, 'documents'), beforeDocuments);
    assert.equal(f.database.list('legacy-process-ownership-v1').length, 0);
    assert.equal(f.database.list('slot-leases').length, 0);
    assert.equal(f.database.list('environment-leases-v1').length, 0);
    assert.equal(JSON.stringify(result).includes(COOKIE_CANARY), false);
    assert.equal(JSON.stringify(result).includes(CAPABILITY_CANARY), false);
  } finally { f.cleanup(); }
});

test('unexpected target revision or state aborts before recovery writes', () => {
  for (const mutation of ['revision', 'state']) {
    const f = fixture();
    try {
      const key = f.r1[0].planId;
      if (mutation === 'revision') {
        const row = rowByKey(f.database, key);
        f.database.put(PLAN_NAMESPACE, key, row.value, { expectedRevision: row.revision });
      } else {
        const row = rowByKey(f.database, key);
        const changed = JSON.parse(JSON.stringify(row.value));
        changed.state = 'PARTIAL';
        f.database.db.prepare('UPDATE records SET value_json = ? WHERE namespace = ? AND record_key = ?')
          .run(JSON.stringify(changed), PLAN_NAMESPACE, key);
      }
      const before = snapshot(f.database);
      assert.throws(() => apply(f), error => error && error.code === 'RECOVERY_PRECONDITION_FAILED');
      assert.deepEqual(snapshot(f.database), before);
    } finally { f.cleanup(); }
  }
});

test('mid-transaction and before-commit faults roll back every recovery write', () => {
  for (const point of ['recovery:after-write:4', 'recovery:before-commit']) {
    const f = fixture();
    try {
      const before = snapshot(f.database);
      assert.throws(() => apply(f, {
        faultInjector(current) { if (current === point) throw new Error('synthetic recovery fault'); },
      }), /synthetic recovery fault/);
      assert.deepEqual(snapshot(f.database), before);
      assert.equal(inspectLaunchPlanRecovery(f.database, f.spec).status, 'ORIGINAL');
    } finally { f.cleanup(); }
  }

  const databaseFault = fixture();
  try {
    const before = snapshot(databaseFault.database);
    databaseFault.database.fault = point => {
      if (point === 'before-commit') throw new Error('synthetic database commit fault');
    };
    assert.throws(() => apply(databaseFault), /synthetic database commit fault/);
    assert.deepEqual(snapshot(databaseFault.database), before);
    assert.equal(inspectLaunchPlanRecovery(databaseFault.database, databaseFault.spec).status, 'ORIGINAL');
  } finally { databaseFault.cleanup(); }
});

test('validation failure causes zero writes and partial recovery is rejected', () => {
  const missingEnvironment = fixture();
  try {
    const key = missingEnvironment.r2.planId;
    const row = rowByKey(missingEnvironment.database, key);
    const changed = JSON.parse(JSON.stringify(row.value));
    changed.operations[0].environmentId = null;
    missingEnvironment.database.db.prepare('UPDATE records SET value_json = ? WHERE namespace = ? AND record_key = ?')
      .run(JSON.stringify(changed), PLAN_NAMESPACE, key);
    const before = snapshot(missingEnvironment.database);
    const report = inspectLaunchPlanRecovery(missingEnvironment.database, missingEnvironment.spec);
    assert.equal(report.safeToApply, false);
    assert.equal(report.mismatches.some(item => item.code === 'ENVIRONMENT_REFERENCE_MISSING'), true);
    assert.throws(() => apply(missingEnvironment), error => error && error.code === 'RECOVERY_PRECONDITION_FAILED');
    assert.deepEqual(snapshot(missingEnvironment.database), before);
  } finally { missingEnvironment.cleanup(); }

  const partial = fixture();
  try {
    const entry = partial.spec.targets.find(item => item.kind === 'R1');
    const row = partial.database.list(PLAN_NAMESPACE)
      .find(item => sha256(item.value.planId) === entry.planDigest);
    const changed = JSON.parse(JSON.stringify(row.value));
    changed.state = 'RECOVERY_REQUIRED';
    partial.database.db.prepare('UPDATE records SET revision = revision + 1, value_json = ? WHERE namespace = ? AND record_key = ?')
      .run(JSON.stringify(changed), PLAN_NAMESPACE, row.key);
    const before = snapshot(partial.database);
    const report = inspectLaunchPlanRecovery(partial.database, partial.spec);
    assert.equal(report.status, 'AMBIGUOUS');
    assert.throws(() => apply(partial), error => error && error.code === 'RECOVERY_PRECONDITION_FAILED');
    assert.deepEqual(snapshot(partial.database), before);
  } finally { partial.cleanup(); }
});

test('complete recovery is detected idempotently through the read-only reader', () => {
  const f = fixture();
  let reader;
  try {
    assert.equal(apply(f).status, 'COMPLETED');
    const second = apply(f);
    assert.equal(second.status, 'ALREADY_COMPLETE');
    assert.equal(second.writes, 0);
    f.database.close();
    reader = new ReadOnlyRecoveryDatabase(f.databasePath);
    assert.equal(reader.quickCheck(), true);
    const report = inspectLaunchPlanRecovery(reader, f.spec);
    assert.equal(report.status, 'COMPLETE');
    assert.equal(report.alreadyComplete, true);
  } finally {
    if (reader) reader.close();
    f.cleanup();
  }
});

test('immutable inspection leaves database files unchanged and refuses pending journal content', () => {
  const f = fixture();
  let reader;
  try {
    f.database.close();
    const before = fs.readdirSync(f.root).sort().map(name => {
      const file = path.join(f.root, name);
      const stat = fs.statSync(file);
      return { name, size: stat.size, mtimeMs: stat.mtimeMs, bytes: fs.readFileSync(file).toString('base64') };
    });
    reader = new ReadOnlyRecoveryDatabase(f.databasePath);
    assert.equal(reader.quickCheck(), true);
    inspectLaunchPlanRecovery(reader, f.spec);
    reader.close();
    reader = null;
    const after = fs.readdirSync(f.root).sort().map(name => {
      const file = path.join(f.root, name);
      const stat = fs.statSync(file);
      return { name, size: stat.size, mtimeMs: stat.mtimeMs, bytes: fs.readFileSync(file).toString('base64') };
    });
    assert.deepEqual(after, before);

    fs.writeFileSync(`${f.databasePath}-wal`, 'pending');
    assert.throws(() => new ReadOnlyRecoveryDatabase(f.databasePath), error => error && error.code === 'READ_ONLY_SIDECAR_PRESENT');
  } finally {
    if (reader) reader.close();
    f.cleanup();
  }
});

test('ownership, lease, and capability conflicts are reported without exposing authority values', () => {
  const f = fixture();
  try {
    f.database.put('legacy-process-ownership-v1', 'synthetic-owner', {
      operationId: 'synthetic-operation',
      capability: CAPABILITY_CANARY,
    });
    f.database.put('slot-leases', 'slot-001', { leaseId: 'synthetic-lease', tokenHash: CAPABILITY_CANARY });
    const before = snapshot(f.database);
    const report = inspectLaunchPlanRecovery(f.database, f.spec);
    const serialized = JSON.stringify(report);
    assert.equal(report.safeToApply, false);
    assert.equal(report.mismatches.some(item => item.code === 'OWNERSHIP_CONFLICT'), true);
    assert.equal(report.mismatches.some(item => item.code === 'LEASE_CONFLICT'), true);
    assert.equal(serialized.includes(CAPABILITY_CANARY), false);
    assert.throws(() => apply(f), error => {
      assert.equal(String(error.message).includes(CAPABILITY_CANARY), false);
      return error && error.code === 'RECOVERY_PRECONDITION_FAILED';
    });
    assert.deepEqual(snapshot(f.database), before);
  } finally { f.cleanup(); }
});

test('nonempty plan capability and credential-shaped target fields fail closed without leaking values', () => {
  const f = fixture();
  try {
    const key = f.r2.planId;
    const row = rowByKey(f.database, key);
    const changed = JSON.parse(JSON.stringify(row.value));
    changed.operations[0].capability = CAPABILITY_CANARY;
    changed.futureCredential = COOKIE_CANARY;
    f.database.db.prepare('UPDATE records SET value_json = ? WHERE namespace = ? AND record_key = ?')
      .run(JSON.stringify(changed), PLAN_NAMESPACE, key);
    const report = inspectLaunchPlanRecovery(f.database, f.spec);
    const serialized = JSON.stringify(report);
    assert.equal(report.safeToApply, false);
    assert.equal(report.conflicts.nonemptyCapabilities, 1);
    assert.equal(serialized.includes(CAPABILITY_CANARY), false);
    assert.equal(serialized.includes(COOKIE_CANARY), false);
    assert.throws(() => apply(f), error => {
      assert.equal(String(error.message).includes(CAPABILITY_CANARY), false);
      assert.equal(String(error.message).includes(COOKIE_CANARY), false);
      return error && error.code === 'RECOVERY_PRECONDITION_FAILED';
    });
  } finally { f.cleanup(); }
});

test('the supplied mutation authority rejects databases outside the dedicated synthetic root', () => {
  const f = fixture('sunday-recovery-not-authorized-');
  try {
    const before = snapshot(f.database);
    assert.throws(() => apply(f), error => error && error.code === 'SYNTHETIC_ONLY');
    assert.deepEqual(snapshot(f.database), before);
  } finally { f.cleanup(); }
});

test('the exact-file mutation authority permits only its synthetic path and fingerprint', () => {
  const f = fixture();
  try {
    const fingerprint = fileFingerprint(f.databasePath);
    const authority = createExactMutationAuthority(fingerprint, { assertOffline() {} });
    const result = applyLaunchPlanRecovery(f.database, f.spec, { authorizeMutation: authority });
    assert.equal(result.status, 'COMPLETED');
    assert.equal(result.writes, 8);

    const wrongHash = createExactMutationAuthority({
      path: f.databasePath,
      size: fingerprint.size,
      sha256: '0'.repeat(64),
    });
    assert.throws(() => wrongHash(f.database), error => error && error.code === 'DATABASE_FINGERPRINT_MISMATCH');

    const wrongPath = createExactMutationAuthority({
      path: path.join(f.root, 'other.sqlite3'),
      size: fingerprint.size,
      sha256: fingerprint.sha256,
    });
    assert.throws(() => wrongPath(f.database), error => error && error.code === 'DATABASE_TARGET_MISMATCH');
  } finally { f.cleanup(); }
});

test('the dry-run command has no default database or mutation invocation', () => {
  const command = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'dry-run-launch-plan-recovery.js')], {
    encoding: 'utf8',
  });
  assert.equal(command.status, 2);
  assert.equal(command.stdout, '');
  const failure = JSON.parse(command.stderr.split(/\r?\n/).find(line => line.trim().startsWith('{')));
  assert.equal(failure.mode, 'READ_ONLY_DRY_RUN');
  assert.equal(failure.ok, false);
});

test('the one-shot recovery command requires the exact explicit confirmation', () => {
  const command = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'apply-approved-launch-plan-recovery.js')], {
    encoding: 'utf8',
  });
  assert.equal(command.status, 2);
  assert.equal(command.stdout, '');
  const failure = JSON.parse(command.stderr.split(/\r?\n/).find(line => line.trim().startsWith('{')));
  assert.equal(failure.mode, 'APPROVED_ONE_SHOT_RECOVERY');
  assert.equal(failure.conclusion, 'RECOVERY NOT APPLIED; DATABASE UNCHANGED');
  assert.equal(failure.errorCode, 'EXPLICIT_CONFIRMATION_REQUIRED');
});
