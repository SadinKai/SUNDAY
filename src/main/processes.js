'use strict';

/**
 * processes.js — enumerate and terminate Roblox client processes.
 *
 * Enumeration uses `tasklist /V` (a native Windows tool) which returns PID,
 * memory, responding-status and the window title in a single fast call — no
 * long-lived helper processes, so nothing here can be orphaned.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const native = require('./native');

const PLAYER_IMAGE = 'RobloxPlayerBeta.exe';
const CRASH_IMAGE = 'RobloxCrashHandler.exe';
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const TASKLIST = path.join(SYSTEM32, 'tasklist.exe');

function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', timeout: timeout || 8000, windowsHide: true },
      (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' }));
  });
}

/** Parse one CSV line where every field is double-quoted. */
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function memToBytes(s) {
  // e.g. "1,234,567 K"
  const digits = String(s).replace(/[^\d]/g, '');
  if (!digits) return 0;
  return parseInt(digits, 10) * 1024;
}

function normalizeExecutablePath(value) {
  if (!value || typeof value !== 'string') return '';
  try { return path.win32.normalize(value.trim()).replace(/[\\/]+$/, ''); }
  catch (_) { return ''; }
}

function inspectRobloxPath(value) {
  const executablePath = normalizeExecutablePath(value);
  const exactName = path.win32.basename(executablePath).toLowerCase() === PLAYER_IMAGE.toLowerCase();
  let exists = false;
  try { exists = exactName && path.win32.isAbsolute(executablePath) && fs.statSync(executablePath).isFile(); } catch (_) {}
  const lower = executablePath.toLowerCase();
  const official = /\\roblox\\versions\\version-[^\\]+\\robloxplayerbeta\.exe$/i.test(lower);
  const sundayClone = /\\clones\\instance-\d+\\robloxplayerbeta\.exe$/i.test(lower);
  return {
    executablePath,
    verifiedPath: !!exists,
    expectedLayout: !!exists && (official || sundayClone),
    // Path shape is classification only, never executable trust. Publisher and
    // file identity are verified by the launch qualifier before execution.
    trustedInstall: false,
  };
}

/**
 * List running Roblox clients.
 *
 * Uses a FAST `tasklist` (no `/V`) for PID + memory — `/V` blocks for seconds
 * while clients are loading because it queries each window, and times out with
 * several clients (which made the list go blank). Window title + responding
 * status come from koffi (`GetWindowTextW` does not block on other processes).
 *
 * @returns {Promise<Array<{pid:number, memBytes:number, status:string, windowTitle:string}>>}
 */
async function list() {
  // Primary: spawn-free Toolhelp enumeration (immune to system load).
  let base = null;
  try { base = native.listProcesses(PLAYER_IMAGE); } catch (_) { base = null; }

  // Fallback: tasklist (only if FFI is unavailable).
  if (base === null) base = await tasklistList();
  if (!base || base.length === 0) return [];

  // Enrich with window title + responding status (fast, non-blocking).
  let info = new Map();
  try { info = native.windowInfoForPids(base.map(r => r.pid)); } catch (_) {}

  return base.map(r => {
    const wi = info.get(r.pid);
    const verified = inspectRobloxPath(r.executablePath);
    const windowVerified = !verified.executablePath && !!(wi && /^Roblox$/i.test((wi.title || '').trim()));
    return {
      pid: r.pid,
      memBytes: r.memBytes,
      status: wi && wi.responding === false ? 'not_responding' : 'running',
      windowTitle: wi ? (wi.title || '') : '',
      executablePath: verified.executablePath,
      verifiedPath: verified.verifiedPath,
      expectedLayout: verified.expectedLayout,
      trustedInstall: verified.trustedInstall,
      windowVerified,
      processIdentity: String(r.processIdentity || ''),
    };
  });
}

/** tasklist-based fallback used only when the native FFI is unavailable. */
async function tasklistList() {
  const { err, stdout } = await run(TASKLIST,
    ['/FI', `IMAGENAME eq ${PLAYER_IMAGE}`, '/FO', 'CSV', '/NH'], 10000);
  if (err) return [];
  if (/No tasks are running/i.test(stdout)) return [];
  const base = [];
  for (const line of stdout.split(/\r?\n/).filter(l => l.trim().startsWith('"'))) {
    const f = parseCsvLine(line);
    if (f.length < 5 || !/robloxplayerbeta\.exe/i.test(f[0])) continue;
    const pid = parseInt(f[1], 10);
    if (!Number.isNaN(pid)) base.push({ pid, memBytes: memToBytes(f[4]) });
  }
  return base;
}

function terminateOwned(record) {
  if (!record || !record.pid || !record.processIdentity || !record.executablePath) {
    return { ok: false, reason: 'A verified SUNDAY Launcher process capability is required.' };
  }
  return native.terminateOwned(record);
}

function focusOwned(record) {
  if (!record || !record.pid || !record.processIdentity || !record.executablePath) {
    return { ok: false, reason: 'A verified SUNDAY Launcher process capability is required.' };
  }
  return native.focusOwned(record);
}

async function kill() {
  return { ok: false, reason: 'PID-only termination is disabled.' };
}

async function killAllPlayers() {
  return { ok: false, reason: 'Broad Roblox termination is disabled.' };
}

async function cleanupAll() {
  return { ok: false, reason: 'Broad process cleanup is disabled.' };
}

module.exports = { list, terminateOwned, focusOwned, kill, killAllPlayers, cleanupAll, inspectRobloxPath, PLAYER_IMAGE, CRASH_IMAGE };
