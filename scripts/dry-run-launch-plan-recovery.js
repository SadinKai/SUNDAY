'use strict';

const path = require('path');
const { loadRecoveryApproval } = require('./recovery-approval');
const {
  ReadOnlyRecoveryDatabase,
  inspectLaunchPlanRecovery,
} = require('../src/main/launch-plan-recovery');

function parseArgs(argv) {
  if (argv.length !== 4 || argv[0] !== '--database' || !argv[1] || argv[2] !== '--approval' || !argv[3]) {
    throw new Error('Usage: node scripts/dry-run-launch-plan-recovery.js --database <absolute-path> --approval <absolute-private-approval-file>');
  }
  if (!path.isAbsolute(argv[1])) throw new Error('The database path must be absolute.');
  const database = path.resolve(argv[1]);
  return { database, approval: argv[3] };
}

function main() {
  let reader;
  try {
    const args = parseArgs(process.argv.slice(2));
    const approval = loadRecoveryApproval(args.approval);
    reader = new ReadOnlyRecoveryDatabase(args.database);
    if (!reader.quickCheck()) throw new Error('SQLite quick_check did not return ok.');
    const report = inspectLaunchPlanRecovery(reader, approval.APPROVED_REAL_RECOVERY_SPEC);
    process.stdout.write(`${JSON.stringify({
      mode: 'READ_ONLY_DRY_RUN',
      integrity: 'ok',
      report,
    }, null, 2)}\n`);
    process.exitCode = report.safeToApply || report.alreadyComplete ? 0 : 2;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      mode: 'READ_ONLY_DRY_RUN',
      ok: false,
      code: String(error && error.code || 'DRY_RUN_FAILED'),
      error: 'The recovery dry run could not establish the approved state.',
    })}\n`);
    process.exitCode = 2;
  } finally {
    if (reader) reader.close();
  }
}

main();
