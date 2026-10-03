// Routine cleanup: expired temporary canvases, stale auth rows, unverified accounts.

import { TEMP_TTL_MS } from './access';
import type { Store } from './db';

const UNVERIFIED_TTL_MS = 48 * 3600 * 1000;

/**
 * Deletes temporary canvases older than TEMP_TTL_MS. `onDeleted` runs for each one, so the
 * server can disconnect people still on it. Returns how many canvases went.
 */
export function cleanup(store: Store, onDeleted: (code: string) => void): number {
  const expired = store.expiredTemporary(Date.now() - TEMP_TTL_MS);
  for (const code of expired) {
    store.deleteCanvas(code);
    onDeleted(code);
  }
  store.purgeExpiredAuth();
  const users = store.purgeUnverified(Date.now() - UNVERIFIED_TTL_MS);
  if (expired.length || users) {
    store.checkpoint();
    console.log(`cleanup: ${expired.length} temporary canvases, ${users} unverified accounts removed`);
  }
  return expired.length;
}
