# Configuration

Normal user preferences are persisted through SUNDAY's existing settings
store. Process environment variables remain available for controlled testing,
release tooling, and backward compatibility. The repository's `.env.example`
documents names and safe empty defaults; SUNDAY does not automatically load
that file.

## Application settings

The `multiInstanceMode` boolean defaults to `true` only when the preference has
never existed. Explicit saved `true` and `false` values survive normalization
and upgrades. On startup, the backend loads the preference before adapter
selection: missing or `true` selects `LegacyRobloxIsolationAdapter`; explicit
`false` selects `UnavailableRobloxIsolationAdapter`. A change requires a
user-confirmed application restart because the selected adapter is intentionally
immutable for the process lifetime.

The renderer receives only the setting, selected-adapter status, activation
source, and restart requirement. No Roblox cookie or other credential is stored
in this preference.

## Runtime selection

| Variable | Meaning | Safe default |
| --- | --- | --- |
| `LEGACY_COMPAT` | Backward-compatible override that selects `LegacyRobloxIsolationAdapter` only when exactly `1`. | absent; saved/default setting decides |
| `SUNDAY_USER_DATA` | Overrides the runtime-state directory for controlled tests. | OS application-data location |
| `SUNDAY_TEST_EXE` | Exact packaged executable for guarded real-Windows launch qualification. | absent |
| `SUNDAY_LIVE_SETTINGS_QUALIFICATION` | Explicit guard for the authorized packaged multi-instance test. | absent |
| `SUNDAY_LIVE_QUALIFICATION_CLIENTS` | Controlled partial-capacity count for the guarded packaged test; must be `1` through the canonical six-client maximum. | canonical maximum |

`LEGACY_COMPAT=true` does not enable the legacy adapter. An exact environment
value of `1` takes effect even when the saved preference is off. The backend
exposes the saved preference, environment match, activation source, selected
adapter, and isolation reason through diagnostics.

`robloxInstallationId` stores only a stable non-secret candidate identifier for
an explicit selection. `robloxPath` remains the user-entered manual classic
path. Automatic results are cached briefly and invalidated by re-detection,
settings changes, or missing/stale installation evidence. AppX install paths
come from package registration metadata and are not hardcoded.

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
source control. These inputs describe optional future controlled signing
workflows; the v1.8.18 binaries are unsigned. A build that explicitly
requires signing still fails closed when its inputs are missing or invalid.

## Repository hygiene

Generated directories, populated environment files, runtime databases, logs,
clone trees, installers, executables, and private screenshots are ignored.
`.env.example`, manifests, lockfiles, workflows, source, tests, and public docs
must remain trackable.
