'use strict';

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
        ${kv('Multi-instance', g.multiInstance)}${kv('LEGACY_COMPAT process value', g.legacyCompatEnvironmentValue)}${kv('Saved preference', g.legacyCompatSettingEnabled)}${kv('Activation source', g.legacyCompatActivationSource)}${kv('legacyCompatEnabled', g.legacyCompatEnabled)}${kv('selectedAdapter', g.selectedAdapter)}${kv('isolationState', g.isolationState)}${kv('isolation reason', g.isolationReason)}${kv('Guard', g.guard)}
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
