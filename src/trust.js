// Trust store for paired devices.
//
// What "trust" means here: the user has previously accepted a pair
// request from a device with this pubkey, and ticked "Trust always."
// Future pair requests from the same key auto-accept silently. Same
// shape as Bluetooth's bonded-devices list.
//
// State: pubkey → { label, firstPairedAt, lastSeenAt }. Pubkey is the
// continuity primitive; label is the human-readable name. Both come
// signed from the other device's discovery ad.
//
// Persistence: localStorage. Cleared = future pair requests prompt
// again. Safe failure mode.

const STORAGE_KEY = 'tallyho:trust:v1';

function _load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function _save(store) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch {}
}

export function isTrusted(pubkey) {
  if (!pubkey) return false;
  return !!_load()[pubkey];
}
export const isAutoAccept = isTrusted;

export function trust(pubkey, label) {
  if (!pubkey) return;
  const store = _load();
  const now = Date.now();
  const existing = store[pubkey];
  store[pubkey] = {
    label: label || (existing && existing.label) || 'Device',
    firstPairedAt: existing ? existing.firstPairedAt : now,
    lastSeenAt: now,
  };
  _save(store);
}

export function untrust(pubkey) {
  if (!pubkey) return;
  const store = _load();
  delete store[pubkey];
  _save(store);
}
