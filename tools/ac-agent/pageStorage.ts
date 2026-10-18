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
import { ITEM_TIMERS_KEY_PREFIX } from '../../packages/renderer/src/agent/macro/itemBuffLedger.ts';

/** The localStorage keys the agent API owns (AgentApi seenKinds / places / corpses / gearCasts). */
export const AGENT_STORAGE_PREFIX = 'acAgent.';
/**
 * Every prefix carried across launches: the agent API's, and the routine macro's item-buff timers (VTank BuffedItems,
 * itemBuffLedger.ts). Those were left behind until 2026-10-18, so after each segment's relaunch "Arcanist fights" judged
 * all seven Banes V missing and recast them on ten pieces 5 and 6 minutes after the last round (07:19, 08:21Z).
 */
export const AGENT_STORAGE_PREFIXES: readonly string[] = [AGENT_STORAGE_PREFIX, ITEM_TIMERS_KEY_PREFIX];
const carried = (k: string): boolean => AGENT_STORAGE_PREFIXES.some((p) => k.startsWith(p));

export interface SavedPageStorage { origin: string; items: Array<[string, string]> }

/** Where a profile's saved page storage lives. */
export function pageStorageFile(stateDir: string, profile: string): string {
  return join(stateDir, `${profile}.storage.json`);
}

/** The agent's own entries of a page's localStorage (other keys, the game's settings and caches, are not ours to carry). */
export function pickAgentStorage(entries: Iterable<[string, string]>): Array<[string, string]> {
  return [...entries].filter(([k, v]) => carried(k) && typeof v === 'string');
}

export function readPageStorage(file: string): SavedPageStorage | null {
  try {
    if (!existsSync(file)) return null;
    const j = JSON.parse(readFileSync(file, 'utf8')) as SavedPageStorage;
    if (typeof j?.origin !== 'string' || !Array.isArray(j.items)) return null;
    return { origin: j.origin, items: pickAgentStorage(j.items) };
  } catch { return null; }
}

/**
 * A save over the last one: the page's entries win, and keys only the old file holds stay (a page that started without
 * them, as the 08:20Z launch on a new port did, must not wipe what earlier launches learned).
 */
export function mergePageStorage(old: SavedPageStorage | null, page: SavedPageStorage): SavedPageStorage {
  const items = new Map(old?.items ?? []);
  for (const [k, v] of pickAgentStorage(page.items)) items.set(k, v);
  return { origin: page.origin, items: [...items] };
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
 * this is the saved origin or `gameOrigin` (this launch's own game page), leaving any the page already has. A plain
 * string, so no bundler helper rides along.
 *
 * `gameOrigin`: each launch serves its game snapshot from Vite on the first free port, so the origin moves when a port
 * is taken (3133 until 07:18Z, 3139 from the 08:20Z launch, 2026-10-18). The restore matched the saved origin only, put
 * nothing back on 3139, and the next minute's save wrote the empty page over the file: the Pumpkin Buffer seen buffing
 * Bulwark all week was a stranger again and stopped his walk "344.2 m short … coming at you (turned to face you)" at
 * 10:00:12Z, and his remembered places were gone.
 */
export function restorePageStorageScript(saved: SavedPageStorage, gameOrigin?: string): string {
  const origins = [...new Set([saved.origin, ...(gameOrigin ? [gameOrigin] : [])])];
  return `(() => { try { const s = ${JSON.stringify(saved)}; if (!${JSON.stringify(origins)}.includes(location.origin)) return; for (const [k, v] of s.items) if (localStorage.getItem(k) === null) localStorage.setItem(k, v); } catch (e) { /* storage blocked */ } })();`;
}

/** The origin of a game page URL ("http://localhost:3139/?ace&agent…" → "http://localhost:3139"), or undefined. */
export function gameOriginOf(url: string): string | undefined {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin : undefined; } catch { return undefined; }
}

/** The page side of a save: the origin and its agent entries (a string for page.evaluate, as above). */
export const READ_PAGE_STORAGE_JS = `(() => { try { const items = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && ${JSON.stringify(AGENT_STORAGE_PREFIXES)}.some((p) => k.startsWith(p))) items.push([k, localStorage.getItem(k)]); } return { origin: location.origin, items }; } catch (e) { return null; } })()`;
