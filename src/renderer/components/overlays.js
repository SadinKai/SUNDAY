'use strict';

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
