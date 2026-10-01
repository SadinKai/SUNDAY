# Development

## Toolchain

Use Windows 10 or later with:

- Node.js 22.23.x (`.nvmrc` and `package.json`);
- Rust 1.96.0 (`rust-toolchain.toml`);
- `x86_64-pc-windows-msvc`, `rustfmt`, and `clippy`;
- Visual Studio C++ Build Tools and a Windows SDK;
- Microsoft WebView2 Runtime.

Do not remove or regenerate lockfiles casually. Dependency changes should update
the relevant manifest and lockfile in the same pull request.

## Install dependencies

```powershell
npm ci
```

Cargo resolves from the committed `src-tauri/Cargo.lock` and
`installer/Cargo.lock` when invoked with `--locked`.

## Development launch

```powershell
npm run start
```

The Tauri shell stages its Node runtime into an ignored resource path during the
build. The default adapter remains unavailable for Roblox execution. Current
source builds expose the opt-in multi-instance preference in Settings; changing
it requires a controlled application restart. The exact `LEGACY_COMPAT=1`
environment value remains a backward-compatible override.

Environment variables are process inputs, not a substitute for a populated
`.env` loader. Copy `.env.example` only for tooling that explicitly supports it;
the application does not silently ingest repository secrets.

## Checks

```powershell
npm test
npm audit --omit=dev --audit-level=moderate

cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-features

cargo fmt --manifest-path installer/Cargo.toml --all -- --check
cargo check --locked --manifest-path installer/Cargo.toml
cargo clippy --locked --manifest-path installer/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path installer/Cargo.toml
```

JavaScript has no separate formatter dependency. `npm test` includes source
policy checks, and CI runs `node --check` across source, test, and script files.

## Packaging

```powershell
npm run build
npm run dist
npm run release:package
npm run audit:artifacts
```

Generated output appears under `dist/`, the Cargo `target/` directories, and the
staged Tauri resource directory. All are ignored. Use `cargo clean` with each
manifest when reclaiming generated Rust output.

Release inputs and the current unsigned distribution model are described in
[Release engineering](release.md). Never use development placeholders as
release credentials.

## Runtime state

SUNDAY stores runtime data under the Windows application-data location for
`com.sadinkai.sundaylauncher`. Development overrides such as
`SUNDAY_USER_DATA` must point outside the repository. Never commit state,
SQLite files, account exports, logs, clone trees, or screenshots.

## Safe local testing

The default automated suite does not launch Roblox. Native UI drivers require
the explicit `SUNDAY_ISOLATED_VM=1` guard and an isolated, dedicated user-data
directory. Run them only on a controlled Windows environment where application
state can be discarded.

Live legacy drivers are a separate, explicit qualification tier. They require
the legacy adapter, authorized test accounts, and a controlled environment with
no valuable Roblox session or process state. They can launch Roblox and are
never part of a normal build or CI run.

See [Testing](testing.md) for the complete boundary.
