'use strict';

/* ----------------------------- Games view ----------------------------- */
/* Local playtime cross-reference for the Games grid: placeId -> total playtime
   and session count, crunched from the stats payload with a short TTL so
   browsing and re-sorting never re-crunch it. Powers the "Played" line on
   cards and the Most-played sort. */
const playedCache = { at: 0, map: new Map() };
const GAMES_REFRESH_TTL_MS = 2 * 60 * 1000;
let gamesBrowseInFlight = null;
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
  if (!g.loaded && !g.loading) gamesBrowse(false);
  else {
    renderGamesGrid();
    if (!g.loading && Date.now() - Number(g.refreshedAt || 0) >= GAMES_REFRESH_TTL_MS) gamesBrowse(false);
  }
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

async function gamesBrowse(force) {
  const g = state.games;
  const rid = ++g.requestId;
  g.loading = true; g.error = null; g.query = ''; g.nextPageToken = null;
  if (!g.list.length) { g.categories = []; g.category = 'All'; }
  if (state.view === 'games') { renderGamesCategories(); renderGamesGrid(); }
  const request = gamesBrowseInFlight || call(() => api.games.browse(force === true));
  if (!gamesBrowseInFlight) gamesBrowseInFlight = request;
  try {
    const r = await request;
    if (rid !== g.requestId) return; // a newer browse/search superseded this one
    g.loading = false; g.loaded = true;
    if (r && r.ok) {
      g.list = r.games; g.nextPageToken = r.nextPageToken; g.categories = r.categories || [];
      g.category = 'All'; g.refreshedAt = Date.now();
    } else g.error = (r && r.error) || 'Games could not be loaded.';
    if (state.view === 'games') { renderGamesCategories(); renderGamesGrid(); }
  } finally {
    if (gamesBrowseInFlight === request) gamesBrowseInFlight = null;
  }
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
  if (r && r.ok) { g.list = r.games; g.nextPageToken = r.nextPageToken; g.categories = r.categories || []; g.refreshedAt = Date.now(); }
  else g.error = (r && r.error) || 'Search failed.';
  if (state.view === 'games') { renderGamesCategories(); renderGamesGrid(); }
}

async function gamesLoadMore() {
  const g = state.games;
  if (g.loading || !g.nextPageToken || !g.query) return;
  g.loading = true;
  const rid = g.requestId;
  const r = await call(() => api.games.search(g.query, g.nextPageToken));
  if (rid !== g.requestId) return; // superseded by a new search/browse
  g.loading = false;
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
    clearLaunchFailure();
    toast(`Launched ${r.launched} client${r.launched === 1 ? '' : 's'}`, r.failed ? 'bad' : 'good');
    recordRecentGame(gameByPlaceId(placeId));
  } else presentLaunchFailure(r, () => call(() => api.launch.accounts(ids, String(placeId))));
}
