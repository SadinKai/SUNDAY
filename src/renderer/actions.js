'use strict';

/* ----------------------------- Action dispatch ----------------------------- */
document.addEventListener('click', async (e) => {
  const elAction = e.target.closest('[data-action]');
  if (!elAction) return;
  const action = elAction.dataset.action;
  const pid = elAction.dataset.pid ? parseInt(elAction.dataset.pid, 10) : null;
  const capability = elAction.dataset.capability || '';
  const id = elAction.dataset.id;

  if (['end-all', 'cleanup', 'arrange'].includes(action)) {
    toast('Broad process actions are disabled.', 'bad');
    return;
  }
  if (['update-check', 'update-install'].includes(action) && !capabilityAvailable('updaterApply')) {
    toast('Automatic updates are unavailable.', 'bad');
    return;
  }
  if (['create-account', 'create-account-submit'].includes(action)) {
    toast('Automated account creation is unavailable.', 'bad');
    return;
  }

  switch (action) {
    case 'step': {
      const inp = document.getElementById(elAction.dataset.target);
      if (inp) {
        const min = parseInt(inp.min, 10) || 1, max = parseInt(inp.max, 10) || 99;
        inp.value = Math.max(min, Math.min(max, (parseInt(inp.value, 10) || min) + parseInt(elAction.dataset.dir, 10)));
        // Let live listeners (the creator's count) react to stepped values.
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
      break;
    }
    case 'goto-settings': setView('settings'); break;
    case 'goto-diagnostics': setView('diagnostics'); break;
    case 'goto-accounts': setView('accounts'); break;
    case 'goto-launch': setView('instances'); break;
    case 'retry-last-launch': {
      if (!retryLastLaunch) break;
      elAction.disabled = true;
      const retry = retryLastLaunch;
      const r = await retry();
      if (r && r.ok) {
        clearLaunchFailure();
        toast(`Launched ${r.launched || 1} client${(r.launched || 1) === 1 ? '' : 's'}`, 'good');
        await loadInstances();
        if (state.view === 'instances') views.instances();
      } else presentLaunchFailure(r, retry);
      break;
    }

    case 'watch-toggle': {
      const watching = toggleWatch(elAction.dataset.user, elAction.dataset.name);
      if (watching === true) toast(`Watching ${elAction.dataset.name} for game activity`, 'good');
      else if (watching === false) toast('Stopped watching ' + (elAction.dataset.name || 'user'));
      // Refresh eye buttons in place (cards + profile hero) without a re-render.
      document.querySelectorAll(`[data-action="watch-toggle"][data-user="${CSS.escape(String(elAction.dataset.user))}"]`).forEach(btn => {
        const on = watching === true;
        btn.classList.toggle('on', on);
        if (btn.classList.contains('icon')) btn.setAttribute('data-tip', on ? 'Stop watching' : 'Watch for game activity');
        else { btn.innerHTML = `${icon('eye')} ${on ? 'Watching' : 'Watch'}`; }
      });
      break;
    }

    case 'launch-mode': {
      state.launchMode = elAction.dataset.mode;
      $('#launch-mode').querySelectorAll('button').forEach(b => {
        const active = b.dataset.mode === state.launchMode;
        b.classList.toggle('on', active);
        b.setAttribute('aria-pressed', String(active));
      });
      $('#lp-account').style.display = state.launchMode === 'account' ? '' : 'none';
      $('#lp-plain').style.display = state.launchMode === 'plain' ? '' : 'none';
      const accountOptions = $('#launch-account-options');
      if (accountOptions) accountOptions.style.display = state.launchMode === 'account' ? '' : 'none';
      break;
    }
    case 'toggle-account': {
      if (state.selected.has(id)) state.selected.delete(id);
      else if (state.selected.size >= (legacyCompatibilityMode() ? 3 : 1)) {
        toast('Normal mode launches one account. Enable Multi-instance mode in Settings for up to three.', 'bad');
        break;
      }
      else state.selected.add(id);
      // update chip + card states without full re-render
      findAllByData(document, 'id', id).filter(el => el.classList.contains('chip') || el.classList.contains('roster-account')).forEach(c => {
        c.classList.toggle('on', state.selected.has(id));
        c.setAttribute('aria-pressed', String(state.selected.has(id)));
      });
      findAllByData(document, 'id', id).filter(el => el.classList.contains('acct')).forEach(c => {
        c.classList.toggle('selected', state.selected.has(id));
        const check = c.querySelector('.check');
        if (check) check.setAttribute('aria-pressed', String(state.selected.has(id)));
      });
      updateLaunchCount();
      if (state.view === 'accounts') updateAccountsLaunchButton();
      break;
    }
    case 'launch-quick': {
      const inp = $('#launch-count');
      const n = Math.max(1, Math.min(3, parseInt(inp && inp.value, 10) || 1));
      if (state.settings && n > state.settings.warnInstanceCount) {
        const ok = await confirmDialog({ title: 'Prepare ' + n + ' operations?', body: 'That is more than your warning threshold of ' + state.settings.warnInstanceCount + '. Continue?', confirmText: 'Prepare' });
        if (!ok) break;
      }
      elAction.disabled = true;
      const r = await call(() => api.launch.quick(n));
      elAction.disabled = false;
      if (handlePreparedPlan(r)) break;
      if (r && r.ok) { clearLaunchFailure(); toast(`Launched ${r.launched} client${r.launched === 1 ? '' : 's'}` + (r.failed ? `, ${r.failed} failed` : ''), 'good'); }
      else presentLaunchFailure(r, () => call(() => api.launch.quick(n)));
      break;
    }
    case 'launch-accounts': case 'launch-selected': {
      const ids = Array.from(state.selected);
      if (!ids.length) { toast('Select at least one account', 'bad'); break; }
      const placeEl = $('#lp-place');
      const raw = placeEl ? placeEl.value.trim() : state.placeId;
      const target = parseRobloxTarget(raw);
      if (target.invalid) { toast('Paste a Roblox game link or a numeric place ID', 'bad'); break; }
      state.placeId = raw;
      elAction.disabled = true;
      const r = target.gameId && target.placeId
        ? await call(() => api.launch.join(ids, target.placeId, target.gameId))
        : await call(() => api.launch.accounts(ids, target.placeId));
      elAction.disabled = false;
      if (handlePreparedPlan(r)) break;
      if (r && r.ok) {
        clearLaunchFailure();
        toast(`Launched ${r.launched} client${r.launched === 1 ? '' : 's'}` + (target.gameId ? ' into the exact server' : '') + (r.failed ? `, ${r.failed} failed` : ''), r.failed ? 'bad' : 'good');
        const ka = $('#lp-keepalive');
        if (ka && ka.checked && target.placeId) {
          armWatchdog(ids.map(id => ({ accountId: id, placeId: target.placeId, gameInstanceId: target.gameId, name: 'the game' })));
          toast('Watchdog enabled — dropped clients rejoin automatically', 'good');
        }
      } else presentLaunchFailure(r, () => target.gameId && target.placeId
        ? call(() => api.launch.join(ids, target.placeId, target.gameId))
        : call(() => api.launch.accounts(ids, target.placeId)));
      break;
    }
    case 'launch-account': {
      const r = await call(() => api.launch.accounts([id], ''));
      if (handlePreparedPlan(r)) break;
      if (r && r.ok) { clearLaunchFailure(); toast('Launched ' + (r.launched) + ' client', 'good'); }
      else presentLaunchFailure(r, () => call(() => api.launch.accounts([id], '')));
      break;
    }
    case 'follow-account': {
      openFollowDialog(id);
      break;
    }
    case 'toggle-follow-account': {
      if (state.following || id === state.followTargetId) break;
      if (state.followSelected.has(id)) state.followSelected.delete(id);
      else if (state.followSelected.size >= (legacyCompatibilityMode() ? 3 : 1)) { toast('Normal mode launches one account. Enable Multi-instance mode for up to three.', 'bad'); break; }
      else state.followSelected.add(id);
      renderFollowDialog();
      break;
    }
    case 'follow-confirm': {
      if (state.following || !state.followTargetId || !state.followSelected.size) break;
      const targetId = state.followTargetId;
      const followerIds = Array.from(state.followSelected).filter(accountId => accountId !== targetId);
      if (!followerIds.length) { toast('Choose at least one other account', 'bad'); break; }
      state.following = true;
      renderFollowDialog();
      const r = await call(() => api.accounts.follow(targetId, followerIds));
      state.following = false;
      if (handlePreparedPlan(r)) {
        closeFollowDialog();
        break;
      }
      if (r && r.ok) {
        clearLaunchFailure();
        const targetName = r.targetDisplayName || r.targetUsername || 'account';
        closeFollowDialog();
        toast(`Joined ${targetName} with ${r.launched} account${r.launched === 1 ? '' : 's'}` + (r.failed ? `, ${r.failed} failed` : ''), r.failed ? 'bad' : 'good');
      } else {
        const firstFailure = r && r.results && r.results.find(result => !result.ok);
        renderFollowDialog();
        toast((r && r.error) || (firstFailure && firstFailure.reason) || 'Could not follow that account', 'bad');
      }
      break;
    }

    case 'create-account': {
      openCreateAccountModal();
      break;
    }
    case 'create-gender': {
      const d = state.createDraft;
      if (!d || d.submitting) break;
      d.gender = CREATE_GENDERS.includes(elAction.dataset.g) ? elAction.dataset.g : 'Skip';
      const seg = $('#create-gender');
      if (seg) Array.from(seg.querySelectorAll('button')).forEach(b => b.classList.toggle('on', b.dataset.g === d.gender));
      break;
    }
    case 'create-pick-user': {
      const d = state.createDraft;
      if (!d || d.submitting) break;
      const name = /^[A-Za-z0-9_]{3,20}$/.test(String(elAction.dataset.u || '')) ? String(elAction.dataset.u) : '';
      if (!name) break;
      d.username = name;
      d.check = null;
      d.suggest = [];
      d.suggestFor = '';
      const input = $('#create-username');
      if (input) input.value = name;
      renderCreateSuggestions();
      updateCreateValidation();
      scheduleCreateUsernameCheck();
      break;
    }
    case 'create-gen-pass': {
      const d = state.createDraft;
      if (!d || d.submitting) break;
      const pass = generateCreatePassword();
      d.password = pass;
      d.confirm = pass;
      const p = $('#create-password');
      const c = $('#create-confirm');
      if (p) p.value = pass;
      if (c) c.value = pass;
      updateCreateValidation();
      break;
    }
    case 'create-toggle-pass': {
      const d = state.createDraft;
      if (!d) break;
      d.showPass = !d.showPass;
      const pass = $('#create-password');
      const confirm = $('#create-confirm');
      if (pass) pass.type = d.showPass ? 'text' : 'password';
      if (confirm) confirm.type = d.showPass ? 'text' : 'password';
      elAction.dataset.tip = d.showPass ? 'Hide password' : 'Show password';
      break;
    }
    case 'create-account-submit': {
      const d = state.createDraft;
      if (!d || d.submitting || state.creatingAccount) break;
      const errors = createValidationErrors(d);
      if (Object.keys(errors).length || (d.check && d.check.available === false)) { updateCreateValidation(); break; }

      const payload = {
        username: String(d.username || '').trim(),
        password: String(d.password || ''),
        birthday: String(d.birthday || ''),
        gender: d.gender,
      };

      d.submitting = true;
      saveCreateDefaults(d);
      state.creatingAccount = true;
      const btn = $('#create-submit');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> Opening Roblox…';
      }

      closeCreateModal();
      if (state.view === 'accounts') views.accounts();
      toast('Opening Roblox sign-up — solve the captcha when it appears');
      const r = await call(() => api.accounts.create({
        username: payload.username,
        password: payload.password,
        birthday: payload.birthday,
        gender: payload.gender,
      }), undefined, 0);
      state.creatingAccount = false;
      if (r && r.ok) {
        await loadAccounts();
        toast((r.updated ? 'Account updated: ' : 'Account created: ') + (r.account ? r.account.username : ''), 'good');
      } else if (r && r.canceled) {
        toast('Sign-up canceled');
      } else {
        toast((r && r.error) || 'Could not create the account', 'bad');
      }
      if (state.view === 'accounts') views.accounts();
      break;
    }

    case 'add-account': {
      if (state.addingAccount) break;
      state.addingAccount = true;
      if (state.view === 'accounts') views.accounts();
      toast('Opening Roblox sign-in…');
      const r = await call(() => api.accounts.add(), undefined, 0);
      state.addingAccount = false;
      if (r && r.ok) { await loadAccounts(); toast((r.updated ? 'Account updated: ' : 'Account added: ') + (r.account ? r.account.username : ''), 'good'); }
      else if (r && r.canceled) toast('Sign-in canceled');
      else if (r && r.unavailable) toast(r.error || 'Account sign-in is unavailable in this build', 'bad');
      else toast((r && r.error) || 'Could not add account', 'bad');
      if (state.view === 'accounts') views.accounts();
      break;
    }
    case 'reauth-account': {
      if (state.addingAccount) break;
      state.addingAccount = true;
      if (state.view === 'accounts') views.accounts();
      toast('Opening Roblox sign-in…');
      const r = await call(() => api.accounts.add(), undefined, 0);
      state.addingAccount = false;
      if (r && r.ok) {
        await loadAccounts();
        toast('Signed in again: ' + (r.account ? r.account.username : ''), 'good');
      } else if (r && r.canceled) toast('Sign-in canceled');
      else if (r && r.unavailable) toast(r.error || 'Account sign-in is unavailable in this build', 'bad');
      else toast((r && r.error) || 'Could not sign in again', 'bad');
      if (state.view === 'accounts') views.accounts();
      break;
    }
    case 'remove-account': {
      const acc = state.accounts.find(a => a.id === id);
      const ok = await confirmDialog({ title: 'Remove account?', body: 'Remove “' + (acc ? acc.username : '') + '” from SUNDAY Launcher? This deletes its stored session on this PC.', confirmText: 'Remove', danger: true });
      if (!ok) break;
      const r = await call(() => api.accounts.remove(id));
      if (r && r.ok) {
        state.selected.delete(id);
        state.accounts = r.accounts; updateAccountsCount(); views.accounts(); toast('Account removed', 'good');
      } else {
        toast((r && r.error) || 'Could not remove the account', 'bad');
      }
      break;
    }
    case 'refresh-account': {
      const r = await call(() => api.accounts.refresh(id));
      if (r && r.ok) { state.accounts = r.accounts; patchAccountGrid(state.accounts); updateAccountsCount(); toast('Refreshed', 'good'); }
      break;
    }
    case 'refresh-accounts': {
      toast('Refreshing accounts…');
      const r = await call(() => api.accounts.refresh(undefined, true));
      if (r && r.ok) { state.accounts = r.accounts; state.accountsRefreshedAt = Date.now(); patchAccountGrid(state.accounts); updateAccountsCount(); toast('Accounts refreshed', 'good'); }
      break;
    }

    case 'refresh-games': gamesBrowse(); break;
    case 'redetect-from-launch': {
      const detected = await call(() => api.detect(), { ok: false, found: false });
      await refreshStatus();
      if (state.view === 'instances') views.instances();
      toast(detected && detected.found ? `${detected.displayName || 'Roblox'} detected` : 'No verified Roblox installation was found', detected && detected.found ? 'good' : 'bad');
      break;
    }
    case 'random-game': {
      const list = visibleGames();
      if (!list.length) { toast('Load games first', 'bad'); break; }
      const gm = list[Math.floor(Math.random() * list.length)];
      joinPlace(gm.placeId, gm.name);
      break;
    }
    case 'games-category':
      state.games.category = elAction.dataset.cat || 'All';
      renderGamesCategories();
      renderGamesGrid();
      break;
    case 'toggle-fav': {
      const gm = gameByPlaceId(elAction.dataset.place);
      if (!gm) break;
      const added = toggleFav(gm);
      toast(added ? 'Saved to favorites' : 'Removed from favorites', 'good');
      renderGamesCategories();
      renderGamesGrid();
      break;
    }
    case 'paste-roblox-link': {
      const result = await call(() => api.ui.clipboard(), { ok: false, text: '', error: 'Clipboard text could not be read.' });
      if (!result || !result.ok) {
        toast((result && result.error) || 'Clipboard text could not be read.', 'bad');
        break;
      }
      const text = String(result.text || '').trim();
      const target = parseRobloxTarget(text);
      if (!target.placeId) {
        toast('The clipboard does not contain a Roblox game link or Place ID.', 'bad');
        break;
      }
      state.placeId = text;
      const inp = $('#lp-place');
      if (inp) { inp.value = text; inp.focus(); }
      updateLaunchReview();
      toast('Link loaded — choose accounts and launch', 'good');
      break;
    }
    case 'keepalive-off':
      await call(() => api.keeper.disarmAll());
      toast('Watchdog stopped', 'good');
      break;
    case 'stats-refresh': views.stats(); break;
    case 'stats-clear': {
      const ok = await confirmDialog({ title: 'Clear playtime data?', body: 'All recorded sessions are deleted from this PC. This cannot be undone.', confirmText: 'Clear', danger: true });
      if (!ok) break;
      await call(() => api.playtime.clear());
      playedCache.at = 0; playedCache.map = new Map();   // drop the Games-grid chips too
      toast('Playtime data cleared', 'good');
      views.stats();
      break;
    }
    case 'set-theme':
      setThemePref(elAction.dataset.theme || 'system');
      if (state.view === 'settings') views.settings();
      break;
    case 'session-save': {
      const ids = Array.from(state.selected);
      if (!ids.length) { toast('Select the accounts to include first', 'bad'); break; }
      const placeEl = $('#lp-place');
      const target = parseRobloxTarget(placeEl ? placeEl.value.trim() : state.placeId);
      if (target.invalid) { toast('Paste a Roblox game link or a numeric place ID', 'bad'); break; }
      state.sessionDraft = {
        accountIds: ids.filter(id => state.accounts.some(account => account.id === id)),
        placeId: target.placeId,
        gameId: target.gameId,
      };
      openModal(`
        <div class="m-head"><h3>Save session</h3><p>${ids.length} account${ids.length === 1 ? '' : 's'} - ${target.placeId ? 'place ' + esc(target.placeId) : 'Roblox home'}</p></div>
        <div class="m-body">
          <div class="field"><label for="session-name">Name</label>
          <input id="session-name" type="text" maxlength="40" placeholder="e.g. Farming crew" value="Session ${loadSessions().length + 1}"></div>
          <label class="toggle-row inline" style="gap:10px;margin-top:4px;cursor:pointer">
            <input type="checkbox" id="session-arrange"> <span>Auto-arrange windows ~20s after launch</span>
          </label>
          <label class="toggle-row inline" style="gap:10px;margin-top:8px;cursor:pointer">
            <input type="checkbox" id="session-keepalive"> <span>Watchdog — put accounts back in the same server if they crash or disconnect</span>
          </label>
        </div>
        <div class="m-foot"><button class="btn" data-action="modal-cancel">Cancel</button>
        <button class="btn primary" data-action="session-save-confirm">${icon('check')} Save session</button></div>`);
      const inp = $('#session-name');
      if (inp) { inp.focus(); inp.select(); }
      break;
    }
    case 'session-save-confirm': {
      const draft = state.sessionDraft;
      if (!draft || !draft.accountIds.length) { closeModal(); toast('That session is no longer available', 'bad'); break; }
      const nameEl = $('#session-name');
      const sessions = loadSessions();
      sessions.push({
        id: 's' + Date.now(),
        name: (nameEl && nameEl.value.trim()) || `Session ${sessions.length + 1}`,
        accountIds: draft.accountIds,
        placeId: draft.placeId,
        gameId: draft.gameId,
        arrange: !!($('#session-arrange') && $('#session-arrange').checked),
        keepAlive: !!($('#session-keepalive') && $('#session-keepalive').checked),
      });
      const saved = saveSessions(sessions);
      state.sessionDraft = null;
      closeModal();
      toast(saved ? 'Session saved' : 'Could not save the session on this PC', saved ? 'good' : 'bad');
      if (state.view === 'instances') views.instances();
      break;
    }
    case 'plan-cancel': {
      const r = await call(() => api.launch.cancelPlan(id));
      if (r && r.plan) rememberLaunchPlan(r.plan);
      toast(r && r.ok ? 'Launch plan cancelled' : ((r && r.error) || 'Could not cancel launch plan'), r && r.ok ? 'good' : 'bad');
      break;
    }
    case 'session-launch': {
      const session = loadSessions().find(x => x.id === elAction.dataset.id);
      if (!session) break;
      const ids = session.accountIds.filter(i => state.accounts.some(a => a.id === i)).slice(0, 3);
      if (!ids.length) { toast('None of this session\'s accounts exist anymore', 'bad'); break; }
      elAction.disabled = true;
      const r = session.gameId && session.placeId
        ? await call(() => api.launch.join(ids, session.placeId, session.gameId))
        : await call(() => api.launch.accounts(ids, session.placeId || ''));
      elAction.disabled = false;
      if (handlePreparedPlan(r)) break;
      if (r && r.ok) {
        toast(`Session "${session.name}": launched ${r.launched} client${r.launched === 1 ? '' : 's'}` + (r.failed ? `, ${r.failed} failed` : ''), r.failed ? 'bad' : 'good');
        if (session.arrange) {
          toast('Windows will be arranged in ~20s', 'good');
          setTimeout(() => { call(() => api.instances.arrange()); }, 20000);
        }
        if (session.keepAlive && session.placeId) armWatchdog(ids.map(id => ({ accountId: id, placeId: session.placeId, gameInstanceId: session.gameId, name: session.name })));
      } else presentLaunchFailure(r, () => session.gameId && session.placeId
        ? call(() => api.launch.join(ids, session.placeId, session.gameId))
        : call(() => api.launch.accounts(ids, session.placeId || '')));
      break;
    }
    case 'session-delete': {
      if (!saveSessions(loadSessions().filter(x => x.id !== elAction.dataset.id))) toast('Could not delete the session', 'bad');
      if (state.view === 'instances') views.instances();
      break;
    }
    case 'games-sort': {
      state.games.sort = elAction.dataset.sort || 'players';
      // The segmented lives in the static mount markup - move its highlight
      // in place instead of re-rendering the whole view.
      document.querySelectorAll('.games-tools [data-action="games-sort"]').forEach(b => {
        b.classList.toggle('on', b.dataset.sort === state.games.sort);
      });
      renderGamesGrid();
      break;
    }
    case 'games-hide-empty':
      state.games.hideEmpty = !state.games.hideEmpty;
      views.games();
      break;
    case 'join-game': joinPlace(elAction.dataset.place, elAction.dataset.name); break;
    case 'open-game-web':
      await call(() => api.openExternal(`https://www.roblox.com/games/${encodeURIComponent(elAction.dataset.place || '')}`));
      break;
    case 'copy-place-id':
      try {
        await navigator.clipboard.writeText(String(elAction.dataset.place || ''));
        toast('Place ID copied', 'good');
      } catch (_) { toast('Could not copy place ID', 'bad'); }
      break;
    case 'open-servers': openServersModal(elAction.dataset.place, elAction.dataset.name); break;
    case 'join-server': joinServer(elAction.dataset.place, elAction.dataset.server, elAction.dataset.name); break;
    case 'server-sort':
      if (state.servers) {
        state.servers.sort = elAction.dataset.sort || 'best';
        renderServersModal();
        if (state.servers.sort === 'players' && !state.servers.deepScanned) await deepScanServers(true);
      }
      break;
    case 'servers-scan': await deepScanServers(false); break;
    case 'servers-filter-reset':
      if (state.servers) {
        state.servers.filters = { occupancy: 0, maxPing: 0, minFps: 0, freeSlots: 1 };
        renderServersModal();
      }
      break;
    case 'servers-auto-refresh':
      if (state.servers) setServerAutoRefresh(!state.servers.autoRefresh);
      break;
    case 'copy-server-id':
      try { await navigator.clipboard.writeText(String(elAction.dataset.server || '')); toast('Server ID copied', 'good'); }
      catch (_) { toast('Could not copy server ID', 'bad'); }
      break;
    case 'servers-more': loadServers(true); break;
    case 'servers-refresh': loadServers(false); break;
    case 'join-best': {
      const sv = state.servers;
      if (sv && sv.list.length) { const top = sortedServers(filteredServers(sv), sv.sort)[0]; if (top) joinServer(sv.placeId, top.id, sv.name); }
      break;
    }
    case 'servers-fill': openFillModal(); break;
    case 'fill-mode': {
      if (!state.fillDraft) break;
      state.fillDraft.spread = elAction.dataset.mode === 'spread';
      const seg = $('#fill-mode');
      if (seg) seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', (b.dataset.mode === 'spread') === state.fillDraft.spread));
      break;
    }
    case 'fill-confirm': {
      const draft = state.fillDraft;
      if (!draft || !draft.ids.length) { closeModal(); state.fillDraft = null; break; }
      const keepAlive = !!($('#fill-keepalive') && $('#fill-keepalive').checked);
      elAction.disabled = true;
      elAction.innerHTML = '<span class="spinner dark"></span> Planning…';
      const r = await call(() => api.launch.autoFill(draft.ids, draft.placeId, { spread: draft.spread, keepAlive, name: draft.name }), undefined, 300000);
      state.fillDraft = null;
      closeModal();
      state.servers = null;
      if (handlePreparedPlan(r)) break;
      if (r && r.ok) {
        clearLaunchFailure();
        toast(`Filled ${r.launched} account${r.launched === 1 ? '' : 's'} into ${r.servers} server${r.servers === 1 ? '' : 's'}` + (r.failed ? `, ${r.failed} failed` : ''), r.failed ? 'bad' : 'good');
      } else presentLaunchFailure(r, null);
      break;
    }

    case 'open-friends':
      state.people.tab = 'people';
      state.people.route = 'friends';
      views.people();
      break;
    case 'people-home':
      state.people.tab = 'people';
      state.people.route = 'home';
      views.people();
      break;
    case 'people-back': state.people.route = state.people.returnRoute || 'home'; views.people(); break;
    case 'people-search': runPeopleSearch(($('#people-search') || {}).value || ''); break;
    case 'people-search-retry': runPeopleSearch(state.people.search.query); break;
    case 'people-search-clear': clearPeopleSearch(); break;
    case 'people-search-more': runPeopleSearch(state.people.search.query, true); break;
    case 'people-filter':
      state.people.filter = elAction.dataset.filter || 'all';
      if (state.people.route === 'friends') views.people();
      else if (state.people.route === 'home') renderPeopleSearchResults();
      break;
    case 'people-sort':
      state.people.sort = elAction.dataset.sort || 'status';
      if (state.people.route === 'friends') views.people();
      else if (state.people.route === 'home') renderPeopleSearchResults();
      break;
    case 'copy-user-id':
      try {
        await navigator.clipboard.writeText(String(elAction.dataset.user || ''));
        toast('User ID copied', 'good');
      } catch (_) { toast('Could not copy user ID', 'bad'); }
      break;
    case 'open-person': openPerson(elAction.dataset.user); break;
    case 'people-prev': if (state.people.hasPrev) loadPeople(state.people.page - 1); break;
    case 'people-next': if (state.people.hasNext) loadPeople(state.people.page + 1); break;
    case 'people-refresh': refreshPeople(); break;
    case 'join-person': openPersonJoinDialog(elAction.dataset.user, elAction.dataset.place, elAction.dataset.game, elAction.dataset.name); break;
    case 'select-join-account': {
      if (!state.personJoin || state.personJoin.joining) break;
      const set = state.personJoin.selectedIds;
      if (set.has(id)) set.delete(id);
      else if (set.size >= (legacyCompatibilityMode() ? 3 : 1)) { toast('Normal mode launches one account. Enable Multi-instance mode for up to three.', 'bad'); break; }
      else set.add(id);
      renderPersonJoinDialog();
      break;
    }
    case 'person-join-confirm': {
      const join = state.personJoin;
      if (!join || join.joining || !join.selectedIds.size) break;
      const ids = Array.from(join.selectedIds).filter(x => state.accounts.some(a => a.id === x));
      if (!ids.length) { toast('Those accounts are no longer available', 'bad'); closePersonJoinDialog(); break; }
      join.joining = true;
      renderPersonJoinDialog();
      const r = await call(() => api.launch.joinPersonMulti(ids, join.userId));
      if (handlePreparedPlan(r)) {
        closePersonJoinDialog();
        break;
      }
      if (r && r.ok) {
        clearLaunchFailure();
        closePersonJoinDialog();
        toast(`Joining ${join.name} with ${r.launched} account${r.launched === 1 ? '' : 's'}` + (r.failed ? `, ${r.failed} failed` : ''), r.failed ? 'bad' : 'good');
      } else {
        join.joining = false;
        renderPersonJoinDialog();
        presentLaunchFailure(r, () => call(() => api.launch.joinPersonMulti(ids, join.userId)));
      }
      break;
    }

    case 'refresh-instances': { await loadInstances(); toast('Refreshed', 'good'); break; }
    case 'arrange': {
      if (!state.instances.length) { toast('No Roblox windows to arrange', 'bad'); break; }
      const r = await call(() => api.instances.arrange());
      toast(r && r.ok ? `Arranged ${r.tiled} window${r.tiled === 1 ? '' : 's'} in a ${r.cols}-${r.rows} grid` : (r && r.reason) || 'Could not arrange windows', r && r.ok ? 'good' : 'bad');
      break;
    }
    case 'end-all': {
      if (!state.instances.length) { toast('No clients running', 'bad'); break; }
      const ok = !needConfirm() || await confirmDialog({ title: 'End all Roblox clients?', body: 'This closes every running Roblox client.', confirmText: 'End all', danger: true });
      if (!ok) break;
      const r = await call(() => api.instances.killAll());
      toast(r && r.ok ? 'All clients ended' : 'Could not end clients', r && r.ok ? 'good' : 'bad');
      break;
    }
    case 'cleanup': {
      const ok = !needConfirm() || await confirmDialog({ title: 'Run cleanup?', body: 'Ends all Roblox clients and clears leftover crash-handler processes.', confirmText: 'Clean up', danger: true });
      if (!ok) break;
      const r = await call(() => api.instances.cleanup());
      toast(r && r.ok ? 'Cleanup complete' : 'Cleanup failed', r && r.ok ? 'good' : 'bad');
      break;
    }
    case 'focus': { const r = await call(() => api.instances.focus(capability)); if (!(r && r.ok)) toast((r && (r.error || r.reason)) || 'Could not focus window', 'bad'); break; }
    case 'restart': { const r = await call(() => api.instances.restart(capability)); toast(r && r.ok ? 'Client restarted' : ((r && r.error) || 'Restart failed'), r && r.ok ? 'good' : 'bad'); break; }
    case 'end': { const r = await call(() => api.instances.kill(capability)); toast(r && r.ok ? 'Client ended' : ((r && r.error) || 'Could not end client'), r && r.ok ? 'good' : 'bad'); break; }

    case 'modal-cancel': cancelModal(); break;
    case 'confirm-yes': if (confirmResolver) { confirmResolver(true); confirmResolver = null; } closeModal(); break;
    case 'confirm-no': if (confirmResolver) { confirmResolver(false); confirmResolver = null; } closeModal(); break;

    case 'clear-history': {
      const ok = await confirmDialog({ title: 'Clear history?', body: 'Remove all launch-history entries.', confirmText: 'Clear', danger: true });
      if (!ok) break;
      await call(() => api.history.clear()); views.history(); toast('History cleared', 'good');
      break;
    }

    case 'set-detect': {
      const auto = elAction.dataset.auto === 'true';
      const seg = $('#set-detect'); seg.dataset.auto = String(auto);
      seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.auto === String(auto)));
      const row = $('#set-path-row'); if (row) row.style.display = auto ? 'none' : '';
      break;
    }
    case 'settings-browse': {
      const r = await call(() => api.settings.browse());
      if (r && r.ok && r.path) {
        const inp = $('#set-path'); if (inp) inp.value = r.path;
        const seg = $('#set-detect');
        if (seg) {
          seg.dataset.auto = 'false';
          seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.auto === 'false'));
        }
        const row = $('#set-path-row'); if (row) row.style.display = '';
        if (!r.valid) {
          toast(r.reason || 'That file is not RobloxPlayerBeta.exe', 'bad');
          break;
        }
        const saved = await call(() => api.settings.save(currentSettingsDraft()));
        if (saved && saved.ok) {
          state.settings = saved.settings;
          await refreshStatus();
          views.settings();
          toast(state.status && state.status.robloxFound ? 'Roblox detected from manual path' : 'Manual path saved, but Roblox was not detected', state.status && state.status.robloxFound ? 'good' : 'bad');
        } else {
          toast((saved && saved.error) || 'Could not save Roblox path', 'bad');
        }
      }
      break;
    }
    case 'redetect': {
      const saved = await call(() => api.settings.save(currentSettingsDraft()));
      if (saved && saved.ok) state.settings = saved.settings;
      const detected = await call(() => api.detect(), { ok: false, found: false });
      await refreshStatus();
      views.settings();
      toast(detected && detected.found ? `${detected.displayName || 'Roblox'} detected` : 'No verified Roblox installation was found', detected && detected.found ? 'good' : 'bad');
      break;
    }
    case 'update-check': {
      const prevUpdater = state.updater;
      state.updater = Object.assign({}, state.updater, { state: 'checking', error: null });
      views.settings();
      let idempotencyKey;
      try { idempotencyKey = updateCheckIdempotencyKey(); }
      catch (error) {
        state.updater = prevUpdater;
        toast(error.message, 'bad');
        if (state.view === 'settings') views.settings();
        break;
      }
      const r = await call(() => api.updater.check(idempotencyKey));
      const job = r && r.ok && r.operationId
        ? await waitForUpdateJob(r.operationId, 35000)
        : null;
      const fallback = prevUpdater && prevUpdater.state ? prevUpdater : { state: 'disabled' };
      if (job && FINAL_JOB_STATES.has(job.state)) clearUpdateCheckIdempotencyKey(idempotencyKey);
      if (!job && r && r.ok) {
        state.updater = Object.assign({}, state.updater, { state: 'checking' });
        toast('Update check is still running in the background');
      } else if (job && job.state === 'SUCCEEDED' && job.result) {
        state.updater = job.result;
      } else {
        state.updater = await call(() => api.updater.status(), fallback);
      }
      if (!(r && r.ok)) toast((r && r.error) || 'Update check could not be started', 'bad');
      else if (job && job.state === 'FAILED') toast(job.error || 'Update check failed', 'bad');
      else if (job && job.state === 'CANCELLED') toast('Update check was cancelled', 'bad');
      else if (state.updater.state === 'current') toast('SUNDAY Launcher is up to date', 'good');
      if (state.view === 'settings') views.settings();
      break;
    }
    case 'update-install': await call(() => api.updater.install()); break;
    case 'update-open-web':
      await call(() => api.openExternal('https://github.com/SadinKai/SUNDAY/releases/latest'));
      toast('Opening the SUNDAY Launcher releases page in your browser');
      break;
    case 'app-restart': await restartApplication(); break;
    case 'settings-save': saveSettings(); break;
    case 'settings-reset': {
      const ok = await confirmDialog({ title: 'Reset settings?', body: 'Restore all settings to their defaults.', confirmText: 'Reset', danger: true });
      if (!ok) break;
      const r = await call(() => api.settings.reset());
      if (r && r.ok) {
        state.settings = r.settings;
        await refreshStatus();
        views.settings();
        if (r.restartRequired) await offerSettingsRestart(false);
        else toast('Settings reset', 'good');
      }
      break;
    }

    case 'log-filter': state.logFilter = elAction.dataset.f;
      $('#log-filter').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.f === state.logFilter));
      renderLogs(); break;
    case 'logs-clear': await call(() => api.logs.clear()); state.logs = []; renderLogs(); toast('Logs cleared', 'good'); break;
    case 'logs-folder': await call(() => api.logs.openFolder()); break;
    case 'copy-diag': copyDiagnostics(); break;
    case 'open-userdata': await call(() => api.openUserData()); break;
    case 'ext-link': await call(() => api.openExternal(elAction.dataset.url)); break;
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'launch-account-search') filterLaunchAccounts(e.target.value);
  if (e.target.id === 'lp-place') {
    state.placeId = e.target.value;
    updateLaunchReview();
    updateLaunchCount();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'lp-destination-preset') {
    const input = $('#lp-place');
    if (input) {
      input.value = e.target.value;
      state.placeId = e.target.value;
      updateLaunchReview();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return;
  }
  const filter = e.target.closest('[data-server-filter]');
  if (!filter || !state.servers) return;
  const key = filter.dataset.serverFilter;
  if (!Object.prototype.hasOwnProperty.call(state.servers.filters, key)) return;
  state.servers.filters[key] = Number(filter.value) || 0;
  renderServersModal();
});

function needConfirm() { return !state.settings || state.settings.confirmCleanup !== false; }

/* Right-click context menu on instance rows */
content.addEventListener('contextmenu', (e) => {
  const row = e.target.closest('[data-row]');
  if (!row) return;
  e.preventDefault();
  const pid = parseInt(row.dataset.pid, 10);
  const instance = (state.instances || []).find(i => Number(i.pid) === pid);
  const capability = instance && instance.controllable ? instance.capability : '';
  const watch = instance ? watchdogRecordForAccount(instance.accountId) : null;
  const items = capability ? [
    { id: 'focus', icon: 'focus', label: 'Focus window', onClick: () => doRowAction('focus', capability) },
    { id: 'restart', icon: 'rotate', label: 'Restart client', onClick: () => doRowAction('restart', capability) },
  ] : [];
  if (watch) {
    items.push({ id: 'stop-watch', icon: 'activity', label: 'Stop auto-rejoin', onClick: async () => {
      const r = await call(() => api.keeper.disarm(instance.accountId));
      toast(r && r.ok ? 'Watchdog stopped for ' + (watch.username || 'that account') : 'Could not stop the watchdog', r && r.ok ? 'good' : 'bad');
    } });
  }
  if (items.length) items.push({ sep: true });
  items.push({ id: 'copy', icon: 'copy', label: 'Copy PID', onClick: () => navigator.clipboard.writeText(String(pid)).then(() => toast('PID copied', 'good')) });
  if (capability) items.push({ sep: true }, { id: 'end', icon: 'x', label: 'End client', danger: true, onClick: () => doRowAction('end', capability) });
  showContextMenu(e.clientX, e.clientY, items);
});
async function doRowAction(kind, capability) {
  if (kind === 'focus') { const r = await call(() => api.instances.focus(capability)); if (!(r && r.ok)) toast((r && (r.error || r.reason)) || 'Could not focus', 'bad'); }
  if (kind === 'restart') { const r = await call(() => api.instances.restart(capability)); toast(r && r.ok ? 'Restarted' : ((r && r.error) || 'Restart failed'), r && r.ok ? 'good' : 'bad'); }
  if (kind === 'end') { const r = await call(() => api.instances.kill(capability)); toast(r && r.ok ? 'Ended' : ((r && r.error) || 'Could not end'), r && r.ok ? 'good' : 'bad'); }
}

async function copyDiagnostics() {
  const g = state.diag || {};
  const safe = g.sanitizedLaunchDiagnostics || { error: 'Sanitized launch diagnostics are unavailable.' };
  try { await navigator.clipboard.writeText(JSON.stringify(safe, null, 2)); toast('Sanitized launch diagnostics copied', 'good'); }
  catch (_) { toast('Could not copy', 'bad'); }
}
