# SUNDAY Launcher v1.8.17

SUNDAY is a Roblox account manager and multi-instance launcher for Windows.

## What changed

- Multi-instance mode now starts enabled for a fresh profile. Existing explicit
  on or off choices are preserved, and changing the setting offers a restart
  prompt before the adapter changes.
- SUNDAY no longer inspects the clipboard at startup, on focus, or while you
  navigate. **Paste Roblox Link** performs one bounded native clipboard read
  only after you click it, so the WebView clipboard-read permission popup is no
  longer required.
- Roblox installation discovery now combines verified manual selection,
  registered Roblox protocols, running-process evidence, bounded classic
  installation roots, and dynamic Microsoft Store / AppX package metadata.
- Settings can re-detect Roblox and choose among verified candidates without
  exposing raw installation paths in normal diagnostics.

## Roblox installation compatibility

Classic Win32 Roblox is the supported installation type for SUNDAY's existing
legacy multi-instance mechanism. The Microsoft Store **Roblox - Windows** app
can be detected through its registered package and application identity, but it
cannot be cloned by this compatibility path. SUNDAY does not change WindowsApps
permissions or copy protected package contents. Install Roblox from roblox.com
to use Multi-instance mode.

## Release qualification

The real-Windows release machine verified the current classic Roblox client,
the packaged one-client and three-client legacy flows, restart, sibling
preservation, slot reuse, teardown, clone cleanup, and the installer lifecycle.
Source and synthetic discovery fixtures cover classic roots, Store package
metadata, a non-default package volume, invalid registrations, stale paths, and
Studio exclusion.

Current Microsoft Store Roblox and a non-default PackageVolume were not
installed on the release machine. Those live scenarios remain explicitly
unqualified; SUNDAY does not infer them from fixtures, require a VM, bypass
WindowsApps ACLs, or modify protected package contents.

## Windows warning

The v1.8.17 Windows binaries are unsigned. Windows SmartScreen may show
a warning. Verify downloads against the SHA-256 checksum published with the
eventual release. A checksum confirms byte integrity; it is not a publisher
signature.

SUNDAY is independent and is not affiliated with or endorsed by Roblox
Corporation. Multi-instance behavior is an unsupported compatibility mechanism
and can change with Roblox or Windows updates.
