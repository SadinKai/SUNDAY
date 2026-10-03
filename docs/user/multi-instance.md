# Multi-instance mode

Multi-instance mode lets SUNDAY launch one to three managed Roblox clients by
using its existing legacy compatibility adapter. It is enabled by default on a
fresh installation and is not an official Roblox feature.

## First run and existing users

If the preference has never existed, SUNDAY saves and uses `true`. An existing
explicit `true` or `false` remains unchanged during upgrade. The Launch screen
shows **MULTI-INSTANCE MODE** and **Enabled · Uses SUNDAY's legacy Roblox
compatibility path.** only when that adapter was actually selected.

No environment variable is required. The exact `LEGACY_COMPAT=1` startup
override remains only for backward-compatible developer workflows.

## Change it

Open **Settings**, change **Multi-instance mode**, and save. Adapter selection
is immutable for the current process, so SUNDAY offers the same visible restart
prompt for both enabling and disabling. It never restarts without confirmation.

## Disable it

Turn the setting off, save, and restart SUNDAY. If Diagnostics says the mode
was activated by the environment, remove `LEGACY_COMPAT=1` from the process
that starts SUNDAY and restart again. The UI setting cannot silently override
an explicit startup environment variable.

After restart, an explicit saved `false` selects the unavailable planning-only
adapter. SUNDAY can still prepare plans but will not start Roblox. Re-enable the
setting and restart to restore managed launches.

## Roblox installation compatibility

SUNDAY automatically verifies classic players discovered from Roblox protocol
registration, a running-process path used only as evidence, and bounded
LocalAppData, Program Files, Program Files (x86), and ProgramData version roots.
You can re-detect or select another verified candidate in Settings.

Microsoft Store / AppX Roblox is detected dynamically from its registered
package and application metadata. It is not compatible with the legacy clone
mechanism. SUNDAY never changes WindowsApps ACLs or copies protected package
files; install classic Roblox from roblox.com to use this mode.

## Safety boundary

The setting selects the existing adapter; it does not bypass Roblox detection,
clone validation, slot ownership, process capabilities, or exact-client stop
and restart checks. A missing Roblox installation or an unsafe client slot
still blocks launch.

Use only accounts, installations, and processes you own or are authorized to
operate. Roblox updates can change compatibility outside SUNDAY's control.

Live qualification is specific to the exact packaged build, Roblox version,
accounts, and Windows environment. A source, UI-smoke, or synthetic test pass
alone is not evidence that Roblox launched successfully.

Developers can read the full [legacy compatibility boundary](../developer/legacy-compatibility.md).
