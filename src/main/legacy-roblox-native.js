'use strict';

/**
 * LEGACY COMPATIBILITY ONLY.
 *
 * This is the quarantined Win32 portion of the pre-hardening Roblox singleton
 * mechanism. It is loaded only after LEGACY_COMPAT=1 selects the legacy
 * adapter. It must never be used as general process-control authority.
 */

const EVENT_NAME = 'ROBLOX_singletonEvent';
const MUTEX_NAME = 'ROBLOX_singletonMutex';
const SYSTEM_EXTENDED_HANDLE_INFORMATION = 0x40;
const STATUS_SUCCESS = 0;
const STATUS_INFO_LENGTH_MISMATCH = 0xC0000004;
const PROCESS_DUP_HANDLE = 0x0040;
const DUPLICATE_CLOSE_SOURCE = 0x1;
const DUPLICATE_SAME_ACCESS = 0x2;
const OBJECT_NAME_INFORMATION = 1;
const SYNCHRONIZE = 0x00100000;
const WAIT_OBJECT_0 = 0;
const WAIT_ABANDONED = 0x80;
const WAIT_TIMEOUT = 0x102;

let initialized = false;
let available = false;
let loadError = '';
let koffi;
let NtQuerySystemInformation;
let NtQueryObject;
let OpenProcess;
let DuplicateHandle;
let CloseHandle;
let GetCurrentProcess;
let CreateEventW;
let CreateMutexW;
let WaitForSingleObject;
let typeIndices = null;
const singletonHandles = new Map();

function init() {
  if (initialized) return available;
  initialized = true;
  try {
    koffi = require('koffi');
    const ntdll = koffi.load('ntdll.dll');
    const kernel32 = koffi.load('kernel32.dll');
    NtQuerySystemInformation = ntdll.func('long __stdcall NtQuerySystemInformation(uint SystemInformationClass, void* SystemInformation, uint32 Length, _Out_ uint32* ReturnLength)');
    NtQueryObject = ntdll.func('long __stdcall NtQueryObject(uintptr Handle, uint ObjectInformationClass, void* ObjectInformation, uint32 Length, _Out_ uint32* ReturnLength)');
    OpenProcess = kernel32.func('uintptr __stdcall OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)');
    DuplicateHandle = kernel32.func('int __stdcall DuplicateHandle(uintptr hSourceProcess, uintptr hSourceHandle, uintptr hTargetProcess, void* lpTargetHandle, uint32 dwDesiredAccess, int bInheritHandle, uint32 dwOptions)');
    CloseHandle = kernel32.func('int __stdcall CloseHandle(uintptr hObject)');
    GetCurrentProcess = kernel32.func('uintptr __stdcall GetCurrentProcess()');
    CreateEventW = kernel32.func('uintptr __stdcall CreateEventW(void* a, int b, int c, str16 d)');
    CreateMutexW = kernel32.func('uintptr __stdcall CreateMutexW(void* a, int b, str16 c)');
    WaitForSingleObject = kernel32.func('uint32 __stdcall WaitForSingleObject(uintptr hHandle, uint32 dwMilliseconds)');
    available = true;
  } catch (error) {
    loadError = (error && error.message) || String(error);
    available = false;
  }
  return available;
}

function isAvailable() { return init(); }
function getLoadError() { init(); return loadError; }

function ownedCount() {
  let count = 0;
  for (const value of singletonHandles.values()) if (value.owned) count += 1;
  return count;
}

function singletonGuardReady() {
  const eventGuard = singletonHandles.get(EVENT_NAME);
  return !!(eventGuard && eventGuard.handle && eventGuard.typeSquat);
}

/** Reserve the singleton event name and acquire the mutex when available. */
function acquireSingletonNames() {
  if (!init()) return { ok: false, held: ownedCount(), total: 2, reason: loadError || 'Legacy Win32 bindings unavailable.' };
  const contested = [];
  for (const name of [EVENT_NAME, MUTEX_NAME]) {
    const current = singletonHandles.get(name);
    if (current && (current.owned || (name === EVENT_NAME && current.typeSquat))) continue;
    let handle = current && current.handle;
    if (!handle) {
      // A mutex deliberately occupies the event name. Roblox cannot open an
      // Event with that name and therefore does not enter its singleton wait.
      try { handle = CreateMutexW(null, 0, name); } catch (_) { handle = 0; }
      if (!handle) { contested.push(name); continue; }
    }
    let wait = WAIT_TIMEOUT;
    try { wait = WaitForSingleObject(handle, 0); } catch (_) { wait = WAIT_TIMEOUT; }
    const owned = wait === WAIT_OBJECT_0 || wait === WAIT_ABANDONED;
    const typeSquat = name === EVENT_NAME;
    singletonHandles.set(name, { handle, owned, typeSquat });
    if (!owned) contested.push(name);
  }
  const guardReady = singletonGuardReady();
  return {
    ok: guardReady,
    guardReady,
    held: ownedCount(),
    total: 2,
    contested,
  };
}

function singletonNamesOwned() { return ownedCount() === 2; }

function querySystemHandles() {
  let size = 1 << 21;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const buffer = Buffer.alloc(size);
    const returned = [0];
    const status = NtQuerySystemInformation(SYSTEM_EXTENDED_HANDLE_INFORMATION, buffer, size, returned) >>> 0;
    if (status === STATUS_INFO_LENGTH_MISMATCH) {
      size = Math.max(size * 2, (returned[0] || 0) + (1 << 20));
      continue;
    }
    if (status === STATUS_SUCCESS) return { buffer, count: Number(buffer.readBigUInt64LE(0)) };
    return null;
  }
  return null;
}

function typeIndexOf(handle) {
  const wanted = BigInt(handle);
  const owner = BigInt(process.pid);
  const snapshot = querySystemHandles();
  if (!snapshot) return null;
  for (let index = 0; index < snapshot.count; index += 1) {
    const offset = 16 + index * 40;
    if (offset + 40 > snapshot.buffer.length) break;
    if (snapshot.buffer.readBigUInt64LE(offset + 8) === owner
        && snapshot.buffer.readBigUInt64LE(offset + 16) === wanted) {
      return snapshot.buffer.readUInt16LE(offset + 30);
    }
  }
  return null;
}

function getTypeIndices() {
  if (typeIndices) return typeIndices;
  let event = null;
  let mutant = null;
  try {
    const eventHandle = CreateEventW(null, 0, 0, null);
    if (eventHandle) { event = typeIndexOf(eventHandle); CloseHandle(eventHandle); }
    const mutexHandle = CreateMutexW(null, 0, null);
    if (mutexHandle) { mutant = typeIndexOf(mutexHandle); CloseHandle(mutexHandle); }
  } catch (_) {}
  typeIndices = { event, mutant };
  return typeIndices;
}

function isSingletonEventName(name) {
  if (!name) return false;
  const lower = String(name).toLowerCase();
  const leaf = lower.slice(lower.lastIndexOf('\\') + 1);
  return leaf === EVENT_NAME.toLowerCase();
}

/**
 * Close only the exact Roblox singleton event in internally enumerated PIDs.
 * The mutex can remain owned by a live client; closing its process handle does
 * not transfer mutex ownership and can leave preflight permanently contested.
 * Callers may not pass user-originated PIDs into this compatibility API.
 */
function closeGlobalSingletonHandles(pids) {
  if (!init()) return { ok: false, closed: 0, scanned: 0, reason: loadError || 'Legacy Win32 bindings unavailable.' };
  const targets = new Set((pids || []).map(value => Number(value)).filter(value => Number.isInteger(value) && value > 0).map(BigInt));
  if (!targets.size) return { ok: true, closed: 0, scanned: 0 };
  const indices = getTypeIndices();
  const snapshot = querySystemHandles();
  if (!snapshot) return { ok: false, closed: 0, scanned: 0, reason: 'System handle enumeration failed.' };

  const currentProcess = GetCurrentProcess();
  const opened = new Map();
  const duplicateOut = Buffer.alloc(8);
  const nameBuffer = Buffer.alloc(2048);
  let scanned = 0;
  let closed = 0;

  const processHandle = pid => {
    if (opened.has(pid)) return opened.get(pid);
    let handle = 0;
    try { handle = OpenProcess(PROCESS_DUP_HANDLE, 0, Number(pid)); } catch (_) {}
    opened.set(pid, handle);
    return handle;
  };

  try {
    for (let index = 0; index < snapshot.count; index += 1) {
      const offset = 16 + index * 40;
      if (offset + 40 > snapshot.buffer.length) break;
      const pid = snapshot.buffer.readBigUInt64LE(offset + 8);
      if (!targets.has(pid)) continue;
      const typeIndex = snapshot.buffer.readUInt16LE(offset + 30);
      if (indices.event != null && indices.mutant != null
          && typeIndex !== indices.event && typeIndex !== indices.mutant) continue;
      const sourceProcess = processHandle(pid);
      if (!sourceProcess) continue;
      const sourceHandle = snapshot.buffer.readBigUInt64LE(offset + 16);
      scanned += 1;
      duplicateOut.writeBigUInt64LE(0n, 0);
      let duplicated = 0;
      try {
        duplicated = DuplicateHandle(sourceProcess, sourceHandle, currentProcess, duplicateOut, 0, 0, DUPLICATE_SAME_ACCESS);
      } catch (_) {}
      if (!duplicated) continue;
      const localHandle = duplicateOut.readBigUInt64LE(0);
      let isGuard = false;
      try {
        const returned = [0];
        const status = NtQueryObject(localHandle, OBJECT_NAME_INFORMATION, nameBuffer, nameBuffer.length, returned) >>> 0;
        if (status === STATUS_SUCCESS) {
          const headerSize = process.arch === 'x64' ? 16 : 8;
          const length = Math.min(nameBuffer.readUInt16LE(0), nameBuffer.length - headerSize);
          if (length > 0) isGuard = isSingletonEventName(nameBuffer.subarray(headerSize, headerSize + length).toString('utf16le'));
        }
      } catch (_) {}
      try { CloseHandle(localHandle); } catch (_) {}
      if (!isGuard) continue;
      try {
        if (DuplicateHandle(sourceProcess, sourceHandle, 0, null, 0, 0, DUPLICATE_CLOSE_SOURCE)) closed += 1;
      } catch (_) {}
    }
  } finally {
    for (const handle of opened.values()) if (handle) try { CloseHandle(handle); } catch (_) {}
  }
  return { ok: true, closed, scanned };
}

module.exports = {
  EVENT_NAME,
  MUTEX_NAME,
  acquireSingletonNames,
  closeGlobalSingletonHandles,
  getLoadError,
  init,
  isAvailable,
  singletonGuardReady,
  singletonNamesOwned,
};
