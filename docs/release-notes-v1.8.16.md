# SUNDAY Launcher v1.8.16

SUNDAY is a Roblox account manager and multi-instance launcher for Windows.

## Highlights

- Normal single-client Roblox launch is now available by default.
- Roblox process and window qualification is deterministic and remains bound
  to the exact process SUNDAY launched.
- Launch failures now provide clearer, sanitized reasons and recovery actions.
- Diagnostics expose useful launch-state metadata without revealing cookies,
  tickets, capabilities, full launch URIs, or personal filesystem paths.
- Multi-instance mode continues to use SUNDAY's existing
  `LegacyRobloxIsolationAdapter` clone, native singleton, slot ownership, and
  capability-controlled process path on real Windows.
- The unsigned installer now supports its integrity-only install/uninstall path
  and reliably creates shortcuts from canonical Windows paths. Its verified
  removal helper now hashes owned files with a bounded heap buffer so uninstall
  completes safely on the Windows process main stack.

The release addresses the identified single-client qualification failure modes
and was live-qualified on the release environment. It does not claim that a
different machine was tested.

## Normal launch

Download → Install → Connect account → Pick game → Launch.

Normal one-account launch requires no environment variable and no
Multi-instance setting. SUNDAY only accepts the process it spawned, or its exact
direct-child transition, after executable, creation-identity, path, and
responsive Roblox-window checks succeed.

## Multi-instance

Open **Settings** → **Multi-instance** → **Enable** → **Restart** to launch up
to three clients. This remains an explicit legacy compatibility mode. It is not
vendor-supported Roblox isolation, and Roblox or Windows changes may affect it.
The exact `LEGACY_COMPAT=1` override remains available for backward-compatible
developer workflows; other values do not enable the mode.

## Security

Focus, Stop, and Restart remain bound to opaque process capabilities that are
issued only after readiness and ownership checks. SUNDAY does not adopt an
arbitrary existing Roblox process and does not use broad process termination.

The unsigned installer uses closed-world payload hashes, a canonical per-user
install path, ledger-bound file ownership, and a hash-matched removal helper.
This is integrity checking, not publisher authentication; signed builds retain
their additional Authenticode verification path.

## Installation

- [Download SundayInstaller.exe](https://github.com/SadinKai/SUNDAY/releases/download/v1.8.16/SundayInstaller.exe)
- [Download SundayPortable_1.8.16_x64.zip](https://github.com/SadinKai/SUNDAY/releases/download/v1.8.16/SundayPortable_1.8.16_x64.zip)

Automatic update installation remains unavailable. Use the canonical GitHub
Releases page to download updates manually.

## Integrity

Verify both downloads against
[SHA256SUMS.txt](https://github.com/SadinKai/SUNDAY/releases/download/v1.8.16/SHA256SUMS.txt).

## Important

The v1.8.16 Windows binaries are unsigned. Windows SmartScreen may display a
warning. Verify downloads against `SHA256SUMS.txt`.

SUNDAY is an independent project and is not affiliated with or endorsed by
Roblox Corporation.
