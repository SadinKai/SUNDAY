'use strict';

/* SUNDAY Launcher renderer - pure UI. All OS/auth work happens in the main process and is
   reached only through the Tauri-backed `window.sunday` bridge. */

const api = window.sunday;
const {
  managedClientCapacity,
  normalizeSessions,
  normalizeThemePreference,
  parseRobloxTarget,
  selectionAfterLaunch,
} = window.SundayModel;
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
  statusLoading: true,
  updater: null,
  instances: [],
  summary: null,
  accounts: [],
  selected: new Set(),     // selected account ids (shared across views)
  launchPlans: [],         // persisted coordinator state; never contains credentials
  lastLaunchFailure: null, // sanitized backend reason only
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
    sort: 'players', hideEmpty: false, categories: [], category: 'All', requestId: 0, refreshedAt: 0,
  },
  people: {
    tab: 'people',
    route: 'home', returnRoute: 'home',
    filter: 'all', sort: 'status', filterText: '',
    list: [], page: 0, pageSize: 12, total: 0, hasNext: false, hasPrev: false, loading: false, error: null, loaded: false, requestId: 0, refreshedAt: 0,
    search: {
      query: '', list: [], nextPageCursor: null, loading: false, error: null,
      searched: false, requestId: 0, notice: null, source: null, cached: false, retryable: false,
    },
    detail: { userId: null, profile: null, loading: false, error: null, requestId: 0 },
  },
  accountsRefreshedAt: 0,
};

const UPDATE_CHECK_KEY_STORAGE = 'sunday-update-check-idempotency-v1';
const FINAL_JOB_STATES = new Set(['CANCELLED', 'SUCCEEDED', 'FAILED']);
let updateCheckSessionKey = null;
let retryLastLaunch = null;

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

function legacyManagedClientLimit() {
  return managedClientCapacity(state.status, legacyCompatibilityMode());
}

function configuredLegacyManagedClientLimit() {
  return managedClientCapacity(state.status, true);
}

function activeManagedAccountIds() {
  return new Set((state.instances || [])
    .filter(instance => instance && instance.source === 'sunday' && instance.accountId)
    .map(instance => String(instance.accountId)));
}

function applyLaunchSelectionResult(response) {
  state.selected = new Set(selectionAfterLaunch(state.selected, response));
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
