'use strict';

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

// Launch requests mutate external process state after they cross the bridge.
// Keep the renderer correlated with the authoritative completion response so a
// presentation timeout cannot invite a duplicate retry while work continues.
let launchMutationPending = false;
let launchResultUnresolved = false;
function unresolvedLaunchResult(reason) {
  return {
    ok: false,
    unresolved: true,
    failureCode: 'LAUNCH_RESULT_UNKNOWN',
    error: String(reason || 'A launch request is still pending. Wait for it to finish or inspect Launch Plans and Diagnostics before trying again.'),
    actions: ['VIEW_DIAGNOSTICS'],
  };
}
async function callLaunch(fn) {
  if (launchResultUnresolved) {
    return unresolvedLaunchResult('The result of an earlier launch request is unknown. Inspect Launch Plans and Diagnostics before starting another launch.');
  }
  if (launchMutationPending) return unresolvedLaunchResult();
  launchMutationPending = true;
  try {
    if (!api) throw new Error('SUNDAY Launcher bridge unavailable (run inside the SUNDAY Launcher app).');
    return await Promise.resolve().then(fn);
  } catch (_) {
    launchResultUnresolved = true;
    return unresolvedLaunchResult('The launch connection ended before SUNDAY received a completion result. The launch may still have changed process state; do not retry until Launch Plans and Diagnostics are checked.');
  } finally {
    launchMutationPending = false;
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
