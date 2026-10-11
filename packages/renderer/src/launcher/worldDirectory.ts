/**
 * RELEASE.launcher-screen — where the launcher's world list comes from and
 * how a chosen world becomes a bridge connection URL.
 *
 * The configured bridge (RuntimeConfig.bridgeUrl) answers `GET /healthz`
 * with its mode:
 *   - "pinned": one fixed game server (local dev, operator-run bridges) →
 *     a single "Local server" world; connect to the bridge URL as is;
 *   - "multi": `GET /servers` lists the allowlisted worlds with live status
 *     (services/ws-tcp-bridge/src/serverDirectory.ts) → connect with
 *     `?server=<id>`.
 * A "Custom…" world is the wss:// URL of a server's own bridge, used as is.
 */

import { probeBridgeHealth } from '@ac/network';
import { eraProfile } from '../era/EraProfiles.js';

export type WorldCompat = 'ok' | 'beta' | 'incompatible';

export interface World {
  /** Servers.xml id (multi mode); null for the local/pinned and custom worlds. */
  id: string | null;
  name: string;
  emu: string | null;
  type: string | null;
  description: string | null;
  website: string | null;
  discord: string | null;
  /** null = status unknown (local, custom, or not watched by TreeStats). */
  online: boolean | null;
  population: number | null;
  compat: WorldCompat;
  compatNote: string | null;
  registration: string | null;
  kind: 'listed' | 'local' | 'custom';
  /** Custom worlds: the bridge URL to connect to. */
  bridgeUrl?: string;
  /**
   * The era profile the server needs (era/EraProfiles.ts): the /servers row
   * (the bridge's compat overlay) or a bridge's own /healthz `era`. null =
   * end of retail. Entering a world of another era reloads into its DATs.
   */
  era: string | null;
}

export interface WorldDirectory {
  mode: 'pinned' | 'multi';
  worlds: World[];
}

export const LOCAL_WORLD_NAME = 'Local server';

/** The bridge's HTTP origin for a ws:// / wss:// bridge URL (ws→http, wss→https). */
export function bridgeHttpOrigin(bridgeUrl: string): string | null {
  try {
    const u = new URL(bridgeUrl);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
    return `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
  } catch {
    return null;
  }
}

export function localWorld(era: string | null = null): World {
  return {
    id: null, name: LOCAL_WORLD_NAME, emu: null, type: null,
    description: 'The game server this bridge is pinned to.',
    website: null, discord: null, online: null, population: null,
    compat: 'ok', compatNote: null, registration: null, kind: 'local', era,
  };
}

/** An era id as the bridge reports it (lower-case slug), or null. */
export function eraIdFrom(v: unknown): string | null {
  return typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v) && v !== 'eor' ? v : null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const httpUrl = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
};

/** One /servers row → World; null for malformed rows. Links must be http(s). */
export function worldFromEntry(raw: unknown): World | null {
  const r = raw as Record<string, unknown> | null;
  const id = str(r?.id);
  if (!r || !id) return null;
  const compat = r.compat === 'beta' || r.compat === 'incompatible' ? r.compat : 'ok';
  const pop = Number(r.population);
  return {
    id,
    name: str(r.name) ?? id,
    emu: str(r.emu),
    type: str(r.type),
    description: str(r.description),
    website: httpUrl(r.website),
    discord: httpUrl(r.discord),
    online: typeof r.online === 'boolean' ? r.online : null,
    population: r.population !== null && r.population !== undefined && Number.isFinite(pop) && pop >= 0 ? Math.round(pop) : null,
    compat,
    compatNote: str(r.compatNote),
    registration: str(r.registration),
    kind: 'listed',
    era: eraIdFrom(r.era),
  };
}

/**
 * Ask the bridge what it is and list its worlds. Pinned (or a bridge too old
 * to answer /healthz with a mode) → the single local world. Throws when the
 * bridge cannot be reached at all.
 */
export async function loadWorldDirectory(bridgeUrl: string, fetchFn: typeof fetch = fetch): Promise<WorldDirectory> {
  const origin = bridgeHttpOrigin(bridgeUrl);
  if (!origin) throw new Error(`not a bridge URL: ${bridgeUrl}`);
  const health = await fetchFn(`${origin}/healthz`, { cache: 'no-store' });
  const hz = health.ok ? ((await health.json()) as { mode?: unknown; era?: unknown }) : {};
  if (hz.mode !== 'multi') return { mode: 'pinned', worlds: [localWorld(eraIdFrom(hz.era))] };
  const resp = await fetchFn(`${origin}/servers`, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`GET /servers: HTTP ${resp.status}`);
  const body = (await resp.json()) as { servers?: unknown };
  const worlds = Array.isArray(body.servers) ? body.servers.map(worldFromEntry).filter((w): w is World => w !== null) : [];
  return { mode: 'multi', worlds };
}

/** `bridgeUrl` with `?server=<id>` set (a multi-mode bridge's world choice). */
export function bridgeUrlWithServer(bridgeUrl: string, serverId: string): string {
  const u = new URL(bridgeUrl);
  u.searchParams.set('server', serverId);
  return u.toString();
}

/** The WebSocket URL to connect to for `world` through `bridgeUrl`. */
export function connectUrlFor(bridgeUrl: string, world: World): string {
  if (world.kind === 'custom' && world.bridgeUrl) return world.bridgeUrl;
  if (world.kind !== 'listed' || !world.id) return bridgeUrl;
  return bridgeUrlWithServer(bridgeUrl, world.id);
}

/**
 * The name the char-select World box shows for a launcher choice: the listed
 * (or custom) world's name; null for the local/pinned server, whose own
 * ServerName message names it.
 */
export function worldBoxName(world: World): string | null {
  return world.kind === 'local' ? null : world.name;
}

/** Why ENTER must not connect to `world`, or null when it may. */
export function worldEnterBlock(world: World | null): string | null {
  if (!world) return 'Pick a world first.';
  if (world.compat === 'incompatible') {
    return `${world.name} needs the classic Asheron's Call data files, which this client cannot load yet. Support is planned after launch. Pick another world.`;
  }
  if (world.online === false) return `${world.name} is offline right now. Pick another world.`;
  if (world.era && !eraProfile(world.era)) {
    return `${world.name} needs a kind of game data (${world.era}) this version of the client does not know. Reload the page to update, or pick another world.`;
  }
  return null;
}

/**
 * A custom (or pinned) bridge's era, so a classic server's own bridge loads
 * the right DATs: its WebSocket "health" answer first (the hosted page's CSP
 * allows wss: to any bridge but not an arbitrary https origin), then its
 * /healthz. null on any failure: end of retail, as before.
 */
export async function probeBridgeEra(
  bridgeUrl: string,
  fetchFn: typeof fetch = fetch,
  health: (url: string) => Promise<Record<string, unknown>> = async (u) => ({ ...(await probeBridgeHealth(u)) }),
): Promise<string | null> {
  try {
    const viaWs = await health(bridgeUrl);
    if (viaWs && typeof viaWs === 'object') return eraIdFrom(viaWs.era);
  } catch {
    /* fall back to /healthz */
  }
  const origin = bridgeHttpOrigin(bridgeUrl);
  if (!origin) return null;
  try {
    const resp = await fetchFn(`${origin}/healthz`, { cache: 'no-store' });
    if (!resp.ok) return null;
    return eraIdFrom(((await resp.json()) as { era?: unknown }).era);
  } catch {
    return null;
  }
}

/**
 * A "Custom…" bridge address → a custom world, or an error message. wss://
 * always; ws:// only for localhost (a browser on https refuses ws:// anyway).
 */
export function parseCustomBridge(input: string): { world: World } | { error: string } {
  const v = input.trim();
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(v) ? v : `wss://${v}`);
  } catch {
    return { error: 'That is not a bridge address. Enter the wss:// address the server publishes.' };
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'wss:' && !(u.protocol === 'ws:' && local)) {
    return { error: 'A custom server needs a wss:// bridge address (ws:// works only for localhost).' };
  }
  return {
    world: {
      id: null, name: u.host, emu: null, type: null,
      description: `Custom bridge ${u.toString()}`,
      website: null, discord: null, online: null, population: null,
      compat: 'ok', compatNote: null, registration: null, kind: 'custom', bridgeUrl: u.toString(), era: null,
    },
  };
}
