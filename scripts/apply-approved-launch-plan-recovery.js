'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
const { StateDatabase } = require('../src/main/state-database');
const { loadRecoveryApproval } = require('./recovery-approval');
let APPROVED_REAL_DATABASE_PATH;
let APPROVED_REAL_DATABASE_SHA256;
let APPROVED_REAL_DATABASE_SIZE;
let APPROVED_REAL_RECOVERY_SPEC;
const {
  ReadOnlyRecoveryDatabase,
  RecoveryError,
  applyLaunchPlanRecovery,
  createExactMutationAuthority,
  fileFingerprint,
  inspectLaunchPlanRecovery,
} = require('../src/main/launch-plan-recovery');

const CONFIRMATION = 'APPLY_APPROVED_RECOVERY_20261009';

function fail(code, message) {
  throw new RecoveryError(code, message);
}

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== '--confirm' || argv[1] !== CONFIRMATION || argv[2] !== '--approval' || !argv[3]) {
    fail('EXPLICIT_CONFIRMATION_REQUIRED', `Usage: node scripts/apply-approved-launch-plan-recovery.js --confirm ${CONFIRMATION} --approval <absolute-private-approval-file>`);
  }
  return argv[3];
}

function observeProtectedProcesses() {
  if (process.platform !== 'win32') fail('PROCESS_OBSERVATION_UNAVAILABLE', 'Process observation requires Windows.');
  const command = [
    "$ErrorActionPreference='Stop'",
    "$items = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(SUNDAY|Sunday|Roblox)' } | Select-Object ProcessId,Name,CreationDate,ExecutablePath)",
    '[pscustomobject]@{ ok=$true; count=$items.Count; processes=$items } | ConvertTo-Json -Compress -Depth 3',
  ].join('; ');
  const observed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (observed.status !== 0 || !observed.stdout.trim()) {
    fail('PROCESS_OBSERVATION_UNAVAILABLE', 'Safe process observation did not complete successfully.');
  }
  let report;
  try { report = JSON.parse(observed.stdout.trim()); }
  catch (_) { fail('PROCESS_OBSERVATION_UNAVAILABLE', 'Safe process observation returned invalid data.'); }
  if (!report || report.ok !== true || !Number.isInteger(report.count)) {
    fail('PROCESS_OBSERVATION_UNAVAILABLE', 'Safe process observation returned an incomplete result.');
  }
  return report;
}

function assertOffline() {
  const report = observeProtectedProcesses();
  if (report.count !== 0) fail('PROTECTED_PROCESS_PRESENT', 'A SUNDAY or Roblox process is present.');
  return true;
}

function assertJournalState(databasePath) {
  for (const suffix of ['-wal', '-journal']) {
    const sidecar = `${databasePath}${suffix}`;
    if (fs.existsSync(sidecar) && fs.statSync(sidecar).size !== 0) {
      fail('PENDING_DATABASE_JOURNAL', 'The database has pending journal content.');
    }
  }
}

function inspectImmutable() {
  let reader;
  try {
    assertJournalState(APPROVED_REAL_DATABASE_PATH);
    reader = new ReadOnlyRecoveryDatabase(APPROVED_REAL_DATABASE_PATH);
    if (!reader.quickCheck()) fail('DATABASE_INTEGRITY_FAILED', 'SQLite quick_check did not return ok.');
    return inspectLaunchPlanRecovery(reader, APPROVED_REAL_RECOVERY_SPEC);
  } finally {
    if (reader) reader.close();
  }
}

function assertApprovedFile() {
  const fingerprint = fileFingerprint(APPROVED_REAL_DATABASE_PATH);
  if (fingerprint.size !== APPROVED_REAL_DATABASE_SIZE
      || fingerprint.sha256 !== APPROVED_REAL_DATABASE_SHA256) {
    fail('DATABASE_FINGERPRINT_MISMATCH', 'The real database does not match the approved pre-recovery fingerprint.');
  }
  return fingerprint;
}

function sanitizedResult(conclusion, report, fingerprint, processCount, errorCode) {
  return {
    mode: 'APPROVED_ONE_SHOT_RECOVERY',
    conclusion,
    errorCode: errorCode || null,
    database: fingerprint ? {
      size: fingerprint.size,
      sha256: fingerprint.sha256,
    } : null,
    processCount,
    integrity: report ? 'ok' : 'unknown',
    report: report || null,
  };
}

function main() {
  let writer;
  let explicitlyConfirmed = false;
  let transactionStarted = false;
  let applyError = null;
  try {
    const approvalFile = parseArgs(process.argv.slice(2));
    ({ APPROVED_REAL_DATABASE_PATH, APPROVED_REAL_DATABASE_SHA256, APPROVED_REAL_DATABASE_SIZE, APPROVED_REAL_RECOVERY_SPEC } = loadRecoveryApproval(approvalFile));
    explicitlyConfirmed = true;
    assertApprovedFile();
    assertOffline();
    const preflight = inspectImmutable();
    if (!preflight.safeToApply || preflight.status !== 'ORIGINAL' || preflight.mismatches.length !== 0) {
      fail('RECOVERY_PREFLIGHT_FAILED', 'The immutable recovery preflight did not match the approved original state.');
    }

    // Recheck immediately before opening a writer. The authority repeats these
    // checks immediately before BEGIN IMMEDIATE.
    assertApprovedFile();
    assertJournalState(APPROVED_REAL_DATABASE_PATH);
    assertOffline();
    const authority = createExactMutationAuthority({
      path: APPROVED_REAL_DATABASE_PATH,
      sha256: APPROVED_REAL_DATABASE_SHA256,
      size: APPROVED_REAL_DATABASE_SIZE,
    }, { assertOffline });
    writer = new StateDatabase({
      path: APPROVED_REAL_DATABASE_PATH,
      assertOwner: () => authority(writer),
    });
    transactionStarted = true;
    applyLaunchPlanRecovery(writer, APPROVED_REAL_RECOVERY_SPEC, { authorizeMutation: authority });
  } catch (error) {
    applyError = error;
  } finally {
    if (writer) {
      try { writer.close(); } catch (error) { if (!applyError) applyError = error; }
      writer = null;
    }
  }

  if (!transactionStarted) {
    const fingerprint = explicitlyConfirmed && fs.existsSync(APPROVED_REAL_DATABASE_PATH)
      ? fileFingerprint(APPROVED_REAL_DATABASE_PATH) : null;
    process.stderr.write(`${JSON.stringify(sanitizedResult(
      'RECOVERY NOT APPLIED; DATABASE UNCHANGED', null, fingerprint, null,
      String(applyError && applyError.code || 'RECOVERY_PREFLIGHT_FAILED'),
    ))}\n`);
    process.exitCode = 2;
    return;
  }

  let report = null;
  let fingerprint = null;
  let processCount = null;
  let verificationError = null;
  try {
    report = inspectImmutable();
    fingerprint = fileFingerprint(APPROVED_REAL_DATABASE_PATH);
    processCount = observeProtectedProcesses().count;
  } catch (error) {
    verificationError = error;
  }

  if (!verificationError && report && report.alreadyComplete && report.status === 'COMPLETE'
      && report.mismatches.length === 0 && processCount === 0) {
    process.stdout.write(`${JSON.stringify(sanitizedResult(
      'RECOVERY APPLIED AND VERIFIED', report, fingerprint, processCount, null,
    ), null, 2)}\n`);
    return;
  }
  if (!verificationError && report && report.safeToApply && report.status === 'ORIGINAL'
      && report.mismatches.length === 0 && fingerprint
      && fingerprint.sha256 === APPROVED_REAL_DATABASE_SHA256) {
    process.stderr.write(`${JSON.stringify(sanitizedResult(
      'RECOVERY NOT APPLIED; DATABASE UNCHANGED', report, fingerprint, processCount,
      String(applyError && applyError.code || 'RECOVERY_ROLLED_BACK'),
    ))}\n`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`${JSON.stringify(sanitizedResult(
    'RECOVERY OUTCOME AMBIGUOUS; STOPPED FOR MANUAL REVIEW', report, fingerprint, processCount,
    String(verificationError && verificationError.code || applyError && applyError.code || 'RECOVERY_VERIFICATION_FAILED'),
  ))}\n`);
  process.exitCode = 3;
}

main();
