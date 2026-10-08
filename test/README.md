# SUNDAY Launcher test boundaries

`npm test` is the host-safe default. It uses temporary directories and mocks;
it does not enumerate, launch, signal, focus, or modify Roblox processes and it
does not read or write the user's SUNDAY Launcher or Roblox configuration.

Obsolete handle-surgery, ad-hoc process probes, and superseded monolithic test
harnesses are not part of this repository. `smoke.js` is a non-launching
packaged UI check guarded by `SUNDAY_PACKAGED_UI_SMOKE=1`; start the candidate
with a fresh `SUNDAY_USER_DATA` directory and a dedicated remote-debugging port.
It does not click Join or launch Roblox. `ui-features.js` is a broader optional
native UI driver and remains outside the v1.8.18 release gates. Neither script
turns a synthetic or source result into real Roblox qualification.
