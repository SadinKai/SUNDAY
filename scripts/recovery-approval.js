'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Approval data is private, supplied explicitly, and never bundled with SUNDAY.
function loadRecoveryApproval(file) {
  if (!file || !path.isAbsolute(file)) throw new Error('An absolute recovery approval file is required.');
  const approval = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!approval || !path.isAbsolute(String(approval.APPROVED_REAL_DATABASE_PATH || ''))
      || !/^[a-f0-9]{64}$/.test(String(approval.APPROVED_REAL_DATABASE_SHA256 || ''))
      || !Number.isSafeInteger(approval.APPROVED_REAL_DATABASE_SIZE) || approval.APPROVED_REAL_DATABASE_SIZE <= 0
      || !approval.APPROVED_REAL_RECOVERY_SPEC || approval.APPROVED_REAL_RECOVERY_SPEC.schemaVersion !== 1) {
    throw new Error('The private recovery approval is invalid.');
  }
  return approval;
}

module.exports = { loadRecoveryApproval };
