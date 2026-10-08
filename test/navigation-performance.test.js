'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { performance } = require('perf_hooks');

const root = path.join(__dirname, '..');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

function gamesContext(api) {
  const state = {
    view: 'help',
    games: {
      list: [], query: '', nextPageToken: null, loading: false, error: null, loaded: false,
      sort: 'players', hideEmpty: false, categories: [], category: 'All', requestId: 0, refreshedAt: 0,
    },
    accounts: [],
  };
  const context = vm.createContext({
    AbortController,
    Array,
    Date,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    URL,
    api,
    call: work => work(),
    clearTimeout,
    console,
    document: { querySelector() { return null; } },
    esc: value => String(value == null ? '' : value),
    fmtDur: value => String(value),
    fmtNum: value => String(value),
    icon: () => '',
    localStorage: { getItem: () => null, setItem() {} },
    mount() {},
    setTimeout,
    state,
    views: {},
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'renderer', 'views', 'games.js'), 'utf8'), context);
  return { context, state };
}

function peopleContext(api) {
  const state = {
    view: 'help',
    people: {
      route: 'friends', filter: 'all', sort: 'status', filterText: '',
      list: [], page: 0, pageSize: 12, total: 0, hasNext: false, hasPrev: false,
      loading: false, error: null, loaded: false, requestId: 0, refreshedAt: 0,
      search: {}, detail: {},
    },
  };
  const context = vm.createContext({
    Array,
    Date,
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    RegExp,
    Set,
    String,
    api,
    call: work => work(),
    clearTimeout,
    console,
    document: { querySelector() { return null; } },
    $: () => null,
    esc: value => String(value == null ? '' : value),
    icon: () => '',
    mount() {},
    setTimeout,
    state,
    views: { people() {} },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'renderer', 'views', 'people.js'), 'utf8'), context);
  return { context, state };
}

test('cold startup paints Launch before local hydration and strict Roblox discovery', async () => {
  const local = [deferred(), deferred(), deferred(), deferred()];
  const status = deferred();
  const events = [];
  const state = { view: 'instances', accounts: [], status: null, statusLoading: true };
  const context = vm.createContext({
    api: {},
    content: { innerHTML: '' },
    document: { querySelector: () => null },
    loadAccounts: () => { events.push('accounts:start'); return local[1].promise; },
    loadInstances: () => { events.push('instances:start'); return local[0].promise; },
    loadLaunchPlans: () => { events.push('plans:start'); return local[3].promise; },
    loadWatchdog: () => { events.push('watchdog:start'); return local[2].promise; },
    localStorage: { getItem: () => null },
    refreshStatus: () => {
      events.push('status:start');
      return status.promise.then(() => { state.status = { ok: true, appVersion: '1.8.18' }; });
    },
    setView: name => { state.view = name; events.push(`shell:${name}`); },
    state,
    toast() {},
    updateLaunchRuntimeStatus: () => events.push('status:patched'),
    views: {
      accounts: () => events.push('accounts:hydrated'),
      instances: () => events.push('instances:hydrated'),
    },
  });
  const source = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
  const started = performance.now();
  const boot = vm.runInContext(source, context);
  const synchronousMs = performance.now() - started;

  assert.equal(events[0], 'shell:instances');
  assert.ok(synchronousMs < 100, `local shell took ${synchronousMs.toFixed(1)}ms`);
  assert.deepEqual(events.slice(1), ['instances:start', 'accounts:start', 'watchdog:start', 'plans:start']);
  assert.equal(events.includes('status:start'), false);

  for (const pending of local) pending.resolve();
  await nextTurn();
  assert.equal(events.includes('instances:hydrated'), true);
  assert.equal(events.at(-1), 'status:start');

  status.resolve();
  await boot;
  assert.equal(state.statusLoading, false);
  assert.equal(events.at(-1), 'status:patched');
});

test('Games keeps cached content, shares duplicate browse work, and only the newest caller commits', async () => {
  let browseCalls = 0;
  const first = deferred();
  const { context, state } = gamesContext({
    games: {
      browse: () => { browseCalls += 1; return first.promise; },
      search: async () => ({ ok: true, games: [], categories: [], nextPageToken: null }),
    },
    playtime: { stats: async () => ({ ok: true, perGame: [] }) },
  });
  state.games.list = [{ placeId: 1, universeId: 1, name: 'Cached' }];
  state.games.loaded = true;

  const one = vm.runInContext('gamesBrowse(false)', context);
  const two = vm.runInContext('gamesBrowse(false)', context);
  assert.equal(browseCalls, 1);
  assert.equal(state.games.list[0].name, 'Cached');
  assert.equal(state.games.loading, true);

  first.resolve({ ok: true, games: [{ placeId: 2, universeId: 2, name: 'Fresh' }], categories: ['Popular'], nextPageToken: null });
  await Promise.all([one, two]);
  assert.equal(state.games.list[0].name, 'Fresh');
  assert.deepEqual(Array.from(state.games.categories), ['Popular']);
});

test('late Games browse response cannot overwrite a newer search response', async () => {
  const browse = deferred();
  const search = deferred();
  const { context, state } = gamesContext({
    games: { browse: () => browse.promise, search: () => search.promise },
    playtime: { stats: async () => ({ ok: true, perGame: [] }) },
  });

  const older = vm.runInContext('gamesBrowse(true)', context);
  const newer = vm.runInContext("doGamesSearch('new')", context);
  search.resolve({ ok: true, games: [{ placeId: 3, universeId: 3, name: 'New result' }], categories: [], nextPageToken: null });
  await newer;
  browse.resolve({ ok: true, games: [{ placeId: 4, universeId: 4, name: 'Old result' }], categories: [], nextPageToken: null });
  await older;

  assert.equal(state.games.list[0].name, 'New result');
  assert.equal(state.games.query, 'new');
});

test('stale Games pagination cannot clear a newer search loading state', async () => {
  const more = deferred();
  const search = deferred();
  const { context, state } = gamesContext({
    games: {
      search: (_query, pageToken) => pageToken ? more.promise : search.promise,
      browse: async () => ({ ok: true, games: [], categories: [], nextPageToken: null }),
    },
    playtime: { stats: async () => ({ ok: true, perGame: [] }) },
  });
  state.games.query = 'old';
  state.games.list = [{ placeId: 1, universeId: 1, name: 'Old page' }];
  state.games.nextPageToken = 'old-page-2';
  state.games.loaded = true;

  const older = vm.runInContext('gamesLoadMore()', context);
  const newer = vm.runInContext("doGamesSearch('new')", context);
  more.resolve({ ok: true, games: [{ placeId: 2, universeId: 2, name: 'Stale page' }], nextPageToken: null });
  await older;

  assert.equal(state.games.loading, true);
  search.resolve({ ok: true, games: [{ placeId: 3, universeId: 3, name: 'New result' }], categories: [], nextPageToken: null });
  await newer;
  assert.equal(state.games.loading, false);
  assert.equal(state.games.list[0].name, 'New result');
});

test('an older same-user profile response cannot overwrite a newer request', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const { context, state } = peopleContext({
    people: {
      profile: () => (++calls === 1 ? first.promise : second.promise),
    },
  });
  state.view = 'help';

  const older = vm.runInContext('openPerson(42)', context);
  const newer = vm.runInContext('openPerson(42)', context);
  second.resolve({ ok: true, profile: { userId: 42, displayName: 'New profile' } });
  await newer;
  first.resolve({ ok: true, profile: { userId: 42, displayName: 'Old profile' } });
  await older;

  assert.equal(state.people.detail.profile.displayName, 'New profile');
});

test('People keeps stale friends visible and suppresses duplicate refresh requests', async () => {
  let calls = 0;
  const response = deferred();
  const { context, state } = peopleContext({
    people: { list: () => { calls += 1; return response.promise; } },
  });
  state.people.list = [{ userId: 1, displayName: 'Cached friend' }];
  state.people.loaded = true;

  const first = vm.runInContext('loadPeople(0, true)', context);
  const duplicate = vm.runInContext('loadPeople(0, true)', context);
  assert.equal(calls, 1);
  assert.equal(state.people.list[0].displayName, 'Cached friend');

  response.resolve({ ok: false, error: 'temporary failure' });
  await Promise.all([first, duplicate]);
  assert.equal(state.people.list[0].displayName, 'Cached friend');
  assert.equal(state.people.error, 'temporary failure');
});

test('People first-load failure renders once without an automatic retry loop', async () => {
  let calls = 0;
  const { context, state } = peopleContext({
    people: { list: async () => { calls += 1; return { ok: false, error: 'Add an account to load friends.' }; } },
  });
  context.views.people = () => vm.runInContext('renderFriendsPage()', context);

  await vm.runInContext('loadPeople(0, false)', context);
  await nextTurn();

  assert.equal(calls, 1);
  assert.equal(state.people.loaded, true);
  assert.equal(state.people.loading, false);
  assert.equal(state.people.error, 'Add an account to load friends.');
});

test('Games response cache has bounded TTL policy, bounded size, and shared in-flight work', async () => {
  const { sharedRequest, RESPONSE_CACHE_MAX, RESPONSE_CACHE_TTL_MS } = require('../src/main/games').__test;
  assert.equal(RESPONSE_CACHE_MAX, 50);
  assert.equal(RESPONSE_CACHE_TTL_MS, 2 * 60 * 1000);

  const prefix = `navigation-${process.pid}-${Date.now()}`;
  let loads = 0;
  const pending = deferred();
  const a = sharedRequest(`${prefix}:shared`, false, () => { loads += 1; return pending.promise; });
  const b = sharedRequest(`${prefix}:shared`, false, () => { loads += 1; return pending.promise; });
  await nextTurn();
  assert.equal(loads, 1);
  pending.resolve({ ok: true, value: 'shared' });
  await Promise.all([a, b]);
  assert.equal((await sharedRequest(`${prefix}:shared`, false, () => { loads += 1; return Promise.resolve({ ok: true }); })).cached, true);
  assert.equal(loads, 1);

  for (let index = 0; index <= RESPONSE_CACHE_MAX; index += 1) {
    await sharedRequest(`${prefix}:bounded:${index}`, false, async () => ({ ok: true, index }));
  }
  let reloaded = false;
  await sharedRequest(`${prefix}:bounded:0`, false, async () => { reloaded = true; return { ok: true }; });
  assert.equal(reloaded, true);
});

test('packaged profiler covers cold and warm navigation for every requested surface', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'profile-packaged-navigation.mjs'), 'utf8');
  for (const measurement of [
    'launchCold', 'launchWarm', 'accountsCold', 'accountsWarm',
    'peopleCold', 'peopleWarm', 'friendsCold', 'friendsWarm', 'gamesCold', 'gamesWarm',
  ]) assert.match(source, new RegExp(`\\b${measurement}\\b`));
  assert.match(source, /clickToShellMs/);
  assert.match(source, /clickToFirstContentMs/);
  assert.match(source, /clickToFinalContentMs/);
});

test('packaged Games refresh forwards the force flag through Rust to the backend', () => {
  const bridge = fs.readFileSync(path.join(root, 'src', 'renderer', 'tauri-bridge.js'), 'utf8');
  const rust = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'lib.rs'), 'utf8');
  const backend = fs.readFileSync(path.join(root, 'src', 'main', 'tauri-backend.js'), 'utf8');
  assert.match(bridge, /games_browse', \{ force: force === true \}/);
  assert.match(rust, /games_browse, "games_browse", \(force: Option<bool>\), json!\(\{ "force": force \}\)/);
  assert.match(backend, /async games_browse\(payload\)[\s\S]*force: !!\(payload && payload\.force\)/);
});

test('account mutations invalidate People data and removal disarms keeper intent', () => {
  const backend = fs.readFileSync(path.join(root, 'src', 'main', 'tauri-backend.js'), 'utf8');
  assert.match(backend, /async accounts_add_cookie\(payload\)[\s\S]*result\.ok\) people\.invalidateFriends\(\)/);
  assert.match(backend, /async accounts_remove\(payload\)[\s\S]*keeper\.disarm\(accountId, 'account removed'\)[\s\S]*people\.invalidateFriends\(\)/);
});
