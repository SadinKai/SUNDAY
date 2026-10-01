# Security policy

## Supported versions

Security fixes target the default branch and the latest published release, when
one exists. Older release lines are not actively maintained. Reports against
unreleased source should identify the affected commit on `main`.

| Version | Support |
| --- | --- |
| Latest published release | Supported |
| Current `main` | Supported for coordinated fixes |
| Older releases and private development builds | Not actively supported |

## Report a vulnerability privately

Use GitHub's **Report a vulnerability** flow in the repository's Security tab.
Do not open a public issue for a suspected vulnerability. If private reporting
is unavailable, use a private contact method intentionally published on the
repository owner's GitHub profile and wait for a secure channel before sharing
sensitive details.

Include:

- the affected version or commit;
- a concise impact statement and realistic attack assumptions;
- minimal reproduction steps using synthetic data;
- the affected component and operating-system version;
- suggested mitigation, if known.

Do not include Roblox cookies, account data, passwords, tokens, signing keys,
private certificates, local databases, or identifying workstation output.
Redact logs and screenshots before attaching them.

## Maintainer process

Maintainers will privately acknowledge and triage the report, determine affected
versions, reproduce it when safe, prepare and test a correction, and coordinate
disclosure. Response or release timing is not guaranteed. Public disclosure
should wait until affected users have a reasonable opportunity to update.

## Scope and important boundaries

- Roblox execution is unavailable by default.
- The saved multi-instance setting or exact `LEGACY_COMPAT=1` override enables
  the same bounded compatibility path; it is not vendor-supported isolation.
- Process control requires current ownership and identity evidence.
- Public v1.8.14 binaries are intentionally unsigned. Checksums establish byte
  integrity, not publisher identity; signing inputs remain fail-closed when a
  build explicitly requires them.
- The in-application updater remains unavailable until its complete trust chain
  is qualified.

Security reports are welcome for the desktop shell, backend, renderer IPC,
persistence, credentials, process capabilities, networking, installer,
migration, and release verification. Do not test against accounts, systems, or
processes you do not own or have explicit authorization to use.

## Public disclosure

After a coordinated fix, a concise advisory may describe impact, affected
versions, remediation, and credit. It will not publish credentials, private user
data, signing material, or unnecessary exploit detail.
