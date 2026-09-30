# Configuration

SUNDAY reads configuration from its inherited process environment. The
repository's `.env.example` documents names and safe empty defaults; SUNDAY does
not automatically load that file.

## Runtime selection

| Variable | Meaning | Safe default |
| --- | --- | --- |
| `LEGACY_COMPAT` | Selects `LegacyRobloxIsolationAdapter` only when exactly `1`. | `0` / absent |
| `SUNDAY_USER_DATA` | Overrides the runtime-state directory for controlled tests. | OS application-data location |
| `SUNDAY_ISOLATED_VM` | Guard required by native UI test drivers when exactly `1`. | absent |
| `SUNDAY_TEST_EXE` | Exact packaged executable for UI qualification. | absent |

`LEGACY_COMPAT=true` does not enable the legacy adapter. The application reads
the variable before adapter selection and exposes the selected adapter and
isolation reason through backend status.

## Signing and release inputs

| Variable | Purpose |
| --- | --- |
| `SUNDAY_REQUIRE_SIGNING` | Requires signing to succeed when set to `1`. |
| `SUNDAY_CODESIGN_PFX` | Path to controlled Authenticode certificate material. |
| `SUNDAY_CODESIGN_PASSWORD` | Password supplied by the release environment. |
| `SUNDAY_RELEASE_SEQUENCE` | Monotonic positive manifest sequence. |
| `SUNDAY_RELEASE_PRIVATE_KEY_PKCS8_B64` | Private manifest-signing key, release environment only. |
| `SUNDAY_RELEASE_PUBLIC_KEY_SPKI_B64` | Public manifest verification key. |
| `SUNDAY_RELEASE_PUBLISHER` | Expected release publisher identity. |
| `SUNDAY_RELEASE_KEY_ID` | Identifier for the manifest verification key. |
| `SUNDAY_RELEASE_MANIFEST_URL` | Canonical HTTPS manifest location. |
| `SUNDAY_RELEASE_BASE_URL` | Canonical HTTPS artifact base location. |

Never put real signing values into `.env.example`, GitHub issues, build logs, or
source control. GitHub Actions supplies secret values through repository or
environment secrets and removes temporary certificate material in an `always()`
cleanup step.

## Repository hygiene

Generated directories, populated environment files, runtime databases, logs,
clone trees, installers, executables, and private screenshots are ignored.
`.env.example`, manifests, lockfiles, workflows, source, tests, and public docs
must remain trackable.
