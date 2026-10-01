# Privacy

This document describes the current public SUNDAY Launcher implementation. It
does not promise that no data leaves your PC: SUNDAY must communicate with
Roblox when you sign in, browse Roblox data, refresh accounts, or launch a
client.

## What does SUNDAY store?

SUNDAY stores application state in its Windows application-data directory,
normally `%APPDATA%\com.sadinkai.sundaylauncher`. Development builds can use a
different directory through the documented `SUNDAY_USER_DATA` override.

Local state can include:

- account identifiers, usernames, display names, avatars, public profile and
  presence metadata;
- a Roblox session cookie for each saved account, encrypted with Windows DPAPI
  for the current Windows user;
- settings, launch history, launch plans, slot leases, update state, and other
  ownership records in `sunday-state.sqlite3`;
- renderer preferences such as theme, last view, saved launch setups,
  favorites, recent games, and watched people in the WebView's local storage;
- local diagnostic logs under the application-data `logs` directory; and
- legacy instance directories when multi-instance mode prepares client slots.

SUNDAY refuses to save a Roblox session in plaintext when Windows DPAPI is not
available. Older supported account data is migrated to DPAPI-protected storage
before it can be used.

## How sign-in works

**Add account** opens a temporary WebView profile restricted to
`https://www.roblox.com`. Before navigation, SUNDAY deletes any stale
`.ROBLOSECURITY` cookie in that profile. After Roblox sets a new session cookie,
the trusted Tauri shell passes it to the local backend for DPAPI encryption,
purges it from the WebView, closes the window, and removes the temporary profile
on a best-effort basis. Leftover temporary WebView profiles are also removed at
the next startup.

The raw cookie is not returned to ordinary renderer UI state and is never
rendered on screen. It is briefly present inside the trusted local shell and
backend while SUNDAY validates the account and encrypts or uses the session.

## What leaves my PC?

When you use Roblox features, SUNDAY sends the information required for that
operation to Roblox-controlled HTTPS services. Depending on the action, this
can include account/session authentication, Roblox user or place identifiers,
presence requests, game and server searches, and a request for a single-use
Roblox authentication ticket. Avatar and game artwork is retrieved from Roblox
CDN hosts.

The current code allows bounded HTTPS communication with Roblox domains and
Roblox CDN domains. SUNDAY can also open allowlisted Roblox or GitHub pages in
your browser when you explicitly choose those actions. The automatic updater is
not active in the v1.8.15 build; updates are downloaded manually from
GitHub Releases.

SUNDAY does not send a Roblox authentication cookie to an analytics provider,
telemetry service, crash-reporting service, or SUNDAY-operated backend. The
current public implementation contains no telemetry, remote analytics, or
remote crash reporting.

## Does account information go to third parties?

Outside the Roblox requests needed for the feature you chose, the current
implementation does not upload the saved account database or Roblox session
cookie to a third-party service. GitHub receives ordinary web requests only
when you open a repository or release link, or if a future build is explicitly
configured with a qualified update feed. That future update infrastructure is
not active in v1.8.15.

## Logs and support

SUNDAY logs operational events locally. Logs can contain timestamps, error
messages, local paths, runtime versions, and non-secret diagnostic metadata.
They are not intended to contain raw cookies or passwords, but you should still
review and redact logs before sharing them.

Never share:

- `.ROBLOSECURITY` cookies, passwords, authentication tickets, or tokens;
- `sunday-state.sqlite3`, account exports, or migrated account files;
- private keys, signing material, or populated environment files;
- unredacted screenshots showing account identities; or
- logs containing personal paths or identifying workstation details.

For private security reports, follow [SECURITY.md](SECURITY.md). For normal
usage help, follow [SUPPORT.md](SUPPORT.md).
