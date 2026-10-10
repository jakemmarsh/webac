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
