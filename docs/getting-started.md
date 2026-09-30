# Getting started

SUNDAY Launcher is a Windows-only Tauri application. The desktop shell starts a
local Node backend and renders the UI from `src/renderer`.

## Requirements

- Windows 10 or later, x64
- Node.js 22.23.x
- Rust 1.96.0 with the MSVC x64 target
- Visual Studio C++ Build Tools and a Windows SDK
- Microsoft WebView2 Runtime

Confirm the toolchain:

```powershell
node --version
npm --version
rustc --version
cargo --version
```

## Clone and verify

```powershell
git clone https://github.com/SadinKai/SUNDAY.git
cd SUNDAY
npm ci
npm test
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo check --locked --manifest-path installer/Cargo.toml
```

`npm ci` is required: it installs exactly the dependency graph represented by
`package-lock.json`. Do not substitute `npm install` in reproducible or release
workflows.

## Run in development

```powershell
npm run start
```

The safe default preserves launch planning but does not spawn Roblox. To inspect
the explicit legacy adapter in an authorized local environment:

```powershell
$env:LEGACY_COMPAT = '1'
npm run start
```

The UI must display **LEGACY MULTI-INSTANCE MODE**. Any other value leaves the
execution adapter unavailable.

## Build

```powershell
npm run build
npm run dist
npm run release:package
npm run audit:artifacts
```

`npm run build` creates the portable tree. `npm run dist` also creates the
installer and standalone uninstaller. `npm run release:package` creates the
portable archive and inventory consumed by the artifact audit. These are local
development artifacts unless the production signing workflow succeeds.

Next: [Development](development.md), [Testing](testing.md), and
[Configuration](configuration.md).
