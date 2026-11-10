# SUNDAY Launcher v1.8.19

Windows release candidate with matching installer and portable payloads.

- Multi-instance mode and automatic discovery are enabled by default. Saved
  choices made after the one-time defaults migration remain respected.
- Automatic discovery selects the newest verified compatible classic Roblox
  Player, including installations beneath Windows usernames with spaces.
- Upgrades retain custom installation paths as verified discovery candidates
  without forcing selection of an older player.
- Successful accounts clear from the launch selection after partial launches;
  repeated retries include only the remaining unsuccessful participants.
- Process ownership remains bound to the original creation identity, canonical
  executable path, and file identity through startup and application restart.
- Missing executables produce a handled launch failure.
- Closing SUNDAY during startup waits for exact launch compensation before
  closing its state database. Clients from completed launches remain alive.
- Runtime packaging uses an explicit module allowlist. Private recovery
  approvals, account data, sessions, and logs are excluded from public assets.

The public asset set is `SundayInstaller.exe`,
`SundayPortable_1.8.19_x64.zip`, and `SHA256SUMS.txt`.

These Windows binaries are intentionally unsigned. Checksums verify file
integrity; they do not establish publisher identity. Automatic update
installation remains unavailable.

The exact packaged executable qualified with SHA-256
`533aa655a819e1df403be5957a12b7e06f3ae08448d0136ed9a1234741d8607a`.
The controlled Windows test launched two accounts into responsive managed
clone clients, verified selection clearing through active-client and account
refreshes, restarted SUNDAY with both clients alive, restored exact ownership,
stopped both by their capabilities, and verified final zero-process and
zero-active-ownership state. Protected session fingerprints were unchanged,
and newly appended logs contained no detected credential or raw capability
markers.

Live qualification is limited to two clients on this machine with classic
Roblox Player 0.746.0.7461267. Synthetic coverage exercises six-client capacity;
six real clients and the Microsoft Store client were not live-qualified.
Roblox and Windows updates can change legacy compatibility behavior.
