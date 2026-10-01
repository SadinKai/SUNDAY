# Migration

SUNDAY Launcher is the canonical identity:

- product: `SUNDAY Launcher`;
- executable: `Sunday.exe`;
- application identifier: `com.sadinkai.sundaylauncher`;
- installer: `SundayInstaller.exe`;
- standalone uninstaller: `SundayUninstall.exe`.

The repository retains narrow migration support for the former product identity.
Those identifiers are isolated in:

- `src/main/legacy-identity-compat.js` for durable backend state and signed
  release metadata;
- `src/renderer/legacy-identity-compat.js` for browser storage;
- `installer/src/legacy_identity.rs` for installer registration and ownership
  records;
- focused regression tests.

Migration is copy/validate/adopt behavior, not a current alias. Existing SUNDAY
state is never overwritten. SQLite sidecars or evidence of an active source
database stop migration rather than risk an inconsistent copy. Browser settings
are moved only when the canonical key is absent, and retired transient values
are removed.

Installer compatibility validates the prior signed identity and ownership
ledger before transferring supported records. It does not authorize broad
directory deletion.

Do not spread former-name constants into current source, UI, documentation,
artifact names, or configuration. A source-policy test enforces the migration
islands.
