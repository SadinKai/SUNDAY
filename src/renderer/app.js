'use strict';

/* ----------------------------- Boot ----------------------------- */
(async function boot() {
  if (!api) {
    content.innerHTML = `<div class="view"><div class="banner bad"><svg class="b-ico"><use href="#i-alert-circle"/></svg>
      <div class="b-text"><b>SUNDAY Launcher bridge unavailable</b><span>Open this through the SUNDAY Launcher application, not a browser.</span></div></div></div>`;
    return;
  }
  // Independent boot calls run together and each has a timeout, so one broken
  // subsystem can no longer leave users staring at the splash forever.
  await Promise.all([refreshStatus(), loadInstances(), loadAccounts(), loadWatchdog(), loadLaunchPlans()]);
  // The last self-update leaves a one-shot result: tell the user it worked
  // (or why it didn't) instead of the update failing silently after close.
  const lastUpdate = state.status && state.status.lastUpdateResult;
  if (lastUpdate) {
    if (lastUpdate.ok) toast(`SUNDAY Launcher updated to v${lastUpdate.to || 'the latest version'}`, 'good');
    else toast(`Update failed: ${lastUpdate.error || 'unknown error'} - try again from Settings`, 'bad');
  }
  state.launchMode = state.accounts.length ? 'account' : 'plain';
  // Reopen the section the user last visited (validated against the nav).
  let startView = 'instances';
  try {
    const saved = localStorage.getItem('sunday-last-view');
    if (saved && document.querySelector(`.nav button[data-view="${saved}"]`)) startView = saved;
  } catch (_) { /* fresh profile */ }
  setView(startView);
})();
