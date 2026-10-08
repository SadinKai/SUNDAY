'use strict';

const { MAX_LEGACY_MANAGED_CLIENTS } = require('./legacy-capacity');

function uniqueAccountIds(input) {
  return Array.from(new Set((Array.isArray(input) ? input : [])
    .map(value => String(value || '').trim())
    .filter(Boolean)));
}

function freeSlots(server) {
  const max = Math.max(0, Number(server && server.maxPlayers) || 0);
  const playing = Math.max(0, Number(server && server.playing) || 0);
  return Math.max(0, max - playing);
}

function planServerFill(options) {
  const opts = options || {};
  const accountIds = uniqueAccountIds(opts.accountIds);
  if (!accountIds.length) return { ok: false, error: 'Choose at least one account.', assignments: [] };
  if (accountIds.length > MAX_LEGACY_MANAGED_CLIENTS) {
    return { ok: false, error: `SUNDAY Launcher launch plans support at most ${MAX_LEGACY_MANAGED_CLIENTS} accounts.`, assignments: [] };
  }

  const servers = (Array.isArray(opts.servers) ? opts.servers : [])
    .filter(server => server && String(server.id || '').trim() && freeSlots(server) > 0)
    .map(server => Object.assign({}, server, { id: String(server.id), freeSlots: freeSlots(server) }))
    .sort((a, b) => b.freeSlots - a.freeSlots
      || (a.ping == null ? Number.MAX_SAFE_INTEGER : Number(a.ping))
      - (b.ping == null ? Number.MAX_SAFE_INTEGER : Number(b.ping))
      || a.id.localeCompare(b.id));

  if (!servers.length) return { ok: false, error: 'No joinable servers have free slots.', assignments: [] };

  const assignments = [];
  if (opts.spread === false) {
    const together = servers.find(server => server.freeSlots >= accountIds.length);
    if (together) {
      for (const accountId of accountIds) {
        assignments.push({ accountId, serverId: together.id, freeSlotsBefore: together.freeSlots });
      }
    }
  }

  if (!assignments.length) {
    let accountIndex = 0;
    for (const server of servers) {
      const take = Math.min(server.freeSlots, accountIds.length - accountIndex);
      for (let index = 0; index < take; index += 1) {
        assignments.push({
          accountId: accountIds[accountIndex],
          serverId: server.id,
          freeSlotsBefore: server.freeSlots - index,
        });
        accountIndex += 1;
      }
      if (accountIndex >= accountIds.length) break;
    }
    while (accountIndex < accountIds.length) {
      assignments.push({
        accountId: accountIds[accountIndex],
        serverId: null,
        reason: 'Every scanned server is full.',
      });
      accountIndex += 1;
    }
  }

  const assigned = assignments.filter(item => item.serverId);
  return {
    ok: assigned.length > 0,
    mode: opts.spread === false ? 'TOGETHER' : 'SPREAD',
    assignments,
    assigned: assigned.length,
    unassigned: assignments.length - assigned.length,
    serverCount: new Set(assigned.map(item => item.serverId)).size,
  };
}

module.exports = { freeSlots, planServerFill };
