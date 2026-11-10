# Launch-plan metadata recovery v1

## Private approval boundary

The public recovery core contains no machine-specific database path, database
fingerprint, or approved record inventory. An approval is supplied explicitly
with `--approval <absolute-private-approval-file>` to either command. The
approval file must remain outside version control and outside every release
payload. Previous local approval material is preserved in ignored artifacts.
The recovery module is excluded from the production runtime allowlist.

The historical record below describes the original local qualification; it
does not authorize another transaction or provide a default recovery target.

## Scope

This procedure reconciles one fixed durable-state inventory. It does not stop,
adopt, focus, launch, or inspect a process. It does not release a logical
environment, delete a clone, create ownership, or manufacture a capability.

The approved set is identified by full SHA-256 fingerprints in
`src/main/launch-plan-recovery.js`:

- Seven R0 plans are evidence-only controls and remain unchanged.
- Seven R1 plans change only their parent state from `COMPLETED` or `FAILED` to
  `RECOVERY_REQUIRED`.
- One R2 plan changes its parent from `RUNNING` to `RECOVERY_REQUIRED` and its
  exact fingerprinted operation from `LAUNCHING` to `UNKNOWN`.

Raw plan, operation, and account identifiers are not report fields.

## Transaction contract

The recovery validates the complete original inventory, every target revision,
the exact serialized value digest, target operation states, account membership,
environment references, and the absence of ownership, lease, and capability
conflicts before writing.

All eight writes run inside the existing synchronous `BEGIN IMMEDIATE`
transaction. Each write includes an exact revision compare-and-swap predicate.
The utility deliberately uses one narrow SQL update rather than
`LaunchPlanStore.update()` or `StateDatabase.put()` because both normal APIs
advance semantic or storage timestamps. This recovery must preserve all plan,
operation, and row timestamps. Only `value_json` and the required CAS revision
change.

The postcondition is validated before commit. Any validation failure, stale
revision, injected fault, write-count mismatch, or postcondition mismatch throws
through `StateDatabase.transaction()` and rolls back the complete transaction.
SQLite therefore leaves either the approved original state or the approved
complete state. A later inspection rejects a mixed state as `AMBIGUOUS`.

## Invocation boundary

There is no real-state mutation command in this phase.

`scripts/dry-run-launch-plan-recovery.js` opens only an explicitly supplied
existing file with SQLite `readOnly`, `query_only`, and `immutable=1`. Immutable
mode avoids writing SQLite shared-memory metadata. The reader refuses a
non-empty WAL or rollback journal because immutable mode must never ignore
pending durable state. It can inspect the real database, but it exposes no write
API.

The transaction function requires a caller-supplied mutation authority. The
only authority supplied by this implementation accepts database paths inside a
dedicated `sunday-launch-recovery-*` system-temporary directory. Tests therefore
cannot point their mutation configuration at the application profile. Enabling
a real mutation path requires a separate reviewed change and explicit owner
authorization.

## Expected inventories

Before recovery:

- Plans: `COMPLETED 91`, `RUNNING 1`, `BLOCKED 12`,
  `RECOVERY_REQUIRED 7`, `FAILED 3`, `PARTIAL 1`.
- Operations: `STOPPED 148`, `LAUNCHING 1`, `UNAVAILABLE 14`, `UNKNOWN 17`,
  `FAILED 4`.

After recovery:

- Plans: `COMPLETED 86`, `RUNNING 0`, `BLOCKED 12`,
  `RECOVERY_REQUIRED 15`, `FAILED 1`, `PARTIAL 1`.
- Operations: `STOPPED 148`, `LAUNCHING 0`, `UNAVAILABLE 14`, `UNKNOWN 18`,
  `FAILED 4`.

The expected counts are preconditions and postconditions, not normalization
targets. A mismatch blocks recovery.

## Synthetic qualification

`test/launch-plan-recovery.test.js` creates independent temporary databases and
proves:

- exactly eight records change and R0/unrelated records remain unchanged;
- R1 children and R2 environment/slot evidence survive;
- semantic and storage timestamps remain unchanged;
- unknown fields survive;
- stale revisions, unexpected states, missing environment evidence, partial
  recovery, authority conflicts, and sensitive target fields fail closed;
- mid-transaction and pre-commit faults roll back all writes;
- complete state is recognized idempotently by the read-only reader; and
- reports never contain synthetic credential or capability canaries.

The suite uses deterministic fault points and no sleeps.

## Real dry run

After the synthetic suite passes, run only:

```powershell
node scripts/dry-run-launch-plan-recovery.js --database <absolute-database-path>
```

The command must report `mode: READ_ONLY_DRY_RUN`, SQLite integrity `ok`, status
`ORIGINAL`, `safeToApply: true`, the expected inventories, exactly fifteen
fingerprinted targets, and no mismatches. File size, modification time, and hash
must be recorded before and after to prove that the real database was unchanged.

The historical forensic log is outside this procedure and must not be opened,
copied, scanned, truncated, or rewritten.
