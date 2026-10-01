# Release engineering

SUNDAY v1.8.15 uses a straightforward unsigned GitHub release. A successful
source build is not public until the exact audited files are uploaded and their
published checksums are verified.

## Canonical version and public files

Version `1.8.15` is declared in `package.json`, both Cargo manifests, and
`src-tauri/tauri.conf.json`. The public release contains only:

- `SundayInstaller.exe`;
- `SundayPortable_1.8.15_x64.zip`; and
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

## Unsigned initial binaries

The v1.8.15 Windows binaries are intentionally unsigned. Windows
SmartScreen may display a warning when the installer or application starts.
Do not claim publisher identity, fabricate signatures, or bypass Windows
security warnings.

Checksums establish byte integrity only; they do not establish publisher
identity.

## Update status

Automatic update application remains unavailable. Users download v1.8.15 from
the canonical GitHub Releases page.
