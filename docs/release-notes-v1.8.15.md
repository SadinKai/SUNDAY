# SUNDAY v1.8.15

SUNDAY is a Roblox account manager and multi-instance launcher for Windows.

## Highlights

- Enable **Multi-instance mode** directly in Settings.
- Apply the setting through a controlled SUNDAY restart.
- Use the reorganized, polished SUNDAY desktop interface and documentation.
- Keep the existing bounded ownership, slot, clone-validation, and
  fail-closed process controls.

## Multi-instance mode

Multi-instance mode is disabled by default. Open **Settings**, choose
**Multi-instance**, turn on **Enable multi-instance mode**, save, and restart
SUNDAY when prompted. After restart, confirm **LEGACY MULTI-INSTANCE MODE** is
visible before launching.

The exact `LEGACY_COMPAT=1` environment value remains a backward-compatible
developer override. It is not the normal user workflow in v1.8.15.

This mode uses SUNDAY's existing legacy Roblox compatibility path. It is not
vendor-supported isolation, and Roblox changes may affect it.

## Installation

Download and run `SundayInstaller.exe`. The portable build is
`SundayPortable_1.8.15_x64.zip`.

The v1.8.15 Windows binaries are unsigned. Windows SmartScreen may display a
warning. Verify downloads against `SHA256SUMS.txt` on the release page.

Automatic update installation remains unavailable. Use **View releases** to
download updates manually.

SUNDAY is an independent project and is not affiliated with or endorsed by
Roblox Corporation.
