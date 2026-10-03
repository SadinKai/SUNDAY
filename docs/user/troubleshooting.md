# Troubleshooting

## A launch fails

Multi-instance mode is enabled by default and launches only SUNDAY-owned Roblox
clients. If a launch fails:

1. Close any unrelated Roblox client; SUNDAY will not adopt it.
2. Confirm a verified classic Roblox installation is ready on the Launch screen.
3. Retry once.
4. Open **Diagnostics** and select **Copy sanitized launch diagnostics**.

The copied report contains mode, Roblox version, process-state booleans,
failure stage, and a sanitized reason. It excludes cookies, authentication
tickets, capability values, logs, and personal filesystem paths.

## Multi-instance mode is disabled

To restore managed launches:

1. Open **Settings** and select **Multi-instance**.
2. Turn on **Enable multi-instance mode** and save.
3. Restart SUNDAY when prompted.
4. Confirm **MULTI-INSTANCE MODE** and the enabled compatibility description
   appear.

The exact `LEGACY_COMPAT=1` environment override remains available for
backward-compatible developer workflows. Values such as `true`, `yes`, and
`0` do not enable that override. Developers can inspect the exact selection
source in Diagnostics.

## The setting changed but the mode did not

Adapter selection happens once during startup. Save the setting and use the
offered **Restart SUNDAY** action. If you cancel, the running adapter stays
unchanged until the next restart.

If Diagnostics reports that the environment override selected the adapter,
turning the saved setting off cannot override it. Remove `LEGACY_COMPAT=1` from
the process that starts SUNDAY and restart.

## Roblox is not detected or became stale

Use **Re-detect** in Settings. SUNDAY rechecks registered Roblox protocols,
bounded classic installation roots, current running-process evidence, and
registered AppX/MSIX packages. If detection still fails, select the installed
classic `RobloxPlayerBeta.exe` manually. Do not copy or modify the installation.

## Microsoft Store Roblox was detected

The Store package is read-only and cannot be used by SUNDAY's legacy clone
mechanism. Install the standard Windows Roblox client from roblox.com, choose
**Re-detect**, and select the verified classic installation. Do not change
WindowsApps permissions or copy package contents.

## Clipboard permission prompt

v1.8.17 no longer reads the clipboard when SUNDAY opens, gains focus, or enters
Launch. Select **Paste Roblox Link** when you intentionally want to import a
link. The bounded native Windows read happens only after that click and does
not require the WebView clipboard-read permission. Invalid text is ignored with
an explanatory message.

## Content is not a directory

The legacy clone validator aborts before spawning when the generated `content`
entry is inaccessible or not directory-shaped. Do not bypass validation.
Capture sanitized metadata—not account data or cookies—and report the Roblox
version and whether the original entry is a normal directory or reparse point.

## A client will not restart in the same slot

A released slot may remain `RELEASED_BUT_BUSY` while a mapped sibling still
uses hard-linked content. SUNDAY should allocate another available slot and
reclaim the busy slot only after ownership evidence clears. Do not terminate
foreign Roblox processes to force reuse.

## Sign-in expired

Use **Sign in again** for the affected account. Never paste a cookie into a log,
issue, fixture, or configuration file.

## Windows SmartScreen shows a warning

The v1.8.17 installer and portable application are intentionally
unsigned. Download only from the canonical
[Releases page](https://github.com/SadinKai/SUNDAY/releases) and compare the
file's SHA-256 hash with the published `SHA256SUMS.txt`. A matching checksum
confirms byte integrity; it is not a publisher signature.

## Automatic updates are unavailable

Automatic update installation is not active in v1.8.17. Use **View releases**
to open the canonical Releases page and download updates manually. SUNDAY does
not claim that an unavailable updater installed anything.

## A source build fails before Rust compilation

Developers should verify Node 22.23.x, Rust 1.96.0, the MSVC x64 target, Visual
Studio C++ Build Tools, Windows SDK, and WebView2. Continue with
[Development](../developer/development.md).

## Reporting diagnostics

Use **Copy sanitized launch diagnostics**, then include exact reproduction
steps. Do not attach the raw AppData log, account database, cookie, token,
authentication ticket, or a screenshot containing private information. Read
[Privacy](../../PRIVACY.md) before sharing files.
