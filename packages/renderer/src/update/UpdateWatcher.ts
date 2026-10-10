/**
 * New-build detection for the hosted client (docs/release-plan.md, "update
 * notifier"). Each production build bakes in a build id (vite `define`
 * __ACJS_BUILD_ID__) and the web container serves /version.json with the
 * build it is running plus an optional `urgent` flag. A client whose baked id
 * differs from the served one is out of date.
 *
 * Applying an update is a page reload, which ends a live game session, so it
 * only happens at a natural break: on the launcher before a password has been
 * typed (no session, nothing to lose; the account name is remembered), or on
 * the way back to the launcher (World box, a refused login, a disconnect).
 * In the world the player gets one notice (a dialog if the build is urgent)
 * and keeps playing. This is browser-UX behaviour, not retail's: retail
 * patched before login only.
 */

export const VERSION_PATH = '/version.json';
export const DEV_BUILD_ID = 'dev';
export const DEFAULT_POLL_MS = 5 * 60 * 1000;

export interface ServedVersion {
  build: string;
  urgent: boolean;
}

export type Screen = 'launcher' | 'char-select' | 'world' | 'disconnected' | 'loading';

export type UpdateAction =
  | { kind: 'none' }
  | { kind: 'reload' }
  | { kind: 'notify'; urgent: boolean };

/** Parse /version.json; null for anything malformed. */
export function parseServedVersion(json: unknown): ServedVersion | null {
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  if (typeof o.build !== 'string' || o.build.trim() === '') return null;
  return { build: o.build.trim(), urgent: o.urgent === true };
}

/** The served build differs from ours (never for dev builds). */
export function isUpdateAvailable(currentBuild: string, served: ServedVersion | null): boolean {
  if (!served || currentBuild === DEV_BUILD_ID || served.build === DEV_BUILD_ID) return false;
  return served.build !== currentBuild;
}

/**
 * What to do about a pending update right now. `passwordTyped`: the launcher's
 * password field has input (reloading would throw it away).
 */
export function decideUpdateAction(opts: {
  pending: ServedVersion | null;
  screen: Screen;
  passwordTyped: boolean;
  alreadyNotified: boolean;
}): UpdateAction {
  const { pending, screen } = opts;
  if (!pending) return { kind: 'none' };
  if (screen === 'launcher' && !opts.passwordTyped) return { kind: 'reload' };
  // The Disconnected screen stays readable; leaving it (OK) or heading back
  // to the launcher reloads instead (reloadAtBreak).
  if ((screen === 'world' || screen === 'char-select') && !opts.alreadyNotified) {
    return { kind: 'notify', urgent: pending.urgent };
  }
  return { kind: 'none' };
}

/**
 * On the way back to the launcher (World box, a refused login, OK on the
 * Disconnected screen) a pending update reloads instead: the session is
 * already ending and the launcher comes back with the remembered account.
 */
export function reloadAtBreak(pending: ServedVersion | null): boolean {
  return pending !== null;
}

/** Player-facing notice text (browser-UX, no retail string exists). */
export function updateNoticeText(urgent: boolean): string {
  return urgent
    ? 'An important update to webAC is ready. Please log out to load it.'
    : 'A new version of webAC is ready. It will load the next time you return to the world list.';
}

export interface UpdateWatcherDeps {
  currentBuild: string;
  fetchFn?: typeof fetch;
  onAvailable: (served: ServedVersion) => void;
  pollMs?: number;
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
}

/** Polls /version.json; reports the first newer build (and an urgent upgrade of it). */
export class UpdateWatcher {
  private pending: ServedVersion | null = null;
  private timer: unknown = null;
  constructor(private readonly deps: UpdateWatcherDeps) {}

  get pendingVersion(): ServedVersion | null { return this.pending; }

  async check(): Promise<ServedVersion | null> {
    const fetchFn = this.deps.fetchFn ?? fetch;
    let served: ServedVersion | null = null;
    try {
      const resp = await fetchFn(VERSION_PATH, { cache: 'no-store' });
      if (resp.ok) served = parseServedVersion(await resp.json());
    } catch {
      served = null;
    }
    if (served && isUpdateAvailable(this.deps.currentBuild, served)) {
      const changed = !this.pending || this.pending.build !== served.build || (served.urgent && !this.pending.urgent);
      this.pending = served;
      if (changed) this.deps.onAvailable(served);
    }
    return this.pending;
  }

  start(): void {
    if (this.deps.currentBuild === DEV_BUILD_ID || this.timer !== null) return;
    const every = this.deps.pollMs ?? DEFAULT_POLL_MS;
    const setI = this.deps.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.timer = setI(() => { void this.check(); }, every);
    void this.check();
  }
}
