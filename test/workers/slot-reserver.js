'use strict';

const { StateDatabase } = require('../../src/main/state-database');
const { SlotLeaseManager } = require('../../src/main/slot-leases');

const [databasePath, ownerId] = process.argv.slice(2);
const database = new StateDatabase({ path: databasePath, assertOwner: () => true });
try {
  const leases = new SlotLeaseManager({
    database,
    maxSlots: 1,
    ttlMs: 60_000,
    inspectProcess: () => ({ status: 'UNKNOWN' }),
  });
  try {
    const lease = leases.reserve(ownerId, `account-${ownerId}`);
    process.stdout.write(JSON.stringify({ ok: true, slotId: lease.slotId }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error.code }));
  }
} finally {
  database.close();
}
