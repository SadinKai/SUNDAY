'use strict';

/* ----------------------------- History view ----------------------------- */
/* ----------------------------- Stats view ----------------------------- */
function fmtDur(ms) {
  if (!ms || ms < 1000) return '0m';
  const m = Math.floor(ms / 60000);
  if (m < 1) return '<1m';
  const h = Math.floor(m / 60);
  if (!h) return `${m}m`;
  const d = Math.floor(h / 24);
  if (!d) return `${h}h ${m % 60}m`;
  return `${d}d ${h % 24}h`;
}

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function hourLabel(h) {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

/* The 14-day activity chart: one column per day, height proportional to
   that day's playtime, today accented. Pure divs on the existing grid.
   Days with no playtime keep a 2px baseline stub so the week never reads
   as a gap in the axis. */
function activityChartHtml(daily) {
  const max = Math.max.apply(null, daily.map(d => d.ms));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const bars = daily.map(d => {
    const date = new Date(d.start);
    const isToday = d.start === today.getTime();
    const pct = max > 0 && d.ms > 0 ? Math.max(4, Math.round((d.ms / max) * 100)) : 0;
    const h = d.ms > 0 ? pct + '%' : '2px';
    const tip = `${DOW_SHORT[date.getDay()]} ${date.getMonth() + 1}/${date.getDate()} — ${d.ms > 0 ? fmtDur(d.ms) : 'no playtime'}`;
    return `<div class="act-col"><div class="act-bar${isToday ? ' now' : ''}" style="height:${h}" data-tip="${esc(tip)}"></div></div>`;
  }).join('');
  const labels = daily.map(d => {
    const date = new Date(d.start);
    return `<span>${DOW_SHORT[date.getDay()].slice(0, 1)}${date.getDate()}</span>`;
  }).join('');
  return `<div class="act-chart"><div class="act-bars">${bars}</div><div class="act-labels">${labels}</div></div>`;
}

function insightsLineHtml(ins) {
  if (!ins) return '';
  const parts = [];
  if (ins.peakHour != null) parts.push(`Peak hour <b>${esc(hourLabel(ins.peakHour))}</b>`);
  if (ins.busiestDayStart) {
    const d = new Date(ins.busiestDayStart);
    parts.push(`Busiest day <b>${DOW_SHORT[d.getDay()]}</b> — ${fmtDur(ins.busiestDayMs)}`);
  }
  return parts.length ? `<div class="act-foot">${parts.join('<i>·</i>')}</div>` : '';
}

views.stats = async function () {
  mount(`
    <div class="page-head"><h1>Stats</h1><p>Playtime per game and account, tracked locally from live presence.</p></div>
    <div id="stats-body"><div class="games-end"><span class="spinner dark"></span> Crunching playtime…</div></div>
  `);
  const r = await call(() => api.playtime.stats(), { ok: false });
  const root = $('#stats-body');
  if (!root || state.view !== 'stats') return;
  if (!r || !r.ok) {
    root.innerHTML = `<div class="games-state" role="alert"><strong>Stats could not load</strong><p>Your saved playtime was not changed.</p><button class="btn sm" data-action="stats-refresh">${icon('refresh')} Try again</button></div>`;
    return;
  }
  const t = r.totals || {};
  const ins = r.insights || {};
  const statCell = (label, value, sub) => `<div class="stat-cell"><div class="stat-value">${value}</div><div class="stat-label">${esc(label)}</div>${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}</div>`;
  const yesterdayMs = (r.daily || []).length >= 2 ? r.daily[r.daily.length - 2].ms : 0;
  const maxTotal = (r.perGame || []).reduce((m, g) => Math.max(m, g.totalMs), 0);
  const row = (cells, live, meterPct) => `<div class="setting stat-row"><div><div class="s-label">${live ? '<span class="pd live-dot"></span>' : ''}${esc(cells.name)}</div><div class="s-desc">${esc(cells.desc)}</div>${meterPct != null ? `<div class="stat-meter"><i style="width:${meterPct}%"></i></div>` : ''}</div>
    <div class="s-control stat-cells"><span data-tip="Today">${fmtDur(cells.today)}</span><span data-tip="Last 7 days">${fmtDur(cells.week)}</span><b data-tip="All time">${fmtDur(cells.total)}</b></div></div>`;
  const games = (r.perGame || []).slice(0, 15).map(g => row({ name: g.label, desc: `${g.sessions} session${g.sessions === 1 ? '' : 's'}`, today: g.todayMs, week: g.weekMs, total: g.totalMs }, g.live, maxTotal > 0 ? Math.max(3, Math.round((g.totalMs / maxTotal) * 100)) : null)).join('');
  const accountsRows = (r.perAccount || []).map(a => row({ name: a.label, desc: `${a.sessions} session${a.sessions === 1 ? '' : 's'}`, today: a.todayMs, week: a.weekMs, total: a.totalMs }, a.live)).join('');
  const recent = (r.recent || []).map(s => `<div class="setting stat-row"><div><div class="s-label">${s.live ? '<span class="pd live-dot"></span>' : ''}${esc(s.game)}</div>
    <div class="s-desc">${esc(s.username)} - ${new Date(s.start).toLocaleString()}</div></div><div class="s-control"><b>${fmtDur(s.ms)}</b></div></div>`).join('');
  const hasAny = (r.perGame || []).length || recent.length;
  root.innerHTML = `
    <div class="card stat-grid">
      ${statCell('Today', fmtDur(t.todayMs), yesterdayMs ? `yesterday ${fmtDur(yesterdayMs)}` : 'no playtime yesterday')}
      ${statCell('Last 7 days', fmtDur(t.weekMs), `avg ${fmtDur(Math.round((t.weekMs || 0) / 7))} / day`)}
      ${statCell('All time', fmtDur(t.totalMs), `${t.sessions || 0} sessions`)}
      ${statCell('Tracking now', String(r.tracking || 0), r.tracking ? 'accounts in game' : 'no one in game')}
      ${ins.avgMs ? statCell('Avg session', fmtDur(ins.avgMs), `${t.sessions || 0} tracked`) : ''}
      ${ins.longestMs ? statCell('Longest session', fmtDur(ins.longestMs), ins.longestGame ? ins.longestGame.slice(0, 28) : '') : ''}
    </div>
    ${hasAny && (r.daily || []).length ? `<div class="section-title">Last 14 days <span class="stat-cols">playtime per day<i class="act-key"></i>today</span></div>
      <div class="card">${activityChartHtml(r.daily)}${insightsLineHtml(ins)}</div>` : ''}
    ${games ? `<div class="section-title">By game <span class="stat-cols">today - 7 days - all time</span></div><div class="card pad">${games}</div>` : ''}
    ${accountsRows ? `<div class="section-title">By account <span class="stat-cols">today - 7 days - all time</span></div><div class="card pad">${accountsRows}</div>` : ''}
    ${recent ? `<div class="section-title">Recent sessions</span><div class="card pad">${recent}</div>` : ''}
    ${!hasAny ? `<div class="games-state"><strong>No playtime yet</strong><p>Stats build automatically while your accounts play.</p><button class="btn sm primary" data-action="goto-launch">${icon('play')} Go to Launch</button></div>` : ''}
    <div class="inline" style="margin-top:16px"><div class="spacer" style="flex:1"></div>
      <button class="btn sm" data-action="stats-refresh">${icon('refresh')} Refresh</button>
      <button class="btn sm ghost danger" data-action="stats-clear">${icon('trash')} Clear playtime data</button></div>`;
};

views.history = async function () {
  const r = await call(() => api.history.get(), { history: [] });
  if (state.view !== 'history') return; // user navigated away while loading
  state.history = (r && r.history) || [];
  const rows = state.history.length ? state.history.map(h => `
    <tr>
      <td>${esc(fmtTime(h.time))}</td>
      <td>${esc(h.profileName)}</td>
      <td><span class="pill ${esc(h.result)}">${esc(h.result)}</span></td>
      <td class="mono">${h.pid || '-'}</td>
      <td>${esc(h.message || '')}</td>
    </tr>`).join('')
    : `<tr><td colspan="5"><div class="empty" style="padding:40px"><div class="e-ico">${icon('clock')}</div><h3>No launches yet</h3><p>Your launch history will appear here.</p><button class="btn sm" data-action="goto-launch">${icon('play')} Go to Launch</button></div></td></tr>`;

  mount(`
    <div class="page-head"><h1>History</h1><p>Every launch, restart and its result.</p></div>
    <div class="row-split" style="margin-bottom:14px">
      <div class="section-title" style="margin:0">Recent activity</div>
      <button class="btn sm ghost danger" data-action="clear-history" ${state.history.length ? '' : 'disabled'}>${icon('trash')} Clear history</button>
    </div>
    <div class="card" style="overflow:hidden">
      <table class="data"><thead><tr><th>Time</th><th>Account / mode</th><th>Result</th><th>PID</th><th>Message</th></tr></thead>
      <tbody>${rows}</tbody></table>
    </div>
  `);
};
