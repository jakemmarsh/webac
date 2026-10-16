/**
 * RELEASE.launcher-screen — remember the last world and account name between
 * visits. Never the password: the inputs carry autocomplete attributes so the
 * browser's password manager can offer it instead.
 *
 * Browser storage can be missing or throw (private windows, blocked site
 * data), so every access is guarded and the launcher works without it.
 */

export const LAUNCHER_STORAGE_KEY = 'acjs.launcher.v1';

export interface RememberedLogin {
  /** Servers.xml id, 'local' for the pinned bridge, or 'custom:<wss url>'. */
  worldKey: string | null;
  account: string | null;
  /**
   * That world's era profile (null = end of retail): the next visit boots
   * straight into its DATs (era/EraBoot.ts) instead of loading end of retail
   * and reloading. Older records have none.
   */
  era?: string | null;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadRememberedLogin(storage: StorageLike | null = defaultStorage()): RememberedLogin {
  const empty: RememberedLogin = { worldKey: null, account: null, era: null };
  if (!storage) return empty;
  try {
    const raw = storage.getItem(LAUNCHER_STORAGE_KEY);
    if (!raw) return empty;
    const v = JSON.parse(raw) as Record<string, unknown>;
    return {
      worldKey: typeof v.worldKey === 'string' && v.worldKey ? v.worldKey : null,
      account: typeof v.account === 'string' && v.account ? v.account : null,
      era: typeof v.era === 'string' && v.era ? v.era : null,
    };
  } catch {
    return empty;
  }
}

/** Store only the world key, account name and era; anything else passed is dropped. */
export function saveRememberedLogin(login: RememberedLogin, storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(LAUNCHER_STORAGE_KEY, JSON.stringify({ worldKey: login.worldKey, account: login.account, era: login.era ?? null }));
  } catch {
    /* storage full or blocked: remembering is a convenience */
  }
}

/** The storage key of a world: its id, 'local', or 'custom:<url>'. */
export function worldKeyOf(world: { id: string | null; kind: string; bridgeUrl?: string }): string {
  if (world.kind === 'custom' && world.bridgeUrl) return `custom:${world.bridgeUrl}`;
  if (world.kind === 'local' || !world.id) return 'local';
  return world.id;
}

/**
 * Favourite worlds: the world keys (worldKeyOf) the player starred, oldest
 * first. Kept apart from the remembered login so either record can be
 * dropped without the other. A key whose world left the directory stays
 * stored (it comes back when the world does).
 */
export const LAUNCHER_FAVORITES_KEY = 'acjs.launcher.favorites.v1';
const MAX_FAVORITES = 64;

export function loadFavoriteWorlds(storage: StorageLike | null = defaultStorage()): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(LAUNCHER_FAVORITES_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const k of v) if (typeof k === 'string' && k && k.length <= 512 && !out.includes(k)) out.push(k);
    return out.slice(0, MAX_FAVORITES);
  } catch {
    return [];
  }
}

export function saveFavoriteWorlds(keys: readonly string[], storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(LAUNCHER_FAVORITES_KEY, JSON.stringify([...new Set(keys)].slice(0, MAX_FAVORITES)));
  } catch {
    /* storage full or blocked: favourites last for this visit only */
  }
}
