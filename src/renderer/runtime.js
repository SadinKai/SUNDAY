'use strict';

/* ----------------------------- Data + live updates ----------------------------- */
function updateRailFoot() {
  const el = $('#rail-foot');
  if (!el) return;
  const version = (state.status && state.status.appVersion) || '';
  const updateReady = state.updater && (state.updater.state === 'ready' || state.updater.state === 'available');
  el.title = updateReady ? `SUNDAY Launcher ${version} - update available` : `SUNDAY Launcher ${version}`;
  el.innerHTML = `${updateReady ? '<span class="dot-live"></span>' : ''}<span>SUNDAY ${esc(version)}</span>`;
}
async function refreshStatus() {
  const [r, diagnostic] = await Promise.all([
    call(() => api.status(), null),
    call(() => api.adapterSelection(), null),
  ]);
  if (r && r.ok) {
    if (diagnostic && diagnostic.ok && diagnostic.adapterSelection) {
      r.adapterSelection = diagnostic.adapterSelection;
    }
    state.status = r;
    state.settings = r.settings;
  }
  updateRailFoot();
}
async function loadInstances() {
  const r = await call(() => api.instances.get(), { instances: [] });
  if (r && r.instances) { state.instances = r.instances; if (state.view === 'instances') renderInstanceList(); updateNavCount(); }
}
async function loadAccounts() {
  const r = await call(() => api.accounts.list(), { accounts: [] });
  state.accounts = (r && r.accounts) || [];
  // prune selections that no longer exist
  for (const id of Array.from(state.selected)) if (!state.accounts.find(a => a.id === id)) state.selected.delete(id);
  updateAccountsCount();
}
function updateNavCount() { const el = $('#nav-count'); if (el) el.textContent = (state.instances || []).length; }
function updateAccountsCount() { const el = $('#nav-accounts'); if (el) el.textContent = (state.accounts || []).length; }
async function loadWatchdog() {
  const r = await call(() => api.keeper.status(), null);
  if (r && Array.isArray(r.records)) applyWatchdogStatus(r);
}
async function loadLaunchPlans() {
  const r = await call(() => api.launch.plans(), { plans: [] });
  state.launchPlans = (r && Array.isArray(r.plans)) ? r.plans.slice(0, 10) : [];
}

if (api) {
  let instanceRenderFrame = 0;
  api.onInstances((payload) => {
    if (payload && payload.instances) {
      state.instances = payload.instances;
      if (payload.summary) state.summary = payload.summary;
      updateNavCount();
      if (state.view === 'instances' && !instanceRenderFrame) {
        instanceRenderFrame = requestAnimationFrame(() => {
          instanceRenderFrame = 0;
          if (state.view === 'instances') renderInstanceList();
        });
      }
    }
  });
  api.onLog((entry) => {
    state.logs.push(entry);
    if (state.logs.length > 600) state.logs.shift();
    if (state.view === 'diagnostics' && (state.logFilter === 'all' || state.logFilter === entry.level)) renderLogs();
  });
  // Real-time presence/game: patch only the changed account card.
  api.onAccountUpdate((acc) => applyAccountUpdate(acc));
  // Session expired: keep the card and wait for an explicit Sign in again click.
  // Background polling must never open a login window or Roblox client.
  api.onAccountExpired((acc) => {
    applyAccountUpdate(acc);
    toast('Session expired for ' + (acc.username || 'an account') + ' - click Sign in again', 'bad');
  });
  // Re-authenticated (or new account added in background): reload the list.
  api.onAccountAdded(async () => { await loadAccounts(); if (state.view === 'accounts') views.accounts(); });
  // Watchdog (auto-rejoin): live per-account state + toasts when it acts.
  api.onKeeperStatus((status) => applyWatchdogStatus(status));
  api.onKeeperRejoin((r) => {
    toast(`Watchdog: ${(r && r.username) || 'an account'} dropped (${(r && r.reason) || 'closed'}) - rejoining in ${Math.max(1, Math.round(((r && r.delayMs) || 0) / 1000))}s`);
  });
  api.onKeeperGaveup((r) => {
    toast(`Watchdog gave up on ${(r && r.username) || 'an account'} after ${((r && r.attempts) || 0)} tries - arm it again by relaunching`, 'bad');
  });
  api.onLaunchPlan((plan) => rememberLaunchPlan(plan));
  api.onUpdaterStatus((status) => {
    const prev = state.updater && state.updater.state;
    state.updater = status;
    updateRailFoot();
    // Progress ticks patch the one status line in place; re-rendering the
    // whole page every 300 ms would drop any settings the user is editing.
    if (status && status.state === 'downloading') {
      const line = document.getElementById('update-status-line');
      if (line && line.dataset.upstate === 'downloading') {
        line.textContent = updaterStatusText(status, (state.status && state.status.appVersion) || '');
        return;
      }
    }
    if (state.view === 'settings') views.settings();
    if (status && status.state === 'restarting') {
      // The new files are already on disk (the swap happens while SUNDAY Launcher runs);
      // restart into them. updater_restart will spawn Sunday.exe with
      // --takeover=<pid> and closes this window itself once it is running —
      // a failed restart keeps the app open and says so instead of
      // vanishing with the update half-delivered.
      toast('Update installed — restarting SUNDAY Launcher', 'good');
      setTimeout(() => {
        call(() => api.updater.restart())
          .then((r) => {
            if (r && r.relaunched) return; // the Rust side closes this window
            toast('SUNDAY Launcher was updated, but could not restart itself — open it from the Start menu', 'bad');
          })
          .catch(() => { toast('SUNDAY Launcher was updated, but could not restart itself — open it from the Start menu', 'bad'); });
      }, 900);
    }
    if (status && status.state === 'ready') toast(`SUNDAY Launcher ${status.availableVersion || 'update'} is ready`, 'good');
    if (status && status.state === 'error' && (prev === 'downloading' || prev === 'staging' || prev === 'applying' || prev === 'restarting' || prev === 'checking')) {
      toast('Update failed — see Settings for details', 'bad');
    }
  });
}
setInterval(refreshInstanceElapsedTimes, 5000);
setInterval(refreshVisiblePeoplePresence, 10000);

// Infinite scroll for the Games search results
(() => {
  const scroller = document.querySelector('.content');
  if (!scroller) return;
  scroller.addEventListener('scroll', () => {
    if (state.view !== 'games') return;
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 320) gamesLoadMore();
  }, { passive: true });
})();
