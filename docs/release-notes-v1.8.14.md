# SUNDAY v1.8.14

SUNDAY is a Roblox account manager and multi-instance launcher for Windows.

It lets you:

- manage multiple Roblox accounts;
- sign into accounts from one app;
- launch multiple Roblox clients; and
- manage active clients from one dashboard.

## Requirements

- Windows 10 or later (x64)
- Microsoft Edge WebView2 Runtime

## Install and start

1. Download `SundayInstaller.exe` from this release.
2. Run the installer and choose an installation folder.
3. Start **SUNDAY Launcher** from the installed shortcut.
4. Add or select your Roblox accounts, choose a destination, and launch.

The portable `SundayPortable_1.8.14_x64.zip` is also available for users who
do not want to install SUNDAY.

Multi-instance launching requires the explicit compatibility mode documented
in the [compatibility guide](https://github.com/SadinKai/SUNDAY/blob/main/docs/compatibility.md).
For this release, `LEGACY_COMPAT=1` selects the shipping legacy clone/slot
compatibility path; without that exact opt-in, the runtime remains fail-closed.
The signed packaged runtime is live-qualified on Windows with authorized test
accounts before publication. This release does not require the future
isolated-provider VM infrastructure.

Legacy compatibility is not an official Roblox feature, is not endorsed by
Roblox, and is not a security boundary. Qualification is specific to the exact
release build and host configuration tested.

SUNDAY is an independent project and is not affiliated with or endorsed by
Roblox Corporation. Advanced setup and runtime details are available in the
[documentation](https://github.com/SadinKai/SUNDAY/tree/main/docs).
