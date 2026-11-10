'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { PLAN_NAMESPACE, PLAN_STATES } = require('./launch-orchestration');

const OWNERSHIP_NAMESPACE = 'legacy-process-ownership-v1';
const SLOT_LEASE_NAMESPACE = 'slot-leases';
const ENVIRONMENT_LEASE_NAMESPACE = 'environment-leases-v1';
const SENSITIVE_KEY = /(cookie|ticket|credential|password|secret|deeplink|auth)/i;
const DIGEST = /^[a-f0-9]{64}$/;

function target(kind, planDigest, beforeValueDigest, afterValueDigest, beforeRevision,
  beforeParent, afterParent, beforeChildren, afterChildren, rowUpdatedAt, r2OperationDigest) {
  return Object.freeze({
    kind,
    planDigest,
    beforeValueDigest,
    afterValueDigest,
    beforeRevision,
    afterRevision: beforeRevision + (kind === 'R0' ? 0 : 1),
    beforeParent,
    afterParent,
    beforeChildren: Object.freeze(beforeChildren.slice()),
    afterChildren: Object.freeze(afterChildren.slice()),
    rowUpdatedAt,
    r2OperationDigest: r2OperationDigest || '',
  });
}

class RecoveryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function fileFingerprint(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new RecoveryError('DATABASE_TARGET_MISMATCH', 'The recovery target is not a regular file.');
  return {
    path: resolved,
    size: stat.size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex'),
  };
}

function samePath(left, right) {
  const a = path.resolve(String(left || ''));
  const b = path.resolve(String(right || ''));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function createExactMutationAuthority(policy, hooks) {
  const expected = policy || {};
  const expectedPath = path.resolve(String(expected.path || ''));
  const expectedSha256 = String(expected.sha256 || '').toLowerCase();
  const expectedSize = Number(expected.size);
  if (!path.isAbsolute(expectedPath) || !DIGEST.test(expectedSha256)
      || !Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
    throw new RecoveryError('INVALID_MUTATION_POLICY', 'The exact recovery mutation policy is invalid.');
  }
  const assertOffline = hooks && typeof hooks.assertOffline === 'function'
    ? hooks.assertOffline : () => {};
  return database => {
    if (!database || !samePath(database.path, expectedPath)) {
      throw new RecoveryError('DATABASE_TARGET_MISMATCH', 'The writable recovery database is not the approved target.');
    }
    assertOffline();
    const actual = fileFingerprint(database.path);
    if (actual.size !== expectedSize || actual.sha256 !== expectedSha256) {
      throw new RecoveryError('DATABASE_FINGERPRINT_MISMATCH', 'The writable recovery database no longer matches the approved fingerprint.');
    }
    return true;
  };
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameCounts(actual, expected) {
  const keys = new Set([...Object.keys(actual || {}), ...Object.keys(expected || {})]);
  return Array.from(keys).every(key => Number(actual[key] || 0) === Number(expected[key] || 0));
}

function assertNoSensitiveKeys(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new RecoveryError('SENSITIVE_PLAN_FIELD', 'A target plan contains a forbidden sensitive field.');
    if (nested && typeof nested === 'object') assertNoSensitiveKeys(nested);
  }
}

function validateSpec(spec) {
  if (!spec || spec.schemaVersion !== 1 || !Array.isArray(spec.targets)) {
    throw new RecoveryError('INVALID_SPEC', 'Recovery specification is invalid.');
  }
  const classes = { R0: 0, R1: 0, R2: 0 };
  const plans = new Set();
  for (const entry of spec.targets) {
    if (!entry || !Object.hasOwn(classes, entry.kind) || !DIGEST.test(entry.planDigest)
        || !DIGEST.test(entry.beforeValueDigest) || !DIGEST.test(entry.afterValueDigest)
        || !Number.isInteger(entry.beforeRevision) || entry.beforeRevision <= 0
        || !Number.isInteger(entry.afterRevision) || entry.afterRevision <= 0
        || !Array.isArray(entry.beforeChildren) || !Array.isArray(entry.afterChildren)) {
      throw new RecoveryError('INVALID_SPEC', 'Recovery target specification is invalid.');
    }
    if (plans.has(entry.planDigest)) throw new RecoveryError('INVALID_SPEC', 'Recovery target specification contains a duplicate plan.');
    plans.add(entry.planDigest);
    classes[entry.kind] += 1;
  }
  if (classes.R0 !== 7 || classes.R1 !== 7 || classes.R2 !== 1 || spec.targets.length !== 15) {
    throw new RecoveryError('INVALID_SPEC', 'Recovery specification must contain exactly seven R0, seven R1, and one R2 plan.');
  }
}

function inventory(rows) {
  const plans = {};
  const operations = {};
  let nonemptyCapabilities = 0;
  for (const row of rows) {
    const plan = row.value;
    plans[String(plan && plan.state || 'INVALID')] = (plans[String(plan && plan.state || 'INVALID')] || 0) + 1;
    for (const operation of (plan && Array.isArray(plan.operations) ? plan.operations : [])) {
      const state = String(operation && operation.state || 'INVALID');
      operations[state] = (operations[state] || 0) + 1;
      if (operation && operation.capability) nonemptyCapabilities += 1;
    }
  }
  return { planCount: rows.length, plans, operations, nonemptyCapabilities };
}

function valueDigest(row) {
  return sha256(row.rawJson == null ? JSON.stringify(row.value) : row.rawJson);
}

function planDigest(row) {
  const planId = String(row.value && row.value.planId || '');
  if (!planId || String(row.key) !== planId) return '';
  return sha256(planId);
}

function operationStates(plan) {
  return (Array.isArray(plan && plan.operations) ? plan.operations : []).map(operation => String(operation.state || ''));
}

function transformedPlan(row, entry) {
  const plan = clone(row.value);
  if (entry.kind === 'R1') plan.state = PLAN_STATES.RECOVERY_REQUIRED;
  if (entry.kind === 'R2') {
    plan.state = PLAN_STATES.RECOVERY_REQUIRED;
    const matches = plan.operations.filter(operation => sha256(operation.operationId) === entry.r2OperationDigest);
    if (matches.length !== 1) throw new RecoveryError('R2_OPERATION_MISMATCH', 'The approved R2 operation could not be identified exactly.');
    matches[0].state = 'UNKNOWN';
  }
  return plan;
}

function namespaceCount(database, namespace) {
  if (typeof database.countNamespace === 'function') return database.countNamespace(namespace);
  return database.list(namespace).length;
}

function savedAccountDigests(database) {
  if (typeof database.accountDigests === 'function') return database.accountDigests();
  if (typeof database.get !== 'function') return null;
  const row = database.get('documents', 'accounts.json', []);
  const accounts = row && row.found && Array.isArray(row.value) ? row.value : [];
  return new Set(accounts.map(account => sha256(account && (account.id || account.userId) || '')));
}

function analyzeRecovery(database, spec) {
  validateSpec(spec);
  const rows = database.list(PLAN_NAMESPACE);
  const currentInventory = inventory(rows);
  const rowByDigest = new Map();
  const mismatches = [];
  for (const row of rows) {
    const digest = planDigest(row);
    if (!digest) continue;
    if (rowByDigest.has(digest)) mismatches.push({ code: 'DUPLICATE_PLAN_DIGEST', ref: digest.slice(0, 12) });
    rowByDigest.set(digest, row);
  }

  const accountDigests = savedAccountDigests(database);
  const targetResults = [];
  for (const entry of spec.targets) {
    const row = rowByDigest.get(entry.planDigest);
    const ref = entry.planDigest.slice(0, 12);
    if (!row) {
      mismatches.push({ code: 'TARGET_MISSING', ref });
      targetResults.push({ entry, row: null, phase: 'MISMATCH', ref });
      continue;
    }
    const states = operationStates(row.value);
    const digest = valueDigest(row);
    const before = row.revision === entry.beforeRevision && row.updatedAt === entry.rowUpdatedAt
      && row.value.state === entry.beforeParent && sameArray(states, entry.beforeChildren)
      && digest === entry.beforeValueDigest;
    const after = row.revision === entry.afterRevision && row.updatedAt === entry.rowUpdatedAt
      && row.value.state === entry.afterParent && sameArray(states, entry.afterChildren)
      && digest === entry.afterValueDigest;
    const phase = before ? 'ORIGINAL' : (after ? 'COMPLETE' : 'MISMATCH');
    if (phase === 'MISMATCH') mismatches.push({ code: 'TARGET_PRECONDITION_MISMATCH', ref });

    try { assertNoSensitiveKeys(row.value); }
    catch (error) { mismatches.push({ code: error.code || 'SENSITIVE_PLAN_FIELD', ref }); }
    for (const operation of (row.value.operations || [])) {
      if (!operation.accountId || (accountDigests && !accountDigests.has(sha256(operation.accountId)))) {
        mismatches.push({ code: 'ACCOUNT_ASSOCIATION_MISMATCH', ref });
      }
      if (['UNKNOWN', 'LAUNCHING'].includes(operation.state)
          && (!operation.environmentId || !operation.instanceId)) {
        mismatches.push({ code: 'ENVIRONMENT_REFERENCE_MISSING', ref });
      }
    }
    targetResults.push({ entry, row, phase, ref });
  }

  const conflicts = {
    ownershipRows: namespaceCount(database, OWNERSHIP_NAMESPACE),
    slotLeaseRows: namespaceCount(database, SLOT_LEASE_NAMESPACE),
    environmentLeaseRows: namespaceCount(database, ENVIRONMENT_LEASE_NAMESPACE),
    nonemptyCapabilities: currentInventory.nonemptyCapabilities,
  };
  if (conflicts.ownershipRows) mismatches.push({ code: 'OWNERSHIP_CONFLICT', ref: '' });
  if (conflicts.slotLeaseRows || conflicts.environmentLeaseRows) mismatches.push({ code: 'LEASE_CONFLICT', ref: '' });
  if (conflicts.nonemptyCapabilities) mismatches.push({ code: 'CAPABILITY_CONFLICT', ref: '' });

  const phases = new Set(targetResults.map(result => result.phase));
  let status = 'AMBIGUOUS';
  if (phases.size === 1 && phases.has('ORIGINAL')
      && sameCounts(currentInventory.plans, spec.expectedBefore.plans)
      && sameCounts(currentInventory.operations, spec.expectedBefore.operations)) status = 'ORIGINAL';
  if (targetResults.filter(result => result.entry.kind === 'R0').every(result => result.phase === 'ORIGINAL')
      && targetResults.filter(result => result.entry.kind !== 'R0').every(result => result.phase === 'COMPLETE')
      && sameCounts(currentInventory.plans, spec.expectedAfter.plans)
      && sameCounts(currentInventory.operations, spec.expectedAfter.operations)) status = 'COMPLETE';
  if (status === 'AMBIGUOUS') mismatches.push({ code: 'INVENTORY_OR_PHASE_MISMATCH', ref: '' });

  const uniqueMismatches = Array.from(new Map(mismatches.map(item => [`${item.code}:${item.ref}`, item])).values());
  const report = {
    schemaVersion: 1,
    status,
    safeToApply: status === 'ORIGINAL' && uniqueMismatches.length === 0,
    alreadyComplete: status === 'COMPLETE' && uniqueMismatches.length === 0,
    inventory: currentInventory,
    conflicts,
    targets: targetResults.map(result => ({
      ref: result.ref,
      class: result.entry.kind,
      phase: result.phase,
      current: result.row ? {
        revision: result.row.revision,
        parent: String(result.row.value.state || ''),
        children: operationStates(result.row.value),
      } : null,
      proposed: {
        revision: result.entry.afterRevision,
        parent: result.entry.afterParent,
        children: result.entry.afterChildren.slice(),
      },
    })),
    mismatches: uniqueMismatches,
  };
  return { report, targetResults };
}

function inspectLaunchPlanRecovery(database, spec) {
  return analyzeRecovery(database, spec).report;
}

function assertSyntheticMutation(database) {
  const resolved = path.resolve(String(database && database.path || ''));
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  const parent = path.basename(path.dirname(resolved));
  if (!resolved.startsWith(tempRoot) || !parent.startsWith('sunday-launch-recovery-')) {
    throw new RecoveryError('SYNTHETIC_ONLY', 'Mutation authority is restricted to a dedicated synthetic recovery database.');
  }
  return true;
}

function applyLaunchPlanRecovery(database, spec, options) {
  const opts = options || {};
  if (!database || typeof database.transaction !== 'function' || !database.db) {
    throw new RecoveryError('MUTABLE_DATABASE_REQUIRED', 'Recovery requires the transactional state database abstraction.');
  }
  if (typeof opts.authorizeMutation !== 'function' || opts.authorizeMutation(database) !== true) {
    throw new RecoveryError('MUTATION_NOT_AUTHORIZED', 'Recovery mutation was not explicitly authorized.');
  }
  const fault = typeof opts.faultInjector === 'function' ? opts.faultInjector : () => {};
  return database.transaction(() => {
    fault('recovery:after-begin');
    const before = analyzeRecovery(database, spec);
    if (before.report.alreadyComplete) return { ok: true, status: 'ALREADY_COMPLETE', writes: 0, report: before.report };
    if (!before.report.safeToApply) throw new RecoveryError('RECOVERY_PRECONDITION_FAILED', 'Recovery preconditions did not match the approved original state.');

    let writes = 0;
    for (const result of before.targetResults.filter(item => item.entry.kind !== 'R0')) {
      const next = transformedPlan(result.row, result.entry);
      const serialized = JSON.stringify(next);
      if (sha256(serialized) !== result.entry.afterValueDigest) {
        throw new RecoveryError('RECOVERY_DIFF_MISMATCH', 'The proposed recovery diff does not match the approved target state.');
      }
      fault(`recovery:before-write:${writes + 1}`);
      const updated = database.db.prepare(`
        UPDATE records
        SET revision = revision + 1, value_json = ?
        WHERE namespace = ? AND record_key = ? AND revision = ?
      `).run(serialized, PLAN_NAMESPACE, result.row.key, result.entry.beforeRevision);
      if (Number(updated.changes) !== 1) throw new RecoveryError('RECOVERY_CAS_FAILED', 'A recovery target revision changed before it could be written.');
      writes += 1;
      fault(`recovery:after-write:${writes}`);
    }

    const after = analyzeRecovery(database, spec);
    if (!after.report.alreadyComplete || writes !== 8) {
      throw new RecoveryError('RECOVERY_POSTCONDITION_FAILED', 'Recovery postconditions did not match the approved complete state.');
    }
    fault('recovery:before-commit');
    return { ok: true, status: 'COMPLETED', writes, report: after.report };
  });
}

function buildSyntheticRecoverySpec(database, selection) {
  const selected = selection || {};
  const groups = [
    ...((selected.r0 || []).map(planId => ({ kind: 'R0', planId }))),
    ...((selected.r1 || []).map(planId => ({ kind: 'R1', planId }))),
    ...(selected.r2 ? [{ kind: 'R2', planId: selected.r2.planId, operationId: selected.r2.operationId }] : []),
  ];
  const rows = database.list(PLAN_NAMESPACE);
  const byKey = new Map(rows.map(row => [row.key, row]));
  const entries = groups.map(group => {
    const row = byKey.get(group.planId);
    if (!row) throw new RecoveryError('SYNTHETIC_FIXTURE_INVALID', 'A synthetic recovery target is missing.');
    const before = row.value;
    const entry = {
      kind: group.kind,
      planDigest: sha256(before.planId),
      beforeValueDigest: valueDigest(row),
      beforeRevision: row.revision,
      beforeParent: before.state,
      beforeChildren: operationStates(before),
      rowUpdatedAt: row.updatedAt,
      r2OperationDigest: group.operationId ? sha256(group.operationId) : '',
    };
    const after = transformedPlan(row, entry);
    return target(group.kind, entry.planDigest, entry.beforeValueDigest, sha256(JSON.stringify(after)),
      entry.beforeRevision, entry.beforeParent, after.state, entry.beforeChildren, operationStates(after),
      entry.rowUpdatedAt, entry.r2OperationDigest);
  });
  const before = inventory(rows);
  const afterRows = rows.map(row => {
    const entry = entries.find(item => item.planDigest === planDigest(row));
    if (!entry || entry.kind === 'R0') return row;
    return Object.assign({}, row, { value: transformedPlan(row, entry), rawJson: null });
  });
  return Object.freeze({
    schemaVersion: 1,
    expectedBefore: Object.freeze({ plans: Object.freeze(before.plans), operations: Object.freeze(before.operations) }),
    expectedAfter: Object.freeze({ plans: Object.freeze(inventory(afterRows).plans), operations: Object.freeze(inventory(afterRows).operations) }),
    targets: Object.freeze(entries),
  });
}

class ReadOnlyRecoveryDatabase {
  constructor(databasePath) {
    const resolved = path.resolve(String(databasePath || ''));
    if (!path.isAbsolute(resolved) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new RecoveryError('READ_ONLY_DATABASE_REQUIRED', 'A readable existing database file is required.');
    }
    for (const suffix of ['-wal', '-journal']) {
      const sidecar = `${resolved}${suffix}`;
      if (fs.existsSync(sidecar) && fs.statSync(sidecar).size > 0) {
        throw new RecoveryError('READ_ONLY_SIDECAR_PRESENT', 'Immutable inspection refuses a database with pending journal content.');
      }
    }
    this.path = resolved;
    const immutableUri = `file:${encodeURI(resolved.replace(/\\/g, '/'))}?immutable=1`;
    this.db = new DatabaseSync(immutableUri, { open: true, readOnly: true, timeout: 5000 });
    this.db.exec('PRAGMA query_only = ON;');
    this.db.exec('PRAGMA trusted_schema = OFF;');
  }

  quickCheck() {
    const row = this.db.prepare('PRAGMA quick_check;').get();
    return row && String(row.quick_check) === 'ok';
  }

  list(namespace) {
    if (namespace !== PLAN_NAMESPACE) throw new RecoveryError('READ_ONLY_SCOPE', 'The read-only recovery reader only exposes launch plans.');
    return this.db.prepare(`
      SELECT record_key, revision, value_json, updated_at
      FROM records WHERE namespace = ? ORDER BY record_key
    `).all(namespace).map(row => {
      let value;
      try { value = JSON.parse(String(row.value_json)); }
      catch (_) { throw new RecoveryError('INVALID_PLAN_JSON', 'A launch-plan record contains invalid JSON.'); }
      return {
        key: String(row.record_key),
        revision: Number(row.revision),
        value,
        rawJson: String(row.value_json),
        updatedAt: String(row.updated_at),
      };
    });
  }

  countNamespace(namespace) {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM records WHERE namespace = ?').get(String(namespace));
    return Number(row && row.count || 0);
  }

  accountDigests() {
    const rows = this.db.prepare(`
      SELECT COALESCE(json_extract(item.value, '$.id'), json_extract(item.value, '$.userId')) AS account_id
      FROM records AS document, json_each(document.value_json) AS item
      WHERE document.namespace = 'documents' AND document.record_key = 'accounts.json'
    `).all();
    return new Set(rows.map(row => sha256(row.account_id == null ? '' : row.account_id)));
  }

  close() {
    if (this.db) this.db.close();
    this.db = null;
  }
}

module.exports = {
  ReadOnlyRecoveryDatabase,
  RecoveryError,
  applyLaunchPlanRecovery,
  assertSyntheticMutation,
  buildSyntheticRecoverySpec,
  createExactMutationAuthority,
  fileFingerprint,
  inspectLaunchPlanRecovery,
  sha256,
};
