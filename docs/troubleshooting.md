# Troubleshooting

## The UI says waiting for isolated environment

This is the expected default. To select the compatibility adapter, close SUNDAY
and start it from a process that inherits exactly:

```powershell
$env:LEGACY_COMPAT = '1'
npm run start
```

Confirm the backend status reports `LegacyRobloxIsolationAdapter` and the UI
shows **LEGACY MULTI-INSTANCE MODE**. `true`, `yes`, and `0` are intentionally
rejected.

## Roblox is not detected

Use Settings to select the installed `RobloxPlayerBeta.exe`. Do not copy or
modify the real installation manually. If a configured location no longer
exists after a Roblox update, select the current executable again.

## Content is not a directory

The legacy clone validator aborts before spawning when the generated `content`
entry is inaccessible or not directory-shaped. Do not bypass validation. Capture
sanitized metadata—not account data or cookies—and report the Roblox version and
whether the original entry is a normal directory or reparse point.

## A client will not restart in the same slot

A released slot may remain `RELEASED_BUT_BUSY` while a mapped sibling still uses
hard-linked content. SUNDAY should allocate another available slot and reclaim
the busy slot only after the ownership evidence clears. Do not terminate foreign
Roblox processes to force reuse.

## Sign-in expired

Use **Sign in again** for the affected account. Never paste a cookie into a log,
issue, fixture, or configuration file.

## Build fails before Rust compilation

Verify Node 22.23.x, Rust 1.96.0, the MSVC x64 target, Visual Studio C++ Build
Tools, Windows SDK, and WebView2. Then remove only generated dependency/build
directories, run `npm ci`, and retry with locked Cargo inputs.

## Production packaging refuses to continue

This is expected when signing is required but certificate, password, publisher,
or manifest inputs are missing or invalid. Do not disable the checks. Use an
unsigned local build only as development evidence.

## Reporting diagnostics

Include the SUNDAY version, Windows version, exact reproduction steps, selected
adapter, isolation state, and sanitized error text. Remove user names, paths,
account identifiers, cookies, tokens, databases, and screenshots containing
private information.
