'use strict';

const path = require('path');
const { StateDatabase } = require(path.join(__dirname, '..', '..', 'src', 'main', 'state-database'));

const dbPath = process.argv[2];
const iterations = Math.max(1, Number(process.argv[3]) || 1);
const db = new StateDatabase({ path: dbPath, assertOwner: () => true });
try {
  for (let index = 0; index < iterations; index += 1) {
    db.update('multiprocess', 'counter', { count: 0 }, value => ({ count: Number(value.count) + 1 }));
  }
} finally {
  db.close();
}
