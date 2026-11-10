'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const {
  PROTOCOL_KEYS,
  STORE_LEGACY_REASON,
  createDiscoveryEngine,
  normalizePlayerPath,
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

test('upgraded custom installation remains discoverable without overriding a newer compatible player', () => {
  const fixture = makeFixture();
  const store = require('../src/main/store');
  try {
    const custom = fixture.makeClassic(path.join(fixture.root, 'First Last', 'Custom'), 'version-custom');
    const userData = path.join(fixture.root, 'synthetic-state');
    store.configure(userData, null, { assertOwner: () => true });
    store.database().put('documents', 'settings.json', { autoDetect: false, multiInstanceMode: false, robloxPath: custom });
    const migrated = store.getSettings();
    const engine = fixture.makeEngine({ inspectExecutables: paths => paths.map(player => fixture.makeMetadata(player, {
      productVersion: player === custom ? '0.715.0.1' : '0.745.0.1',
    })) });
    assert.equal(migrated.robloxPath, '');
    assert.equal(engine.locate({ autoDetect: true }).found, false);
    assert.equal(engine.locate(migrated).playerPath, custom, 'fallback must participate in the cache key');
    const newer = fixture.makeClassic(fixture.local, 'version-newer');
    assert.equal(engine.locate(migrated, { force: true }).playerPath, newer);
    assert.equal(engine.locate({ ...migrated, robloxDiscoveryPath: 'missing' }, { force: true }).playerPath, newer);
  } finally { store.close(); cleanup(fixture); }
});

test('player paths preserve spaces and punctuation in Windows profile and installation folders', () => {
  const fixture = makeFixture();
  try {
    const profile = path.join(fixture.root, 'Users', "First Last [test] & O'Name \u010Cern\u00FD");
    const playerPath = fixture.makeClassic(profile, 'version with spaces');
    const engine = fixture.makeEngine();
    for (const value of [
      playerPath,
      `"${playerPath}"`,
      `"${playerPath}" -app`,
      `"${playerPath}" "%1"`,
      `"${playerPath}" --example="value with spaces"`,
      `${playerPath} -app`,
      playerPath.split(path.sep).join('/'),
      path.dirname(playerPath),
    ]) {
      assert.equal(normalizePlayerPath(value), playerPath);
      assert.equal(engine.pathStatus(value).ok, true);
    }
    const expanded = playerPath.replace(profile, '%LOCALAPPDATA%');
    assert.equal(normalizePlayerPath(expanded, { env: { LOCALAPPDATA: profile } }), playerPath);
  } finally { cleanup(fixture); }
});

test('encoded file links resolve the actual player beneath a spaced profile without changing literal percent paths', () => {
  const fixture = makeFixture();
  try {
    const profile = path.join(fixture.root, 'Users', 'First Last #1');
    const playerPath = fixture.makeClassic(profile, 'version with spaces');
    const uri = pathToFileURL(playerPath).href;
    assert.equal(normalizePlayerPath(uri), playerPath);
    assert.equal(normalizePlayerPath(`"${uri}"`), playerPath);
    assert.equal(normalizePlayerPath(pathToFileURL(path.dirname(playerPath)).href), playerPath);
    assert.equal(fixture.makeEngine().pathStatus(uri).ok, true);

    const literalPlayer = fixture.makeClassic(path.join(fixture.root, 'First%20Last'), 'version-literal');
    assert.equal(normalizePlayerPath(literalPlayer), literalPlayer);
    assert.equal(normalizePlayerPath(uri + '?download=1'), '');
    assert.equal(normalizePlayerPath(uri + '#fragment'), '');
    assert.equal(normalizePlayerPath(uri.replace('First%20Last', 'First%2FLast')), '');
    assert.equal(normalizePlayerPath('file:///C:/invalid%ZZ/RobloxPlayerBeta.exe'), '');
  } finally { cleanup(fixture); }
});

test('registry command rows preserve the entire unquoted player path when the profile contains spaces', () => {
  const fixture = makeFixture();
  try {
    const profile = path.join(fixture.root, 'Users', 'First Last');
    const playerPath = fixture.makeClassic(profile, 'version-current');
    for (const type of ['REG_SZ', 'REG_EXPAND_SZ']) {
      const data = type === 'REG_EXPAND_SZ' ? playerPath.replace(profile, '%TEST_PROFILE%') : playerPath;
      const output = `HKEY_CURRENT_USER\\Software\\Classes\\roblox-player\\shell\\open\\command\r\n    (Default)    ${type}    ${data} -app\r\n`;
      assert.equal(normalizePlayerPath(output, { env: { TEST_PROFILE: profile } }), playerPath);
      const engine = fixture.makeEngine({
        queryRegistry: () => ({ protocol: output.replace('%TEST_PROFILE%', profile) }),
        inspectExecutables: paths => paths.filter(file => fs.existsSync(file)).map(file => fixture.makeMetadata(file)),
      });
      const location = engine.locate({ autoDetect: true, multiInstanceMode: true });
      assert.equal(location.found, true);
      assert.equal(location.playerPath, playerPath);
      assert.equal(location.source, 'registry');
    }
  } finally { cleanup(fixture); }
});

test('a directory name containing the player executable name does not truncate a real path', () => {
  const fixture = makeFixture();
  try {
    const base = path.join(fixture.root, 'RobloxPlayerBeta.exe backup', 'First Last');
    const playerPath = fixture.makeClassic(base, 'version-current');
    assert.equal(normalizePlayerPath(playerPath), playerPath);
    assert.equal(normalizePlayerPath(path.dirname(playerPath)), playerPath);
    assert.equal(normalizePlayerPath(`${playerPath} -app`), playerPath);
  } finally { cleanup(fixture); }
});

test('normalizing a spaced UNC player path preserves its server prefix without accessing the share', {
  skip: process.platform !== 'win32',
}, () => {
  const playerPath = '\\\\synthetic-server\\Shared Users\\First Last\\RobloxPlayerBeta.exe';
  const fileSystem = { existsSync: () => false };
  assert.equal(normalizePlayerPath(playerPath, { fs: fileSystem }), playerPath);
  assert.equal(normalizePlayerPath(`"${playerPath}" -app`, { fs: fileSystem }), playerPath);
});

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

test('automatic discovery prefers the newer verified player over a stale registry or process entry', () => {
  for (const source of ['registry', 'process']) {
    const fixture = makeFixture();
    try {
      const oldPlayer = fixture.makeClassic(fixture.local, 'version-old-715');
      const newPlayer = fixture.makeClassic(fixture.programFiles, 'version-current-745', 10_000);
      const engine = fixture.makeEngine({
        queryRegistry: () => source === 'registry' ? { protocol: `"${oldPlayer}" -app` } : {},
        inspectProcesses: () => source === 'process' ? [{ name: 'RobloxPlayerBeta.exe', executablePath: oldPlayer }] : [],
        inspectExecutables: paths => paths.map(playerPath => fixture.makeMetadata(playerPath, {
          productVersion: playerPath === path.resolve(oldPlayer) ? '0, 715, 0, 7151110' : '0, 745, 0, 7451110',
        })),
      });
      for (const multiInstanceMode of [true, false]) {
        const location = engine.locate({ autoDetect: true, multiInstanceMode }, { force: true });
        assert.equal(location.playerPath, path.resolve(newPlayer));
        assert.equal(location.source, 'filesystem');
        assert.equal(location.selectedCandidate.verified, true);
      }
    } finally { cleanup(fixture); }
  }
});

test('automatic player version comparison handles numeric and mixed Windows version formats', () => {
  for (const [older, newer] of [
    ['0.99.0.9999999', '0, 100, 0, 1'],
    ['0, 745, 0, 9', '0.745.0.10'],
    ['0.745.0', '0, 745, 0, 1'],
  ]) {
    const fixture = makeFixture();
    try {
      const oldPlayer = fixture.makeClassic(fixture.local, 'version-old');
      const newPlayer = fixture.makeClassic(fixture.programFiles, 'version-new', 10_000);
      const engine = fixture.makeEngine({
        queryRegistry: () => ({ protocol: oldPlayer }),
        inspectExecutables: paths => paths.map(playerPath => fixture.makeMetadata(playerPath, {
          productVersion: playerPath === path.resolve(oldPlayer) ? older : newer,
        })),
      });
      assert.equal(engine.locate({ autoDetect: true, multiInstanceMode: true }).playerPath, path.resolve(newPlayer));
    } finally { cleanup(fixture); }
  }
});

test('newer player discovery preserves an explicit installation or manual-path selection', () => {
  const fixture = makeFixture();
  try {
    const oldPlayer = fixture.makeClassic(fixture.local, 'version-old');
    const newPlayer = fixture.makeClassic(fixture.programFiles, 'version-new');
    const engine = fixture.makeEngine({
      queryRegistry: () => ({ protocol: oldPlayer }),
      inspectExecutables: paths => paths.map(playerPath => fixture.makeMetadata(playerPath, {
        productVersion: playerPath === path.resolve(oldPlayer) ? '0.715.0.7151110' : '0.745.0.7451110',
      })),
    });
    const automatic = engine.locate({ autoDetect: true, multiInstanceMode: true }, { force: true });
    const oldCandidate = automatic.candidates.find(candidate => candidate.playerPath === path.resolve(oldPlayer));
    assert.ok(automatic.candidates.some(candidate => candidate.playerPath === path.resolve(newPlayer)));
    assert.equal(engine.locate({
      autoDetect: true, multiInstanceMode: true, robloxInstallationId: oldCandidate.id,
    }, { force: true }).playerPath, path.resolve(oldPlayer));
    assert.equal(engine.locate({
      autoDetect: false, multiInstanceMode: true, robloxPath: oldPlayer,
    }, { force: true }).playerPath, path.resolve(oldPlayer));
  } finally { cleanup(fixture); }
});

test('unverified newer players are rejected and equal or unknown versions preserve source precedence', () => {
  for (const mode of ['invalid-signature', 'equal-version', 'unknown-version']) {
    const fixture = makeFixture();
    try {
      const registered = fixture.makeClassic(fixture.local, 'version-registered', 10_000);
      fixture.makeClassic(fixture.programFiles, 'version-other');
      const engine = fixture.makeEngine({
        queryRegistry: () => ({ protocol: registered }),
        inspectExecutables: paths => paths.map(playerPath => {
          const isRegistered = playerPath === path.resolve(registered);
          return fixture.makeMetadata(playerPath, {
            productVersion: mode === 'unknown-version' ? 'unknown' : isRegistered || mode === 'equal-version' ? '0.715.0.1' : '0.745.0.1',
            signatureStatus: mode === 'invalid-signature' && !isRegistered ? 'NotSigned' : 'Valid',
          });
        }),
      });
      const location = engine.locate({ autoDetect: true, multiInstanceMode: true });
      assert.equal(location.playerPath, path.resolve(registered));
      if (mode === 'invalid-signature') assert.equal(location.candidates.length, 1);
    } finally { cleanup(fixture); }
  }
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
