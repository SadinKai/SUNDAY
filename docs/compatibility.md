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
leases, sibling preservation, and process identity. The v1.8.14 production gate
runs the packaged legacy driver on a dedicated, controlled Windows host with
authorized test accounts. It refuses to start while any Roblox client already
exists, uses only SUNDAY-issued process capabilities for actions, verifies
responsive one-, two-, and three-client operation, and requires ordered teardown
with no clone directories left behind.

The future provider-backed isolation architecture and its disposable-VM
qualification remain separate work. They are not prerequisites for the legacy
compatibility mechanism shipped in v1.8.14. See [Testing](testing.md) for the
current live-test boundary.
