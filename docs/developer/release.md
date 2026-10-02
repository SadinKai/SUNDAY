# Release engineering

SUNDAY v1.8.16 uses a straightforward unsigned GitHub release. A successful
source build is not public until the exact audited files are uploaded and their
published checksums are verified.

## Canonical version and public files

Version `1.8.16` is declared in `package.json`, both Cargo manifests, and
`src-tauri/tauri.conf.json`. The public release contains only:

- `SundayInstaller.exe`;
- `SundayPortable_1.8.16_x64.zip`; and
- `SHA256SUMS.txt`.

Source archives generated automatically by GitHub are not SUNDAY build
artifacts. Local databases, account data, cookies, credentials, certificates,
private keys, logs, and build residue must never be uploaded.

## Build and verify

From the exact merged `main` commit:

```powershell
npm ci
npm test
npm audit --omit=dev --audit-level=moderate
npm run dist
npm run release:package
npm run audit:artifacts
npm run audit:release-secrets -- dist/Sunday release-assets
```

Copy only the installer and portable ZIP into `release-assets`, then generate
`SHA256SUMS.txt` from those two files. Verify the uploaded copies against that
checksum file after publication.

## Launch qualification

A release candidate that changes Roblox launch behavior must also pass
both guarded packaged launch gates using the exact built `Sunday.exe` and
explicitly authorized test accounts:

```powershell
$env:SUNDAY_TEST_EXE = (Resolve-Path 'dist/Sunday/Sunday.exe').Path
Remove-Item Env:LEGACY_COMPAT -ErrorAction SilentlyContinue
$env:SUNDAY_LIVE_SINGLECLIENT_QUALIFICATION = '1'
npm run test:singleclient-packaged-live
$env:SUNDAY_LIVE_SETTINGS_QUALIFICATION = '1'
npm run test:legacy-settings-packaged
```

The normal gate must pass before the legacy gate. Both reports are local,
sanitized qualification evidence and are never packaged as public assets. A
successful local run does not identify the cause of a different machine's
failure without that machine's sanitized diagnostics or forensic stage data.

The multi-instance release gate is the existing Settings-selected
`LegacyRobloxIsolationAdapter` running its bounded clone, native singleton,
slot-ownership, capability, and cleanup path on real Windows. Provider research
and environment-broker qualification are not part of the v1.8.16 shipping or
publication path.

## Unsigned initial binaries

The v1.8.16 Windows binaries are intentionally unsigned. Windows
SmartScreen may display a warning when the installer or application starts.
Do not claim publisher identity, fabricate signatures, or bypass Windows
security warnings.

Checksums establish byte integrity only; they do not establish publisher
identity.

The unsigned installer operates in a distinct integrity-only mode: it validates
its closed-world payload manifest, records exact file hashes and install
identity in the ledger, and only runs a hash-matched removal helper. Builds with
an embedded release publisher retain the stricter Authenticode path.

## Update status

Automatic update application remains unavailable. Users download v1.8.16 from
the canonical GitHub Releases page.
