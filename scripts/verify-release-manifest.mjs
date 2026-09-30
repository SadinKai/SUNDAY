import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { parseAndVerifyManifest, verifyArtifactBuffer } = require('../src/main/release-trust');
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, '..');
const releaseDirectory = path.join(root, 'dist');
const manifestPath = path.join(releaseDirectory, 'sunday-release.json');
const packageDocument = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const publisher = String(process.env.SUNDAY_RELEASE_PUBLISHER || '').trim();
const publicKeySpkiBase64 = String(process.env.SUNDAY_RELEASE_PUBLIC_KEY_SPKI_B64 || '').trim();
if (!publisher || !publicKeySpkiBase64) throw new Error('Release verification trust is not configured.');
const manifest = parseAndVerifyManifest(fs.readFileSync(manifestPath, 'utf8'), {
  publisher,
  publicKeySpkiBase64,
  minimumSequence: 0,
});
if (manifest.version !== packageDocument.version) {
  throw new Error('Signed manifest version does not match package.json.');
}
for (const artifact of manifest.artifacts) {
  const file = path.join(releaseDirectory, artifact.name);
  if (path.dirname(file) !== releaseDirectory || !fs.statSync(file).isFile()) {
    throw new Error(`Signed release artifact is missing: ${artifact.name}`);
  }
  verifyArtifactBuffer(fs.readFileSync(file), artifact);
}
process.stdout.write(`Verified signed SUNDAY Launcher release manifest sequence ${manifest.releaseSequence}.\n`);
