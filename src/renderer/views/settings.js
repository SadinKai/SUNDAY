'use strict';

/* ----------------------------- Settings view ----------------------------- */
views.settings = async function () {
  if (!state.settings) {
    const r = await call(() => api.settings.get(), { settings: null });
    if (state.view !== 'settings') return; // user navigated away while loading
    state.settings = (r && r.settings) || {};
  }
  const s = state.settings;
  const st = state.status || {};
  if (!state.updater) {
    const up = await call(() => api.updater.status(), { state: 'disabled' });
    if (state.view !== 'settings') return; // user navigated away while loading
    state.updater = up && up.state ? up : { state: 'disabled' };
  }
  const up = state.updater || { state: 'disabled' };
  const busy = up.state === 'checking' || up.state === 'downloading' || up.state === 'staging' || up.state === 'applying' || up.state === 'restarting';
  const updaterEnabled = capabilityAvailable('updaterApply');
  const updateText = updaterEnabled
    ? updaterStatusText(up, st.appVersion)
    : 'Automatic updating is not available in this build. Download updates from GitHub Releases.';
  const updateActions = !updaterEnabled
    ? `<button class="btn" data-action="update-open-web">${icon('download')} View releases</button>`
    : up.state === 'ready' || up.state === 'available'
    ? `<button class="btn primary" data-action="update-install">${icon('refresh')} Install update</button>`
    : up.state === 'error'
      ? `<div class="inline" style="flex-direction:column; align-items:flex-end; gap:8px">
          <button class="btn" data-action="update-check">${icon('refresh')} Retry</button>
          <button class="btn" data-action="update-open-web" data-tip="Download the installer with your browser instead">${icon('download')} Download in browser</button>
        </div>`
      : `<button class="btn" data-action="update-check" ${busy ? 'disabled' : ''}>${icon('refresh')} Check now</button>`;
  const auto = s.autoDetect !== false;
  const multiInstancePreference = s.multiInstanceMode === true;
  const adapterSelection = st.adapterSelection || {};
  const multiInstanceActive = adapterSelection.legacyCompatEnabled === true
    && adapterSelection.selectedAdapter === 'LegacyRobloxIsolationAdapter';
  const environmentOverride = adapterSelection.legacyCompatEnvironmentEnabled === true;
  const activeFromSettings = adapterSelection.legacyCompatActivationSource === 'settings';
  const multiInstanceRestartRequired = !environmentOverride && multiInstancePreference !== activeFromSettings;
  const multiInstanceStatus = environmentOverride
    ? 'Active because SUNDAY inherited LEGACY_COMPAT=1. Remove that environment variable and restart to remove the override.'
    : multiInstanceRestartRequired
      ? `Saved as ${multiInstancePreference ? 'enabled' : 'disabled'}; restart SUNDAY to apply this change.`
      : multiInstanceActive
        ? 'Active for this SUNDAY session.'
        : 'Disabled for this SUNDAY session.';
  mount(`
    <div class="page-head"><h1>Settings</h1><p>Shape how SUNDAY behaves on this PC. Changes are saved to your user profile.</p></div>
    <div class="settings-layout">
      <nav class="settings-index" aria-label="Settings sections">
        <a href="#settings-appearance">Appearance</a>
        <a href="#settings-roblox">Roblox location</a>
        <a href="#settings-multi-instance">Multi-instance</a>
        <a href="#settings-behaviour">Behaviour</a>
        <a href="#settings-advanced">Advanced</a>
        <a href="#settings-updates">Updates</a>
      </nav>
      <div class="settings-content">
        <section class="settings-group" id="settings-appearance"><div class="settings-group-head"><h2>Appearance</h2><p>Choose how SUNDAY looks on this PC.</p></div><div class="settings-sheet">
          ${settingRow('Theme', 'Eclipse is the default. Choose Dawn or follow Windows when you want a different surface.',
            `<div class="segmented compact" id="set-theme">
              <button type="button" data-action="set-theme" data-theme="system" class="${themePref() === 'system' ? 'on' : ''}">System</button>
              <button type="button" data-action="set-theme" data-theme="light" class="${themePref() === 'light' ? 'on' : ''}">Dawn</button>
              <button type="button" data-action="set-theme" data-theme="dark" class="${themePref() === 'dark' ? 'on' : ''}">Eclipse</button>
            </div>`)}
        </div></section>

        <section class="settings-group" id="settings-roblox"><div class="settings-group-head"><h2>Roblox location</h2><p>Control how the installed player is detected.</p></div><div class="settings-sheet settings-fields">
          <div class="field">
            <label>Detection</label>
            <div class="segmented" id="set-detect" data-auto="${auto}">
              <button type="button" data-action="set-detect" data-auto="true" class="${auto ? 'on' : ''}">Auto-detect</button>
              <button type="button" data-action="set-detect" data-auto="false" class="${auto ? '' : 'on'}">Manual path</button>
            </div>
            <div class="hint">Auto-detect checks the registry and your Roblox install folder.</div>
          </div>
          <div class="field" id="set-path-row" style="${auto ? 'display:none' : ''}">
            <label for="set-path">RobloxPlayerBeta.exe path</label>
            <div class="inline"><input id="set-path" type="text" value="${esc(s.robloxPath || '')}" placeholder="Path to RobloxPlayerBeta.exe" /><button class="btn" data-action="settings-browse">${icon('folder')} Browse</button></div>
          </div>
          <div class="field" style="margin-bottom:0">
            <label>Currently detected</label>
            <div class="inline"><input type="text" readonly value="${esc(st.playerPath || 'Not found')}" /><button class="btn" data-action="redetect" data-tip="Run detection again">${icon('refresh')} Re-detect</button></div>
          </div>
        </div></section>

        <section class="settings-group" id="settings-multi-instance"><div class="settings-group-head"><h2>Multi-instance mode</h2><p>Choose whether SUNDAY may use its legacy Roblox compatibility path.</p></div><div class="settings-sheet">
          ${settingRow('Enable multi-instance mode', 'Allows up to three SUNDAY-managed clients through the existing legacy compatibility adapter. This does not bypass Roblox detection, slot ownership, or process capability checks.', `<label class="toggle"><input type="checkbox" id="set-multi-instance" aria-describedby="multi-instance-status" ${multiInstancePreference ? 'checked' : ''}><span class="track"></span></label>`)}
          <div class="settings-note" id="multi-instance-status">${esc(multiInstanceStatus)}${multiInstanceRestartRequired ? ` <button class="btn sm" data-action="app-restart">${icon('refresh')} Restart SUNDAY</button>` : ''}</div>
        </div></section>

        <section class="settings-group" id="settings-behaviour"><div class="settings-group-head"><h2>Behaviour</h2><p>Set refresh, confirmation, and local history preferences.</p></div><div class="settings-sheet">
          ${settingRow('Confirm before bulk actions', 'Ask before “End all” and “Cleanup”.', `<label class="toggle"><input type="checkbox" id="set-confirm" ${s.confirmCleanup ? 'checked' : ''}><span class="track"></span></label>`)}
          ${settingRow('Refresh interval', 'How often the active-client list updates (750-10000 ms).', `<input id="set-poll" type="number" min="750" max="10000" step="250" value="${s.pollIntervalMs}" style="width:120px">`)}
          ${settingRow('History entries to keep', 'Maximum launch-history rows stored (10-2000).', `<input id="set-historylimit" type="number" min="10" max="2000" step="10" value="${s.historyLimit}" style="width:120px">`)}
        </div></section>

        <details class="settings-advanced" id="settings-advanced"><summary><span><b>Advanced runtime controls</b><small>Currently unavailable until their runtime paths are qualified.</small></span></summary><div class="settings-sheet">
          ${settingRow('Delay between launches', 'Pause between clients in a multi-launch.', `<input id="set-delay" type="number" min="0" max="20000" step="500" value="${s.launchDelayMs}" style="width:120px" disabled>`)}
          ${settingRow('Warn above this many instances', 'Warn when a launch would exceed this many clients.', `<input id="set-warn" type="number" min="1" max="100" value="${s.warnInstanceCount}" style="width:120px" disabled>`)}
          ${settingRow('Auto-rejoin delay', 'Wait before a dropped account is rejoined.', `<input id="set-rejoin-delay" type="number" min="3" max="300" step="1" value="${s.autoRejoinDelaySec}" style="width:120px" disabled>`)}
          ${settingRow('Give up after', 'Failed rejoin attempts before SUNDAY stops retrying.', `<input id="set-rejoin-tries" type="number" min="1" max="20" step="1" value="${s.autoRejoinMaxAttempts}" style="width:120px" disabled>`)}
          ${settingRow('Restart a stuck client after', '0 disables automatic restart.', `<input id="set-hung" type="number" min="0" max="120" step="5" value="${s.autoRestartHungSec}" style="width:120px" disabled>`)}
        </div></details>

        <section class="settings-group" id="settings-updates"><div class="settings-group-head"><h2>Updates</h2><p>Read current update capability and recovery options.</p></div><div class="settings-sheet">
          ${settingRow('Automatic updates', updateText, updateActions, 'update-status-line')}
          <div class="settings-note">SUNDAY does not install updates automatically. Review release notes and checksums on GitHub before downloading a newer version.</div>
        </div></section>

        <div class="settings-savebar">
          <button class="btn primary" data-action="settings-save">${icon('check')} Save settings</button>
          <button class="btn" data-action="settings-reset">Reset to defaults</button>
          <div class="spacer"></div>
          <button class="btn ghost" data-action="open-userdata">${icon('folder')} Open data folder</button>
        </div>
      </div>
    </div>
  `);
  const statusLine = document.getElementById('update-status-line');
  if (statusLine) statusLine.dataset.upstate = up.state;
};
function settingRow(label, desc, control, descId) {
  return `<div class="setting"><div><div class="s-label">${esc(label)}</div><div class="s-desc" ${descId ? `id="${descId}"` : ''}>${esc(desc)}</div></div>
    <div class="s-control">${control}</div></div>`;
}

/* Updater status line — shared by the settings render and live progress patches. */
function updaterStatusText(up, appVersion) {
  if (up.state === 'unavailable') return up.error || 'Automatic updates are unavailable.';
  if (up.state === 'ready' || up.state === 'available') return `Version ${up.latestVersion || up.availableVersion || 'update'} is available — install it automatically`;
  if (up.state === 'downloading') {
    if (up.total) return `Downloading update — ${fmtBytes(up.received)} of ${fmtBytes(up.total)}${up.percent != null ? ` (${up.percent}%)` : ''}`;
    return 'Downloading update…';
  }
  if (up.state === 'restarting') return 'Update installed — restarting SUNDAY Launcher';
  if (up.state === 'applying') return 'Installing the new files — SUNDAY Launcher stays open';
  if (up.state === 'staging') return 'Unpacking the update…';
  if (up.state === 'checking') return 'Checking for updates…';
  if (up.state === 'error') return `Update failed: ${up.error || 'unknown error'}`;
  if (up.state === 'disabled') return 'Automatic updates activate in the installed version';
  return `SUNDAY Launcher ${appVersion || ''} is up to date`;
}
function currentSettingsDraft() {
  const auto = $('#set-detect').dataset.auto === 'true';
  return {
    autoDetect: auto,
    robloxPath: $('#set-path') ? $('#set-path').value.trim() : (state.settings.robloxPath || ''),
    multiInstanceMode: $('#set-multi-instance').checked,
    confirmCleanup: $('#set-confirm').checked,
    pollIntervalMs: parseInt($('#set-poll').value, 10),
    launchDelayMs: parseInt($('#set-delay').value, 10),
    warnInstanceCount: parseInt($('#set-warn').value, 10),
    historyLimit: parseInt($('#set-historylimit').value, 10),
    autoRejoinDelaySec: parseInt($('#set-rejoin-delay').value, 10),
    autoRejoinMaxAttempts: parseInt($('#set-rejoin-tries').value, 10),
    autoRestartHungSec: parseInt($('#set-hung').value, 10),
  };
}

async function saveSettings() {
  const partial = currentSettingsDraft();
  const r = await call(() => api.settings.save(partial));
  if (r && r.ok) {
    state.settings = r.settings;
    await refreshStatus();
    views.settings();
    if (r.restartRequired) await offerSettingsRestart(r.settings.multiInstanceMode === true);
    else toast('Settings saved', 'good');
  }
  else toast((r && r.error) || 'Could not save settings', 'bad');
}

async function restartApplication() {
  toast('Restarting SUNDAY…', 'good');
  const result = await call(() => api.restart());
  if (!(result && result.ok)) toast((result && result.error) || 'SUNDAY could not restart itself. Close and reopen it to apply the setting.', 'bad');
}

async function offerSettingsRestart(enabled) {
  const confirmed = await confirmDialog({
    title: 'Restart SUNDAY now?',
    body: `Multi-instance mode is saved as ${enabled ? 'enabled' : 'disabled'}. Restart SUNDAY to apply the change.`,
    confirmText: 'Restart now',
  });
  if (confirmed) await restartApplication();
  else toast('Setting saved — restart SUNDAY when you are ready');
}
