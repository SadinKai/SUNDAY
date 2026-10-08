'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 1;

function stateError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

class StateDatabase {
  constructor(options) {
    const opts = options || {};
    const dbPath = path.resolve(String(opts.path || ''));
    if (!path.isAbsolute(dbPath) || !path.basename(dbPath)) {
      throw stateError('ESTATEPATH', 'State database path must be absolute.');
    }
    this.path = dbPath;
    this.assertOwner = typeof opts.assertOwner === 'function'
      ? opts.assertOwner
      : () => { throw stateError('ENOTOWNER', 'Persistent mutation requires the SUNDAY Launcher owner authority.'); };
    this.fault = typeof opts.faultInjector === 'function' ? opts.faultInjector : () => {};
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.transactionDepth = 0;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    try {
      this.db = new DatabaseSync(dbPath, {
        open: true,
        readOnly: false,
        enableForeignKeyConstraints: true,
        timeout: 5000,
      });
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = FULL;');
      this.db.exec('PRAGMA busy_timeout = 5000;');
      this.db.exec('PRAGMA trusted_schema = OFF;');
      this._migrate();
      const result = this.db.prepare('PRAGMA quick_check;').get();
      if (!result || String(result.quick_check) !== 'ok') {
        throw stateError('ESTATECORRUPT', 'SQLite quick_check did not return ok.');
      }
    } catch (error) {
      try { if (this.db) this.db.close(); } catch (_) {}
      if (error && error.code === 'ESTATECORRUPT') throw error;
      throw stateError('ESTATEOPEN', `Could not open the transactional state database: ${error.message}`, error);
    }
  }

  _migrate() {
    const current = Number(this.db.prepare('PRAGMA user_version;').get().user_version || 0);
    if (current > SCHEMA_VERSION) {
      throw stateError('ESTATENEWER', `State schema ${current} is newer than supported schema ${SCHEMA_VERSION}.`);
    }
    if (current < 1) {
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS records (
          namespace TEXT NOT NULL,
          record_key TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK (revision > 0),
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (namespace, record_key)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO schema_migrations(version, applied_at)
          VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
        PRAGMA user_version = 1;
        COMMIT;
      `);
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  transaction(callback) {
    this.assertOwner();
    if (this.transactionDepth > 0) return callback(this);
    this.fault('before-begin');
    this.db.exec('BEGIN IMMEDIATE;');
    this.transactionDepth = 1;
    try {
      const result = callback(this);
      if (result && typeof result.then === 'function') {
        throw stateError('EASYNCTRANSACTION', 'State transactions must be synchronous.');
      }
      this.fault('before-commit');
      this.db.exec('COMMIT;');
      this.transactionDepth = 0;
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK;'); } catch (_) {}
      this.transactionDepth = 0;
      throw error;
    }
  }

  get(namespace, key, fallback) {
    const row = this.db.prepare(
      'SELECT revision, value_json, updated_at FROM records WHERE namespace = ? AND record_key = ?',
    ).get(String(namespace), String(key));
    if (!row) return { found: false, revision: 0, value: clone(fallback), updatedAt: null };
    try {
      return {
        found: true,
        revision: Number(row.revision),
        value: JSON.parse(String(row.value_json)),
        updatedAt: String(row.updated_at),
      };
    } catch (error) {
      throw stateError('ESTATECORRUPT', `State record ${namespace}/${key} contains invalid JSON.`, error);
    }
  }

  list(namespace) {
    const rows = this.db.prepare(
      'SELECT record_key, revision, value_json, updated_at FROM records WHERE namespace = ? ORDER BY record_key',
    ).all(String(namespace));
    return rows.map(row => {
      try {
        return {
          key: String(row.record_key),
          revision: Number(row.revision),
          value: JSON.parse(String(row.value_json)),
          updatedAt: String(row.updated_at),
        };
      } catch (error) {
        throw stateError('ESTATECORRUPT', `State record ${namespace}/${row.record_key} contains invalid JSON.`, error);
      }
    });
  }

  put(namespace, key, value, options) {
    const write = () => {
      this.assertOwner();
      const expected = options && options.expectedRevision;
      const current = this.get(namespace, key, undefined);
      if (expected != null && Number(expected) !== current.revision) {
        throw stateError('ESTALEWRITE', `State revision conflict for ${namespace}/${key}.`);
      }
      const revision = current.revision + 1;
      const json = JSON.stringify(value);
      if (json === undefined) throw stateError('ESTATEVALUE', 'Undefined is not a persistent state value.');
      const updatedAt = new Date(this.now()).toISOString();
      this.fault('before-write');
      this.db.prepare(`
        INSERT INTO records(namespace, record_key, revision, value_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(namespace, record_key) DO UPDATE SET
          revision = excluded.revision,
          value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `).run(String(namespace), String(key), revision, json, updatedAt);
      this.fault('after-write');
      return { revision, value: clone(value), updatedAt };
    };
    return this.transactionDepth > 0 ? write() : this.transaction(write);
  }

  update(namespace, key, fallback, mutator, options) {
    return this.transaction(() => {
      const current = this.get(namespace, key, fallback);
      const next = mutator(clone(current.value), current.revision);
      return this.put(namespace, key, next, {
        expectedRevision: options && options.expectedRevision != null
          ? options.expectedRevision
          : current.revision,
      });
    });
  }

  delete(namespace, key, options) {
    const remove = () => {
      this.assertOwner();
      const current = this.get(namespace, key, undefined);
      const expected = options && options.expectedRevision;
      if (expected != null && Number(expected) !== current.revision) {
        throw stateError('ESTALEWRITE', `State revision conflict for ${namespace}/${key}.`);
      }
      if (!current.found) return { deleted: false, revision: 0 };
      this.fault('before-delete');
      this.db.prepare('DELETE FROM records WHERE namespace = ? AND record_key = ?')
        .run(String(namespace), String(key));
      return { deleted: true, revision: current.revision };
    };
    return this.transactionDepth > 0 ? remove() : this.transaction(remove);
  }

  backupTo(destination) {
    this.assertOwner();
    const target = path.resolve(String(destination || ''));
    if (!path.isAbsolute(target) || target === this.path || fs.existsSync(target)) {
      throw stateError('EBACKUPPATH', 'Backup destination must be a fresh absolute path.');
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const quoted = target.replace(/'/g, "''");
    this.fault('before-backup');
    this.db.exec(`VACUUM INTO '${quoted}';`);
    const check = new DatabaseSync(target, { readOnly: true });
    try {
      const result = check.prepare('PRAGMA quick_check;').get();
      if (!result || String(result.quick_check) !== 'ok') {
        throw stateError('EBACKUPVERIFY', 'Backup integrity check failed.');
      }
    } finally {
      check.close();
    }
    return target;
  }

  compact() {
    this.assertOwner();
    if (this.transactionDepth > 0) {
      throw stateError('ESTATETRANSACTION', 'State compaction cannot run inside a transaction.');
    }
    this.fault('before-compact');
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    this.db.exec('VACUUM;');
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const result = this.db.prepare('PRAGMA quick_check;').get();
    if (!result || String(result.quick_check) !== 'ok') {
      throw stateError('ESTATECORRUPT', 'SQLite quick_check failed after compaction.');
    }
    return true;
  }
}

module.exports = { StateDatabase, SCHEMA_VERSION, stateError };
