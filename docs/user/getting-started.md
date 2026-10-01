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

The initial v1.8.14 Windows binaries are unsigned. Windows SmartScreen may show
a warning because the files do not carry an Authenticode publisher signature.
Verify that the download came from the canonical Releases page and compare its
SHA-256 hash with `SHA256SUMS.txt` on that release.

You can instead download `SundayPortable_1.8.14_x64.zip`, extract it into a new
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
2. Select the account or accounts you want to use.
3. Choose a destination.
4. Review the plan and select **Launch**.
5. Manage clients SUNDAY launched in **Active clients**.

Roblox execution is disabled by default. To launch multiple clients, enable the
explicit compatibility mode described in
[Multi-instance mode](multi-instance.md).

> The normal Settings control is present in current source builds. The already
> published v1.8.14 binaries predate that control and use the exact
> `LEGACY_COMPAT=1` startup override documented in the v1.8.14 release notes.

## Next steps

- [Accounts and sign-in](accounts.md)
- [Multi-instance mode](multi-instance.md)
- [Troubleshooting](troubleshooting.md)
- [Documentation index](../README.md)

Developers building from source should start with
[Development](../developer/development.md),
[Testing](../developer/testing.md), and
[Configuration](../developer/configuration.md).
