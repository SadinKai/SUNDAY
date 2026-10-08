'use strict';
function requirePackagedUiSmoke() {
  if (process.env.SUNDAY_PACKAGED_UI_SMOKE !== '1') {
    console.error('REFUSED: packaged UI smoke requires SUNDAY_PACKAGED_UI_SMOKE=1 and a fresh SUNDAY_USER_DATA directory.');
    process.exit(2);
  }
}

/* Non-disruptive UI smoke test. Attaches to a SUNDAY Launcher instance launched with
   --remote-debugging-port=9222 (use an isolated --user-data-dir so it does not
   collide with an installed SUNDAY Launcher). Verifies:
     1. Games category chips render with "All" default + counts
     2. Server modal sort chips actually reorder the list on switch
     3. Tooltip stays inside the viewport near the right edge (no clip)
   Prints JSON facts. Does not click Join or launch Roblox. */
const PORT = Number(process.env.SUNDAY_SMOKE_PORT || process.env.CDP_PORT || process.argv[2] || 9222);
const wait = ms => new Promise(r => setTimeout(r, ms));

function cdp(ws) {
  let id = 0; const pending = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  return (method, params = {}) => new Promise(res => {
    const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
}

function isSundayTarget(t) {
  if (!t || t.type !== 'page') return false;
  const url = t.url || '';
  const title = t.title || '';
  const isSundayUrl = /index\.html($|\?|#)/i.test(url)
    || /tauri:\/\//i.test(url)
    || /^https?:\/\/tauri\.localhost(?:[/:?#]|$)/i.test(url);
  const normalizedTitle = title.trim();
  const isSundayTitle = /^sunday launcher(?:\s|$)/i.test(normalizedTitle)
    || /\s[—–-]\s*sunday launcher$/i.test(normalizedTitle);
  return isSundayUrl || isSundayTitle;
}

async function main() {
  let targets;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json`);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    targets = await res.json();
  } catch (err) {
    throw new Error(
      `Unable to connect to DevTools debugging endpoint on port ${PORT}: ${err.message}. ` +
      `Ensure SUNDAY Launcher was launched with --remote-debugging-port=${PORT}`
    );
  }

  if (!Array.isArray(targets)) {
    throw new Error(`Invalid response from DevTools endpoint on port ${PORT}: expected JSON array of targets.`);
  }

  const page = targets.find(isSundayTarget);
  if (!page) {
    const pageTargets = targets
      .filter(t => t && t.type === 'page')
      .map(t => `"${t.title || 'Untitled'}" (${t.url || 'no URL'})`);
    const available = pageTargets.length > 0 ? pageTargets.join(', ') : 'none';
    throw new Error(
      `No SUNDAY Launcher application window found among DevTools targets on port ${PORT}. ` +
      `Expected a target with title "SUNDAY Launcher" or URL containing "index.html". Available page targets: [${available}].`
    );
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const send = cdp(ws);
  await send('Runtime.enable');

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  };

  // Verify that the connected target actually presents the SUNDAY Launcher application DOM
  const isSundayApp = await evalJs(`Boolean(document.querySelector('#nav') || typeof state !== 'undefined')`);
  if (!isSundayApp) {
    ws.close();
    throw new Error(
      `Connected target "${page.title}" (${page.url}) does not contain SUNDAY Launcher UI elements (#nav / state). ` +
      `Refusing to execute smoke tests on an unexpected page.`
    );
  }

  const facts = {};

  // ---- Product identity and real backend selection ----
  await evalJs(`document.querySelector('button[data-view="help"]').click()`);
  await wait(150);
  facts.branding = await evalJs(`(() => {
    const rail = document.querySelector('.rail-brand');
    const help = document.querySelector('#content');
    return {
      title: document.title,
      rail: rail ? rail.innerText.replace(/\\s+/g, ' ').trim() : null,
      about: help && help.innerText.includes('SUNDAY Launcher') && help.innerText.includes('Created by SADINKAI'),
      formerProductNameVisible: /\\bFleet\\b/.test(document.body.innerText),
    };
  })()`);
  facts.adapterSelection = await evalJs(`window.sunday.adapterSelection()`);
  facts.accountSession = await evalJs(`window.sunday.accounts.list().then(result => {
    const rows = Array.isArray(result && result.accounts) ? result.accounts : [];
    return {
      ok: result && result.ok === true,
      accountCount: rows.length,
      metadataReadable: rows.every(row => typeof row.id === 'string' && typeof row.username === 'string'),
      sessionStatusReadable: rows.every(row => typeof row.sessionExpired === 'boolean'),
    };
  })`);

  // ---- v1.8.18 default mode, explicit paste, and layout ----
  await evalJs(`document.querySelector('button[data-view="instances"]').click()`);
  await wait(150);
  facts.v1818 = await evalJs(`(() => ({
    multiInstanceBanner: /MULTI-INSTANCE MODE/.test(document.body.innerText),
    legacyDescription: /Enabled.*Uses SUNDAY.s legacy Roblox compatibility path\./s.test(document.body.innerText),
    pasteAction: Boolean(document.querySelector('[data-action="paste-roblox-link"]')),
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    selectedAdapter: state.status && state.status.adapterSelection && state.status.adapterSelection.selectedAdapter,
    installationType: state.status && state.status.robloxInstallation && state.status.robloxInstallation.installationType,
  }))()`);

  // ---- 1. Games category filter ----
  await evalJs(`document.querySelector('#nav button[data-view="games"]').click()`);
  // wait for browse() to populate
  for (let i = 0; i < 40; i++) { if (await evalJs(`(state.games.list||[]).length > 0`)) break; await wait(400); }
  await wait(300);
  facts.games = await evalJs(`(() => {
    const chips = [...document.querySelectorAll('#games-cats .cat-chip')].map(c => ({
      label: c.textContent.replace(/\\s+/g,' ').trim(), on: c.classList.contains('on'), cat: c.dataset.cat }));
    return { total: state.games.list.length, category: state.games.category, chips };
  })()`);
  // switch to the 2nd category and confirm the grid count changes to that category's count
  facts.gamesSwitch = await evalJs(`(() => {
    const g = state.games; const cats = g.categories || [];
    if (cats.length < 1) return { skipped: 'no categories' };
    const allCount = document.querySelectorAll('#games-grid .game').length;
    const target = cats[0];
    document.querySelector('#games-cats .cat-chip[data-cat="'+CSS.escape(target)+'"]').click();
    const afterCount = document.querySelectorAll('#games-grid .game').length;
    const expected = g.list.filter(x => (x.categories||[]).includes(target)).length;
    // reset to All
    document.querySelector('#games-cats .cat-chip[data-cat="All"]').click();
    return { target, allCount, afterCount, expected, matches: afterCount === expected, backToAll: document.querySelectorAll('#games-grid .game').length };
  })()`);

  // ---- 2. Server modal sort reorders ----
  const placeId = await evalJs(`(() => { const g = (state.games.list||[])[0]; return g ? String(g.placeId) : null; })()`);
  if (placeId) {
    await evalJs(`openServersModal(${JSON.stringify(placeId)}, 'Smoke Test')`);
    for (let i = 0; i < 40; i++) { if (await evalJs(`!!(state.servers && state.servers.list && state.servers.list.length)`)) break; await wait(400); }
    await wait(300);
    facts.servers = await evalJs(`(() => {
      const sv = state.servers; if (!sv) return { skipped: 'no servers state' };
      const topFor = mode => { const el = document.querySelector('.seg-chip[data-sort="'+mode+'"]'); if (el) el.click();
        const row = document.querySelector('.server-row'); return row ? row.querySelector('.server-fill strong').textContent + ' | ' + row.querySelector('.server-meta').textContent.trim() : null; };
      const best = topFor('best'); const ping = topFor('ping'); const space = topFor('space'); const players = topFor('players'); const fps = topFor('fps');
      const uniq = new Set([best, ping, space, players, fps].filter(Boolean)).size;
      return { count: sv.list.length, best, ping, space, players, fps, distinctTops: uniq,
        summary: (document.querySelector('.server-summary')||{}).textContent || null,
        hasRefresh: !!document.querySelector('[data-action="servers-refresh"]'),
        hasJoinBest: !!document.querySelector('[data-action="join-best"]') };
    })()`);
  } else {
    facts.servers = { skipped: 'no placeId' };
  }

  // ---- 3. Tooltip does not clip at the right edge ----
  facts.tooltip = await evalJs(`(() => {
    // put a data-tip button flush against the right edge and hover it
    const b = document.createElement('button');
    b.setAttribute('data-tip', 'Copy place ID');
    b.style.cssText = 'position:fixed;top:120px;right:0;width:30px;height:30px;z-index:5';
    document.body.appendChild(b);
    b.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    const tip = document.querySelector('.tip');
    const r = tip ? tip.getBoundingClientRect() : null;
    const res = { shown: tip ? tip.classList.contains('show') : false, text: tip ? tip.textContent : null,
      right: r ? Math.round(r.right) : null, viewport: window.innerWidth,
      insideViewport: r ? (r.left >= 0 && r.right <= window.innerWidth) : null };
    b.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    b.remove();
    return res;
  })()`);

  facts.jsErrors = await evalJs(`window.__err || null`);
  console.log(JSON.stringify(facts, null, 2));
  if (process.env.SUNDAY_SMOKE_CLOSE === '1') {
    await evalJs(`window.sunday.ui.window.close()`);
  }
  ws.close();
}

if (require.main === module) {
  requirePackagedUiSmoke();
  main().catch(e => { console.error('smoke failed:', e.message); process.exit(1); });
}

module.exports = { isSundayTarget };
