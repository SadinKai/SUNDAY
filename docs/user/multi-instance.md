# Multi-instance mode

Multi-instance mode lets SUNDAY launch up to three managed Roblox clients by
using its existing legacy compatibility adapter. It is disabled by default and
is not an official Roblox feature.

## Enable it

1. Open **Settings**.
2. Open **Multi-instance mode**.
3. Enable **Multi-instance mode**.
4. Select **Save settings**.
5. Restart SUNDAY when prompted.

The normal Settings control is present in current source builds. The already
published v1.8.14 binaries predate it and still require the exact
`LEGACY_COMPAT=1` startup override from the release notes.

After restart, the Launch screen shows **LEGACY MULTI-INSTANCE MODE** when the
legacy adapter was actually selected. Diagnostics shows the selected adapter
and whether activation came from the saved setting or the backward-compatible
`LEGACY_COMPAT=1` environment variable.

## Disable it

Turn the setting off, save, and restart SUNDAY. If Diagnostics says the mode
was activated by the environment, remove `LEGACY_COMPAT=1` from the process
that starts SUNDAY and restart again. The UI setting cannot silently override
an explicit startup environment variable.

## Safety boundary

The setting selects the existing adapter; it does not bypass Roblox detection,
clone validation, slot ownership, process capabilities, or exact-client stop
and restart checks. A missing Roblox installation or an unsafe client slot
still blocks launch.

Use only accounts, installations, and processes you own or are authorized to
operate. Roblox updates can change compatibility outside SUNDAY's control.

The packaged legacy path was live-qualified before this documentation update.
That qualification is specific to the tested build, Roblox version, and
Windows environment; it is not a permanent compatibility guarantee, and this
documentation work did not rerun a live Roblox test.

Developers can read the full [legacy compatibility boundary](../developer/legacy-compatibility.md).
