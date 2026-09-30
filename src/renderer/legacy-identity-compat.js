'use strict';

// Browser-local one-time migration for keys created before the SUNDAY identity
// became canonical. Old names are intentionally quarantined in this file.
(function exposeLegacyIdentityMigration(root) {
  const mappings = Object.freeze([
    ['fleet-theme', 'sunday-theme'],
    ['fleet-update-check-idempotency-v1', 'sunday-update-check-idempotency-v1'],
    ['fleet-create-defaults-v1', 'sunday-create-defaults-v1'],
    ['fleet-last-view', 'sunday-last-view'],
    ['fleet-fav-games', 'sunday-fav-games'],
    ['fleet-recent-games', 'sunday-recent-games'],
    ['fleet-watch-v1', 'sunday-watch-v1'],
    ['fleet-sessions', 'sunday-sessions'],
  ]);
  function migrateStorage(storage) {
    for (const [legacyKey, currentKey] of mappings) {
      if (storage.getItem(currentKey) !== null) continue;
      const value = storage.getItem(legacyKey);
      if (value === null) continue;
      storage.setItem(currentKey, value);
      if (storage.getItem(currentKey) === value) storage.removeItem(legacyKey);
    }
    storage.removeItem('fleet-notifs-v1');
  }
  root.SundayLegacyIdentityCompat = Object.freeze({ migrateStorage });
})(window);
