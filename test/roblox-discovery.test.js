'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PROTOCOL_KEYS,
  STORE_LEGACY_REASON,
  createDiscoveryEngine,
  sanitizeLocation,
} = require('../src/main/roblox');

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sunday-roblox-discovery-'));
  const local = path.join(root, 'Local');
  const programFiles = path.join(root, 'Program Files');
  const programFilesX86 = path.join(root, 'Program Files (x86)');
  const programData = path.join(root, 'ProgramData');
  for (const directory of [local, programFiles, programFilesX86, programData]) fs.mkdirSync(directory, { recursive: true });
  const makeClassic = (base, version, ageMs = 0) => {
    const directory = path.join(base, 'Roblox', 'Versions', version);
    fs.mkdirSync(directory, { recursive: true });
    const playerPath = path.join(directory, 'RobloxPlayerBeta.exe');
    fs.writeFileSync(playerPath, `synthetic-${version}`);
    const timestamp = new Date(Date.now() - ageMs);
    fs.utimesSync(playerPath, timestamp, timestamp);
    return playerPath;
  };
  const makeMetadata = (playerPath, overrides = {}) => {
    const stat = fs.statSync(playerPath);
    return Object.assign({
      path: playerPath,
      length: stat.size,
      lastWriteTimeUtc: stat.mtime.toISOString(),
      companyName: 'Roblox Corporation',
      productName: 'Roblox',
      fileVersion: '1.2.3.4',
      productVersion: '1.2.3.4',
      signatureStatus: 'Valid',
      signerSubject: 'CN=Roblox Corporation, O=Roblox Corporation, C=US',
    }, overrides);
  };
  const makeEngine = overrides => createDiscoveryEngine(Object.assign({
    env: {
      SystemRoot: 'C:\\Windows',
      LOCALAPPDATA: local,
      ProgramFiles: programFiles,
      'ProgramFiles(x86)': programFilesX86,
      ProgramData: programData,
    },
    queryRegistry: () => ({}),
    inspectProcesses: () => [],
    inspectAppxPackages: () => [],
    inspectExecutables: paths => paths.map(playerPath => makeMetadata(playerPath)),
  }, overrides || {}));
  return { root, local, programFiles, programFilesX86, programData, makeClassic, makeMetadata, makeEngine };
}

function cleanup(fixture) {
  fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

test('classic discovery verifies publisher identity, merges evidence, and prefers protocol registration', () => {
  const fixture = makeFixture();
  try {
    const playerPath = fixture.makeClassic(fixture.local, 'version-current');
    const engine = fixture.makeEngine({
      queryRegistry: keys => {
        assert.deepEqual(keys, PROTOCOL_KEYS);
        return { [keys[1]]: `"${playerPath}" -app` };
      },
      inspectProcesses: () => [{ name: 'RobloxPlayerBeta.exe', executablePath: playerPath }],
    });
    const location = engine.locate({ autoDetect: true, multiInstanceMode: true }, { force: true });
    assert.equal(location.found, true);
    assert.equal(location.playerPath, path.resolve(playerPath));
    assert.equal(location.source, 'registry');
    assert.equal(location.selectedCandidate.legacyCompatible, true);
    assert.deepEqual(location.candidates[0].sources.sort(), ['filesystem', 'process', 'registry']);
  } finally { cleanup(fixture); }
});

test('bounded classic roots include LocalAppData, both Program Files roots, and ProgramData', () => {
  const fixture = makeFixture();
  try {
    const installations = [
      fixture.makeClassic(fixture.local, 'version-local', 4000),
      fixture.makeClassic(fixture.programFiles, 'version-program-files', 3000),
      fixture.makeClassic(fixture.programFilesX86, 'version-program-files-x86', 2000),
      fixture.makeClassic(fixture.programData, 'version-program-data', 1000),
    ];
    const engine = fixture.makeEngine();
    const location = engine.locate({ autoDetect: true, multiInstanceMode: true }, { force: true });
    assert.equal(location.candidates.length, 4);
    assert.deepEqual(
      new Set(location.candidates.map(candidate => candidate.playerPath)),
      new Set(installations.map(candidatePath => path.resolve(candidatePath))),
    );
    assert.equal(location.playerPath, path.resolve(installations[3]), 'newest verified classic candidate should win a source tie');
  } finally { cleanup(fixture); }
});

test('spoofed names, invalid signatures, non-Roblox products, and Roblox Studio are rejected', () => {
  const fixture = makeFixture();
  try {
    const badSignature = fixture.makeClassic(fixture.local, 'version-bad-signature');
    const badCompany = fixture.makeClassic(fixture.programFiles, 'version-bad-company');
    const studio = fixture.makeClassic(fixture.programFilesX86, 'version-studio');
    const engine = fixture.makeEngine({
      inspectExecutables: paths => paths.map(playerPath => {
        if (playerPath === path.resolve(badSignature)) return fixture.makeMetadata(playerPath, { signatureStatus: 'NotSigned' });
        if (playerPath === path.resolve(badCompany)) return fixture.makeMetadata(playerPath, { companyName: 'Not Roblox', signerSubject: 'CN=Not Roblox' });
        return fixture.makeMetadata(playerPath, { productName: 'Roblox Studio' });
      }),
    });
    const location = engine.locate({ autoDetect: true, multiInstanceMode: true }, { force: true });
    assert.equal(location.found, false);
    assert.deepEqual(location.candidates, []);
  } finally { cleanup(fixture); }
});

test('manual selection is strict and manual-only mode does not silently fall back', () => {
  const fixture = makeFixture();
  try {
    const automatic = fixture.makeClassic(fixture.local, 'version-auto');
    const invalidManual = path.join(fixture.root, 'not-roblox.exe');
    fs.writeFileSync(invalidManual, 'synthetic');
    const engine = fixture.makeEngine();
    const location = engine.locate({ robloxPath: invalidManual, autoDetect: false, multiInstanceMode: true }, { force: true });
    assert.equal(location.found, false);
    assert.match(location.detectionWarnings.join(' '), /manual Roblox path|could not be verified/i);
    assert.equal(engine.pathStatus(automatic).ok, true);
  } finally { cleanup(fixture); }
});

test('Microsoft Store discovery uses registered package metadata and is explicitly incompatible with legacy mode', () => {
  const fixture = makeFixture();
  try {
    const installLocation = path.join(fixture.root, 'WindowsApps', 'ROBLOXCORPORATION.ROBLOX_1.2.3.4_x64');
    fs.mkdirSync(installLocation, { recursive: true });
    const engine = fixture.makeEngine({
      inspectExecutables: () => [],
      inspectAppxPackages: () => [{
        packageFullName: 'ROBLOXCORPORATION.ROBLOX_1.2.3.4_x64__55nm5eh3cm0pr',
        packageFamilyName: 'ROBLOXCORPORATION.ROBLOX_55nm5eh3cm0pr',
        identityName: 'ROBLOXCORPORATION.ROBLOX',
        publisher: 'CN=Roblox Corporation, O=Roblox Corporation, C=US',
        version: '1.2.3.4',
        installLocation,
        displayName: 'Roblox - Windows',
        applications: [{ id: 'App', aumid: 'ROBLOXCORPORATION.ROBLOX_55nm5eh3cm0pr!App', displayName: 'Roblox - Windows', executable: '', entryPoint: 'Windows.FullTrustApplication' }],
      }],
    });
    const location = engine.locate({ autoDetect: true, multiInstanceMode: true }, { force: true });
    assert.equal(location.found, true);
    assert.equal(location.playerPath, null);
    assert.equal(location.activationId, 'ROBLOXCORPORATION.ROBLOX_55nm5eh3cm0pr!App');
    assert.equal(location.selectedCandidate.kind, 'microsoft-store-appx');
    assert.equal(location.selectedCandidate.legacyCompatible, false);
    assert.equal(location.selectedCandidate.compatibilityReason, STORE_LEGACY_REASON);
    assert.equal(location.selectedCandidate.displayName, 'Roblox - Windows');
  } finally { cleanup(fixture); }
});

test('invalid, missing, non-Roblox, and Studio packages are rejected', () => {
  const fixture = makeFixture();
  try {
    const validDirectory = path.join(fixture.root, 'OtherVolume', 'WindowsApps', 'Fixture');
    fs.mkdirSync(validDirectory, { recursive: true });
    const engine = fixture.makeEngine({
      inspectExecutables: () => [],
      inspectAppxPackages: () => [
        { identityName: 'RobloxStudio', displayName: 'Roblox Studio', publisher: 'CN=Roblox Corporation', installLocation: validDirectory, applications: [{ id: 'Studio', aumid: 'studio!Studio' }] },
        { identityName: 'Unrelated', displayName: 'Game', publisher: 'CN=Roblox Corporation', installLocation: validDirectory, applications: [{ id: 'App', aumid: 'game!App' }] },
        { identityName: 'Roblox.Windows', displayName: 'Roblox - Windows', publisher: 'CN=Unknown Publisher', installLocation: validDirectory, applications: [{ id: 'App', aumid: 'roblox!App' }] },
        { identityName: 'Roblox.Windows', displayName: 'Roblox - Windows', publisher: 'CN=Roblox Corporation', installLocation: path.join(fixture.root, 'missing'), applications: [{ id: 'App', aumid: 'roblox!App' }] },
        { identityName: 'Roblox.Windows', displayName: 'Roblox - Windows', publisher: 'CN=Roblox Corporation', installLocation: validDirectory, applications: [] },
      ],
    });
    const location = engine.locate({ autoDetect: true, multiInstanceMode: true }, { force: true });
    assert.equal(location.found, false);
    assert.deepEqual(location.candidates, []);
  } finally { cleanup(fixture); }
});

test('classic installation outranks Store for multi-instance but an explicit candidate selection is preserved', () => {
  const fixture = makeFixture();
  try {
    const playerPath = fixture.makeClassic(fixture.local, 'version-classic');
    const installLocation = path.join(fixture.root, 'WindowsApps', 'RobloxStore');
    fs.mkdirSync(installLocation, { recursive: true });
    const appx = {
      packageFullName: 'ROBLOXCORPORATION.ROBLOX_2.0.0.0_x64__55nm5eh3cm0pr',
      packageFamilyName: 'ROBLOXCORPORATION.ROBLOX_55nm5eh3cm0pr',
      identityName: 'ROBLOXCORPORATION.ROBLOX',
      publisher: 'CN=Roblox Corporation, O=Roblox Corporation, C=US',
      version: '2.0.0.0',
      installLocation,
      applications: [{ id: 'App', aumid: 'ROBLOXCORPORATION.ROBLOX_55nm5eh3cm0pr!App', displayName: 'Roblox' }],
    };
    const engine = fixture.makeEngine({ inspectAppxPackages: () => [appx] });
    const automatic = engine.locate({ autoDetect: true, multiInstanceMode: true }, { force: true });
    assert.equal(automatic.playerPath, path.resolve(playerPath));
    const storeCandidate = automatic.candidates.find(candidate => candidate.kind === 'microsoft-store-appx');
    const selected = engine.locate({ autoDetect: true, multiInstanceMode: true, robloxInstallationId: storeCandidate.id }, { force: true });
    assert.equal(selected.selectedCandidate.id, storeCandidate.id);
    assert.equal(selected.selectedCandidate.legacyCompatible, false);
  } finally { cleanup(fixture); }
});

test('manual override has precedence over registry, process, and newer filesystem candidates', () => {
  const fixture = makeFixture();
  try {
    const manual = fixture.makeClassic(fixture.programData, 'version-manual', 10_000);
    const automatic = fixture.makeClassic(fixture.local, 'version-auto');
    const engine = fixture.makeEngine({
      queryRegistry: () => ({ protocol: `"${automatic}"` }),
      inspectProcesses: () => [{ name: 'RobloxPlayerBeta.exe', executablePath: automatic }],
    });
    const location = engine.locate({ robloxPath: manual, autoDetect: true, multiInstanceMode: true }, { force: true });
    assert.equal(location.playerPath, path.resolve(manual));
    assert.equal(location.source, 'manual');
  } finally { cleanup(fixture); }
});

test('a stale AppX registration is invalidated when its dynamic install location disappears', () => {
  const fixture = makeFixture();
  try {
    const installLocation = path.join(fixture.root, 'D-package-volume', 'WindowsApps', 'RobloxWindows');
    fs.mkdirSync(installLocation, { recursive: true });
    let inspections = 0;
    const engine = fixture.makeEngine({
      inspectExecutables: () => [],
      inspectAppxPackages: () => {
        inspections += 1;
        return [{
          identityName: 'Roblox.Windows', displayName: 'Roblox - Windows', publisher: 'CN=Roblox Corporation',
          installLocation, version: '3.0.0.0', packageFamilyName: 'fixture_family', packageFullName: 'fixture_full',
          applications: [{ id: 'Player', aumid: 'fixture_family!Player' }],
        }];
      },
    });
    const settings = { autoDetect: true, multiInstanceMode: true };
    assert.equal(engine.locate(settings).found, true);
    fs.rmSync(installLocation, { recursive: true, force: true });
    assert.equal(engine.locate(settings).found, false);
    assert.equal(inspections, 2);
  } finally { cleanup(fixture); }
});

test('cache is bounded, validates file evidence, and explicit invalidation re-runs discovery', () => {
  const fixture = makeFixture();
  try {
    const playerPath = fixture.makeClassic(fixture.local, 'version-cache');
    let inspections = 0;
    let now = 1000;
    const engine = fixture.makeEngine({
      now: () => now,
      inspectExecutables: paths => {
        inspections += 1;
        return paths.map(candidatePath => fixture.makeMetadata(candidatePath));
      },
    });
    const settings = { autoDetect: true, multiInstanceMode: true };
    assert.equal(engine.locate(settings).found, true);
    assert.equal(engine.locate(settings).found, true);
    assert.equal(inspections, 1);
    engine.invalidateCache();
    assert.equal(engine.locate(settings).found, true);
    assert.equal(inspections, 2);
    fs.appendFileSync(playerPath, '-changed');
    now += 1;
    assert.equal(engine.locate(settings).found, true);
    assert.equal(inspections, 3);
  } finally { cleanup(fixture); }
});

test('renderer-safe discovery metadata never includes installation paths or package install locations', () => {
  const fixture = makeFixture();
  try {
    const playerPath = fixture.makeClassic(fixture.local, 'version-private-path');
    const engine = fixture.makeEngine();
    const safe = sanitizeLocation(engine.locate({ autoDetect: true, multiInstanceMode: true }, { force: true }));
    const serialized = JSON.stringify(safe);
    assert.equal(safe.found, true);
    assert.doesNotMatch(serialized, /sunday-roblox-discovery-|RobloxPlayerBeta\.exe|installLocation|playerPath/i);
    assert.match(serialized, /Classic Roblox Player/);
    assert.ok(playerPath);
  } finally { cleanup(fixture); }
});
