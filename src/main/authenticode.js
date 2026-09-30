'use strict';

const path = require('path');
const { execFile } = require('child_process');

const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$s = Get-AuthenticodeSignature -LiteralPath $env:SUNDAY_VERIFY_FILE',
  '[pscustomobject]@{ Status = [string]$s.Status; Subject = if ($s.SignerCertificate) { [string]$s.SignerCertificate.Subject } else { "" }; Thumbprint = if ($s.SignerCertificate) { [string]$s.SignerCertificate.Thumbprint } else { "" } } | ConvertTo-Json -Compress',
].join('; ');

function verifyAuthenticode(file, expectedPublisher, options) {
  const target = path.resolve(String(file || ''));
  const publisher = String(expectedPublisher || '').trim();
  if (!path.isAbsolute(target) || !publisher) return Promise.reject(new Error('Authenticode verification requires an absolute file and publisher.'));
  return new Promise((resolve, reject) => {
    const env = Object.assign({}, process.env, { SUNDAY_VERIFY_FILE: target });
    const child = execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
      windowsHide: true,
      timeout: Math.max(1000, Number(options && options.timeoutMs) || 15000),
      encoding: 'utf8',
      env,
      maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      if (error) return reject(new Error('Authenticode verification could not be completed.'));
      let result;
      try { result = JSON.parse(String(stdout || '').trim()); }
      catch (_) { return reject(new Error('Authenticode verifier returned an invalid result.')); }
      if (result.Status !== 'Valid') return reject(new Error('Authenticode signature is not valid.'));
      if (String(result.Subject || '') !== publisher) return reject(new Error('Authenticode publisher does not match the embedded identity.'));
      resolve({ ok: true, publisher: result.Subject, thumbprint: String(result.Thumbprint || '').toUpperCase() });
    });
    child.once('error', () => reject(new Error('Authenticode verifier could not be started.')));
  });
}

module.exports = { verifyAuthenticode, POWERSHELL };
