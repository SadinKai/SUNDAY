# Testing

## Evidence tiers

SUNDAY uses distinct evidence labels:

- **Implemented:** the boundary exists in source.
- **Behaviorally verified:** a host-safe test exercises it.
- **Windows verified:** native behavior passed in an isolated Windows setup.
- **Roblox verified:** an authorized disposable Roblox test passed.
- **Release verified:** the exact signed artifact graph passed release checks.

One tier never implies another.

## Canonical JavaScript suite

```powershell
npm ci
npm test
```

The suite covers persistence, concurrent writers, release trust, process
identity, environment RPC, orchestration, synthetic isolation, migration,
runtime adapter selection, legacy clone/reparse handling, slot reuse, network
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
payloads, archive safety, manifest signatures, and byte identity. A local
unsigned artifact is development evidence only.

## Single-instance and UI smoke tests

These native tests are outside the default suite:

```powershell
$env:SUNDAY_ISOLATED_VM = '1'
npm run test:single-instance
npm run test:smoke:isolated-vm
npm run test:ui:isolated-vm
```

The UI drivers require an exact packaged executable and, where documented by the
driver, an already-running process with a dedicated local debugging endpoint.
Use a disposable VM or snapshot.

## Legacy compatibility tests

Automated legacy regression coverage is included in `npm test` and uses
synthetic fixtures. Optional live drivers are guarded separately:

```powershell
$env:LEGACY_COMPAT = '1'
npm run test:legacy-singleclient
npm run test:legacy-multiclient
```

These commands can start Roblox. Run them only on a dedicated, controlled
Windows host with authorized test accounts and no pre-existing Roblox process.
Keep its SUNDAY state outside the repository and separate from normal user data.
The release workflow runs the packaged multi-client driver as a required live
gate; normal pull-request CI and a normal local build remain non-live.

The future provider-backed isolation tests still use the disposable-VM boundary
described above. That provider is separate from the v1.8.14 legacy compatibility
path and is not a production prerequisite for this release.

No live Roblox test is implied by a source, CI, packaging, or smoke-test pass.

## Migration tests

`test/identity-migration.test.js` verifies durable state and browser-storage
migration without overwriting current identity data. Installer migration is
covered by Rust tests and source-policy assertions.

## Test integrity

A security regression test should fail for an observable reason if the unsafe
behavior is restored. Comment matching or a passing source scan is not a
substitute for behavioral evidence.
