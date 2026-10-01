'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
function filesUnder(relative, extension) {
  const output = [];
  function visit(current) {
    for (const entry of fs.readdirSync(path.join(root, current), { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (!extension || entry.name.endsWith(extension)) output.push(child);
    }
  }
  visit(relative);
  return output.sort();
}
const rendererJavaScript = () => filesUnder(path.join('src', 'renderer'), '.js').map(read).join('\n');
const { isSundayTarget } = require('./smoke');

test('production backend exposes capability gates and no updater applier imports', () => {
  const source = read('src/main/tauri-backend.js');
  const bridge = read('src/renderer/tauri-bridge.js');
  const rust = read('src-tauri/src/lib.rs');
  assert.match(source, /robloxIsolation:[\s\S]*STATES\.UNAVAILABLE/);
  assert.match(source, /updaterApply:[\s\S]*STATES\.UNAVAILABLE/);
  assert.match(source, /registerUpdateJobs\(jobs, updater\);[\s\S]*jobs\.resumePending\(\)/);
  assert.match(source, /startUpdateCheck\(jobs, payload\.idempotencyKey\)/);
  assert.match(bridge, /updater_check', \{ idempotencyKey \}/);
  assert.match(rust, /updater_check[\s\S]*idempotencyKey/);
  assert.match(rust, /async fn app_restart[\s\S]*request_restart/);
  assert.match(bridge, /restart: \(\) => tauriInvoke\('app_restart'\)/);
  assert.doesNotMatch(source, /require\('\.\/(?:download|selfupdate|unzip)'\)/);
  assert.doesNotMatch(source, /latest\.yml|downloadUpdatePackage|applyUpdate\s*\(/);
  assert.doesNotMatch(source, /launching directly/);
});

test('production launch flow is adapter-bound and host launch intents contain no credentials', () => {
  const backend = read('src/main/tauri-backend.js');
  const orchestration = read('src/main/launch-orchestration.js');
  const adapter = read('src/main/roblox-isolation-adapter.js');
  const bridge = read('src/renderer/tauri-bridge.js');
  assert.match(backend, /selectRobloxIsolationAdapter\(/);
  assert.match(adapter, /const enabled = legacyCompatRequested\(environment\);[\s\S]*if \(!enabled\)[\s\S]*new UnavailableRobloxIsolationAdapter/);
  assert.match(adapter, /opts\.loadLegacy \|\| \(\(\) => require\('\.\/legacy-roblox-isolation-adapter'\)/);
  assert.match(backend, /new LaunchCoordinator\(/);
  assert.doesNotMatch(backend, /require\('\.\/launcher'\)|require\('\.\/clones'\)|launchIsolated|doLaunch/);
  assert.match(orchestration, /adapter\.preflight[\s\S]*if \(!isActivated\(preflight\)\)[\s\S]*adapter\.allocateInstance[\s\S]*resolveIntent[\s\S]*adapter\.launch/);
  assert.match(orchestration, /cannot persist sensitive field/);
  assert.match(adapter, /class UnavailableRobloxIsolationAdapter/);
  assert.match(bridge, /launch_plan_get[\s\S]*launch_plan_cancel/);
  assert.doesNotMatch(backend, /SyntheticIsolationAdapter|support\/synthetic/);
  assert.equal(fs.existsSync(path.join(root, 'test', 'support', 'synthetic-isolation-adapter.js')), true);
  assert.match(backend, /accounts\.getLaunchInfo/);
  assert.match(backend, /accounts\.getPersonJoinLaunchInfo/);
  assert.match(backend, /accounts\.getFollowContext/);
  assert.match(backend, /accountHandle: operation\.accountId/);
  assert.match(backend, /launchUri: launch\.deeplink/);
});

test('legacy compatibility is quarantined, explicit, and has no broad process command', () => {
  const selector = read('src/main/roblox-isolation-adapter.js');
  const legacy = read('src/main/legacy-roblox-isolation-adapter.js');
  const legacyNative = read('src/main/legacy-roblox-native.js');
  const backend = read('src/main/tauri-backend.js');
  const rust = read('src-tauri/src/lib.rs');
  const renderer = rendererJavaScript();
  assert.match(selector, /LEGACY_COMPAT === '1'/);
  assert.match(legacy, /class LegacyRobloxIsolationAdapter/);
  assert.match(legacy, /LEGACY CROSS-PROCESS COMPATIBILITY ACTION/);
  assert.match(legacy, /instance-\$\{index\}/);
  assert.match(legacy, /processCapabilities\.authorize\(capability, 'stop', this\.ownerId\)/);
  assert.match(legacyNative, /ROBLOX_singletonEvent/);
  assert.match(legacyNative, /ROBLOX_singletonMutex/);
  assert.doesNotMatch(legacy, /killAll|terminateByName|taskkill/i);
  assert.doesNotMatch(backend, /LEGACY_COMPAT\s*!==\s*'1'/);
  assert.match(backend, /adapterSelection: Object\.assign\(\{\}, adapterSelection\)/);
  assert.match(backend, /implementation: adapterSelection\.selectedAdapter/);
  assert.match(backend, /async adapter_selection_status\(\)/);
  assert.match(backend, /resolveLegacyCompatibility\(settings, externalAdapterEnvironment\)/);
  assert.match(backend, /legacyCompatSettingEnabled/);
  assert.match(backend, /restartRequired: settings\.multiInstanceMode !== before\.multiInstanceMode/);
  assert.match(rust, /var_os\("LEGACY_COMPAT"\)[\s\S]*command\.env\("LEGACY_COMPAT", value\)/);
  assert.doesNotMatch(rust, /env_clear\s*\(/);
  assert.match(renderer, /selection\.selectedAdapter === 'LegacyRobloxIsolationAdapter'/);
  assert.match(renderer, /selection\.legacyCompatEnabled === true/);
  assert.match(renderer, /api\.adapterSelection\(\)/);
  assert.match(renderer, /blocked; prepare again to evaluate the current legacy adapter/);
});

test('Phase 6 production boundary is provider-neutral and synthetic code is artifact-excluded', () => {
  const provider = read('src/main/environment-provider.js');
  const windows = read('src/main/windows-vm-provider.js');
  const broker = read('src/main/environment-broker.js');
  const rpc = read('src/main/environment-rpc.js');
  const guest = read('src/guest/windows-guest-agent.js');
  const adapter = read('src/main/roblox-isolation-adapter.js');
  const build = read('scripts/build-portable.ps1');
  assert.match(provider, /PROVIDER_UNAVAILABLE[\s\S]*PROVIDER_READY[\s\S]*QUALIFICATION_REQUIRED[\s\S]*QUALIFIED[\s\S]*ACTIVATED[\s\S]*FAILED/);
  assert.match(windows, /class WindowsVmProvider[\s\S]*PROVIDER_UNAVAILABLE/);
  assert.doesNotMatch(windows, /Enable-WindowsOptionalFeature|dism(?:\.exe)?|New-VM|VBoxManage|vmrun|Start-Process|child_process/i);
  assert.match(broker, /EnvironmentLeaseManager[\s\S]*authenticated !== true[\s\S]*encrypted !== true[\s\S]*replayProtected !== true/);
  assert.match(rpc, /AES-256-GCM\+Ed25519/);
  assert.match(rpc, /cookie\|password\|credential\|secret\|ticket\|deeplink/i);
  assert.match(guest, /signatureStatus !== 'VALID'/);
  assert.match(guest, /maxRestarts: 2/);
  assert.doesNotMatch(build, /src\\guest|test\\support|synthetic-(?:environment-provider|guest-agent)/);
  assert.equal(fs.existsSync(path.join(root, 'test', 'support', 'synthetic-environment-provider.js')), true);
  assert.equal(fs.existsSync(path.join(root, 'test', 'support', 'synthetic-guest-agent.js')), true);
  const productionBoundary = [provider, windows, broker, rpc, guest, read('src/main/environment-leases.js'), adapter].join('\n');
  for (const forbidden of [
    'DUPLICATE_CLOSE_SOURCE', 'DuplicateHandle', 'NtQuerySystemInformation', 'NtQueryObject',
    'ROBLOX_singletonEvent', 'ROBLOX_singletonMutex', 'mklink', 'CreateHardLink',
    'CreateSymbolicLink', 'taskkill', 'process.kill',
  ]) {
    assert.equal(productionBoundary.includes(forbidden), false, `production isolation boundary contains ${forbidden}`);
  }
});

test('renderer process actions pass opaque capabilities, not PIDs', () => {
  const bridge = read('src/renderer/tauri-bridge.js');
  const native = read('src/main/native.js');
  const backend = read('src/main/tauri-backend.js');
  assert.match(bridge, /instance_focus[\s\S]*capability/);
  assert.match(bridge, /instance_kill[\s\S]*capability/);
  assert.match(bridge, /instance_restart[\s\S]*capability/);
  assert.doesNotMatch(native, /function focusByPid\s*\(/);
  assert.doesNotMatch(native, /function tileWindows\s*\(/);
  assert.match(native, /function tileOwned\(records\)/);
  assert.match(native, /verifiedRecordFromHandle\(item\.handle, item\.record\)/);
  assert.match(backend, /native\.tileOwned\(records\)/);
});

test('WebView navigation and credential injection are fail closed', () => {
  const rust = read('src-tauri/src/lib.rs');
  assert.match(rust, /\.on_navigation\(/);
  assert.match(rust, /host_str\(\) == Some\("www\.roblox\.com"\)/);
  assert.match(rust, /Account creation is unavailable until the isolated credential handoff/);
  assert.match(rust, /Automatic update restart is unavailable/);
  assert.doesNotMatch(rust, /Some\(fill_script\)/);
  assert.match(rust, /#\[cfg\(any\(\)\)\]\s*const PREFILL_SCRIPT/);
});

test('production utilities are resolved by absolute system paths', () => {
  const host = read('src/main/tauri-node-host.js');
  const roblox = read('src/main/roblox.js');
  const processes = read('src/main/processes.js');
  assert.doesNotMatch(host, /spawn\(['"](?:explorer|powershell\.exe)['"]/i);
  assert.doesNotMatch(roblox, /execFileSync\(['"]reg['"]/i);
  assert.match(processes, /path\.join\(SYSTEM32, 'tasklist\.exe'\)/);
});

test('remote fetch is centralized in the bounded policy module', () => {
  for (const file of ['accounts.js', 'games.js', 'people.js', 'signup.js']) {
    const source = read(`src/main/${file}`);
    assert.doesNotMatch(source, /\bglobalThis\.fetch\s*\(/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.match(source, /fetchWithPolicy/);
  }
});

test('account-creation profile defaults are session-only', () => {
  const renderer = rendererJavaScript();
  assert.match(renderer, /let createSessionDefaults = null/);
  assert.match(renderer, /localStorage\.removeItem\(CREATE_DEFAULTS_KEY\)/);
  assert.doesNotMatch(renderer, /localStorage\.setItem\(CREATE_DEFAULTS_KEY/);
});

test('retired destructive updater helpers are absent from the distribution tree', () => {
  for (const file of ['download.js', 'selfupdate.js', 'unzip.js', 'launcher.js', 'guard.js', 'clones.js']) {
    assert.equal(fs.existsSync(path.join(root, 'src/main', file)), false);
  }
  const installer = read('installer/src/shell.rs');
  assert.doesNotMatch(installer, /TerminateProcess|close_sunday_processes|wipe_dir|remove_dir_all/);
  const accounts = read('src/main/accounts.js');
  assert.doesNotMatch(accounts, /\b(?:fs\.)?linkSync|process\.kill\s*\(|_setLockTimeoutMs/);
  const releaseWorkflow = read('.github/workflows/build-installer.yml');
  assert.doesNotMatch(releaseWorkflow, /latest\.yml/);
  const keeper = read('src/main/keeper.js');
  assert.doesNotMatch(keeper, /require\('\.\/(?:launcher|processes|accounts|native)'\)|child_process|process\.kill|\bspawn\s*\(/);
  assert.match(keeper, /requestRelaunch/);
  assert.match(keeper, /onOwnedExit[\s\S]*ownership !== 'OWNED'/);
  assert.match(keeper, /isExecutionEnabledState\(this\.isolationStateProvider\(\)\)/);
});

test('installer removal is ledger-bound and never recursively deletes an install root', () => {
  const main = read('installer/src/main.rs');
  const ledger = read('installer/src/ledger.rs');
  const shell = read('installer/src/shell.rs');
  assert.match(main, /A copied or renamed uninstaller has no authority/);
  assert.match(main, /verify_authenticode\(&canonical_uninstaller/);
  assert.match(main, /fn verified_installed_sunday\(\)[\s\S]*verified_registered_removal\(false\)/);
  assert.match(main, /fn validate_install_destination\([\s\S]*canonical_parent\.starts_with\(&canonical_local\)/);
  assert.match(ledger, /owned file changed after removal preflight and was preserved/);
  assert.match(ledger, /modified and will not be removed/);
  assert.doesNotMatch(ledger.replace(/#\[cfg\(test\)\][\s\S]*$/, ''), /remove_dir_all/);
  assert.match(shell, /InstallationId/);
  assert.match(shell, /ProductGuid/);
  assert.match(shell, /LedgerPath/);
  assert.doesNotMatch(shell, /has_app|installed_sunday|exe_file_version/);
  assert.doesNotMatch(shell, /C:\\\\Users\\\\Public/);
});

test('initial public release workflow builds only the exact audited unsigned assets', () => {
  const workflow = read('.github/workflows/build-installer.yml');
  const portable = read('scripts/build-portable.ps1');
  const installer = read('scripts/build-installer.ps1');
  assert.match(workflow, /cargo clippy --locked[\s\S]*--all-targets --all-features/);
  assert.match(workflow, /npm run dist/);
  assert.match(workflow, /npm run release:package/);
  assert.match(workflow, /npm run audit:artifacts/);
  assert.match(workflow, /npm run audit:release-secrets -- dist\/Sunday release-assets/);
  assert.match(workflow, /SundayInstaller\.exe/);
  assert.match(workflow, /SundayPortable_\$\{version\}_x64\.zip/);
  assert.match(workflow, /SHA256SUMS\.txt/);
  assert.match(workflow, /Get-FileHash[\s\S]*SHA256/);
  assert.match(workflow, /actions\/upload-artifact@[a-f0-9]{40}/);
  assert.match(workflow, /permissions:[\s\S]*contents: read/);
  assert.doesNotMatch(workflow, /CODESIGNING|SUNDAY_RELEASE_PRIVATE_KEY|attest-build-provenance|test:isolation-real|sunday-legacy-qualification|gh release/);
  assert.doesNotMatch(workflow, /Expand-Archive/);
  assert.match(portable, /tauri build -- --locked/);
  assert.match(installer, /cargo build --release --locked/);
});

test('manual release packaging rejects runtime residue and reparse points', () => {
  const release = read('scripts/make-release.ps1');
  const audit = read('scripts/audit-release-artifacts.ps1');
  assert.match(release, /allowedPortableTopLevel/);
  assert.match(release, /Sunday\.exe|runtime or unknown top-level content/);
  assert.match(release, /FileAttributes\]::ReparsePoint/);
  assert.match(release, /will not be released/);
  assert.match(audit, /fileDescription/);
  assert.match(audit, /authoredForbiddenBindingsFound/);
  assert.match(audit, /networkOriginScan/);
  assert.match(audit, /insecureHttpOrigins/);
});

test('SUNDAY Launcher is canonical and former identity values are isolated', () => {
  const html = read('src/renderer/index.html');
  const splash = read('src/renderer/splash.html');
  const renderer = rendererJavaScript();
  const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
  const packageMetadata = JSON.parse(read('package.json'));
  const installer = read('installer/src/main.rs');
  const installerShell = read('installer/src/shell.rs');
  const installerBuild = read('installer/build.rs');
  const releaseManifest = read('scripts/create-release-manifest.mjs');
  const legacyNodeIdentity = read('src/main/legacy-identity-compat.js');
  const legacyInstallerIdentity = read('installer/src/legacy_identity.rs');

  assert.match(html, /<title>SUNDAY Launcher<\/title>/);
  assert.match(html, /aria-label="SUNDAY Launcher"/);
  assert.match(splash, /<span>S<\/span><span>U<\/span><span>N<\/span><span>D<\/span><span>A<\/span><span>Y<\/span>/);
  assert.match(renderer, /<b>SUNDAY Launcher<\/b><br>Created by SADINKAI/);
  assert.doesNotMatch(renderer, />Fleet</);
  assert.equal(tauri.productName, 'SUNDAY Launcher');
  assert.equal(tauri.mainBinaryName, 'Sunday');
  assert.equal(tauri.identifier, 'com.sadinkai.sundaylauncher');
  assert.equal(packageMetadata.name, 'sunday-launcher');
  assert.equal(packageMetadata.author, 'SADINKAI');
  assert.match(installer, /const APP_TITLE: &str = "SUNDAY Launcher"/);
  assert.match(installerShell, /reg_set_string\(hkey, "DisplayName", "SUNDAY Launcher"\)/);
  assert.match(installerBuild, /VALUE "CompanyName", "SADINKAI"/);
  assert.match(releaseManifest, /product: 'SUNDAY Launcher'/);
  assert.match(legacyNodeIdentity, /LEGACY_APP_IDENTIFIER/);
  assert.match(legacyInstallerIdentity, /pub const MAIN_BINARY/);
});

test('former product identity is absent from active production files outside migration islands', () => {
  const allowed = new Set([
    path.join('src', 'main', 'legacy-identity-compat.js'),
    path.join('src', 'renderer', 'legacy-identity-compat.js'),
    path.join('installer', 'src', 'legacy_identity.rs'),
  ]);
  const roots = ['src', 'src-tauri', 'installer', 'scripts', '.github'];
  const violations = [];
  function inspect(relative) {
    const absolute = path.join(root, relative);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'target' && entry.name !== 'resources') inspect(child);
      } else if (!allowed.has(child) && /fleet/i.test(fs.readFileSync(path.join(root, child), 'utf8'))) {
        violations.push(child);
      }
    }
  }
  for (const directory of roots) inspect(directory);
  assert.deepEqual(violations, []);
});

test('current package, install, shortcut, and launch paths use Sunday.exe', () => {
  const tauri = JSON.parse(read('src-tauri/tauri.conf.json'));
  const portable = read('scripts/build-portable.ps1');
  const installerBuild = read('scripts/build-installer.ps1');
  const release = read('scripts/make-release.ps1');
  const artifactAudit = read('scripts/audit-release-artifacts.ps1');
  const workflow = read('.github/workflows/build-installer.yml');
  const installer = read('installer/src/main.rs');
  const shell = read('installer/src/shell.rs');
  const payload = read('installer/src/payload.rs');

  assert.equal(tauri.mainBinaryName, 'Sunday');
  assert.match(portable, /dist\\Sunday/);
  assert.match(portable, /target\\release\\Sunday\.exe/);
  assert.match(portable, /Join-Path \$out 'Sunday\.exe'/);
  assert.doesNotMatch(portable, /dist\\Fleet|target\\release\\fleet\.exe|Join-Path \$out 'Fleet\.exe'/i);
  assert.match(installerBuild, /Join-Path \$releaseDir 'Sunday'/);
  assert.match(installerBuild, /Portable build did not produce Sunday\.exe/);
  assert.match(release, /SundayPortable_\$\{version\}_x64\.zip/);
  assert.match(artifactAudit, /\$payloadMap\['Sunday\.exe'\]/);
  assert.match(workflow, /dist\/Sunday\/Sunday\.exe/);
  assert.match(installer, /const CURRENT_MAIN_BINARY: &str = "Sunday\.exe"/);
  assert.doesNotMatch(installer, /LEGACY_MAIN_BINARY/);
  assert.match(shell, /reg_set_string\(hkey, "MainBinaryName", "Sunday\.exe"\)/);
  assert.match(payload, /\["sunday\.exe", "node\.exe", "uninstall\.exe"\]/);
});

test('supported native UI entry points require an isolated VM declaration', () => {
  for (const file of ['smoke.js', 'ui-features.js']) {
    const source = read(`test/${file}`);
    assert.match(source.slice(0, 500), /SUNDAY_ISOLATED_VM/);
  }
});

test('renderer is split into ordered responsibility modules without a framework migration', () => {
  const html = read('src/renderer/index.html');
  const bootstrap = read('src/renderer/app.js');
  const expectedScripts = [
    'core.js',
    'components/notifications.js',
    'components/palette.js',
    'components/overlays.js',
    'router.js',
    'views/launch.js',
    'views/accounts.js',
    'views/games.js',
    'views/people.js',
    'views/history-stats.js',
    'views/diagnostics.js',
    'views/settings.js',
    'views/help.js',
    'actions.js',
    'runtime.js',
    'app.js',
  ];
  let previous = -1;
  for (const script of expectedScripts) {
    const index = html.indexOf(`<script src="${script}"></script>`);
    assert.ok(index > previous, `${script} is missing or out of order`);
    previous = index;
  }
  assert.ok(bootstrap.length < 5000, 'app.js must remain a small bootstrap coordinator');
  assert.equal(fs.existsSync(path.join(root, 'src', 'renderer', 'styles.css')), false);
  assert.doesNotMatch(html, /react|vue|svelte/i);
});

test('packaged smoke target detection accepts the canonical Tauri URL and route title', () => {
  assert.equal(isSundayTarget({
    type: 'page',
    url: 'http://tauri.localhost/',
    title: 'Launch — SUNDAY Launcher',
  }), true);
  assert.equal(isSundayTarget({
    type: 'page',
    url: 'https://example.invalid/',
    title: 'Settings — SUNDAY Launcher',
  }), true);
  assert.equal(isSundayTarget({
    type: 'page',
    url: 'https://example.invalid/',
    title: 'Unrelated application',
  }), false);
});

test('public-facing GitHub links use the canonical SUNDAY repository', () => {
  const activeFiles = [
    path.join(root, 'README.md'),
    path.join(root, 'docs', 'user', 'getting-started.md'),
    path.join(root, 'installer', 'src', 'main.rs'),
    path.join(root, 'scripts', 'create-release-manifest.mjs'),
    ...filesUnder(path.join('src', 'renderer'), '.js').map(file => path.join(root, file)),
  ];
  for (const file of activeFiles) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /github\.com\/SadinKai\/RobloxV2/i, path.relative(root, file));
  }
});

test('public documentation has no placeholder visual or broken local links', () => {
  const files = [
    'README.md',
    'PRIVACY.md',
    'SECURITY.md',
    'SUPPORT.md',
    'CONTRIBUTING.md',
    'CHANGELOG.md',
    ...filesUnder('docs', '.md'),
  ];
  assert.doesNotMatch(read('README.md'), /screenshot pending/i);
  const broken = [];
  for (const file of files) {
    const source = read(file);
    const base = path.dirname(path.join(root, file));
    for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const rawTarget = match[1].trim().replace(/^<|>$/g, '');
      if (!rawTarget || /^(?:https?:|mailto:|#)/i.test(rawTarget)) continue;
      const target = decodeURIComponent(rawTarget.split('#', 1)[0]);
      if (!fs.existsSync(path.resolve(base, target))) broken.push(`${file} -> ${rawTarget}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('multi-instance preference and privacy documentation keep secrets outside renderer state', () => {
  const store = read('src/main/store.js');
  const backend = read('src/main/tauri-backend.js');
  const settingsView = read('src/renderer/views/settings.js');
  const privacy = read('PRIVACY.md');
  assert.match(store, /multiInstanceMode: false/);
  assert.match(store, /s\.multiInstanceMode = s\.multiInstanceMode === true/);
  assert.match(backend, /const legacyCompatibility = resolveLegacyCompatibility\(settings, externalAdapterEnvironment\)/);
  assert.match(read('src/renderer/views/launch.js'), /label: 'LEGACY MULTI-INSTANCE MODE'/);
  assert.doesNotMatch(settingsView, /\.ROBLOSECURITY|auth(?:entication)?Ticket|cookieValue/i);
  assert.match(privacy, /Windows DPAPI/);
  assert.match(privacy, /raw cookie is not returned to ordinary renderer UI state/);
  assert.match(privacy, /no telemetry, remote analytics, or\s+remote crash reporting/);
});

test('public provenance distinguishes Fleet origin from SUNDAY maintenance', () => {
  const readme = read('README.md');
  const notice = read('NOTICE.md');
  const license = read('LICENSE');

  assert.match(readme, /## Origin and Attribution/);
  assert.match(readme, /github\.com\/Toluwer\/Fleet/);
  assert.match(notice, /Author: Toluwa/);
  assert.match(notice, /does not assert that Toluwa and Toluwer are the\s+same person/);
  assert.match(notice, /does not claim ownership of upstream Fleet\s+material/);
  assert.match(license, /Copyright \(c\) 2026 SADINKAI/);
  assert.doesNotMatch(license, /Copyright \(c\) 2024 Toluwa/);
});
