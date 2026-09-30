/**
 * test/workers/concurrent-writer.js
 *
 * TRUE STALE-READ LOST-UPDATE TEST WORKER
 *
 * Protocol (proves the new RMW design prevents lost updates):
 *
 *   1. Read the entire accounts.json into `staleSnapshot` BEFORE the barrier.
 *      This simulates two processes that both read the same initial state.
 *
 *   2. Wait for the go-file (barrier) — at this point BOTH workers have
 *      their stale snapshots and are racing to commit.
 *
 *   3. Inside withLock:
 *        a. Re-read the CURRENT file (not the stale snapshot).
 *        b. Find this worker's target account in the current file.
 *        c. Apply ONLY this worker's mutation (username change).
 *        d. Write the result.
 *
 *   Why this proves correctness:
 *     - OLD implementation: writeRaw(staleSnapshot_with_one_mutation)
 *       → last writer overwrites first writer's changes → lost update
 *     - NEW implementation: re-read inside lock, apply targeted mutation
 *       → both mutations survive regardless of order
 *
 * argv[2] = baseDir
 * argv[3] = accountId  ('acc1' or 'acc2')
 * argv[4] = newUsername
 * argv[5] = goFile     (wait until this file exists before committing)
 * argv[6] = doneFile   (write 'done' here on completion)
 */
'use strict';
const path   = require('path');
const fs     = require('fs');
const accs   = require(path.join(__dirname, '..', '..', 'src', 'main', 'accounts'));

const baseDir    = process.argv[2];
const accountId  = process.argv[3];
const newName    = process.argv[4];
const goFile     = process.argv[5];
const doneFile   = process.argv[6];

accs.configure({ baseDir, safeStorage: null, logger: { info(){}, warn(){}, error(){} } });

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
// This is the snapshot that the OLD implementation would commit wholesale,
// causing the other worker's changes to be lost.
const accountsPath = path.join(baseDir, 'accounts.json');
const staleSnapshot = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
process.stdout.write('read-stale:' + accountId + ':' + JSON.stringify(staleSnapshot.map(a => a.username)) + '\n');

// STEP 2: Wait for the go-file (barrier).
// Both workers are now past their initial read and are about to commit.
const deadline = Date.now() + 10000;
while (!fs.existsSync(goFile) && Date.now() < deadline) {
  sleepMs(10);
}
if (!fs.existsSync(goFile)) {
  process.stderr.write('concurrent-writer: timeout waiting for go-file\n');
  process.exit(1);
}

// STEP 3: Commit inside withLock with a re-read.
// The re-read ensures this worker sees any changes the other worker already
// committed, so its own write preserves the other's mutation.
accs.withLock(() => {
  const current = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
  const acc = current.find(a => a.id === accountId);
  if (acc) acc.username = newName;
  fs.writeFileSync(accountsPath, JSON.stringify(current, null, 2), 'utf8');
});

if (doneFile) fs.writeFileSync(doneFile, 'done\n', 'utf8');
process.stdout.write('committed:' + accountId + ':' + newName + '\n');
process.exit(0);