'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const logger = require('./logger');
const store = require('./store');
const roblox = require('./roblox');
const native = require('./native');
const processes = require('./processes');
const accounts = require('./accounts');
const people = require('./people');
const signup = require('./signup');
const games = require('./games');
const playtime = require('./playtime');
const { InstanceKeeper } = require('./keeper');
const { ProcessMonitor } = require('./monitor');
const { CapabilityGates, STATES } = require('./capability-gates');
const { ProcessCapabilityRegistry } = require('./process-capabilities');
const { DurableJobSystem } = require('./durable-jobs');
const { UpdateCoordinator } = require('./update-coordinator');
const { registerUpdateJobs, startUpdateCheck } = require('./update-jobs');
const { SlotLeaseManager, normalizePath: normalizeLeasePath } = require('./slot-leases');
const {
  ISOLATION_STATES,
  adapterSelectionDiagnostics,
  legacyCompatRequested,
  selectRobloxIsolationAdapter,
} = require('./roblox-isolation-adapter');
const { LaunchCoordinator, LaunchPlanner, LaunchPlanStore } = require('./launch-orchestration');
const { planServerFill } = require('./server-fill-planner');

function asInt(v) { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; }

function resolveLegacyCompatibility(settings, environment) {
  const sourceEnvironment = environment || {};
  const environmentValue = Object.prototype.hasOwnProperty.call(sourceEnvironment, 'LEGACY_COMPAT')
    ? String(sourceEnvironment.LEGACY_COMPAT)
    : 'ABSENT';
  const environmentEnabled = legacyCompatRequested(sourceEnvironment);
  const settingEnabled = !!(settings && settings.multiInstanceMode === true);
  const enabled = environmentEnabled || settingEnabled;
  return Object.freeze({
    enabled,
    environmentEnabled,
    environmentValue,
    settingEnabled,
    activationSource: environmentEnabled ? 'environment' : (settingEnabled ? 'settings' : 'none'),
    selectorEnvironment: Object.freeze(enabled ? { LEGACY_COMPAT: '1' } : {}),
  });
}

function makeBackend(ctx) {
  const { appVersion, userData, emit, openPath, openExternal, pickFile, safeStorage } = ctx;

  logger.configure(userData);
  const ownerId = crypto.randomBytes(16).toString('hex');
  // Capture the process-start value once. The persisted user preference is
  // loaded before adapter selection and is translated into the same exact
  // selector input as LEGACY_COMPAT=1. Later code cannot switch adapters in a
  // running process; changing the preference requires a controlled restart.
  const externalAdapterEnvironment = Object.freeze(Object.prototype.hasOwnProperty.call(process.env, 'LEGACY_COMPAT')
    ? { LEGACY_COMPAT: String(process.env.LEGACY_COMPAT) }
    : {});
  const legacyReason = "LEGACY MULTI-INSTANCE MODE: Uses SUNDAY Launcher's legacy compatibility mechanism. This is not vendor supported isolation.";
  const gates = new CapabilityGates({
    singleOwner: { state: STATES.ACTIVE, reason: 'The Tauri single-instance broker owns this backend.' },
    processControl: { state: STATES.PREPARING, reason: 'Native process identity validation is initializing.' },
    robloxIsolation: {
      state: STATES.UNAVAILABLE,
      reason: 'Multi-instance mode is disabled. Enable it in Settings, then restart SUNDAY.',
    },
    updaterApply: {
      state: STATES.UNAVAILABLE,
      reason: 'Automatic update application is disabled until signed-manifest and rollback infrastructure is configured.',
    },
  });
  store.configure(userData, logger, { assertOwner: () => gates.require('singleOwner') });
  const settings = store.getSettings();
  const legacyCompatibility = resolveLegacyCompatibility(settings, externalAdapterEnvironment);
  if (legacyCompatibility.enabled) {
    gates.set('robloxIsolation', STATES.ACTIVE, legacyReason);
  }

  // Update application is intentionally unavailable until a pinned signing
  // key, monotonic manifest and side-by-side rollback path are provisioned.
  const lastUpdateResult = null;

  try { native.init(); } catch (err) { logger.warn('Native initialization failed', err && err.message); }
  if (native.isAvailable()) {
    gates.set('processControl', STATES.QUALIFIED, 'Native process creation identity and image-path revalidation are available.');
  } else {
    gates.set('processControl', STATES.FAILED, native.getLoadError() || 'Native process validation is unavailable.');
  }
  const processCapabilities = new ProcessCapabilityRegistry(native);
  const slotLeases = new SlotLeaseManager({
    database: store.database(),
    inspectProcess(expected) {
      if (!native.isAvailable()) return { status: 'UNKNOWN' };
      const imageName = path.win32.basename(String(expected && expected.executablePath || ''));
      const processesByName = imageName ? native.listProcesses(imageName) : null;
      if (!Array.isArray(processesByName)) return { status: 'UNKNOWN' };
      if (!processesByName.some(entry => Number(entry.pid) === Number(expected.pid))) {
        return { status: 'ABSENT' };
      }
      const current = native.processFingerprintOf(Number(expected.pid));
      if (!current || !current.processIdentity || !current.fileIdentity || !current.executablePath) {
        return { status: 'UNKNOWN' };
      }
      const matches = String(current.processIdentity) === String(expected.processIdentity)
        && String(current.fileIdentity) === String(expected.fileIdentity)
        && normalizeLeasePath(current.executablePath) === normalizeLeasePath(expected.executablePath);
      return {
        status: matches ? 'MATCH' : 'MISMATCH',
        executablePath: current.executablePath,
      };
    },
  });
  const recoveredSlots = slotLeases.recoverExpired();
  if (recoveredSlots.length) logger.info('Recovered expired process-bound slot leases', recoveredSlots);
  const jobs = new DurableJobSystem({ database: store.database() });
  const updater = new UpdateCoordinator({
    currentVersion: appVersion,
    database: store.database(),
    publicKeySpkiBase64: ctx.releaseTrust && ctx.releaseTrust.publicKeySpkiBase64,
    publisher: ctx.releaseTrust && ctx.releaseTrust.publisher,
    manifestUrl: ctx.releaseTrust && ctx.releaseTrust.manifestUrl,
    // Deliberately absent until the signed native extraction/Authenticode/
    // process-health adapter is qualified. Trust configuration alone cannot
    // activate mutations.
    applyAdapter: null,
  });
  registerUpdateJobs(jobs, updater);
  // Pending operations are visible after owner restart. Job types that are no
  // longer registered fail closed instead of disappearing or being replayed
  // through an unqualified implementation.
  jobs.resumePending();
  accounts.configure({
    baseDir: userData,
    safeStorage,
    logger,
    singleOwner: gates.permits('singleOwner'),
    database: store.database(),
    assertOwner: () => gates.require('singleOwner'),
  });
  playtime.configure({ store, logger });
  signup.configure({ logger });
  games.configure({ logger });
  people.configure({ logger });

  let monitor = new ProcessMonitor({ intervalMs: settings.pollIntervalMs, logger, capabilities: processCapabilities });
  const isolationReason = gates.get('robloxIsolation').reason;
  const isolationAdapter = selectRobloxIsolationAdapter({
    reason: isolationReason,
    environment: legacyCompatibility.selectorEnvironment,
    legacyOptions: {
      logger,
      nativeApi: native,
      processCapabilities,
      ownerId,
      monitor,
      cloneRoot: path.join(userData, 'legacy-instances'),
      forensicPath: path.join(userData, 'logs', 'phase7-live-runtime-forensic.jsonl'),
      locateRoblox: () => roblox.locate(store.getSettings()),
    },
  });
  const adapterSelection = Object.freeze(Object.assign(adapterSelectionDiagnostics(isolationAdapter), {
    legacyCompatEnvironmentValue: legacyCompatibility.environmentValue,
    legacyCompatEnvironmentEnabled: legacyCompatibility.environmentEnabled,
    legacyCompatSettingEnabled: legacyCompatibility.settingEnabled,
    legacyCompatActivationSource: legacyCompatibility.activationSource,
  }));
  logger.info('Roblox isolation adapter selected', adapterSelection);
  const launchPlans = new LaunchPlanStore({ database: store.database() });
  const launchPlanner = new LaunchPlanner();
  const launchCoordinator = new LaunchCoordinator({
    adapter: isolationAdapter,
    store: launchPlans,
    planner: launchPlanner,
    async resolveIntent(operation) {
      const target = operation.target || { type: 'HOME' };
      if (target.type === 'CLIENT') {
        return { ok: true, intent: { mode: 'client', accountHandle: operation.accountId, target, profileName: operation.label } };
      }
      let launch;
      if (target.type === 'FOLLOW_PERSON') {
        launch = await accounts.getPersonJoinLaunchInfo(operation.accountId, target.targetUserId);
      } else if (target.type === 'FOLLOW_ACCOUNT') {
        const followed = await accounts.getFollowContext(target.targetAccountId);
        if (!followed.ok) return followed;
        launch = await accounts.getLaunchInfo(operation.accountId, followed.placeId, followed.gameInstanceId);
      } else {
        launch = await accounts.getLaunchInfo(operation.accountId, target.placeId, target.serverId);
      }
      if (!launch || !launch.ok || !launch.deeplink) return { ok: false, reason: launch && launch.reason || 'A fresh Roblox authentication ticket could not be minted.' };
      return {
        ok: true,
        intent: {
          mode: 'deeplink',
          accountHandle: operation.accountId,
          target,
          profileName: launch.username || operation.label,
          // Ephemeral only: LaunchPlanStore rejects this field and the adapter
          // never stores or logs it.
          launchUri: launch.deeplink,
        },
      };
    },
    operationTimeoutMs: legacyCompatibility.enabled ? 90000 : 30000,
  });
  launchCoordinator.on('update', plan => emit('launch-plan:update', plan));

  function isolationState() {
    if (adapterSelection.isolationState === ISOLATION_STATES.LEGACY_COMPAT) {
      return ISOLATION_STATES.LEGACY_COMPAT;
    }
    const state = gates.get('robloxIsolation').state;
    if (state === STATES.ACTIVE) return ISOLATION_STATES.ACTIVATED;
    if (state === STATES.QUALIFIED) return ISOLATION_STATES.QUALIFIED;
    return ISOLATION_STATES.UNAVAILABLE;
  }

  // The keeper requests a fresh plan. It cannot mint credentials or create a
  // process itself, and restored records remain paused until exact owned-exit
  // evidence is supplied by an activated adapter.
  const keeper = new InstanceKeeper({
    logger,
    store,
    settingsProvider: () => store.getSettings(),
    isolationStateProvider: isolationState,
    requestRelaunch: async record => {
      const target = record.targetUserId
        ? { type: 'FOLLOW_PERSON', targetUserId: record.targetUserId, name: record.name }
        : (record.gameInstanceId
          ? { type: 'EXACT_SERVER', placeId: record.placeId, serverId: record.gameInstanceId, name: record.name }
          : (record.placeId ? { type: 'PLACE', placeId: record.placeId, name: record.name } : { type: 'HOME', name: record.name }));
      return launchCoordinator.prepare({
        name: `Keeper: ${record.name}`,
        participants: [{ accountId: record.accountId, label: record.accountId }],
        target,
        launchDelayMs: 0,
        keepAlive: true,
      });
    },
  });
  keeper.on('change', (status) => emit('keeper:status', status));
  keeper.on('rejoin', (record) => emit('keeper:rejoin', {
    accountId: record.accountId, username: record.username, name: record.name,
    attempts: record.attempts, delayMs: record.delayMs || 0, reason: record.lastReason || '',
  }));
  keeper.on('gaveup', (record) => emit('keeper:gaveup', {
    accountId: record.accountId, username: record.username, name: record.name,
    attempts: record.attempts, reason: record.lastReason || '',
  }));
  keeper.restore();

  monitor.on('update', (payload) => {
    emit('instances:update', payload);
    keeper.onInstances(payload.instances);
    if (typeof isolationAdapter.reconcile === 'function') {
      isolationAdapter.reconcile()
        .then(exits => { for (const evidence of exits) keeper.onOwnedExit(evidence); })
        .catch(error => logger.warn('Legacy ownership reconciliation failed', error && error.message));
    }
  });
  monitor.start();

  logger.onEntry((entry) => emit('log:entry', entry));
  accounts.startPolling({
    intervalMs: 12000,
    onUpdate: (acc) => emit('account:update', acc),
    onExpired: (acc) => emit('account:expired', acc),
    onObserve: (userId, username, status, game) => { playtime.observe(userId, username, status, game); keeper.onPresence(userId, status); },
  });

  function buildStatus() {
    const settings = store.getSettings();
    const loc = roblox.locate(settings);
    return {
      ok: true,
      appVersion,
      robloxFound: loc.found,
      playerPath: loc.playerPath,
      version: loc.version,
      source: loc.source,
      candidates: loc.candidates,
      multiInstance: gates.permits('robloxIsolation'),
      ffiAvailable: native.isAvailable(),
      ffiError: native.getLoadError(),
      adapterSelection: Object.assign({}, adapterSelection),
      isolationAdapter: {
        state: isolationState(),
        mode: adapterSelection.selectedAdapter === 'LegacyRobloxIsolationAdapter'
          ? 'LEGACY_COMPAT'
          : 'SAFE_UNAVAILABLE',
        implementation: adapterSelection.selectedAdapter,
        qualified: false,
        reason: adapterSelection.reason,
      },
      launchPlans: {
        recent: launchCoordinator.list(30).length,
        recovered: launchCoordinator.recovered.length,
      },
      capabilities: gates.snapshot(),
      slotLeases: {
        state: 'FOUNDATION_ONLY',
        active: slotLeases.list().length,
        activation: gates.get('robloxIsolation').state,
      },
      watchdog: keeper.status().summary,
      lastUpdateResult: lastUpdateResult || null,
      settings,
    };
  }

  function participantsFor(accountIds) {
    const known = new Map(accounts.list().map(account => [String(account.id), account]));
    const unique = Array.from(new Set((Array.isArray(accountIds) ? accountIds : [])
      .map(value => String(value || '').trim()).filter(Boolean)));
    if (!unique.length) throw new Error('Choose at least one account.');
    if (unique.length > 3) throw new Error('SUNDAY Launcher launch plans support 1 to 3 accounts.');
    const participants = unique.map(accountId => {
      const account = known.get(accountId);
      if (!account) throw new Error('One or more selected accounts no longer exist.');
      return { accountId, label: account.displayName || account.username || accountId };
    });
    return participants;
  }

  async function prepareLaunch(input) {
    const request = Object.assign({}, input, {
      launchDelayMs: store.getSettings().launchDelayMs,
    });
    const response = await launchCoordinator.prepare(request);
    const result = response.prepared ? 'prepared' : (response.ok ? 'launched' : 'failed');
    store.addHistory({
      profileName: request.name || 'Launch plan',
      mode: 'orchestrated',
      result,
      pid: null,
      message: response.prepared
        ? `${response.selectedCount}-account plan prepared; ${response.error}`
        : (response.error || ''),
    });
    logger.info(`Launch plan ${response.planId}: ${response.plan.state} (${response.selectedCount} operation(s))`);
    return response;
  }

  /** Turn account ids into watchdog records the keeper can arm. */
  function armRecords(rows) {
    const known = new Map(accounts.list().map(a => [a.id, a]));
    const list = [];
    for (const row of (Array.isArray(rows) ? rows : []).slice(0, 20)) {
      const accountId = String((row && row.accountId) || '').trim();
      const acc = known.get(accountId);
      if (accountId && acc) {
        list.push({
          accountId,
          userId: acc.userId,
          username: acc.username,
          placeId: String((row && row.placeId) || ''),
          gameInstanceId: String((row && row.gameInstanceId) || ''),
          targetUserId: Number(row && row.targetUserId) || null,
          name: String((row && row.name) || ''),
        });
      }
    }
    if (!list.length) return { ok: false, error: 'No matching accounts to watch.' };
    return keeper.armMany(list);
  }

  /** Discover servers and build exact-server intents without minting tickets. */
  async function autoFill({ accountIds, placeId, spread, keepAlive, name }) {
    let participants;
    try { participants = participantsFor(accountIds); }
    catch (error) { return { ok: false, error: error.message }; }
    const scan = await games.scanServers(placeId, 8);
    if (!scan.ok) return { ok: false, error: scan.error || 'Server scan failed.' };
    const fill = planServerFill({ accountIds: participants.map(item => item.accountId), servers: scan.servers, spread });
    if (!fill.ok) return Object.assign({ scan: scan.scan || null }, fill);
    if (fill.unassigned) return Object.assign({ ok: false, error: 'The scanned servers do not have enough free slots for the selected accounts.', scan: scan.scan || null }, fill);
    const targetsByAccount = Object.fromEntries(fill.assignments.map(assignment => [assignment.accountId, {
      type: 'EXACT_SERVER', placeId, serverId: assignment.serverId, name,
    }]));
    const response = await prepareLaunch({
      name: `Server fill: ${name || placeId}`,
      participants,
      target: { type: 'PLACE', placeId, name },
      targetsByAccount,
      keepAlive,
    });
    return Object.assign(response, { fill, servers: fill.serverCount, scan: scan.scan || null });
  }

  let adapterStatusServed = false;
  let adapterDiagnosticServed = false;
  const handlers = {
    async app_status() {
      const status = buildStatus();
      if (!adapterStatusServed) {
        adapterStatusServed = true;
        logger.info('Runtime adapter status served to renderer', status.adapterSelection);
      }
      return status;
    },
    async adapter_selection_status() {
      if (!adapterDiagnosticServed) {
        adapterDiagnosticServed = true;
        logger.info('Runtime adapter selection diagnostic served to renderer', adapterSelection);
      }
      return { ok: true, adapterSelection: Object.assign({}, adapterSelection) };
    },
    async updater_status() { return Object.assign({ ok: true }, updater.status()); },
    async updater_check(payload) {
      if (!updater.trustConfigured()) {
        const gate = gates.get('updaterApply');
        return Object.assign({ ok: false, error: gate.reason, capability: gate }, updater.status());
      }
      try {
        const job = startUpdateCheck(jobs, payload.idempotencyKey);
        return { ok: true, operationId: job.operationId, job };
      }
      catch (error) { return Object.assign({ ok: false, error: error.message }, updater.status()); }
    },
    async updater_install() {
      const gate = gates.get('updaterApply');
      return Object.assign({ ok: false, error: gate.reason, capability: gate }, updater.status());
    },
    async jobs_list() { return { ok: true, jobs: jobs.list() }; },
    async job_get(payload) {
      const job = jobs.get(payload.operationId);
      return job ? { ok: true, job } : { ok: false, error: 'Unknown operation ID.' };
    },
    async job_cancel(payload) {
      try { return { ok: true, job: jobs.cancel(payload.operationId) }; }
      catch (error) { return { ok: false, error: error.message }; }
    },
    async roblox_detect() {
      const settings = store.getSettings();
      const loc = roblox.locate(settings);
      logger.info('Roblox detection: ' + (loc.found ? (loc.source + ' -> ' + loc.playerPath) : 'NOT FOUND'));
      return Object.assign({ ok: true }, loc);
    },
    async launch_quick(payload) {
      const count = Math.max(1, Math.min(3, asInt(payload.count) || 1));
      return prepareLaunch({
        name: 'Signed-out launch plan',
        participants: Array.from({ length: count }, (_, index) => ({ accountId: `signed-out-${index + 1}`, label: `Signed out ${index + 1}` })),
        target: { type: 'CLIENT' },
      });
    },
    async launch_accounts(payload) {
      let participants;
      try { participants = participantsFor(payload.accountIds); } catch (error) { return { ok: false, error: error.message }; }
      const placeId = String(payload.placeId || '').trim();
      if (placeId && !/^\d+$/.test(placeId)) return { ok: false, error: 'A valid place id is required.' };
      return prepareLaunch({
        name: placeId ? `Place ${placeId}` : 'Account home launch plan',
        participants,
        target: placeId ? { type: 'PLACE', placeId } : { type: 'HOME' },
      });
    },
    async launch_join(payload) {
      let participants;
      try { participants = participantsFor(payload.accountIds); } catch (error) { return { ok: false, error: error.message }; }
      const placeId = String(payload.placeId || '').trim();
      const serverId = String(payload.gameId || '').trim();
      if (!/^\d+$/.test(placeId) || !serverId) return { ok: false, error: 'A valid place and server id are required.' };
      return prepareLaunch({
        name: `Exact server ${placeId}`,
        participants,
        target: { type: 'EXACT_SERVER', placeId, serverId },
      });
    },
    async launch_join_person(payload) {
      const accountId = String(payload.accountId || '');
      const targetUserId = asInt(payload.targetUserId);
      if (!accountId || !targetUserId) return { ok: false, error: 'Choose an account and player first.' };
      let participants;
      try { participants = participantsFor([accountId]); } catch (error) { return { ok: false, error: error.message }; }
      return prepareLaunch({ name: `Follow person ${targetUserId}`, participants, target: { type: 'FOLLOW_PERSON', targetUserId } });
    },
    async launch_join_person_multi(payload) {
      const targetUserId = asInt(payload.targetUserId);
      const accountIds = Array.from(new Set((Array.isArray(payload.accountIds) ? payload.accountIds : []).map(id => String(id || '')).filter(Boolean))).slice(0, 3);
      if (!targetUserId || !accountIds.length) return { ok: false, error: 'Choose at least one account and a player.' };
      let participants;
      try { participants = participantsFor(accountIds); } catch (error) { return { ok: false, error: error.message }; }
      return prepareLaunch({ name: `Follow person ${targetUserId}`, participants, target: { type: 'FOLLOW_PERSON', targetUserId } });
    },
    async launch_auto_fill(payload) {
      const accountIds = Array.from(new Set((Array.isArray(payload.accountIds) ? payload.accountIds : []).map(id => String(id || '')).filter(Boolean))).slice(0, 3);
      const placeId = String(payload.placeId || '').trim();
      if (!accountIds.length) return { ok: false, error: 'Choose at least one account.' };
      if (!/^\d+$/.test(placeId)) return { ok: false, error: 'A valid place id is required.' };
      return autoFill({
        accountIds,
        placeId,
        spread: payload.spread !== false,
        keepAlive: !!payload.keepAlive,
        name: String(payload.name || 'the game').slice(0, 80),
      });
    },
    async launch_plans() { return { ok: true, plans: launchCoordinator.list(30), recovered: launchCoordinator.recovered.slice() }; },
    async launch_plan_get(payload) {
      const plan = launchCoordinator.get(payload.planId);
      return plan ? { ok: true, plan } : { ok: false, error: 'Unknown launch plan.' };
    },
    async launch_plan_cancel(payload) { return launchCoordinator.cancel(payload.planId); },
    async keeper_arm(payload) {
      return armRecords(payload.records);
    },
    async keeper_disarm(payload) {
      const r = keeper.disarm(payload.accountId, 'stopped by user');
      return r.ok ? { ok: true } : { ok: false, error: 'That account is not being watched.' };
    },
    async keeper_disarm_all() { return keeper.disarmAll('stopped by user'); },
    async keeper_status() { return keeper.status(); },
    async legacy_test_crash_owned(payload) {
      if (!legacyCompatibility.enabled || process.env.SUNDAY_LEGACY_TEST_MODE !== '1') {
        return { ok: false, error: 'The exact-owned legacy test hook is disabled.' };
      }
      const capability = String(payload.capability || '');
      const ownedOperation = launchCoordinator.list(200).flatMap(plan => plan.operations.map(operation => ({ plan, operation })))
        .find(item => item.operation.capability === capability);
      if (!ownedOperation) return { ok: false, error: 'No SUNDAY Launcher launch operation matches that capability.' };
      const stopped = await isolationAdapter.stop(capability, { environmentId: ownedOperation.operation.environmentId });
      if (!(stopped && stopped.ok && stopped.confirmed)) return { ok: false, error: stopped && stopped.reason || 'Exact owned stop was not confirmed.' };
      const evidence = {
        accountId: ownedOperation.operation.accountId,
        operationId: ownedOperation.operation.operationId,
        capability,
        confirmed: true,
        ownership: 'OWNED',
        reason: 'Controlled Phase 7 keeper test simulated an owned-client crash.',
      };
      const keeperResult = keeper.onOwnedExit(evidence);
      return { ok: true, stopped: true, keeper: keeperResult };
    },
    async people_list(payload) { return people.listFriends(asInt(payload.page) || 0, asInt(payload.pageSize) || 9, !!payload.force); },
    async people_search(payload) { return people.search(payload.query, payload.cursor); },
    async people_profile(payload) { return people.profile(payload.userId); },
    async people_presence(payload) { return people.presence(payload.userIds); },
    async accounts_list() { return { ok: true, accounts: accounts.list() }; },
    async accounts_add(payload) { return accounts.add(payload || {}); },
    async accounts_add_cookie(payload) { return accounts.addFromCookie(String((payload && payload.cookie) || '')); },
    async signup_check_username(payload) {
      return signup.checkUsername(String((payload && payload.username) || ''), String((payload && payload.birthday) || ''));
    },
    async signup_suggest_usernames(payload) {
      return signup.suggestUsernames(String((payload && payload.username) || ''), String((payload && payload.birthday) || ''));
    },
    async accounts_remove(payload) { return accounts.remove(payload.id); },
    async accounts_refresh(payload) { return accounts.refresh(payload.id, payload.full); },
    async accounts_follow(payload) {
      const targetAccountId = String(payload.targetAccountId || '');
      const followerAccountIds = Array.from(new Set((Array.isArray(payload.followerAccountIds) ? payload.followerAccountIds : []).map(id => String(id || '')).filter(id => id && id !== targetAccountId))).slice(0, 3);
      if (!targetAccountId) return { ok: false, error: 'Choose an account to follow.' };
      if (!followerAccountIds.length) return { ok: false, error: 'Choose at least one other account to follow with.' };
      const target = accounts.list().find(account => String(account.id) === targetAccountId);
      if (!target) return { ok: false, error: 'The account to follow no longer exists.' };
      let participants;
      try { participants = participantsFor(followerAccountIds); } catch (error) { return { ok: false, error: error.message }; }
      const result = await prepareLaunch({
        name: `Follow ${target.displayName || target.username || 'account'}`,
        participants,
        target: { type: 'FOLLOW_ACCOUNT', targetAccountId, name: target.displayName || target.username },
      });
      return Object.assign({}, result, { targetUsername: target.username, targetDisplayName: target.displayName });
    },
    async games_browse() { return games.browse(); },
    async games_search(payload) { return games.search(payload.query, payload.pageToken); },
    async games_servers(payload) { return games.servers(payload.placeId, payload.cursor); },
    async games_server_scan(payload) { return games.scanServers(payload.placeId, payload.pageLimit); },
    async instances_get() { return { ok: true, instances: monitor.snapshot(), summary: null }; },
    async instance_focus(payload) {
      const resolved = processCapabilities.authorize(payload.capability, 'focus', ownerId);
      if (!resolved.ok) return { ok: false, error: resolved.reason };
      const r = processes.focusOwned(resolved.record); return Object.assign({ ok: r.ok }, r);
    },
    async instance_kill(payload) {
      const resolved = processCapabilities.authorize(payload.capability, 'kill', ownerId);
      if (!resolved.ok) return { ok: false, error: resolved.reason };
      keeper.onManualKill(payload.capability);
      const ownedOperation = launchCoordinator.list(200).flatMap(plan => plan.operations.map(operation => ({ plan, operation })))
        .find(item => item.operation.capability === payload.capability);
      if (ownedOperation) {
        const stopped = await launchCoordinator.stop(ownedOperation.plan.planId, ownedOperation.operation.operationId);
        monitor.poll();
        return stopped;
      }
      const { pid } = resolved.record;
      const r = processes.terminateOwned(resolved.record);
      if (r.ok) {
        processCapabilities.revoke(payload.capability, 'Owned process termination was confirmed.');
        monitor.forget(pid);
        monitor.poll();
      }
      return r;
    },
    async instance_restart(payload) {
      const resolved = processCapabilities.authorize(payload.capability, 'restart', ownerId);
      if (!resolved.ok) return { ok: false, error: resolved.reason };
      const ownedOperation = launchCoordinator.list(200).flatMap(plan => plan.operations.map(operation => ({ plan, operation })))
        .find(item => item.operation.capability === payload.capability);
      if (!ownedOperation) return { ok: false, error: 'No active launch operation matches that process capability.' };
      keeper.onManualRestart(payload.capability);
      const restarted = await launchCoordinator.restart(ownedOperation.plan.planId, ownedOperation.operation.operationId);
      monitor.poll();
      return restarted;
    },
    async instances_kill_all() { return { ok: false, error: 'Broad Roblox termination is permanently disabled.' }; },
    async instances_cleanup() { return { ok: false, error: 'Broad process cleanup is permanently disabled.' }; },
    async instances_arrange() {
      const records = [];
      for (const row of (monitor.snapshot() || [])) {
        if (!row.controllable || !row.capability) continue;
        const resolved = processCapabilities.authorize(row.capability, 'arrange', ownerId);
        if (resolved.ok) records.push(resolved.record);
      }
      if (!records.length) return { ok: false, reason: 'No SUNDAY-owned windows are available.' };
      const r = native.tileOwned(records); return Object.assign({ ok: r.ok }, r);
    },
    async history_get() { return { ok: true, history: store.getHistory() }; },
    async playtime_stats() { return playtime.stats(); },
    async playtime_clear() { return playtime.clear(); },
    async history_clear() { return { ok: true, history: store.clearHistory() }; },
    async settings_get() { return { ok: true, settings: store.getSettings() }; },
    async settings_save(payload) {
      const before = store.getSettings();
      const partial = Object.assign({}, payload.partial || {});
      if (typeof partial.robloxPath === 'string' && partial.robloxPath.trim()) {
        const pathStatus = roblox.pathStatus(partial.robloxPath);
        if (pathStatus.normalized) partial.robloxPath = pathStatus.normalized;
      }
      const settings = store.saveSettings(partial);
      if (settings.pollIntervalMs !== before.pollIntervalMs) monitor.setPollInterval(settings.pollIntervalMs);
      return {
        ok: true,
        settings,
        restartRequired: settings.multiInstanceMode !== before.multiInstanceMode,
      };
    },
    async settings_reset() {
      const before = store.getSettings();
      const settings = store.resetSettings();
      monitor.setPollInterval(settings.pollIntervalMs);
      return {
        ok: true,
        settings,
        restartRequired: settings.multiInstanceMode !== before.multiInstanceMode,
      };
    },
    async settings_browse() {
      const picked = await pickFile();
      if (!picked) return { ok: false, canceled: true };
      const pathStatus = roblox.pathStatus(picked);
      return { ok: true, path: pathStatus.normalized || picked, valid: pathStatus.ok, reason: pathStatus.reason };
    },
    async logs_get(payload) { return { ok: true, entries: logger.recent(asInt(payload.limit) || 300) }; },
    async logs_clear() { logger.clear(); return { ok: true }; },
    async logs_open_folder() {
      const dir = logger.getLogDir(); if (!dir) return { ok: false, error: 'No log folder.' };
      await openPath(dir); return { ok: true, dir };
    },
    async diag_get() {
      const settings = store.getSettings();
      const loc = roblox.locate(settings);
      return {
        ok: true,
        diagnostics: {
          appVersion,
          shell: 'tauri',
          chrome: null,
          node: process.versions.node,
          v8: process.versions.v8,
          platform: process.platform,
          arch: process.arch,
          osType: os.type(),
          osRelease: os.release(),
          osHost: os.hostname(),
          totalMemGB: +(os.totalmem() / 1024 / 1024 / 1024).toFixed(1),
          cpu: (os.cpus()[0] || {}).model || 'unknown',
          userData,
          logFile: logger.getLogFile(),
          logSink: logger.getSinkStatus(),
          ffiAvailable: native.isAvailable(),
          ffiError: native.getLoadError(),
          multiInstance: gates.get('robloxIsolation').state + ': ' + gates.get('robloxIsolation').reason,
          legacyCompatEnabled: adapterSelection.legacyCompatEnabled,
          legacyCompatEnvironmentValue: adapterSelection.legacyCompatEnvironmentValue,
          legacyCompatEnvironmentEnabled: adapterSelection.legacyCompatEnvironmentEnabled,
          legacyCompatSettingEnabled: adapterSelection.legacyCompatSettingEnabled,
          legacyCompatActivationSource: adapterSelection.legacyCompatActivationSource,
          selectedAdapter: adapterSelection.selectedAdapter,
          isolationState: adapterSelection.isolationState,
          isolationReason: adapterSelection.reason,
          isolationAdapter: `${adapterSelection.isolationState}: ${adapterSelection.reason}`,
          legacyCompatibility: typeof isolationAdapter.diagnostics === 'function' ? isolationAdapter.diagnostics() : null,
          robloxFound: loc.found,
          robloxPath: loc.playerPath,
          robloxVersion: loc.version,
          robloxSource: loc.source,
          candidates: loc.candidates,
        },
      };
    },
    async app_open_external(payload) {
      const raw = String((payload && payload.url) || '').trim();
      let parsed;
      try {
        parsed = new URL(raw);
      } catch (_) {
        return { ok: false, error: 'Invalid URL format.' };
      }
      const allowedHosts = new Set(['www.roblox.com', 'github.com']);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !allowedHosts.has(parsed.hostname.toLowerCase())) {
        return { ok: false, error: 'That external link is not allowlisted.' };
      }
      try {
        await openExternal(parsed.href);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : 'Could not open link.' };
      }
    },
    async app_open_user_data() { await openPath(userData); return { ok: true }; },
  };

  async function invoke(name, payload) {
    const fn = handlers[name];
    if (!fn) return { ok: false, error: 'Unknown command: ' + name };
    try {
      return await fn(payload || {});
    } catch (err) {
      logger.error('Tauri backend ' + name + ' failed', err && err.message);
      return { ok: false, error: (err && err.message) || String(err) };
    }
  }

  async function shutdown() {
    try { if (monitor) monitor.stop(); } catch (_) {}
    try { accounts.stopPolling(); } catch (_) {}
    try { playtime.flush(); } catch (_) {}
    try { keeper.stop(); } catch (_) {}
    try { if (typeof isolationAdapter.shutdown === 'function') isolationAdapter.shutdown(); } catch (_) {}
    try { store.close(); } catch (_) {}
    // Slot cleanup is lease-owned and must never run as an implicit broad
    // shutdown sweep. The retired clone implementation remains gated off.
  }

  return { invoke, shutdown };
}

module.exports = { makeBackend, resolveLegacyCompatibility };
