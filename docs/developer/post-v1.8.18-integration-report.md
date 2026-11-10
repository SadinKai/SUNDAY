# SUNDAY post-v1.8.18 controlled integration report

Generated 2026-10-09. This report covers an uncommitted, unpublished integration
candidate. It does not alter or replace the immutable v1.8.18 release.

## Provenance and boundary

- Worktree: `C:\Games\Sunday-postrelease-integration`
- Branch: `integration/post-v1.8.18-fixes-20261009`
- Base commit: `b8ca07fe390127074cd8180e1803561758f11ef2`
- Base tree: `3ef6100361d93ce67ec199f95e100f3b0b669355`
- Reviewed source: `C:\Games\Sunday-postrelease-audit` at
  `4aafac8b591d8e822b23f600672ba464ddaf874b`
- Reviewed source tree: `3ef6100361d93ce67ec199f95e100f3b0b669355`
- Immutable v1.8.18 tag target: `5d935b3c4f0e983785bec3f39a01f0d9e6f9cba8`
- Immutable published executable SHA-256:
  `cd61da9c0f11e862b624c619d15b03dc2fd2b988412384eabd02b8c0f4699de4`

The integration base and reviewed source have the same Git tree. The newer
provenance commit was selected as the base because it retains the corrected
v1.8.18 evidence documents while leaving the source bytes identical. The 11
reviewed files were transferred exactly; each integration SHA-256 matched its
reviewed-source counterpart before validation.

No commit, push, merge, tag, publication, release, installer execution, real
Roblox launch, Roblox process action, process command-line inspection, or real
account/cookie/ticket/session use was performed.

## Integrated changes

The integration contains POST-001 through POST-005 plus POST-011's
deterministic cancellation/allocation race correction:

- POST-001 and POST-002 retain exact capability/environment authority through
  persistence, recovery, cleanup, and restart uncertainty.
- POST-003 compares the full game/server identity and serializes polling.
- POST-004 preserves `Unknown` across backend and renderer presence state and
  suppresses stale People refresh completion.
- POST-005 completion-correlates every renderer launch/restart mutation,
  blocks duplicate dispatch, and treats lost responses as unresolved without
  offering an unsafe retry.
- POST-011 waits for mutation-producing allocation/launch work to settle after
  cancellation, attaches any returned authority, and then performs exact
  cleanup. Its regression uses a deterministic barrier rather than timing.

Exact modified source/test files:

1. `src/main/accounts.js`
2. `src/main/launch-orchestration.js`
3. `src/main/legacy-roblox-isolation-adapter.js`
4. `src/main/people.js`
5. `src/renderer/actions.js`
6. `src/renderer/router.js`
7. `src/renderer/views/games.js`
8. `src/renderer/views/people.js`
9. `test/phase5-orchestration.test.js`
10. `test/safe-unit.test.js`
11. `test/six-client-capacity.test.js`

Diff size: 1,113 insertions and 116 deletions. `git diff --check` passed.

## Explicit exclusions

- No six-client ceiling, allocation order, clone topology, singleton guard,
  Tauri shell, installer implementation, dependency, lockfile, schema,
  credential storage, updater, or UI-design change was integrated.
- POST-006 through POST-010 and POST-012 through POST-014 remain deferred,
  false-positive, intentional-boundary, or qualification-only findings as
  previously classified.
- Seven untracked audit documents were used only as review context and were
  not copied into this worktree. This integration report is the sole added
  documentation file.
- No prior `artifacts`, `dist`, `node_modules`, Rust `target`, `Working`, account
  database, cookie, or other ignored machine-local content was copied.
- The immutable v1.8.18 tag, released assets, and published hashes are
  unchanged.

## Validation

All results below were rerun from this integration worktree and are not reused
from the audit candidate:

| Gate | Result |
| --- | --- |
| Focused changed-path JavaScript regressions | PASS, 68/68 |
| Full JavaScript suite | PASS, 172/172 |
| Source-policy and release-security subset | PASS, 27/27 |
| JavaScript syntax inventory | PASS, 93 files |
| Release sensitive-material audit | PASS, 194 files; no raw values emitted |
| npm full and production audits | PASS, 0 vulnerabilities |
| Tauri fmt / Clippy with warnings denied | PASS |
| Tauri Rust tests | PASS, 3/3 |
| Installer fmt / Clippy with warnings denied | PASS |
| Installer Rust tests | PASS, 11/11 |
| Installer RustSec audit | PASS, no vulnerability |
| Tauri RustSec audit | PASS, no vulnerability; 7 allowed warnings |
| Ephemeral signed release-manifest qualification | PASS, sequence 1815; 2 artifacts |
| Packaged renderer selection | PASS; mocked backend; 0 Roblox calls |
| Fresh empty-profile packaged navigation | PASS; credentials absent and not logged |
| Packaged single-instance ownership | PASS; one backend owner |
| Installer/ZIP closed-world artifact audit | PASS |

Packaged selection trace: A+B were selected; the successful completion cleared
selection; active-client refresh and account refresh kept it empty; selecting C
produced the next call with only C. Later C and D completions also cleared their
selection. The executable reported version 1.8.18 and capacity 6.

Navigation reached DOM/shell readiness in 501 ms and status readiness in
5,286 ms. Warm route transitions were at most 12.6 ms in this run. Cold Games
content took 3,069.1 ms, dominated by a 2,954.2 ms network-backed browse call;
this is measured evidence, not a general latency guarantee. The temporary empty
profile was removed after the test.

Single-instance qualification used an isolated portable copy and AppData. The
owner remained running, the second invocation forwarded then exited, and one
backend Node owner was observed. The harness records Roblox qualification as
`NOT RUN`, with no launch or process action attempted.

## Fresh artifacts

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `dist/Sunday/Sunday.exe` | 10,476,032 | `e6a541d94b4c69d7d484cef67e7731fd249806f9bdbb3ed29c30ffa353f27795` |
| `dist/SundayInstaller.exe` | 45,062,225 | `c2b45d81a6259ab2c58343d86814e7486b2d127599e27aa401f3224f778697d7` |
| `dist/SundayPortable_1.8.18_x64.zip` | 44,276,494 | `b24eebb8879c1333565bc21f7c8833d4ac7cc7d901c44b428b6e6ca2184d8149` |
| `dist/SundayUninstall.exe` | 511,488 | `bc3a8567f130aac429b78d427e408d895052d550ea716c07ae7ba73748d5b836` |
| `dist/Sunday/node.exe` | 86,988,616 | `17347995af08dadcc73a1a154f0942559fbc3f37b9ba57d4576b4d2bcb2834a2` |

- Portable tree: 168 files.
- Deterministic portable inventory SHA-256:
  `3125dc77449b729b490aaffedbaa137e4c8a902cab92bcae66627cfef357f17a`
- Portable ZIP: 168 files and exact content equality with `dist/Sunday`.
- Installer payload: 170 extracted files, comprising 169 closed-world manifest
  entries plus `sunday-install-manifest.json`.
- Embedded install-manifest SHA-256:
  `965b9fb75209c3237887de9f7f1264f72b7bc747ec6f760b3266a248ec109c56`
- Embedded launcher, Node runtime, and uninstaller each equal their standalone
  artifact by SHA-256.
- Release inventory SHA-256:
  `e3ef71a5a5561822e9e096654bfe915a12c7efb63e76d2732ff8331bf8dfb51a`
- Artifact-audit report SHA-256:
  `3a60094e576b9b5c1c4a7d120ed4e6a4eec6871e11282003c8eccbe60d56998c`
- `Sunday.exe`, installer, and uninstaller are intentionally unsigned. The
  bundled Node runtime retains a valid OpenJS Foundation signature.
- Updater activation remains `UNAVAILABLE`; no automatic-update feed exists.

## Residual uncertainty and next test

This candidate has local, synthetic, and packaged-fixture qualification only.
It does not establish real Roblox launch, cancellation, restart, six-client,
account-provider, production-signing, published-download, or field behavior.
Seven allowed RustSec warnings remain in the Tauri transitive graph. Durable
recovery during a permanent simultaneous storage outage and cross-window
exactly-once launch correlation remain outside this patch.

The next test is a controlled real-client qualification using only the exact
`Sunday.exe` hash above and dedicated test accounts: launch selected A+B, wait
until both are authoritatively `RUNNING`, refresh active clients, refresh
accounts, prove renderer selection is empty, then select C and prove the newly
created plan contains only C before allowing C to launch. Stop immediately on
any foreign-process observation, ambiguous ownership, selection repopulation,
or plan membership beyond C. No artifact should be published from that run.

## Decision

**INTEGRATION CANDIDATE READY FOR LIVE QUALIFICATION**

This decision is not a release approval, production-readiness claim, or
activation authorization.
