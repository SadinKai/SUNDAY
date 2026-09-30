# SUNDAY Launcher test boundaries

`npm test` is the host-safe default. It uses temporary directories and mocks;
it does not enumerate, launch, signal, focus, or modify Roblox processes and it
does not read or write the user's SUNDAY Launcher or Roblox configuration.

Obsolete handle-surgery, ad-hoc process probes, and superseded monolithic test
harnesses are not part of this repository. The supported UI drivers are
`smoke.js` and `ui-features.js`; both refuse to run unless
`SUNDAY_ISOLATED_VM=1` is set. That flag is a declaration, not proof: use it only
inside a disposable VM with no valuable user profile, Roblox session, or
production credentials. They remain outside the default CI gate because they
exercise an actual packaged Windows process.
