'use strict';

/**
 * store.js — JSON persistence for settings, profiles and launch history.
 *
 * Files live under the app's userData directory:
 *   settings.json, profiles.json, history.json
 *
 * Writes are durable atomic replacements. Existing legacy documents are read
 * and migrated to a versioned envelope on their next successful write. A
 * malformed/empty/unknown-schema file is uniquely quarantined and surfaced as
 * an error; it is never silently replaced with defaults.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { StateDatabase } = require('./state-database');

const DEFAULT_SETTINGS = Object.freeze({
  robloxPath: '',            // manual override; empty = auto-detect
  robloxInstallationId: '',  // stable, non-path identity for a discovered installation
  autoDetect: true,
  multiInstanceMode: true,   // fresh-install default; explicit false remains disabled
  pollIntervalMs: 2000,      // process monitor refresh
  launchDelayMs: 5000,       // delay between instances so each boots first
  confirmCleanup: true,      // confirm before "End all"
  warnInstanceCount: 6,      // soft warning threshold
  historyLimit: 200,
  autoRejoinDelaySec: 10,    // watchdog: first retry delay, doubles each try
  autoRejoinMaxAttempts: 5,  // watchdog: straight tries with no stable run before giving up
  autoRestartHungSec: 0,     // watchdog: restart a client not responding this long (0 = off)
});

let baseDir = null;
let logger = { info() {}, warn() {}, error() {} };
let stateDb = null;

function configure(dir, log, options) {
  baseDir = dir;
  if (log) logger = log;
  fs.mkdirSync(baseDir, { recursive: true });
  if (stateDb) {
    try { stateDb.close(); } catch (_) {}
  }
  stateDb = new StateDatabase({
    path: path.join(baseDir, 'sunday-state.sqlite3'),
    assertOwner: options && typeof options.assertOwner === 'function' ? options.assertOwner : () => true,
    faultInjector: options && options.faultInjector,
  });
}

function fileFor(name) { return path.join(baseDir, name); }

function ensureConfigured() {
  if (!stateDb) throw new Error('State storage is not configured.');
}

function readLegacyJson(name) {
  const p = fileFor(name);
  if (!fs.existsSync(p)) return { found: false, value: undefined };
  try {
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw || !raw.trim()) throw new Error('The state file is empty.');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Object.prototype.hasOwnProperty.call(parsed, 'schemaVersion')) {
      if (parsed.schemaVersion !== 1 || !Object.prototype.hasOwnProperty.call(parsed, 'data')) {
        throw new Error(`Unsupported state schema version: ${String(parsed.schemaVersion)}`);
      }
      return { found: true, value: parsed.data };
    }
    return { found: true, value: parsed };
  } catch (err) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const quarantine = `${p}.corrupt.${stamp}.${crypto.randomBytes(4).toString('hex')}`;
    try {
      fs.renameSync(p, quarantine);
    } catch (moveErr) {
      const failure = new Error(`Could not read ${name}, and quarantine failed: ${moveErr.message}`);
      failure.code = 'ESTATECORRUPT';
      failure.cause = err;
      throw failure;
    }
    const failure = new Error(`Could not read ${name}; the original was quarantined as ${path.basename(quarantine)}: ${err.message}`);
    failure.code = 'ESTATECORRUPT';
    failure.quarantine = quarantine;
    throw failure;
  }
}

function readJson(name, fallback) {
  ensureConfigured();
  const current = stateDb.get('documents', name, fallback);
  if (current.found) return current.value;
  const legacy = readLegacyJson(name);
  if (!legacy.found) return clone(fallback);
  // The database commit is the ownership event. The legacy source remains
  // intact until the committed record is readable, then becomes a migration
  // backup rather than being silently destroyed.
  stateDb.put('documents', name, legacy.value, { expectedRevision: 0 });
  const p = fileFor(name);
  const backup = `${p}.migrated.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  try { fs.renameSync(p, backup); }
  catch (error) { logger.warn(`Committed ${name} migration but could not archive the legacy source`, error.message); }
  return clone(legacy.value);
}

function writeJson(name, data) {
  ensureConfigured();
  try {
    const current = stateDb.get('documents', name, undefined);
    stateDb.put('documents', name, data, { expectedRevision: current.revision });
    return true;
  } catch (err) {
    logger.error('Failed to write ' + name, err.message);
    const failure = new Error(`Failed to durably write ${name}: ${err.message}`);
    failure.code = err.code || 'ESTATEWRITE';
    failure.cause = err;
    throw failure;
  }
}

function updateJson(name, fallback, mutator) {
  ensureConfigured();
  try {
    const result = stateDb.update('documents', name, fallback, mutator);
    return result.value;
  } catch (err) {
    logger.error('Failed to update ' + name, err.message);
    if (err && err.code) throw err;
    const failure = new Error(`Failed to durably update ${name}: ${err.message}`);
    failure.code = 'ESTATEWRITE';
    failure.cause = err;
    throw failure;
  }
}

function database() {
  ensureConfigured();
  return stateDb;
}

function backupState(destination) {
  ensureConfigured();
  try {
    return stateDb.backupTo(destination);
  } catch (err) {
    logger.error('State backup failed', err.message);
    throw err;
  }
}

function close() {
  if (stateDb) {
    try {
      stateDb.close();
    } finally {
      stateDb = null;
    }
  }
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

/* ----------------------------- Settings ----------------------------- */

function getSettings() {
  const s = readJson('settings.json', DEFAULT_SETTINGS);
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('settings.json has the wrong schema.');
  return normalizeSettings(s);
}

function normalizeSettings(input) {
  const s = Object.assign({}, DEFAULT_SETTINGS, input || {});
  s.robloxPath = typeof s.robloxPath === 'string' ? s.robloxPath : '';
  s.robloxInstallationId = typeof s.robloxInstallationId === 'string' ? s.robloxInstallationId : '';
  s.autoDetect = !!s.autoDetect;
  s.multiInstanceMode = s.multiInstanceMode === true;
  s.confirmCleanup = !!s.confirmCleanup;
  s.pollIntervalMs = clampInt(s.pollIntervalMs, 750, 10000, DEFAULT_SETTINGS.pollIntervalMs);
  s.launchDelayMs = clampInt(s.launchDelayMs, 0, 20000, DEFAULT_SETTINGS.launchDelayMs);
  s.warnInstanceCount = clampInt(s.warnInstanceCount, 1, 100, DEFAULT_SETTINGS.warnInstanceCount);
  s.historyLimit = clampInt(s.historyLimit, 10, 2000, DEFAULT_SETTINGS.historyLimit);
  s.autoRejoinDelaySec = clampInt(s.autoRejoinDelaySec, 3, 300, DEFAULT_SETTINGS.autoRejoinDelaySec);
  s.autoRejoinMaxAttempts = clampInt(s.autoRejoinMaxAttempts, 1, 20, DEFAULT_SETTINGS.autoRejoinMaxAttempts);
  s.autoRestartHungSec = clampInt(s.autoRestartHungSec, 0, 120, DEFAULT_SETTINGS.autoRestartHungSec);
  return s;
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

function saveSettings(partial) {
  return updateJson('settings.json', DEFAULT_SETTINGS, current =>
    normalizeSettings(Object.assign({}, current, partial || {})));
}

function resetSettings() {
  return updateJson('settings.json', DEFAULT_SETTINGS, () => clone(DEFAULT_SETTINGS));
}

/* ----------------------------- Profiles ----------------------------- */

function getProfiles() {
  const list = readJson('profiles.json', []);
  if (!Array.isArray(list)) throw new Error('profiles.json has the wrong schema.');
  return list.map(normalizeProfile).filter(Boolean);
}

function normalizeProfile(p) {
  if (!p || typeof p !== 'object') return null;
  const mode = p.launchMode === 'deeplink' ? 'deeplink' : 'client';
  return {
    id: p.id || newId(),
    name: String(p.name || 'Untitled').slice(0, 80),
    launchMode: mode,
    deeplink: mode === 'deeplink' ? String(p.deeplink || '') : '',
    count: clampInt(p.count, 1, 20, 1),
    notes: String(p.notes || '').slice(0, 500),
    createdAt: p.createdAt || new Date().toISOString(),
  };
}

/** Validate a profile coming from the UI. Returns { ok, errors, value }. */
function validateProfile(p) {
  const errors = [];
  const name = (p && typeof p.name === 'string') ? p.name.trim() : '';
  if (!name) errors.push('Name is required.');
  if (name.length > 80) errors.push('Name must be 80 characters or fewer.');
  const mode = p && p.launchMode === 'deeplink' ? 'deeplink' : 'client';
  let deeplink = '';
  if (mode === 'deeplink') {
    deeplink = (p && typeof p.deeplink === 'string') ? p.deeplink.trim() : '';
    if (!deeplink) {
      errors.push('A deep link is required for deep-link profiles.');
    } else if (!/^roblox(-player)?:/i.test(deeplink) && !/^https?:\/\//i.test(deeplink)) {
      errors.push('Deep link must start with roblox:, roblox-player: or http(s)://');
    }
  }
  const count = clampInt(p && p.count, 1, 20, 1);
  return {
    ok: errors.length === 0,
    errors,
    value: errors.length === 0
      ? normalizeProfile({ id: p.id, name, launchMode: mode, deeplink, count, notes: p.notes, createdAt: p.createdAt })
      : null,
  };
}

function saveProfile(p) {
  const result = validateProfile(p);
  if (!result.ok) return { ok: false, errors: result.errors };
  const list = updateJson('profiles.json', [], current => {
    const normalized = Array.isArray(current) ? current.map(normalizeProfile).filter(Boolean) : [];
    const idx = normalized.findIndex(x => x.id === result.value.id);
    if (idx >= 0) normalized[idx] = result.value;
    else normalized.push(result.value);
    return normalized;
  });
  return { ok: true, profile: result.value, profiles: list };
}

function deleteProfile(id) {
  return updateJson('profiles.json', [], current =>
    (Array.isArray(current) ? current : []).map(normalizeProfile).filter(Boolean).filter(p => p.id !== id));
}

/* ----------------------------- History ----------------------------- */

function getHistory() {
  const list = readJson('history.json', []);
  if (!Array.isArray(list)) throw new Error('history.json has the wrong schema.');
  return list;
}

function addHistory(entry) {
  const settings = getSettings();
  return updateJson('history.json', [], current => {
    const list = Array.isArray(current) ? current : [];
    list.unshift({
      time: new Date().toISOString(),
      profileName: entry.profileName || 'Quick launch',
      mode: entry.mode || 'client',
      result: entry.result || 'launched',
      pid: entry.pid || null,
      message: entry.message || '',
    });
    while (list.length > settings.historyLimit) list.pop();
    return list;
  });
}

function clearHistory() {
  return updateJson('history.json', [], () => []);
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

module.exports = {
  DEFAULT_SETTINGS,
  configure,
  readJson, writeJson, updateJson, database, backupState, close,
  getSettings, saveSettings, resetSettings, normalizeSettings,
  getProfiles, saveProfile, deleteProfile, validateProfile,
  getHistory, addHistory, clearHistory,
  newId,
};
