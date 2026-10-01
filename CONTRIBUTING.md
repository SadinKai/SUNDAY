# Contributing to SUNDAY Launcher

Thank you for helping improve SUNDAY Launcher. Contributions should preserve
the project's fail-closed process, persistence, installer, network, signing,
and Roblox-execution boundaries.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before opening an issue

- Search existing issues and documentation.
- Use the bug or feature issue form where possible.
- Remove cookies, account records, tokens, local databases, personal paths, and
  identifying screenshots from all reports.
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## Development setup

Follow [docs/developer/development.md](docs/developer/development.md). The
minimum local verification is:

```powershell
npm ci
npm test
npm audit --omit=dev --audit-level=moderate
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo check --locked --manifest-path installer/Cargo.toml
```

## Branches and commits

Use a short descriptive branch name such as `fix/slot-release` or
`docs/build-prerequisites`. Keep commits focused and write an imperative summary
that explains the observable change. Do not mix generated artifacts or unrelated
formatting churn into a functional change.

## Coding conventions

- Match the surrounding JavaScript, Rust, PowerShell, HTML, and CSS style.
- Preserve public APIs and architecture unless the change requires otherwise.
- Keep risky operations capability-bound and fail closed.
- Prefer behavioral tests over source-string assertions.
- Do not weaken signing, ownership, path, archive, or network validation to make
  a test pass.
- Do not add broad process cleanup or adopt processes SUNDAY did not launch.

## Tests required

Run the relevant commands from
[docs/developer/testing.md](docs/developer/testing.md). A normal pull request
should include:

```powershell
npm test
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo fmt --manifest-path installer/Cargo.toml --all -- --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo clippy --locked --manifest-path installer/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-features
cargo test --locked --manifest-path installer/Cargo.toml
git diff --check
```

Add a regression test for a bug fix. State which evidence tier was reached;
source checks do not imply packaged-artifact or live-Roblox qualification.

## Pull requests

Explain what changed, why it is necessary, tests run, security impact, and any
documentation changes. Keep pull requests reviewable. UI changes may include
redacted screenshots, but screenshots must never expose accounts or sessions.

Security-sensitive changes to process control, sessions, IPC, networking,
updates, release signing, installer extraction, migration, or legacy isolation
require focused tests and an explicit trust-boundary explanation.

## Documentation

Update user-facing commands and links when behavior changes. Keep deep technical
material in `docs/`; do not add forensic reports or local investigation logs.

## Never commit

- credentials, cookies, tokens, keys, certificates, or populated `.env` files;
- account databases, runtime state, logs, dumps, or personal information;
- generated binaries, archives, installers, `node_modules`, or Cargo targets;
- private screenshots, local paths, or live-test evidence.
