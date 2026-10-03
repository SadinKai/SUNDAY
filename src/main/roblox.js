'use strict';

/**
 * Roblox installation discovery.
 *
 * This module discovers evidence; it never adopts a running Roblox process and
 * never mutates an installation. Classic Win32 candidates must pass local file
 * identity and Authenticode publisher checks. Microsoft Store candidates must
 * come from registered AppX/MSIX package metadata. Only a private backend
 * result contains paths; renderer-facing callers must use sanitizeLocation().
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PLAYER_EXE = 'RobloxPlayerBeta.exe';
const CACHE_TTL_MS = 60_000;
const POWERSHELL_TIMEOUT_MS = 8_000;
const REGISTRY_TIMEOUT_MS = 4_000;
const MAX_PROCESS_OUTPUT = 1024 * 1024;
const ROBLOX_COMPANY = 'Roblox Corporation';
const STORE_LEGACY_REASON = 'Microsoft Store Roblox was detected, but SUNDAY legacy multi-instance mode supports the classic Roblox Player only. Install Roblox Player from roblox.com or choose a verified classic installation.';

const PROTOCOL_KEYS = [
  'HKCU\\Software\\Classes\\roblox-player\\shell\\open\\command',
  'HKCU\\Software\\Classes\\roblox\\shell\\open\\command',
  'HKLM\\Software\\Classes\\roblox-player\\shell\\open\\command',
  'HKLM\\Software\\Classes\\roblox\\shell\\open\\command',
  'HKCR\\roblox-player\\shell\\open\\command',
  'HKCR\\roblox\\shell\\open\\command',
];

const EXECUTABLE_INSPECTION_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Import-Module (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop",
  "$paths = ConvertFrom-Json $env:SUNDAY_ROBLOX_CANDIDATES",
  '$items = @()',
  'foreach ($candidatePath in @($paths)) {',
  '  try {',
  '    $item = Get-Item -LiteralPath ([string]$candidatePath) -ErrorAction Stop',
  '    if ($item.PSIsContainer) { continue }',
  '    $signature = Get-AuthenticodeSignature -LiteralPath $item.FullName',
  '    $version = $item.VersionInfo',
  '    $items += [pscustomobject]@{',
  '      path = $item.FullName',
  '      length = [int64]$item.Length',
  '      lastWriteTimeUtc = $item.LastWriteTimeUtc.ToString("o")',
  '      companyName = [string]$version.CompanyName',
  '      productName = [string]$version.ProductName',
  '      fileVersion = [string]$version.FileVersion',
  '      productVersion = [string]$version.ProductVersion',
  '      signatureStatus = [string]$signature.Status',
  '      signerSubject = $(if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { "" })',
  '    }',
  '  } catch { }',
  '}',
  '$items | ConvertTo-Json -Compress -Depth 4',
].join('\n');

const PROCESS_EVIDENCE_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$items = Get-CimInstance Win32_Process | Where-Object {',
  '  $_.Name -in @("RobloxPlayerBeta.exe", "Windows10Universal.exe") -or',
  '  $_.ExecutablePath -match "(?i)Roblox"',
  '} | ForEach-Object {',
  '  [pscustomobject]@{ name = [string]$_.Name; executablePath = [string]$_.ExecutablePath }',
  '}',
  '$items | ConvertTo-Json -Compress -Depth 3',
].join('\n');

const APPX_DISCOVERY_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  '$startApps = @(Get-StartApps)',
  '$items = @()',
  'Get-AppxPackage -PackageTypeFilter Main | ForEach-Object {',
  '  $package = $_',
  '  $manifest = Get-AppxPackageManifest -Package $package.PackageFullName',
  '  if (-not $manifest) { return }',
  '  $publisher = [string]$package.Publisher',
  '  $identityName = [string]$manifest.Package.Identity.Name',
  '  $displayName = [string]$manifest.Package.Properties.DisplayName',
  '  $description = [string]$manifest.Package.Properties.Description',
  '  $metadata = "$identityName $displayName $description $publisher"',
  '  if ($metadata -notmatch "(?i)Roblox" -or $metadata -match "(?i)Studio") { return }',
  '  $apps = @()',
  '  foreach ($application in @($manifest.Package.Applications.Application)) {',
  '    $appId = [string]$application.Id',
  '    if (-not $appId) { continue }',
  '    $aumid = "$($package.PackageFamilyName)!$appId"',
  '    $start = $startApps | Where-Object { $_.AppID -eq $aumid } | Select-Object -First 1',
  '    $apps += [pscustomobject]@{',
  '      id = $appId',
  '      aumid = $aumid',
  '      displayName = $(if ($start) { [string]$start.Name } else { [string]$application.VisualElements.DisplayName })',
  '      executable = [string]$application.Executable',
  '      entryPoint = [string]$application.EntryPoint',
  '    }',
  '  }',
  '  $items += [pscustomobject]@{',
  '    packageFullName = [string]$package.PackageFullName',
  '    packageFamilyName = [string]$package.PackageFamilyName',
  '    identityName = $identityName',
  '    publisher = $publisher',
  '    publisherId = [string]$package.PublisherId',
  '    version = [string]$package.Version',
  '    architecture = [string]$package.Architecture',
  '    installLocation = [string]$package.InstallLocation',
  '    displayName = $displayName',
  '    description = $description',
  '    applications = $apps',
  '  }',
  '}',
  '$items | ConvertTo-Json -Compress -Depth 7',
].join('\n');

function asArray(value) {
  if (value == null || value === '') return [];
  return Array.isArray(value) ? value : [value];
}

function parseJsonOutput(value) {
  const text = String(value || '').replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  try { return asArray(JSON.parse(text)); } catch (_) { return []; }
}

function expandEnvVars(value, environment = process.env) {
  return String(value || '').replace(/%([^%]+)%/g, (_, name) => environment[name] || environment[name.toUpperCase()] || environment[name.toLowerCase()] || `%${name}%`);
}

function normalizePlayerPath(value, dependencies = {}) {
  const fileSystem = dependencies.fs || fs;
  const environment = dependencies.env || process.env;
  try {
    if (!value || typeof value !== 'string') return '';
    let raw = expandEnvVars(value, environment).trim();
    if (!raw) return '';
    raw = raw.replace(/^file:\/+/i, '');
    raw = raw.replace(/[\\/]+/g, path.sep);

    const quoted = raw.match(/"([^"]*RobloxPlayerBeta\.exe)"/i);
    if (quoted) raw = quoted[1];
    else {
      const exeIndex = raw.toLowerCase().indexOf(PLAYER_EXE.toLowerCase());
      if (exeIndex >= 0) raw = raw.slice(0, exeIndex + PLAYER_EXE.length);
    }

    raw = raw.trim().replace(/^["']|["']$/g, '').trim();
    while (/[\\/]$/.test(raw)) raw = raw.slice(0, -1);

    if (fileSystem.existsSync(raw)) {
      const stat = fileSystem.statSync(raw);
      if (stat.isDirectory()) {
        const direct = path.join(raw, PLAYER_EXE);
        if (fileSystem.existsSync(direct) && fileSystem.statSync(direct).isFile()) return path.resolve(direct);
      }
      if (stat.isFile() && path.basename(raw).toLowerCase() === PLAYER_EXE.toLowerCase()) return path.resolve(raw);
    }

    if (path.basename(raw).toLowerCase() === PLAYER_EXE.toLowerCase()) return path.resolve(raw);
    return '';
  } catch (_) {
    return '';
  }
}

function versionFromPath(value) {
  try { return path.basename(path.dirname(value)) || 'unknown'; } catch (_) { return 'unknown'; }
}

function stableId(kind, identity) {
  return `${kind}:${crypto.createHash('sha256').update(String(identity || '')).digest('hex').slice(0, 16)}`;
}

function isRobloxPublisher(value) {
  return /(?:^|,\s*)(?:CN|O)=Roblox Corporation(?:,|$)/i.test(String(value || '').trim());
}

function hasRobloxProductIdentity(metadata) {
  const company = String(metadata.companyName || '').trim();
  const product = String(metadata.productName || '').trim();
  return company.toLowerCase() === ROBLOX_COMPANY.toLowerCase() && /roblox/i.test(product) && !/studio/i.test(product);
}

function classicCandidateFromMetadata(metadata, source, dependencies = {}) {
  if (!metadata || String(metadata.signatureStatus || '').toLowerCase() !== 'valid') return null;
  if (!isRobloxPublisher(metadata.signerSubject) || !hasRobloxProductIdentity(metadata)) return null;
  const playerPath = normalizePlayerPath(metadata.path, dependencies);
  if (!playerPath) return null;
  const version = String(metadata.productVersion || metadata.fileVersion || versionFromPath(playerPath));
  return {
    id: stableId('classic', playerPath.toLowerCase()),
    kind: 'classic-win32',
    installationType: 'Classic Roblox Player',
    displayName: 'Roblox Player',
    source,
    sources: [source],
    version,
    playerPath,
    path: playerPath,
    launchMethod: 'executable',
    verified: true,
    legacyCompatible: true,
    compatibilityReason: '',
    fileLength: Number(metadata.length || 0),
    fileMtimeMs: Date.parse(metadata.lastWriteTimeUtc || '') || 0,
  };
}

function appxCandidateFromMetadata(packageMetadata, dependencies = {}) {
  if (!packageMetadata) return null;
  const fileSystem = dependencies.fs || fs;
  const searchable = [
    packageMetadata.identityName,
    packageMetadata.displayName,
    packageMetadata.description,
    packageMetadata.packageFullName,
  ].join(' ');
  if (!/roblox/i.test(searchable) || /studio/i.test(searchable)) return null;
  if (!isRobloxPublisher(packageMetadata.publisher)) return null;
  const installLocation = String(packageMetadata.installLocation || '').trim();
  if (!installLocation) return null;
  try {
    if (!fileSystem.existsSync(installLocation) || !fileSystem.statSync(installLocation).isDirectory()) return null;
  } catch (_) { return null; }

  const applications = asArray(packageMetadata.applications).filter(app => app && String(app.aumid || '').trim());
  const application = applications.find(app => !/studio/i.test(`${app.id || ''} ${app.displayName || ''}`)) || applications[0];
  if (!application) return null;
  const displayName = String(application.displayName || packageMetadata.displayName || 'Roblox (Microsoft Store)').trim();
  return {
    id: stableId('appx', `${packageMetadata.packageFamilyName || packageMetadata.packageFullName}!${application.id}`.toLowerCase()),
    kind: 'microsoft-store-appx',
    installationType: 'Microsoft Store app',
    displayName: /roblox/i.test(displayName) ? displayName : 'Roblox (Microsoft Store)',
    source: 'appx-registration',
    sources: ['appx-registration'],
    version: String(packageMetadata.version || 'unknown'),
    installLocation,
    packageFullName: String(packageMetadata.packageFullName || ''),
    packageFamilyName: String(packageMetadata.packageFamilyName || ''),
    appId: String(application.id || ''),
    aumid: String(application.aumid || ''),
    launchMethod: 'appx-activation',
    verified: true,
    legacyCompatible: false,
    compatibilityReason: STORE_LEGACY_REASON,
  };
}

function sourceRank(source) {
  return ({ manual: 600, registry: 500, process: 400, 'appx-registration': 300, filesystem: 200 })[source] || 0;
}

function mergeCandidates(candidates) {
  const merged = new Map();
  for (const candidate of candidates.filter(Boolean)) {
    const existing = merged.get(candidate.id);
    if (!existing) {
      merged.set(candidate.id, Object.assign({}, candidate));
      continue;
    }
    const sources = new Set([...(existing.sources || []), ...(candidate.sources || []), existing.source, candidate.source].filter(Boolean));
    const preferred = sourceRank(candidate.source) > sourceRank(existing.source) ? candidate : existing;
    merged.set(candidate.id, Object.assign({}, existing, candidate, preferred, { sources: [...sources] }));
  }
  return [...merged.values()].sort((left, right) => {
    const rankDifference = sourceRank(right.source) - sourceRank(left.source);
    if (rankDifference) return rankDifference;
    return Number(right.fileMtimeMs || 0) - Number(left.fileMtimeMs || 0) || left.id.localeCompare(right.id);
  });
}

function sanitizeCandidate(candidate) {
  if (!candidate) return null;
  return {
    id: candidate.id,
    kind: candidate.kind,
    installationType: candidate.installationType,
    displayName: candidate.displayName,
    source: candidate.source,
    sources: [...(candidate.sources || [])],
    version: candidate.version,
    launchMethod: candidate.launchMethod,
    verified: candidate.verified === true,
    legacyCompatible: candidate.legacyCompatible === true,
    compatibilityReason: candidate.compatibilityReason || '',
  };
}

function sanitizeLocation(location) {
  const selected = location && location.selectedCandidate ? sanitizeCandidate(location.selectedCandidate) : null;
  return {
    found: !!(location && location.found),
    source: location && location.source || 'none',
    version: location && location.version || null,
    installationId: selected && selected.id || null,
    installationType: selected && selected.installationType || null,
    displayName: selected && selected.displayName || null,
    launchMethod: selected && selected.launchMethod || null,
    verified: !!(selected && selected.verified),
    legacyCompatible: !!(selected && selected.legacyCompatible),
    compatibilityReason: selected && selected.compatibilityReason || '',
    candidates: asArray(location && location.candidates).map(sanitizeCandidate).filter(Boolean),
    detectionWarnings: asArray(location && location.detectionWarnings).map(String),
  };
}

function createDiscoveryEngine(customDependencies = {}) {
  const dependencies = {
    fs: customDependencies.fs || fs,
    env: customDependencies.env || process.env,
    now: customDependencies.now || Date.now,
    execFileSync: customDependencies.execFileSync || execFileSync,
    inspectExecutables: customDependencies.inspectExecutables,
    inspectProcesses: customDependencies.inspectProcesses,
    inspectAppxPackages: customDependencies.inspectAppxPackages,
    queryRegistry: customDependencies.queryRegistry,
  };
  let cache = null;

  function systemExecutable(name) {
    const systemRoot = dependencies.env.SystemRoot || 'C:\\Windows';
    return path.join(systemRoot, 'System32', name);
  }

  function runPowerShell(script, extraEnv = {}) {
    return dependencies.execFileSync(systemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'), [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], {
      encoding: 'utf8',
      timeout: POWERSHELL_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: MAX_PROCESS_OUTPUT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, dependencies.env, extraEnv),
    });
  }

  function inspectExecutables(candidatePaths) {
    const unique = [...new Set(candidatePaths.map(value => normalizePlayerPath(value, dependencies)).filter(Boolean))];
    if (!unique.length) return [];
    if (dependencies.inspectExecutables) return asArray(dependencies.inspectExecutables(unique));
    try {
      return parseJsonOutput(runPowerShell(EXECUTABLE_INSPECTION_SCRIPT, {
        SUNDAY_ROBLOX_CANDIDATES: JSON.stringify(unique),
      }));
    } catch (_) { return []; }
  }

  function inspectProcesses() {
    if (dependencies.inspectProcesses) return asArray(dependencies.inspectProcesses());
    try { return parseJsonOutput(runPowerShell(PROCESS_EVIDENCE_SCRIPT)); } catch (_) { return []; }
  }

  function inspectAppxPackages() {
    if (dependencies.inspectAppxPackages) return asArray(dependencies.inspectAppxPackages());
    try { return parseJsonOutput(runPowerShell(APPX_DISCOVERY_SCRIPT)); } catch (_) { return []; }
  }

  function queryRegistry() {
    if (dependencies.queryRegistry) return dependencies.queryRegistry(PROTOCOL_KEYS) || {};
    const result = {};
    const regExe = systemExecutable('reg.exe');
    for (const key of PROTOCOL_KEYS) {
      try {
        result[key] = dependencies.execFileSync(regExe, ['query', key, '/ve'], {
          encoding: 'utf8', timeout: REGISTRY_TIMEOUT_MS, windowsHide: true,
          maxBuffer: 64 * 1024, env: dependencies.env, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (_) { /* registration is optional */ }
    }
    return result;
  }

  function scanRoots() {
    const found = [];
    const roots = [
      dependencies.env.LOCALAPPDATA && path.join(dependencies.env.LOCALAPPDATA, 'Roblox', 'Versions'),
      dependencies.env['ProgramFiles(x86)'] && path.join(dependencies.env['ProgramFiles(x86)'], 'Roblox', 'Versions'),
      dependencies.env.ProgramFiles && path.join(dependencies.env.ProgramFiles, 'Roblox', 'Versions'),
      dependencies.env.ProgramData && path.join(dependencies.env.ProgramData, 'Roblox', 'Versions'),
    ].filter(Boolean);
    for (const root of roots) {
      try {
        if (!dependencies.fs.existsSync(root)) continue;
        for (const entry of dependencies.fs.readdirSync(root, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const candidatePath = path.join(root, entry.name, PLAYER_EXE);
          if (dependencies.fs.existsSync(candidatePath) && dependencies.fs.statSync(candidatePath).isFile()) found.push(candidatePath);
        }
      } catch (_) { /* a bounded root may be inaccessible */ }
    }
    return found;
  }

  function discover(settings = {}) {
    const warnings = [];
    const evidence = [];
    const sourcesByPath = new Map();
    const recordPathEvidence = (candidatePath, source) => {
      const normalized = normalizePlayerPath(candidatePath, dependencies);
      if (!normalized) return;
      const key = normalized.toLowerCase();
      const row = sourcesByPath.get(key) || { path: normalized, sources: new Set() };
      row.sources.add(source);
      sourcesByPath.set(key, row);
    };

    const manual = normalizePlayerPath(settings.robloxPath || '', dependencies);
    if (manual) recordPathEvidence(manual, 'manual');
    else if (String(settings.robloxPath || '').trim()) warnings.push('The selected manual Roblox path is not a RobloxPlayerBeta.exe path.');

    const registryValues = queryRegistry();
    for (const value of Object.values(registryValues)) {
      recordPathEvidence(value, 'registry');
    }

    for (const processEvidence of inspectProcesses()) {
      recordPathEvidence(processEvidence && processEvidence.executablePath, 'process');
    }

    for (const candidatePath of scanRoots()) {
      recordPathEvidence(candidatePath, 'filesystem');
    }

    const inspected = inspectExecutables([...sourcesByPath.values()].map(row => row.path));
    for (const metadata of inspected) {
      const normalized = normalizePlayerPath(metadata && metadata.path, dependencies);
      const sourceEvidence = sourcesByPath.get(normalized.toLowerCase());
      const sources = sourceEvidence ? [...sourceEvidence.sources].sort((left, right) => sourceRank(right) - sourceRank(left)) : ['filesystem'];
      const source = sources[0];
      const candidate = classicCandidateFromMetadata(metadata, source, dependencies);
      if (candidate) evidence.push(Object.assign(candidate, { sources }));
    }

    for (const packageMetadata of inspectAppxPackages()) {
      const candidate = appxCandidateFromMetadata(packageMetadata, dependencies);
      if (candidate) evidence.push(candidate);
    }

    const candidates = mergeCandidates(evidence);
    let selected = null;
    const selectedId = String(settings.robloxInstallationId || '').trim();
    if (selectedId) selected = candidates.find(candidate => candidate.id === selectedId) || null;
    if (!selected && manual) selected = candidates.find(candidate => candidate.source === 'manual') || null;
    if (!selected && settings.autoDetect !== false) {
      selected = settings.multiInstanceMode === true
        ? candidates.find(candidate => candidate.legacyCompatible) || candidates[0] || null
        : candidates[0] || null;
    }
    if (!selectedId && settings.autoDetect === false && !manual) selected = null;

    if (!selected && selectedId) warnings.push('The selected Roblox installation is no longer available. Re-detect Roblox installations.');
    if (!selected && manual) warnings.push('The selected manual Roblox executable could not be verified as a Roblox Corporation player binary.');

    return {
      found: !!selected,
      playerPath: selected && selected.kind === 'classic-win32' ? selected.playerPath : null,
      activationId: selected && selected.kind === 'microsoft-store-appx' ? selected.aumid : null,
      version: selected && selected.version || null,
      source: selected && selected.source || (manual ? 'manual' : 'none'),
      selectedCandidate: selected,
      candidates,
      detectionWarnings: warnings,
    };
  }

  function cacheKey(settings) {
    return JSON.stringify({
      robloxPath: String(settings && settings.robloxPath || ''),
      robloxInstallationId: String(settings && settings.robloxInstallationId || ''),
      autoDetect: settings && settings.autoDetect !== false,
      multiInstanceMode: settings && settings.multiInstanceMode === true,
    });
  }

  function selectedEvidenceStillExists(location) {
    const selected = location && location.selectedCandidate;
    if (!selected) return false;
    try {
      if (selected.kind === 'classic-win32') {
        const stat = dependencies.fs.statSync(selected.playerPath);
        return stat.isFile() && (!selected.fileLength || stat.size === selected.fileLength) && (!selected.fileMtimeMs || Math.abs(stat.mtimeMs - selected.fileMtimeMs) < 2_000);
      }
      if (selected.kind === 'microsoft-store-appx') return dependencies.fs.statSync(selected.installLocation).isDirectory();
    } catch (_) { return false; }
    return false;
  }

  function locate(settings = {}, options = {}) {
    const key = cacheKey(settings);
    const now = dependencies.now();
    if (!options.force && cache && cache.key === key && now - cache.createdAt < CACHE_TTL_MS
      && (!cache.value.found || selectedEvidenceStillExists(cache.value))) return cache.value;
    const value = discover(settings);
    cache = { key, createdAt: now, value };
    return value;
  }

  function invalidateCache() { cache = null; }

  function pathStatus(value) {
    const normalized = normalizePlayerPath(value, dependencies);
    if (!String(value || '').trim()) return { ok: false, normalized: '', reason: 'Path is empty.' };
    if (!normalized) return { ok: false, normalized: '', reason: 'Choose RobloxPlayerBeta.exe or its containing version folder.' };
    const metadata = inspectExecutables([normalized]);
    const candidate = metadata.map(item => classicCandidateFromMetadata(item, 'manual', dependencies)).find(Boolean);
    if (!candidate) return { ok: false, normalized, reason: 'The file is not a valid Roblox Corporation Roblox Player executable.' };
    return { ok: true, normalized: candidate.playerPath, reason: '', candidate };
  }

  function validatePath(value) { return pathStatus(value).ok; }

  return { locate, invalidateCache, validatePath, pathStatus, inspectExecutables };
}

const defaultEngine = createDiscoveryEngine();

module.exports = {
  APPX_DISCOVERY_SCRIPT,
  CACHE_TTL_MS,
  PLAYER_EXE,
  PROTOCOL_KEYS,
  STORE_LEGACY_REASON,
  createDiscoveryEngine,
  locate: defaultEngine.locate,
  invalidateCache: defaultEngine.invalidateCache,
  validatePath: defaultEngine.validatePath,
  pathStatus: defaultEngine.pathStatus,
  normalizePlayerPath,
  sanitizeLocation,
  sanitizeCandidate,
  versionFromPath,
};
