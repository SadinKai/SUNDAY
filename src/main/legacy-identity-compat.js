'use strict';

// All pre-SUNDAY product identity strings used for one-time data migration live
// in this compatibility boundary. Active runtime code must not import these
// values for naming new files, directories, globals, or environment variables.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEGACY_APP_IDENTIFIER = 'com.toluwa.fleet';
const LEGACY_DEV_DATA_DIRECTORY = '.fleet-data';
const LEGACY_STATE_DATABASE = 'fleet-state.sqlite3';
const LEGACY_RELEASE_PRODUCT = 'Fleet';
const CURRENT_STATE_DATABASE = 'sunday-state.sqlite3';
const MIGRATION_MARKER = 'sunday-identity-migration-v1.json';
const DURABLE_JSON_FILES = Object.freeze([
  'accounts.json',
  'settings.json',
  'profiles.json',
  'history.json',
  'keeper.json',
  'playtime.json',
]);

function sha256(file) {
  const digest = crypto.createHash('sha256');
  const descriptor = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      digest.update(buffer.subarray(0, count));
    }
  } finally {
    buffer.fill(0);
    fs.closeSync(descriptor);
  }
  return digest.digest('hex');
}

function assertPlainFile(file) {
  const metadata = fs.lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Legacy identity migration refused a non-plain file: ${path.basename(file)}`);
  }
}

function copyVerified(source, destination) {
  assertPlainFile(source);
  const temporary = `${destination}.migrating-${process.pid}`;
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  try {
    assertPlainFile(temporary);
    const sourceSize = fs.statSync(source).size;
    const destinationSize = fs.statSync(temporary).size;
    if (sourceSize !== destinationSize || sha256(source) !== sha256(temporary)) {
      throw new Error(`Legacy identity migration verification failed for ${path.basename(source)}`);
    }
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}

function defaultLegacyRoot(currentRoot) {
  const current = path.resolve(currentRoot);
  const parent = path.dirname(current);
  return path.basename(current).toLowerCase() === '.sunday-data'
    ? path.join(parent, LEGACY_DEV_DATA_DIRECTORY)
    : path.join(parent, LEGACY_APP_IDENTIFIER);
}

function migrateLegacyUserData(currentRoot, options) {
  const targetRoot = path.resolve(String(currentRoot || ''));
  if (!path.isAbsolute(targetRoot) || !path.basename(targetRoot)) {
    throw new Error('SUNDAY user-data migration requires an absolute target root.');
  }
  const sourceRoot = path.resolve(String(options && options.legacyRoot || defaultLegacyRoot(targetRoot)));
  if (sourceRoot.toLowerCase() === targetRoot.toLowerCase() || !fs.existsSync(sourceRoot)) {
    return { migrated: false, reason: 'legacy-root-absent' };
  }
  const sourceMetadata = fs.lstatSync(sourceRoot);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error('Legacy identity migration refused a non-directory source root.');
  }
  fs.mkdirSync(targetRoot, { recursive: true });
  const targetMetadata = fs.lstatSync(targetRoot);
  if (!targetMetadata.isDirectory() || targetMetadata.isSymbolicLink()) {
    throw new Error('Legacy identity migration refused a non-directory target root.');
  }

  const marker = path.join(targetRoot, MIGRATION_MARKER);
  if (fs.existsSync(marker)) return { migrated: false, reason: 'already-migrated', marker };

  const legacyDatabase = path.join(sourceRoot, LEGACY_STATE_DATABASE);
  const currentDatabase = path.join(targetRoot, CURRENT_STATE_DATABASE);
  if (fs.existsSync(currentDatabase)) return { migrated: false, reason: 'current-state-exists' };
  if (fs.existsSync(`${legacyDatabase}-wal`) || fs.existsSync(`${legacyDatabase}-shm`)) {
    throw new Error('Legacy state has active SQLite sidecars; close the prior application before migration.');
  }

  const migratedFiles = [];
  if (fs.existsSync(legacyDatabase)) {
    copyVerified(legacyDatabase, currentDatabase);
    migratedFiles.push(`${LEGACY_STATE_DATABASE} -> ${CURRENT_STATE_DATABASE}`);
  }
  for (const name of DURABLE_JSON_FILES) {
    const source = path.join(sourceRoot, name);
    const destination = path.join(targetRoot, name);
    if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
    copyVerified(source, destination);
    migratedFiles.push(name);
  }
  if (migratedFiles.length === 0) return { migrated: false, reason: 'no-durable-state' };

  const document = {
    schemaVersion: 1,
    migratedAt: new Date().toISOString(),
    sourceApplicationId: LEGACY_APP_IDENTIFIER,
    sourceRoot,
    targetRoot,
    files: migratedFiles,
    sourcePreserved: true,
  };
  const temporaryMarker = `${marker}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryMarker, JSON.stringify(document, null, 2), { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temporaryMarker, marker);
  return { migrated: true, marker, files: migratedFiles, sourcePreserved: true };
}

module.exports = {
  CURRENT_STATE_DATABASE,
  LEGACY_APP_IDENTIFIER,
  LEGACY_RELEASE_PRODUCT,
  LEGACY_STATE_DATABASE,
  MIGRATION_MARKER,
  defaultLegacyRoot,
  migrateLegacyUserData,
};
