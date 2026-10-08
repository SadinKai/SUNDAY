# SUNDAY Launcher v1.8.18

## Managed-client capacity and incremental launches

SUNDAY's legacy compatibility path now uses one consistent logical ceiling of
six managed classic Win32 Roblox clients. Launch planning, saved sessions,
quick launch, follow/join flows, server fill, backend validation, and
Diagnostics all consume the same backend-reported capacity.

Successful incremental launches now remove only the accounts that actually
started from the renderer selection. In the final real-client qualification,
A+B launched together, the selection remained empty through active-client and
account refreshes, C was then submitted alone, and D was submitted alone.
Already-active accounts cannot be selected for a duplicate managed launch.

The allocator and deterministic tests cover the six-client policy and bounded
physical slot headroom. The real-client qualification used four authorized
accounts; E and F were not live-qualified and this release does not claim that
six real clients were exercised.

## Reliability, ownership, and compatibility

Launch cancellation, restart, cleanup, and recovery now preserve uncertainty
instead of reporting success when exact cleanup cannot be proved. Process
observation fails closed, concurrent lifecycle actions are serialized, and
long-lived capabilities are renewed only after exact process identity is
revalidated.

Application restart recovery uses durable non-secret ownership evidence bound
to the exact Windows process creation identity, executable path and file
identity, slot, account, and operation. Opaque capabilities are never
persisted. Matching owned clients receive fresh in-memory capabilities;
foreign Roblox clients remain external, unadopted, and uncontrollable.

The singleton compatibility guard intentionally reserves
`ROBLOX_singletonEvent` by occupying that object name with a mutex. A Roblox
client may continue to own `ROBLOX_singletonMutex`; contention on that mutex is
not treated as a launch-readiness failure. Cross-process cleanup is restricted
to the exact singleton event handle in internally discovered Roblox processes.

## Navigation, state, and credential safety

The application paints its local shell before strict Roblox discovery and
hydrates independent views progressively. Games and People requests now share
bounded in-flight work, use bounded caches, and prevent stale responses from
overwriting newer navigation. Failed Friends loading no longer loops
automatically.

Legacy credential migration protects and verifies all affected records before
the first database commit, compacts and checks the target database, and removes
legacy sources only after the committed protected records are proven. Redirect
bodies are cancelled before retry/follow-up work, and account changes
invalidate dependent cached data.

## Qualification and limitations

The exact packaged `Sunday.exe` qualified with SHA-256
`CD61DA9C0F11E862B624C619D15B03DC2FD2B988412384EABD02B8C0F4699DE4`.
The controlled four-client run passed incremental A+B -> C -> D, exact stop and
restart, application restart ownership restoration, foreign-client
coexistence, final cleanup, and credential/evidence checks.

Legacy multi-instance support remains limited to verified classic Win32 Roblox
installations. Microsoft Store/AppX Roblox is detected but is not supported by
the clone-based legacy mode. Roblox and Windows changes can invalidate this
compatibility behavior, so the current qualification is not a guarantee of
future compatibility.

The SUNDAY application, installer, and uninstaller are intentionally unsigned.
Published SHA-256 checksums establish byte integrity, not publisher identity.
The bundled Node runtime retains its OpenJS Foundation signature. Automatic
update application remains unavailable; updates are manual GitHub Release
downloads.
