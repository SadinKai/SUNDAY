'use strict';

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
        ${selectedCount ? `<button class="btn sm" data-action="launch-selected" data-account-launch-selected>${icon('play')} Launch ${selectedCount} selected</button>` : ''}
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
  const alreadyActive = activeManagedAccountIds().has(String(a.id));
  const facts = accountFactsHtml(a);
  return `
    <div class="acct ${state.selected.has(a.id) ? 'selected' : ''}" data-id="${id}">
      <div class="top">
        ${a.avatar ? `<img class="avatar" src="${esc(a.avatar)}" alt="">` : `<div class="avatar"></div>`}
        <div class="who">
          <div class="dname" data-acct-dname="${id}">${esc(a.displayName || a.username)}${a.verified ? ` <span class="vbadge" data-tip="Verified account">${icon('check-circle')}</span>` : ''}</div>
          <div class="uname">@${esc(a.username)}</div>
        </div>
        <button type="button" class="check" data-action="toggle-account" data-id="${id}" data-tip="${alreadyActive ? 'This account already has an active client' : 'Select for a launch plan'}" aria-label="Select ${esc(a.displayName || a.username)} for a launch plan" aria-pressed="${state.selected.has(a.id)}" ${alreadyActive ? 'disabled aria-disabled="true"' : ''}>${icon('check')}</button>
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
          : `<button class="btn primary sm" data-action="launch-account" data-id="${id}" ${alreadyActive ? 'disabled aria-disabled="true"' : ''}>${icon('play')} ${alreadyActive ? 'Active client' : 'Launch'}</button>`}
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
