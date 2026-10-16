/**
 * The agent page's own memory across daemon launches. The daemon opens a fresh browser context each launch
 * (chromium.launch + newPage), so the page's localStorage starts empty every time, and the stream restarts each
 * profile's daemon every segment or so (Bulwark's: 17 launches on 2026-10-16). What the agent API keeps there
 * (`acAgent.*`: the kinds of creature seen only buffing you, remembered places) was gone each time: the Pumpkin
 * Buffer, seen casting 28 Incantations on Bulwark in the morning, was a stranger again after the 20:51Z launch and
 * stopped his walk "421.4 m short … coming at you (turned to face you)" at 21:12:13Z.
 *
 * The daemon saves those keys to a file in its state dir (every minute and at shutdown) and puts them back before
 * the game's scripts run on the next launch (an init script), for the same page origin only and never over a value
 * the page already holds.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The localStorage keys the agent API owns (AgentApi seenKinds / places). */
export const AGENT_STORAGE_PREFIX = 'acAgent.';

export interface SavedPageStorage { origin: string; items: Array<[string, string]> }

/** Where a profile's saved page storage lives. */
export function pageStorageFile(stateDir: string, profile: string): string {
  return join(stateDir, `${profile}.storage.json`);
}

/** The agent's own entries of a page's localStorage (other keys, the game's settings and caches, are not ours to carry). */
export function pickAgentStorage(entries: Iterable<[string, string]>): Array<[string, string]> {
  return [...entries].filter(([k, v]) => k.startsWith(AGENT_STORAGE_PREFIX) && typeof v === 'string');
}

export function readPageStorage(file: string): SavedPageStorage | null {
  try {
    if (!existsSync(file)) return null;
    const j = JSON.parse(readFileSync(file, 'utf8')) as SavedPageStorage;
    if (typeof j?.origin !== 'string' || !Array.isArray(j.items)) return null;
    return { origin: j.origin, items: pickAgentStorage(j.items) };
  } catch { return null; }
}

/** Write atomically (a half-written file would lose it all on the next launch). Nothing to save: the old file stays. */
export function writePageStorage(file: string, saved: SavedPageStorage): boolean {
  if (!saved.origin || !saved.items.length) return false;
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(saved));
  renameSync(tmp, file);
  return true;
}

/**
 * The init script (runs in the page before its own scripts, on every navigation): put the saved entries back when
 * this is the saved origin, leaving any the page already has. A plain string, so no bundler helper rides along.
 */
export function restorePageStorageScript(saved: SavedPageStorage): string {
  return `(() => { try { const s = ${JSON.stringify(saved)}; if (location.origin !== s.origin) return; for (const [k, v] of s.items) if (localStorage.getItem(k) === null) localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } })();`;
}

/** The page side of a save: the origin and its agent entries (a string for page.evaluate, as above). */
export const READ_PAGE_STORAGE_JS = `(() => { try { const items = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(${JSON.stringify(AGENT_STORAGE_PREFIX)})) items.push([k, localStorage.getItem(k)]); } return { origin: location.origin, items }; } catch (e) { return null; } })()`;
