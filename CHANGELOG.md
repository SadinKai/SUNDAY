# Changelog

All notable changes to SUNDAY Launcher are documented in this file.

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
