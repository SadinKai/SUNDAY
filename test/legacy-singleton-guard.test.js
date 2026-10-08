'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const nativePath = path.resolve(__dirname, '..', 'src', 'main', 'legacy-roblox-native.js');
const { classifyLaunchFailure } = require('../src/main/launch-orchestration');

function loadNative(functions) {
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'koffi') {
      return {
        load() {
          return {
            func(signature) {
              const entry = Object.entries(functions).find(([name]) => signature.includes(name));
              return entry ? entry[1] : (() => 0);
            },
          };
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[nativePath];
  try {
    const native = require(nativePath);
    native.init();
    return native;
  } finally {
    Module._load = originalLoad;
  }
}

test('event type squat is launch-ready while an external client owns the mutex', () => {
  let eventClosed = false;
  const native = loadNative({
    CreateMutexW(_attributes, _initialOwner, name) {
      if (name === 'ROBLOX_singletonEvent') return eventClosed ? 101 : 0;
      if (name === 'ROBLOX_singletonMutex') return 202;
      return 0;
    },
    WaitForSingleObject(handle) {
      return handle === 101 ? 0 : 0x102;
    },
  });

  const contested = native.acquireSingletonNames();
  assert.equal(contested.ok, false);
  assert.equal(native.singletonGuardReady(), false);

  eventClosed = true;
  const guarded = native.acquireSingletonNames();
  assert.equal(guarded.ok, true);
  assert.equal(guarded.guardReady, true);
  assert.equal(native.singletonGuardReady(), true);
  assert.equal(native.singletonNamesOwned(), false);
  assert.deepEqual(guarded.contested, ['ROBLOX_singletonMutex']);
});

test('cross-process cleanup closes only the exact singleton event handle', () => {
  const targetPid = 444;
  const names = new Map([
    [11n, '\\Sessions\\1\\BaseNamedObjects\\ROBLOX_singletonEvent'],
    [12n, '\\Sessions\\1\\BaseNamedObjects\\ROBLOX_singletonMutex'],
    [13n, '\\Sessions\\1\\BaseNamedObjects\\not-ROBLOX_singletonEvent'],
  ]);
  const localToSource = new Map();
  const closedSources = [];
  const native = loadNative({
    CreateEventW: () => 0,
    CreateMutexW: () => 0,
    GetCurrentProcess: () => 999,
    OpenProcess: () => 777,
    CloseHandle: () => 1,
    NtQuerySystemInformation(_classId, buffer) {
      buffer.writeBigUInt64LE(BigInt(names.size), 0);
      let index = 0;
      for (const sourceHandle of names.keys()) {
        const offset = 16 + index * 40;
        buffer.writeBigUInt64LE(BigInt(targetPid), offset + 8);
        buffer.writeBigUInt64LE(sourceHandle, offset + 16);
        index += 1;
      }
      return 0;
    },
    DuplicateHandle(_sourceProcess, sourceHandle, _targetProcess, targetHandle, _access, _inherit, options) {
      const source = BigInt(sourceHandle);
      if (options === 2) {
        const local = source + 1000n;
        targetHandle.writeBigUInt64LE(local, 0);
        localToSource.set(local, source);
        return 1;
      }
      if (options === 1) {
        closedSources.push(source);
        return 1;
      }
      return 0;
    },
    NtQueryObject(localHandle, _classId, buffer) {
      const source = localToSource.get(BigInt(localHandle));
      const name = names.get(source) || '';
      const encoded = Buffer.from(name, 'utf16le');
      buffer.writeUInt16LE(encoded.length, 0);
      encoded.copy(buffer, process.arch === 'x64' ? 16 : 8);
      return 0;
    },
  });

  const outcome = native.closeGlobalSingletonHandles([targetPid]);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.closed, 1);
  assert.deepEqual(closedSources, [11n]);
});

test('singleton reservation failure is preserved as an actionable diagnostic', () => {
  assert.deepEqual(
    classifyLaunchFailure('Legacy compatibility could not reserve the Roblox singleton event; no client was launched.'),
    {
      code: 'SINGLETON_GUARD_UNAVAILABLE',
      reason: "Multi-instance compatibility could not reserve Roblox's singleton event. Close Roblox Player and other multi-instance launchers, then retry.",
      actions: ['RETRY', 'VIEW_DIAGNOSTICS'],
    },
  );
});
