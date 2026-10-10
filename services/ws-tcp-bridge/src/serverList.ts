/**
 * The multi-server allowlist (RELEASE Phase 2: "connect by server id, no open
 * relay"). A browser names a server by id (`?server=<id>`); the bridge only
 * ever forwards to hosts on this list:
 *
 *   1. the community list, acresources/serverslist Servers.xml (what
 *      ThwargLauncher reads), refreshed every BRIDGE_SERVERS_REFRESH_MS; the
 *      last good copy is cached to disk and used until a refresh succeeds;
 *   2. an optional local overlay (BRIDGE_SERVERS_OVERLAY file and/or
 *      BRIDGE_SERVERS_OVERLAY_JSON) adding servers and denying ids/hosts.
 *
 * Never fails open: with no list loaded, ids that would come from it are
 * rejected; only overlay servers still resolve.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Logger } from './log.js';

export const DEFAULT_SERVERS_URL = 'https://raw.githubusercontent.com/acresources/serverslist/master/Servers.xml';
export const DEFAULT_SERVERS_REFRESH_MS = 30 * 60 * 1000;

export interface ServerEntry {
  id: string;
  name: string;
  /** "ACE", "GDL", "GDLE", ... — informational; both emulators take the
   *  ConnectResponse on port+1 and answer from the base port or port+1. */
  emu: string;
  host: string;
  /** Base (login) port. The world port is port + 1 (ACE and GDLE both bind it). */
  port: number;
  source: 'list' | 'overlay';
  /** Listing details (Servers.xml description / type / website_url /
   *  discord_url); shown by the launcher via GET /servers, never used to route. */
  description?: string;
  /** "PvE" / "PvP" ... */
  type?: string;
  website?: string;
  discord?: string;
}

/** An http(s) URL from a listing field, or undefined. Scheme-less values
 *  ("gdleac.com") get https://; anything else (javascript:, ...) is dropped. */
export function normalizeLinkUrl(raw: unknown): string | undefined {
  const v = String(raw ?? '').trim();
  if (!v) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function details(get: (name: string) => string): Pick<ServerEntry, 'description' | 'type' | 'website' | 'discord'> {
  const out: Pick<ServerEntry, 'description' | 'type' | 'website' | 'discord'> = {};
  const description = get('description');
  const type = get('type');
  const website = normalizeLinkUrl(get('website_url') || get('website'));
  const discord = normalizeLinkUrl(get('discord_url') || get('discord'));
  if (description) out.description = description;
  if (type) out.type = type;
  if (website) out.website = website;
  if (discord) out.discord = discord;
  return out;
}

export interface ServerOverlay {
  servers: ServerEntry[];
  /** Server ids or hostnames (case-insensitive) never to bridge to. */
  deny: string[];
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXmlText(s: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  if (cdata) return cdata[1];
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : m;
    }
    return ENTITY[e.toLowerCase()] ?? m;
  }).trim();
}

/** Hostname or IPv4 literal: letters, digits, dots, hyphens; no leading hyphen/dot. */
export function isValidHost(host: string): boolean {
  return host.length > 0 && host.length <= 253 && /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host) && !host.includes('..');
}

function validPort(p: number): boolean {
  // port + 1 must also be a valid port (the world port).
  return Number.isInteger(p) && p >= 1 && p <= 65534;
}

function tag(block: string, name: string): string {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? decodeXmlText(m[1]) : '';
}

/**
 * Parse Servers.xml into entries. Items with a missing id, an invalid host or
 * an invalid port are skipped (counted in `skipped`); duplicate ids keep the
 * first occurrence.
 */
export function parseServersXml(xml: string): { servers: ServerEntry[]; skipped: number } {
  const servers: ServerEntry[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  const items = xml.match(/<ServerItem(?:\s[^>]*)?>[\s\S]*?<\/ServerItem>/gi) ?? [];
  for (const block of items) {
    const id = tag(block, 'id');
    const host = tag(block, 'server_host').toLowerCase();
    const port = Number(tag(block, 'server_port'));
    if (!id || !isValidHost(host) || !validPort(port) || seen.has(id.toLowerCase())) { skipped++; continue; }
    seen.add(id.toLowerCase());
    servers.push({
      id, name: tag(block, 'name') || id, emu: tag(block, 'emu') || 'ACE', host, port, source: 'list',
      ...details((n) => tag(block, n)),
    });
  }
  return { servers, skipped };
}

/**
 * Parse an overlay: `{ "servers": [{ "id", "name"?, "emu"?, "host", "port" }],
 * "deny": ["<id or host>"] }`. Throws on malformed JSON or entries, so a typo
 * in the operator's overlay is loud at startup rather than silently ignored.
 */
export function parseOverlay(json: string): ServerOverlay {
  const raw = JSON.parse(json) as { servers?: unknown; deny?: unknown };
  const servers: ServerEntry[] = [];
  if (raw.servers !== undefined) {
    if (!Array.isArray(raw.servers)) throw new Error('overlay "servers" must be an array');
    for (const s of raw.servers as Record<string, unknown>[]) {
      const id = String(s?.id ?? '').trim();
      const host = String(s?.host ?? '').trim().toLowerCase();
      const port = Number(s?.port);
      if (!id) throw new Error('overlay server without an id');
      if (!isValidHost(host)) throw new Error(`overlay server ${id}: invalid host "${host}"`);
      if (!validPort(port)) throw new Error(`overlay server ${id}: invalid port "${String(s?.port)}"`);
      servers.push({
        id, name: String(s.name ?? id), emu: String(s.emu ?? 'ACE'), host, port, source: 'overlay',
        ...details((n) => (s[n] === undefined || s[n] === null ? '' : String(s[n]).trim())),
      });
    }
  }
  let deny: string[] = [];
  if (raw.deny !== undefined) {
    if (!Array.isArray(raw.deny)) throw new Error('overlay "deny" must be an array');
    deny = (raw.deny as unknown[]).map(d => String(d).trim().toLowerCase()).filter(d => d.length > 0);
  }
  return { servers, deny };
}

/** The public AC1999 server (AC1999's Launcher/launcher.h); not in Servers.xml (checked 2026-10-06). */
export const AC1999_PUBLIC_SERVER: Readonly<ServerEntry> = Object.freeze({
  id: 'ac1999',
  name: 'AC1999',
  emu: 'AC1999',
  host: 'ac1999.cobradragon.com',
  port: 9110,
  source: 'overlay',
  description: 'The world as it launched in November 1999, run by the AC1999 project.',
  website: 'https://gitlab.com/adamplumb/ac1999',
});

/** BRIDGE_AC1999_LOCAL's row id (our Docker server, tools/ac1999/start-ac1999.sh). */
export const AC1999_LOCAL_ID = 'ac1999-local';

/**
 * The AC1999 (Nov 1999) worlds the bridge lists itself, since Servers.xml has
 * none: the public server always, and a local one only when
 * BRIDGE_AC1999_LOCAL=<host>:<port> names it (local dev; a loopback host also
 * needs BRIDGE_ALLOW_PRIVATE_TARGETS=1). Their era comes from the compat
 * overlay by emu "AC1999" (serverCompat.ts). An operator overlay can deny
 * either id. Throws on a malformed BRIDGE_AC1999_LOCAL, like a bad overlay.
 */
export function ac1999Overlay(env: Readonly<Record<string, string | undefined>>): ServerOverlay {
  const servers: ServerEntry[] = [{ ...AC1999_PUBLIC_SERVER }];
  const local = env.BRIDGE_AC1999_LOCAL?.trim();
  if (local) {
    const m = /^([^:\s]+):(\d+)$/.exec(local);
    const host = m?.[1].toLowerCase() ?? '';
    const port = Number(m?.[2]);
    if (!m || !isValidHost(host) || !validPort(port)) {
      throw new Error(`BRIDGE_AC1999_LOCAL must be <host>:<port>, got "${local}"`);
    }
    servers.push({
      id: AC1999_LOCAL_ID, name: 'AC1999 (local)', emu: 'AC1999', host, port, source: 'overlay',
      description: 'The local AC1999 server (tools/ac1999/start-ac1999.sh).',
    });
  }
  return { servers, deny: [] };
}

export function mergeOverlays(...overlays: ServerOverlay[]): ServerOverlay {
  return { servers: overlays.flatMap(o => o.servers), deny: overlays.flatMap(o => o.deny) };
}

export type FetchText = (url: string, timeoutMs: number) => Promise<string>;

export const defaultFetchText: FetchText = async (url, timeoutMs) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'acjs-bridge' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

export interface ServerRegistryOptions {
  /** null = no remote list (overlay only). */
  url: string | null;
  refreshMs: number;
  /** Where the last good Servers.xml is kept; null = no disk cache. */
  cachePath: string | null;
  overlay: ServerOverlay;
  fetchText?: FetchText;
  now?: () => number;
  log?: Logger;
}

export class ServerRegistry {
  private list: ServerEntry[] = [];
  private listLoadedAt: number | null = null;
  private listSource: 'none' | 'remote' | 'cache' = 'none';
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly fetchText: FetchText;
  private readonly now: () => number;
  private readonly log: Logger;
  lastError: string | null = null;

  constructor(private readonly opts: ServerRegistryOptions) {
    this.fetchText = opts.fetchText ?? defaultFetchText;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** Load the disk cache, try one refresh, then refresh periodically. Never throws. */
  async start(): Promise<void> {
    this.loadCache();
    await this.refresh();
    if (this.opts.url && this.opts.refreshMs > 0) {
      this.timer = setInterval(() => { void this.refresh(); }, this.opts.refreshMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Accept a parsed list only if it has at least one server; keep the old one otherwise. */
  private accept(xml: string, source: 'remote' | 'cache', loadedAt: number): boolean {
    const { servers, skipped } = parseServersXml(xml);
    if (servers.length === 0) {
      this.lastError = `${source}: no valid servers in list`;
      this.log('warn', 'servers_list_rejected', { source, reason: 'empty', skipped });
      return false;
    }
    this.list = servers;
    this.listLoadedAt = loadedAt;
    this.listSource = source;
    this.log('info', 'servers_list_loaded', { source, servers: servers.length, skipped });
    return true;
  }

  private loadCache(): void {
    const p = this.opts.cachePath;
    if (!p) return;
    try {
      const xml = fs.readFileSync(p, 'utf8');
      this.accept(xml, 'cache', fs.statSync(p).mtimeMs);
    } catch {
      /* no cache yet */
    }
  }

  /** Fetch + parse the remote list; on any failure keep the current list. */
  async refresh(): Promise<boolean> {
    if (!this.opts.url) return false;
    try {
      const xml = await this.fetchText(this.opts.url, 15_000);
      if (!this.accept(xml, 'remote', this.now())) return false;
      this.lastError = null;
      this.writeCache(xml);
      return true;
    } catch (err) {
      this.lastError = (err as Error).message;
      this.log('warn', 'servers_list_fetch_failed', { url: this.opts.url, error: this.lastError, keeping: this.listSource });
      return false;
    }
  }

  private writeCache(xml: string): void {
    const p = this.opts.cachePath;
    if (!p) return;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, xml);
      fs.renameSync(tmp, p);
    } catch (err) {
      this.log('warn', 'servers_cache_write_failed', { path: p, error: (err as Error).message });
    }
  }

  private denied(s: ServerEntry): boolean {
    const deny = this.opts.overlay.deny;
    return deny.includes(s.id.toLowerCase()) || deny.includes(s.host.toLowerCase());
  }

  /** The allowlisted server for `id` (case-insensitive), or null. Overlay
   *  servers win over list servers with the same id; denied ids/hosts never resolve. */
  lookup(id: string): ServerEntry | null {
    const key = id.trim().toLowerCase();
    if (!key) return null;
    const hit = this.opts.overlay.servers.find(s => s.id.toLowerCase() === key)
      ?? this.list.find(s => s.id.toLowerCase() === key);
    if (!hit || this.denied(hit)) return null;
    return hit;
  }

  /** Every server currently allowed (overlay first, then list; denied removed). */
  all(): ServerEntry[] {
    const ids = new Set<string>();
    const out: ServerEntry[] = [];
    for (const s of [...this.opts.overlay.servers, ...this.list]) {
      const k = s.id.toLowerCase();
      if (ids.has(k) || this.denied(s)) continue;
      ids.add(k);
      out.push(s);
    }
    return out;
  }

  status(): { source: string; servers: number; ageSeconds: number | null; lastError: string | null } {
    return {
      source: this.listSource,
      servers: this.all().length,
      ageSeconds: this.listLoadedAt === null ? null : Math.max(0, Math.round((this.now() - this.listLoadedAt) / 1000)),
      lastError: this.lastError,
    };
  }
}
