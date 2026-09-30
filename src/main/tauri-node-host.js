'use strict';

const readline = require('readline');
const path = require('path');
const { makeBackend } = require('./tauri-backend');
const { migrateLegacyUserData } = require('./legacy-identity-compat');

const appVersion = process.argv[2] || '1.5.0';
const userData = process.argv[3] || path.join(process.cwd(), '.sunday-data');
const releaseTrust = Object.freeze({
  publicKeySpkiBase64: process.argv[4] || '',
  publisher: process.argv[5] || '',
  manifestUrl: process.argv[6] || '',
});

migrateLegacyUserData(userData);

const { spawn } = require('child_process');

function createSafeStorage() {
  const isWin = process.platform === 'win32';
  let dpapiReady = false;
  let koffiMod = null;
  let CryptProtectData = null, CryptUnprotectData = null, LocalFree = null, GetLastError = null;

  if (isWin) {
    try {
      koffiMod = require('koffi');
      const crypt32 = koffiMod.load('crypt32.dll');
      const kernel32 = koffiMod.load('kernel32.dll');

      const DATA_BLOB = koffiMod.struct('DATA_BLOB', {
        cbData: 'uint32',
        pbData: 'uint8*'
      });

      CryptProtectData = crypt32.func('bool __stdcall CryptProtectData(_In_ DATA_BLOB* pDataIn, void* szDataDescr, void* pOptionalEntropy, void* pvReserved, void* pPromptStruct, uint32 dwFlags, _Out_ DATA_BLOB* pDataOut)');
      CryptUnprotectData = crypt32.func('bool __stdcall CryptUnprotectData(_In_ DATA_BLOB* pDataIn, void* ppszDataDescr, void* pOptionalEntropy, void* pvReserved, void* pPromptStruct, uint32 dwFlags, _Out_ DATA_BLOB* pDataOut)');
      LocalFree = kernel32.func('uintptr __stdcall LocalFree(uintptr hMem)');
      GetLastError = kernel32.func('uint32 __stdcall GetLastError()');

      dpapiReady = true;
    } catch (_) {
      dpapiReady = false;
    }
  }

  const CRYPTPROTECT_UI_FORBIDDEN = 0x1;

  return {
    isEncryptionAvailable() {
      return isWin && dpapiReady;
    },
    encryptString(value) {
      if (!isWin || !dpapiReady) {
        throw new Error('Secure storage is only available on Windows.');
      }
      const ownsInput = !Buffer.isBuffer(value);
      const inBuf = ownsInput ? Buffer.from(String(value || ''), 'utf8') : value;
      if (inBuf.length === 0) {
        throw new Error('Value to encrypt cannot be empty.');
      }
      const inBlob = { cbData: inBuf.length, pbData: inBuf };
      const outBlob = { cbData: 0, pbData: null };

      const ok = CryptProtectData(inBlob, null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, outBlob);
      if (!ok) {
        const code = GetLastError ? GetLastError() : 0;
        throw new Error('DPAPI protect failed: Win32 error ' + code);
      }

      try {
        return Buffer.from(koffiMod.decode(outBlob.pbData, koffiMod.array('uint8', outBlob.cbData)));
      } finally {
        if (ownsInput) inBuf.fill(0);
        if (outBlob.pbData) {
          LocalFree(koffiMod.address(outBlob.pbData));
        }
      }
    },
    decryptString(buffer) {
      if (!isWin || !dpapiReady) {
        throw new Error('Secure storage is only available on Windows.');
      }
      let inBuf;
      if (Buffer.isBuffer(buffer)) {
        inBuf = Buffer.from(buffer);
      } else if (typeof buffer === 'string') {
        inBuf = Buffer.from(buffer, 'base64');
      } else {
        inBuf = Buffer.from(String(buffer || ''), 'utf8');
      }
      if (inBuf.length === 0) {
        throw new Error('Buffer to decrypt cannot be empty.');
      }

      const inBlob = { cbData: inBuf.length, pbData: inBuf };
      const outBlob = { cbData: 0, pbData: null };

      const ok = CryptUnprotectData(inBlob, null, null, null, null, CRYPTPROTECT_UI_FORBIDDEN, outBlob);
      if (!ok) {
        const code = GetLastError ? GetLastError() : 0;
        throw new Error('DPAPI unprotect failed: Win32 error ' + code);
      }

      try {
        const decBuf = Buffer.from(koffiMod.decode(outBlob.pbData, koffiMod.array('uint8', outBlob.cbData)));
        try { return decBuf.toString('utf8'); }
        finally { decBuf.fill(0); }
      } finally {
        inBuf.fill(0);
        if (outBlob.pbData) {
          LocalFree(koffiMod.address(outBlob.pbData));
        }
      }
    },
  };
}

const safeStorage = createSafeStorage();

async function openPath(target) {
  return new Promise((resolve, reject) => {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const explorer = path.join(sysRoot, 'explorer.exe');
    const child = spawn(explorer, [String(target)], { windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', resolve);
    child.unref();
  });
}

async function openExternal(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch (_) {
    throw new Error('Invalid URL format');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Only https URLs are allowed');
  }
  const allowedHosts = new Set(['www.roblox.com', 'github.com']);
  if (parsed.username || parsed.password || parsed.port || !allowedHosts.has(parsed.hostname.toLowerCase())) {
    throw new Error('External URL is not allowlisted');
  }
  return new Promise((resolve, reject) => {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const rundll = path.join(sysRoot, 'System32', 'rundll32.exe');
    const child = spawn(rundll, ['url.dll,FileProtocolHandler', parsed.href], { windowsHide: true, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', resolve);
    child.unref();
  });
}

async function pickFile() {
  const { spawn } = require('child_process');
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dlg = New-Object System.Windows.Forms.OpenFileDialog',
    "$dlg.Title = 'Select RobloxPlayerBeta.exe'",
    "$dlg.Filter = 'RobloxPlayerBeta.exe|RobloxPlayerBeta.exe|Executable files (*.exe)|*.exe|All files (*.*)|*.*'",
    "$dlg.FileName = 'RobloxPlayerBeta.exe'",
    "$dlg.CheckFileExists = $true",
    "$dlg.Multiselect = $false",
    'if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::OutputEncoding = [Text.UTF8Encoding]::UTF8; Write-Output $dlg.FileName }',
  ].join('; ');
  return new Promise((resolve) => {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const powershell = path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], { windowsHide: true });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk.toString('utf8'); });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const picked = out.trim().split(/\r?\n/).filter(Boolean).pop();
      resolve(picked || null);
    });
  });
}

function emit(event, payload) {
  process.stdout.write(JSON.stringify({ event, payload }) + '\n');
}

const backend = makeBackend({
  appVersion,
  userData,
  emit,
  openPath,
  openExternal,
  pickFile,
  safeStorage,
  releaseTrust,
});

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    process.stdout.write(JSON.stringify({ id: null, ok: false, error: 'Invalid JSON: ' + err.message }) + '\n');
    return;
  }

  const id = msg && msg.id;
  const command = msg && msg.command;
  const payload = msg && msg.payload;

  if (command === 'shutdown') {
    try { await backend.shutdown(); } catch (_) {}
    process.stdout.write(JSON.stringify({ id, ok: true, result: { ok: true } }) + '\n');
    process.exit(0);
    return;
  }

  try {
    const result = await backend.invoke(command, payload || {});
    process.stdout.write(JSON.stringify({ id, ok: true, result }) + '\n');
  } catch (err) {
    process.stdout.write(JSON.stringify({ id, ok: false, error: (err && err.message) || String(err) }) + '\n');
  }
});

rl.on('close', async () => {
  try { await backend.shutdown(); } catch (_) {}
  process.exit(0);
});
