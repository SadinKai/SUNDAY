# Testing

## Evidence tiers

SUNDAY uses distinct evidence labels:

- **Implemented:** the boundary exists in source.
- **Behaviorally verified:** a host-safe test exercises it.
- **Windows verified:** native behavior passed on a controlled real Windows host.
- **Roblox verified:** an authorized, bounded real Roblox test passed.
- **Release verified:** the exact published or candidate artifact graph passed
  its declared release checks. State separately whether it was signed.

One tier never implies another.

## Canonical JavaScript suite

```powershell
npm ci
npm test
```

The suite covers persistence, concurrent writers, release trust, process
identity, environment RPC, orchestration, synthetic isolation, migration,
runtime adapter selection, native clipboard policy, verified Roblox discovery,
AppX fixture handling, legacy clone/reparse handling, slot reuse, network
policy, installer policy, and source policy. It must not launch Roblox or use
real credentials.

## Rust desktop and installer

```powershell
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-features

cargo check --locked --manifest-path installer/Cargo.toml
cargo clippy --locked --manifest-path installer/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path installer/Cargo.toml
```

Use `cargo fmt ... -- --check` for both manifests before submitting Rust changes.

## Packaging and artifact audit

```powershell
npm run dist
npm run release:package
npm run audit:artifacts
npm run test:release-manifest
```

Packaging tests inspect naming, architecture, version resources, expected
payloads, archive safety, manifest behavior, and byte identity. The v1.8.17
assets are intentionally unsigned; a locally rebuilt artifact is still
not evidence about the bytes published on GitHub.

## Single-instance qualification

The packaged single-instance check is outside the default suite:

```powershell
npm run test:single-instance
```

It verifies that a second packaged process forwards to the existing owner and
does not create a second backend owner.

## Legacy compatibility tests

Automated legacy regression coverage is included in `npm test` and uses
synthetic fixtures. Optional live drivers are guarded separately:

```powershell
$env:LEGACY_COMPAT = '1'
npm run test:legacy-singleclient
npm run test:legacy-multiclient
```

These commands can start Roblox. Run them only with explicit authorization,
test accounts, and no valuable Roblox process, cookie, or user data in scope.
They are never part of CI or a normal build.

Release qualification starts the exact candidate without `LEGACY_COMPAT` and
with a fresh temporary profile. It must prove that a missing preference selects
the legacy adapter by default without spawning Roblox automatically. With the
authorized saved-account profile it then exercises one and exactly three live
clients, focus, stop, restart while siblings remain, slot reuse, teardown, clone
cleanup, explicit disable/restart to the unavailable adapter, and the exact
environment override. The environment-override drivers remain
backward-compatibility checks; they do not substitute for the default
Settings-based packaged test.

The guarded packaged Settings driver is invoked only for an explicitly
authorized release qualification:

```powershell
$env:SUNDAY_LIVE_SETTINGS_QUALIFICATION = '1'
$env:SUNDAY_TEST_EXE = (Resolve-Path 'dist/Sunday/Sunday.exe').Path
Remove-Item Env:LEGACY_COMPAT -ErrorAction SilentlyContinue
npm run test:legacy-settings-packaged
```

It writes a sanitized result to
`artifacts/settings-live-qualification-v<VERSION>.json`. Account identifiers,
session material, and opaque capabilities are not included in that report.

No live Roblox test is implied by a source, CI, packaging, or smoke-test pass.

## Store and package-volume qualification

`test/roblox-discovery.test.js` uses synthetic AppX package/manifest fixtures,
including the current **Roblox - Windows** display name, missing executable
declarations, invalid publishers, Studio exclusion, stale registration, and a
non-default package volume. Fixture coverage proves parsing and selection, not
real Store compatibility.

The release machine must inspect its registered AppX/MSIX metadata without
bypassing WindowsApps ACLs or modifying protected content. If the current Store
app is installed, record its package identity, AUMID/application selection,
actual registered InstallLocation, and clear legacy-incompatible result without
exposing the raw user path. If it is absent, report the live Store scenario as
unqualified and rely only on the automated fixtures for implementation
coverage. A non-default PackageVolume is likewise unqualified unless directly
observed. Neither scenario is a VM or publication prerequisite.

## Migration tests

`test/identity-migration.test.js` verifies durable state and browser-storage
migration without overwriting current identity data. Installer migration is
covered by Rust tests and source-policy assertions.

## Test integrity

A security regression test should fail for an observable reason if the unsafe
behavior is restored. Comment matching or a passing source scan is not a
substitute for behavioral evidence.
