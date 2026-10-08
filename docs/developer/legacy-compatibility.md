# Roblox compatibility

SUNDAY provides two explicit adapter states.

## Planning-only unavailable mode

An explicit saved `multiInstanceMode: false` preference selects
`UnavailableRobloxIsolationAdapter`. It can produce a launch plan but cannot
execute Roblox. Removing the preference on a fresh profile does not select this
state because v1.8.18 defaults a missing preference to enabled.

## Legacy compatibility mode

On v1.8.18, a missing first-run preference or saved `multiInstanceMode: true`
selects `LegacyRobloxIsolationAdapter` at startup. The exact
`LEGACY_COMPAT=1` environment value remains a backward-compatible override. In
either case the UI displays **MULTI-INSTANCE MODE** and the legacy compatibility
description only after the backend confirms the adapter is selected.

The adapter preserves the established:

- per-slot clone builder and pre-spawn tree validation;
- singleton compatibility handling;
- six-managed-client logical allocation boundary with bounded physical headroom;
- `RELEASED_BUT_BUSY` reclamation behavior;
- process-capability ownership rules;
- close, restart, cleanup, and sibling-preservation behavior.

Clone validation requires the player executable, an accessible `content`
directory, required top-level files, and containment of generated paths. Known
directory reparse points are reproduced deliberately; unexpected path escape
fails before spawn.

The adapter accepts only a verified classic Win32 Roblox candidate. AppX/MSIX
packages are detected and reported, but fail preflight with an actionable
compatibility reason before clone allocation. Package ACLs and contents are not
modified.

## Limitations

- This is not vendor-supported isolation.
- Roblox updates may change filesystem, singleton, or launch behavior.
- Six managed clients is a project boundary, not a performance guarantee.
- SUNDAY never adopts a client it did not launch.
- A Roblox error dialog is not considered a running client.
- Live qualification is version- and environment-specific.

The allocator keeps logical client capacity separate from physical clone-slot
history. A slot is reusable only after its exact ownership is released and its
executable is no longer occupied. If several histories remain
`RELEASED_BUT_BUSY`, bounded headroom allows a later safe slot without raising
the managed-client ceiling above six.

Application restart recovery is equally fail-closed. The ownership store
contains only non-secret process and file identity evidence. Exact matches are
given fresh in-memory capabilities; stale, mismatched, or merely foreign
processes are not adopted. Launch-plan persistence contains no capability
secret. Existing v1.8.17 plans and slot state remain readable. A pre-upgrade
operation that was still running is restored only with matching new ownership
evidence; without that evidence it is reported as UNKNOWN and is not adopted
or killed.

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

The full-capacity v1.8.18 gate exercises bulk six, incremental A+B then C
through F, application restart while all six remain alive, clean seventh-launch
rejection, exact restart/stop/reuse, and responsive `WINDOWSCLIENT`
verification. A controlled bounded qualification may exercise fewer authorized
accounts, but its release evidence must state the exact real-client count and
must not claim that the remaining capacity passed a live test. Source,
synthetic, and build passes do not substitute for either live evidence class.
