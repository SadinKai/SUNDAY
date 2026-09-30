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
9. audit the exact artifact graph and scan source and artifacts for credential
   material without logging matched values;
10. attest the exact release asset set and upload the immutable signed candidate
    for a separate live gate;
11. on a dedicated Windows qualification host, refuse any pre-existing Roblox
    process and exercise the packaged `LEGACY_COMPAT=1` runtime with authorized
    test accounts through one-, two-, and three-client launch, sibling
    preservation, safe restart, responsiveness, ordered teardown, and clone
    cleanup checks;
12. after live qualification succeeds, create a draft release, then download
    and verify the uploaded bytes, checksums, release target, and
    Authenticode publisher; and
13. publish the verified draft as the latest release.

Signing failure is fatal. The workflow removes temporary certificate material in
an unconditional cleanup step. No private signing material belongs in source or
artifacts.

The workflow refuses non-`main` dispatches, an existing version tag or release,
missing CI or CodeQL success for the exact commit, open code-scanning alerts,
missing signing configuration, and missing or failed live legacy qualification.
The live gate uses the signed `dist/Sunday` runtime produced by the build job,
not the development source runtime. It requires a controlled self-hosted Windows
runner labelled `sunday-legacy-qualification`, an absolute
`SUNDAY_LEGACY_QUALIFICATION_USER_DATA` repository variable that points outside
the checkout, and three authorized saved test accounts. The optional
`SUNDAY_LEGACY_QUALIFICATION_ACCOUNT_IDS` variable can select those accounts.
A failed publication attempt removes only the draft release and tag created by
that workflow run.

Version `1.8.14` ships the explicitly enabled legacy compatibility mechanism.
Its production gate does not depend on the future disposable-VM isolation
provider, GPU passthrough, signed guest/image identities, or a VM activation
record. Those belong to the replacement isolation architecture and do not
qualify this release. Legacy compatibility is not an official Roblox feature or
a security boundary; the live result applies only to the exact build and Windows
qualification host that were checked.

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
