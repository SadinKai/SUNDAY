'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { validateAllowedPath } = require('./release-trust');

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    while (true) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    buffer.fill(0);
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function listFiles(root, current, output) {
  const base = current || root;
  const out = output || [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    const full = path.join(base, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error('Candidate contains a link or reparse-point entry.');
    if (entry.isDirectory()) listFiles(root, full, out);
    else if (entry.isFile()) out.push(path.relative(root, full).split(path.sep).join('/'));
    else throw new Error('Candidate contains an unsupported filesystem entry.');
  }
  return out;
}

function assertPlainDirectory(directory) {
  let current = path.resolve(directory);
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`Version store path traverses a link: ${current}`);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(temp, 'wx');
    fs.writeFileSync(fd, JSON.stringify(value), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
  } catch (error) {
    if (fd != null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { fs.rmSync(temp, { force: true }); } catch (_) {}
    throw error;
  }
}

function normalizeAllowedFiles(allowedFiles) {
  if (!Array.isArray(allowedFiles) || !allowedFiles.length) {
    throw new Error('Candidate manifest must declare at least one file.');
  }
  const declared = new Map();
  for (const file of allowedFiles) {
    const relative = validateAllowedPath(file && file.path);
    const key = relative.toLowerCase();
    const size = Number(file && file.size);
    const sha256 = String(file && file.sha256 || '').toLowerCase();
    if (declared.has(key)) throw new Error('Candidate manifest contains a case-colliding path.');
    if (!Number.isSafeInteger(size) || size < 0 || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error(`Candidate manifest metadata is invalid: ${relative}`);
    }
    declared.set(key, { path: relative, size, sha256 });
  }
  return Array.from(declared.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function syncCopiedFile(input, output) {
  fs.copyFileSync(input, output, fs.constants.COPYFILE_EXCL);
  const fd = fs.openSync(output, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

class VersionStore {
  constructor(options) {
    const opts = options || {};
    this.root = path.resolve(String(opts.root || ''));
    this.db = opts.database;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.fault = typeof opts.faultInjector === 'function' ? opts.faultInjector : () => {};
    if (!path.isAbsolute(this.root) || !this.db) throw new Error('Version store requires an absolute root and transactional database.');
    fs.mkdirSync(this.root, { recursive: true });
    assertPlainDirectory(this.root);
    this.versions = path.join(this.root, 'versions');
    fs.mkdirSync(this.versions, { recursive: true });
    this.health = path.join(this.root, 'health');
    fs.mkdirSync(this.health, { recursive: true });
    this.pointer = path.join(this.root, 'active.json');
  }

  candidatePath(version) {
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(String(version || ''))) {
      throw new Error('Candidate version is invalid.');
    }
    return path.join(this.versions, String(version));
  }

  active() {
    if (!fs.existsSync(this.pointer)) return null;
    const value = JSON.parse(fs.readFileSync(this.pointer, 'utf8'));
    if (!value || typeof value.version !== 'string' || !Number.isSafeInteger(value.releaseSequence)) {
      throw new Error('Active version pointer is invalid.');
    }
    return value;
  }

  stageCandidate(version, sourceDirectory, allowedFiles) {
    const final = this.candidatePath(version);
    if (fs.existsSync(final)) throw new Error('Candidate version already exists.');
    const source = path.resolve(sourceDirectory);
    assertPlainDirectory(source);
    const files = normalizeAllowedFiles(allowedFiles);
    const declared = new Map(files.map(file => [file.path.toLowerCase(), file]));
    const actual = listFiles(source);
    if (actual.length !== declared.size || actual.some(file => !declared.has(file.toLowerCase()))) {
      throw new Error('Candidate directory contains undeclared or missing files.');
    }
    const stage = path.join(this.versions, `.staging-${crypto.randomUUID()}`);
    let promoted = false;
    this.fault('stage:before-directory');
    fs.mkdirSync(stage);
    try {
      for (const item of declared.values()) {
        this.fault('stage:before-copy');
        const input = path.join(source, ...item.path.split('/'));
        const stat = fs.lstatSync(input);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.size || hashFile(input) !== item.sha256) {
          throw new Error(`Candidate file failed verification: ${item.path}`);
        }
        const output = path.join(stage, ...item.path.split('/'));
        fs.mkdirSync(path.dirname(output), { recursive: true });
        assertPlainDirectory(path.dirname(output));
        syncCopiedFile(input, output);
        if (hashFile(output) !== item.sha256) throw new Error(`Candidate copy failed verification: ${item.path}`);
        this.fault('stage:after-copy');
      }
      this.fault('stage:before-rename');
      fs.renameSync(stage, final);
      promoted = true;
      this.fault('stage:after-rename');
      try {
        this.db.put('update-candidates', String(version), {
          version: String(version),
          path: final,
          files,
          stagedAt: new Date(this.now()).toISOString(),
        }, { expectedRevision: 0 });
      } catch (error) {
        this._removeOwnedCandidate(final);
        throw error;
      }
      return final;
    } catch (error) {
      this._removeOwnedStage(stage);
      if (promoted) this._removeOwnedCandidate(final);
      throw error;
    }
  }

  verifyCandidate(version) {
    const candidate = this.candidatePath(version);
    const row = this.db.get('update-candidates', String(version), null);
    if (!row.found || !row.value || row.value.version !== String(version) || path.resolve(row.value.path || '') !== candidate) {
      throw new Error('Candidate has no matching durable staging evidence.');
    }
    assertPlainDirectory(candidate);
    const metadata = fs.lstatSync(candidate);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Candidate root is not a plain directory.');
    const files = normalizeAllowedFiles(row.value.files);
    const declared = new Map(files.map(file => [file.path.toLowerCase(), file]));
    const actual = listFiles(candidate);
    if (actual.length !== files.length || actual.some(file => !declared.has(file.toLowerCase()))) {
      throw new Error('Candidate changed after staging.');
    }
    for (const item of files) {
      const file = path.join(candidate, ...item.path.split('/'));
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.size || hashFile(file) !== item.sha256) {
        throw new Error(`Candidate activation verification failed: ${item.path}`);
      }
    }
    return { candidate, files };
  }

  _removeOwnedStage(stage) {
    const resolved = path.resolve(stage);
    if (path.dirname(resolved) !== this.versions || !path.basename(resolved).startsWith('.staging-')) return false;
    if (!fs.existsSync(resolved) || fs.lstatSync(resolved).isSymbolicLink()) return false;
    fs.rmSync(resolved, { recursive: true, force: false });
    return true;
  }

  _removeOwnedCandidate(candidate) {
    const resolved = path.resolve(candidate);
    if (path.dirname(resolved) !== this.versions || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(path.basename(resolved))) return false;
    if (!fs.existsSync(resolved) || fs.lstatSync(resolved).isSymbolicLink()) return false;
    fs.rmSync(resolved, { recursive: true, force: false });
    return true;
  }

  _removeActivePointer() {
    if (!fs.existsSync(this.pointer)) return;
    const stat = fs.lstatSync(this.pointer);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Active pointer is not an owned plain file.');
    fs.rmSync(this.pointer, { force: false });
  }

  _removeHealthMarker(version) {
    const marker = path.join(this.health, `${String(version)}.json`);
    if (!fs.existsSync(marker)) return;
    const stat = fs.lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Health marker is not an owned plain file.');
    fs.rmSync(marker, { force: false });
  }

  recoverInterruptedActivation() {
    const row = this.db.get('update-journal', 'current', null);
    if (!row.found || !row.value || row.value.state !== 'ACTIVATING') {
      return { recovered: false };
    }
    const journal = row.value;
    const previous = journal.previous;
    const candidateVersion = journal.candidate && journal.candidate.version;
    let rollbackError = null;
    try {
      this.fault('recover:before-pointer');
      if (previous) {
        if (typeof previous.version !== 'string' || !Number.isSafeInteger(previous.releaseSequence)) {
          throw new Error('Interrupted activation journal has an invalid previous pointer.');
        }
        this.candidatePath(previous.version);
        atomicJson(this.pointer, previous);
      } else {
        this._removeActivePointer();
      }
      this.fault('recover:after-pointer');
      if (candidateVersion) {
        this.candidatePath(candidateVersion);
        this._removeHealthMarker(candidateVersion);
      }
    } catch (error) {
      rollbackError = error.message;
    }
    this.db.update('update-journal', 'current', null, current => Object.assign({}, current, {
      state: rollbackError ? 'ROLLBACK_FAILED' : 'ROLLED_BACK',
      error: 'Recovered an interrupted activation before accepting the candidate.',
      rollbackError,
      updatedAt: new Date(this.now()).toISOString(),
    }));
    return {
      recovered: !rollbackError,
      rolledBackTo: !rollbackError && previous && previous.version || null,
      rollbackError,
    };
  }

  async activate(version, releaseSequence, controls) {
    if (!controls || typeof controls.startCandidate !== 'function'
        || typeof controls.awaitHealth !== 'function' || typeof controls.verifyCandidate !== 'function') {
      throw new Error('Activation requires start, health, and external candidate verification controls.');
    }
    if (!Number.isSafeInteger(releaseSequence) || releaseSequence <= 0) {
      throw new Error('Release sequence must be a positive safe integer.');
    }
    const accepted = this.db.get('update-state', 'accepted', { releaseSequence: 0 }).value;
    if (releaseSequence <= (Number(accepted && accepted.releaseSequence) || 0)) {
      throw new Error('Candidate release sequence is not newer than the accepted release.');
    }
    const initial = this.verifyCandidate(version);
    const initialExternal = await controls.verifyCandidate(initial.candidate, initial.files);
    if (!initialExternal || initialExternal.ok !== true) throw new Error('External candidate verification failed before start.');
    const candidate = initial.candidate;
    const previous = this.active();
    const operationId = crypto.randomUUID();
    const nonce = crypto.randomBytes(32).toString('base64url');
    const journal = {
      operationId,
      state: 'ACTIVATING',
      previous,
      candidate: { version, releaseSequence },
      nonce,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.db.put('update-journal', 'current', journal);
    let started = null;
    let pointerChanged = false;
    let healthWritten = false;
    try {
      this.fault('activate:before-start');
      started = await controls.startCandidate(candidate, { version, nonce });
      if (!started || !started.capability) throw new Error('Candidate start did not return an owned process capability.');
      this.fault('activate:before-health');
      const health = await controls.awaitHealth(started, { version, nonce });
      if (!health || health.ok !== true || health.version !== version || health.nonce !== nonce) {
        throw new Error('Candidate health/version handshake failed.');
      }
      this.fault('activate:before-revalidation');
      const final = this.verifyCandidate(version);
      const finalExternal = await controls.verifyCandidate(final.candidate, final.files);
      if (!finalExternal || finalExternal.ok !== true) throw new Error('External candidate verification failed at activation boundary.');
      this.fault('activate:after-revalidation');
      const healthMarker = path.join(this.health, `${String(version)}.json`);
      this.fault('activate:before-health-marker');
      atomicJson(healthMarker, {
        version,
        releaseSequence,
        nonceHash: crypto.createHash('sha256').update(nonce).digest('hex'),
        healthyAt: new Date(this.now()).toISOString(),
      });
      healthWritten = true;
      this.fault('activate:before-pointer');
      atomicJson(this.pointer, {
        version,
        releaseSequence,
        activatedAt: new Date(this.now()).toISOString(),
      });
      pointerChanged = true;
      this.fault('activate:after-pointer');
      this.db.transaction(() => {
        this.db.update('update-journal', 'current', null, current => Object.assign({}, current, {
          state: 'ACTIVE',
          updatedAt: new Date(this.now()).toISOString(),
        }));
        this.db.put('update-state', 'accepted', { version, releaseSequence });
      });
      return { ok: true, operationId, version, previous };
    } catch (error) {
      if (started && typeof controls.stopCandidate === 'function') {
        try { await controls.stopCandidate(started); } catch (_) {}
      }
      let rollbackError = null;
      if (pointerChanged) {
        try {
          if (previous) atomicJson(this.pointer, previous);
          else this._removeActivePointer();
        } catch (rollbackFailure) {
          rollbackError = rollbackFailure.message;
        }
      }
      if (healthWritten) {
        try { this._removeHealthMarker(version); } catch (healthFailure) { rollbackError ||= healthFailure.message; }
      }
      let journalError = null;
      try {
        this.db.update('update-journal', 'current', null, current => Object.assign({}, current, {
          state: rollbackError ? 'ROLLBACK_FAILED' : 'ROLLED_BACK',
          error: error.message,
          rollbackError,
          updatedAt: new Date(this.now()).toISOString(),
        }));
      } catch (journalFailure) {
        journalError = journalFailure.message;
      }
      return {
        ok: false,
        operationId,
        rolledBackTo: !rollbackError && previous && previous.version || null,
        error: error.message,
        rollbackError,
        journalError,
      };
    }
  }
}

module.exports = {
  VersionStore,
  hashFile,
  listFiles,
  atomicJson,
  assertPlainDirectory,
  normalizeAllowedFiles,
};
