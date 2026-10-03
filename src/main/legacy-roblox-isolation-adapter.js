'use strict';

/**
 * LEGACY COMPATIBILITY MODE -- NOT VENDOR SUPPORTED ISOLATION.
 *
 * This adapter preserves the pre-hardening launcher's per-path clone and Roblox singleton
 * behavior behind the exact LEGACY_COMPAT=1 opt-in. The compatibility code
 * may coordinate Roblox's global singleton handles; it never grants broad
 * process authority and never terminates a process not launched by this
 * adapter instance.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const {
  ISOLATION_STATES,
  RobloxIsolationAdapter,
  result,
} = require('./roblox-isolation-adapter');

const LEGACY_REASON = "Uses SUNDAY Launcher's legacy compatibility mechanism. This is not vendor supported isolation.";
const PLAYER_EXE = 'RobloxPlayerBeta.exe';
const SLOT_STATES = Object.freeze({
  FREE: 'FREE',
  OCCUPIED: 'OCCUPIED',
  RELEASABLE_BUT_BUSY: 'RELEASABLE_BUT_BUSY',
});

function normalize(value) {
  try { return path.win32.normalize(String(value || '')).replace(/[\\/]+$/, '').toLowerCase(); }
  catch (_) { return ''; }
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason || new Error('Cancelled.'));
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('Cancelled.'));
    }, { once: true });
  });
}

function present(target) {
  try { fs.lstatSync(target); return true; } catch (_) { return false; }
}

function statShape(stat) {
  if (!stat) return null;
  return {
    file: stat.isFile(),
    directory: stat.isDirectory(),
    symbolicLink: stat.isSymbolicLink(),
    size: Number(stat.size),
    device: String(stat.dev),
    inode: String(stat.ino),
    links: Number(stat.nlink),
    mode: Number(stat.mode),
  };
}

function pathEvidence(target) {
  const value = String(target || '');
  const evidence = { path: value, pathLength: value.length, exists: present(value) };
  try { evidence.lstat = statShape(fs.lstatSync(value)); }
  catch (error) { evidence.lstatError = { code: error.code, message: error.message }; }
  try { evidence.stat = statShape(fs.statSync(value)); }
  catch (error) { evidence.statError = { code: error.code, message: error.message }; }
  try { evidence.realpath = fs.realpathSync.native(value); }
  catch (error) { evidence.realpathError = { code: error.code, message: error.message }; }
  try { fs.accessSync(value, fs.constants.R_OK); evidence.readable = true; }
  catch (error) { evidence.readable = false; evidence.readError = { code: error.code, message: error.message }; }
  try { fs.accessSync(value, fs.constants.W_OK); evidence.writableAccessCheck = true; }
  catch (error) { evidence.writableAccessCheck = false; evidence.writeError = { code: error.code, message: error.message }; }
  return evidence;
}

function directoryTraversalEvidence(directory) {
  const evidence = { directory: String(directory || '') };
  let handle;
  try {
    handle = fs.opendirSync(directory);
    const names = [];
    let entry;
    while ((entry = handle.readSync()) && names.length < 100) names.push(entry.name);
    evidence.entries = names;
  } catch (error) {
    evidence.error = { code: error.code, message: error.message };
  } finally {
    try { if (handle) handle.closeSync(); } catch (_) {}
  }
  try {
    const entries = fs.readdirSync(directory, { withFileTypes: true });
    const knownDirectory = entries.find(entry => {
      try { return fs.statSync(path.join(directory, entry.name)).isDirectory(); } catch (_) { return false; }
    });
    if (knownDirectory) {
      const childDirectory = path.join(directory, knownDirectory.name);
      evidence.knownChildDirectory = pathEvidence(childDirectory);
      const queue = [childDirectory];
      while (queue.length && !evidence.knownChildFile) {
        const current = queue.shift();
        for (const name of fs.readdirSync(current)) {
          const child = path.join(current, name);
          const stat = fs.statSync(child);
          if (stat.isFile()) {
            const fileHandle = fs.openSync(child, 'r');
            try { evidence.knownChildFile = pathEvidence(child); }
            finally { fs.closeSync(fileHandle); }
            break;
          }
          if (stat.isDirectory() && queue.length < 20) queue.push(child);
        }
      }
    }
  } catch (error) {
    evidence.childError = { code: error.code, message: error.message };
  }
  return evidence;
}

function treeEvidence(directory) {
  try {
    return fs.readdirSync(directory).sort().map(name => {
      const target = path.join(directory, name);
      return Object.assign({ name }, pathEvidence(target));
    });
  } catch (error) {
    return [{ error: { code: error.code, message: error.message } }];
  }
}

function windowsShellEvidence(target) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    "$p=$env:SUNDAY_FORENSIC_PATH",
    "$item=Get-Item -LiteralPath $p -Force -ErrorAction Stop",
    "$resolved=(Resolve-Path -LiteralPath $p -ErrorAction Stop).ProviderPath",
    "$acl=(Get-Acl -LiteralPath $p -ErrorAction Stop).Sddl",
    "$entries=@(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Select-Object -First 100 -ExpandProperty Name)",
    "[ordered]@{path=$p;exists=(Test-Path -LiteralPath $p);container=(Test-Path -LiteralPath $p -PathType Container);leaf=(Test-Path -LiteralPath $p -PathType Leaf);fullName=$item.FullName;providerPath=$item.PSPath;resolvedProviderPath=$resolved;attributes=[string]$item.Attributes;linkType=[string]$item.LinkType;target=@($item.Target);acl=$acl;entries=$entries}|ConvertTo-Json -Compress -Depth 6",
  ].join(';');
  const completed = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { SUNDAY_FORENSIC_PATH: String(target || '') }),
    timeout: 10000,
    windowsHide: true,
  });
  const stdout = String(completed.stdout || '').trim();
  try { return { status: completed.status, result: JSON.parse(stdout), stderr: String(completed.stderr || '').trim() }; }
  catch (_) { return { status: completed.status, stdout, stderr: String(completed.stderr || '').trim(), error: completed.error && completed.error.message }; }
}

function sanitizedLegacyFailure(message, stage) {
  const value = String(message || '').toLowerCase();
  if (value.includes('startup error dialog')) return { code: 'ROBLOX_STARTUP_ERROR', stage, reason: 'Roblox opened a startup error dialog.' };
  if (value.includes('timeout') || value.includes('stable running window')) return { code: 'STARTUP_TIMEOUT', stage, reason: 'Roblox startup timed out before a stable running state was verified.' };
  if (value.includes('not found')) return { code: 'ROBLOX_NOT_FOUND', stage, reason: 'RobloxPlayerBeta.exe was not found. Locate it in Settings.' };
  if (value.includes('clone') || value.includes('slot') || value.includes('content')) return { code: 'SLOT_PREPARATION_FAILED', stage, reason: 'Multi-instance compatibility could not prepare a safe client slot.' };
  if (value.includes('identity') || value.includes('ownership')) return { code: 'OWNERSHIP_NOT_VERIFIED', stage, reason: 'SUNDAY could not verify ownership of the launched Roblox process.' };
  return { code: 'LAUNCH_FAILED', stage, reason: 'Roblox could not be launched in Multi-instance mode.' };
}

class LegacyCloneManager {
  constructor(options) {
    const opts = options || {};
    if (!opts.root) throw new Error('LegacyCloneManager requires a clone root.');
    this.root = path.resolve(opts.root);
    this.logger = opts.logger || { info() {}, warn() {} };
    this.forensic = typeof opts.forensic === 'function' ? opts.forensic : () => {};
    this.maxConcurrentSlots = 3;
    this.maxPhysicalSlots = Math.max(this.maxConcurrentSlots + 1, Number(opts.maxPhysicalSlots) || 4);
    this.reserved = new Set();
    this.slotStates = new Map();
    this.reclaimProbe = typeof opts.reclaimProbe === 'function'
      ? opts.reclaimProbe
      : executablePath => {
        const handle = fs.openSync(executablePath, 'r+');
        fs.closeSync(handle);
      };
    fs.mkdirSync(this.root, { recursive: true });
  }

  _setSlotState(slotId, state, details) {
    const entry = Object.freeze(Object.assign({
      instanceId: String(slotId),
      state,
      ownership: state === SLOT_STATES.OCCUPIED ? 'OWNED' : 'RELEASED',
      reclamation: state === SLOT_STATES.FREE ? 'READY' : (state === SLOT_STATES.OCCUPIED ? 'BLOCKED_BY_OWNER' : 'BUSY'),
      reason: '',
    }, details || {}));
    this.slotStates.set(String(slotId), entry);
    this.forensic('clone_slot_state', entry);
    return entry;
  }

  getSlotState(slotId) {
    return this.slotStates.get(String(slotId)) || null;
  }

  slotStateSnapshot() {
    return Array.from(this.slotStates.values())
      .sort((a, b) => Number(a.instanceId.split('-')[1]) - Number(b.instanceId.split('-')[1]));
  }

  markOccupied(slotId, evidence) {
    return this._setSlotState(slotId, SLOT_STATES.OCCUPIED, {
      ownership: 'OWNED',
      reclamation: 'BLOCKED_BY_OWNER',
      reason: 'A current SUNDAY Launcher capability proves a live Roblox process owns this slot.',
      owner: evidence || null,
      reservation: 'ACTIVE',
    });
  }

  markReleased(slotId, details) {
    return this._setSlotState(slotId, SLOT_STATES.RELEASABLE_BUT_BUSY, Object.assign({
      ownership: 'RELEASED',
      reclamation: 'PENDING',
      reason: 'No current SUNDAY Launcher capability owns this slot; safe physical reclamation has not yet been proved.',
      reservation: this.reserved.has(String(slotId)) ? 'RESERVED_FOR_LAUNCH' : 'NONE',
    }, details || {}));
  }

  _refreshOwnedStates(ownedSlots) {
    if (!(ownedSlots instanceof Map)) return;
    for (const [slotId, evidence] of ownedSlots) this.markOccupied(slotId, evidence);
  }

  _slotPath(slotId) {
    const target = path.resolve(this.root, String(slotId));
    const prefix = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (!target.startsWith(prefix)) throw new Error('Legacy slot path escaped its configured root.');
    return target;
  }

  _slotInUse(directory, liveRows) {
    if (!Array.isArray(liveRows)) return true;
    const base = normalize(directory) + '\\';
    const slotMarker = `\\${path.basename(this.root).toLowerCase()}\\${path.basename(directory).toLowerCase()}\\`;
    for (const row of liveRows) {
      const executable = normalize(row && row.executablePath);
      if (!executable) return true;
      // Packaged Windows parents can virtualize AppData and prepend a
      // LocalCache path. The stable legacy-instances/instance-N suffix still
      // identifies the occupied slot and must prevent any rebuild beneath it.
      if (executable.startsWith(base) || executable.includes(slotMarker)) return true;
    }
    return false;
  }

  _unlinkLink(link) {
    try { fs.unlinkSync(link); return; } catch (_) {}
    try { fs.rmdirSync(link); } catch (_) {}
  }

  _removeTree(directory) {
    let stat;
    try { stat = fs.lstatSync(directory); } catch (_) { return true; }
    if (stat.isSymbolicLink()) {
      this._unlinkLink(directory);
      return !present(directory);
    }
    if (!stat.isDirectory()) {
      try { fs.unlinkSync(directory); return true; } catch (_) { return false; }
    }
    try {
      for (const name of fs.readdirSync(directory)) {
        const entryPath = path.join(directory, name);
        let entry;
        try { entry = fs.lstatSync(entryPath); } catch (_) { continue; }
        if (entry.isSymbolicLink()) this._unlinkLink(entryPath);
        else if (entry.isDirectory()) {
          if (!this._removeTree(entryPath)) return false;
        } else fs.unlinkSync(entryPath);
      }
      fs.rmdirSync(directory);
    } catch (_) {
      return false;
    }
    return !present(directory);
  }

  reclaim(slotId, liveRows, ownedSlots) {
    this._refreshOwnedStates(ownedSlots);
    const directory = this._slotPath(slotId);
    const owned = ownedSlots instanceof Map ? ownedSlots.get(slotId) : null;
    if (owned) {
      const state = this.markOccupied(slotId, owned);
      this.forensic('clone_reclaim', { slotId, directory, outcome: 'LIVE_OWNER', owner: owned });
      return Object.assign({ reusable: false }, state);
    }
    if (!present(directory)) {
      this.forensic('clone_reclaim', { slotId, directory, outcome: 'ABSENT' });
      return Object.assign({ reusable: true }, this._setSlotState(slotId, SLOT_STATES.FREE, {
        ownership: 'RELEASED',
        reclamation: 'ABSENT',
        reason: 'The slot directory is absent and can be built safely.',
        reservation: 'NONE',
      }));
    }
    if (this._slotInUse(directory, liveRows)) {
      this.forensic('clone_reclaim', {
        slotId,
        directory,
        outcome: 'UNOWNED_PROCESS_MAPPING',
        liveRows: Array.isArray(liveRows) ? liveRows : null,
      });
      return Object.assign({ reusable: false }, this._setSlotState(slotId, SLOT_STATES.RELEASABLE_BUT_BUSY, {
        ownership: 'RELEASED',
        reclamation: 'BUSY',
        reason: 'A process without a current SUNDAY Launcher capability still maps this slot; physical reclamation is deferred.',
        reservation: 'NONE',
      }));
    }
    const executable = path.join(directory, PLAYER_EXE);
    if (present(executable)) {
      try { this.reclaimProbe(executable, slotId); }
      catch (error) {
        this.forensic('clone_reclaim', {
          slotId,
          directory,
          outcome: 'EXECUTABLE_LOCKED',
          error: { code: error.code, message: error.message },
          executable: pathEvidence(executable),
        });
        return Object.assign({ reusable: false }, this._setSlotState(slotId, SLOT_STATES.RELEASABLE_BUT_BUSY, {
          ownership: 'RELEASED',
          reclamation: 'BUSY',
          reason: error && error.code === 'EBUSY'
            ? 'shared hard-linked bytes remain mapped'
            : 'Filesystem reclamation is currently blocked.',
          errorCode: error && error.code || '',
          reservation: 'NONE',
        }));
      }
    }
    const removed = this._removeTree(directory);
    if (!removed) this.logger.warn(`Legacy compatibility slot ${slotId} could not be reclaimed because files remain in use.`);
    this.forensic('clone_reclaim', {
      slotId,
      directory,
      outcome: removed ? 'REMOVED' : 'REMOVE_FAILED',
      remainingTree: present(directory) ? treeEvidence(directory) : [],
    });
    if (removed) {
      return Object.assign({ reusable: true }, this._setSlotState(slotId, SLOT_STATES.FREE, {
        ownership: 'RELEASED',
        reclamation: 'REMOVED',
        reason: 'The released slot was reclaimed safely.',
        reservation: 'NONE',
      }));
    }
    return Object.assign({ reusable: false }, this._setSlotState(slotId, SLOT_STATES.RELEASABLE_BUT_BUSY, {
      ownership: 'RELEASED',
      reclamation: 'BUSY',
      reason: 'Filesystem reclamation is currently blocked.',
      reservation: 'NONE',
    }));
  }

  _build(slotId, versionDirectory, trace) {
    if (trace) trace.buildCount += 1;
    const slotDirectory = this._slotPath(slotId);
    const sourceDirectory = fs.realpathSync(versionDirectory);
    this.forensic('clone_build_start', {
      trace,
      slotId,
      slotDirectory: pathEvidence(slotDirectory),
      sourceDirectory: pathEvidence(sourceDirectory),
    });
    fs.mkdirSync(slotDirectory, { recursive: true });
    let linked = 0;
    let copied = 0;
    let junctioned = 0;
    let directoryShells = 0;
    const shareFile = (source, destination) => {
      try { fs.linkSync(source, destination); linked += 1; }
      catch (_) { fs.copyFileSync(source, destination); copied += 1; }
    };
    const shareDirectory = (source, destination) => {
      fs.symlinkSync(source, destination, 'junction');
      junctioned += 1;
    };
    try {
      for (const entry of fs.readdirSync(sourceDirectory, { withFileTypes: true })) {
        const source = path.join(sourceDirectory, entry.name);
        const destination = path.join(slotDirectory, entry.name);
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          let target = source;
          if (entry.isSymbolicLink()) {
            try {
              const real = fs.realpathSync(source);
              if (fs.statSync(real).isFile()) {
                shareFile(real, destination);
                continue;
              }
              target = real;
            } catch (_) {}
          }
          // Current Roblox rejects `content` itself when it is a reparse
          // point even though ordinary Windows and Node directory traversal
          // succeed. Preserve sharing below that boundary: make only the
          // content root a real directory, then mirror its immediate entries
          // with the same hard-link/junction policy.
          if (entry.name.toLowerCase() === 'content' && fs.statSync(target).isDirectory()) {
            fs.mkdirSync(destination);
            directoryShells += 1;
            for (const child of fs.readdirSync(target, { withFileTypes: true })) {
              const childSource = path.join(target, child.name);
              const childDestination = path.join(destination, child.name);
              if (child.isDirectory()) shareDirectory(childSource, childDestination);
              else if (child.isFile()) shareFile(childSource, childDestination);
              else if (child.isSymbolicLink()) {
                const childReal = fs.realpathSync(childSource);
                if (fs.statSync(childReal).isDirectory()) shareDirectory(childReal, childDestination);
                else if (fs.statSync(childReal).isFile()) shareFile(childReal, childDestination);
                else throw new Error(`Unsupported content entry type (${child.name}).`);
              } else throw new Error(`Unsupported content entry type (${child.name}).`);
            }
          } else shareDirectory(target, destination);
        } else if (entry.isFile()) {
          shareFile(source, destination);
        }
      }
    } catch (error) {
      this._removeTree(slotDirectory);
      throw error;
    }
    let validation;
    try { validation = this._validate(slotDirectory, sourceDirectory, trace); }
    catch (error) {
      this._removeTree(slotDirectory);
      throw error;
    }
    this.logger.info(`LEGACY COMPATIBILITY: prepared and validated ${slotId} (${linked} linked files, ${copied} copied files, ${junctioned} shared folders, ${directoryShells} directory shells).`);
    const executablePath = path.join(slotDirectory, PLAYER_EXE);
    const launchExecutablePath = fs.realpathSync.native(executablePath);
    const launchContentPath = path.join(path.dirname(launchExecutablePath), 'content');
    if (!fs.statSync(launchContentPath).isDirectory()) {
      throw new Error('Legacy clone validation failed: canonical launch content is not an accessible directory.');
    }
    this.forensic('clone_build_complete', {
      trace,
      slotId,
      linked,
      copied,
      junctioned,
      directoryShells,
      slotDirectory: pathEvidence(slotDirectory),
      content: pathEvidence(path.join(slotDirectory, 'content')),
      contentTraversal: directoryTraversalEvidence(path.join(slotDirectory, 'content')),
      contentTree: treeEvidence(path.join(slotDirectory, 'content')),
      tree: treeEvidence(slotDirectory),
    });
    return {
      slotId,
      directory: slotDirectory,
      executablePath,
      launchExecutablePath,
      validation,
    };
  }

  _validate(slotDirectory, versionDirectory, trace) {
    if (trace) trace.validationCount += 1;
    const slotRoot = path.resolve(slotDirectory);
    const rootPrefix = slotRoot.endsWith(path.sep) ? slotRoot : slotRoot + path.sep;
    const canonicalSlotRoot = fs.realpathSync.native(slotRoot);
    const sourceEntries = fs.readdirSync(versionDirectory, { withFileTypes: true });
    const generatedNames = fs.readdirSync(slotDirectory).sort();
    const sourceNames = sourceEntries.map(entry => entry.name).sort();
    if (JSON.stringify(generatedNames) !== JSON.stringify(sourceNames)) {
      throw new Error('Legacy clone validation failed: top-level entries differ from the Roblox version directory.');
    }
    const evidence = [];
    for (const entry of sourceEntries) {
      const source = path.join(versionDirectory, entry.name);
      const destination = path.join(slotDirectory, entry.name);
      const resolvedDestination = path.resolve(destination);
      if (!resolvedDestination.startsWith(rootPrefix)) {
        throw new Error(`Legacy clone validation failed: generated path escaped the instance root (${entry.name}).`);
      }
      let sourceReal;
      let sourceStat;
      let destinationLstat;
      let destinationStat;
      let destinationReal;
      try {
        sourceReal = fs.realpathSync(source);
        sourceStat = fs.statSync(source);
        destinationLstat = fs.lstatSync(destination);
        destinationStat = fs.statSync(destination);
        destinationReal = fs.realpathSync(destination);
      } catch (error) {
        throw new Error(`Legacy clone validation failed: ${entry.name} is missing or inaccessible (${error.code || error.message}).`);
      }
      if (sourceStat.isDirectory()) {
        if (entry.name.toLowerCase() === 'content') {
          if (destinationLstat.isSymbolicLink() || !destinationStat.isDirectory()) {
            throw new Error('Legacy clone validation failed: content must be a local directory shell, not a reparse point.');
          }
          const sourceChildren = fs.readdirSync(sourceReal).sort();
          const generatedChildren = fs.readdirSync(destination).sort();
          if (JSON.stringify(sourceChildren) !== JSON.stringify(generatedChildren)) {
            throw new Error('Legacy clone validation failed: content directory entries differ from the source.');
          }
          for (const childName of sourceChildren) {
            const sourceChild = path.join(sourceReal, childName);
            const destinationChild = path.join(destination, childName);
            const sourceChildReal = fs.realpathSync(sourceChild);
            const sourceChildStat = fs.statSync(sourceChild);
            const destinationChildLstat = fs.lstatSync(destinationChild);
            const destinationChildStat = fs.statSync(destinationChild);
            const destinationChildReal = fs.realpathSync(destinationChild);
            if (sourceChildStat.isDirectory()) {
              if (!destinationChildLstat.isSymbolicLink() || !destinationChildStat.isDirectory()
                  || normalize(destinationChildReal) !== normalize(sourceChildReal)) {
                throw new Error(`Legacy clone validation failed: content/${childName} is not the intended directory junction.`);
              }
            } else if (sourceChildStat.isFile()) {
              const insideLogicalContent = normalize(destinationChildReal).startsWith(normalize(destination) + '\\');
              const insideCanonicalContent = normalize(destinationChildReal).startsWith(normalize(fs.realpathSync.native(destination)) + '\\');
              if (destinationChildLstat.isSymbolicLink() || !destinationChildStat.isFile()
                  || (!insideLogicalContent && !insideCanonicalContent)) {
                throw new Error(`Legacy clone validation failed: content/${childName} is not a local regular file.`);
              }
            } else throw new Error(`Legacy clone validation failed: unsupported content entry type (${childName}).`);
          }
        } else {
          if (!destinationLstat.isSymbolicLink() || !destinationStat.isDirectory()) {
            throw new Error(`Legacy clone validation failed: ${entry.name} is not an accessible directory junction.`);
          }
          if (normalize(destinationReal) !== normalize(sourceReal)) {
            throw new Error(`Legacy clone validation failed: ${entry.name} junction target differs from the source directory.`);
          }
        }
      } else if (sourceStat.isFile()) {
        if (destinationLstat.isSymbolicLink() || !destinationStat.isFile()) {
          throw new Error(`Legacy clone validation failed: ${entry.name} is not a local regular file.`);
        }
        const insideLogicalRoot = normalize(destinationReal).startsWith(normalize(slotRoot) + '\\');
        const insideCanonicalRoot = normalize(destinationReal).startsWith(normalize(canonicalSlotRoot) + '\\');
        if (!insideLogicalRoot && !insideCanonicalRoot) {
          throw new Error(`Legacy clone validation failed: ${entry.name} escaped the instance root.`);
        }
      } else {
        throw new Error(`Legacy clone validation failed: unsupported source entry type (${entry.name}).`);
      }
      evidence.push({
        name: entry.name,
        sourceType: sourceStat.isDirectory() ? 'directory' : 'file',
        generatedType: destinationLstat.isSymbolicLink()
          ? 'junction'
          : (destinationStat.isDirectory() ? (entry.name.toLowerCase() === 'content' ? 'directory-shell' : 'directory') : 'file'),
        realpath: destinationReal,
        sharedTarget: destinationLstat.isSymbolicLink() ? destinationReal : null,
      });
    }
    const player = path.join(slotDirectory, PLAYER_EXE);
    if (!fs.existsSync(player) || !fs.statSync(player).isFile()) {
      throw new Error(`Legacy clone validation failed: ${PLAYER_EXE} is missing.`);
    }
    const content = path.join(slotDirectory, 'content');
    try {
      if (!fs.existsSync(content) || !fs.statSync(content).isDirectory()) {
        throw new Error('content is not an accessible directory.');
      }
    } catch (error) {
      throw new Error(`Legacy clone validation failed: content is not an accessible directory (${error.code || error.message}).`);
    }
    return { ok: true, slotRoot, canonicalSlotRoot, entries: evidence };
  }

  validateSlot(slotId, versionDirectory) {
    return this._validate(this._slotPath(slotId), fs.realpathSync(versionDirectory));
  }

  sweep(liveRows, ownedSlots) {
    this._refreshOwnedStates(ownedSlots);
    const results = [];
    for (let index = 1; index <= this.maxPhysicalSlots; index += 1) {
      const slotId = `instance-${index}`;
      if (this.reserved.has(slotId)) continue;
      results.push(this.reclaim(slotId, liveRows, ownedSlots));
    }
    return results;
  }

  acquire(versionDirectory, liveRows, trace, ownedSlots) {
    this.forensic('clone_acquire_start', {
      trace,
      root: pathEvidence(this.root),
      versionDirectory: pathEvidence(versionDirectory),
      reserved: Array.from(this.reserved),
      liveRows: Array.isArray(liveRows) ? liveRows : null,
      ownedSlots: ownedSlots instanceof Map ? Array.from(ownedSlots.entries()) : null,
    });
    this._refreshOwnedStates(ownedSlots);
    if (this.reserved.size >= this.maxConcurrentSlots) {
      throw new Error('SUNDAY Launcher legacy compatibility already has three active or in-flight client slots.');
    }
    // All top-level files are hard links. A client running from one slot can
    // therefore make the write-lock probe fail through every stale slot name.
    // Reclaim stale, unreserved slots before the first live launch, while the
    // lock probe can still distinguish a genuinely occupied clone.
    if (Array.isArray(liveRows) && liveRows.length === 0 && this.reserved.size === 0) {
      this.sweep(liveRows, ownedSlots);
    }
    for (let index = 1; index <= this.maxPhysicalSlots; index += 1) {
      const slotId = `instance-${index}`;
      if (this.reserved.has(slotId)) {
        this.forensic('clone_slot_decision', {
          trace,
          slotId,
          decision: 'SKIP_RESERVED',
          slotState: this.getSlotState(slotId),
        });
        continue;
      }
      const reclaim = this.reclaim(slotId, liveRows, ownedSlots);
      if (!reclaim.reusable) {
        this.forensic('clone_slot_decision', {
          trace,
          slotId,
          decision: reclaim.state === SLOT_STATES.OCCUPIED ? 'SKIP_OCCUPIED' : 'SKIP_RELEASABLE_BUT_BUSY',
          slotState: reclaim,
        });
        continue;
      }
      this.forensic('clone_slot_decision', { trace, slotId, decision: 'BUILD', slotState: reclaim });
      const built = this._build(slotId, versionDirectory, trace);
      this.reserved.add(slotId);
      this._setSlotState(slotId, SLOT_STATES.FREE, {
        ownership: 'RELEASED',
        reclamation: 'READY',
        reason: 'The slot was built and validated for one in-flight launch.',
        reservation: 'RESERVED_FOR_LAUNCH',
      });
      return built;
    }
    throw new Error('No safe legacy compatibility slot is available; active slots remain owned and released slots remain busy.');
  }

  release(slotId, liveRows, ownedSlots) {
    if (!this.reserved.has(slotId)) return { ok: false, released: false, reason: 'Unknown legacy compatibility slot.' };
    const reclaimed = this.reclaim(slotId, liveRows, ownedSlots);
    if (reclaimed.state === SLOT_STATES.OCCUPIED) {
      return { ok: false, released: false, reason: 'A current SUNDAY Launcher capability still proves that the Roblox process owns this slot.' };
    }
    this.reserved.delete(slotId);
    if (reclaimed.state === SLOT_STATES.RELEASABLE_BUT_BUSY) {
      return {
        ok: true,
        released: true,
        deferredReclaim: true,
        slotState: reclaimed,
        reason: 'Owned process exited; clone reclamation is deferred until shared hard-linked files are no longer mapped by a sibling.',
      };
    }
    if (Array.isArray(liveRows) && liveRows.length === 0) {
      this.sweep(liveRows, ownedSlots);
    }
    return { ok: true, released: true, deferredReclaim: false, slotState: reclaimed };
  }
}

class LegacyRobloxIsolationAdapter extends RobloxIsolationAdapter {
  constructor(options) {
    super();
    const opts = options || {};
    this.logger = opts.logger || { info() {}, warn() {}, error() {} };
    this.native = opts.nativeApi || require('./native');
    this.legacyNative = opts.legacyNativeApi || require('./legacy-roblox-native');
    this.processCapabilities = opts.processCapabilities;
    this.ownerId = String(opts.ownerId || '');
    this.monitor = opts.monitor || null;
    this.locateRoblox = opts.locateRoblox || (() => ({ found: false }));
    this.spawnProcess = opts.spawnProcess || ((executable, args) => spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    }));
    this.forensicPath = String(opts.forensicPath || '');
    this.cloneManager = opts.cloneManager || new LegacyCloneManager({
      root: opts.cloneRoot,
      logger: this.logger,
      forensic: (event, payload) => this._forensic(event, payload),
    });
    if (!this.processCapabilities) throw new Error('LegacyRobloxIsolationAdapter requires a ProcessCapabilityRegistry.');
    if (!this.ownerId) throw new Error('LegacyRobloxIsolationAdapter requires a SUNDAY Launcher owner ID.');
    this.pollMs = Math.max(10, Number(opts.pollMs) || 750);
    this.stableSamples = Math.max(1, Number(opts.stableSamples) || 4);
    this.launchTimeoutMs = Math.max(100, Number(opts.launchTimeoutMs) || 60000);
    this.releaseTimeoutMs = Math.max(1000, Number(opts.releaseTimeoutMs) || 30000);
    this.requireWindow = opts.requireWindow !== false;
    this.environments = new Map();
    this.capabilityToEnvironment = new Map();
    this.guardSeen = new Map();
    this.externalAtStartup = new Map();
    this.guardTimer = null;
    this.guardBusy = false;
    this.lastContestedSweep = 0;
    this.closedHandles = 0;
    this.crossProcessActions = [];
    this.lastFailure = null;
    this._forensic('adapter_started', {
      pid: process.pid,
      cwd: process.cwd(),
      cloneRoot: pathEvidence(this.cloneManager.root),
      source: process.execPath,
    });
    this._recordStartupProcesses();
  }

  _forensic(event, payload) {
    if (!this.forensicPath) return;
    try {
      fs.mkdirSync(path.dirname(this.forensicPath), { recursive: true });
      fs.appendFileSync(this.forensicPath, JSON.stringify({
        at: new Date().toISOString(),
        event,
        pid: process.pid,
        payload: payload || {},
      }) + '\n', 'utf8');
    } catch (error) {
      this.logger.warn('Phase 7 forensic capture failed: ' + error.message);
    }
  }

  _rows() {
    try {
      const rows = this.native.listProcesses(PLAYER_EXE);
      return Array.isArray(rows) ? rows : [];
    } catch (_) { return []; }
  }

  _ownedSlotEvidence(liveRows) {
    const rows = Array.isArray(liveRows) ? liveRows : this._rows();
    const owned = new Map();
    for (const environment of this.environments.values()) {
      if (environment.state !== 'RUNNING' || !environment.capability || !environment.pid) continue;
      if (this.capabilityToEnvironment.get(environment.capability) !== environment.environmentId) continue;
      const authorized = this.processCapabilities.authorize(environment.capability, 'observe', this.ownerId);
      if (!authorized.ok) continue;
      const record = authorized.record;
      const row = rows.find(item => Number(item.pid) === Number(record.pid));
      if (!row) continue;
      if (record.instanceId !== environment.instanceId || record.slotId !== environment.slotId
          || Number(record.pid) !== Number(environment.pid)
          || record.processIdentity !== environment.processIdentity
          || String(row.processIdentity || '') !== record.processIdentity
          || normalize(row.executablePath) !== normalize(record.executablePath)
          || normalize(environment.executablePath) !== normalize(record.executablePath)) continue;
      owned.set(environment.slotId, Object.freeze({
        operationId: environment.operationId,
        instanceId: environment.instanceId,
        pid: Number(record.pid),
        processIdentity: record.processIdentity,
        executablePath: record.executablePath,
        capability: environment.capability,
      }));
    }
    return owned;
  }

  _identity(row) {
    return `${Number(row && row.pid) || 0}:${String(row && row.processIdentity || '')}:${normalize(row && row.executablePath)}`;
  }

  _recordStartupProcesses() {
    for (const row of this._rows()) this.externalAtStartup.set(this._identity(row), Object.freeze({
      pid: Number(row.pid),
      processIdentity: String(row.processIdentity || ''),
      executablePath: String(row.executablePath || ''),
      ownership: 'EXTERNAL',
    }));
  }

  _managedIdentitySet() {
    const managed = new Set();
    for (const environment of this.environments.values()) {
      if (environment.pid && environment.processIdentity) {
        managed.add(`${environment.pid}:${environment.processIdentity}:${normalize(environment.executablePath)}`);
      }
      if (environment.spawnPid) managed.add(`pid:${environment.spawnPid}`);
    }
    return managed;
  }

  _recordCrossProcessAction(rows, reason) {
    if (!rows.length) return;
    const action = {
      at: new Date().toISOString(),
      label: 'LEGACY CROSS-PROCESS COMPATIBILITY ACTION',
      reason,
      processes: rows.map(row => ({
        pid: Number(row.pid),
        processIdentity: String(row.processIdentity || ''),
        executablePath: String(row.executablePath || ''),
        ownership: 'EXTERNAL',
      })),
    };
    this.crossProcessActions.push(action);
    if (this.crossProcessActions.length > 100) this.crossProcessActions.shift();
    this.logger.warn(`${action.label}: ${reason}; external PIDs ${action.processes.map(item => item.pid).join(', ')}.`);
  }

  async _guardTick(forceContested) {
    if (this.guardBusy) return;
    this.guardBusy = true;
    try {
      const hold = this.legacyNative.acquireSingletonNames();
      const rows = this._rows();
      const managed = this._managedIdentitySet();
      const now = Date.now();
      const live = new Set(rows.map(row => this._identity(row)));
      for (const key of Array.from(this.guardSeen.keys())) if (!live.has(key)) this.guardSeen.delete(key);
      const due = [];
      for (const row of rows) {
        const key = this._identity(row);
        let seen = this.guardSeen.get(key);
        if (!seen) {
          seen = { at: now, passes: 0, row };
          this.guardSeen.set(key, seen);
        }
        const age = now - seen.at;
        if (seen.passes === 0 && age >= 3000) { seen.passes = 1; due.push(row); }
        else if (seen.passes === 1 && age >= 8000) { seen.passes = 2; due.push(row); }
      }
      if (due.length) this._stripRows(due, managed, 'timed singleton compatibility pass');
      if (!hold.ok && rows.length && (forceContested || now - this.lastContestedSweep >= 1500)) {
        this.lastContestedSweep = now;
        this._stripRows(rows, managed, 'singleton ownership was contested');
        this.legacyNative.acquireSingletonNames();
      }
    } finally {
      this.guardBusy = false;
    }
  }

  _stripRows(rows, managed, reason) {
    const external = rows.filter(row => !managed.has(this._identity(row)) && !managed.has(`pid:${Number(row.pid)}`));
    this._recordCrossProcessAction(external, reason);
    const outcome = this.legacyNative.closeGlobalSingletonHandles(rows.map(row => row.pid));
    if (outcome && outcome.closed) {
      this.closedHandles += outcome.closed;
      this.logger.info(`LEGACY COMPATIBILITY: closed ${outcome.closed} exact Roblox global singleton handle(s).`);
    }
  }

  _startGuard() {
    if (this.guardTimer) return;
    this._guardTick(true).catch(error => this.logger.warn('Legacy singleton guard failed: ' + error.message));
    this.guardTimer = setInterval(() => {
      this._guardTick(false).catch(error => this.logger.warn('Legacy singleton guard failed: ' + error.message));
    }, 250);
    if (this.guardTimer.unref) this.guardTimer.unref();
  }

  async preflight() {
    if (process.platform !== 'win32') return result(ISOLATION_STATES.UNAVAILABLE, 'Legacy compatibility is Windows-only.');
    if (!this.native.isAvailable() || !this.legacyNative.isAvailable()) {
      return result(ISOLATION_STATES.UNAVAILABLE, this.legacyNative.getLoadError() || this.native.getLoadError() || 'Required Win32 bindings are unavailable.');
    }
    const located = this.locateRoblox();
    if (located && located.found && located.legacyCompatible === false) {
      return result(ISOLATION_STATES.UNAVAILABLE, located.compatibilityReason || 'This Roblox installation is not compatible with legacy multi-instance mode.');
    }
    if (!located || !located.found || !located.playerPath) {
      return result(ISOLATION_STATES.UNAVAILABLE, 'Roblox Player was not found for legacy compatibility mode.');
    }
    this._startGuard();
    const deadline = Date.now() + 7000;
    while (!this.legacyNative.singletonNamesOwned() && Date.now() < deadline) {
      await this._guardTick(true);
      if (!this.legacyNative.singletonNamesOwned()) await delay(100);
    }
    if (!this.legacyNative.singletonNamesOwned()) {
      return result(ISOLATION_STATES.UNAVAILABLE, 'Legacy compatibility could not own the Roblox singleton names; no client was launched.');
    }
    return result(ISOLATION_STATES.LEGACY_COMPAT, LEGACY_REASON, { mode: 'LEGACY_COMPAT', qualified: false });
  }

  _reclaimExitedEnvironments() {
    const liveRows = this._rows();
    const ownedSlots = this._ownedSlotEvidence(liveRows);
    for (const [environmentId, environment] of Array.from(this.environments.entries())) {
      if (!['EXITED', 'STOPPED', 'FAILED'].includes(environment.state)) continue;
      const released = this.cloneManager.release(environment.slotId, liveRows, ownedSlots);
      if (released && released.released) this.environments.delete(environmentId);
    }
  }

  async allocateInstance(operation) {
    this._reclaimExitedEnvironments();
    const located = this.locateRoblox();
    if (located && located.found && located.legacyCompatible === false) {
      return result(ISOLATION_STATES.UNAVAILABLE, located.compatibilityReason || 'This Roblox installation is not compatible with legacy multi-instance mode.');
    }
    if (!located || !located.found || !located.playerPath) {
      return result(ISOLATION_STATES.UNAVAILABLE, 'Roblox Player was not found.');
    }
    try {
      const environmentId = `legacy-${crypto.randomUUID()}`;
      const trace = {
        allocationId: environmentId,
        operationId: String(operation && operation.operationId || ''),
        instanceId: null,
        allocationCount: 1,
        buildCount: 0,
        validationCount: 0,
        launchCount: 0,
      };
      const liveRows = this._rows();
      const ownedSlots = this._ownedSlotEvidence(liveRows);
      this._forensic('allocation_start', {
        trace,
        cwd: process.cwd(),
        playerPath: pathEvidence(located.playerPath),
        liveRows,
        ownedSlots: Array.from(ownedSlots.entries()),
        environments: Array.from(this.environments.values()).map(item => ({
          environmentId: item.environmentId,
          slotId: item.slotId,
          state: item.state,
          pid: item.pid,
        })),
      });
      const slot = this.cloneManager.acquire(path.dirname(located.playerPath), liveRows, trace, ownedSlots);
      trace.instanceId = slot.slotId;
      this.environments.set(environmentId, {
        environmentId,
        slotId: slot.slotId,
        executablePath: slot.executablePath,
        launchExecutablePath: slot.launchExecutablePath || slot.executablePath,
        sourcePlayerPath: located.playerPath,
        operationId: String(operation && operation.operationId || ''),
        accountId: String(operation && operation.accountId || ''),
        instanceId: slot.slotId,
        state: 'ALLOCATED',
        pid: null,
        processIdentity: '',
        capability: null,
        trace,
      });
      this._forensic('allocation_complete', { trace, environmentId, slot });
      return result(ISOLATION_STATES.LEGACY_COMPAT, LEGACY_REASON, {
        environmentId,
        instanceId: slot.slotId,
        mode: 'LEGACY_COMPAT',
        qualified: false,
      });
    } catch (error) {
      this.lastFailure = Object.freeze(Object.assign({ at: new Date().toISOString() }, sanitizedLegacyFailure(error.message, 'allocation')));
      return result(ISOLATION_STATES.LEGACY_COMPAT, error.message, {
        ok: false, mode: 'LEGACY_COMPAT', failureCode: this.lastFailure.code, failureStage: this.lastFailure.stage,
      });
    }
  }

  _environment(environmentId) {
    const environment = this.environments.get(String(environmentId || ''));
    if (!environment) throw new Error('No SUNDAY-owned legacy environment matches this operation.');
    return environment;
  }

  async _waitForStable(environment, initialIdentities, signal) {
    const deadline = Date.now() + this.launchTimeoutMs;
    let candidate = null;
    let consecutive = 0;
    while (Date.now() < deadline) {
      if (signal && signal.aborted) throw signal.reason || new Error('Launch cancelled.');
      const matches = this._rows().filter(row => row.processIdentity
        && !initialIdentities.has(this._identity(row))
        && (Number(row.pid) === Number(environment.spawnPid)
          || normalize(row.executablePath) === normalize(environment.launchExecutablePath)
          || normalize(row.executablePath) === normalize(environment.executablePath)));
      const row = matches.find(item => candidate && this._identity(item) === candidate)
        || matches.find(item => Number(item.pid) === Number(environment.spawnPid))
        || matches[0];
      if (!row) {
        candidate = null;
        consecutive = 0;
        await delay(this.pollMs, signal);
        continue;
      }
      const identity = this._identity(row);
      if (identity === candidate) consecutive += 1;
      else { candidate = identity; consecutive = 1; }
      let windowReady = !this.requireWindow;
      let windowEvidence = null;
      if (this.requireWindow && typeof this.native.windowInfoForPids === 'function') {
        const windows = this.native.windowInfoForPids([row.pid]);
        const window = windows && windows.get(Number(row.pid));
        windowEvidence = window || null;
        if (window && String(window.className || '').toLowerCase() === '#32770') {
          this._forensic('launch_startup_error_dialog', {
            trace: environment.trace,
            candidate: row,
            window,
          });
          throw new Error(`Roblox opened a startup error dialog${window.title ? ` (${window.title})` : ''}; launch was not marked RUNNING.`);
        }
        windowReady = !!(window
          && window.responding !== false
          && String(window.className || '').toUpperCase() === 'WINDOWSCLIENT');
      }
      this._forensic('launch_stability_sample', {
        trace: environment.trace,
        candidate: row,
        consecutive,
        windowReady,
        window: windowEvidence,
      });
      if (consecutive >= this.stableSamples && windowReady) {
        environment.acceptedWindow = windowEvidence;
        return row;
      }
      await delay(this.pollMs, signal);
    }
    throw new Error('Roblox did not reach a stable running window before the legacy launch timeout.');
  }

  async _launchInEnvironment(rawIntent, environment, context) {
    const intent = rawIntent || {};
    environment.state = 'STARTING';
    const args = [];
    if (intent.mode !== 'client') {
      const launchUri = String(intent.launchUri || '');
      if (!/^roblox-player:/i.test(launchUri)) throw new Error('A fresh Roblox launch URI is required.');
      args.push(launchUri);
    }
    environment.trace.launchCount += 1;
    const logicalExecutable = environment.launchExecutablePath;
    let canonicalExecutable = '';
    try { canonicalExecutable = fs.realpathSync.native(logicalExecutable); } catch (_) {}
    const cloneContent = path.join(path.dirname(logicalExecutable), 'content');
    this._forensic('launch_spawn_request', {
      trace: environment.trace,
      cwd: process.cwd(),
      launchArguments: {
        count: args.length,
        mode: intent.mode === 'client' ? 'client' : 'deeplink',
        hasLaunchUri: args.length === 1,
      },
      logicalExecutable: pathEvidence(logicalExecutable),
      canonicalExecutable,
      cloneDirectory: pathEvidence(path.dirname(logicalExecutable)),
      cloneContent: pathEvidence(cloneContent),
      cloneContentTraversal: directoryTraversalEvidence(cloneContent),
      cloneContentPowerShell: windowsShellEvidence(cloneContent),
      cloneTree: treeEvidence(path.dirname(logicalExecutable)),
      sourceDirectory: pathEvidence(path.dirname(environment.sourcePlayerPath)),
      sourceContent: pathEvidence(path.join(path.dirname(environment.sourcePlayerPath), 'content')),
      sourceContentPowerShell: windowsShellEvidence(path.join(path.dirname(environment.sourcePlayerPath), 'content')),
    });
    const initialIdentities = new Set(this._rows().map(row => this._identity(row)));
    const child = this.spawnProcess(environment.launchExecutablePath, args);
    if (!child || !Number.isInteger(Number(child.pid)) || Number(child.pid) <= 0) throw new Error('Roblox process creation did not return a PID.');
    environment.spawnPid = Number(child.pid);
    environment.state = 'LAUNCHING';
    if (typeof child.on === 'function') {
      environment.spawnChild = child;
      environment.spawnExitPromise = new Promise(resolve => {
        child.once('exit', (code, signal) => {
          environment.spawnChild = null;
          resolve({ code, signal });
        });
      });
    }
    const spawnFingerprint = typeof this.native.processFingerprintOf === 'function'
      ? this.native.processFingerprintOf(environment.spawnPid)
      : null;
    environment.spawnFingerprint = spawnFingerprint;
    this._forensic('launch_spawned', {
      trace: environment.trace,
      spawnPid: environment.spawnPid,
      fingerprint: spawnFingerprint,
    });
    if (typeof child.once === 'function') child.once('error', error => {
      environment.spawnError = (error && error.message) || String(error);
    });
    if (typeof child.unref === 'function') child.unref();
    await this._guardTick(false);
    const row = await this._waitForStable(environment, initialIdentities, context && context.signal);
    if (environment.spawnError) throw new Error(environment.spawnError);
    // Windows package virtualization can rewrite the logical AppData clone
    // path. Launch and process capabilities both bind the canonical path
    // reported by the OS; the logical path remains diagnostic evidence.
    environment.executablePath = String(row.executablePath || environment.launchExecutablePath);
    const capability = this.processCapabilities.issue(row.pid, {
      executablePath: environment.executablePath,
      ownerId: this.ownerId,
      instanceId: environment.instanceId,
      accountId: environment.accountId,
      profileName: String(intent.profileName || environment.accountId || environment.instanceId),
      slotId: environment.slotId,
    });
    environment.pid = Number(row.pid);
    environment.processIdentity = String(row.processIdentity || this.native.processIdentityOf(row.pid) || '');
    environment.capability = capability;
    environment.state = 'RUNNING';
    this.lastFailure = null;
    environment.startedAt = new Date().toISOString();
    this._forensic('launch_marked_running', {
      trace: environment.trace,
      spawnPid: environment.spawnPid,
      pid: environment.pid,
      processIdentity: environment.processIdentity,
      executablePath: environment.executablePath,
      acceptedWindow: environment.acceptedWindow || null,
    });
    this.capabilityToEnvironment.set(capability, environment.environmentId);
    if (typeof this.cloneManager.markOccupied === 'function') {
      this.cloneManager.markOccupied(environment.slotId, {
        operationId: environment.operationId,
        instanceId: environment.instanceId,
        pid: environment.pid,
        processIdentity: environment.processIdentity,
        executablePath: environment.executablePath,
        capability,
      });
    }
    if (this.monitor) this.monitor.markManaged(environment.pid, {
      profileName: String(intent.profileName || environment.accountId || environment.instanceId),
      mode: intent.mode === 'client' ? 'client' : 'deeplink',
      playerPath: environment.sourcePlayerPath,
      exePath: environment.executablePath,
      accountId: environment.accountId,
      capability,
      instanceId: environment.instanceId,
      operationId: environment.operationId,
      processIdentity: environment.processIdentity,
    });
    return result(ISOLATION_STATES.LEGACY_COMPAT, LEGACY_REASON, {
      capability,
      pid: environment.pid,
      stable: true,
      status: 'RUNNING',
      instanceId: environment.instanceId,
      mode: 'LEGACY_COMPAT',
      qualified: false,
    });
  }

  async launch(rawIntent, context) {
    const environment = this._environment(context && context.environmentId);
    if (environment.state !== 'ALLOCATED') return result(ISOLATION_STATES.LEGACY_COMPAT, 'Legacy environment is not launchable.', { ok: false });
    try { return await this._launchInEnvironment(rawIntent, environment, context); }
    catch (error) {
      environment.state = 'FAILED';
      this.lastFailure = Object.freeze(Object.assign({ at: new Date().toISOString() }, sanitizedLegacyFailure(error.message, 'launch')));
      let cleanup = null;
      if (environment.spawnPid && environment.spawnFingerprint
          && environment.spawnFingerprint.processIdentity
          && environment.spawnFingerprint.executablePath) {
        cleanup = this.native.terminateOwned(Object.assign({ pid: environment.spawnPid }, environment.spawnFingerprint));
      }
      this._forensic('launch_failed', {
        trace: environment.trace,
        spawnPid: environment.spawnPid || null,
        message: error.message,
        cleanup,
      });
      return result(ISOLATION_STATES.LEGACY_COMPAT, error.message, {
        ok: false, status: 'FAILED', failureCode: this.lastFailure.code, failureStage: this.lastFailure.stage,
      });
    }
  }

  _ownedEnvironment(capability) {
    const environmentId = this.capabilityToEnvironment.get(String(capability || ''));
    const environment = environmentId && this.environments.get(environmentId);
    if (!environment || environment.capability !== String(capability || '')) return null;
    return environment;
  }

  async observe(capability) {
    const environment = this._ownedEnvironment(capability);
    if (!environment) return result(ISOLATION_STATES.LEGACY_COMPAT, 'Unknown legacy process capability.', { ok: false, status: 'UNKNOWN' });
    const rows = this._rows();
    const byPid = rows.find(row => Number(row.pid) === environment.pid);
    if (!byPid) {
      environment.state = 'EXITED';
      this.processCapabilities.revoke(capability, 'Owned Roblox process exit was confirmed.');
      return result(ISOLATION_STATES.LEGACY_COMPAT, 'Owned Roblox process exit was confirmed.', { status: 'EXITED', confirmed: true, ownership: 'OWNED' });
    }
    if (String(byPid.processIdentity || '') !== environment.processIdentity
        || normalize(byPid.executablePath) !== normalize(environment.executablePath)) {
      environment.state = 'UNKNOWN';
      return result(ISOLATION_STATES.LEGACY_COMPAT, 'PID identity no longer matches the SUNDAY Launcher launch record.', { ok: false, status: 'UNKNOWN' });
    }
    return result(ISOLATION_STATES.LEGACY_COMPAT, LEGACY_REASON, { status: 'RUNNING', pid: environment.pid, stable: true });
  }

  async _waitForExit(environment, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const row = this._rows().find(item => Number(item.pid) === environment.pid);
      if (!row) return true;
      if (String(row.processIdentity || '') !== environment.processIdentity) return false;
      await delay(100);
    }
    return false;
  }

  async stop(capability) {
    const environment = this._ownedEnvironment(capability);
    if (!environment) return result(ISOLATION_STATES.LEGACY_COMPAT, 'Unknown legacy process capability.', { ok: false, confirmed: false });
    const authorized = this.processCapabilities.authorize(capability, 'stop', this.ownerId);
    if (!authorized.ok) return result(ISOLATION_STATES.LEGACY_COMPAT, authorized.reason, { ok: false, confirmed: false });
    const terminated = this.native.terminateOwned(authorized.record);
    if (!terminated || !terminated.ok || !terminated.confirmed) {
      return result(ISOLATION_STATES.LEGACY_COMPAT, terminated && terminated.reason || 'Owned termination was not confirmed.', { ok: false, confirmed: false });
    }
    if (!await this._waitForExit(environment, 7000)) {
      return result(ISOLATION_STATES.LEGACY_COMPAT, 'Termination returned but exact process exit was not confirmed.', { ok: false, confirmed: false });
    }
    if (environment.spawnExitPromise) {
      await Promise.race([environment.spawnExitPromise, delay(5000)]);
      environment.spawnExitPromise = null;
      environment.spawnChild = null;
    }
    this.processCapabilities.revoke(capability, 'Owned Roblox process termination was confirmed.');
    this.capabilityToEnvironment.delete(capability);
    if (this.monitor) this.monitor.forget(environment.pid);
    environment.state = 'STOPPED';
    environment.pid = null;
    environment.processIdentity = '';
    environment.capability = null;
    if (typeof this.cloneManager.markReleased === 'function') {
      this.cloneManager.markReleased(environment.slotId, {
        reclamation: 'PENDING',
        reason: 'Owned process exit was confirmed; no current SUNDAY Launcher capability owns this slot.',
      });
    }
    return result(ISOLATION_STATES.LEGACY_COMPAT, LEGACY_REASON, { confirmed: true, status: 'STOPPED' });
  }

  async restart(rawIntent, context) {
    const environment = this._ownedEnvironment(context && context.capability);
    if (!environment) return result(ISOLATION_STATES.LEGACY_COMPAT, 'Unknown legacy process capability.', { ok: false });
    const stopped = await this.stop(context.capability);
    if (!stopped.ok || !stopped.confirmed) return stopped;
    environment.state = 'ALLOCATED';
    try { return await this._launchInEnvironment(rawIntent, environment, context); }
    catch (error) {
      environment.state = 'FAILED';
      return result(ISOLATION_STATES.LEGACY_COMPAT, error.message, { ok: false, status: 'FAILED' });
    }
  }

  async release(environmentId) {
    const environment = this._environment(environmentId);
    if (environment.state === 'RUNNING') {
      return result(ISOLATION_STATES.LEGACY_COMPAT, 'A live legacy instance directory cannot be released.', { ok: false, released: false });
    }
    let liveRows = this._rows();
    let released = this.cloneManager.release(environment.slotId, liveRows, this._ownedSlotEvidence(liveRows));
    // Windows can retain the executable image mapping briefly after the
    // process object reports signalled. Preserve the directory and retry a
    // bounded number of times; never delete through a live lock.
    const deadline = Date.now() + this.releaseTimeoutMs;
    while (!released.released && Date.now() < deadline) {
      await delay(100);
      liveRows = this._rows();
      released = this.cloneManager.release(environment.slotId, liveRows, this._ownedSlotEvidence(liveRows));
    }
    if (released.released) this.environments.delete(environment.environmentId);
    return result(ISOLATION_STATES.LEGACY_COMPAT, released.reason || LEGACY_REASON, {
      ok: !!released.ok,
      released: !!released.released,
    });
  }

  async health() {
    const running = [];
    for (const environment of this.environments.values()) {
      if (environment.state !== 'RUNNING' || !environment.capability) continue;
      const observed = await this.observe(environment.capability);
      if (observed.status === 'RUNNING') running.push({
        environmentId: environment.environmentId,
        instanceId: environment.instanceId,
        operationId: environment.operationId,
        accountId: environment.accountId,
        pid: environment.pid,
      });
    }
    return result(ISOLATION_STATES.LEGACY_COMPAT, LEGACY_REASON, { running, count: running.length, mode: 'LEGACY_COMPAT', qualified: false });
  }

  async reconcile() {
    const exits = [];
    for (const environment of this.environments.values()) {
      if (environment.state !== 'RUNNING' || !environment.capability) continue;
      const capability = environment.capability;
      const observed = await this.observe(capability);
      if (observed.status === 'EXITED' && observed.confirmed) exits.push({
        accountId: environment.accountId,
        operationId: environment.operationId,
        instanceId: environment.instanceId,
        capability,
        confirmed: true,
        ownership: 'OWNED',
        reason: observed.reason,
      });
    }
    return exits;
  }

  diagnostics() {
    return {
      mode: 'LEGACY_COMPAT',
      qualified: false,
      lastFailure: this.lastFailure,
      singletonNamesOwned: !!this.legacyNative.singletonNamesOwned(),
      closedGlobalSingletonHandles: this.closedHandles,
      externalAtStartup: Array.from(this.externalAtStartup.values()),
      crossProcessActions: this.crossProcessActions.slice(),
      slotStates: typeof this.cloneManager.slotStateSnapshot === 'function'
        ? this.cloneManager.slotStateSnapshot()
        : [],
      environments: Array.from(this.environments.values()).map(environment => ({
        environmentId: environment.environmentId,
        instanceId: environment.instanceId,
        operationId: environment.operationId,
        accountId: environment.accountId,
        state: environment.state,
        pid: environment.pid,
        executablePath: environment.executablePath,
        launchExecutablePath: environment.launchExecutablePath,
      })),
    };
  }

  shutdown() {
    if (this.guardTimer) clearInterval(this.guardTimer);
    this.guardTimer = null;
    // Never terminate or delete live clients during shutdown. The backend
    // process exit releases the named mutexes; stale slots are reclaimed on a
    // later allocation only after process absence is proved.
  }
}

module.exports = {
  LEGACY_REASON,
  SLOT_STATES,
  LegacyCloneManager,
  LegacyRobloxIsolationAdapter,
};
