'use strict';

// This is the single product-policy limit for the legacy real-Windows Roblox
// compatibility path. Renderer surfaces receive it from app_status; they must
// not duplicate the value.
const MAX_LEGACY_MANAGED_CLIENTS = 6;

// Released clone directories can remain physically busy while sibling Roblox
// processes map shared hard-linked bytes. Keep bounded headroom for several
// generations of those directories instead of assuming active capacity + 1.
const LEGACY_PHYSICAL_SLOT_HEADROOM_FACTOR = 4;
const MAX_LEGACY_PHYSICAL_SLOTS = MAX_LEGACY_MANAGED_CLIENTS
  * LEGACY_PHYSICAL_SLOT_HEADROOM_FACTOR;

module.exports = {
  LEGACY_PHYSICAL_SLOT_HEADROOM_FACTOR,
  MAX_LEGACY_MANAGED_CLIENTS,
  MAX_LEGACY_PHYSICAL_SLOTS,
};
