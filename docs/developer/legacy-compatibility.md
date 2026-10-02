# Roblox compatibility

SUNDAY provides two explicit adapter states.

## Normal single-client mode

Without either the saved multi-instance preference or exact
`LEGACY_COMPAT=1` override, startup selects
`SingleClientRobloxIsolationAdapter`. It launches at most one client, refuses to
adopt an existing Roblox process, and requires exact executable file identity,
process creation identity, path continuity, and a responsive Roblox client
window before issuing an ownership capability.

## Legacy compatibility mode

On current source builds, a saved `multiInstanceMode: true` preference selects
`LegacyRobloxIsolationAdapter` at startup. The exact `LEGACY_COMPAT=1`
environment value remains a backward-compatible override. In either case the
UI displays **LEGACY MULTI-INSTANCE MODE** only after the backend confirms the
legacy adapter is selected.

The adapter preserves the established:

- per-slot clone builder and pre-spawn tree validation;
- singleton compatibility handling;
- three-slot allocation boundary;
- `RELEASED_BUT_BUSY` reclamation behavior;
- process-capability ownership rules;
- close, restart, cleanup, and sibling-preservation behavior.

Clone validation requires the player executable, an accessible `content`
directory, required top-level files, and containment of generated paths. Known
directory reparse points are reproduced deliberately; unexpected path escape
fails before spawn.

## Limitations

- This is not vendor-supported isolation.
- Roblox updates may change filesystem, singleton, or launch behavior.
- Up to three slots is a project boundary, not a performance guarantee.
- SUNDAY never adopts a client it did not launch.
- A Roblox error dialog is not considered a running client.
- Live qualification is version- and environment-specific.

Use only accounts and installations you own or are authorized to operate, and
follow Roblox's terms and applicable rules.

## Qualification

Automated tests use synthetic fixtures for normal directories, directory
reparse points, regular files, invalid `content` shapes, slot reuse, stale
leases, sibling preservation, and process identity. Live drivers are manual,
can launch Roblox, and require authorized accounts plus controlled disposable
state as described in [Testing](testing.md).

The packaged v1.8.15 release candidate was live-qualified on 2026-10-02 using
the normal Settings activation path with `LEGACY_COMPAT` absent. The run proved
the default unavailable adapter, Settings persistence across controlled
restart, the confirmed legacy-mode UI state, one owned client, three concurrent
owned clients, client focus and stop, sibling preservation, restart and slot
reuse, clone cleanup, disabling back to the unavailable adapter, and the exact
`LEGACY_COMPAT=1` compatibility override semantics. No foreign Roblox process
was adopted or terminated. The observed Roblox build was
`version-02c37bc51a384b8f`.

This evidence applies only to that packaged candidate, Roblox build, Windows
environment, and authorized account set. Roblox updates, local installation
shape, or Windows changes can invalidate it; it is not a permanent guarantee.
