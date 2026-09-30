import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, '..');
const manifestPath = path.join(root, 'dist', 'sunday-release.json');
if (fs.existsSync(manifestPath)) {
  throw new Error('Refusing to overwrite an existing dist/sunday-release.json qualification target.');
}
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const baseEnvironment = {
  ...process.env,
  SUNDAY_RELEASE_SEQUENCE: '1814',
  SUNDAY_RELEASE_PUBLIC_KEY_SPKI_B64: publicKey
    .export({ type: 'spki', format: 'der' })
    .toString('base64'),
  SUNDAY_RELEASE_PUBLISHER: 'CN=SUNDAY Local Qualification Only',
  SUNDAY_RELEASE_KEY_ID: 'local-qualification-key',
};
const run = (script, env) => spawnSync(process.execPath, [path.join(scriptDirectory, script)], {
  cwd: root,
  env,
  encoding: 'utf8',
  windowsHide: true,
});

try {
  const missingKey = run('create-release-manifest.mjs', baseEnvironment);
  if (missingKey.status === 0 || !/SUNDAY_RELEASE_PRIVATE_KEY_PKCS8_B64 is required/.test(missingKey.stderr)) {
    throw new Error('Release manifest generation did not fail closed without a private signing key.');
  }
  const environment = {
    ...baseEnvironment,
    SUNDAY_RELEASE_PRIVATE_KEY_PKCS8_B64: privateKey
      .export({ type: 'pkcs8', format: 'der' })
      .toString('base64'),
  };
  const generated = run('create-release-manifest.mjs', environment);
  if (generated.status !== 0) throw new Error(generated.stderr || generated.stdout || 'Manifest generation failed.');
  const verified = run('verify-release-manifest.mjs', environment);
  if (verified.status !== 0) throw new Error(verified.stderr || verified.stdout || 'Manifest verification failed.');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (Buffer.from(manifest.signature, 'base64').length !== 64) {
    throw new Error('Qualified manifest did not contain an Ed25519 signature.');
  }
  process.stdout.write([
    generated.stdout.trim(),
    verified.stdout.trim(),
    `Qualified ${manifest.product} ${manifest.version}, sequence ${manifest.releaseSequence}, ${manifest.artifacts.length} artifacts.`,
  ].filter(Boolean).join('\n') + '\n');
} finally {
  if (fs.existsSync(manifestPath)) fs.rmSync(manifestPath);
}
