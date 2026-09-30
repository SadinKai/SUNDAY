# Changelog

All notable changes to SUNDAY Launcher are documented in this file.

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

### Known limitations

- Roblox execution is unavailable by default. Legacy execution requires the
  exact explicit `LEGACY_COMPAT=1` opt-in and remains an unsupported
  compatibility mechanism rather than a security boundary.
- Live Roblox functionality was not requalified as part of the final source
  publication gate.
- The in-application updater remains unavailable until a complete signed
  release chain is produced and qualified.
- Production binaries require Authenticode and release-manifest signing in a
  controlled release environment; unsigned development builds are not
  production releases.
- SUNDAY supports Windows 10 or later on x64 with Microsoft WebView2 and is not
  affiliated with or endorsed by Roblox Corporation.
