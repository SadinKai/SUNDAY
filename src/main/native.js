'use strict';

/**
 * Narrow Win32 boundary for process identity, owned termination, and window
 * presentation. It deliberately binds no system-handle enumeration,
 * DuplicateHandle, remote-memory, or named-singleton mutation APIs.
 */

const path = require('path');

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const PROCESS_TERMINATE = 0x0001;
const SYNCHRONIZE = 0x00100000;
const TH32CS_SNAPPROCESS = 0x2;
const SW_RESTORE = 9;

let initialized = false;
let available = false;
let loadError = null;
let koffi;
let OpenProcess, CloseHandle, QueryFullProcessImageNameW, GetProcessTimes;
let CreateFileW, GetFileInformationByHandleEx;
let WaitForSingleObject, TerminateProcess, CreateToolhelp32Snapshot;
let Process32FirstW, Process32NextW, K32GetProcessMemoryInfo;
let EnumWindows, GetWindowThreadProcessId, IsWindowVisible, ShowWindow;
let SetForegroundWindow, BringWindowToTop, AllowSetForegroundWindow;
let GetWindowTextW, GetClassNameW, GetWindowRect, IsHungAppWindow, SetWindowPos, SystemParametersInfoW;
let EnumWindowsProto, PE32, PE32_SIZE;

function init() {
  if (initialized) return available;
  initialized = true;
  try {
    koffi = require('koffi');
    const kernel32 = koffi.load('kernel32.dll');
    const user32 = koffi.load('user32.dll');

    OpenProcess = kernel32.func('uintptr __stdcall OpenProcess(uint32 dwDesiredAccess, int bInheritHandle, uint32 dwProcessId)');
    CloseHandle = kernel32.func('int __stdcall CloseHandle(uintptr hObject)');
    QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(uintptr hProcess, uint32 dwFlags, void* lpExeName, _Inout_ uint32* lpdwSize)');
    GetProcessTimes = kernel32.func('bool __stdcall GetProcessTimes(uintptr hProcess, void* lpCreationTime, void* lpExitTime, void* lpKernelTime, void* lpUserTime)');
    CreateFileW = kernel32.func('uintptr __stdcall CreateFileW(str16 lpFileName, uint32 dwDesiredAccess, uint32 dwShareMode, void* lpSecurityAttributes, uint32 dwCreationDisposition, uint32 dwFlagsAndAttributes, uintptr hTemplateFile)');
    GetFileInformationByHandleEx = kernel32.func('bool __stdcall GetFileInformationByHandleEx(uintptr hFile, int FileInformationClass, _Out_ void* lpFileInformation, uint32 dwBufferSize)');
    WaitForSingleObject = kernel32.func('uint32 __stdcall WaitForSingleObject(uintptr hHandle, uint32 dwMilliseconds)');
    TerminateProcess = kernel32.func('bool __stdcall TerminateProcess(uintptr hProcess, uint32 uExitCode)');
    CreateToolhelp32Snapshot = kernel32.func('uintptr __stdcall CreateToolhelp32Snapshot(uint32 dwFlags, uint32 th32ProcessID)');
    K32GetProcessMemoryInfo = kernel32.func('bool __stdcall K32GetProcessMemoryInfo(uintptr Process, void *counters, uint32 cb)');

    PE32 = koffi.struct('PROCESSENTRY32W', {
      dwSize: 'uint32', cntUsage: 'uint32', th32ProcessID: 'uint32',
      th32DefaultHeapID: 'uintptr', th32ModuleID: 'uint32', cntThreads: 'uint32',
      th32ParentProcessID: 'uint32', pcPriClassBase: 'int32', dwFlags: 'uint32',
      szExeFile: koffi.array('char16', 260, 'string'),
    });
    PE32_SIZE = koffi.sizeof(PE32);
    Process32FirstW = kernel32.func('bool __stdcall Process32FirstW(uintptr hSnapshot, _Inout_ PROCESSENTRY32W *lppe)');
    Process32NextW = kernel32.func('bool __stdcall Process32NextW(uintptr hSnapshot, _Inout_ PROCESSENTRY32W *lppe)');

    EnumWindowsProto = koffi.proto('bool __stdcall SundayEnumProc(void* hwnd, intptr lparam)');
    EnumWindows = user32.func('bool __stdcall EnumWindows(void* lpEnumFunc, intptr lParam)');
    GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void* hWnd, _Out_ uint32* lpdwProcessId)');
    IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void* hWnd)');
    ShowWindow = user32.func('bool __stdcall ShowWindow(void* hWnd, int nCmdShow)');
    SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(void* hWnd)');
    BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(void* hWnd)');
    AllowSetForegroundWindow = user32.func('bool __stdcall AllowSetForegroundWindow(uint32 dwProcessId)');
    GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void* hWnd, void* lpString, int nMaxCount)');
    GetClassNameW = user32.func('int __stdcall GetClassNameW(void* hWnd, void* lpClassName, int nMaxCount)');
    GetWindowRect = user32.func('bool __stdcall GetWindowRect(void* hWnd, _Out_ void* lpRect)');
    try { IsHungAppWindow = user32.func('bool __stdcall IsHungAppWindow(void* hWnd)'); } catch (_) { IsHungAppWindow = null; }
    SetWindowPos = user32.func('bool __stdcall SetWindowPos(void* hWnd, void* hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)');
    SystemParametersInfoW = user32.func('bool __stdcall SystemParametersInfoW(uint32 uiAction, uint32 uiParam, void* pvParam, uint32 fWinIni)');
    available = true;
  } catch (err) {
    available = false;
    loadError = (err && err.message) || String(err);
  }
  return available;
}

function isAvailable() { return available; }
function getLoadError() { return loadError; }
function disabled(reason) { return { ok: false, reason }; }

function withProcess(pid, access, fn, fallback) {
  if (!init()) return fallback;
  let handle = 0;
  try {
    handle = OpenProcess(access, 0, Number(pid));
    if (!handle) return fallback;
    return fn(handle);
  } catch (_) {
    return fallback;
  } finally {
    if (handle) try { CloseHandle(handle); } catch (_) {}
  }
}

function imagePathFromHandle(handle) {
  const chars = 32767;
  const buffer = Buffer.alloc(chars * 2);
  const size = [chars];
  if (!QueryFullProcessImageNameW(handle, 0, buffer, size) || !size[0]) return '';
  return buffer.subarray(0, Number(size[0]) * 2).toString('utf16le');
}

function identityFromHandle(handle) {
  const creation = Buffer.alloc(8), exit = Buffer.alloc(8), kernel = Buffer.alloc(8), user = Buffer.alloc(8);
  if (!GetProcessTimes(handle, creation, exit, kernel, user)) return '';
  return creation.readBigUInt64LE(0).toString(16);
}

function invalidHandle(handle) {
  return !handle || handle === -1 || handle === 0xffffffffffffffffn;
}

/**
 * Return the stable NTFS/ReFS file identity for the executable currently at
 * `filePath`. Empty means the filesystem or policy did not expose one; callers
 * must never substitute the path string as a file identity.
 */
function fileIdentityOfPath(filePath) {
  if (!init() || !filePath) return '';
  let handle = 0;
  try {
    // FILE_READ_ATTRIBUTES; share read/write/delete so a running, updating
    // application can still be identified without changing it.
    handle = CreateFileW(String(filePath), 0x80, 0x7, null, 3, 0x80, 0);
    if (invalidHandle(handle)) return '';
    // FileIdInfo = 18. FILE_ID_INFO is an 8-byte volume serial followed by a
    // 16-byte file identifier.
    const info = Buffer.alloc(24);
    if (!GetFileInformationByHandleEx(handle, 18, info, info.length)) return '';
    return info.subarray(0, 24).toString('hex');
  } catch (_) {
    return '';
  } finally {
    if (!invalidHandle(handle)) try { CloseHandle(handle); } catch (_) {}
  }
}

function fingerprintFromHandle(handle) {
  const executablePath = imagePathFromHandle(handle);
  return {
    processIdentity: identityFromHandle(handle),
    executablePath,
    fileIdentity: fileIdentityOfPath(executablePath),
  };
}

function processFingerprintOf(pid) {
  return withProcess(pid, PROCESS_QUERY_LIMITED_INFORMATION, fingerprintFromHandle, {
    processIdentity: '',
    executablePath: '',
    fileIdentity: '',
  });
}

function executablePathOf(pid) {
  return withProcess(pid, PROCESS_QUERY_LIMITED_INFORMATION, imagePathFromHandle, '');
}

function processIdentityOf(pid) {
  return withProcess(pid, PROCESS_QUERY_LIMITED_INFORMATION, identityFromHandle, '');
}

function verifiedRecordFromHandle(handle, record) {
  const current = fingerprintFromHandle(handle);
  const actualPath = path.win32.normalize(String(current.executablePath || '')).toLowerCase();
  const wantedPath = path.win32.normalize(String(record && record.executablePath || '')).toLowerCase();
  if (!current.processIdentity || current.processIdentity !== String(record && record.processIdentity || '')) {
    return { ok: false, reason: 'Process creation identity changed; action refused.' };
  }
  if (!wantedPath || actualPath !== wantedPath) {
    return { ok: false, reason: 'Process executable path changed; action refused.' };
  }
  if (record && record.fileIdentity && current.fileIdentity !== record.fileIdentity) {
    return { ok: false, reason: 'Process executable file identity changed; action refused.' };
  }
  return { ok: true, current };
}

function terminateOwned(record) {
  if (!init()) return disabled(loadError || 'Native process validation is unavailable.');
  if (!record || typeof record !== 'object') return disabled('Owned process evidence is required.');
  let handle = 0;
  try {
    handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | SYNCHRONIZE, 0, Number(record.pid));
    if (!handle) return disabled('The owned process is no longer accessible.');
    const verified = verifiedRecordFromHandle(handle, record);
    if (!verified.ok) return disabled(verified.reason);
    if (!TerminateProcess(handle, 1)) return disabled('Windows refused to terminate the owned process.');
    const wait = WaitForSingleObject(handle, 5000);
    if (wait !== 0) return disabled('Termination was requested but Windows did not confirm process exit.');
    return { ok: true, confirmed: true };
  } catch (err) {
    return disabled((err && err.message) || 'Owned termination failed.');
  } finally {
    if (handle) try { CloseHandle(handle); } catch (_) {}
  }
}

function focusOwned(record) {
  if (!init()) return disabled(loadError || 'Native process validation is unavailable.');
  let handle = 0;
  try {
    // Holding the process object open prevents a recycled PID from becoming
    // authoritative between validation and the window operation.
    handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, Number(record && record.pid));
    if (!handle) return disabled('The owned process is no longer accessible.');
    const verified = verifiedRecordFromHandle(handle, record);
    if (!verified.ok) return disabled(verified.reason);
    const window = enumerateWindows([record.pid]).get(Number(record.pid));
    if (!window) return disabled('No visible window exists for the owned process.');
    // Validate again immediately before the action while the same process
    // handle remains open.
    const finalCheck = verifiedRecordFromHandle(handle, record);
    if (!finalCheck.ok) return disabled(finalCheck.reason);
    try { AllowSetForegroundWindow(0xffffffff); } catch (_) {}
    ShowWindow(window.hwnd, SW_RESTORE);
    BringWindowToTop(window.hwnd);
    return { ok: true, foreground: !!SetForegroundWindow(window.hwnd) };
  } catch (err) {
    return disabled((err && err.message) || 'Window focus failed.');
  } finally {
    if (handle) try { CloseHandle(handle); } catch (_) {}
  }
}

function workingSetOf(pid) {
  return withProcess(pid, PROCESS_QUERY_LIMITED_INFORMATION, handle => {
    const counters = Buffer.alloc(72);
    counters.writeUInt32LE(72, 0);
    return K32GetProcessMemoryInfo(handle, counters, 72) ? Number(counters.readBigUInt64LE(16)) : 0;
  }, 0);
}

function listProcesses(imageName) {
  if (!init()) return null;
  const wanted = String(imageName || '').toLowerCase();
  let snapshot = 0;
  const result = [];
  try {
    snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (!snapshot) return null;
    const entry = { dwSize: PE32_SIZE };
    let more = Process32FirstW(snapshot, entry);
    if (!more) return null;
    while (more) {
      if (String(entry.szExeFile || '').toLowerCase() === wanted) {
        result.push({
          pid: entry.th32ProcessID,
          memBytes: workingSetOf(entry.th32ProcessID),
          executablePath: executablePathOf(entry.th32ProcessID),
          processIdentity: processIdentityOf(entry.th32ProcessID),
        });
      }
      more = Process32NextW(snapshot, entry);
    }
    return result;
  } catch (_) {
    return null;
  } finally {
    if (snapshot) try { CloseHandle(snapshot); } catch (_) {}
  }
}

function enumerateWindows(pids) {
  const out = new Map();
  if (!init()) return out;
  const targets = new Set((pids || []).map(Number));
  if (!targets.size) return out;
  const text = Buffer.alloc(1024);
  const classNameBuffer = Buffer.alloc(512);
  const rectBuffer = Buffer.alloc(16);
  let callback = null;
  try {
    callback = koffi.register(hwnd => {
      try {
        if (!IsWindowVisible(hwnd)) return true;
        const pid = [0];
        GetWindowThreadProcessId(hwnd, pid);
        if (!targets.has(pid[0])) return true;
        const length = GetWindowTextW(hwnd, text, 511);
        const title = length > 0 ? text.subarray(0, length * 2).toString('utf16le') : '';
        const classLength = GetClassNameW(hwnd, classNameBuffer, 255);
        const className = classLength > 0
          ? classNameBuffer.subarray(0, classLength * 2).toString('utf16le')
          : '';
        let rect = null;
        if (GetWindowRect(hwnd, rectBuffer)) {
          const left = rectBuffer.readInt32LE(0), top = rectBuffer.readInt32LE(4);
          const right = rectBuffer.readInt32LE(8), bottom = rectBuffer.readInt32LE(12);
          rect = { left, top, right, bottom, width: right - left, height: bottom - top };
        }
        const responding = IsHungAppWindow ? !IsHungAppWindow(hwnd) : true;
        const previous = out.get(pid[0]);
        if (!previous || (!previous.title && title)) out.set(pid[0], {
          hwnd, title, className, rect, responding,
        });
      } catch (_) {}
      return true;
    }, koffi.pointer(EnumWindowsProto));
    EnumWindows(callback, 0);
  } finally {
    if (callback) try { koffi.unregister(callback); } catch (_) {}
  }
  return out;
}

function windowInfoForPids(pids) {
  const raw = enumerateWindows(pids);
  return new Map(Array.from(raw, ([pid, value]) => [pid, {
    title: value.title,
    className: value.className,
    rect: value.rect,
    responding: value.responding,
  }]));
}

function tileOwned(records) {
  if (!init()) return Object.assign(disabled(loadError || 'Native process validation is unavailable.'), { tiled: 0 });
  const requested = Array.isArray(records) ? records : [];
  if (!requested.length) return Object.assign(disabled('No owned process evidence was provided.'), { tiled: 0 });
  const qualified = [];
  try {
    for (const record of requested) {
      const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, Number(record && record.pid));
      if (!handle) return Object.assign(disabled('An owned process is no longer accessible.'), { tiled: 0 });
      qualified.push({ handle, record });
      const verified = verifiedRecordFromHandle(handle, record);
      if (!verified.ok) return Object.assign(disabled(verified.reason), { tiled: 0 });
    }
    const byPid = enumerateWindows(qualified.map(item => item.record.pid));
    const windows = qualified
      .map(item => ({ item, window: byPid.get(Number(item.record.pid)) }))
      .filter(entry => entry.window);
    if (!windows.length) return Object.assign(disabled('No visible owned windows to arrange.'), { tiled: 0 });
  const rect = Buffer.alloc(16);
  let left = 0, top = 0, right = 1920, bottom = 1080;
  try {
    if (SystemParametersInfoW(0x0030, 0, rect, 0)) {
      left = rect.readInt32LE(0); top = rect.readInt32LE(4);
      right = rect.readInt32LE(8); bottom = rect.readInt32LE(12);
    }
  } catch (_) {}
  const cols = Math.ceil(Math.sqrt(windows.length));
  const rows = Math.ceil(windows.length / cols);
  const width = Math.floor(Math.max(200, right - left) / cols);
  const height = Math.floor(Math.max(200, bottom - top) / rows);
  let tiled = 0;
  for (let index = 0; index < windows.length; index++) {
    try {
      const { item, window } = windows[index];
      const finalCheck = verifiedRecordFromHandle(item.handle, item.record);
      if (!finalCheck.ok) continue;
      const currentPid = [0];
      GetWindowThreadProcessId(window.hwnd, currentPid);
      if (Number(currentPid[0]) !== Number(item.record.pid)) continue;
      const column = index % cols, row = Math.floor(index / cols);
      ShowWindow(window.hwnd, SW_RESTORE);
      if (SetWindowPos(window.hwnd, 0, left + column * width, top + row * height, width, height, 0x54)) tiled++;
    } catch (_) {}
  }
  return { ok: tiled > 0, tiled, cols, rows };
  } finally {
    for (const item of qualified) {
      if (item.handle) try { CloseHandle(item.handle); } catch (_) {}
    }
  }
}

module.exports = {
  init, isAvailable, getLoadError,
  listProcesses, executablePathOf, processIdentityOf, fileIdentityOfPath,
  processFingerprintOf, terminateOwned,
  windowInfoForPids, focusOwned, tileOwned,
};
