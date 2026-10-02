'use strict';

/* ----------------------------- Instances view ----------------------------- */

/* ----------------------------- Favorites & Recents ----------------------------- */
/* Starred games and the last games joined, persisted locally so they survive
   restarts and searches. Stored as full game objects (name/thumbnail/votes)
   so the grid renders them even when they're not in the current browse list. */
const FAV_KEY = 'sunday-fav-games';
const RECENT_KEY = 'sunday-recent-games';
function loadGameStore(key) {
  try { const l = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(l) ? l : []; }
  catch (_) { return []; }
}
function favGames() { return loadGameStore(FAV_KEY); }
function recentGames() { return loadGameStore(RECENT_KEY); }
function isFav(gm) { return favGames().some(g => String(g.placeId) === String(gm.placeId)); }
function toggleFav(gm) {
  const list = favGames();
  const idx = list.findIndex(g => String(g.placeId) === String(gm.placeId));
  if (idx >= 0) list.splice(idx, 1); else list.unshift(gm);
  localStorage.setItem(FAV_KEY, JSON.stringify(list.slice(0, 60)));
  return idx < 0;
}
function recordRecentGame(gm) {
  if (!gm || !gm.placeId) return;
  const list = recentGames().filter(g => String(g.placeId) !== String(gm.placeId));
  list.unshift(Object.assign({}, gm, { joinedAt: Date.now() }));
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 12)));
}
function gameByPlaceId(placeId) {
  return state.games.list.find(g => String(g.placeId) === String(placeId))
    || favGames().find(g => String(g.placeId) === String(placeId))
    || recentGames().find(g => String(g.placeId) === String(placeId))
    || null;
}

/* ----------------------------- Activity watcher ----------------------------- */
/* Watch up to 20 people across views; a background poll (works while the
   window is hidden) toasts the moment one of them joins a game or switches
   games. The People home shows a live card with one-click Join. Persisted
   locally; Roblox is only polled, never written to. */
const WATCH_KEY = 'sunday-watch-v1';
const WATCH_MAX = 20;
const WATCH_POLL_MS = 60000;
state.watch = { list: [] };        // [{ id, name }]
const watchSnap = {};              // id -> { p, gn, pl, gid } last known presence
let watchBusy = false;
function watchLoad() {
  try {
    const raw = JSON.parse(localStorage.getItem(WATCH_KEY) || 'null');
    if (raw && Array.isArray(raw)) {
      state.watch.list = raw
        .filter(w => w && (w.id || w.id === 0) && typeof w.name === 'string')
        .map(w => ({ id: w.id, name: w.name })).slice(0, WATCH_MAX);
    }
  } catch (_) { /* start fresh */ }
}
function watchSave() {
  try { localStorage.setItem(WATCH_KEY, JSON.stringify(state.watch.list)); } catch (_) { /* best-effort */ }
}
watchLoad();
function isWatched(userId) { return state.watch.list.some(w => String(w.id) === String(userId)); }
function toggleWatch(userId, name) {
  const label = (name || 'User').trim() || 'User';
  const idx = state.watch.list.findIndex(w => String(w.id) === String(userId));
  let watching;
  if (idx >= 0) { state.watch.list.splice(idx, 1); delete watchSnap[String(userId)]; watching = false; }
  else {
    if (state.watch.list.length >= WATCH_MAX) { toast(`The watch list is full (${WATCH_MAX})`, 'bad'); return null; }
    state.watch.list.push({ id: userId, name: label });
    watchSnap[String(userId)] = { p: 'Unknown', gn: '', pl: '', gid: '' };
    watching = true;
  }
  watchSave();
  renderWatchCard();
  if (watching) watchTick();
  return watching;
}
function watchSnapshot(p) {
  return {
    p: String(p && p.presence || 'Offline'),
    gn: String(p && p.game && p.game.name || ''),
    pl: String(p && p.game && p.game.placeId || ''),
    gid: String(p && p.game && p.game.gameId || ''),
  };
}
function watchJoinedGame(prev, next) {
  const wasIn = String(prev.p || '').toLowerCase().includes('game');
  const nowIn = String(next.p || '').toLowerCase().includes('game');
  if (!nowIn) return false;
  return !wasIn || String(prev.pl || '') !== String(next.pl || '');
}
async function watchTick() {
  if (!api || watchBusy || !state.watch.list.length) return;
  watchBusy = true;
  const ids = state.watch.list.map(w => Number(w.id)).filter(n => Number.isFinite(n) && n > 0);
  const r = ids.length ? await call(() => api.people.presence(ids), null, 12000) : null;
  watchBusy = false;
  if (!r || !r.ok || !Array.isArray(r.people)) return;
  const byId = new Map(r.people.map(p => [String(p.userId), watchSnapshot(p)]));
  state.watch.list.forEach(w => {
    const snap = byId.get(String(w.id));
    if (!snap) return;                       // Roblox did not report this user this round
    const prev = watchSnap[String(w.id)];
    watchSnap[String(w.id)] = snap;
    if (prev && watchJoinedGame(prev, snap)) {
      toast(`${w.name} is playing ${snap.gn || 'a game'}`, 'good');
    }
  });
  renderWatchCard();
}
setInterval(watchTick, WATCH_POLL_MS);
if (api && state.watch.list.length) setTimeout(watchTick, 5000);

function renderWatchCard() {
  const el = $('#watch-card');
  if (!el) return;
  const list = state.watch.list;
  if (!list.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `
    <div class="row-split" style="margin-bottom:10px">
      <div style="font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px">${icon('eye')} Watching <span class="nav count" style="background:var(--surface-3);color:var(--ink-3)">${list.length}</span></div>
      <span class="hint">Alerts the moment they join a game</span>
    </div>
    <div class="watch-list">${list.map(w => {
      const s = watchSnap[String(w.id)] || {};
      const ingame = String(s.p || '').toLowerCase().includes('game');
      const presenceText = ingame ? 'In game' : (s.p || 'Unknown');
      return `<div class="watch-row">
        <span class="presence ${presenceClass(s.p || '')}"><span class="pd"></span></span>
        <button class="w-name" type="button" data-action="open-person" data-user="${esc(String(w.id))}" data-tip="Open profile">${esc(w.name)}</button>
        <span class="w-game">${ingame && s.gn ? esc(s.gn) : esc(presenceText)}</span>
        ${ingame && s.pl ? `<button class="btn sm primary" data-action="join-person" data-user="${esc(String(w.id))}" data-place="${esc(s.pl)}" data-game="${esc(s.gid)}" data-name="${esc(w.name)}">${icon('play')} Plan join</button>` : ''}
        <button class="btn sm icon" data-action="watch-toggle" data-user="${esc(String(w.id))}" data-name="${esc(w.name)}" data-tip="Stop watching">${icon('x')}</button>
      </div>`;
    }).join('')}</div>`;
}

/* ----------------------------- Clipboard quick-join ----------------------------- */
/* If a Roblox game link is sitting on the clipboard when Instances is opened
   or refocused, offer it - one click drops it into the launch box. Local only. */
let lastClipboardOffer = '';
async function checkClipboardForGameLink() {
  if (state.view !== 'instances' || !api.ui || !api.ui.clipboard) return;
  const r = await call(() => api.ui.clipboard(), { ok: false, text: '' });
  const text = (r && r.text || '').trim();
  if (!text || text === lastClipboardOffer) return;
  const target = parseRobloxTarget(text);
  if (!target.placeId) return;
  lastClipboardOffer = text;
  const box = $('#clip-offer');
  if (!box) return;
  box.hidden = false;
  box.innerHTML = `${icon('copy')} <span>Roblox link on your clipboard - place <b>${esc(target.placeId)}</b>${target.gameId ? ' (specific server)' : ''}</span>
    <button class="btn sm primary" data-action="clip-use" data-text="${esc(text)}">Use it</button>
    <button class="btn sm ghost" data-action="clip-dismiss">Dismiss</button>`;
}
window.addEventListener('focus', () => { setTimeout(checkClipboardForGameLink, 150); });

/* ----------------------------- Sessions ----------------------------- */
/* A session = a saved multi-launch setup (accounts + target + arrange).
   One click reproduces the whole thing. Stored locally, survives restarts. */
const SESSIONS_KEY = 'sunday-sessions';
function loadSessions() {
  try { return normalizeSessions(JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]')); }
  catch (_) { return []; }
}
function saveSessions(list) {
  try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(normalizeSessions(list))); return true; }
  catch (_) { return false; }
}

function sessionRows() {
  const sessions = loadSessions();
  if (!sessions.length) return '<div class="hint">No sessions yet — set up a launch above, then save it here.</div>';
  return sessions.map(s => {
    const known = s.accountIds.filter(id => state.accounts.some(a => a.id === id));
    const target = s.gameId ? 'specific server' : (s.placeId ? `place ${s.placeId}` : 'Roblox home');
    const missing = known.length < s.accountIds.length ? ` — ${s.accountIds.length - known.length} account(s) missing` : '';
    return `<div class="setting">
      <div><div class="s-label">${esc(s.name)}</div>
      <div class="s-desc">${known.length} account${known.length === 1 ? '' : 's'} · ${esc(target)}${s.arrange ? ' · auto-arrange' : ''}${s.keepAlive ? ' · watchdog' : ''}${esc(missing)}</div></div>
      <div class="s-control inline">
        <button class="btn sm primary" data-action="session-launch" data-id="${esc(s.id)}" ${known.length ? '' : 'disabled'}>${icon('play')} ${legacyCompatibilityMode() ? 'Launch' : 'Prepare'}</button>
        <button class="btn sm icon ghost" data-action="session-delete" data-id="${esc(s.id)}" data-tip="Delete this session">${icon('x')}</button>
      </div></div>`;
  }).join('');
}

function rememberLaunchPlan(plan) {
  if (!plan || !plan.planId) return;
  state.launchPlans = [plan].concat((state.launchPlans || []).filter(item => item.planId !== plan.planId)).slice(0, 10);
  if (state.view === 'instances') {
    const root = $('#launch-plans-list');
    if (root) root.innerHTML = launchPlanRows();
  }
}

function handlePreparedPlan(response) {
  if (response && response.plan) rememberLaunchPlan(response.plan);
  if (!(response && response.prepared) || response.failureCode) return false;
  const count = response.selectedCount || (response.plan && response.plan.operations && response.plan.operations.length) || 0;
  toast(legacyCompatibilityMode()
    ? `${count}-account launch plan prepared`
    : `${count}-account plan saved — execution is unavailable right now`);
  return true;
}

function presentLaunchFailure(response, retry) {
  const failedResult = response && Array.isArray(response.results)
    ? response.results.find(result => !result.ok)
    : null;
  const reason = String(response && response.error || failedResult && failedResult.reason || 'Roblox could not be launched.');
  const code = String(response && response.failureCode || failedResult && failedResult.failureCode || 'LAUNCH_FAILED');
  const actions = Array.isArray(response && response.actions) ? response.actions.slice() : ['RETRY', 'VIEW_DIAGNOSTICS'];
  state.lastLaunchFailure = { reason, code, actions };
  retryLastLaunch = typeof retry === 'function' ? retry : null;
  toast(reason, 'bad');
  if (state.view !== 'instances') setView('instances');
  else views.instances();
}

function clearLaunchFailure() {
  state.lastLaunchFailure = null;
  retryLastLaunch = null;
}

function launchFailureBanner() {
  const failure = state.lastLaunchFailure;
  if (!failure) return '';
  const actions = new Set(failure.actions || []);
  return `<section class="settings-note launch-failure" role="alert">
    <div><b>Launch needs attention</b><div>${esc(failure.reason)}</div></div>
    <div class="inline">
      ${retryLastLaunch && actions.has('RETRY') ? `<button class="btn sm primary" data-action="retry-last-launch">${icon('refresh')} Retry</button>` : ''}
      ${actions.has('OPEN_ACCOUNTS') ? `<button class="btn sm" data-action="goto-accounts">${icon('users')} Accounts</button>` : ''}
      ${actions.has('OPEN_SETTINGS') ? `<button class="btn sm" data-action="goto-settings">${icon('settings')} Open Settings</button>` : ''}
      <button class="btn sm" data-action="goto-diagnostics">${icon('activity')} View Diagnostics</button>
    </div>
  </section>`;
}

function launchPlanRows() {
  const plans = state.launchPlans || [];
  if (!plans.length) return '<div class="hint">Prepared and active launch plans will appear here.</div>';
  return plans.slice(0, 5).map(plan => {
    const operations = Array.isArray(plan.operations) ? plan.operations : [];
    const status = operations.map(operation => `${operation.label || operation.accountId}: ${String(operation.state || '').toLowerCase()}`).join(' · ');
    const waiting = plan.state === 'BLOCKED' ? ' · needs attention' : '';
    const cancellable = ['PREPARED', 'RUNNING', 'CANCEL_REQUESTED'].includes(plan.state);
    return `<div class="setting">
      <div><div class="s-label">${esc(plan.name || 'Launch plan')} · ${esc(plan.state || '')}${esc(waiting)}</div>
      <div class="s-desc">${esc(status || 'No operations')}</div></div>
      ${cancellable ? `<button class="btn sm ghost" data-action="plan-cancel" data-id="${esc(plan.planId)}">Cancel</button>` : ''}
    </div>`;
  }).join('');
}

function instanceRuntimeStatus(s) {
  if (!s || !s.robloxFound) {
    return {
      tone: 'bad', icon: 'alert-circle', label: 'Roblox not found',
      detail: 'Choose the Roblox executable in Settings.', action: 'goto-settings', actionLabel: 'Open Settings',
    };
  }
  if (legacyCompatibilityMode()) {
    return {
      tone: 'good', icon: 'check-circle', label: 'LEGACY MULTI-INSTANCE MODE',
      detail: 'Ready for SUNDAY-managed clients', action: 'goto-diagnostics', actionLabel: 'Details',
    };
  }
  if (capabilityAvailable('robloxIsolation')) {
    return {
      tone: 'good', icon: 'check-circle', label: 'Roblox ready',
      detail: 'Ready for a SUNDAY launch', action: 'goto-diagnostics', actionLabel: 'Details',
    };
  }
  return {
    tone: 'quiet', icon: 'clock', label: 'Planning mode',
    detail: 'Launch plans can still be prepared.', action: 'goto-diagnostics', actionLabel: 'Details',
  };
}

function launchDestinationSummary(value) {
  const target = parseRobloxTarget(value);
  if (target.invalid) return { label: 'Check destination', detail: 'Use a Roblox game link or numeric Place ID.', invalid: true };
  if (!target.placeId) return { label: 'Roblox home', detail: 'Clients open at the home screen.', invalid: false };
  if (target.gameId) return { label: `Place ${target.placeId}`, detail: 'Exact server selected.', invalid: false };
  return { label: `Place ${target.placeId}`, detail: 'Game destination selected.', invalid: false };
}

function launchActionState(selectedCount, destination) {
  const robloxDetected = !!(state.status && state.status.robloxFound);
  const executionAvailable = robloxDetected
    && (legacyCompatibilityMode() || capabilityAvailable('robloxIsolation'));
  const hasSelection = selectedCount > 0;
  const destinationValid = !(destination && destination.invalid);
  const countAllowed = legacyCompatibilityMode() || selectedCount <= 1;

  let readiness = executionAvailable ? 'Ready to launch' : 'Launch unavailable';
  if (!hasSelection) readiness = 'Select at least one account';
  else if (!destinationValid) readiness = 'Check destination';
  else if (!countAllowed) readiness = 'Enable Multi-instance mode for multiple accounts';
  else if (!executionAvailable && !robloxDetected) readiness = 'Roblox not detected · locate Roblox to continue';

  return {
    executionAvailable,
    enabled: hasSelection && destinationValid && countAllowed,
    label: executionAvailable ? 'Launch' : (robloxDetected ? 'View Diagnostics' : 'Locate Roblox'),
    action: executionAvailable ? 'launch' : (robloxDetected ? 'goto-diagnostics' : 'goto-settings'),
    readiness,
  };
}

function updateLaunchReview() {
  const input = $('#lp-place');
  const summary = launchDestinationSummary(input ? input.value.trim() : state.placeId);
  const target = $('#launch-review-target');
  const detail = $('#launch-review-detail');
  if (target) {
    target.textContent = summary.label;
    target.classList.toggle('is-invalid', summary.invalid);
  }
  if (detail) detail.textContent = summary.detail;
}

function filterLaunchAccounts(value) {
  const query = String(value || '').trim().toLowerCase();
  document.querySelectorAll('.launch-account-row').forEach(row => {
    row.hidden = !!query && !String(row.dataset.search || '').includes(query);
  });
  const empty = $('#launch-account-filter-empty');
  if (empty) empty.hidden = !query || !!document.querySelector('.launch-account-row:not([hidden])');
}

views.instances = function () {
  const s = state.status || {};
  const runtime = instanceRuntimeStatus(s);

  const hasAccounts = state.accounts.length > 0;
  const mode = hasAccounts ? state.launchMode : 'account';
  const selectedCount = state.selected.size;
  const savedSessions = loadSessions();

  const accountRows = state.accounts.map(a => {
    const selected = state.selected.has(a.id);
    const presence = String(a.presence || 'Offline');
    return `
      <button type="button" class="launch-account-row roster-account ${selected ? 'on' : ''}" data-action="toggle-account" data-id="${a.id}" data-search="${esc(`${a.displayName || ''} ${a.username || ''} ${presence}`.toLowerCase())}" aria-pressed="${selected}">
        <span class="launch-account-check" aria-hidden="true">${icon('check')}</span>
        ${a.avatar ? `<img src="${esc(a.avatar)}" alt="">` : `<span class="launch-account-avatar">${icon('users')}</span>`}
        <span class="launch-account-copy"><b>${esc(a.displayName || a.username)}</b><small>@${esc(a.username || 'account')}</small></span>
        <span class="launch-account-state"><span class="pd ${presenceClass(presence)}"></span>${esc(presence)}</span>
      </button>`;
  }).join('');

  const destination = launchDestinationSummary(state.placeId);
  const accountLaunch = launchActionState(selectedCount, destination);
  const quickLaunch = launchActionState(1, { invalid: false });
  const destinationPresets = savedSessions.map(session => {
    const value = session.gameId && session.placeId
      ? `https://www.roblox.com/games/${session.placeId}?gameInstanceId=${session.gameId}`
      : (session.placeId || '');
    const label = session.gameId ? `${session.name} · exact server` : `${session.name} · ${session.placeId ? `place ${session.placeId}` : 'Roblox home'}`;
    return `<option value="${esc(value)}">${esc(label)}</option>`;
  }).join('');

  const stageHeading = (number, title, description, id) => `
    <div class="launch-stage-heading">
      <span class="launch-stage-number" aria-hidden="true">${number}</span>
      <span><h2 id="${id}">${title}</h2><p>${description}</p></span>
    </div>`;

  const accountPanel = `
    <div id="lp-account" class="launch-mode-panel launch-stage-grid" style="${mode === 'account' ? '' : 'display:none'}">
      <section class="launch-stage launch-stage-roster" aria-labelledby="roster-heading">
        ${stageHeading(1, 'Account roster', 'Choose who plays', 'roster-heading')}
        <div class="launch-roster-toolbar">
          <label class="launch-account-search" for="launch-account-search">${icon('search')}<span class="sr-only">Search accounts</span><input id="launch-account-search" type="search" placeholder="Search accounts…" autocomplete="off"></label>
          <span class="launch-roster-count" id="launch-selection-count" aria-live="polite">${selectedCount} / ${legacyCompatibilityMode() ? 3 : 1}</span>
        </div>
        <div class="launch-roster-list">${hasAccounts ? accountRows : `
          <div class="launch-roster-empty"><span class="launch-account-avatar">${icon('users')}</span><div><b>No accounts yet</b><small>Add an account to build a launch roster.</small></div></div>`}
          <p class="launch-filter-empty" id="launch-account-filter-empty" hidden>No accounts match that search.</p>
        </div>
        <button class="launch-stage-link" type="button" data-action="goto-accounts">${icon(hasAccounts ? 'settings' : 'plus')} ${hasAccounts ? 'Manage accounts' : 'Add account'}</button>
      </section>

      <section class="launch-stage launch-stage-destination" aria-labelledby="destination-heading">
        ${stageHeading(2, 'Destination', 'Choose where they go', 'destination-heading')}
        <label class="launch-field-label" for="lp-place">Game link or Place ID</label>
        <div class="launch-destination-input">${icon('compass')}<input id="lp-place" type="text" placeholder="Roblox home, game link, or Place ID" value="${esc(state.placeId)}" aria-describedby="launch-review-detail" /></div>
        <div class="launch-destination-preview">
          <span class="destination-mark">${icon('box')}</span>
          <span><b id="launch-review-target" class="${destination.invalid ? 'is-invalid' : ''}">${esc(destination.label)}</b><small id="launch-review-detail">${esc(destination.detail)}</small></span>
        </div>
        ${savedSessions.length ? `<label class="launch-preset-label" for="lp-destination-preset">Saved destination</label><select id="lp-destination-preset"><option value="">Choose a saved destination…</option>${destinationPresets}</select>` : ''}
      </section>

      <section class="launch-stage launch-stage-action" aria-labelledby="launch-action-heading">
        ${stageHeading(3, 'Launch', 'Review and launch', 'launch-action-heading')}
        <div class="launch-action-review" aria-live="polite">
          <span><b id="launch-review-count">${selectedCount} client${selectedCount === 1 ? '' : 's'}</b><small id="launch-account-readiness">${esc(accountLaunch.readiness)}</small></span>
        </div>
        <button class="btn primary launch-primary-action" data-action="${accountLaunch.action === 'launch' ? 'launch-accounts' : accountLaunch.action}" aria-describedby="launch-account-readiness" ${accountLaunch.enabled ? '' : 'disabled'}>${icon(accountLaunch.action === 'goto-settings' ? 'settings' : (accountLaunch.action === 'goto-diagnostics' ? 'activity' : 'play'))} <span id="lp-count-label">${accountLaunch.label}</span></button>
        <p class="launch-action-context">${selectedCount || 'No'} client${selectedCount === 1 ? '' : 's'} · ${esc(destination.label)}</p>
      </section>
    </div>`;

  const plainPanel = `
    <div id="lp-plain" class="launch-mode-panel launch-stage-grid launch-signed-out" style="${mode === 'plain' ? '' : 'display:none'}">
      <section class="launch-stage">
        ${stageHeading(1, 'Client count', 'Choose how many open', 'plain-count-heading')}
        <div class="launch-plain-count"><div class="stepper" data-tip="How many clients to open">
          <button type="button" data-action="step" data-dir="-1" data-target="launch-count">-</button>
          <input id="launch-count" type="number" min="1" max="3" value="1" />
          <button type="button" data-action="step" data-dir="1" data-target="launch-count">+</button>
        </div><p>Signed-out clients do not use a saved account.</p></div>
      </section>
      <section class="launch-stage">
        ${stageHeading(2, 'Destination', 'Choose where they go', 'plain-destination-heading')}
        <div class="launch-destination-preview plain-home"><span class="destination-mark">${icon('compass')}</span><span><b>Roblox home</b><small>Signed-out launch destination</small></span></div>
      </section>
      <section class="launch-stage launch-stage-action">
        ${stageHeading(3, 'Launch', 'Review and launch', 'plain-launch-heading')}
        <div class="launch-action-review"><span><b>Signed-out clients</b><small id="launch-quick-readiness">${esc(quickLaunch.readiness)}</small></span></div>
        <button class="btn primary launch-primary-action" data-action="${quickLaunch.action === 'launch' ? 'launch-quick' : quickLaunch.action}" aria-describedby="launch-quick-readiness">${icon(quickLaunch.action === 'goto-settings' ? 'settings' : (quickLaunch.action === 'goto-diagnostics' ? 'activity' : 'play'))} ${quickLaunch.label}</button>
        <p class="launch-action-context">Roblox home</p>
      </section>
    </div>`;

  const modeToggle = hasAccounts ? `
    <div class="segmented" id="launch-mode">
      <button type="button" data-action="launch-mode" data-mode="account" class="${mode === 'account' ? 'on' : ''}" aria-pressed="${mode === 'account'}">With account</button>
      <button type="button" data-action="launch-mode" data-mode="plain" class="${mode === 'plain' ? 'on' : ''}" aria-pressed="${mode === 'plain'}">Signed out</button>
    </div>` : '';

  mount(`
    <div class="launch-command-page">
      <h1 id="view-heading" class="sr-only">Launch</h1>
      ${launchFailureBanner()}
      <section class="launch-workflow" aria-label="Launch workflow">
        ${accountPanel}
        ${plainPanel}
        <div class="launch-utility-bar">
          <div class="launch-mode-status runtime-${runtime.tone}" role="status">
            <svg class="b-ico"><use href="#i-${runtime.icon}"/></svg><span><b>${runtime.label}</b><small>${esc(runtime.detail)}</small></span>
            <button class="btn sm ghost" data-action="${runtime.action}">${runtime.actionLabel}</button>
          </div>
          <div class="launch-utility-actions">
            ${modeToggle}
            <div class="launch-account-options" id="launch-account-options" style="${mode === 'account' ? '' : 'display:none'}">
              <label class="launch-toggle" data-tip="If a client closes unexpectedly, the watchdog rejoins the same destination"><input type="checkbox" id="lp-keepalive"><span class="toggle-box">${icon('check')}</span><span><b>Keep client alive</b><small>Restart if the client closes</small></span></label>
              <button class="btn sm" data-action="session-save" ${hasAccounts && selectedCount ? '' : 'disabled'} data-tip="Save the current roster and destination as a one-click setup">${icon('bookmark')} Save setup</button>
            </div>
          </div>
        </div>
      </section>
      <div id="clip-offer" class="clip-offer" hidden></div>

      <section class="active-section" aria-labelledby="active-heading">
          <div class="active-heading">
            <div><h2 id="active-heading">Active clients</h2><p>Live clients launched or observed by SUNDAY.</p></div>
            <span id="watchdog-chip" class="keepalive-chip" hidden></span>
            <div class="inline active-actions">
              <button class="btn sm ghost" data-action="refresh-instances" data-tip="Refresh now">${icon('refresh')} Refresh</button>
              <button class="btn sm ghost" data-action="arrange" data-tip="Tile all Roblox windows into a grid">${icon('grid')} Arrange</button>
              <button class="btn sm ghost danger" disabled data-tip="Broad process termination is disabled">${icon('x')} End all</button>
              <button class="btn sm ghost" disabled data-tip="Broad process cleanup is disabled">${icon('broom')} Cleanup</button>
            </div>
          </div>
          <div class="active-instances">
            <div class="summary" id="summary" hidden></div>
            <div id="ilist" class="ilist"></div>
          </div>
      </section>

      <div class="secondary-stack">
          <details class="secondary-disclosure">
            <summary><span><b>History</b><small>Recent launch plans and operation state</small></span><span class="disclosure-count">${(state.launchPlans || []).length || 0}</span></summary>
            <div id="launch-plans-list">${launchPlanRows()}</div>
          </details>
          <details class="secondary-disclosure">
            <summary><span><b>Saved setups</b><small>Reusable rosters and destinations</small></span><span class="disclosure-count">${savedSessions.length}</span></summary>
            <div id="sessions-list">${sessionRows()}</div>
          </details>
      </div>
    </div>
  `);
  $('#main-content').setAttribute('aria-labelledby', 'view-heading');
  renderInstanceList();
  renderWatchdogChip();
  setTimeout(checkClipboardForGameLink, 200);
};

function renderInstanceList() {
  const list = $('#ilist');
  if (!list) return;
  const items = state.instances || [];
  renderInstanceSummary(items);
  patchInstanceList(list, items);
}

function renderInstanceSummary(items) {
  const el = $('#summary');
  if (!el) return;
  const sum = state.summary;
  if (sum && items.length) {
    // Longest-running client right now — "how long has SUNDAY been up".
    let longestStarted = 0;
    for (const item of items) {
      const started = Number(item.startedAt) || 0;
      if (started && (!longestStarted || started < longestStarted)) longestStarted = started;
    }
    const uptime = longestStarted ? fmtDur(Date.now() - longestStarted) : '0m';
    const key = [sum.total, sum.sunday, sum.external, sum.notResponding, sum.totalMemBytes, uptime].join('|');
    if (el.dataset.summaryKey !== key) el.innerHTML = `
      <span><b>${sum.total}</b> active</span>
      <span><b>${sum.sunday}</b> SUNDAY-managed</span>
      ${sum.external ? `<span><b>${sum.external}</b> external</span>` : ''}
      ${sum.notResponding ? `<span class="summary-attention"><b>${sum.notResponding}</b> need attention</span>` : ''}
      <span><b>${fmtBytes(sum.totalMemBytes)}</b> memory</span>
      <span><b>${uptime}</b> longest runtime</span>`;
    el.dataset.summaryKey = key;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

function instanceRowHtml(i, isNew) {
  const pid = Number(i.pid) || 0;
  const capability = i.controllable ? safeAttr(i.capability) : '';
  const watched = !!watchdogRecordForAccount(i.accountId);
  const sourceLabel = i.source === 'sunday' ? 'SUNDAY-managed' : 'External client';
  const watchLabel = watched ? ' · Keep alive' : '';
  const account = i.profileName || i.accountId || (i.source === 'sunday' ? 'SUNDAY client' : 'External client');
  const title = i.windowTitle ? esc(i.windowTitle) : '<span style="color:var(--ink-3)">Loading…</span>';
  const started = (i.startedExact ? '' : '~') + relTime(i.startedAt);
  const stateKey = i.status === 'not_responding' ? 'attention' : (i.status === 'starting' ? 'starting' : 'running');
  const stateLabel = stateKey === 'attention' ? 'Needs attention' : (stateKey === 'starting' ? 'Starting' : 'Running');
  const signature = encodeURIComponent(JSON.stringify([i.status, i.windowTitle, i.source, i.profileName, i.memBytes, i.startedAt, !!i.startedExact, watched, capability]));
  return `<div class="irow${isNew ? ' row-enter' : ''}" data-pid="${pid}" data-capability="${capability}" data-signature="${signature}" data-row>
    <span class="instance-account-cell"><span class="instance-avatar-dot ${esc(i.status || 'running')}" aria-hidden="true"></span><span><b>${esc(account)}</b><small>${esc(sourceLabel + watchLabel)}</small></span></span>
    <span class="instance-destination-cell"><b class="window-name">${title}</b><small>PID ${pid} · ${fmtBytes(i.memBytes)}</small></span>
    <span class="instance-state state-${stateKey}">${stateLabel}</span>
    <span class="when" data-tip="${i.startedExact ? 'Launched by SUNDAY Launcher' : 'First seen by SUNDAY Launcher'}">${started}</span>
    <span class="actions">
      <button class="btn sm" data-action="focus" data-capability="${capability}" data-tip="Bring this SUNDAY-launched window to front" ${capability ? '' : 'disabled'}>${icon('focus')} <span>Open</span></button>
      <button class="btn icon sm ghost" data-action="restart" data-capability="${capability}" data-tip="Restart this SUNDAY-launched client" aria-label="Restart ${esc(account)}" ${capability ? '' : 'disabled'}>${icon('rotate')}</button>
      <button class="btn sm danger" data-action="end" data-capability="${capability}" data-tip="End this SUNDAY-launched client" ${capability ? '' : 'disabled'}>${icon('x')} <span>Stop</span></button>
    </span>
  </div>`;
}

function patchInstanceList(list, items) {
  if (!items.length) {
    if (list.dataset.mode !== 'empty') {
      list.dataset.mode = 'empty';
      list.innerHTML = `<div class="empty"><div class="e-ico">${icon('box')}</div>
        <h3>No active clients</h3><p>Clients launched or observed by SUNDAY will appear here.</p><button class="btn sm" data-action="refresh-instances">${icon('refresh')} Refresh</button></div>`;
    }
    return;
  }

  if (list.dataset.mode !== 'rows') {
    list.dataset.mode = 'rows';
    list.innerHTML = `<div class="head"><span>Account</span><span>Destination</span><span>State</span><span class="when">Runtime</span><span>Actions</span></div><div data-instance-rows></div>`;
  }

  const rowsRoot = list.querySelector('[data-instance-rows]') || list;
  const existing = new Map(Array.from(rowsRoot.querySelectorAll('.irow[data-pid]')).map(row => [row.dataset.pid, row]));
  const live = new Set();

  for (const item of items) {
    const key = String(item.pid);
    live.add(key);
    const current = existing.get(key);
    if (current) {
      const signature = encodeURIComponent(JSON.stringify([item.status, item.windowTitle, item.source, item.profileName, item.memBytes, item.startedAt, !!item.startedExact, !!watchdogRecordForAccount(item.accountId), item.controllable ? item.capability : '']));
      if (current.dataset.signature !== signature) current.outerHTML = instanceRowHtml(item, false);
      else {
        const when = current.querySelector('.when');
        if (when) when.textContent = (item.startedExact ? '' : '~') + relTime(item.startedAt);
      }
    } else {
      rowsRoot.insertAdjacentHTML('beforeend', instanceRowHtml(item, true));
    }
  }

  for (const [key, row] of existing) {
    if (!live.has(key)) row.remove();
  }

  for (const item of items) {
    const row = findByData(rowsRoot, 'pid', item.pid);
    if (row) rowsRoot.appendChild(row);
  }
}

function refreshInstanceElapsedTimes() {
  if (state.view !== 'instances' || document.hidden) return;
  const root = $('#ilist');
  if (!root) return;
  // The "Longest up" stat rolls forward with the clock, not just with data.
  renderInstanceSummary(state.instances || []);
  for (const item of state.instances || []) {
    const row = findByData(root, 'pid', item.pid);
    const when = row && row.querySelector('.when');
    if (when) when.textContent = (item.startedExact ? '' : '~') + relTime(item.startedAt);
  }
}


function updateAccountsLaunchButton() {
  const root = document.querySelector('[data-account-launch-actions]');
  if (!root) return;
  const count = state.selected.size;
  const existing = root.querySelector('[data-account-launch-selected]');
  if (!count) { if (existing) existing.remove(); return; }
  const html = `${icon('play')} Launch ${count} selected`;
  if (existing) { existing.innerHTML = html; return; }
  root.insertAdjacentHTML('afterbegin', `<button class="btn sm" data-action="launch-selected" data-account-launch-selected>${html}</button>`);
}
function updateLaunchCount() {
  const destination = launchDestinationSummary($('#lp-place') ? $('#lp-place').value : state.placeId);
  const launchState = launchActionState(state.selected.size, destination);
  const lbl = $('#lp-count-label');
  if (lbl) lbl.textContent = launchState.label;
  const action = document.querySelector('[data-action="launch-accounts"]');
  if (action) action.disabled = !launchState.enabled;
  const count = state.selected.size;
  const rosterCount = $('#launch-selection-count');
  if (rosterCount) rosterCount.textContent = `${count} / ${legacyCompatibilityMode() ? 3 : 1}`;
  const reviewCount = $('#launch-review-count');
  if (reviewCount) reviewCount.textContent = `${count} client${count === 1 ? '' : 's'}`;
  const readiness = $('#launch-account-readiness');
  if (readiness) readiness.textContent = launchState.readiness;
  const context = document.querySelector('.launch-action-context');
  if (context) context.textContent = `${count || 'No'} client${count === 1 ? '' : 's'} · ${destination.label}`;
}
