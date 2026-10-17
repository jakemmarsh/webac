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
import { LOGIN_REFUSED_TOKENS } from '../ui/ConnectionNotices.js';
import { accountBootedText, PASSWORD_MISMATCH_BOOT_REASON } from '../session/AccountBoot.js';

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
  /**
   * compat 'incompatible': the bridge's one-sentence reason nobody can play
   * there from webAC (e.g. a VPN check that refuses the bridge). null from a
   * bridge that predates it, or for any other world.
   */
  compatReason: string | null;
  /** A note for worlds that need an account registered before the first login. */
  registration: string | null;
  /** Where to register (http/https); the launcher links it. null when unknown. */
  registrationUrl: string | null;
  kind: 'listed' | 'local' | 'custom';
  /** Custom worlds: the bridge URL to connect to. */
  bridgeUrl?: string;
  /**
   * The era profile the server needs (era/EraProfiles.ts): the /servers row
   * (the bridge's compat overlay) or a bridge's own /healthz `era`. null =
   * end of retail. Entering a world of another era reloads into its DATs.
   */
  era: string | null;
  /**
   * A custom bridge that answered neither era probe (unreachable, or refused
   * by the page's CSP, e.g. ws://localhost on playwebac.com): its era is not
   * known, so ENTER stays in this page's era instead of reloading into end
   * of retail for a server that may be nothing of the kind (launcherLogin.ts
   * launcherEraTarget).
   */
  eraUnknown?: boolean;
  /**
   * The bridge's short warning for a world that can be entered but is
   * limited from webAC (the public AC1999 server's per-address account cap):
   * shown in the details box where the new-player hint goes. null/absent: none.
   */
  compatWarning?: string | null;
  /**
   * The server's per-address caps (accounts created, sessions at once), which
   * every webAC player shares through the bridge's one address; they change
   * what its login refusals mean (loginFailureText). null/absent: none known.
   */
  perIpLimits?: PerIpLimits | null;
}

/** A server's per-IP caps (0 = unlimited): the bridge's CompatEntry.perIpLimits. */
export interface PerIpLimits {
  accounts: number;
  sessions: number;
}

/** A /servers row's (or a stashed world's) perIpLimits, or null when absent or malformed. */
export function perIpLimitsFrom(v: unknown): PerIpLimits | null {
  const r = v as Record<string, unknown> | null | undefined;
  if (!r || typeof r !== 'object') return null;
  const n = (x: unknown): number | null => (typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : null);
  const accounts = n(r.accounts);
  const sessions = n(r.sessions);
  if (accounts === null || sessions === null || (accounts === 0 && sessions === 0)) return null;
  return { accounts, sessions };
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
    compat: 'ok', compatNote: null, compatReason: null, registration: null, registrationUrl: null, kind: 'local', era,
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
    compatReason: compat === 'incompatible' ? str(r.compatReason) : null,
    registration: str(r.registration),
    registrationUrl: httpUrl(r.registrationUrl),
    kind: 'listed',
    era: eraIdFrom(r.era),
    compatWarning: compat === 'incompatible' ? null : str(r.compatWarning),
    perIpLimits: perIpLimitsFrom(r.perIpLimits),
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
    // The bridge's reason (a VPN check that refuses every webAC player), else
    // its chip (an older bridge; "Unsupported client version"). Classic data
    // is supported now, so this no longer blames it.
    if (world.compatReason) {
      const why = world.compatReason.charAt(0).toLowerCase() + world.compatReason.slice(1);
      return `${world.name} can't be played from webAC yet: ${why} Pick another world for now.`;
    }
    const why = world.compatNote ? ` (${world.compatNote}).` : '.';
    return `${world.name} can't be played from webAC${why} Pick another world.`;
  }
  if (world.online === false) return `${world.name} is offline right now. Pick another world.`;
  if (world.era && !eraProfile(world.era)) {
    return `${world.name} needs a kind of game data (${world.era}) this version of the client does not know. Reload the page to update, or pick another world.`;
  }
  return null;
}

/** The registration line a world carries, in the launcher's words (null: none). */
export function worldRegistrationText(world: Pick<World, 'name' | 'registration' | 'registrationUrl'>): string | null {
  if (world.registration) return world.registration;
  return world.registrationUrl ? `Register on the ${world.name} website first.` : null;
}

/**
 * A refused-login failure for a login to `world`: the connection timeout
 * ("Client timed out the connection", a world that answers an unknown
 * account with silence) or the server's login-failed NetError ("Client logon
 * failed", GDLE's STR_LOGIN_FAILED). That is what a new player on a world
 * that only takes web-registered accounts sees; for those worlds the text
 * also says to register, and where.
 */
export function loginTimeoutText(base: string, world: Pick<World, 'name' | 'registration' | 'registrationUrl'> | null): string {
  const reg = world ? worldRegistrationText(world) : null;
  if (!world || !reg) return base;
  return `${base}\n\nNew account? ${reg}${world.registrationUrl ? ` ${world.registrationUrl}` : ''}`;
}

/**
 * The launcher's line under a wrong-password refusal on a world that creates
 * accounts on first login (ACE / ClassicACE AllowAutoAccountCreate, GDLE and
 * the AC1999 server's auto_create_accounts=1, all on by default). There an
 * unknown name is simply created, so the refusal means the name already
 * exists: a newcomer who picks a common name gets someone else's account.
 * The other cause seen live (2026-10-13): the browser keeps one saved
 * password per account name per site, so the same name on two worlds
 * autofills the other world's password.
 */
export const ACCOUNT_NAME_TAKEN_HINT =
  "If you're new to this world, that account name may already belong to someone else: try a different account name. "
  + '(Your browser may also have filled in a password saved for another world.)';

/**
 * The same hint after a refusal whose own text does not say "password" (GDLE / AC1999 "Client logon failed").
 * GDLE sends that one refusal (STR_LOGIN_FAILED) for a wrong password AND for its own account query
 * failing (Network.cpp AuthenticateUserQuery::PerformQuery → CDatabaseIO::VerifyAccount
 * VERIFYACCOUNT_ERROR_QUERY_FAILED), which passes again minutes later: Snowreap refused a returning
 * player twice and a brand-new account once, each accepted soon after (2026-10-17).
 */
export const LOGON_FAILED_HINT = `That usually means a wrong password for this account name. ${ACCOUNT_NAME_TAKEN_HINT} `
  + 'If this name and password worked before, the server may be having trouble: wait a minute and try again.';

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const countWord = (n: number): string => COUNT_WORDS[n] ?? String(n);
const capitalized = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The launcher's line under a ClientLogOnFailed on a world that caps the
 * accounts created from one address (the AC1999 server's
 * max_accounts_per_ip): its auto-create refuses a new name once the bridge's
 * address has used its quota, with the same STR_LOGIN_FAILED it sends for a
 * wrong password, so the refusal is either. Replaces LOGON_FAILED_HINT, whose
 * "try a different account name" sends a newcomer round in circles there.
 */
export function perIpLogonFailedText(limits: PerIpLimits): string {
  const n = countWord(limits.accounts);
  return `This server allows ${n} account${limits.accounts === 1 ? '' : 's'} per network address, and every webAC player shares ours, `
    + "so new accounts can't be created through webAC here yet. "
    + 'If this is an account you already have, check its password.';
}

/**
 * The line under a ServerFull on a world that caps the sessions online at
 * once from one address (max_sessions_per_ip): every webAC player counts
 * against the same cap, so the server is "full" for webAC only.
 */
export function perIpServerFullText(limits: PerIpLimits): string {
  const n = limits.sessions;
  const who = n === 1 ? 'One webAC player is' : `${capitalized(countWord(n))} webAC players are`;
  return `${who} already on this server; it allows ${countWord(n)} per network address, and every webAC player shares ours. Try again later.`;
}

/**
 * The text of a connection-failure dialog (ConnectionNotices'
 * netErrorNotice / serverNetErrorNotice) for a login to `world`: a refused
 * login before entering the world (LOGIN_REFUSED_TOKENS: the timeout, or
 * GDLE's / the AC1999 server's "Client logon failed" NetError) carries the
 * registration hint on a register-first world. On any other world "Client
 * logon failed" (STR_LOGIN_FAILED) is a wrong password for an existing
 * account (AuthenticateUserQuery::PerformQuery auto-creates unknown names),
 * so it carries LOGON_FAILED_HINT. A Custom… world whose bridge never
 * answered (CantSocket) gets customBridgeUnansweredText. Anything else, or
 * anything once in the world, is the notice text alone.
 */
export function loginFailureText(
  notice: { readonly token: string; readonly text: string },
  world: (Pick<World, 'name' | 'registration' | 'registrationUrl'> & Partial<Pick<World, 'kind' | 'bridgeUrl' | 'perIpLimits'>>) | null,
  inWorld: boolean,
): string {
  // A Custom… world's bridge that never answered: say that, not retail's
  // "make sure you have a working network" (listed worlds keep retail's text).
  if (!inWorld && world?.kind === 'custom' && notice.token === 'ID_NetError_CantSocket') return customBridgeUnansweredText(world);
  // A world whose per-address caps every webAC player shares (perIpLimits):
  // its refused create and its session cap read as that, not as a taken name
  // or a full server.
  const limits = world?.perIpLimits;
  if (!inWorld && limits) {
    if (notice.token === 'ID_ConnectionError_ClientLogOnFailed' && limits.accounts > 0) return `${notice.text}\n\n${perIpLogonFailedText(limits)}`;
    if (notice.token === 'ID_ConnectionError_ServerFull' && limits.sessions > 0) return `${notice.text}\n\n${perIpServerFullText(limits)}`;
  }
  if (inWorld || !LOGIN_REFUSED_TOKENS.has(notice.token)) return notice.text;
  if (world && worldRegistrationText(world)) return loginTimeoutText(notice.text, world);
  return notice.token === 'ID_ConnectionError_ClientLogOnFailed' ? `${notice.text}\n\n${LOGON_FAILED_HINT}` : notice.text;
}

/**
 * The text of an AccountBoot (0xF7DC) for a login to `world`: retail's
 * "You have been booted from Asheron's Call%s." with the server's reason
 * (accountBootedText), plus ACCOUNT_NAME_TAKEN_HINT when it is ACE's
 * wrong-password boot before the world on a world that is not
 * register-first (a register-first world never hands a newcomer a taken
 * name; its registration refuses it).
 */
export function accountBootLoginText(
  reason: string | undefined | null,
  world: Pick<World, 'name' | 'registration' | 'registrationUrl'> | null,
  inWorld: boolean,
): string {
  const text = accountBootedText(reason);
  if (inWorld || reason !== PASSWORD_MISMATCH_BOOT_REASON) return text;
  if (world && worldRegistrationText(world)) return text;
  return `${text}\n\n${ACCOUNT_NAME_TAKEN_HINT}`;
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
  return (await probeCustomBridge(bridgeUrl, fetchFn, health)).era;
}

/**
 * probeBridgeEra, also saying whether the bridge answered at all: `reachable`
 * is false when neither its WebSocket health probe nor its /healthz answered
 * (an HTTP error status still counts as an answer). The launcher must not
 * read an unreachable bridge as an end-of-retail one (World.eraUnknown).
 */
export async function probeCustomBridge(
  bridgeUrl: string,
  fetchFn: typeof fetch = fetch,
  health: (url: string) => Promise<Record<string, unknown>> = async (u) => ({ ...(await probeBridgeHealth(u)) }),
): Promise<{ reachable: boolean; era: string | null }> {
  try {
    const viaWs = await health(bridgeUrl);
    if (viaWs && typeof viaWs === 'object') return { reachable: true, era: eraIdFrom(viaWs.era) };
  } catch {
    /* fall back to /healthz */
  }
  const origin = bridgeHttpOrigin(bridgeUrl);
  if (!origin) return { reachable: false, era: null };
  try {
    const resp = await fetchFn(`${origin}/healthz`, { cache: 'no-store' });
    if (!resp.ok) return { reachable: true, era: null };
    return { reachable: true, era: eraIdFrom(((await resp.json()) as { era?: unknown }).era) };
  } catch {
    return { reachable: false, era: null };
  }
}

/**
 * What Custom… says to an AC game server's own address (what AC players
 * habitually type: `host:9000`, `1.2.3.4:9050`, `udp://…`). webAC reaches a
 * server only through a WebSocket bridge, so trying it as `wss://host:9000`
 * found nothing and the player got retail's CantSocket "Make sure you have a
 * working network" (production 2026-10-12/13, server=custom-bridge).
 */
export const GAME_SERVER_ADDRESS_ERROR =
  "That looks like a game server's address. Custom… needs the server's own webAC bridge (a wss:// address). "
  + 'Most servers are already in the world list.';

/** The port range AC game servers listen on (ACE 9000/9001, GDLE 9050, others nearby). */
const GAME_PORT_MIN = 9000;
const GAME_PORT_MAX = 9999;

/**
 * True for a Custom… entry that is an AC game server's address rather than a
 * bridge's: a udp:// / tcp:// address, or a scheme-less one with a port in
 * AC's game range or a bare IPv4 host with a port (a wss:// bridge has a
 * TLS hostname). A plain hostname (bridge on 443), a scheme-less hostname on
 * another port, and anything written as ws(s):// are left to the parser.
 */
export function looksLikeGameServerAddress(input: string): boolean {
  const v = input.trim();
  if (/^(udp|tcp):\/\//i.test(v)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return false;
  const m = /^([^/:?#\s]+):(\d{1,5})(?:[/?#]|$)/.exec(v);
  if (!m) return false;
  const port = Number(m[2]);
  if (port >= GAME_PORT_MIN && port <= GAME_PORT_MAX) return true;
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(m[1]);
}

/**
 * The connect-failure text for a Custom… world whose bridge never answered
 * (ID_NetError_CantSocket): retail's "Couldn't create local socket. Make
 * sure you have a working network." blames the player's network, when the
 * usual cause is an address with no webAC bridge behind it.
 */
export function customBridgeUnansweredText(world: Pick<World, 'name' | 'bridgeUrl'>): string {
  let host = world.name;
  try { if (world.bridgeUrl) host = new URL(world.bridgeUrl).host || host; } catch { /* keep the name */ }
  return `No webAC bridge answered at ${host}. A Custom… world needs the wss:// address of the server's own webAC bridge, `
    + "not its game server address. Check the address with the server's operators, or pick a world from the list.";
}

/**
 * A "Custom…" bridge address → a custom world, or an error message. wss://
 * always; ws:// only for localhost (a browser on https refuses ws:// anyway).
 */
export function parseCustomBridge(input: string): { world: World } | { error: string } {
  const v = input.trim();
  if (looksLikeGameServerAddress(v)) return { error: GAME_SERVER_ADDRESS_ERROR };
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
      compat: 'ok', compatNote: null, compatReason: null, registration: null, registrationUrl: null, kind: 'custom', bridgeUrl: u.toString(), era: null,
    },
  };
}
