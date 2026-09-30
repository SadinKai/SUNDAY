import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new Error(`Canonical JSON cannot encode ${typeof value}.`);
}

function sha256(file) {
  const digest = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      digest.update(buffer.subarray(0, count));
    }
  } finally {
    buffer.fill(0);
    fs.closeSync(descriptor);
  }
  return digest.digest('hex');
}

function inventory(root, current = root, output = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`Release tree contains a link: ${full}`);
    if (entry.isDirectory()) inventory(root, full, output);
    else if (entry.isFile()) {
      output.push({
        path: path.relative(root, full).split(path.sep).join('/'),
        size: stat.size,
        sha256: sha256(full),
      });
    } else throw new Error(`Release tree contains an unsupported entry: ${full}`);
  }
  return output.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, '..');
const releaseDirectory = path.join(root, 'dist');
const packageDocument = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(packageDocument.version || '');
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('package.json contains an invalid release version.');
}
const releaseSequence = Number(required('SUNDAY_RELEASE_SEQUENCE'));
if (!Number.isSafeInteger(releaseSequence) || releaseSequence <= 0) {
  throw new Error('SUNDAY_RELEASE_SEQUENCE must be a positive safe integer.');
}
const publisher = required('SUNDAY_RELEASE_PUBLISHER');
const keyId = required('SUNDAY_RELEASE_KEY_ID');
if (!/^[A-Za-z0-9._-]{1,80}$/.test(keyId)) throw new Error('SUNDAY_RELEASE_KEY_ID is invalid.');
const baseUrl = String(process.env.SUNDAY_RELEASE_BASE_URL
  || `https://github.com/SadinKai/SUNDAY/releases/download/v${version}`).replace(/\/$/, '');
const parsedBase = new URL(baseUrl);
if (parsedBase.protocol !== 'https:' || parsedBase.hostname !== 'github.com'
    || parsedBase.username || parsedBase.password || parsedBase.search || parsedBase.hash) {
  throw new Error('SUNDAY_RELEASE_BASE_URL must be an HTTPS github.com release URL without credentials or query state.');
}

const portableName = `SundayPortable_${version}_x64.zip`;
const artifacts = [
  {
    name: portableName,
    file: path.join(releaseDirectory, portableName),
    allowedFiles: inventory(path.join(releaseDirectory, 'Sunday')),
  },
  {
    name: 'SundayInstaller.exe',
    file: path.join(releaseDirectory, 'SundayInstaller.exe'),
    allowedFiles: [{
      path: 'SundayInstaller.exe',
      size: fs.statSync(path.join(releaseDirectory, 'SundayInstaller.exe')).size,
      sha256: sha256(path.join(releaseDirectory, 'SundayInstaller.exe')),
    }],
  },
].map(artifact => {
  const stat = fs.statSync(artifact.file);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`Release artifact is missing: ${artifact.file}`);
  return {
    name: artifact.name,
    url: `${baseUrl}/${encodeURIComponent(artifact.name)}`,
    sha256: sha256(artifact.file),
    size: stat.size,
    allowedFiles: artifact.allowedFiles,
  };
});

const privateBytes = Buffer.from(required('SUNDAY_RELEASE_PRIVATE_KEY_PKCS8_B64'), 'base64');
let privateKey;
try {
  privateKey = crypto.createPrivateKey({ key: privateBytes, format: 'der', type: 'pkcs8' });
} finally {
  privateBytes.fill(0);
}
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Release manifest key must be Ed25519.');
const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
const embeddedPublic = Buffer.from(required('SUNDAY_RELEASE_PUBLIC_KEY_SPKI_B64'), 'base64');
if (publicKey.length !== embeddedPublic.length || !crypto.timingSafeEqual(publicKey, embeddedPublic)) {
  throw new Error('Release private key does not match the embedded public trust anchor.');
}

const manifest = {
  schemaVersion: 1,
  product: 'SUNDAY Launcher',
  version,
  releaseSequence,
  artifacts,
  signing: { algorithm: 'Ed25519', keyId, publisher },
  signature: '',
};
manifest.signature = crypto.sign(
  null,
  Buffer.from(canonicalize(Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'signature')))),
  privateKey,
).toString('base64');
const verified = crypto.verify(
  null,
  Buffer.from(canonicalize(Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'signature')))),
  crypto.createPublicKey(privateKey),
  Buffer.from(manifest.signature, 'base64'),
);
if (!verified) throw new Error('Release manifest self-verification failed.');

const output = path.resolve(process.argv[2] || path.join(releaseDirectory, 'sunday-release.json'));
if (path.dirname(output) !== releaseDirectory) throw new Error('Release manifest output must stay in dist/.');
const temporary = `${output}.${process.pid}.tmp`;
fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
fs.renameSync(temporary, output);
process.stdout.write(`Wrote signed SUNDAY Launcher release manifest: ${output}\n`);
