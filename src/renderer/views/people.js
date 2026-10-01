'use strict';

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
