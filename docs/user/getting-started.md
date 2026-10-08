# Getting started

SUNDAY is a Windows desktop app for managing Roblox accounts and launching
managed clients from one dashboard.

## Requirements

- Windows 10 or later on an x64 PC
- Microsoft WebView2 Runtime
- Roblox desktop client for Roblox launch features

## Download and install

1. Open the canonical [SUNDAY Releases page](https://github.com/SadinKai/SUNDAY/releases).
2. Download `SundayInstaller.exe` from the latest release.
3. Run the installer and open **SUNDAY**.

The v1.8.18 Windows binaries are unsigned. Windows SmartScreen may show
a warning because the files do not carry an Authenticode publisher signature.
Verify that the download came from the canonical Releases page and compare its
SHA-256 hash with `SHA256SUMS.txt` on that release.

You can instead download `SundayPortable_1.8.18_x64.zip`, extract it into a new
folder, and run `Sunday.exe`.

## Add an account

1. Open **Accounts**.
2. Select **Add account**.
3. Complete sign-in in the temporary Roblox window.
4. Return to SUNDAY after the account appears.

SUNDAY protects the imported Roblox session with Windows DPAPI for the current
Windows user. It does not show the raw cookie in the normal interface. Read
[Privacy](../../PRIVACY.md) for details.

## Launch

1. Open **Launch**.
2. Select the account you want to use.
3. Choose a destination.
4. Review the plan and select **Launch**.
5. Manage clients SUNDAY launched in **Active clients**.

Multi-instance mode is enabled by default on a fresh installation and can
launch one to six managed clients through SUNDAY's legacy compatibility
path. Normal use does not require an environment variable, PowerShell command,
or developer configuration. An explicit choice saved by an existing user is
preserved during upgrade.

SUNDAY automatically detects verified classic Roblox installations. It also
detects Microsoft Store / AppX Roblox through Windows package metadata, but the
Store package is not compatible with the legacy file-cloning path. Use the
standard Windows client from roblox.com for Multi-instance mode. Open Settings
only if you want to re-detect, select another verified installation, choose a
classic player manually, or turn the mode off.

The exact `LEGACY_COMPAT=1` startup override remains available for
backward-compatible developer use. It is not required for normal use.

## Next steps

- [Accounts and sign-in](accounts.md)
- [Multi-instance mode](multi-instance.md)
- [Troubleshooting](troubleshooting.md)
- [Documentation index](../README.md)

Developers building from source should start with
[Development](../developer/development.md),
[Testing](../developer/testing.md), and
[Configuration](../developer/configuration.md).
