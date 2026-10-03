# Changelog

All notable changes to SUNDAY Launcher are documented in this file.

## 1.8.17

### Changed

- Enabled the existing bounded `LegacyRobloxIsolationAdapter` by default for a
  missing first-run preference while preserving explicit saved `true` and
  `false` choices and the exact `LEGACY_COMPAT=1` compatibility override.
- Removed automatic renderer clipboard inspection. **Paste Roblox Link** now
  reads sanitized plain text through a native Windows command only after an
  explicit click, avoiding the WebView clipboard-read permission prompt.
- Replaced narrow Roblox path lookup with verified candidate discovery across
  manual selection, registered Roblox protocols, running-process evidence,
  bounded classic Windows roots, and dynamic AppX/MSIX package metadata.
- Added cached re-detection, multiple-installation selection, sanitized
  diagnostics, and actionable missing, stale, and Microsoft Store states.
- Removed the temporary competing single-client adapter. An explicit
  multi-instance opt-out now selects the planning-only unavailable adapter.

### Release boundaries

- Microsoft Store / AppX Roblox is detected without hardcoded WindowsApps or
  XboxGames paths, but it is not supported by the legacy clone mechanism.
  SUNDAY does not change package ACLs, copy package contents, or claim Store
  multi-instance compatibility.
- Classic discovery, packaged launch behavior, and installer lifecycle are
  verified on the real-Windows release machine. Source-level AppX fixtures are
  verified, but current Store Roblox and a non-default PackageVolume were not
  installed on that machine and remain explicitly unqualified. That absent
  platform scenario is reported honestly rather than treated as a VM or release
  prerequisite.
- The v1.8.17 release is intentionally unsigned. Checksums establish byte
  integrity only and do not establish publisher identity.

## 1.8.16

### Changed

- Added a normal, capability-bound single-client Roblox adapter as the default
  launch path; Multi-instance mode and `LEGACY_COMPAT=1` remain optional legacy
  compatibility paths.
- Added actionable launch failure codes and UI actions without exposing launch
  tickets, cookies, capabilities, or personal filesystem paths.
- Made window selection deterministic when Roblox exposes more than one visible
  window, while retaining process identity and responsive `WINDOWSCLIENT`
  requirements.
- Added guarded packaged qualification for Account-page launch, public-game
  launch, Active Clients, focus, restart, exact stop, and the existing
  three-client legacy regression path.
- Kept the existing `LegacyRobloxIsolationAdapter` clone, native singleton,
  slot-ownership, capability, and cleanup implementation as the production
  multi-instance path; provider research is not a v1.8.16 release gate.
- Made the intentionally unsigned installer usable in an explicit
  integrity-only mode while retaining closed-world payload hashes, canonical
  install paths, ledger-bound ownership, and hash-matched uninstall helpers;
  signed builds retain their Authenticode checks.
- Fixed Start Menu and desktop shortcut creation when canonical Windows paths
  use the verbatim `\\?\` prefix.
- Kept the uninstaller's SHA-256 buffer off the Windows process stack so the
  verified removal helper can complete without a stack-overflow crash.

### Release boundaries

- Multi-instance remains an opt-in legacy compatibility mode whose behavior can
  change with Roblox and the Windows environment; it is not vendor-supported
  isolation.
- Automatic update installation remains unavailable. The v1.8.16 installer and
  portable archive are intentionally unsigned, so users should verify the
  published SHA-256 checksums.
- SUNDAY is independent and is not affiliated with or endorsed by Roblox
  Corporation. This release addresses the identified single-client
  qualification failure modes and was live-qualified on the release
  environment; it does not claim a retest on another machine.

## 1.8.15

### Added

- Added a disabled-by-default **Multi-instance mode** setting as the normal
  user activation path for the existing legacy Roblox compatibility adapter.
- Added a controlled SUNDAY restart prompt so adapter selection is applied only
  at the next process start.
- Added plain-language privacy, user, developer, troubleshooting, and release
  documentation plus an updated public launch-workflow screenshot.

### Changed

- Split the renderer into responsibility-focused view, component, runtime, and
  stylesheet modules while preserving its trust boundary and application
  behavior.
- Polished the current SUNDAY desktop interface, product copy, icons, and
  public repository presentation.
- Kept exact `LEGACY_COMPAT=1` support as a backward-compatible developer
  override; ordinary users enable the mode in Settings and restart SUNDAY.
- Expanded automated adapter-selection, persisted-setting, UI, source-policy,
  security, packaging, and release validation for the new activation path.

### Release boundaries

- Multi-instance mode remains an unsupported compatibility mechanism rather
  than vendor-supported isolation, and it stays disabled by default.
- Automatic update installation remains unavailable; users download updates
  manually from GitHub Releases.
- The v1.8.15 Windows installer and portable archive are intentionally
  unsigned. SHA-256 checksums provide byte-integrity evidence but do not
  establish a Windows publisher identity.
- The packaged v1.8.15 candidate passed the Settings-based live qualification
  with one client, three concurrent clients, restart and slot reuse, sibling
  preservation, teardown, clone cleanup, disable/restart, and exact
  `LEGACY_COMPAT=1` compatibility semantics. This evidence remains specific to
  the qualified build, Roblox version, authorized accounts, and Windows
  environment.

## 1.8.14

### Changed

- Rebranded the application, executable, installer, application identifier,
  paths, and public documentation as SUNDAY Launcher.
- Reworked the desktop interface and made the Eclipse dark theme the first-run
  default while preserving light and system-theme choices.
- Hardened process authorization, account-session storage, network policy,
  single-instance coordination, installer ownership, and release validation.
- Improved portable packaging, standalone installation, uninstallation,
  release-manifest generation, artifact auditing, and update fail-closed
  behavior.
- Added bounded migration and compatibility support for the former product
  identity and its local data.
- Expanded JavaScript, Rust, UI, packaging, adapter-selection, clone-validation,
  installer, release-manifest, and single-instance regression coverage.

### Source-publication limitations

- Roblox execution is unavailable by default. At the source-publication gate,
  legacy execution required the exact explicit `LEGACY_COMPAT=1` opt-in. It
  remains an unsupported compatibility mechanism rather than a security
  boundary.
- Live Roblox functionality was not requalified during that source-publication
  gate. The packaged legacy path was subsequently live-qualified separately;
  that evidence remains version- and environment-specific.
- Automatic update installation was not included in v1.8.14 and remains
  unavailable.
- The first public v1.8.14 installer and portable archive were intentionally
  published unsigned. SHA-256 checksums provide byte-integrity evidence but do
  not establish a Windows publisher identity.
- SUNDAY supports Windows 10 or later on x64 with Microsoft WebView2 and is not
  affiliated with or endorsed by Roblox Corporation.

### Post-release source changes

- Added a normal, disabled-by-default Settings control that persists the
  multi-instance preference and selects the existing legacy adapter after a
  controlled application restart. The `LEGACY_COMPAT=1` environment override
  remains backward compatible.
- Split the renderer into responsibility-focused view, component, runtime, and
  stylesheet modules without changing its framework or trust boundary.
- Added user-focused documentation and a plain-language privacy disclosure.
