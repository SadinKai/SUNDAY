'use strict';

/* SUNDAY Launcher renderer - pure UI. All OS/auth work happens in the main process and is
   reached only through the Tauri-backed `window.sunday` bridge. */

const api = window.sunday;
const { parseRobloxTarget, normalizeThemePreference, normalizeSessions } = window.SundayModel;
window.SundayLegacyIdentityCompat.migrateStorage(localStorage);

/* ----------------------------- Theme ----------------------------- */
const THEME_KEY = 'sunday-theme';
function themePref() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    // Eclipse is the product default. "System" remains an explicit choice,
    // rather than an implicit first-run decision that can make SUNDAY feel
    // different on two otherwise identical machines.
    return stored === null ? 'dark' : normalizeThemePreference(stored);
  } catch (_) { return 'dark'; }
}
function applyTheme() {
  const pref = themePref();
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
function setThemePref(pref) {
  try { localStorage.setItem(THEME_KEY, normalizeThemePreference(pref)); } catch (_) { /* use current theme */ }
  applyTheme();
}
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
if (systemTheme.addEventListener) systemTheme.addEventListener('change', () => { if (themePref() === 'system') applyTheme(); });
applyTheme();

function initWindowChrome() {
  const windowApi = api && api.ui && api.ui.window;
  const drag = document.getElementById('titlebar-drag');
  if (!windowApi || !drag) return;
  const syncMaximized = async () => {
    const maximized = await windowApi.isMaximized();
    document.body.classList.toggle('window-maximized', maximized);
    document.documentElement.classList.toggle('window-maximized', maximized);
    const button = document.querySelector('[data-window-action="maximize"]');
    if (button) {
      button.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
      button.title = maximized ? 'Restore' : 'Maximize';
    }
  };
  drag.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    if (event.detail === 2) windowApi.toggleMaximize().then(syncMaximized);
    else windowApi.startDragging();
  });
  document.querySelector('.window-controls').addEventListener('click', (event) => {
    const button = event.target.closest('[data-window-action]');
    if (!button) return;
    const action = button.dataset.windowAction;
    if (action === 'minimize') windowApi.minimize();
    else if (action === 'maximize') windowApi.toggleMaximize().then(syncMaximized);
    else if (action === 'close') windowApi.close();
  });
  windowApi.onResized(syncMaximized);
  syncMaximized();
}
initWindowChrome();

const state = {
  view: 'instances',
  status: null,
  updater: null,
  instances: [],
  summary: null,
  accounts: [],
  selected: new Set(),     // selected account ids (shared across views)
  launchPlans: [],         // persisted coordinator state; never contains credentials
  launchMode: 'account',   // 'account' | 'plain'
  placeId: '',
  history: [],
  diag: null,
  logs: [],
  logFilter: 'all',
  addingAccount: false,
  creatingAccount: false,
  createDraft: null,
  followTargetId: null,
  followSelected: new Set(),
  following: false,
  personJoin: null,
  sessionDraft: null,
  games: {
    list: [], query: '', nextPageToken: null, loading: false, error: null, loaded: false,
    sort: 'players', hideEmpty: false, categories: [], category: 'All', requestId: 0,
  },
  people: {
    tab: 'people',
    route: 'home', returnRoute: 'home',
    filter: 'all', sort: 'status', filterText: '',
    list: [], page: 0, pageSize: 12, total: 0, hasNext: false, hasPrev: false, loading: false, error: null, loaded: false, requestId: 0,
    search: {
      query: '', list: [], nextPageCursor: null, loading: false, error: null,
      searched: false, requestId: 0, notice: null, source: null, cached: false, retryable: false,
    },
    detail: { userId: null, profile: null, loading: false, error: null },
  },
  accountsRefreshedAt: 0,
};

const UPDATE_CHECK_KEY_STORAGE = 'sunday-update-check-idempotency-v1';
const FINAL_JOB_STATES = new Set(['CANCELLED', 'SUCCEEDED', 'FAILED']);
let updateCheckSessionKey = null;

function updateCheckIdempotencyKey() {
  if (updateCheckSessionKey) return updateCheckSessionKey;
  try {
    const stored = localStorage.getItem(UPDATE_CHECK_KEY_STORAGE);
    if (/^update-check:[0-9a-f-]{36}$/.test(String(stored || ''))) {
      updateCheckSessionKey = stored;
      return stored;
    }
  } catch (_) { /* use process-lifetime correlation */ }
  if (!window.crypto || typeof window.crypto.randomUUID !== 'function') {
    throw new Error('Secure operation ID generation is unavailable.');
  }
  updateCheckSessionKey = `update-check:${window.crypto.randomUUID()}`;
  try { localStorage.setItem(UPDATE_CHECK_KEY_STORAGE, updateCheckSessionKey); } catch (_) { /* best effort */ }
  return updateCheckSessionKey;
}

function clearUpdateCheckIdempotencyKey(expected) {
  if (updateCheckSessionKey !== expected) return;
  updateCheckSessionKey = null;
  try {
    if (localStorage.getItem(UPDATE_CHECK_KEY_STORAGE) === expected) {
      localStorage.removeItem(UPDATE_CHECK_KEY_STORAGE);
    }
  } catch (_) { /* best effort */ }
}

async function waitForUpdateJob(operationId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await call(() => api.jobs.get(operationId), null, 5000);
    if (!response || response.ok !== true || !response.job) return null;
    if (FINAL_JOB_STATES.has(response.job.state)) return response.job;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

function capability(name) {
  return state.status && state.status.capabilities && state.status.capabilities[name];
}
function capabilityAvailable(name) {
  const item = capability(name);
  return !!item && (item.state === 'QUALIFIED' || item.state === 'ACTIVE');
}

function legacyCompatibilityMode() {
  const selection = state.status && state.status.adapterSelection;
  return !!(selection
    && selection.legacyCompatEnabled === true
    && selection.selectedAdapter === 'LegacyRobloxIsolationAdapter'
    && selection.isolationState === 'LEGACY_COMPAT');
}

/* ----------------------------- DOM helpers ----------------------------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const content = $('#content');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function safeAttr(value) { return esc(value); }
function dataKeyToProp(attr) {
  return String(attr || '').replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}
function findAllByData(root, attr, value) {
  const scope = root || document;
  const prop = dataKeyToProp(attr);
  const expected = String(value == null ? '' : value);
  return Array.from(scope.querySelectorAll(`[data-${attr}]`)).filter(el => el.dataset[prop] === expected);
}
function findByData(root, attr, value) {
  return findAllByData(root, attr, value)[0] || null;
}
function icon(id) { return `<svg class="ico"><use href="#i-${id}"/></svg>`; }
function fmtBytes(b) {
  if (!b) return '0 MB';
  const mb = b / 1048576;
  return mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(mb < 10 ? 1 : 0) + ' MB';
}
function relTime(iso) {
  if (!iso) return '-';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '-';
  let s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60); s = s % 60;
  if (m < 60) return m + 'm ' + (s ? s + 's' : '');
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}
function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1).replace(/\.0$/, '') + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(n);
}

/* ----------------------------- Notifications ----------------------------- */
/* Toasts are ephemeral: shown, dismissible, auto-expiring. v1.5.9 briefly
   added a persistent notification center; removed in v1.5.11 - clear its
   stored history once so nothing lingers. */
function toast(message, type) {
  const wrap = $('#toasts');
  if (wrap) {
    // Keep at most four stacked toasts so a burst of events can't pile up.
    while (wrap.children.length >= 4) wrap.firstElementChild.remove();
    const t = document.createElement('div');
    t.className = 'toast ' + (type === 'bad' ? 'bad' : type === 'good' ? 'good' : '');
    // Notifications carry the SUNDAY logo mark; only errors swap in the alert
    // glyph so failures stay impossible to miss.
    const ic = type === 'bad' ? 'alert-circle' : 'sunday';
    t.innerHTML = `<svg class="t-ico${type === 'bad' ? '' : ' sunday-mark'}"><use href="#i-${ic}"/></svg><span>${esc(message)}</span>`
      + `<button class="toast-x" type="button" aria-label="Dismiss notification" data-tip="Dismiss"><svg class="tx-ico"><use href="#i-x"/></svg></button>`;
    const dismiss = () => {
      if (!t.isConnected) return;
      t.style.transition = 'opacity .25s, transform .25s';
      t.style.opacity = '0';
      t.style.transform = 'translateY(8px)';
      setTimeout(() => t.remove(), 260);
    };
    t.querySelector('.toast-x').addEventListener('click', dismiss);
    wrap.appendChild(t);
    setTimeout(dismiss, 3400);
  }
}

/* ----------------------------- Command palette ----------------------------- */
/* Ctrl+K summons a searchable launcher: rail sections, every account (toggle
   for launch), favorite/recent games (one-Enter join), and power actions.
   Fuzzy matching prefers substrings, then subsequences; digits 1-9 run the
   nth result while the palette is open. */
state.palette = { open: false, items: [], sel: 0, query: '' };

function fuzzyScore(query, text) {
  if (!query) return 1;
  const t = text.toLowerCase(), s = query.toLowerCase();
  const at = t.indexOf(s);
  if (at === 0) return 300;
  if (at > 0) return 200 - Math.min(at, 50);
  let i = 0;
  for (const ch of t) { if (ch === s[i]) i++; }
  return i >= s.length ? 100 - Math.min(t.length - s.length, 60) : -1;
}

async function paletteEndAll() {
  if (!state.instances.length) { toast('No clients running', 'bad'); return; }
  const ok = !needConfirm() || await confirmDialog({ title: 'End all Roblox clients?', body: 'This closes every running Roblox client.', confirmText: 'End all', danger: true });
  if (!ok) return;
  const r = await call(() => api.instances.killAll());
  toast(r && r.ok ? 'All clients ended' : 'Could not end clients', r && r.ok ? 'good' : 'bad');
}
async function paletteCleanup() {
  const ok = !needConfirm() || await confirmDialog({ title: 'Run cleanup?', body: 'Ends all Roblox clients and clears leftover crash-handler processes.', confirmText: 'Clean up', danger: true });
  if (!ok) return;
  const r = await call(() => api.instances.cleanup());
  toast(r && r.ok ? 'Cleanup complete' : 'Cleanup failed', r && r.ok ? 'good' : 'bad');
}
function paletteCycleTheme() {
  const order = ['system', 'light', 'dark'];
  const names = { system: 'follow system', light: 'Dawn', dark: 'Eclipse' };
  const next = order[(order.indexOf(themePref()) + 1) % order.length];
  setThemePref(next);
  if (state.view === 'settings') views.settings();
  toast('Theme: ' + names[next], 'good');
}

function paletteActions() {
  const acts = [
    { icon: 'refresh', label: 'Refresh accounts', hint: 'Reload list', run: async () => { await loadAccounts(); toast('Accounts refreshed', 'good'); } },
    { icon: 'refresh', label: 'Refresh active clients', hint: 'Reload list', run: async () => { await loadInstances(); toast('Refreshed', 'good'); } },
  ];
  acts.push(
    { icon: 'contrast', label: 'Toggle theme', hint: 'System / Dawn / Eclipse', run: paletteCycleTheme },
    { icon: 'copy', label: 'Copy diagnostics', hint: 'Clipboard', run: () => copyDiagnostics() },
    { icon: 'folder', label: 'Open data folder', hint: 'Local files', run: async () => { await call(() => api.openUserData()); } },
  );
  return acts;
}

function paletteItems(query) {
  const items = [];
  // 1) Rail sections (labels stay in sync with the nav).
  document.querySelectorAll('.nav button[data-view]').forEach(btn => {
    const label = (btn.querySelector('.label') || {}).textContent || btn.dataset.view;
    items.push({ icon: null, navIcon: btn.querySelector('svg.ico use').getAttribute('href').slice(3), label: 'Go to ' + label.trim(), hint: 'Section', run: () => { if (btn.dataset.view === 'people') state.people.route = 'home'; setView(btn.dataset.view); } });
  });
  // 2) Accounts: toggle launch selection (jumps to Accounts so the change is visible).
  state.accounts.forEach(acc => {
    const name = acc.displayName || acc.username || ('Account ' + acc.id);
    items.push({ icon: 'users-group', label: name, hint: 'Account — toggle selection', run: () => {
      if (state.selected.has(acc.id)) state.selected.delete(acc.id); else state.selected.add(acc.id);
      setView('accounts');
      updateLaunchCount();
    } });
  });
  // 3) Watched people: join straight in when they are in a game.
  state.watch.list.forEach(w => {
    const s = watchSnap[String(w.id)] || {};
    const ingame = String(s.p || '').toLowerCase().includes('game');
    if (ingame && s.pl) {
      items.push({ icon: 'eye', label: 'Plan join ' + w.name, hint: 'Watching' + (s.gn ? ' — ' + s.gn : ''), run: () => openPersonJoinDialog(w.id, s.pl, s.gid, w.name) });
    } else {
      items.push({ icon: 'eye', label: w.name, hint: 'Watching — ' + (s.p || 'checking'), run: () => openPerson(String(w.id)) });
    }
  });
  // 4) Favorite then recent games: Enter joins with the current selection.
  favGames().slice(0, 10).forEach(gm => {
    if (!gm || !gm.placeId) return;
    items.push({ icon: 'bookmark', label: 'Plan ' + (gm.name || 'game'), hint: 'Favorite', run: () => joinPlace(String(gm.placeId), gm.name) });
  });
  recentGames().slice(0, 12).forEach(gm => {
    if (!gm || !gm.placeId) return;
    items.push({ icon: 'clock', label: 'Plan ' + (gm.name || 'game'), hint: 'Recent', run: () => joinPlace(String(gm.placeId), gm.name) });
  });
  // 5) Power actions.
  paletteActions().forEach(a => items.push(a));
  if (!query) return items.slice(0, 16);
  return items
    .map(it => ({ it, score: Math.max(fuzzyScore(query, it.label), fuzzyScore(query, it.hint || '') * 0.6) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 14)
    .map(x => x.it);
}

function renderPalette() {
  const list = $('#palette-list');
  if (!list) return;
  const sel = state.palette.sel;
  if (!state.palette.items.length) {
    list.innerHTML = `<div class="p-empty">${icon('search')}<span>No matches</span></div>`;
    return;
  }
  list.innerHTML = state.palette.items.map((it, i) => `
    <button class="p-item${i === sel ? ' sel' : ''}${it.danger ? ' danger' : ''}" type="button" role="option" aria-selected="${i === sel}" data-idx="${i}">
      <svg class="ico"><use href="#i-${it.icon || it.navIcon}"/></svg>
      <span class="p-label">${esc(it.label)}</span>
      <span class="p-hint">${esc(it.hint || '')}</span>
      <span class="p-idx">${i < 9 ? i + 1 : ''}</span>
    </button>`).join('');
  const active = list.children[sel];
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}
function paletteSearch(query) {
  state.palette.query = query;
  state.palette.items = paletteItems(query.trim());
  state.palette.sel = 0;
  renderPalette();
}
function openPalette() {
  const back = $('#palette-back');
  if (!back) return;
  back.hidden = false;
  state.palette.open = true;
  const input = $('#palette-input');
  input.value = '';
  paletteSearch('');
  input.focus();
}
function closePalette() {
  const back = $('#palette-back');
  if (!back || back.hidden) return;
  back.hidden = true;
  state.palette.open = false;
}
function paletteRunIndex(idx) {
  const it = state.palette.items[idx];
  if (!it) return;
  closePalette();
  // Async on purpose: run() may await confirm dialogs without blocking the UI.
  Promise.resolve().then(() => it.run()).catch(() => toast('Command failed', 'bad'));
}

$('#palette-back').addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) closePalette(); });
$('#palette-input').addEventListener('input', (e) => paletteSearch(e.target.value));
$('#palette-input').addEventListener('keydown', (e) => {
  const n = state.palette.items.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!n) return;
    state.palette.sel = (state.palette.sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    renderPalette();
  } else if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    if (!n) return;
    state.palette.sel = e.key === 'Home' ? 0 : n - 1;
    renderPalette();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    paletteRunIndex(state.palette.sel);
  }
});
$('#palette-list').addEventListener('click', (e) => {
  const btn = e.target.closest('.p-item');
  if (btn) paletteRunIndex(parseInt(btn.dataset.idx, 10));
});
$('#palette-list').addEventListener('mousemove', (e) => {
  const btn = e.target.closest('.p-item');
  if (!btn) return;
  const idx = parseInt(btn.dataset.idx, 10);
  if (idx !== state.palette.sel) { state.palette.sel = idx; renderPalette(); }
});
/* Ctrl+K toggles the palette anywhere in the app. */
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    if (state.palette.open) closePalette(); else openPalette();
  }
});

/* ----------------------------- Modal ----------------------------- */
let modalReturnFocus = null;
function openModal(htmlStr, className) {
  const modal = $('#modal');
  if (!$('#modal-back').classList.contains('open')) modalReturnFocus = document.activeElement;
  modal.className = 'modal' + (className ? ' ' + className : '');
  modal.innerHTML = htmlStr;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  const title = modal.querySelector('h3');
  if (title) {
    title.id = 'modal-title';
    modal.setAttribute('aria-labelledby', title.id);
  } else {
    modal.removeAttribute('aria-labelledby');
  }
  $('#modal-back').classList.add('open');
  requestAnimationFrame(() => {
    const focusTarget = modal.querySelector('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (focusTarget) focusTarget.focus({ preventScroll: true });
  });
}
function closeModal() {
  if (state.servers && state.servers.refreshTimer) clearInterval(state.servers.refreshTimer);
  $('#modal-back').classList.remove('open');
  $('#modal').className = 'modal';
  $('#modal').innerHTML = '';
  if (modalReturnFocus && document.contains(modalReturnFocus) && typeof modalReturnFocus.focus === 'function') {
    modalReturnFocus.focus({ preventScroll: true });
  }
  modalReturnFocus = null;
}
let confirmResolver = null;
function confirmDialog({ title, body, confirmText, danger }) {
  return new Promise((resolve) => {
    openModal(`
      <div class="m-head"><h3>${esc(title)}</h3></div>
      <div class="m-body"><p style="margin:0;color:var(--ink-2)">${esc(body)}</p></div>
      <div class="m-foot">
        <button class="btn" data-action="confirm-no">Cancel</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-action="confirm-yes">${esc(confirmText || 'Confirm')}</button>
      </div>`);
    confirmResolver = resolve;
  });
}

function closeFollowDialog() {
  state.followTargetId = null;
  state.followSelected = new Set();
  state.following = false;
  closeModal();
}

function renderFollowDialog() {
  const target = state.accounts.find(a => a.id === state.followTargetId);
  if (!target) { closeFollowDialog(); return; }
  const followers = state.accounts.filter(a => a.id !== target.id);
  const chips = followers.map(a => `
    <button type="button" class="chip ${state.followSelected.has(a.id) ? 'on' : ''}" data-action="toggle-follow-account" data-id="${a.id}" aria-pressed="${state.followSelected.has(a.id)}" ${state.following ? 'disabled' : ''}>
      ${a.avatar ? `<img src="${esc(a.avatar)}" alt="">` : icon('users')}<span>${esc(a.displayName || a.username)}</span>
    </button>`).join('');
  const count = state.followSelected.size;
  openModal(`
    <div class="m-head"><h3>Follow ${esc(target.displayName || target.username)}</h3></div>
    <div class="m-body">
      <p style="margin:0 0 14px;color:var(--ink-2)">Choose the other accounts that should join this account's exact Roblox server.</p>
      <div class="chips">${chips || '<span class="hint">Add another account first.</span>'}</div>
      <p class="hint" style="margin:14px 0 0">SUNDAY Launcher checks the target's live server again when you click Follow.</p>
    </div>
    <div class="m-foot">
      <button class="btn" data-action="modal-cancel" ${state.following ? 'disabled' : ''}>Cancel</button>
      <button class="btn primary" data-action="follow-confirm" ${!count || state.following ? 'disabled' : ''}>
        ${state.following ? '<span class="spinner"></span> Preparing…' : `${icon('users-group')} Prepare follow with ${count || ''}`}
      </button>
    </div>`);
}

function openFollowDialog(targetId) {
  const followers = new Set(state.accounts.filter(a => a.id !== targetId).map(a => a.id));
  state.followTargetId = targetId;
  state.followSelected = new Set(Array.from(state.selected).filter(id => followers.has(id)));
  state.following = false;
  renderFollowDialog();
}

/* ----------------------------- Create account ----------------------------- */
// The creator drives Roblox's real signup form in a Tauri webview: SUNDAY Launcher
// fills every field, clicks through the steps and stops at the captcha,
// which only the user can solve — then the new session is imported the
// moment Roblox sets it. Validation mirrors Roblox's own rules so the
// button only enables on submittable input.

const CREATE_GENDERS = ['Male', 'Female', 'Skip'];
const CREATE_DEFAULTS_KEY = 'sunday-create-defaults-v1';
let createSessionDefaults = null;
let createCheckTimer = null;

function defaultCreateBirthday() {
  // ~18 years back, formatted for <input type="date">.
  const now = new Date();
  return (now.getFullYear() - 18) + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
}

// Keep birthday and profile-field choices only for this running app session.
// Persisting them in browser storage would retain sensitive profile data in
// clear text after SUNDAY exits.
function loadCreateDefaults() {
  try { localStorage.removeItem(CREATE_DEFAULTS_KEY); } catch (_) { /* best-effort legacy cleanup */ }
  return createSessionDefaults ? { ...createSessionDefaults } : null;
}

function saveCreateDefaults(d) {
  createSessionDefaults = {
    gender: CREATE_GENDERS.includes(d.gender) ? d.gender : 'Skip',
    birthday: /^\d{4}-\d{2}-\d{2}$/.test(String(d.birthday)) ? String(d.birthday) : null,
  };
}

// Unambiguous glyphs only — no 0/O, 1/I/l — so a generated password reads
// back by eye. Mirrors the rule-checked generator in main/signup.js.
const CREATE_PASS_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
const CREATE_PASS_DIGITS = '23456789';

function createRandomInt(n) {
  const c = window.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    const limit = Math.floor(0x100000000 / n) * n;   // rejection sampling keeps it even
    const buf = new Uint32Array(1);
    do { c.getRandomValues(buf); } while (buf[0] >= limit);
    return buf[0] % n;
  }
  return Math.floor(Math.random() * n);
}

function generateCreatePassword() {
  const pick = (set) => set[createRandomInt(set.length)];
  const chars = [pick(CREATE_PASS_LETTERS), pick(CREATE_PASS_LETTERS), pick(CREATE_PASS_DIGITS)];
  const pool = CREATE_PASS_LETTERS + CREATE_PASS_DIGITS;
  while (chars.length < 14) chars.push(pick(pool));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = createRandomInt(i + 1);
    const tmp = chars[i]; chars[i] = chars[j]; chars[j] = tmp;
  }
  return chars.join('');
}

function openCreateAccountModal() {
  clearTimeout(createCheckTimer);
  const defaults = loadCreateDefaults();
  state.createDraft = {
    username: '', password: '', confirm: '',
    birthday: (defaults && defaults.birthday) || defaultCreateBirthday(),
    gender: (defaults && defaults.gender) || 'Skip',
    check: null, checking: false, submitting: false, showPass: false,
    suggest: [], suggestFor: '', suggesting: false,
  };
  renderCreateAccountModal();
}

function renderCreateAccountModal() {
  const d = state.createDraft;
  if (!d) return;
  openModal(`
    <div class="m-head"><h3 id="create-modal-title">Create a Roblox account</h3>
      <p id="create-modal-sub">SUNDAY Launcher fills and advances Roblox's signup. Roblox will ask one quick human check in its window — that part is theirs, not SUNDAY Launcher's — then the new account lands here, already signed in.</p></div>
    <div class="m-body">
      <div class="field">
        <label for="create-username" id="create-username-label">Username</label>
        <input id="create-username" type="text" maxlength="20" autocomplete="off" spellcheck="false"
          placeholder="3-20 characters" value="${esc(d.username)}">
        <div class="field-status" id="create-username-status"></div>
        <div class="suggest-row" id="create-suggest" hidden></div>
        <p class="hint" id="create-username-hint">Checked against Roblox as you type.</p>
      </div>
      <div class="field">
        <label for="create-password">Password</label>
        <div class="pass-row">
          <input id="create-password" type="${d.showPass ? 'text' : 'password'}" maxlength="20"
            autocomplete="new-password" placeholder="8-20 characters" value="${esc(d.password)}">
          <button class="btn sm icon" data-action="create-gen-pass" data-tip="Generate a strong password"
            aria-label="Generate a strong password">${icon('dice')}</button>
          <button class="btn sm icon" data-action="create-toggle-pass" data-tip="${d.showPass ? 'Hide password' : 'Show password'}"
            aria-label="${d.showPass ? 'Hide password' : 'Show password'}">${icon('eye')}</button>
        </div>
        <div class="field-status" id="create-password-status"></div>
        <p class="hint">8-20 characters with a letter and a number.</p>
      </div>
      <div class="field">
        <label for="create-confirm">Confirm password</label>
        <input id="create-confirm" type="${d.showPass ? 'text' : 'password'}" maxlength="20"
          autocomplete="new-password" placeholder="Repeat the password" value="${esc(d.confirm)}">
        <div class="field-status" id="create-confirm-status"></div>
      </div>
      <div class="field">
        <label for="create-birthday">Birthday</label>
        <input id="create-birthday" type="date" min="1900-01-01" max="${defaultCreateBirthday().slice(0, 4) - 5}-12-31" value="${esc(d.birthday)}">
        <div class="field-status" id="create-birthday-status"></div>
        <p class="hint">Age 13+ keeps Roblox's quick sign-up flow.</p>
      </div>
      <div class="field" style="margin-bottom:0">
        <label>Profile field</label>
        <div class="segmented" id="create-gender">
          ${CREATE_GENDERS.map(g => `<button type="button" class="${d.gender === g ? 'on' : ''}" data-action="create-gender" data-g="${g}">${g === 'Skip' ? 'Prefer not to say' : g}</button>`).join('')}
        </div>
        <p class="hint" style="margin-top:6px">Optional — sets the avatar's default look.</p>
      </div>
    </div>
    <div class="m-foot">
      <button class="btn" data-action="modal-cancel">Cancel</button>
      <button class="btn primary" data-action="create-account-submit" id="create-submit">
        ${d.submitting ? '<span class="spinner"></span> Opening Roblox…' : `${icon('user-plus')} Create account`}
      </button>
    </div>`, 'create-modal');
  wireCreateModal();
  updateCreateValidation();
  const first = $('#create-username');
  if (first) first.focus();
}

function wireCreateModal() {
  const d = state.createDraft;
  if (!d) return;
  const username = $('#create-username');
  const password = $('#create-password');
  const confirm = $('#create-confirm');
  const birthday = $('#create-birthday');

  username.addEventListener('input', () => {
    d.username = username.value;
    d.check = null;
    d.suggest = [];
    d.suggestFor = '';
    d.checking = false;
    clearTimeout(createCheckTimer);
    renderCreateSuggestions();
    updateCreateValidation();
    scheduleCreateUsernameCheck();
  });
  password.addEventListener('input', () => {
    d.password = password.value;
    updateCreateValidation();
  });
  confirm.addEventListener('input', () => {
    d.confirm = confirm.value;
    updateCreateValidation();
  });
  birthday.addEventListener('input', () => {
    d.birthday = birthday.value;
    d.check = null;               // availability checks depend on the birthday
    updateCreateValidation();
    scheduleCreateUsernameCheck();
  });
}

function scheduleCreateUsernameCheck() {
  const d = state.createDraft;
  if (!d || d.submitting) return;
  clearTimeout(createCheckTimer);
  const candidate = String(d.username || '').trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(candidate) || !d.birthday) return;
  createCheckTimer = setTimeout(async () => {
    const dd = state.createDraft;
    if (!dd || dd.submitting || !$('#create-username')) return;   // modal closed or re-opened
    dd.checking = true;
    updateCreateStatusLine();
    const current = String(dd.username || '').trim();
    const r = await call(() => api.signup.checkUsername(current, dd.birthday), { ok: true }, 9000);
    if (!state.createDraft || state.createDraft !== dd || !$('#create-username')) return;
    dd.checking = false;
    if (r && r.ok) dd.check = { available: r.available, message: r.message };
    else dd.check = { available: null, message: (r && r.error) || 'Could not check availability — Roblox validates the name at sign-up.' };
    updateCreateStatusLine();
    updateCreateValidation();
    // A taken name gets instant alternatives: verified-available variants
    // the user can adopt with one click.
    if (dd.check && dd.check.available === false) loadCreateSuggestions(dd);
    else { dd.suggest = []; dd.suggestFor = ''; renderCreateSuggestions(); }
  }, 550);
}

// Fetch available username variants for a taken name. Guarded by draft
// identity and re-checked against the current username so a slow response
// never lands on the wrong form state.
async function loadCreateSuggestions(d) {
  const base = String(d.username || '').trim();
  if (!base || d.suggestFor === base || d.suggesting) return;
  d.suggestFor = base;
  d.suggesting = true;
  d.suggest = [];
  renderCreateSuggestions();
  const r = await call(() => api.signup.suggestUsernames(base, d.birthday), { ok: true }, 15000);
  if (!state.createDraft || state.createDraft !== d || !$('#create-username')) return;
  d.suggesting = false;
  if (d.suggestFor !== String(d.username || '').trim()) return;   // username moved on
  d.suggest = (r && r.ok && Array.isArray(r.suggestions))
    ? r.suggestions.filter(s => typeof s === 'string' && /^[A-Za-z0-9_]{3,20}$/.test(s)).slice(0, 5)
    : [];
  renderCreateSuggestions();
}

function renderCreateSuggestions() {
  const d = state.createDraft;
  const box = $('#create-suggest');
  if (!d || !box) return;
  const taken = d.check && d.check.available === false;
  const items = (d.suggest || []).filter(s => s !== String(d.username || '').trim());
  if (!taken || (!items.length && !d.suggesting)) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  if (d.suggesting) {
    box.innerHTML = '<span class="spinner"></span><span class="suggest-note">Looking for available names…</span>';
  } else if (items.length) {
    box.innerHTML = '<span class="suggest-note">Try:</span>'
      + items.map(u => `<button type="button" class="suggest-chip" data-action="create-pick-user" data-u="${esc(u)}">${esc(u)}</button>`).join('');
  } else {
    box.innerHTML = '';
    box.hidden = true;
  }
}

function createValidationErrors(d) {
  const errors = {};
  const u = String(d.username || '').trim();
  if (u.length < 3) errors.username = 'At least 3 characters.';
  else if (u.length > 20) errors.username = 'At most 20 characters.';
  else if (!/^[A-Za-z0-9_]+$/.test(u)) errors.username = 'Only letters, numbers and underscores.';

  const p = String(d.password || '');
  if (!p) errors.password = 'Enter a password.';
  else if (p.length < 8) errors.password = 'At least 8 characters.';
  else if (p.length > 20) errors.password = 'At most 20 characters.';
  else if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) errors.password = 'Include a letter and a number.';

  const c = String(d.confirm || '');
  if (c !== p) errors.confirm = 'The passwords do not match.';

  const b = String(d.birthday || '');
  const m = b.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) errors.birthday = 'Enter a valid birthday.';
  else {
    const y = Number(m[1]), mo = Number(m[2]), dy = Number(m[3]);
    const date = new Date(Date.UTC(y, mo - 1, dy));
    const now = new Date();
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== dy) {
      errors.birthday = 'That date is invalid.';
    } else if (date.getTime() > Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) {
      errors.birthday = 'Birthday must be in the past.';
    } else {
      let age = now.getUTCFullYear() - y;
      const before = now.getUTCMonth() < mo - 1 || (now.getUTCMonth() === mo - 1 && now.getUTCDate() < dy);
      if (before) age -= 1;
      if (age < 13) errors.birthday = 'Roblox requires age 13 or older for automatic sign-up.';
    }
  }
  return errors;
}

function updateCreateStatusLine() {
  const d = state.createDraft;
  const line = $('#create-username-status');
  if (!d || !line) return;
  if (d.checking) { line.className = 'field-status dim'; line.innerHTML = '<span class="spinner"></span> Checking availability…'; return; }
  if (d.check && d.check.available === true) { line.className = 'field-status ok'; line.innerHTML = `${icon('check-circle')} ${esc(d.check.message || 'Username is available')}`; return; }
  if (d.check && d.check.available === false) {
    line.className = 'field-status bad'; line.innerHTML = `${icon('alert-circle')} ${esc(d.check.message || 'That username is already taken')}`;
    return;
  }
  if (d.check) { line.className = 'field-status dim'; line.textContent = d.check.message || 'Availability unknown — Roblox validates at sign-up.'; return; }
  line.className = 'field-status'; line.innerHTML = '';
}

function updateCreateValidation() {
  const d = state.createDraft;
  if (!d || !$('#create-submit')) return;   // modal closed
  const errors = createValidationErrors(d);
  const taken = d.check && d.check.available === false;
  const btn = $('#create-submit');
  btn.disabled = !!Object.keys(errors).length || taken || d.checking || d.submitting;
  const mark = (field, err) => {
    const el = $('#create-' + field + '-status');
    if (!el) return;
    if (field === 'username') { updateCreateStatusLine(); return; }
    if (err) { el.className = 'field-status bad'; el.textContent = err; }
    else { el.className = 'field-status'; el.textContent = ''; }
  };
  mark('username', errors.username);
  mark('password', errors.password);
  mark('confirm', errors.confirm);
  mark('birthday', errors.birthday);
}

function closeCreateModal() {
  clearTimeout(createCheckTimer);
  state.createDraft = null;
  closeModal();
}

function closePersonJoinDialog() {
  state.personJoin = null;
  closeModal();
}

function renderPersonJoinDialog() {
  const join = state.personJoin;
  if (!join) return;
  const choices = state.accounts.map(account => {
    const selected = join.selectedIds.has(account.id);
    return `<button type="button" class="join-account-choice ${selected ? 'on' : ''}" data-action="select-join-account" data-id="${esc(account.id)}" aria-pressed="${selected}" ${join.joining ? 'disabled' : ''}>
      ${account.avatar ? `<img src="${esc(account.avatar)}" alt="">` : `<span class="join-account-avatar">${icon('users-group')}</span>`}
      <span class="join-account-name"><strong>${esc(account.displayName || account.username)}</strong><small>@${esc(account.username)}</small></span>
      <span class="presence ${presenceClass(account.presence)}"><span class="pd"></span>${esc(account.presence || 'Offline')}</span>
      <span class="join-account-check">${selected ? icon('check') : ''}</span>
    </button>`;
  }).join('');
  const n = join.selectedIds.size;
  openModal(`
    <div class="m-head"><h3>Plan join for ${esc(join.name || 'player')}</h3><p>Pick up to three accounts. SUNDAY Launcher preserves an exact-target launch intent for each.</p></div>
    <div class="m-body">
      <div class="join-account-list">${choices}</div>
      <p class="hint" style="margin:13px 0 0">Exact live-server joining is available only while client launching is active. Private or privacy-restricted servers can still block a join.</p>
    </div>
    <div class="m-foot">
      <button class="btn" data-action="modal-cancel" ${join.joining ? 'disabled' : ''}>Cancel</button>
      <button class="btn primary" data-action="person-join-confirm" ${!n || join.joining ? 'disabled' : ''}>
        ${join.joining ? '<span class="spinner"></span> Preparing…' : `${icon('play')} Prepare${n ? ` for ${n} account${n === 1 ? '' : 's'}` : ''}`}
      </button>
    </div>`);
}

function openPersonJoinDialog(userId, placeId, gameId, name) {
  // The join flow is account-driven: Roblox resolves the target's live server
  // at launch time, so a place/game hint is only cosmetic. The user id is the
  // one thing that must be valid, and it arrives as a data-* string.
  const targetId = Number(userId);
  if (!targetId || !Number.isFinite(targetId)) { toast('That person could not be identified. Refresh the page and try again.', 'bad'); return; }
  if (!state.accounts.length) { toast('Add an account to join', 'bad'); setView('accounts'); return; }
  const preselect = Array.from(state.selected).filter(id => state.accounts.some(a => a.id === id));
  const initial = preselect.length ? preselect : (state.accounts.length === 1 ? [state.accounts[0].id] : []);
  state.personJoin = {
    userId: targetId,
    placeId: placeId ? String(placeId) : null,
    gameId: gameId || null,
    name: name || 'player',
    selectedIds: new Set(initial),
    joining: false,
  };
  renderPersonJoinDialog();
}

/* ----------------------------- Context menu ----------------------------- */
const ctxmenu = $('#ctxmenu');
function showContextMenu(x, y, items) {
  ctxmenu.innerHTML = items.map(it => it.sep ? '<div class="sep"></div>'
    : `<button data-ctx="${it.id}" class="${it.danger ? 'danger' : ''}">${icon(it.icon)}<span>${esc(it.label)}</span></button>`).join('');
  ctxmenu.style.display = 'block';
  const w = ctxmenu.offsetWidth, h = ctxmenu.offsetHeight;
  ctxmenu.style.left = Math.min(x, window.innerWidth - w - 8) + 'px';
  ctxmenu.style.top = Math.min(y, window.innerHeight - h - 8) + 'px';
  ctxmenu._items = items;
}
function hideContextMenu() { ctxmenu.style.display = 'none'; ctxmenu._items = null; }
document.addEventListener('click', hideContextMenu);
document.addEventListener('scroll', hideContextMenu, true);
ctxmenu.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-ctx]');
  if (!btn || !ctxmenu._items) return;
  const item = ctxmenu._items.find(i => i.id === btn.dataset.ctx);
  hideContextMenu();
  if (item && item.onClick) item.onClick();
});

/* Native window feel: Escape closes context menus and dialogs, mirroring
   how every Windows app dismisses a menu or modal. */
function cancelModal() {
  if (state.personJoin) closePersonJoinDialog();
  else if (state.followTargetId) closeFollowDialog();
  else if (state.createDraft) closeCreateModal();
  else { closeModal(); state.servers = null; state.sessionDraft = null; }
}
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (ctxmenu.style.display === 'block') { hideContextMenu(); hideTip(); e.preventDefault(); return; }
  const pal = $('#palette-back');
  if (pal && !pal.hidden) { closePalette(); e.preventDefault(); return; }
  if ($('#modal-back').classList.contains('open')) { hideTip(); cancelModal(); e.preventDefault(); }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Tab' || !$('#modal-back').classList.contains('open')) return;
  const modal = $('#modal');
  const focusable = Array.from(modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'));
  if (!focusable.length) { event.preventDefault(); modal.focus(); return; }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

/* Ctrl+1..9 jumps straight to a rail section, numbered top to bottom.
   While the command palette is open the same digits run the nth result. */
document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
  const n = parseInt(e.key, 10);
  if (!(n >= 1 && n <= 9)) return;
  if (state.palette && state.palette.open) { e.preventDefault(); paletteRunIndex(n - 1); return; }
  const target = document.querySelectorAll('.nav button[data-view]')[n - 1];
  if (!target) return;
  e.preventDefault();
  if (target.dataset.view === 'people') state.people.route = 'home';
  setView(target.dataset.view);
});

/* '/' focuses the search box on Games and People, like Win11 lists. */
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.altKey || e.metaKey) return;
  const active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable)) return;
  const search = (state.view === 'games' && $('#games-search')) || (state.view === 'people' && $('#people-search'));
  if (!search) return;
  e.preventDefault();
  search.focus();
  if (typeof search.select === 'function') search.select();
});

/* ----------------------------- Tooltips ----------------------------- */
/* JS-driven so tips never clip at the viewport edge (the old pure-CSS
   translateX(-50%) ::after overflowed near the right/top of the window). */
const tipEl = document.createElement('div');
tipEl.className = 'tip';
tipEl.setAttribute('role', 'tooltip');
document.body.appendChild(tipEl);
let tipTarget = null;

function positionTip(target) {
  const text = target.getAttribute('data-tip');
  if (!text) return;
  tipEl.textContent = text;
  tipEl.classList.toggle('wide', target.hasAttribute('data-tip-wide'));
  tipEl.classList.add('show');
  const M = 8; // viewport margin
  const r = target.getBoundingClientRect();
  const tw = tipEl.offsetWidth, th = tipEl.offsetHeight;
  let top = r.top - th - M;
  const below = top < M;
  if (below) top = r.bottom + M;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(M, Math.min(left, window.innerWidth - tw - M));
  top = Math.max(M, Math.min(top, window.innerHeight - th - M));
  tipEl.style.left = left + 'px';
  tipEl.style.top = top + 'px';
  tipEl.classList.toggle('below', below);
}
function hideTip() { tipTarget = null; tipEl.classList.remove('show'); }
document.addEventListener('mouseover', (e) => {
  const t = e.target.closest('[data-tip]');
  if (t === tipTarget) return;
  if (!t) { hideTip(); return; }
  tipTarget = t;
  positionTip(t);
});
document.addEventListener('mouseout', (e) => {
  if (!tipTarget) return;
  const to = e.relatedTarget;
  if (!to || !tipTarget.contains(to)) hideTip();
});
document.addEventListener('mousedown', hideTip);
window.addEventListener('scroll', hideTip, true);
window.addEventListener('blur', hideTip);

/* ----------------------------- Safe API ----------------------------- */
async function call(fn, fallback, timeoutMs) {
  let timer = null;
  try {
    if (!api) throw new Error('SUNDAY Launcher bridge unavailable (run inside the SUNDAY Launcher app).');
    const work = Promise.resolve().then(fn);
    const limit = timeoutMs === undefined ? 15000 : Number(timeoutMs);
    // Interactive operations such as account sign-in resolve when their own
    // window closes. A non-positive timeout lets that user-driven flow finish
    // without showing a false "did not respond" error after 15 seconds.
    if (!(limit > 0)) return await work;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('SUNDAY Launcher did not respond in time. Check Diagnostics and retry.')), limit);
    });
    return await Promise.race([work, timeout]);
  } catch (err) {
    if (fallback !== undefined) return fallback;
    return { ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ----------------------------- Router ----------------------------- */
const views = {};
let renderedView = null;
const VIEW_META = {
  instances: ['Launch', 'Launch'],
  games: ['Games', 'Games'],
  accounts: ['Accounts', 'Accounts'],
  people: ['People', 'People'],
  stats: ['Stats', 'Stats'],
  history: ['History', 'History'],
  diagnostics: ['Diagnostics', 'Diagnostics'],
  settings: ['Settings', 'Settings'],
  help: ['Help', 'Help'],
};
function setView(name) {
  state.view = name;
  try { localStorage.setItem('sunday-last-view', name); } catch (_) { /* storage is best-effort */ }
  document.querySelectorAll('.nav button').forEach(b => {
    const active = b.dataset.view === name;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  const meta = VIEW_META[name] || VIEW_META.instances;
  const titlebarSection = $('#titlebar-section');
  if (titlebarSection) titlebarSection.textContent = meta[1];
  document.title = `${meta[1]} — SUNDAY Launcher`;
  (views[name] || views.instances)();
  renderedView = name;
  if (name === 'people') setTimeout(refreshVisiblePeoplePresence, 0);
}
document.querySelectorAll('.nav').forEach(navEl => navEl.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]');
  if (b) {
    if (b.dataset.view === state.view && renderedView === state.view && b.dataset.view !== 'people') return;
    if (b.dataset.view === 'people') state.people.route = 'home';
    setView(b.dataset.view);
    requestAnimationFrame(() => $('#main-content').focus({ preventScroll: true }));
  }
}));
function mount(html, options) {
  const animate = !options || options.animate !== false;
  content.innerHTML = `<div class="view${animate ? ' view-enter' : ''}">${html}</div>`;
  const head = content.querySelector('.page-head');
  if (head) {
    const heading = head.querySelector('h1');
    if (heading) {
      heading.id = 'view-heading';
      $('#main-content').setAttribute('aria-labelledby', heading.id);
    }
  }
}

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
  if (!(response && response.prepared)) return false;
  const count = response.selectedCount || (response.plan && response.plan.operations && response.plan.operations.length) || 0;
  toast(legacyCompatibilityMode()
    ? `${count}-account launch plan prepared`
    : `${count}-account plan saved — execution is unavailable right now`);
  return true;
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
      tone: 'good', icon: 'check-circle', label: 'Legacy mode active',
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

  let readiness = executionAvailable ? 'Ready to launch' : 'Ready to prepare';
  if (!hasSelection) readiness = 'Select at least one account';
  else if (!destinationValid) readiness = 'Check destination';
  else if (!executionAvailable && !robloxDetected) readiness = 'Roblox not detected · plan only';

  return {
    executionAvailable,
    enabled: hasSelection && destinationValid,
    label: executionAvailable ? 'Launch' : 'Prepare plan',
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
  const mode = hasAccounts ? state.launchMode : 'plain';
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
          <span class="launch-roster-count" id="launch-selection-count" aria-live="polite">${selectedCount} / 3</span>
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
        <button class="btn primary launch-primary-action" data-action="launch-accounts" aria-describedby="launch-account-readiness" ${accountLaunch.enabled ? '' : 'disabled'}>${icon('play')} <span id="lp-count-label">${accountLaunch.label}</span></button>
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
        <button class="btn primary launch-primary-action" data-action="launch-quick" aria-describedby="launch-quick-readiness">${icon('play')} ${quickLaunch.label}</button>
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
  const html = `${icon('play')} ${legacyCompatibilityMode() ? 'Launch' : 'Prepare'} ${count} selected`;
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
  if (rosterCount) rosterCount.textContent = `${count} / 3`;
  const reviewCount = $('#launch-review-count');
  if (reviewCount) reviewCount.textContent = `${count} client${count === 1 ? '' : 's'}`;
  const readiness = $('#launch-account-readiness');
  if (readiness) readiness.textContent = launchState.readiness;
  const context = document.querySelector('.launch-action-context');
  if (context) context.textContent = `${count || 'No'} client${count === 1 ? '' : 's'} · ${destination.label}`;
}

/* ----------------------------- Accounts view ----------------------------- */
views.accounts = function () {
  const list = state.accounts || [];
  const selectedCount = state.selected.size;

  const cards = list.length ? `<div class="acct-grid identity-list" data-account-grid>` + list.map(a => renderAccountCard(a)).join('') + `</div>`
    : `<div class="identity-empty"><div class="e-ico">${icon('users')}</div>
        <div><h2>No accounts yet</h2><p>Add an existing Roblox account to build a launch roster.</p></div>
        <button class="btn primary" data-action="add-account" ${state.addingAccount ? 'disabled' : ''}>${state.addingAccount ? '<span class="spinner"></span> Waiting for sign-in…' : icon('user-plus') + ' Add account'}</button></div>`;

  mount(`
    <div class="page-head page-head-actions">
      <div><h1>Accounts</h1><p>Manage identities, session health, and who is ready for the next launch.</p></div>
      <div class="inline" data-account-launch-actions>
        ${list.length ? `<button class="btn sm" data-action="refresh-accounts" data-tip="Refresh all">${icon('refresh')} Refresh all</button>` : ''}
        ${selectedCount ? `<button class="btn sm" data-action="launch-selected" data-account-launch-selected>${icon('play')} ${legacyCompatibilityMode() ? 'Launch' : 'Prepare'} ${selectedCount} selected</button>` : ''}
        <button class="btn primary sm" data-action="add-account" ${state.addingAccount ? 'disabled' : ''}>
          ${state.addingAccount ? '<span class="spinner"></span>' : icon('user-plus')} ${state.addingAccount ? 'Waiting for sign-in…' : 'Add account'}
        </button>
      </div>
    </div>
    <div class="identity-summary"><span>${list.length} account${list.length === 1 ? '' : 's'}</span><span>${selectedCount} selected</span>${(() => { const t = list.reduce((n, x) => n + (x.robux || 0), 0); return list.some(x => x.robux != null) ? `<span class="robux-total" data-tip="Total Robux across all accounts">${icon('box')} ${fmtNum(t)}</span>` : ''; })()}</div>
    ${cards}
  `);
};

/* Compact public-profile facts for an account card: social counts and
   account age, each shown only when Roblox reported it. */
function accountFactsHtml(a) {
  const facts = [];
  if (a.friends != null) facts.push(`<span>${icon('users-group')} ${fmtNum(a.friends)} friends</span>`);
  if (a.followers != null) facts.push(`<span>${icon('users')} ${fmtNum(a.followers)} followers</span>`);
  if (a.created) {
    const age = accountAge(a.created);
    if (age && age !== 'today') facts.push(`<span>${icon('clock')} ${age} old</span>`);
  }
  return facts.join('');
}

function renderAccountCard(a) {
  const allAccounts = state.accounts || [];
  const presRaw = a.presence || 'Offline';
  const pl = presRaw.toLowerCase();
  const presClass = presenceClass(presRaw);
  const presTip = a.presenceError ? ` data-tip="${esc(a.presenceError)}"` : '';
  const expired = !!a.sessionExpired || a.presenceError === 'Session expired';
  const canFollow = !expired && pl === 'in game' && allAccounts.length > 1;
  const followTip = allAccounts.length < 2 ? 'Add a second account to use Follow'
    : (canFollow ? 'Choose other accounts to join this exact server' : 'This account must be in a game');
  const id = safeAttr(a.id);
  const facts = accountFactsHtml(a);
  return `
    <div class="acct ${state.selected.has(a.id) ? 'selected' : ''}" data-id="${id}">
      <div class="top">
        ${a.avatar ? `<img class="avatar" src="${esc(a.avatar)}" alt="">` : `<div class="avatar"></div>`}
        <div class="who">
          <div class="dname" data-acct-dname="${id}">${esc(a.displayName || a.username)}${a.verified ? ` <span class="vbadge" data-tip="Verified account">${icon('check-circle')}</span>` : ''}</div>
          <div class="uname">@${esc(a.username)}</div>
        </div>
        <button type="button" class="check" data-action="toggle-account" data-id="${id}" data-tip="Select for a launch plan" aria-label="Select ${esc(a.displayName || a.username)} for a launch plan" aria-pressed="${state.selected.has(a.id)}">${icon('check')}</button>
      </div>
      <div class="acct-meta">
        <div class="row-split">
          <span class="presence ${presClass}"${presTip} data-acct-presence="${id}"><span class="pd"></span>${esc(presRaw)}</span>
          <span class="robux-chip" data-acct-robux="${id}"${a.robux == null ? ' hidden' : ''} data-tip="Robux balance${a.premium ? ' - Premium member' : ''}">${a.premium ? '<b class="prem">P</b>' : ''}${icon('box')} ${a.robux == null ? '' : fmtNum(a.robux)}</span>
        </div>
        ${facts ? `<div class="acct-facts" data-acct-facts="${id}">${facts}</div>` : ''}
        <div class="acct-game" data-acct-game="${id}"${a.game ? '' : ' hidden'}>${a.game ? icon('compass') + ' ' + esc(a.game.name) : ''}</div>
      </div>
      <div class="acct-actions">
        ${expired
          ? `<button class="btn primary sm" data-action="reauth-account" data-id="${id}">${icon('user-plus')} Sign in again</button>`
          : `<button class="btn primary sm" data-action="launch-account" data-id="${id}">${icon('play')} ${legacyCompatibilityMode() ? 'Launch' : 'Prepare'}</button>`}
        <button class="btn sm" data-action="follow-account" data-id="${id}" data-tip="${esc(followTip)}" ${canFollow ? '' : 'disabled'}>${icon('users-group')} Follow</button>
        <button class="btn sm icon" data-action="refresh-account" data-id="${id}" data-tip="Refresh status">${icon('refresh')}</button>
        <button class="btn sm icon danger" data-action="remove-account" data-id="${id}" data-tip="Remove account">${icon('trash')}</button>
      </div>
    </div>`;
}

function presenceClass(presRaw) {
  const pl = (presRaw || 'Offline').toLowerCase();
  if (pl === 'online') return 'online';
  if (pl.includes('game') || pl.includes('studio')) return 'ingame';
  if (pl === 'unknown') return 'unknown';
  return '';
}

/**
 * Real-time per-card update: the main process pushes only accounts whose
 * status/game changed. Patch just that card in place - no full re-render,
 * no timer, no extra network from the renderer.
 */
function replaceAccountCard(acc) {
  const card = findAllByData(document, 'id', acc.id).find(el => el.classList.contains('acct'));
  if (card) card.outerHTML = renderAccountCard(acc);
}

function patchAccountGrid(accounts) {
  const grid = document.querySelector('[data-account-grid]');
  if (!grid) {
      if (state.view === 'accounts') views.accounts();
    return;
  }
  const live = new Set();
  for (const acc of accounts || []) {
    if (!acc || !acc.id) continue;
    live.add(String(acc.id));
    const card = findAllByData(grid, 'id', acc.id).find(el => el.classList.contains('acct'));
    if (card) card.outerHTML = renderAccountCard(acc);
    else grid.insertAdjacentHTML('beforeend', renderAccountCard(acc));
  }
  Array.from(grid.querySelectorAll('.acct[data-id]')).forEach(card => {
    if (!live.has(card.dataset.id)) card.remove();
  });
  for (const acc of accounts || []) {
    const card = findAllByData(grid, 'id', acc.id).find(el => el.classList.contains('acct'));
    if (card) grid.appendChild(card);
  }
}

function applyAccountUpdate(acc) {
  if (!acc || !acc.id) return;
  const i = state.accounts.findIndex(a => a.id === acc.id);
  const prev = i >= 0 ? state.accounts[i] : null;
  if (i >= 0) state.accounts[i] = Object.assign({}, state.accounts[i], acc);
  const merged = state.accounts[i >= 0 ? i : -1] || acc;
  const structureChanged = !!prev && (!!prev.sessionExpired !== !!merged.sessionExpired || prev.presenceError === 'Session expired' !== (merged.presenceError === 'Session expired'));
  if (structureChanged && state.view === 'accounts') {
    replaceAccountCard(merged);
    return;
  }

  const dnameEl = findByData(document, 'acct-dname', acc.id);
  if (dnameEl) dnameEl.innerHTML = `${esc(acc.displayName || acc.username)}${acc.verified ? ` <span class="vbadge" data-tip="Verified account">${icon('check-circle')}</span>` : ''}`;
  const factsEl = findByData(document, 'acct-facts', acc.id);
  if (factsEl) {
    const facts = accountFactsHtml(acc);
    factsEl.innerHTML = facts;
    factsEl.hidden = !facts;
  }

  const presEl = findByData(document, 'acct-presence', acc.id);
  if (presEl) {
    presEl.className = 'presence ' + presenceClass(acc.presence);
    presEl.innerHTML = `<span class="pd"></span>${esc(acc.presence || 'Offline')}`;
    if (acc.presenceError) presEl.setAttribute('data-tip', acc.presenceError);
    else presEl.removeAttribute('data-tip');
  }
  const gameEl = findByData(document, 'acct-game', acc.id);
  if (gameEl) {
    if (acc.game && acc.game.name) { gameEl.hidden = false; gameEl.innerHTML = icon('compass') + ' ' + esc(acc.game.name); }
    else { gameEl.hidden = true; gameEl.innerHTML = ''; }
  }
  const robuxEl = findByData(document, 'acct-robux', acc.id);
  if (robuxEl && acc.robux != null) {
    robuxEl.hidden = false;
    robuxEl.innerHTML = `${acc.premium ? '<b class="prem">P</b>' : ''}${icon('box')} ${fmtNum(acc.robux)}`;
    robuxEl.setAttribute('data-tip', 'Robux balance' + (acc.premium ? ' - Premium member' : ''));
  }
}

/* ----------------------------- Watchdog (auto-rejoin) ----------------------------- */
/* Armed per launch or saved session. The main process accepts only confirmed
   owned-exit evidence, then asks the coordinator for a fresh intent and backs
   off between tries. Presence is display context, never replacement proof. */
const watchdog = { records: [], summary: null };

function armWatchdog(rows) {
  const records = (rows || []).map(r => ({
    accountId: String(r.accountId || ''),
    placeId: String(r.placeId || ''),
    gameInstanceId: String(r.gameInstanceId || r.gameId || ''),
    targetUserId: r.targetUserId || null,
    name: r.name || 'the game',
  })).filter(r => r.accountId);
  if (!records.length) return;
  call(() => api.keeper.arm(records), null, 0);
}

function watchdogRecordForAccount(accountId) {
  if (!accountId) return null;
  return watchdog.records.find(r => String(r.accountId) === String(accountId) && r.state !== 'gaveup') || null;
}

function applyWatchdogStatus(status) {
  if (!status || !Array.isArray(status.records)) return;
  watchdog.records = status.records;
  watchdog.summary = status.summary || null;
  renderWatchdogChip();
  if (state.view === 'instances') renderInstanceList();
}

function renderWatchdogChip() {
  const el = $('#watchdog-chip');
  if (!el) return;
  const recs = watchdog.records.filter(r => r.state !== 'gaveup');
  el.hidden = !recs.length;
  if (!recs.length) { el.innerHTML = ''; return; }
  const rejoining = recs.filter(r => r.state === 'rejoining').length;
  const label = `Watchdog: ${recs.length} account${recs.length === 1 ? '' : 's'}` + (rejoining ? ` - ${rejoining} rejoining` : '');
  el.innerHTML = `${icon('activity')} ${label} <button class="btn sm ghost" data-action="keepalive-off">Stop</button>`;
}

/* ----------------------------- Games view ----------------------------- */
/* Local playtime cross-reference for the Games grid: placeId -> total playtime
   and session count, crunched from the stats payload with a short TTL so
   browsing and re-sorting never re-crunch it. Powers the "Played" line on
   cards and the Most-played sort. */
const playedCache = { at: 0, map: new Map() };
async function ensurePlayedMap() {
  if (Date.now() - playedCache.at < 60000) return playedCache.map;
  const r = await call(() => api.playtime.stats(), { ok: false });
  if (r && r.ok && Array.isArray(r.perGame)) {
    playedCache.map = new Map(r.perGame.filter(g => g.placeId).map(g =>
      [String(g.placeId), { ms: g.totalMs || 0, sessions: g.sessions || 0 }]));
    playedCache.at = Date.now();
  }
  return playedCache.map;
}
function playedFor(gm) {
  const hit = playedCache.map.get(String(gm && gm.placeId));
  if (!hit || !(hit.ms > 0)) return null;
  return {
    label: `Played ${fmtDur(hit.ms)}`,
    tip: `${hit.sessions} session${hit.sessions === 1 ? '' : 's'} — full breakdown on Stats`,
  };
}

/* "Updated 3d ago" for game cards — day-granular, unlike relTime's seconds. */
function updatedAgo(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const days = Math.floor((Date.now() - t) / 86400000);
  if (days < 1) return 'updated today';
  if (days < 7) return `updated ${days}d ago`;
  if (days < 30) return `updated ${Math.floor(days / 7)}w ago`;
  return `updated ${Math.floor(days / 30)}mo ago`;
}

views.games = function () {
  const g = state.games;
  mount(`
    <div class="page-head">
      <h1>Games</h1>
      <p>Browse and search Roblox experiences, then jump straight in.</p>
    </div>
    <div class="toolbar">
      <div class="search">${icon('search')}<input id="games-search" type="text" placeholder="Search experiences…" value="${esc(g.query)}" aria-label="Search Roblox experiences"></div>
      <button class="btn" data-action="refresh-games" data-tip="Reload popular experiences">${icon('refresh')} Refresh</button>
      <button class="btn" data-action="random-game" data-tip="Prepare a random game from the list">${icon('dice')} Plan random</button>
    </div>
    <div class="games-cats" id="games-cats"></div>
    <div class="games-tools">
      <div class="segmented compact" aria-label="Sort games">
        <button data-action="games-sort" data-sort="players" class="${g.sort === 'players' ? 'on' : ''}" data-tip="Sort by live player count">Most players</button>
        <button data-action="games-sort" data-sort="rating" class="${g.sort === 'rating' ? 'on' : ''}" data-tip="Sort by like ratio">Top rated</button>
        <button data-action="games-sort" data-sort="played" class="${g.sort === 'played' ? 'on' : ''}" data-tip="Sort by your tracked playtime">Most played</button>
        <button data-action="games-sort" data-sort="name" class="${g.sort === 'name' ? 'on' : ''}">A–Z</button>
      </div>
      <button class="btn sm ${g.hideEmpty ? 'active-filter' : ''}" data-action="games-hide-empty">${icon('users-group')} ${g.hideEmpty ? 'Showing active only' : 'Hide empty'}</button>
    </div>
    <div class="games-grid" id="games-grid"></div>
  `);
  const inp = $('#games-search');
  if (inp) {
    let debounce = null;
    inp.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (state.view === 'games' && inp.value.trim() !== state.games.query) doGamesSearch(inp.value);
      }, 450);
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(debounce); doGamesSearch(inp.value); } });
  }
  renderGamesCategories();
  if (!g.loaded && !g.loading) gamesBrowse();
  else renderGamesGrid();
  // Playtime chips land a beat after the grid - re-render the grid only.
  ensurePlayedMap().then(() => { if (state.view === 'games') renderGamesGrid(); });
};

// Category filter chips (browse mode only - Roblox explore sorts). "All" is default.
function renderGamesCategories() {
  const box = $('#games-cats');
  if (!box) return;
  const g = state.games;
  const cats = g.categories || [];
  const favs = favGames().length;
  const recents = recentGames().length;
  if (!cats.length && !favs && !recents) { box.innerHTML = ''; box.hidden = true; return; }
  box.hidden = false;
  const chip = (label, value, count) => {
    const n = count != null ? count : (value === 'All' ? g.list.length : g.list.filter(x => (x.categories || []).includes(value)).length);
    return `<button class="cat-chip ${g.category === value ? 'on' : ''}" data-action="games-category" data-cat="${esc(value)}">${esc(label)}<span class="cat-n">${n}</span></button>`;
  };
  box.innerHTML = (cats.length ? chip('All', 'All') : '')
    + (favs ? chip('Favorites', '__fav', favs) : '')
    + (recents ? chip('Recent', '__recent', recents) : '')
    + cats.map(c => chip(c, c)).join('');
}

function gameRating(gm) {
  const up = Number(gm.upVotes);
  const down = Number(gm.downVotes);
  const total = up + down;
  return total > 0 ? Math.round(up / total * 100) : null;
}

// Loose text match for search ranking: normalized exact > prefix > substring,
// plus per-token prefix overlap (so "grow a gard" pins "Grow a Garden" first).
function normName(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function matchScore(name, query) {
  const n = normName(name), q = normName(query);
  if (!q || !n) return 0;
  if (n === q) return 100;
  let s = 0;
  if (n.startsWith(q)) s = 80;
  else if (n.includes(q)) s = 62;
  const nt = n.split(' '), qt = q.split(' ');
  let hit = 0;
  for (const t of qt) if (t && nt.some(w => w.startsWith(t))) hit++;
  s += (hit / qt.length) * 30;
  return s;
}

function visibleGames() {
  const g = state.games;
  // Favorites and Recents render straight from their stores (kept in saved
  // order - player counts there are snapshots, not live).
  if (g.category === '__fav') return favGames();
  if (g.category === '__recent') return recentGames();
  const list = g.list.filter(game =>
    (!g.hideEmpty || Number(game.playerCount) > 0)
    && (!g.category || g.category === 'All' || (game.categories || []).includes(g.category))
  ).slice();
  if (g.query) {
    // Search mode: the API order is relevance - keep it, but float the games
    // whose names actually resemble the query to the top (stable).
    const idx = new Map(list.map((game, i) => [game, i]));
    list.sort((a, b) => matchScore(b.name, g.query) - matchScore(a.name, g.query) || idx.get(a) - idx.get(b));
  } else if (g.sort === 'rating') {
    list.sort((a, b) => (gameRating(b) == null ? -1 : gameRating(b)) - (gameRating(a) == null ? -1 : gameRating(a))
      || Number(b.playerCount || 0) - Number(a.playerCount || 0));
  } else if (g.sort === 'played') {
    const played = playedCache.map;
    const ms = gm => (played.get(String(gm.placeId)) || { ms: 0 }).ms;
    list.sort((a, b) => ms(b) - ms(a) || Number(b.playerCount || 0) - Number(a.playerCount || 0));
  } else if (g.sort === 'name') {
    list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  } else {
    list.sort((a, b) => Number(b.playerCount || 0) - Number(a.playerCount || 0));
  }
  return list;
}

function gameCard(gm) {
  const thumb = gm.thumbnail
    ? `<img loading="lazy" src="${esc(gm.thumbnail)}" alt="">`
    : `<div class="ph">${icon('compass')}</div>`;
  const rating = gameRating(gm);
  const likes = rating != null ? `<span class="likes">${icon('thumb')} ${rating}%</span>` : '';
  const upd = updatedAgo(gm.lastUpdated);
  const visitsTip = [upd, gm.maxPlayers ? `up to ${gm.maxPlayers} players/server` : ''].filter(Boolean).join(' · ');
  const visits = gm.visits != null ? `<span class="visits"${visitsTip ? ` data-tip="${esc(visitsTip)}"` : ''}>${fmtNum(gm.visits)} visits</span>` : '';
  const played = playedFor(gm);
  return `<div class="game">
    <div class="game-thumb">${thumb}<span class="game-players">${icon('users-group')} ${fmtNum(gm.playerCount)}</span></div>
    <div class="game-body">
      <div class="game-name" title="${esc(gm.name)}">${esc(gm.name)}</div>
      <div class="game-meta">${gm.creator ? '<span>' + esc(gm.creator) + '</span>' : ''}${likes}${visits}</div>
      ${played ? `<div class="game-played" data-tip="${esc(played.tip)}">${icon('clock')} ${esc(played.label)}</div>` : ''}
      <div class="game-actions">
      <button class="btn primary sm" data-action="join-game" data-place="${esc(gm.placeId)}" data-name="${esc(gm.name)}">${icon('play')} Plan join</button>
        <button class="btn sm icon fav ${isFav(gm) ? 'on' : ''}" data-action="toggle-fav" data-place="${esc(gm.placeId)}" data-tip="${isFav(gm) ? 'Remove from favorites' : 'Save to favorites'}">${icon('bookmark')}</button>
        <button class="btn sm" data-action="open-servers" data-place="${esc(gm.placeId)}" data-name="${esc(gm.name)}" data-tip="Browse & join a specific server">${icon('server')}</button>
        <button class="btn sm icon" data-action="open-game-web" data-place="${esc(gm.placeId)}" data-tip="Open on Roblox">${icon('box')}</button>
        <button class="btn sm icon" data-action="copy-place-id" data-place="${esc(gm.placeId)}" data-tip="Copy place ID">${icon('copy')}</button>
      </div>
    </div>
  </div>`;
}

/* ----------------------------- Server browser ----------------------------- */
const SERVER_SORTS = [
  ['best', 'Best match'],
  ['ping', 'Lowest ping'],
  ['space', 'Most space'],
  ['players', 'Most players'],
  ['fps', 'Highest FPS'],
];

function sortedServers(list, mode) {
  const out = (list || []).slice();
  const slots = s => Math.max(0, Number(s.maxPlayers || 0) - Number(s.playing || 0));
  const ping = s => Number(s.ping == null ? 999999 : s.ping);
  const fps = s => Number(s.fps == null ? -1 : s.fps);
  const fill = s => (Number(s.maxPlayers) > 0 ? Number(s.playing || 0) / Number(s.maxPlayers) : 1);
  const full = s => (slots(s) > 0 ? 0 : 1); // non-full (0) sorts before full (1)
  if (mode === 'ping') {
    out.sort((a, b) => ping(a) - ping(b) || slots(b) - slots(a));
  } else if (mode === 'space') {
    out.sort((a, b) => slots(b) - slots(a) || ping(a) - ping(b));
  } else if (mode === 'players') {
    out.sort((a, b) => full(a) - full(b) || Number(b.playing || 0) - Number(a.playing || 0) || ping(a) - ping(b));
  } else if (mode === 'fps') {
    out.sort((a, b) => full(a) - full(b) || fps(b) - fps(a) || ping(a) - ping(b));
  } else { // 'best' - has room, low ping, and not packed (a blended score, distinct from pure ping)
    const score = s => ping(s) + fill(s) * 60;
    out.sort((a, b) => full(a) - full(b) || score(a) - score(b));
  }
  return out;
}

function serverStats(list) {
  const l = list || [];
  const withPing = l.filter(s => s.ping != null);
  const withFps = l.filter(s => s.fps != null);
  const pings = withPing.map(s => Number(s.ping)).sort((a, b) => a - b);
  const avgPing = withPing.length ? Math.round(withPing.reduce((n, s) => n + Number(s.ping), 0) / withPing.length) : null;
  const bestPing = withPing.length ? Math.min(...withPing.map(s => Number(s.ping))) : null;
  const medianPing = pings.length ? pings[Math.floor(pings.length / 2)] : null;
  const avgFps = withFps.length ? Math.round(withFps.reduce((n, s) => n + Number(s.fps), 0) / withFps.length) : null;
  const peakPlayers = l.length ? Math.max(...l.map(s => Number(s.playing) || 0)) : 0;
  return { count: l.length, avgPing, bestPing, medianPing, avgFps, peakPlayers };
}

function filteredServers(sv) {
  const f = sv.filters || {};
  return (sv.list || []).filter(s => {
    const capacity = Number(s.maxPlayers) || 0;
    const occupancy = capacity ? (Number(s.playing) || 0) / capacity * 100 : 0;
    const free = Math.max(0, capacity - (Number(s.playing) || 0));
    return occupancy >= Number(f.occupancy || 0)
      && (Number(f.maxPing || 0) <= 0 || (s.ping != null && Number(s.ping) <= Number(f.maxPing)))
      && (Number(f.minFps || 0) <= 0 || (s.fps != null && Number(s.fps) >= Number(f.minFps)))
      && free >= Number(f.freeSlots || 1);
  });
}

function serverQuality(s) {
  const ping = s.ping == null ? 180 : Number(s.ping);
  const fps = s.fps == null ? 30 : Number(s.fps);
  const fill = s.maxPlayers ? Number(s.playing || 0) / Number(s.maxPlayers) : 0;
  const score = Math.max(0, Math.min(100, Math.round(100 - ping * .28 + (fps - 30) * .5 - Math.max(0, fill - .9) * 80)));
  return { score, label: score >= 80 ? 'Excellent' : score >= 60 ? 'Good' : score >= 40 ? 'Fair' : 'Weak' };
}

function filterSelect(label, key, value, options) {
  return `<label class="server-filter"><span>${label}</span><select data-server-filter="${key}">
    ${options.map(([v, text]) => `<option value="${v}"${String(value) === String(v) ? ' selected' : ''}>${text}</option>`).join('')}
  </select></label>`;
}

function serverSortControls(sv, visible) {
  const sort = sv.sort || 'best';
  const st = serverStats(visible);
  const f = sv.filters || {};
  const scanText = sv.scanning ? 'Scanning Roblox pages…' : sv.deepScanned ? `${sv.scan && sv.scan.pagesScanned || 0} pages analyzed` : 'Quick sample';
  return `<div class="server-tools">
    <div class="server-tool-head"><div class="seg-wrap" role="tablist" aria-label="Sort servers">
      ${SERVER_SORTS.map(([v, label]) => `<button class="seg-chip ${sort === v ? 'on' : ''}" data-action="server-sort" data-sort="${v}">${label}</button>`).join('')}
    </div><button class="btn sm" data-action="servers-scan" ${sv.scanning ? 'disabled' : ''}>${sv.scanning ? '<span class="spinner dark"></span>' : icon('search')} Deep scan</button></div>
    <div class="server-filters">
      ${filterSelect('Occupancy', 'occupancy', f.occupancy, [[0, 'Any'], [25, '25%+'], [50, '50%+'], [75, '75%+']])}
      ${filterSelect('Max ping', 'maxPing', f.maxPing, [[0, 'Any'], [50, '50 ms'], [100, '100 ms'], [150, '150 ms'], [250, '250 ms']])}
      ${filterSelect('Min FPS', 'minFps', f.minFps, [[0, 'Any'], [30, '30'], [45, '45'], [55, '55']])}
      ${filterSelect('Free slots', 'freeSlots', f.freeSlots, [[1, '1+'], [2, '2+'], [5, '5+'], [10, '10+']])}
      <button class="server-reset" data-action="servers-filter-reset">Reset</button>
    </div>
    <div class="server-intel">
      <div><strong>${st.count}</strong><span>Visible</span></div>
      <div><strong>${st.medianPing == null ? '-' : st.medianPing + ' ms'}</strong><span>Median ping</span></div>
      <div><strong>${st.avgFps == null ? '-' : st.avgFps}</strong><span>Average FPS</span></div>
      <div><strong>${st.peakPlayers}</strong><span>Peak players</span></div>
    </div>
    <div class="server-summary">${scanText}${sv.error ? ` - ${esc(sv.error)}` : ''}</div>
  </div>`;
}

function renderServersModal() {
  const sv = state.servers;
  if (!sv) return;
  let body;
  if (sv.loading && !sv.list.length) body = `<div class="games-end"><span class="spinner dark"></span> Loading servers…</div>`;
  else if (sv.error && !sv.list.length) body = `<div class="games-end">${esc(sv.error)}</div>`;
  else if (!sv.list.length) body = `<div class="games-end">No joinable servers found - every server is full right now.</div>`;
  else {
    const visible = filteredServers(sv);
    const sorted = sortedServers(visible, sv.sort);
    body = `${serverSortControls(sv, visible)}<div class="server-list">${sorted.length ? sorted.map((s, i) => {
      const quality = serverQuality(s);
      return `
      <div class="server-row">
        <div class="server-fill"><strong>${s.playing}/${s.maxPlayers}</strong><span>players</span></div>
        <div class="server-bar"><span style="width:${s.maxPlayers ? Math.min(100, Math.round(s.playing / s.maxPlayers * 100)) : 0}%"></span></div>
        <div class="server-meta"><span class="server-quality q-${quality.label.toLowerCase()}">${quality.score} - ${quality.label}</span>${s.ping != null ? `${s.ping} ms` : ''}${s.fps != null ? ` - ${s.fps} fps` : ''}</div>
        <button class="server-copy" data-action="copy-server-id" data-server="${esc(s.id)}" data-tip="Copy server ID">${icon('copy')}</button>
        <button class="btn sm" data-action="join-server" data-place="${esc(sv.placeId)}" data-server="${esc(s.id)}" data-name="${esc(sv.name)}" data-tip="Server #${i + 1}">${icon('play')} Plan join</button>
      </div>`;
    }).join('') : '<div class="games-end">No servers match these filters.</div>'}
      ${sv.nextPageCursor ? `<button class="btn sm servers-more" data-action="servers-more">Load more servers</button>` : ''}</div>`;
  }
  const hasList = !!sv.list.length;
  openModal(`
    <div class="m-head"><h3>Servers - ${esc(sv.name)}</h3><p>Prepare an exact public-server target${state.accounts.length ? ' for your selected accounts' : ''}.</p></div>
    <div class="m-body">${body}</div>
    <div class="m-foot">
      ${hasList ? `<button class="btn" data-action="servers-refresh" style="margin-right:auto" data-tip="Reload the server list">${icon('refresh')} Refresh</button>
      <button class="btn ${sv.autoRefresh ? 'on' : ''}" data-action="servers-auto-refresh" data-tip="Refresh this server list every 30 seconds">Live ${sv.autoRefresh ? 'on' : 'off'}</button>` : ''}
      <button class="btn" data-action="modal-cancel">Close</button>
      ${hasList && state.accounts.length ? `<button class="btn" data-action="servers-fill" data-tip="Plan selected accounts for the emptiest servers">${icon('users-group')} Plan fill</button>` : ''}
      ${hasList ? `<button class="btn primary" data-action="join-best" data-tip="Prepare the top server for this filter">${icon('play')} Plan best</button>` : ''}
    </div>`, 'server-modal');
}

/* Fill: pick the emptiest servers automatically and pack the selected
   accounts into them, optionally arming the watchdog per account. */
function openFillModal() {
  const sv = state.servers;
  if (!sv) return;
  if (!state.accounts.length) { toast('Add an account first', 'bad'); return; }
  const ids = state.selected.size ? Array.from(state.selected) : [state.accounts[0].id];
  state.fillDraft = { placeId: sv.placeId, name: sv.name, ids, spread: false };
  openModal(`
    <div class="m-head"><h3>Plan server fill</h3><p>${ids.length} account${ids.length === 1 ? '' : 's'} - ${esc(sv.name)}</p></div>
    <div class="m-body">
      <div class="field"><label>Placement</label>
        <div class="segmented" id="fill-mode">
          <button data-action="fill-mode" data-mode="same" class="on">Same server</button>
          <button data-action="fill-mode" data-mode="spread">Spread out</button>
        </div>
        <div class="hint">Same server keeps the whole crew together when one server has room for everyone; spread fills the emptiest servers first, so accounts land in the least crowded ones.</div>
      </div>
      <label class="toggle-row inline" style="gap:10px;margin-top:8px;cursor:pointer">
        <input type="checkbox" id="fill-keepalive" checked> <span>Arm the watchdog only after owned clients reach stable running</span>
      </label>
    </div>
    <div class="m-foot"><button class="btn" data-action="modal-cancel">Cancel</button>
    <button class="btn primary" data-action="fill-confirm">${icon('users-group')} Prepare ${ids.length}</button></div>`, 'fill-modal');
}

async function openServersModal(placeId, name) {
  state.servers = {
    placeId: String(placeId), name: name || 'game', list: [], cursor: null, nextPageCursor: null,
    loading: true, scanning: false, deepScanned: false, scan: null, error: null, sort: 'best',
    filters: { occupancy: 0, maxPing: 0, minFps: 0, freeSlots: 1 },
    autoRefresh: false, refreshTimer: null, requestId: 0,
  };
  renderServersModal();
  await loadServers(false);
}

async function loadServers(append) {
  const sv = state.servers;
  if (!sv) return;
  const requestId = ++sv.requestId;
  sv.loading = true;
  sv.error = null;
  renderServersModal();
  const r = await call(() => api.games.servers(sv.placeId, append ? sv.nextPageCursor : null), undefined, 45000);
  if (!state.servers || state.servers !== sv || sv.requestId !== requestId) return;
  sv.loading = false;
  if (r && r.ok) {
    if (append) {
      const seen = new Set(sv.list.map(s => s.id));
      sv.list = sv.list.concat((r.servers || []).filter(s => !seen.has(s.id)));
    } else {
      sv.list = r.servers || [];
    }
    sv.nextPageCursor = r.nextPageCursor;
    if (r.scan) sv.scan = r.scan;
  } else sv.error = (r && r.error) || 'Servers could not be loaded.';
  renderServersModal();
}

async function deepScanServers(silent) {
  const sv = state.servers;
  if (!sv || sv.scanning) return;
  const requestId = ++sv.requestId;
  sv.scanning = true;
  sv.error = null;
  renderServersModal();
  const r = await call(() => api.games.scanServers(sv.placeId, 8), undefined, 120000);
  if (!state.servers || state.servers !== sv || sv.requestId !== requestId) return;
  sv.scanning = false;
  if (r && r.ok) {
    const byId = new Map(sv.list.map(s => [s.id, s]));
    (r.servers || []).forEach(s => byId.set(s.id, s));
    sv.list = Array.from(byId.values());
    sv.deepScanned = true;
    sv.scan = r.scan || null;
    if (!silent) toast(`Analyzed ${r.scan && r.scan.examined || sv.list.length} servers`, 'good');
  } else {
    sv.error = (r && r.error) || 'Deep scan failed.';
    if (!silent) toast(sv.error, 'bad');
  }
  renderServersModal();
}

function setServerAutoRefresh(enabled) {
  const sv = state.servers;
  if (!sv) return;
  if (sv.refreshTimer) clearInterval(sv.refreshTimer);
  sv.refreshTimer = null;
  sv.autoRefresh = !!enabled;
  if (sv.autoRefresh) sv.refreshTimer = setInterval(() => {
    if (state.servers === sv && !sv.loading && !sv.scanning) loadServers(false);
  }, 30000);
  renderServersModal();
}

async function joinServer(placeId, serverId, name) {
  if (!state.accounts.length) { toast('Add an account to join a server', 'bad'); closeModal(); state.servers = null; setView('accounts'); return; }
  const ids = state.selected.size ? Array.from(state.selected) : [state.accounts[0].id];
  const r = await call(() => api.launch.join(ids, String(placeId), String(serverId)));
  if (handlePreparedPlan(r)) { closeModal(); state.servers = null; return; }
  if (r && r.ok) {
    toast(`Joining ${name} - ${r.launched} client${r.launched === 1 ? '' : 's'}`, r.failed ? 'bad' : 'good');
    recordRecentGame(gameByPlaceId(placeId));
    closeModal(); state.servers = null;
  } else toast((r && r.error) || 'Join failed', 'bad');
}

function renderGamesGrid() {
  const grid = $('#games-grid');
  if (!grid) return;
  const g = state.games;
  grid.setAttribute('aria-live', 'polite');
  grid.setAttribute('aria-busy', String(!!g.loading));
  if (g.loading && !g.list.length) {
    grid.innerHTML = `<div class="games-skeleton" aria-label="Loading experiences"><span></span><span></span><span></span></div>`;
    return;
  }
  if (g.error && !g.list.length) {
    grid.innerHTML = `<div class="games-state" role="alert"><strong>Experiences could not load</strong><p>${esc(g.error)}</p><button class="btn sm" data-action="refresh-games">${icon('refresh')} Try again</button></div>`;
    return;
  }
  if (!g.list.length) {
    grid.innerHTML = `<div class="games-state"><strong>No experiences found</strong><p>Try a broader search or return to popular experiences.</p><button class="btn sm" data-action="refresh-games">${icon('refresh')} Browse popular</button></div>`;
    return;
  }
  const list = visibleGames();
  if (!list.length) {
    grid.innerHTML = `<div class="games-state"><strong>No active matches</strong><p>Every result is currently empty. Show all experiences to keep browsing.</p><button class="btn sm" data-action="games-hide-empty">Show all experiences</button></div>`;
    return;
  }
  let tail = '';
  if (g.nextPageToken && g.query) tail = `<div class="games-end"><span class="spinner dark"></span> Scroll for more…</div>`;
  else if (g.query) tail = `<div class="games-end">End of results</div>`;
  grid.innerHTML = list.map(gameCard).join('') + tail;
}

async function gamesBrowse() {
  const g = state.games;
  const rid = ++g.requestId;
  g.loading = true; g.error = null; g.query = ''; g.list = []; g.nextPageToken = null;
  g.categories = []; g.category = 'All';
  if (state.view === 'games') { renderGamesCategories(); renderGamesGrid(); }
  const r = await call(() => api.games.browse());
  if (rid !== g.requestId) return; // a newer browse/search superseded this one
  g.loading = false; g.loaded = true;
  if (r && r.ok) { g.list = r.games; g.nextPageToken = r.nextPageToken; g.categories = r.categories || []; }
  else g.error = (r && r.error) || 'Games could not be loaded.';
  if (state.view === 'games') { renderGamesCategories(); renderGamesGrid(); }
}

async function doGamesSearch(query) {
  const g = state.games;
  const rid = ++g.requestId;
  g.query = (query || '').trim(); g.loading = true; g.error = null; g.list = []; g.nextPageToken = null;
  g.categories = []; g.category = 'All';
  if (state.view === 'games') { renderGamesCategories(); renderGamesGrid(); }
  const r = await call(() => (g.query ? api.games.search(g.query) : api.games.browse()));
  if (rid !== g.requestId) return; // a newer search superseded this one
  g.loading = false; g.loaded = true;
  if (r && r.ok) { g.list = r.games; g.nextPageToken = r.nextPageToken; g.categories = r.categories || []; }
  else g.error = (r && r.error) || 'Search failed.';
  if (state.view === 'games') { renderGamesCategories(); renderGamesGrid(); }
}

async function gamesLoadMore() {
  const g = state.games;
  if (g.loading || !g.nextPageToken || !g.query) return;
  g.loading = true;
  const rid = g.requestId;
  const r = await call(() => api.games.search(g.query, g.nextPageToken));
  g.loading = false;
  if (rid !== g.requestId) return; // superseded by a new search/browse
  if (r && r.ok) { g.list = g.list.concat(r.games); g.nextPageToken = r.nextPageToken; if (state.view === 'games') renderGamesGrid(); }
}

async function joinPlace(placeId, name) {
  if (!placeId) { toast('No place id for this game', 'bad'); return; }
  if (!state.accounts.length) { toast('Add an account to join games', 'bad'); setView('accounts'); return; }
  const ids = state.selected.size ? Array.from(state.selected) : [state.accounts[0].id];
  toast('Preparing ' + (name || 'game') + (ids.length > 1 ? ' for ' + ids.length + ' accounts' : '') + '…');
  const r = await call(() => api.launch.accounts(ids, String(placeId)));
  if (handlePreparedPlan(r)) return;
  if (r && r.ok) {
    toast(`Launched ${r.launched} client${r.launched === 1 ? '' : 's'}`, r.failed ? 'bad' : 'good');
    recordRecentGame(gameByPlaceId(placeId));
  } else toast((r && r.error) || 'Join failed', 'bad');
}

/* ----------------------------- People view ----------------------------- */
views.people = function () {
  if (state.people.route === 'friends') return renderFriendsPage();
  if (state.people.route === 'profile') return renderPeopleProfile();
  return renderPeopleHome();
};

function renderPeopleHome() {
  const pp = state.people;
  const search = pp.search;
  const onboarding = state.accounts.length ? '' : `
    <div class="banner warn" style="margin-bottom:14px"><svg class="b-ico"><use href="#i-user-plus"/></svg>
      <div class="b-text"><b>Add a Roblox account to unlock People</b><span>Search, friends, live presence and Join buttons all need a signed-in session - Roblox hides them from anonymous apps. Sign in once and everything here lights up.</span></div>
      <div class="b-actions"><button class="btn sm primary" data-action="goto-accounts">Add account</button></div>
    </div>`;
  mount(`
    <div class="page-head">
      <h1>People</h1>
      <p>Find Roblox users or browse friends shared across your saved accounts.</p>
    </div>
    ${onboarding}
    <div class="toolbar people-searchbar">
      <div class="search">${icon('search')}<input id="people-search" type="text" maxlength="50" placeholder="Username, display name, or user ID" value="${esc(search.query)}" aria-label="Search Roblox people"></div>
      <button class="btn" data-action="people-search-clear" ${search.searched || search.query ? '' : 'disabled'}>Clear</button>
      <button class="btn primary" data-action="people-search" ${search.loading ? 'disabled' : ''}>${search.loading ? '<span class="spinner"></span>' : icon('search')} Search</button>
    </div>
    <div class="section-title">Browse</div>
    <div class="card pad watch-card" id="watch-card" hidden></div>
    <button class="people-entry" data-action="open-friends">
      <span class="people-entry-icon">${icon('users-group')}</span>
      <span><strong>Friends</strong><small>${pp.loaded ? `${fmtNum(pp.total)} unique friend${pp.total === 1 ? '' : 's'}` : 'Across all saved accounts'}</small></span>
      ${icon('chevron-right')}
    </button>
    <div id="people-search-results" class="people-results"></div>
  `);
  const input = $('#people-search');
  if (input) {
    input.addEventListener('keydown', e => { if (e.key === 'Enter') runPeopleSearch(input.value); });
    input.focus();
  }
  renderPeopleSearchResults();
  renderWatchCard();
}

function personMatchesFilter(u) {
  const filter = state.people.filter || 'all';
  const status = String(u && u.presence || 'Offline').toLowerCase();
  if (filter === 'ingame') return status.includes('game');
  if (filter === 'online') return status === 'online' || status.includes('studio');
  if (filter === 'offline') return status === 'offline';
  return true;
}

/* Live roll-up of the friends on the loaded page: "2 in game · 1 online",
   patched in place by the presence poller so it never goes stale. */
function peoplePresenceCounts(list) {
  let ingame = 0, online = 0;
  for (const u of (list || [])) {
    const s = String(u && u.presence || '').toLowerCase();
    if (s.includes('game')) ingame += 1;
    else if (s === 'online' || s.includes('studio')) online += 1;
  }
  return { ingame, online, offline: Math.max(0, (list || []).length - ingame - online) };
}
function peopleCountsText(list) {
  const c = peoplePresenceCounts(list);
  return `${c.ingame} in game · ${c.online} online · ${c.offline} offline`;
}
function updatePeopleCounts() {
  const el = document.querySelector('[data-people-counts]');
  if (el) el.textContent = peopleCountsText(state.people.list);
}

function personPresenceRank(u) {
  const status = String(u && u.presence || 'Offline').toLowerCase();
  if (status.includes('game')) return 0;
  if (status === 'online' || status.includes('studio')) return 1;
  if (status === 'unknown') return 3;
  return 2;
}

function visiblePeople(list) {
  const q = normName(state.people.filterText || '');
  const out = (list || []).filter(personMatchesFilter).filter(u => {
    if (!q) return true;
    return normName(String(u && u.displayName || '')).includes(q)
      || normName(String(u && u.username || '')).includes(q);
  }).slice();
  if (state.people.sort === 'name') {
    out.sort((a, b) => String(a.displayName || a.username).localeCompare(String(b.displayName || b.username)));
  } else if (state.people.sort === 'status') {
    out.sort((a, b) => personPresenceRank(a) - personPresenceRank(b)
      || String(a.displayName || a.username).localeCompare(String(b.displayName || b.username)));
  }
  return out;
}

function peopleTools() {
  const filter = state.people.filter || 'all';
  const sort = state.people.sort || 'status';
  return `<div class="people-tools">
    <div class="segmented compact" aria-label="Filter people">
      <button data-action="people-filter" data-filter="all" class="${filter === 'all' ? 'on' : ''}">All</button>
      <button data-action="people-filter" data-filter="ingame" class="${filter === 'ingame' ? 'on' : ''}">In game</button>
      <button data-action="people-filter" data-filter="online" class="${filter === 'online' ? 'on' : ''}">Online</button>
      <button data-action="people-filter" data-filter="offline" class="${filter === 'offline' ? 'on' : ''}">Offline</button>
    </div>
    <div class="segmented compact" aria-label="Sort people">
      <button data-action="people-sort" data-sort="status" class="${sort === 'status' ? 'on' : ''}">Live first</button>
      <button data-action="people-sort" data-sort="name" class="${sort === 'name' ? 'on' : ''}">Name</button>
    </div>
  </div>`;
}

function personJoinButton(u, className) {
  if (!u || !u.canJoin) return '';
  const game = u.game || {};
  return `<button class="${className || 'btn primary sm'}" data-action="join-person" data-user="${esc(u.userId)}" data-place="${esc(game.placeId || u.placeId || '')}" data-game="${esc(game.gameId || u.gameId || '')}" data-name="${esc(u.displayName)}">${icon('play')} Plan join</button>`;
}

function personCardActions(u) {
  const watched = isWatched(u.userId);
  return `${personJoinButton(u)}
    <button class="btn sm icon watch${watched ? ' on' : ''}" data-action="watch-toggle" data-user="${esc(u.userId)}" data-name="${esc(u.displayName || u.username || '')}" data-tip="${watched ? 'Stop watching' : 'Watch for game activity'}">${icon('eye')}</button>
    <button class="btn sm icon" data-action="copy-user-id" data-user="${esc(u.userId)}" data-tip="Copy user ID">${icon('copy')}</button>
    <button class="btn sm" data-action="open-person" data-user="${esc(u.userId)}">View</button>`;
}

function personCard(u) {
  const presClass = presenceClass(u.presence);
  const avatar = u.avatar ? `<img class="avatar" loading="lazy" src="${esc(u.avatar)}" alt="">` : `<div class="avatar"></div>`;
  const gameLine = `<div class="acct-game" data-person-game="${esc(u.userId)}"${u.game && u.game.name ? '' : ' hidden'}>${u.game && u.game.name ? icon('compass') + ' ' + esc(u.game.name) : ''}</div>`;
  const sources = u.connectedAccounts && u.connectedAccounts.length
    ? `<div class="friend-source">Friend of ${esc(u.connectedAccounts.map(a => a.displayName).join(', '))}</div>` : '';
  return `<div class="person" data-person-card="${esc(u.userId)}">
    <div class="top">
      ${avatar}
      <div class="who">
        <div class="dname">${esc(u.displayName)} ${u.hasVerifiedBadge ? `<span class="verified" data-tip="Verified">${icon('check-circle')}</span>` : ''}</div>
        <div class="uname">@${esc(u.username)}</div>
      </div>
    </div>
    ${u.bio ? `<div class="person-bio">${esc(u.bio)}</div>` : ''}
    ${sources}
    <div class="row-split" style="margin-top:auto">
      <span class="presence ${presClass}" data-person-presence="${esc(u.userId)}"><span class="pd"></span>${esc(u.presence)}</span>
      <span class="inline" data-person-actions="${esc(u.userId)}">${personCardActions(u)}</span>
    </div>
    ${gameLine}
  </div>`;
}

function renderFriendsPage() {
  const pp = state.people;
  const start = pp.total ? pp.page * pp.pageSize + 1 : 0;
  const end = Math.min(pp.total, (pp.page + 1) * pp.pageSize);
  mount(`
    <button class="back-link" data-action="people-home">${icon('chevron-left')} Back to People</button>
    <div class="page-head compact">
      <h1>Friends</h1>
      <p>Public profiles from every saved account, merged without duplicates.</p>
    </div>
    <div class="row-split" style="margin-bottom:16px">
      <div class="section-title" style="margin:0">${pp.total ? `${start}-${end} of ${pp.total}` : 'Friends'}
        <span class="stat-cols" data-people-counts data-tip="Live presence of the friends on this page">${peopleCountsText(pp.list)}</span></div>
      <div class="inline">
        <div class="search" style="min-width:200px;max-width:240px">${icon('search')}<input id="people-filter" type="text" maxlength="50" placeholder="Filter this page…" value="${esc(pp.filterText || '')}"></div>
        <button class="btn sm" data-action="people-prev" ${pp.hasPrev ? '' : 'disabled'}>${icon('chevron-left')} Previous</button>
        <button class="btn sm" data-action="people-next" ${pp.hasNext ? '' : 'disabled'}>Next ${icon('chevron-right')}</button>
        <button class="btn sm" data-action="people-refresh" data-tip="Reload">${icon('refresh')}</button>
      </div>
    </div>
    ${peopleTools()}
    <div class="people-grid" id="people-grid"></div>
  `);
  const filterInp = $('#people-filter');
  if (filterInp) {
    filterInp.addEventListener('input', () => {
      state.people.filterText = filterInp.value;
      renderPeopleGrid();
    });
    filterInp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); filterInp.blur(); }
    });
  }
  if (!pp.loaded && !pp.loading) loadPeople(0);
  else renderPeopleGrid();
}

function renderPeopleGrid() {
  const grid = $('#people-grid');
  if (!grid) return;
  const pp = state.people;
  if (pp.loading) { grid.innerHTML = `<div class="games-end"><span class="spinner dark"></span> Loading people…</div>`; return; }
  if (pp.error) { grid.innerHTML = `<div class="games-end">${esc(pp.error)}</div>`; return; }
  if (!pp.list.length) { grid.innerHTML = `<div class="card"><div class="empty"><div class="e-ico">${icon('users-group')}</div><h3>No people to show</h3><p>Add an account with friends to populate this list.</p></div></div>`; return; }
  const list = visiblePeople(pp.list);
  grid.innerHTML = list.length
    ? list.map(personCard).join('')
    : `<div class="games-end">${pp.filterText ? `No one here matches “${esc(pp.filterText)}”.` : 'No one matches this filter.'}</div>`;
}

async function loadPeople(page) {
  const pp = state.people;
  const rid = ++pp.requestId;
  pp.loading = true; pp.error = null;
  if (state.view === 'people' && pp.route === 'friends') renderPeopleGrid();
  const r = await call(() => api.people.list(page, pp.pageSize, false));
  if (rid !== pp.requestId) return; // a newer page load superseded this one
  pp.loading = false; pp.loaded = true;
  if (r && r.ok) {
    pp.list = r.people; pp.page = r.page; pp.total = r.total; pp.hasNext = r.hasNext; pp.hasPrev = r.hasPrev;
  } else {
    pp.list = []; pp.error = (r && r.error) || 'People could not be loaded.';
  }
  if (state.view === 'people' && pp.route === 'friends') views.people();
}

async function refreshPeople() {
  const pp = state.people;
  const rid = ++pp.requestId;
  pp.loading = true; pp.error = null;
  renderPeopleGrid();
  const r = await call(() => api.people.list(pp.page, pp.pageSize, true));
  if (rid !== pp.requestId) return; // a newer load superseded this refresh
  pp.loading = false; pp.loaded = true;
  if (r && r.ok) {
    pp.list = r.people; pp.page = r.page; pp.total = r.total; pp.hasNext = r.hasNext; pp.hasPrev = r.hasPrev;
  } else pp.error = (r && r.error) || 'Friends could not be loaded.';
  if (state.view === 'people' && pp.route === 'friends') views.people();
}

function renderPeopleSearchResults() {
  const root = $('#people-search-results');
  if (!root) return;
  const search = state.people.search;
  if (search.loading) {
    root.innerHTML = `<div class="people-search-state"><span class="spinner dark"></span><div><strong>Searching Roblox</strong><small>Checking matching public profiles...</small></div></div>`;
    return;
  }
  if (search.error) {
    root.innerHTML = `<div class="people-search-state error">${icon('alert-circle')}<div><strong>Search paused</strong><small>${esc(search.error)}</small></div>
      ${search.retryable ? `<button class="btn sm" data-action="people-search-retry">${icon('refresh')} Retry</button>` : ''}</div>`;
    return;
  }
  if (!search.searched) { root.innerHTML = ''; return; }
  const notice = search.notice
    ? `<div class="people-search-notice ${search.source === 'friends' ? 'warn' : ''}">${icon(search.source === 'friends' ? 'alert-circle' : 'check-circle')}<span>${esc(search.notice)}${search.cached ? ' (cached)' : ''}</span></div>`
    : '';
  root.innerHTML = `
    ${notice}
    <div class="people-result-head"><div class="section-title">Results for -${esc(search.query)}-</div><span>${search.list.length} shown</span></div>
    ${search.list.length ? peopleTools() : ''}
    <div class="people-grid">${visiblePeople(search.list).length ? visiblePeople(search.list).map(personCard).join('') : `<div class="games-end">${search.list.length ? 'No one matches this filter.' : 'No people found.'}</div>`}</div>
    ${search.nextPageCursor ? `<button class="btn people-more" data-action="people-search-more">Show more</button>` : ''}`;
}

function setPeopleSearchBusy(busy) {
  const button = document.querySelector('[data-action="people-search"]');
  if (button) button.disabled = !!busy;
}

function clearPeopleSearch() {
  const requestId = state.people.search.requestId + 1;
  state.people.search = {
    query: '', list: [], nextPageCursor: null, loading: false, error: null,
    searched: false, requestId, notice: null, source: null, cached: false, retryable: false,
  };
  if (state.view === 'people' && state.people.route === 'home') renderPeopleHome();
}

async function runPeopleSearch(query, append) {
  const search = state.people.search;
  if (search.loading) return;
  const q = String(query == null ? search.query : query).trim();
  if (q.length < 2) { search.error = 'Type at least 2 characters.'; search.searched = true; renderPeopleSearchResults(); return; }
  if (!append) { search.query = q; search.list = []; search.nextPageCursor = null; }
  const requestId = ++search.requestId;
  search.loading = true; search.error = null; search.searched = true; search.notice = null;
  search.source = null; search.cached = false; search.retryable = false;
  setPeopleSearchBusy(true);
  renderPeopleSearchResults();
  const r = await call(() => api.people.search(search.query, append ? search.nextPageCursor : null));
  if (requestId !== search.requestId) return;
  search.loading = false;
  setPeopleSearchBusy(false);
  if (r && r.ok) {
    search.list = append ? search.list.concat(r.people || []) : (r.people || []);
    search.nextPageCursor = r.nextPageCursor || null;
    search.notice = r.notice || null;
    search.source = r.source || 'keyword';
    search.cached = !!r.cached;
  } else {
    search.error = (r && r.error) || 'Search failed.';
    search.retryable = !!(r && r.retryable);
  }
  if (state.view === 'people' && state.people.route === 'home') renderPeopleSearchResults();
}

let peoplePresenceBusy = false;
function mergePresence(user, fresh) {
  if (!user || !fresh) return user;
  return Object.assign({}, user, fresh, {
    placeId: fresh.game && fresh.game.placeId || null,
    gameId: fresh.game && fresh.game.gameId || null,
  });
}

function presenceChanged(before, after) {
  const a = before && before.game || {};
  const b = after && after.game || {};
  return String(before && before.presence || '') !== String(after && after.presence || '')
    || !!(before && before.canJoin) !== !!(after && after.canJoin)
    || String(a.name || '') !== String(b.name || '')
    || String(a.placeId || '') !== String(b.placeId || '')
    || String(a.gameId || '') !== String(b.gameId || '');
}

function profileHeroActions(u) {
  const watched = isWatched(u.userId);
  return `${personJoinButton(u, 'btn primary')}
    <button class="btn${watched ? ' on' : ''}" data-action="watch-toggle" data-user="${esc(u.userId)}" data-name="${esc(u.displayName || u.username || '')}">${icon('eye')} ${watched ? 'Watching' : 'Watch'}</button>
    <button class="btn" data-action="ext-link" data-url="${esc(u.profileUrl || `https://www.roblox.com/users/${u.userId}/profile`)}">Open on Roblox</button>`;
}

function profileLivePanel(u) {
  if (!u || !u.game) return '';
  return `<div class="now-playing${u.canJoin ? ' joinable' : ''}">${icon('compass')}
    <span><strong>${esc(u.game.name)}</strong><small>${u.canJoin ? 'Playing now — access is verified on join' : 'Currently playing'}</small></span>
    ${personJoinButton(u)}</div>`;
}

function patchPersonPresence(user) {
  if (!user || !user.userId) return;
  const id = String(user.userId);
  findAllByData(document, 'person-presence', id).forEach(el => {
    el.className = 'presence ' + presenceClass(user.presence);
    el.innerHTML = `<span class="pd"></span>${esc(user.presence || 'Offline')}`;
  });
  findAllByData(document, 'person-game', id).forEach(el => {
    if (user.game && user.game.name) {
      el.hidden = false;
      el.innerHTML = icon('compass') + ' ' + esc(user.game.name);
    } else {
      el.hidden = true;
      el.innerHTML = '';
    }
  });
  findAllByData(document, 'person-actions', id).forEach(el => {
    el.innerHTML = personCardActions(user);
  });
  findAllByData(document, 'person-card', id).forEach(el => {
    el.hidden = !personMatchesFilter(user);
  });
  const profileActions = findByData(document, 'profile-actions', id);
  if (profileActions) profileActions.innerHTML = profileHeroActions(user);
  const live = findByData(document, 'profile-live', id);
  if (live) live.innerHTML = profileLivePanel(user);
}

/** Poll visible users, then patch only cards whose live state actually changed. */
async function refreshVisiblePeoplePresence() {
  if (!api || document.hidden || peoplePresenceBusy || state.view !== 'people') return;
  const pp = state.people;
  let users = [];
  if (pp.route === 'home' && pp.search.searched) users = pp.search.list;
  else if (pp.route === 'friends') users = pp.list;
  else if (pp.route === 'profile' && pp.detail.profile) users = [pp.detail.profile];
  const ids = Array.from(new Set(users.map(u => Number(u && u.userId)).filter(Boolean)));
  if (!ids.length) return;
  peoplePresenceBusy = true;
  const r = await call(() => api.people.presence(ids), null, 12000);
  peoplePresenceBusy = false;
  if (!r || !r.ok || !Array.isArray(r.people)) return;
  const byId = new Map(r.people.map(item => [Number(item.userId), item]));
  if (pp.route === 'home') {
    pp.search.list = pp.search.list.map(user => {
      const next = mergePresence(user, byId.get(Number(user.userId)));
      if (presenceChanged(user, next)) patchPersonPresence(next);
      return next;
    });
  } else if (pp.route === 'friends') {
    pp.list = pp.list.map(user => {
      const next = mergePresence(user, byId.get(Number(user.userId)));
      if (presenceChanged(user, next)) patchPersonPresence(next);
      return next;
    });
    updatePeopleCounts();
  } else if (pp.route === 'profile' && pp.detail.profile) {
    const previous = pp.detail.profile;
    const next = mergePresence(previous, byId.get(Number(previous.userId)));
    pp.detail.profile = next;
    if (presenceChanged(previous, next)) patchPersonPresence(next);
  }
}

function peopleStat(label, value) {
  return `<div class="profile-stat"><strong>${fmtNum(value)}</strong><span>${esc(label)}</span></div>`;
}

function profileListSection(title, items, emptyText, renderItem) {
  return `<section class="profile-section"><h2>${esc(title)} <span>${items.length}</span></h2>
    ${items.length ? `<div class="profile-list">${items.map(renderItem).join('')}</div>` : `<p class="profile-empty">${esc(emptyText)}</p>`}</section>`;
}

function profileGameSection(title, games) {
  return profileListSection(title, games, 'Nothing to show.', game => `
    <div class="profile-game">
      ${game.thumbnail ? `<img src="${esc(game.thumbnail)}" loading="lazy" alt="">` : `<span class="profile-game-ph">${icon('compass')}</span>`}
      <span><strong>${esc(game.name)}</strong><small>${game.visits ? `${fmtNum(game.visits)} visits` : 'Public experience'}</small></span>
      ${game.rootPlaceId ? `<button class="btn sm" data-action="join-game" data-place="${esc(game.rootPlaceId)}" data-name="${esc(game.name)}">${icon('play')} Plan join</button>` : ''}
    </div>`);
}

function accountAge(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 1) return 'today';
  const years = Math.floor(days / 365);
  if (years >= 1) { const mo = Math.floor((days - years * 365) / 30); return years + ' yr' + (years === 1 ? '' : 's') + (mo ? ` ${mo} mo` : ''); }
  const months = Math.floor(days / 30);
  if (months >= 1) return months + ' month' + (months === 1 ? '' : 's');
  return days + ' day' + (days === 1 ? '' : 's');
}

function renderPeopleProfile() {
  const detail = state.people.detail;
  const backLabel = state.people.returnRoute === 'friends' ? 'Back to Friends' : 'Back to People';
  if (detail.loading) {
    mount(`<button class="back-link" data-action="people-back">${icon('chevron-left')} ${backLabel}</button><div class="profile-loading"><span class="spinner dark"></span> Loading public profile…</div>`);
    return;
  }
  if (detail.error || !detail.profile) {
    mount(`<button class="back-link" data-action="people-back">${icon('chevron-left')} ${backLabel}</button><div class="card"><div class="empty"><div class="e-ico">${icon('alert-circle')}</div><h3>Profile unavailable</h3><p>${esc(detail.error || 'This profile could not be loaded.')}</p></div></div>`);
    return;
  }
  const u = detail.profile;
  const counts = u.counts || {};
  const presClass = presenceClass(u.presence);
  const created = u.created ? new Date(u.created).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }) : 'Unknown';
  const source = u.connectedAccounts && u.connectedAccounts.length ? `Friend of ${u.connectedAccounts.map(a => a.displayName).join(', ')}` : 'Public Roblox profile';
  const groups = u.groups || [], badges = u.robloxBadges || [], assets = u.avatarDetails && u.avatarDetails.assets || [];
  const collectibles = u.inventory && u.inventory.collectibles || [];
  mount(`
    <button class="back-link" data-action="people-back">${icon('chevron-left')} ${backLabel}</button>
    <div class="profile-hero">
      <div class="profile-identity">
        ${u.avatar ? `<img src="${esc(u.avatar)}" alt="">` : `<span class="profile-avatar-ph">${icon('users-group')}</span>`}
        <div><h1>${esc(u.displayName)} ${u.hasVerifiedBadge ? `<span class="verified">${icon('check-circle')}</span>` : ''}</h1><p>@${esc(u.username)}</p>
          <span class="presence ${presClass}" data-person-presence="${esc(u.userId)}"><span class="pd"></span>${esc(u.presence)}</span></div>
      </div>
      <div class="inline" data-profile-actions="${esc(u.userId)}">${profileHeroActions(u)}</div>
    </div>
    <div class="profile-stats">${peopleStat('Friends', counts.friends)}${peopleStat('Followers', counts.followers)}${peopleStat('Following', counts.following)}</div>
    <div class="profile-layout">
      <div class="profile-main">
        <section class="profile-section"><h2>About</h2><p class="profile-bio">${esc(u.bio || 'No description provided.')}</p>
          <div class="profile-facts"><span><strong>Joined</strong>${esc(created)}${accountAge(u.created) ? ` - ${esc(accountAge(u.created))} old` : ''}</span><span><strong>User ID</strong>${esc(u.userId)}</span><span><strong>Connection</strong>${esc(source)}</span><span><strong>Account</strong>${u.isBanned ? 'Banned' : 'Active'}</span></div>
          <div data-profile-live="${esc(u.userId)}">${profileLivePanel(u)}</div>
        </section>
        ${profileGameSection('Created experiences', u.createdGames || [])}
        ${profileGameSection('Favorite experiences', u.favoriteGames || [])}
        ${profileListSection('Groups', groups, 'No public groups.', group => `<div class="profile-row"><span>${icon('users-group')}</span><div><strong>${esc(group.name)}</strong><small>${esc(group.role || 'Member')}${group.memberCount ? ` - ${fmtNum(group.memberCount)} members` : ''}</small></div></div>`)}
        ${profileListSection('Roblox badges', badges, 'No Roblox badges.', badge => `<div class="profile-row"><span>${icon('check-circle')}</span><div><strong>${esc(badge.name)}</strong><small>${esc(badge.description || 'Roblox badge')}</small></div></div>`)}
      </div>
      <aside class="profile-side">
        <section class="profile-section avatar-preview"><h2>Avatar</h2>${u.fullBodyAvatar ? `<img src="${esc(u.fullBodyAvatar)}" alt="Full avatar">` : '<p class="profile-empty">Avatar unavailable.</p>'}
          ${u.avatarDetails ? `<p>${esc(u.avatarDetails.avatarType || 'Avatar')} · ${assets.length} equipped asset${assets.length === 1 ? '' : 's'}</p>` : ''}</section>
        ${profileListSection('Currently wearing', assets, 'Outfit details unavailable.', asset => `<div class="asset-row"><strong>${esc(asset.name)}</strong><small>${esc(asset.assetType || 'Asset')} - #${esc(asset.id)}</small></div>`)}
        ${profileListSection('Previous usernames', u.previousUsernames || [], 'No previous usernames.', name => `<div class="asset-row"><strong>@${esc(name)}</strong></div>`)}
        ${profileListSection('Public collectibles', collectibles, u.inventory && u.inventory.canView ? 'No collectibles returned.' : 'Inventory is private.', item => `<div class="asset-row"><strong>${esc(item.name)}</strong><small>${esc(item.assetType || 'Collectible')}${item.recentAveragePrice ? ` - ${fmtNum(item.recentAveragePrice)} recent value` : ''}</small></div>`)}
      </aside>
    </div>`);
}

async function openPerson(userId) {
  const id = Number(userId);
  if (!id) return;
  state.people.returnRoute = state.people.route === 'friends' ? 'friends' : 'home';
  state.people.route = 'profile';
  state.people.detail = { userId: id, profile: null, loading: true, error: null };
  views.people();
  const r = await call(() => api.people.profile(id));
  if (state.people.detail.userId !== id) return;
  state.people.detail.loading = false;
  if (r && r.ok) state.people.detail.profile = r.profile;
  else state.people.detail.error = (r && r.error) || 'This profile could not be loaded.';
  if (state.view === 'people' && state.people.route === 'profile') views.people();
}

/* ----------------------------- History view ----------------------------- */
/* ----------------------------- Stats view ----------------------------- */
function fmtDur(ms) {
  if (!ms || ms < 1000) return '0m';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '<1m';
  const h = Math.floor(m / 60);
  if (!h) return `${m}m`;
  const d = Math.floor(h / 24);
  if (!d) return `${h}h ${m % 60}m`;
  return `${d}d ${h % 24}h`;
}

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function hourLabel(h) {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

/* The 14-day activity chart: one column per day, height proportional to
   that day's playtime, today accented. Pure divs on the existing grid.
   Days with no playtime keep a 2px baseline stub so the week never reads
   as a gap in the axis. */
function activityChartHtml(daily) {
  const max = Math.max.apply(null, daily.map(d => d.ms));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const bars = daily.map(d => {
    const date = new Date(d.start);
    const isToday = d.start === today.getTime();
    const pct = max > 0 && d.ms > 0 ? Math.max(4, Math.round((d.ms / max) * 100)) : 0;
    const h = d.ms > 0 ? pct + '%' : '2px';
    const tip = `${DOW_SHORT[date.getDay()]} ${date.getMonth() + 1}/${date.getDate()} — ${d.ms > 0 ? fmtDur(d.ms) : 'no playtime'}`;
    return `<div class="act-col"><div class="act-bar${isToday ? ' now' : ''}" style="height:${h}" data-tip="${esc(tip)}"></div></div>`;
  }).join('');
  const labels = daily.map(d => {
    const date = new Date(d.start);
    return `<span>${DOW_SHORT[date.getDay()].slice(0, 1)}${date.getDate()}</span>`;
  }).join('');
  return `<div class="act-chart"><div class="act-bars">${bars}</div><div class="act-labels">${labels}</div></div>`;
}

function insightsLineHtml(ins) {
  if (!ins) return '';
  const parts = [];
  if (ins.peakHour != null) parts.push(`Peak hour <b>${esc(hourLabel(ins.peakHour))}</b>`);
  if (ins.busiestDayStart) {
    const d = new Date(ins.busiestDayStart);
    parts.push(`Busiest day <b>${DOW_SHORT[d.getDay()]}</b> — ${fmtDur(ins.busiestDayMs)}`);
  }
  return parts.length ? `<div class="act-foot">${parts.join('<i>·</i>')}</div>` : '';
}

views.stats = async function () {
  mount(`
    <div class="page-head"><h1>Stats</h1><p>Playtime per game and account, tracked locally from live presence.</p></div>
    <div id="stats-body"><div class="games-end"><span class="spinner dark"></span> Crunching playtime…</div></div>
  `);
  const r = await call(() => api.playtime.stats(), { ok: false });
  const root = $('#stats-body');
  if (!root || state.view !== 'stats') return;
  if (!r || !r.ok) {
    root.innerHTML = `<div class="games-state" role="alert"><strong>Stats could not load</strong><p>Your saved playtime was not changed.</p><button class="btn sm" data-action="stats-refresh">${icon('refresh')} Try again</button></div>`;
    return;
  }
  const t = r.totals || {};
  const ins = r.insights || {};
  const statCell = (label, value, sub) => `<div class="stat-cell"><div class="stat-value">${value}</div><div class="stat-label">${esc(label)}</div>${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}</div>`;
  const yesterdayMs = (r.daily || []).length >= 2 ? r.daily[r.daily.length - 2].ms : 0;
  const maxTotal = (r.perGame || []).reduce((m, g) => Math.max(m, g.totalMs), 0);
  const row = (cells, live, meterPct) => `<div class="setting stat-row"><div><div class="s-label">${live ? '<span class="pd live-dot"></span>' : ''}${esc(cells.name)}</div><div class="s-desc">${esc(cells.desc)}</div>${meterPct != null ? `<div class="stat-meter"><i style="width:${meterPct}%"></i></div>` : ''}</div>
    <div class="s-control stat-cells"><span data-tip="Today">${fmtDur(cells.today)}</span><span data-tip="Last 7 days">${fmtDur(cells.week)}</span><b data-tip="All time">${fmtDur(cells.total)}</b></div></div>`;
  const games = (r.perGame || []).slice(0, 15).map(g => row({ name: g.label, desc: `${g.sessions} session${g.sessions === 1 ? '' : 's'}`, today: g.todayMs, week: g.weekMs, total: g.totalMs }, g.live, maxTotal > 0 ? Math.max(3, Math.round((g.totalMs / maxTotal) * 100)) : null)).join('');
  const accountsRows = (r.perAccount || []).map(a => row({ name: a.label, desc: `${a.sessions} session${a.sessions === 1 ? '' : 's'}`, today: a.todayMs, week: a.weekMs, total: a.totalMs }, a.live)).join('');
  const recent = (r.recent || []).map(s => `<div class="setting stat-row"><div><div class="s-label">${s.live ? '<span class="pd live-dot"></span>' : ''}${esc(s.game)}</div>
    <div class="s-desc">${esc(s.username)} - ${new Date(s.start).toLocaleString()}</div></div><div class="s-control"><b>${fmtDur(s.ms)}</b></div></div>`).join('');
  const hasAny = (r.perGame || []).length || recent.length;
  root.innerHTML = `
    <div class="card stat-grid">
      ${statCell('Today', fmtDur(t.todayMs), yesterdayMs ? `yesterday ${fmtDur(yesterdayMs)}` : 'no playtime yesterday')}
      ${statCell('Last 7 days', fmtDur(t.weekMs), `avg ${fmtDur(Math.round((t.weekMs || 0) / 7))} / day`)}
      ${statCell('All time', fmtDur(t.totalMs), `${t.sessions || 0} sessions`)}
      ${statCell('Tracking now', String(r.tracking || 0), r.tracking ? 'accounts in game' : 'no one in game')}
      ${ins.avgMs ? statCell('Avg session', fmtDur(ins.avgMs), `${t.sessions || 0} tracked`) : ''}
      ${ins.longestMs ? statCell('Longest session', fmtDur(ins.longestMs), ins.longestGame ? ins.longestGame.slice(0, 28) : '') : ''}
    </div>
    ${hasAny && (r.daily || []).length ? `<div class="section-title">Last 14 days <span class="stat-cols">playtime per day<i class="act-key"></i>today</span></div>
      <div class="card">${activityChartHtml(r.daily)}${insightsLineHtml(ins)}</div>` : ''}
    ${games ? `<div class="section-title">By game <span class="stat-cols">today - 7 days - all time</span></div><div class="card pad">${games}</div>` : ''}
    ${accountsRows ? `<div class="section-title">By account <span class="stat-cols">today - 7 days - all time</span></div><div class="card pad">${accountsRows}</div>` : ''}
    ${recent ? `<div class="section-title">Recent sessions</span><div class="card pad">${recent}</div>` : ''}
    ${!hasAny ? `<div class="games-state"><strong>No playtime yet</strong><p>Stats build automatically while your accounts play.</p><button class="btn sm primary" data-action="goto-launch">${icon('play')} Go to Launch</button></div>` : ''}
    <div class="inline" style="margin-top:16px"><div class="spacer" style="flex:1"></div>
      <button class="btn sm" data-action="stats-refresh">${icon('refresh')} Refresh</button>
      <button class="btn sm ghost danger" data-action="stats-clear">${icon('trash')} Clear playtime data</button></div>`;
};

views.history = async function () {
  const r = await call(() => api.history.get(), { history: [] });
  if (state.view !== 'history') return; // user navigated away while loading
  state.history = (r && r.history) || [];
  const rows = state.history.length ? state.history.map(h => `
    <tr>
      <td>${esc(fmtTime(h.time))}</td>
      <td>${esc(h.profileName)}</td>
      <td><span class="pill ${esc(h.result)}">${esc(h.result)}</span></td>
      <td class="mono">${h.pid || '-'}</td>
      <td>${esc(h.message || '')}</td>
    </tr>`).join('')
    : `<tr><td colspan="5"><div class="empty" style="padding:40px"><div class="e-ico">${icon('clock')}</div><h3>No launches yet</h3><p>Your launch history will appear here.</p><button class="btn sm" data-action="goto-launch">${icon('play')} Go to Launch</button></div></td></tr>`;

  mount(`
    <div class="page-head"><h1>History</h1><p>Every launch, restart and its result.</p></div>
    <div class="row-split" style="margin-bottom:14px">
      <div class="section-title" style="margin:0">Recent activity</div>
      <button class="btn sm ghost danger" data-action="clear-history" ${state.history.length ? '' : 'disabled'}>${icon('trash')} Clear history</button>
    </div>
    <div class="card" style="overflow:hidden">
      <table class="data"><thead><tr><th>Time</th><th>Account / mode</th><th>Result</th><th>PID</th><th>Message</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>
  `);
};

/* ----------------------------- Diagnostics view ----------------------------- */
views.diagnostics = async function () {
  const d = await call(() => api.diag(), { diagnostics: {} });
  if (state.view !== 'diagnostics') return; // user navigated away while loading
  state.diag = (d && d.diagnostics) || {};
  const g = state.diag;
  const kv = (k, v) => `<div class="k">${esc(k)}</div><div class="v">${esc(v == null ? '-' : v)}</div>`;
  mount(`
    <div class="page-head page-head-actions"><div><h1>Diagnostics</h1><p>Runtime truth, environment details, and the live troubleshooting log.</p></div><div class="inline"><button class="btn sm" data-action="copy-diag">${icon('copy')} Copy diagnostics</button><button class="btn sm" data-action="open-userdata">${icon('folder')} Open data folder</button></div></div>
    <div class="diag-overview" aria-label="Runtime summary">
      <div><span>Launch mode</span><b>${esc(g.isolationState || 'Unavailable')}</b></div>
      <div><span>Adapter</span><b>${esc(g.selectedAdapter || 'Unavailable')}</b></div>
      <div><span>Roblox</span><b>${g.robloxFound ? 'Detected' : 'Not found'}</b></div>
      <div><span>Native helper</span><b>${g.ffiAvailable ? 'Available' : 'Unavailable'}</b></div>
    </div>
    <div class="diag-layout">
      <section class="diag-section"><h2>System</h2><div class="kv">
        ${kv('SUNDAY Launcher version', g.appVersion)}${kv('Host runtime', 'Tauri')}${kv('Node / V8', (g.node || '?') + ' / ' + (g.v8 || '?'))}${kv('OS', (g.osType || '') + ' ' + (g.osRelease || '') + ' (' + (g.arch || '') + ')')}${kv('CPU', g.cpu)}${kv('Memory', (g.totalMemGB || '?') + ' GB')}
      </div></section>
      <section class="diag-section"><h2>Launch capability</h2><div class="kv">
        ${kv('Multi-instance', g.multiInstance)}${kv('LEGACY_COMPAT process value', g.legacyCompatEnvironmentValue)}${kv('legacyCompatEnabled', g.legacyCompatEnabled)}${kv('selectedAdapter', g.selectedAdapter)}${kv('isolationState', g.isolationState)}${kv('isolation reason', g.isolationReason)}${kv('Guard', g.guard)}
      </div></section>
      <section class="diag-section diag-wide"><h2>Paths and data</h2><div class="kv">
        ${kv('Roblox', g.robloxFound ? (g.robloxVersion + ' via ' + g.robloxSource) : 'not found')}${kv('Roblox path', g.robloxPath)}${kv('Data folder', g.userData)}${kv('Log file', g.logFile)}
      </div><details class="diag-technical"><summary>Technical plan state</summary><div class="a">A blocked plan is blocked; prepare again to evaluate the current legacy adapter.</div></details></section>
    </div>
    <div class="row-split diag-log-head">
      <div><h2>Live log</h2><p>Newest runtime events from this SUNDAY process.</p></div>
      <div class="inline">
        <div class="segmented" id="log-filter">
          ${['all', 'info', 'warn', 'error'].map(f => `<button data-action="log-filter" data-f="${f}" class="${state.logFilter === f ? 'on' : ''}">${f[0].toUpperCase() + f.slice(1)}</button>`).join('')}
        </div>
        <button class="btn sm" data-action="logs-folder">${icon('folder')} Folder</button>
        <button class="btn sm ghost danger" data-action="logs-clear">${icon('trash')} Clear</button>
      </div>
    </div>
    <div class="logview" id="logview"></div>
  `);
  const lr = await call(() => api.logs.get(400), { entries: [] });
  if (state.view !== 'diagnostics') return; // user navigated away while loading
  state.logs = (lr && lr.entries) || [];
  renderLogs();
};
function renderLogs() {
  const view = $('#logview');
  if (!view) return;
  const f = state.logFilter;
  const items = state.logs.filter(e => f === 'all' || e.level === f);
  view.innerHTML = items.map(e => `
    <div class="logline ${esc(e.level)}">
      <span class="t">${esc((e.time || '').slice(11))}</span>
      <span class="lv">${esc(e.level.toUpperCase())}</span>
      <span class="m">${esc(e.message)}${e.detail ? ' <small>' + esc(e.detail) + '</small>' : ''}</span>
    </div>`).join('') || `<div class="logline"><span></span><span></span><span class="m" style="color:var(--ink-3)">No log entries.</span></div>`;
  view.scrollTop = view.scrollHeight;
}

/* ----------------------------- Settings view ----------------------------- */
views.settings = async function () {
  if (!state.settings) {
    const r = await call(() => api.settings.get(), { settings: null });
    if (state.view !== 'settings') return; // user navigated away while loading
    state.settings = (r && r.settings) || {};
  }
  const s = state.settings;
  const st = state.status || {};
  if (!state.updater) {
    const up = await call(() => api.updater.status(), { state: 'disabled' });
    if (state.view !== 'settings') return; // user navigated away while loading
    state.updater = up && up.state ? up : { state: 'disabled' };
  }
  const up = state.updater || { state: 'disabled' };
  const updateText = updaterStatusText(up, st.appVersion);
  const busy = up.state === 'checking' || up.state === 'downloading' || up.state === 'staging' || up.state === 'applying' || up.state === 'restarting';
  const updaterEnabled = capabilityAvailable('updaterApply');
  const updateActions = !updaterEnabled
    ? `<button class="btn" disabled>Automatic updates unavailable</button>`
    : up.state === 'ready' || up.state === 'available'
    ? `<button class="btn primary" data-action="update-install">${icon('refresh')} Install update</button>`
    : up.state === 'error'
      ? `<div class="inline" style="flex-direction:column; align-items:flex-end; gap:8px">
          <button class="btn" data-action="update-check">${icon('refresh')} Retry</button>
          <button class="btn" data-action="update-open-web" data-tip="Download the installer with your browser instead">${icon('download')} Download in browser</button>
        </div>`
      : `<button class="btn" data-action="update-check" ${busy ? 'disabled' : ''}>${icon('refresh')} Check now</button>`;
  const auto = s.autoDetect !== false;
  mount(`
    <div class="page-head"><h1>Settings</h1><p>Shape how SUNDAY behaves on this PC. Changes are saved to your user profile.</p></div>
    <div class="settings-layout">
      <nav class="settings-index" aria-label="Settings sections">
        <a href="#settings-appearance">Appearance</a>
        <a href="#settings-roblox">Roblox location</a>
        <a href="#settings-behaviour">Behaviour</a>
        <a href="#settings-advanced">Advanced</a>
        <a href="#settings-updates">Updates</a>
      </nav>
      <div class="settings-content">
        <section class="settings-group" id="settings-appearance"><div class="settings-group-head"><h2>Appearance</h2><p>Choose how SUNDAY looks on this PC.</p></div><div class="settings-sheet">
          ${settingRow('Theme', 'Eclipse is the default. Choose Dawn or follow Windows when you want a different surface.',
            `<div class="segmented compact" id="set-theme">
              <button type="button" data-action="set-theme" data-theme="system" class="${themePref() === 'system' ? 'on' : ''}">System</button>
              <button type="button" data-action="set-theme" data-theme="light" class="${themePref() === 'light' ? 'on' : ''}">Dawn</button>
              <button type="button" data-action="set-theme" data-theme="dark" class="${themePref() === 'dark' ? 'on' : ''}">Eclipse</button>
            </div>`)}
        </div></section>

        <section class="settings-group" id="settings-roblox"><div class="settings-group-head"><h2>Roblox location</h2><p>Control how the installed player is detected.</p></div><div class="settings-sheet settings-fields">
          <div class="field">
            <label>Detection</label>
            <div class="segmented" id="set-detect" data-auto="${auto}">
              <button type="button" data-action="set-detect" data-auto="true" class="${auto ? 'on' : ''}">Auto-detect</button>
              <button type="button" data-action="set-detect" data-auto="false" class="${auto ? '' : 'on'}">Manual path</button>
            </div>
            <div class="hint">Auto-detect checks the registry and your Roblox install folder.</div>
          </div>
          <div class="field" id="set-path-row" style="${auto ? 'display:none' : ''}">
            <label for="set-path">RobloxPlayerBeta.exe path</label>
            <div class="inline"><input id="set-path" type="text" value="${esc(s.robloxPath || '')}" placeholder="Path to RobloxPlayerBeta.exe" /><button class="btn" data-action="settings-browse">${icon('folder')} Browse</button></div>
          </div>
          <div class="field" style="margin-bottom:0">
            <label>Currently detected</label>
            <div class="inline"><input type="text" readonly value="${esc(st.playerPath || 'Not found')}" /><button class="btn" data-action="redetect" data-tip="Run detection again">${icon('refresh')} Re-detect</button></div>
          </div>
        </div></section>

        <section class="settings-group" id="settings-behaviour"><div class="settings-group-head"><h2>Behaviour</h2><p>Set refresh, confirmation, and local history preferences.</p></div><div class="settings-sheet">
          ${settingRow('Confirm before bulk actions', 'Ask before “End all” and “Cleanup”.', `<label class="toggle"><input type="checkbox" id="set-confirm" ${s.confirmCleanup ? 'checked' : ''}><span class="track"></span></label>`)}
          ${settingRow('Refresh interval', 'How often the active-client list updates (750-10000 ms).', `<input id="set-poll" type="number" min="750" max="10000" step="250" value="${s.pollIntervalMs}" style="width:120px">`)}
          ${settingRow('History entries to keep', 'Maximum launch-history rows stored (10-2000).', `<input id="set-historylimit" type="number" min="10" max="2000" step="10" value="${s.historyLimit}" style="width:120px">`)}
        </div></section>

        <details class="settings-advanced" id="settings-advanced"><summary><span><b>Advanced runtime controls</b><small>Currently unavailable until their runtime paths are qualified.</small></span></summary><div class="settings-sheet">
          ${settingRow('Delay between launches', 'Pause between clients in a multi-launch.', `<input id="set-delay" type="number" min="0" max="20000" step="500" value="${s.launchDelayMs}" style="width:120px" disabled>`)}
          ${settingRow('Warn above this many instances', 'Warn when a launch would exceed this many clients.', `<input id="set-warn" type="number" min="1" max="100" value="${s.warnInstanceCount}" style="width:120px" disabled>`)}
          ${settingRow('Auto-rejoin delay', 'Wait before a dropped account is rejoined.', `<input id="set-rejoin-delay" type="number" min="3" max="300" step="1" value="${s.autoRejoinDelaySec}" style="width:120px" disabled>`)}
          ${settingRow('Give up after', 'Failed rejoin attempts before SUNDAY stops retrying.', `<input id="set-rejoin-tries" type="number" min="1" max="20" step="1" value="${s.autoRejoinMaxAttempts}" style="width:120px" disabled>`)}
          ${settingRow('Restart a stuck client after', '0 disables automatic restart.', `<input id="set-hung" type="number" min="0" max="120" step="5" value="${s.autoRestartHungSec}" style="width:120px" disabled>`)}
        </div></details>

        <section class="settings-group" id="settings-updates"><div class="settings-group-head"><h2>Updates</h2><p>Read current update capability and recovery options.</p></div><div class="settings-sheet">
          ${settingRow('Automatic updates', updateText, updateActions, 'update-status-line')}
          <div class="settings-note">Automatic application stays unavailable until signing, staging, health checks, and rollback are qualified.</div>
        </div></section>

        <div class="settings-savebar">
          <button class="btn primary" data-action="settings-save">${icon('check')} Save settings</button>
          <button class="btn" data-action="settings-reset">Reset to defaults</button>
          <div class="spacer"></div>
          <button class="btn ghost" data-action="open-userdata">${icon('folder')} Open data folder</button>
        </div>
      </div>
    </div>
  `);
  const statusLine = document.getElementById('update-status-line');
  if (statusLine) statusLine.dataset.upstate = up.state;
};
function settingRow(label, desc, control, descId) {
  return `<div class="setting"><div><div class="s-label">${esc(label)}</div><div class="s-desc" ${descId ? `id="${descId}"` : ''}>${esc(desc)}</div></div>
    <div class="s-control">${control}</div></div>`;
}

/* Updater status line — shared by the settings render and live progress patches. */
function updaterStatusText(up, appVersion) {
  if (up.state === 'unavailable') return up.error || 'Automatic updates are unavailable.';
  if (up.state === 'ready' || up.state === 'available') return `Version ${up.latestVersion || up.availableVersion || 'update'} is available — install it automatically`;
  if (up.state === 'downloading') {
    if (up.total) return `Downloading update — ${fmtBytes(up.received)} of ${fmtBytes(up.total)}${up.percent != null ? ` (${up.percent}%)` : ''}`;
    return 'Downloading update…';
  }
  if (up.state === 'restarting') return 'Update installed — restarting SUNDAY Launcher';
  if (up.state === 'applying') return 'Installing the new files — SUNDAY Launcher stays open';
  if (up.state === 'staging') return 'Unpacking the update…';
  if (up.state === 'checking') return 'Checking for updates…';
  if (up.state === 'error') return `Update failed: ${up.error || 'unknown error'}`;
  if (up.state === 'disabled') return 'Automatic updates activate in the installed version';
  return `SUNDAY Launcher ${appVersion || ''} is up to date`;
}
function currentSettingsDraft() {
  const auto = $('#set-detect').dataset.auto === 'true';
  return {
    autoDetect: auto,
    robloxPath: $('#set-path') ? $('#set-path').value.trim() : (state.settings.robloxPath || ''),
    confirmCleanup: $('#set-confirm').checked,
    pollIntervalMs: parseInt($('#set-poll').value, 10),
    launchDelayMs: parseInt($('#set-delay').value, 10),
    warnInstanceCount: parseInt($('#set-warn').value, 10),
    historyLimit: parseInt($('#set-historylimit').value, 10),
    autoRejoinDelaySec: parseInt($('#set-rejoin-delay').value, 10),
    autoRejoinMaxAttempts: parseInt($('#set-rejoin-tries').value, 10),
    autoRestartHungSec: parseInt($('#set-hung').value, 10),
  };
}

async function saveSettings() {
  const partial = currentSettingsDraft();
  const r = await call(() => api.settings.save(partial));
  if (r && r.ok) { state.settings = r.settings; toast('Settings saved', 'good'); await refreshStatus(); views.settings(); }
  else toast((r && r.error) || 'Could not save settings', 'bad');
}

/* ----------------------------- Help view ----------------------------- */
views.help = function () {
  const legacyMode = legacyCompatibilityMode();
  mount(`
    <div class="help">
      <div class="page-head"><h1>Help</h1><p>Everything you need to use SUNDAY Launcher.</p></div>

      <h2>What SUNDAY Launcher does</h2>
      <p>${legacyMode ? '<b>Legacy multi-instance mode is active.</b> SUNDAY can launch up to three managed clients. This compatibility mode is not supported by Roblox.' : 'SUNDAY organizes your saved accounts, prepares one-to-three-account launch plans, and keeps active Roblox clients visible. Client launching stays unavailable until a supported runtime mode is active.'}</p>

      <h2>Quick start</h2>
      <div class="step"><div class="n">1</div><div>On <b>Accounts</b>, click <b>Add account</b>. SUNDAY Launcher opens a Tauri Roblox sign-in window and saves the account after Roblox sets the session.</div></div>
      <div class="step"><div class="n">2</div><div>Select up to three accounts, choose a place, person, or exact server, then click <b>${legacyMode ? 'Launch' : 'Prepare'}</b>.</div></div>
      <div class="step"><div class="n">3</div><div>Stay on <b>Launch</b> to follow each active client, its destination, state, and available actions.</div></div>

      <h2>Accounts</h2>
      <p>Accounts appear with avatar, name, presence, and useful session status. Saved sign-ins remain protected on this PC. Automated account creation is unavailable.</p>

      <h2>Command palette</h2>
      <p>Press <b>Ctrl+K</b> to search safe navigation, refresh, theme, diagnostics, and data-folder actions. Destructive process and update actions are not exposed there.</p>

      <h2>Watch people</h2>
      <p>On <b>People</b>, the eye button on a card or profile adds that person to the watch list. A background poll reports when they join or switch games, and <b>Plan join</b> creates per-account follow intents. Up to 20 people are stored locally.</p>

      <h2>Keep alive</h2>
      <p>When Keep alive is enabled, SUNDAY can rejoin an account after a client it launched closes unexpectedly. It never acts on an unrelated Roblox client.</p>

      <h2>Fill the emptiest servers</h2>
      <p>Filter servers by capacity and connection quality, then choose whether selected accounts should stay together or spread across available servers.</p>

      <h2>Sessions and appearance</h2>
      <p>Saved sessions can prepare the same account and target plan in one click. In <b>Settings · Appearance</b>, choose System, Dawn, or Eclipse.</p>

      <h2>Runtime modes</h2>
      <p>${legacyMode ? 'Legacy compatibility mode is active for this SUNDAY process. It can manage up to three clients, but it is not a Roblox-supported feature. Open Diagnostics for implementation details.' : 'The default mode saves complete launch plans without starting Roblox clients. Open Diagnostics to see the exact runtime capability and reason.'}</p>

      <h2>Tools</h2>
      <ul>
        <li>Refresh updates the active-client list.</li>
        <li>Focus, End, and Restart are available only for clients SUNDAY launched. Other observed clients remain view-only.</li>
        <li><b>End all</b> and <b>Cleanup</b> are disabled.</li>
        <li>Keyboard: <b>Ctrl+K</b> opens the command palette, <b>Ctrl+1</b> through <b>Ctrl+9</b> jump straight to a section, <b>/</b> focuses search on Games and People, and <b>Esc</b> closes any dialog. SUNDAY Launcher reopens the section you last used.</li>
      </ul>

      <h2>Troubleshooting</h2>
      <div class="faq">
        <details><summary>“Roblox not found”</summary><div class="a">Install Roblox, or open <b>Settings · Roblox location</b>, switch to <b>Manual path</b> and point SUNDAY Launcher at <code>RobloxPlayerBeta.exe</code>.</div></details>
        <details><summary>Why is Launch unavailable?</summary><div class="a">${legacyMode ? 'Legacy mode still refuses a launch when Roblox is missing or SUNDAY cannot safely prepare an exact client slot.' : 'No supported client-execution mode is active. You can still select accounts and save a complete launch plan.'}</div></details>
        <details><summary>An account shows “Session expired”</summary><div class="a">Roblox sessions expire over time. Click <b>Sign in again</b> on that account to refresh it.</div></details>
        <details><summary>Is my login safe?</summary><div class="a">Existing saved sessions remain local to this PC and are never shown in the UI.</div></details>
      </div>

      <h2>Use responsibly</h2>
      <p>Run only as many clients as your PC can handle, and follow Roblox's Terms of Use for the experiences you play.</p>
      <p style="margin-top:14px"><button class="btn sm" data-action="ext-link" data-url="https://www.roblox.com/download">${icon('box')} Get Roblox</button></p>

      <h2>About</h2>
      <p><b>SUNDAY Launcher</b><br>Created by SADINKAI</p>
    </div>
  `);
};

/* ----------------------------- Action dispatch ----------------------------- */
document.addEventListener('click', async (e) => {
  const elAction = e.target.closest('[data-action]');
  if (!elAction) return;
  const action = elAction.dataset.action;
  const pid = elAction.dataset.pid ? parseInt(elAction.dataset.pid, 10) : null;
  const capability = elAction.dataset.capability || '';
  const id = elAction.dataset.id;

  if (['end-all', 'cleanup', 'arrange'].includes(action)) {
    toast('Broad process actions are disabled.', 'bad');
    return;
  }
  if (['update-check', 'update-install'].includes(action) && !capabilityAvailable('updaterApply')) {
    toast('Automatic updates are unavailable.', 'bad');
    return;
  }
  if (['create-account', 'create-account-submit'].includes(action)) {
    toast('Automated account creation is unavailable.', 'bad');
    return;
  }

  switch (action) {
    case 'step': {
      const inp = document.getElementById(elAction.dataset.target);
      if (inp) {
        const min = parseInt(inp.min, 10) || 1, max = parseInt(inp.max, 10) || 99;
        inp.value = Math.max(min, Math.min(max, (parseInt(inp.value, 10) || min) + parseInt(elAction.dataset.dir, 10)));
        // Let live listeners (the creator's count) react to stepped values.
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
      break;
    }
    case 'goto-settings': setView('settings'); break;
    case 'goto-diagnostics': setView('diagnostics'); break;
    case 'goto-accounts': setView('accounts'); break;
    case 'goto-launch': setView('instances'); break;

    case 'watch-toggle': {
      const watching = toggleWatch(elAction.dataset.user, elAction.dataset.name);
      if (watching === true) toast(`Watching ${elAction.dataset.name} for game activity`, 'good');
      else if (watching === false) toast('Stopped watching ' + (elAction.dataset.name || 'user'));
      // Refresh eye buttons in place (cards + profile hero) without a re-render.
      document.querySelectorAll(`[data-action="watch-toggle"][data-user="${CSS.escape(String(elAction.dataset.user))}"]`).forEach(btn => {
        const on = watching === true;
        btn.classList.toggle('on', on);
        if (btn.classList.contains('icon')) btn.setAttribute('data-tip', on ? 'Stop watching' : 'Watch for game activity');
        else { btn.innerHTML = `${icon('eye')} ${on ? 'Watching' : 'Watch'}`; }
      });
      break;
    }

    case 'launch-mode': {
      state.launchMode = elAction.dataset.mode;
      $('#launch-mode').querySelectorAll('button').forEach(b => {
        const active = b.dataset.mode === state.launchMode;
        b.classList.toggle('on', active);
        b.setAttribute('aria-pressed', String(active));
      });
      $('#lp-account').style.display = state.launchMode === 'account' ? '' : 'none';
      $('#lp-plain').style.display = state.launchMode === 'plain' ? '' : 'none';
      const accountOptions = $('#launch-account-options');
      if (accountOptions) accountOptions.style.display = state.launchMode === 'account' ? '' : 'none';
      break;
    }
    case 'toggle-account': {
      if (state.selected.has(id)) state.selected.delete(id);
      else if (state.selected.size >= 3) { toast('Launch plans support up to 3 accounts', 'bad'); break; }
      else state.selected.add(id);
      // update chip + card states without full re-render
      findAllByData(document, 'id', id).filter(el => el.classList.contains('chip') || el.classList.contains('roster-account')).forEach(c => {
        c.classList.toggle('on', state.selected.has(id));
        c.setAttribute('aria-pressed', String(state.selected.has(id)));
      });
      findAllByData(document, 'id', id).filter(el => el.classList.contains('acct')).forEach(c => {
        c.classList.toggle('selected', state.selected.has(id));
        const check = c.querySelector('.check');
        if (check) check.setAttribute('aria-pressed', String(state.selected.has(id)));
      });
      updateLaunchCount();
      if (state.view === 'accounts') updateAccountsLaunchButton();
      break;
    }
    case 'launch-quick': {
      const inp = $('#launch-count');
      const n = Math.max(1, Math.min(3, parseInt(inp && inp.value, 10) || 1));
      if (state.settings && n > state.settings.warnInstanceCount) {
        const ok = await confirmDialog({ title: 'Prepare ' + n + ' operations?', body: 'That is more than your warning threshold of ' + state.settings.warnInstanceCount + '. Continue?', confirmText: 'Prepare' });
        if (!ok) break;
      }
      elAction.disabled = true;
      const r = await call(() => api.launch.quick(n));
      elAction.disabled = false;
      if (handlePreparedPlan(r)) break;
      if (r && r.ok) toast(`Launched ${r.launched} client${r.launched === 1 ? '' : 's'}` + (r.failed ? `, ${r.failed} failed` : ''), 'good');
      else toast((r && r.error) || 'Launch failed', 'bad');
      break;
    }
    case 'launch-accounts': case 'launch-selected': {
      const ids = Array.from(state.selected);
      if (!ids.length) { toast('Select at least one account', 'bad'); break; }
      const placeEl = $('#lp-place');
      const raw = placeEl ? placeEl.value.trim() : state.placeId;
      const target = parseRobloxTarget(raw);
      if (target.invalid) { toast('Paste a Roblox game link or a numeric place ID', 'bad'); break; }
      state.placeId = raw;
      elAction.disabled = true;
      const r = target.gameId && target.placeId
        ? await call(() => api.launch.join(ids, target.placeId, target.gameId))
        : await call(() => api.launch.accounts(ids, target.placeId));
      elAction.disabled = false;
      if (handlePreparedPlan(r)) break;
      if (r && r.ok) {
        toast(`Launched ${r.launched} client${r.launched === 1 ? '' : 's'}` + (target.gameId ? ' into the exact server' : '') + (r.failed ? `, ${r.failed} failed` : ''), r.failed ? 'bad' : 'good');
        const ka = $('#lp-keepalive');
        if (ka && ka.checked && target.placeId) {
          armWatchdog(ids.map(id => ({ accountId: id, placeId: target.placeId, gameInstanceId: target.gameId, name: 'the game' })));
          toast('Watchdog enabled — dropped clients rejoin automatically', 'good');
        }
      } else toast((r && r.error) || 'Launch failed', 'bad');
      break;
    }
    case 'launch-account': {
      const r = await call(() => api.launch.accounts([id], ''));
      if (handlePreparedPlan(r)) break;
      if (r && r.ok) toast('Launched ' + (r.launched) + ' client', 'good');
      else toast((r && (r.error || (r.results && r.results[0] && r.results[0].reason))) || 'Launch failed', 'bad');
      break;
    }
    case 'follow-account': {
      openFollowDialog(id);
      break;
    }
    case 'toggle-follow-account': {
      if (state.following || id === state.followTargetId) break;
      if (state.followSelected.has(id)) state.followSelected.delete(id);
      else if (state.followSelected.size >= 3) { toast('Launch plans support up to 3 accounts', 'bad'); break; }
      else state.followSelected.add(id);
      renderFollowDialog();
      break;
    }
    case 'follow-confirm': {
      if (state.following || !state.followTargetId || !state.followSelected.size) break;
      const targetId = state.followTargetId;
      const followerIds = Array.from(state.followSelected).filter(accountId => accountId !== targetId);
      if (!followerIds.length) { toast('Choose at least one other account', 'bad'); break; }
      state.following = true;
      renderFollowDialog();
      const r = await call(() => api.accounts.follow(targetId, followerIds));
      state.following = false;
      if (handlePreparedPlan(r)) {
        closeFollowDialog();
        break;
      }
      if (r && r.ok) {
        const targetName = r.targetDisplayName || r.targetUsername || 'account';
        closeFollowDialog();
        toast(`Joined ${targetName} with ${r.launched} account${r.launched === 1 ? '' : 's'}` + (r.failed ? `, ${r.failed} failed` : ''), r.failed ? 'bad' : 'good');
      } else {
        const firstFailure = r && r.results && r.results.find(result => !result.ok);
        renderFollowDialog();
        toast((r && r.error) || (firstFailure && firstFailure.reason) || 'Could not follow that account', 'bad');
      }
      break;
    }

    case 'create-account': {
      openCreateAccountModal();
      break;
    }
    case 'create-gender': {
      const d = state.createDraft;
      if (!d || d.submitting) break;
      d.gender = CREATE_GENDERS.includes(elAction.dataset.g) ? elAction.dataset.g : 'Skip';
      const seg = $('#create-gender');
      if (seg) Array.from(seg.querySelectorAll('button')).forEach(b => b.classList.toggle('on', b.dataset.g === d.gender));
      break;
    }
    case 'create-pick-user': {
      const d = state.createDraft;
      if (!d || d.submitting) break;
      const name = /^[A-Za-z0-9_]{3,20}$/.test(String(elAction.dataset.u || '')) ? String(elAction.dataset.u) : '';
      if (!name) break;
      d.username = name;
      d.check = null;
      d.suggest = [];
      d.suggestFor = '';
      const input = $('#create-username');
      if (input) input.value = name;
      renderCreateSuggestions();
      updateCreateValidation();
      scheduleCreateUsernameCheck();
      break;
    }
    case 'create-gen-pass': {
      const d = state.createDraft;
      if (!d || d.submitting) break;
      const pass = generateCreatePassword();
      d.password = pass;
      d.confirm = pass;
      const p = $('#create-password');
      const c = $('#create-confirm');
      if (p) p.value = pass;
      if (c) c.value = pass;
      updateCreateValidation();
      break;
    }
    case 'create-toggle-pass': {
      const d = state.createDraft;
      if (!d) break;
      d.showPass = !d.showPass;
      const pass = $('#create-password');
      const confirm = $('#create-confirm');
      if (pass) pass.type = d.showPass ? 'text' : 'password';
      if (confirm) confirm.type = d.showPass ? 'text' : 'password';
      elAction.dataset.tip = d.showPass ? 'Hide password' : 'Show password';
      break;
    }
    case 'create-account-submit': {
      const d = state.createDraft;
      if (!d || d.submitting || state.creatingAccount) break;
      const errors = createValidationErrors(d);
      if (Object.keys(errors).length || (d.check && d.check.available === false)) { updateCreateValidation(); break; }

      const payload = {
        username: String(d.username || '').trim(),
        password: String(d.password || ''),
        birthday: String(d.birthday || ''),
        gender: d.gender,
      };

      d.submitting = true;
      saveCreateDefaults(d);
      state.creatingAccount = true;
      const btn = $('#create-submit');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Opening Roblox…';
      }

      closeCreateModal();
      if (state.view === 'accounts') views.accounts();
      toast('Opening Roblox sign-up — solve the captcha when it appears');
      const r = await call(() => api.accounts.create({
        username: payload.username,
        password: payload.password,
        birthday: payload.birthday,
        gender: payload.gender,
      }), undefined, 0);
      state.creatingAccount = false;
      if (r && r.ok) {
        await loadAccounts();
        toast((r.updated ? 'Account updated: ' : 'Account created: ') + (r.account ? r.account.username : ''), 'good');
      } else if (r && r.canceled) {
        toast('Sign-up canceled');
      } else {
        toast((r && r.error) || 'Could not create the account', 'bad');
      }
      if (state.view === 'accounts') views.accounts();
      break;
    }

    case 'add-account': {
      if (state.addingAccount) break;
      state.addingAccount = true;
      if (state.view === 'accounts') views.accounts();
      toast('Opening Roblox sign-in…');
      const r = await call(() => api.accounts.add(), undefined, 0);
      state.addingAccount = false;
      if (r && r.ok) { await loadAccounts(); toast((r.updated ? 'Account updated: ' : 'Account added: ') + (r.account ? r.account.username : ''), 'good'); }
      else if (r && r.canceled) toast('Sign-in canceled');
      else if (r && r.unavailable) toast(r.error || 'Account sign-in is unavailable in this build', 'bad');
      else toast((r && r.error) || 'Could not add account', 'bad');
      if (state.view === 'accounts') views.accounts();
      break;
    }
    case 'reauth-account': {
      if (state.addingAccount) break;
      state.addingAccount = true;
      if (state.view === 'accounts') views.accounts();
      toast('Opening Roblox sign-in…');
      const r = await call(() => api.accounts.add(), undefined, 0);
      state.addingAccount = false;
      if (r && r.ok) {
        await loadAccounts();
        toast('Signed in again: ' + (r.account ? r.account.username : ''), 'good');
      } else if (r && r.canceled) toast('Sign-in canceled');
      else if (r && r.unavailable) toast(r.error || 'Account sign-in is unavailable in this build', 'bad');
      else toast((r && r.error) || 'Could not sign in again', 'bad');
      if (state.view === 'accounts') views.accounts();
      break;
    }
    case 'remove-account': {
      const acc = state.accounts.find(a => a.id === id);
      const ok = await confirmDialog({ title: 'Remove account?', body: 'Remove “' + (acc ? acc.username : '') + '” from SUNDAY Launcher? This deletes its stored session on this PC.', confirmText: 'Remove', danger: true });
      if (!ok) break;
      const r = await call(() => api.accounts.remove(id));
      if (r && r.ok) {
        state.selected.delete(id);
        state.accounts = r.accounts; updateAccountsCount(); views.accounts(); toast('Account removed', 'good');
      } else {
        toast((r && r.error) || 'Could not remove the account', 'bad');
      }
      break;
    }
    case 'refresh-account': {
      const r = await call(() => api.accounts.refresh(id));
      if (r && r.ok) { state.accounts = r.accounts; patchAccountGrid(state.accounts); updateAccountsCount(); toast('Refreshed', 'good'); }
      break;
    }
    case 'refresh-accounts': {
      toast('Refreshing accounts…');
      const r = await call(() => api.accounts.refresh(undefined, true));
      if (r && r.ok) { state.accounts = r.accounts; state.accountsRefreshedAt = Date.now(); patchAccountGrid(state.accounts); updateAccountsCount(); toast('Accounts refreshed', 'good'); }
      break;
    }

    case 'refresh-games': gamesBrowse(); break;
    case 'random-game': {
      const list = visibleGames();
      if (!list.length) { toast('Load games first', 'bad'); break; }
      const gm = list[Math.floor(Math.random() * list.length)];
      joinPlace(gm.placeId, gm.name);
      break;
    }
    case 'games-category':
      state.games.category = elAction.dataset.cat || 'All';
      renderGamesCategories();
      renderGamesGrid();
      break;
    case 'toggle-fav': {
      const gm = gameByPlaceId(elAction.dataset.place);
      if (!gm) break;
      const added = toggleFav(gm);
      toast(added ? 'Saved to favorites' : 'Removed from favorites', 'good');
      renderGamesCategories();
      renderGamesGrid();
      break;
    }
    case 'clip-use': {
      const text = elAction.dataset.text || '';
      state.placeId = text;
      const inp = $('#lp-place');
      if (inp) { inp.value = text; inp.focus(); }
      updateLaunchReview();
      const box = $('#clip-offer');
      if (box) { box.hidden = true; box.innerHTML = ''; }
      toast('Link loaded — choose accounts and launch', 'good');
      break;
    }
    case 'clip-dismiss': {
      const box = $('#clip-offer');
      if (box) { box.hidden = true; box.innerHTML = ''; }
      break;
    }
    case 'keepalive-off':
      await call(() => api.keeper.disarmAll());
      toast('Watchdog stopped', 'good');
      break;
    case 'stats-refresh': views.stats(); break;
    case 'stats-clear': {
      const ok = await confirmDialog({ title: 'Clear playtime data?', body: 'All recorded sessions are deleted from this PC. This cannot be undone.', confirmText: 'Clear', danger: true });
      if (!ok) break;
      await call(() => api.playtime.clear());
      playedCache.at = 0; playedCache.map = new Map();   // drop the Games-grid chips too
      toast('Playtime data cleared', 'good');
      views.stats();
      break;
    }
    case 'set-theme':
      setThemePref(elAction.dataset.theme || 'system');
      if (state.view === 'settings') views.settings();
      break;
    case 'session-save': {
      const ids = Array.from(state.selected);
      if (!ids.length) { toast('Select the accounts to include first', 'bad'); break; }
      const placeEl = $('#lp-place');
      const target = parseRobloxTarget(placeEl ? placeEl.value.trim() : state.placeId);
      if (target.invalid) { toast('Paste a Roblox game link or a numeric place ID', 'bad'); break; }
      state.sessionDraft = {
        accountIds: ids.filter(id => state.accounts.some(account => account.id === id)),
        placeId: target.placeId,
        gameId: target.gameId,
      };
      openModal(`
        <div class="m-head"><h3>Save session</h3><p>${ids.length} account${ids.length === 1 ? '' : 's'} - ${target.placeId ? 'place ' + esc(target.placeId) : 'Roblox home'}</p></div>
        <div class="m-body">
          <div class="field"><label for="session-name">Name</label>
          <input id="session-name" type="text" maxlength="40" placeholder="e.g. Farming crew" value="Session ${loadSessions().length + 1}"></div>
          <label class="toggle-row inline" style="gap:10px;margin-top:4px;cursor:pointer">
            <input type="checkbox" id="session-arrange"> <span>Auto-arrange windows ~20s after launch</span>
          </label>
          <label class="toggle-row inline" style="gap:10px;margin-top:8px;cursor:pointer">
            <input type="checkbox" id="session-keepalive"> <span>Watchdog — put accounts back in the same server if they crash or disconnect</span>
          </label>
        </div>
        <div class="m-foot"><button class="btn" data-action="modal-cancel">Cancel</button>
        <button class="btn primary" data-action="session-save-confirm">${icon('check')} Save session</button></div>`);
      const inp = $('#session-name');
      if (inp) { inp.focus(); inp.select(); }
      break;
    }
    case 'session-save-confirm': {
      const draft = state.sessionDraft;
      if (!draft || !draft.accountIds.length) { closeModal(); toast('That session is no longer available', 'bad'); break; }
      const nameEl = $('#session-name');
      const sessions = loadSessions();
      sessions.push({
        id: 's' + Date.now(),
        name: (nameEl && nameEl.value.trim()) || `Session ${sessions.length + 1}`,
        accountIds: draft.accountIds,
        placeId: draft.placeId,
        gameId: draft.gameId,
        arrange: !!($('#session-arrange') && $('#session-arrange').checked),
        keepAlive: !!($('#session-keepalive') && $('#session-keepalive').checked),
      });
      const saved = saveSessions(sessions);
      state.sessionDraft = null;
      closeModal();
      toast(saved ? 'Session saved' : 'Could not save the session on this PC', saved ? 'good' : 'bad');
      if (state.view === 'instances') views.instances();
      break;
    }
    case 'plan-cancel': {
      const r = await call(() => api.launch.cancelPlan(id));
      if (r && r.plan) rememberLaunchPlan(r.plan);
      toast(r && r.ok ? 'Launch plan cancelled' : ((r && r.error) || 'Could not cancel launch plan'), r && r.ok ? 'good' : 'bad');
      break;
    }
    case 'session-launch': {
      const session = loadSessions().find(x => x.id === elAction.dataset.id);
      if (!session) break;
      const ids = session.accountIds.filter(i => state.accounts.some(a => a.id === i)).slice(0, 3);
      if (!ids.length) { toast('None of this session\'s accounts exist anymore', 'bad'); break; }
      elAction.disabled = true;
      const r = session.gameId && session.placeId
        ? await call(() => api.launch.join(ids, session.placeId, session.gameId))
        : await call(() => api.launch.accounts(ids, session.placeId || ''));
      elAction.disabled = false;
      if (handlePreparedPlan(r)) break;
      if (r && r.ok) {
        toast(`Session "${session.name}": launched ${r.launched} client${r.launched === 1 ? '' : 's'}` + (r.failed ? `, ${r.failed} failed` : ''), r.failed ? 'bad' : 'good');
        if (session.arrange) {
          toast('Windows will be arranged in ~20s', 'good');
          setTimeout(() => { call(() => api.instances.arrange()); }, 20000);
        }
        if (session.keepAlive && session.placeId) armWatchdog(ids.map(id => ({ accountId: id, placeId: session.placeId, gameInstanceId: session.gameId, name: session.name })));
      } else toast((r && r.error) || 'Session launch failed', 'bad');
      break;
    }
    case 'session-delete': {
      if (!saveSessions(loadSessions().filter(x => x.id !== elAction.dataset.id))) toast('Could not delete the session', 'bad');
      if (state.view === 'instances') views.instances();
      break;
    }
    case 'games-sort': {
      state.games.sort = elAction.dataset.sort || 'players';
      // The segmented lives in the static mount markup - move its highlight
      // in place instead of re-rendering the whole view.
      document.querySelectorAll('.games-tools [data-action="games-sort"]').forEach(b => {
        b.classList.toggle('on', b.dataset.sort === state.games.sort);
      });
      renderGamesGrid();
      break;
    }
    case 'games-hide-empty':
      state.games.hideEmpty = !state.games.hideEmpty;
      views.games();
      break;
    case 'join-game': joinPlace(elAction.dataset.place, elAction.dataset.name); break;
    case 'open-game-web':
      await call(() => api.openExternal(`https://www.roblox.com/games/${encodeURIComponent(elAction.dataset.place || '')}`));
      break;
    case 'copy-place-id':
      try {
        await navigator.clipboard.writeText(String(elAction.dataset.place || ''));
        toast('Place ID copied', 'good');
      } catch (_) { toast('Could not copy place ID', 'bad'); }
      break;
    case 'open-servers': openServersModal(elAction.dataset.place, elAction.dataset.name); break;
    case 'join-server': joinServer(elAction.dataset.place, elAction.dataset.server, elAction.dataset.name); break;
    case 'server-sort':
      if (state.servers) {
        state.servers.sort = elAction.dataset.sort || 'best';
        renderServersModal();
        if (state.servers.sort === 'players' && !state.servers.deepScanned) await deepScanServers(true);
      }
      break;
    case 'servers-scan': await deepScanServers(false); break;
    case 'servers-filter-reset':
      if (state.servers) {
        state.servers.filters = { occupancy: 0, maxPing: 0, minFps: 0, freeSlots: 1 };
        renderServersModal();
      }
      break;
    case 'servers-auto-refresh':
      if (state.servers) setServerAutoRefresh(!state.servers.autoRefresh);
      break;
    case 'copy-server-id':
      try { await navigator.clipboard.writeText(String(elAction.dataset.server || '')); toast('Server ID copied', 'good'); }
      catch (_) { toast('Could not copy server ID', 'bad'); }
      break;
    case 'servers-more': loadServers(true); break;
    case 'servers-refresh': loadServers(false); break;
    case 'join-best': {
      const sv = state.servers;
      if (sv && sv.list.length) { const top = sortedServers(filteredServers(sv), sv.sort)[0]; if (top) joinServer(sv.placeId, top.id, sv.name); }
      break;
    }
    case 'servers-fill': openFillModal(); break;
    case 'fill-mode': {
      if (!state.fillDraft) break;
      state.fillDraft.spread = elAction.dataset.mode === 'spread';
      const seg = $('#fill-mode');
      if (seg) seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', (b.dataset.mode === 'spread') === state.fillDraft.spread));
      break;
    }
    case 'fill-confirm': {
      const draft = state.fillDraft;
      if (!draft || !draft.ids.length) { closeModal(); state.fillDraft = null; break; }
      const keepAlive = !!($('#fill-keepalive') && $('#fill-keepalive').checked);
      elAction.disabled = true;
      elAction.innerHTML = '<span class="spinner dark"></span> Planning…';
      const r = await call(() => api.launch.autoFill(draft.ids, draft.placeId, { spread: draft.spread, keepAlive, name: draft.name }), undefined, 300000);
      state.fillDraft = null;
      closeModal();
      state.servers = null;
      if (handlePreparedPlan(r)) break;
      if (r && r.ok) {
        toast(`Filled ${r.launched} account${r.launched === 1 ? '' : 's'} into ${r.servers} server${r.servers === 1 ? '' : 's'}` + (r.failed ? `, ${r.failed} failed` : ''), r.failed ? 'bad' : 'good');
      } else toast((r && r.error) || 'Fill failed', 'bad');
      break;
    }

    case 'open-friends':
      state.people.tab = 'people';
      state.people.route = 'friends';
      views.people();
      break;
    case 'people-home':
      state.people.tab = 'people';
      state.people.route = 'home';
      views.people();
      break;
    case 'people-back': state.people.route = state.people.returnRoute || 'home'; views.people(); break;
    case 'people-search': runPeopleSearch(($('#people-search') || {}).value || ''); break;
    case 'people-search-retry': runPeopleSearch(state.people.search.query); break;
    case 'people-search-clear': clearPeopleSearch(); break;
    case 'people-search-more': runPeopleSearch(state.people.search.query, true); break;
    case 'people-filter':
      state.people.filter = elAction.dataset.filter || 'all';
      if (state.people.route === 'friends') views.people();
      else if (state.people.route === 'home') renderPeopleSearchResults();
      break;
    case 'people-sort':
      state.people.sort = elAction.dataset.sort || 'status';
      if (state.people.route === 'friends') views.people();
      else if (state.people.route === 'home') renderPeopleSearchResults();
      break;
    case 'copy-user-id':
      try {
        await navigator.clipboard.writeText(String(elAction.dataset.user || ''));
        toast('User ID copied', 'good');
      } catch (_) { toast('Could not copy user ID', 'bad'); }
      break;
    case 'open-person': openPerson(elAction.dataset.user); break;
    case 'people-prev': if (state.people.hasPrev) loadPeople(state.people.page - 1); break;
    case 'people-next': if (state.people.hasNext) loadPeople(state.people.page + 1); break;
    case 'people-refresh': refreshPeople(); break;
    case 'join-person': openPersonJoinDialog(elAction.dataset.user, elAction.dataset.place, elAction.dataset.game, elAction.dataset.name); break;
    case 'select-join-account': {
      if (!state.personJoin || state.personJoin.joining) break;
      const set = state.personJoin.selectedIds;
      if (set.has(id)) set.delete(id);
      else if (set.size >= 3) { toast('Launch plans support up to 3 accounts', 'bad'); break; }
      else set.add(id);
      renderPersonJoinDialog();
      break;
    }
    case 'person-join-confirm': {
      const join = state.personJoin;
      if (!join || join.joining || !join.selectedIds.size) break;
      const ids = Array.from(join.selectedIds).filter(x => state.accounts.some(a => a.id === x));
      if (!ids.length) { toast('Those accounts are no longer available', 'bad'); closePersonJoinDialog(); break; }
      join.joining = true;
      renderPersonJoinDialog();
      const r = await call(() => api.launch.joinPersonMulti(ids, join.userId));
      if (handlePreparedPlan(r)) {
        closePersonJoinDialog();
        break;
      }
      if (r && r.ok) {
        closePersonJoinDialog();
        toast(`Joining ${join.name} with ${r.launched} account${r.launched === 1 ? '' : 's'}` + (r.failed ? `, ${r.failed} failed` : ''), r.failed ? 'bad' : 'good');
      } else {
        join.joining = false;
        renderPersonJoinDialog();
        const firstFailure = r && r.results && r.results.find(result => !result.ok);
        toast((r && r.error) || (firstFailure && firstFailure.reason) || 'Join failed', 'bad');
      }
      break;
    }

    case 'refresh-instances': { await loadInstances(); toast('Refreshed', 'good'); break; }
    case 'arrange': {
      if (!state.instances.length) { toast('No Roblox windows to arrange', 'bad'); break; }
      const r = await call(() => api.instances.arrange());
      toast(r && r.ok ? `Arranged ${r.tiled} window${r.tiled === 1 ? '' : 's'} in a ${r.cols}-${r.rows} grid` : (r && r.reason) || 'Could not arrange windows', r && r.ok ? 'good' : 'bad');
      break;
    }
    case 'end-all': {
      if (!state.instances.length) { toast('No clients running', 'bad'); break; }
      const ok = !needConfirm() || await confirmDialog({ title: 'End all Roblox clients?', body: 'This closes every running Roblox client.', confirmText: 'End all', danger: true });
      if (!ok) break;
      const r = await call(() => api.instances.killAll());
      toast(r && r.ok ? 'All clients ended' : 'Could not end clients', r && r.ok ? 'good' : 'bad');
      break;
    }
    case 'cleanup': {
      const ok = !needConfirm() || await confirmDialog({ title: 'Run cleanup?', body: 'Ends all Roblox clients and clears leftover crash-handler processes.', confirmText: 'Clean up', danger: true });
      if (!ok) break;
      const r = await call(() => api.instances.cleanup());
      toast(r && r.ok ? 'Cleanup complete' : 'Cleanup failed', r && r.ok ? 'good' : 'bad');
      break;
    }
    case 'focus': { const r = await call(() => api.instances.focus(capability)); if (!(r && r.ok)) toast((r && (r.error || r.reason)) || 'Could not focus window', 'bad'); break; }
    case 'restart': { const r = await call(() => api.instances.restart(capability)); toast(r && r.ok ? 'Client restarted' : ((r && r.error) || 'Restart failed'), r && r.ok ? 'good' : 'bad'); break; }
    case 'end': { const r = await call(() => api.instances.kill(capability)); toast(r && r.ok ? 'Client ended' : ((r && r.error) || 'Could not end client'), r && r.ok ? 'good' : 'bad'); break; }

    case 'modal-cancel': cancelModal(); break;
    case 'confirm-yes': if (confirmResolver) { confirmResolver(true); confirmResolver = null; } closeModal(); break;
    case 'confirm-no': if (confirmResolver) { confirmResolver(false); confirmResolver = null; } closeModal(); break;

    case 'clear-history': {
      const ok = await confirmDialog({ title: 'Clear history?', body: 'Remove all launch-history entries.', confirmText: 'Clear', danger: true });
      if (!ok) break;
      await call(() => api.history.clear()); views.history(); toast('History cleared', 'good');
      break;
    }

    case 'set-detect': {
      const auto = elAction.dataset.auto === 'true';
      const seg = $('#set-detect'); seg.dataset.auto = String(auto);
      seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.auto === String(auto)));
      const row = $('#set-path-row'); if (row) row.style.display = auto ? 'none' : '';
      break;
    }
    case 'settings-browse': {
      const r = await call(() => api.settings.browse());
      if (r && r.ok && r.path) {
        const inp = $('#set-path'); if (inp) inp.value = r.path;
        const seg = $('#set-detect');
        if (seg) {
          seg.dataset.auto = 'false';
          seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.auto === 'false'));
        }
        const row = $('#set-path-row'); if (row) row.style.display = '';
        if (!r.valid) {
          toast(r.reason || 'That file is not RobloxPlayerBeta.exe', 'bad');
          break;
        }
        const saved = await call(() => api.settings.save(currentSettingsDraft()));
        if (saved && saved.ok) {
          state.settings = saved.settings;
          await refreshStatus();
          views.settings();
          toast(state.status && state.status.robloxFound ? 'Roblox detected from manual path' : 'Manual path saved, but Roblox was not detected', state.status && state.status.robloxFound ? 'good' : 'bad');
        } else {
          toast((saved && saved.error) || 'Could not save Roblox path', 'bad');
        }
      }
      break;
    }
    case 'redetect': {
      const saved = await call(() => api.settings.save(currentSettingsDraft()));
      if (saved && saved.ok) state.settings = saved.settings;
      await refreshStatus();
      views.settings();
      toast(state.status && state.status.robloxFound ? 'Roblox detected' : 'Roblox not found', state.status && state.status.robloxFound ? 'good' : 'bad');
      break;
    }
    case 'update-check': {
      const prevUpdater = state.updater;
      state.updater = Object.assign({}, state.updater, { state: 'checking', error: null });
      views.settings();
      let idempotencyKey;
      try { idempotencyKey = updateCheckIdempotencyKey(); }
      catch (error) {
        state.updater = prevUpdater;
        toast(error.message, 'bad');
        if (state.view === 'settings') views.settings();
        break;
      }
      const r = await call(() => api.updater.check(idempotencyKey));
      const job = r && r.ok && r.operationId
        ? await waitForUpdateJob(r.operationId, 35000)
        : null;
      const fallback = prevUpdater && prevUpdater.state ? prevUpdater : { state: 'disabled' };
      if (job && FINAL_JOB_STATES.has(job.state)) clearUpdateCheckIdempotencyKey(idempotencyKey);
      if (!job && r && r.ok) {
        state.updater = Object.assign({}, state.updater, { state: 'checking' });
        toast('Update check is still running in the background');
      } else if (job && job.state === 'SUCCEEDED' && job.result) {
        state.updater = job.result;
      } else {
        state.updater = await call(() => api.updater.status(), fallback);
      }
      if (!(r && r.ok)) toast((r && r.error) || 'Update check could not be started', 'bad');
      else if (job && job.state === 'FAILED') toast(job.error || 'Update check failed', 'bad');
      else if (job && job.state === 'CANCELLED') toast('Update check was cancelled', 'bad');
      else if (state.updater.state === 'current') toast('SUNDAY Launcher is up to date', 'good');
      if (state.view === 'settings') views.settings();
      break;
    }
    case 'update-install': await call(() => api.updater.install()); break;
    case 'update-open-web':
      await call(() => api.openExternal('https://github.com/SadinKai/SUNDAY/releases/latest'));
      toast('Opening the SUNDAY Launcher releases page in your browser');
      break;
    case 'settings-save': saveSettings(); break;
    case 'settings-reset': {
      const ok = await confirmDialog({ title: 'Reset settings?', body: 'Restore all settings to their defaults.', confirmText: 'Reset', danger: true });
      if (!ok) break;
      const r = await call(() => api.settings.reset());
      if (r && r.ok) { state.settings = r.settings; views.settings(); toast('Settings reset', 'good'); }
      break;
    }

    case 'log-filter': state.logFilter = elAction.dataset.f;
      $('#log-filter').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.f === state.logFilter));
      renderLogs(); break;
    case 'logs-clear': await call(() => api.logs.clear()); state.logs = []; renderLogs(); toast('Logs cleared', 'good'); break;
    case 'logs-folder': await call(() => api.logs.openFolder()); break;
    case 'copy-diag': copyDiagnostics(); break;
    case 'open-userdata': await call(() => api.openUserData()); break;
    case 'ext-link': await call(() => api.openExternal(elAction.dataset.url)); break;
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'launch-account-search') filterLaunchAccounts(e.target.value);
  if (e.target.id === 'lp-place') {
    state.placeId = e.target.value;
    updateLaunchReview();
    updateLaunchCount();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'lp-destination-preset') {
    const input = $('#lp-place');
    if (input) {
      input.value = e.target.value;
      state.placeId = e.target.value;
      updateLaunchReview();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }
  const filter = e.target.closest('[data-server-filter]');
  if (!filter || !state.servers) return;
  const key = filter.dataset.serverFilter;
  if (!Object.prototype.hasOwnProperty.call(state.servers.filters, key)) return;
  state.servers.filters[key] = Number(filter.value) || 0;
  renderServersModal();
});

function needConfirm() { return !state.settings || state.settings.confirmCleanup !== false; }

/* Right-click context menu on instance rows */
content.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('[data-row]');
  if (!row) return;
  e.preventDefault();
  const pid = parseInt(row.dataset.pid, 10);
  const instance = (state.instances || []).find(i => Number(i.pid) === pid);
  const capability = instance && instance.controllable ? instance.capability : '';
  const watch = instance ? watchdogRecordForAccount(instance.accountId) : null;
  const items = capability ? [
    { id: 'focus', icon: 'focus', label: 'Focus window', onClick: () => doRowAction('focus', capability) },
    { id: 'restart', icon: 'rotate', label: 'Restart client', onClick: () => doRowAction('restart', capability) },
  ] : [];
  if (watch) {
    items.push({ id: 'stop-watch', icon: 'activity', label: 'Stop auto-rejoin', onClick: async () => {
      const r = await call(() => api.keeper.disarm(instance.accountId));
      toast(r && r.ok ? 'Watchdog stopped for ' + (watch.username || 'that account') : 'Could not stop the watchdog', r && r.ok ? 'good' : 'bad');
    } });
  }
  if (items.length) items.push({ sep: true });
  items.push({ id: 'copy', icon: 'copy', label: 'Copy PID', onClick: () => navigator.clipboard.writeText(String(pid)).then(() => toast('PID copied', 'good')) });
  if (capability) items.push({ sep: true }, { id: 'end', icon: 'x', label: 'End client', danger: true, onClick: () => doRowAction('end', capability) });
  showContextMenu(e.clientX, e.clientY, items);
});
async function doRowAction(kind, capability) {
  if (kind === 'focus') { const r = await call(() => api.instances.focus(capability)); if (!(r && r.ok)) toast((r && (r.error || r.reason)) || 'Could not focus', 'bad'); }
  if (kind === 'restart') { const r = await call(() => api.instances.restart(capability)); toast(r && r.ok ? 'Restarted' : ((r && r.error) || 'Restart failed'), r && r.ok ? 'good' : 'bad'); }
  if (kind === 'end') { const r = await call(() => api.instances.kill(capability)); toast(r && r.ok ? 'Ended' : ((r && r.error) || 'Could not end'), r && r.ok ? 'good' : 'bad'); }
}

async function copyDiagnostics() {
  const g = state.diag || {};
  const lines = ['SUNDAY Launcher diagnostics', '----------------'];
  Object.keys(g).forEach(k => { if (k !== 'candidates') lines.push(k + ': ' + g[k]); });
  lines.push('', 'Recent log:');
  state.logs.slice(-40).forEach(e => lines.push(`[${e.time}] ${e.level.toUpperCase()} ${e.message}${e.detail ? ' | ' + e.detail : ''}`));
  try { await navigator.clipboard.writeText(lines.join('\n')); toast('Diagnostics copied', 'good'); }
  catch (_) { toast('Could not copy', 'bad'); }
}

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
