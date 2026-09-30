# Release engineering

SUNDAY separates source verification, development packaging, and a signed
release. A successful local build is not a production release.

## Canonical version and names

Version `1.8.14` is declared in `package.json`, both Cargo manifests, and
`src-tauri/tauri.conf.json`. Release outputs use:

- `Sunday.exe`;
- `SundayInstaller.exe`;
- `SundayUninstall.exe`;
- `SundayPortable_<version>_x64.zip`;
- `sunday-release.json`.

## Development package

```powershell
npm ci
npm run dist
npm run release:package
npm run audit:artifacts
```

This proves buildability and artifact structure. It does not provide publisher
identity when signing is not required.

## Signed release workflow

The manually dispatched release workflow requires controlled Authenticode and
manifest-signing secrets. Its order is:

1. install locked dependencies and run source tests;
2. check, lint, and test both Rust crates;
3. build `Sunday.exe` and verify its signature;
4. verify the bundled Node runtime signature;
5. create and verify the standalone uninstaller;
6. build the embedded payload and final installer;
7. sign and verify the final installer;
8. generate the portable archive, signed canonical manifest, dependency
   inventories, and SHA-256 checksums;
9. audit the exact artifact graph and attest uploaded assets.

Signing failure is fatal. The workflow removes temporary certificate material in
an unconditional cleanup step. No private signing material belongs in source or
artifacts.

## Reproducibility boundary

Lockfiles, pinned toolchains, controlled GitHub actions, canonical scripts, and
artifact inventories make dependency and build inputs reviewable. Authenticode
timestamps, runner images, PE metadata, and compiler behavior may prevent
bit-for-bit equality across independent builds. Do not claim deterministic
binary reproducibility without separate evidence.

## Checksums and signatures

Checksums detect byte changes but do not independently establish publisher
identity. Verify Authenticode signer, trust chain, timestamp, version resources,
manifest signature, sequence, key identifier, and artifact digest together.

## Update status

The application can validate signed release metadata, but automatic update
application remains unavailable until its end-to-end activation and rollback
path is qualified. Releases must not imply otherwise.
