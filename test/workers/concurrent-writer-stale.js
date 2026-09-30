/**
 * test/workers/concurrent-writer-stale.js
 *
 * DEMONSTRATES THE OLD BROKEN BEHAVIOR (for regression testing).
 *
 * This worker simulates what the OLD implementation did:
 *   1. Read the ENTIRE accounts.json into staleSnapshot BEFORE the barrier.
 *   2. Wait for the go-file (barrier).
 *   3. Mutate the target account IN THE STALE SNAPSHOT.
 *   4. Write the ENTIRE STALE SNAPSHOT back to disk (no re-read, no lock).
 *
 * When two such workers run concurrently on different accounts, the second
 * writer's stale snapshot does not include the first writer's mutation.
 * The second write OVERWRITES the first. Exactly one mutation survives.
 *
 * This is the lost-update bug the new implementation fixes.
 * Tests use this worker to prove the bug EXISTS with the old approach and
 * DOES NOT EXIST with the new one.
 *
 * argv[2] = accountsFile (path to accounts.json)
 * argv[3] = accountId   ('acc1' or 'acc2')
 * argv[4] = newUsername
 * argv[5] = goFile      (wait until this file exists before committing)
 * argv[6] = doneFile    (write 'done' here on completion)
 */
'use strict';
const fs      = require('fs');
const path    = require('path');

const accountsFile = process.argv[2];
const accountId    = process.argv[3];
const newName      = process.argv[4];
const goFile       = process.argv[5];
const doneFile     = process.argv[6];

function sleepMs(ms) {
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, Math.max(1, ms));
  } catch (_) {
    const t = Date.now() + ms;
    while (Date.now() < t) {}
  }
}

// STEP 1: Read the stale snapshot BEFORE the barrier.
// This is exactly what both processes do in the lost-update scenario.
const stale = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
process.stdout.write('read-stale:' + accountId + ':' + JSON.stringify(stale.map(a => a.username)) + '\n');

// STEP 2: Wait for go-file (barrier). Both workers are past their reads.
const deadline = Date.now() + 10000;
while (!fs.existsSync(goFile) && Date.now() < deadline) {
  sleepMs(10);
}

// STEP 3: Mutate the target account IN THE STALE SNAPSHOT.
const acc = stale.find(a => a.id === accountId);
if (acc) acc.username = newName;

// STEP 4: Write the ENTIRE STALE SNAPSHOT back (old broken behavior).
// No lock, no re-read. Second writer clobbers first writer's changes.
fs.writeFileSync(accountsFile, JSON.stringify(stale, null, 2), 'utf8');

if (doneFile) fs.writeFileSync(doneFile, 'done\n', 'utf8');
process.stdout.write('committed-stale:' + accountId + ':' + newName + '\n');
process.exit(0);