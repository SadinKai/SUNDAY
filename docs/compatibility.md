# Roblox compatibility

SUNDAY provides two explicit adapter states.

## Safe default

Without `LEGACY_COMPAT=1`, startup selects
`UnavailableRobloxIsolationAdapter`. Account selection and launch planning remain
available, but no Roblox ticket is resolved and no client is spawned.

## Legacy compatibility mode

When the SUNDAY process inherits exactly `LEGACY_COMPAT=1`, startup selects
`LegacyRobloxIsolationAdapter` and the UI displays **LEGACY MULTI-INSTANCE
MODE**.

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
leases, sibling preservation, and process identity. Live drivers are manual and
must run only in a disposable Windows VM as described in [Testing](testing.md).
