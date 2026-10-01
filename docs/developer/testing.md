# Testing

## Evidence tiers

SUNDAY uses distinct evidence labels:

- **Implemented:** the boundary exists in source.
- **Behaviorally verified:** a host-safe test exercises it.
- **Windows verified:** native behavior passed in an isolated Windows setup.
- **Roblox verified:** an authorized disposable Roblox test passed.
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
payloads, archive safety, manifest behavior, and byte identity. The v1.8.15
assets are intentionally unsigned; a locally rebuilt artifact is still
not evidence about the bytes published on GitHub.

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
Use a controlled Windows environment and a dedicated disposable user-data
directory. A VM or snapshot is recommended when host state cannot be isolated.

## Legacy compatibility tests

Automated legacy regression coverage is included in `npm test` and uses
synthetic fixtures. Optional live drivers are guarded separately:

```powershell
$env:LEGACY_COMPAT = '1'
npm run test:legacy-singleclient
npm run test:legacy-multiclient
```

These commands can start Roblox. Run them only with explicit authorization,
test accounts, and no valuable Roblox process, cookie, or user data in scope. A
disposable VM remains the preferred isolation when available, but the evidence
requirement is controlled, disposable state—not a claim that a VM alone makes
the test safe. They are never part of CI or a normal build.

For v1.8.15, release qualification must start the exact packaged candidate
without `LEGACY_COMPAT`, enable multi-instance mode in Settings, complete the
controlled restart, and then exercise the authorized live client path. The
environment-override drivers remain backward-compatibility checks; they do not
substitute for the Settings-based packaged test.

The guarded packaged Settings driver is invoked only for an explicitly
authorized release qualification:

```powershell
$env:SUNDAY_LIVE_SETTINGS_QUALIFICATION = '1'
$env:SUNDAY_TEST_EXE = (Resolve-Path 'dist/Sunday/Sunday.exe').Path
Remove-Item Env:LEGACY_COMPAT -ErrorAction SilentlyContinue
npm run test:legacy-settings-packaged
```

It writes a sanitized result to
`artifacts/settings-live-qualification-v1.8.15.json`. Account identifiers,
session material, and opaque capabilities are not included in that report.

No live Roblox test is implied by a source, CI, packaging, or smoke-test pass.

## Migration tests

`test/identity-migration.test.js` verifies durable state and browser-storage
migration without overwriting current identity data. Installer migration is
covered by Rust tests and source-policy assertions.

## Test integrity

A security regression test should fail for an observable reason if the unsafe
behavior is restored. Comment matching or a passing source scan is not a
substitute for behavioral evidence.
