/**
 * test/workers/lock-holder.js
 * Hold the accounts.json lock for holdMs ms to prove a live holder is never forcibly evicted.
 * argv[2] = baseDir, argv[3] = holdMs, argv[4] = ipc-file (optional)
 */
'use strict';
const path = require('path');
const fs   = require('fs');

const baseDir  = process.argv[2];
const holdMs   = parseInt(process.argv[3], 10) || 3000;
const ipcFile  = process.argv[4] || null;
const lockPath = path.join(baseDir, 'accounts.json.lock');

function sleep(ms) {
  try {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, Math.max(1, ms));
  } catch (_) {
    const until = Date.now() + ms;
    while (Date.now() < until) {}
  }
}

let fd;
try {
  fd = fs.openSync(lockPath, 'wx');
  fs.writeFileSync(fd, String(process.pid), 'utf8');
  fs.closeSync(fd);
} catch (e) {
  process.stderr.write('lock-holder: failed to acquire: ' + e.message + '\n');
  process.exit(1);
}
if (ipcFile) fs.writeFileSync(ipcFile, 'locked\n', 'utf8');
process.stdout.write('locked\n');

sleep(holdMs);

try { fs.unlinkSync(lockPath); } catch (_) {}
if (ipcFile) fs.appendFileSync(ipcFile, 'released\n', 'utf8');
process.stdout.write('released\n');
process.exit(0);
