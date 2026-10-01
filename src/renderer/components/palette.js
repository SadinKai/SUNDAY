'use strict';

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
