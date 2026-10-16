/**
 * The launcher's world list (RELEASE.launcher-screen): `GET /servers` on a
 * multi-mode bridge. Merges, per allowlisted server (ServerRegistry.all()):
 *
 *   - live status from TreeStats (`servers.treestats.net/api/servers/`, keyed
 *     by the Servers.xml id = TreeStats `guid`),
 *   - approximate population from TreeStats player counts
 *     (`treestats.net/player_counts-latest.json`, keyed by server name;
 *     Decal-plugin based, so a floor, not a census),
 *   - the committed era/compat overlay (serverCompat.ts),
 *   - each ACE server's era, detected live from the login version it
 *     accepts (eraDetect.ts) where the overlay names none.
 *
 * Both feeds are fetched server-side and cached (refresh ~5 min) so browsers
 * never hit TreeStats directly, and a feed failure keeps the last good copy.
 */
import type { Logger } from './log.js';
import type { FetchText, ServerEntry } from './serverList.js';
import { type Compat, type CompatEntry, type CompatOverlay, type PerIpLimits, NO_PROBE_ERAS, SERVER_COMPAT, compatFor } from './serverCompat.js';
import type { Detection, EraDetector } from './eraDetect.js';

export const TREESTATS_STATUS_URL = 'https://servers.treestats.net/api/servers/';
export const TREESTATS_COUNTS_URL = 'https://treestats.net/player_counts-latest.json';
export const DEFAULT_DIRECTORY_REFRESH_MS = 5 * 60 * 1000;
/** Player counts older than this are not shown (the plugin feed goes quiet). */
export const POPULATION_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export interface ServerStatus { online: boolean; lastSeen: string | null }
export interface PlayerCount { count: number; at: number | null }

export interface DirectoryEntry {
  id: string;
  name: string;
  emu: string;
  type: string | null;
  description: string | null;
  website: string | null;
  discord: string | null;
  /** null = no status known (e.g. an operator overlay server TreeStats does not watch). */
  online: boolean | null;
  lastSeen: string | null;
  /** Approximate players online; null when unknown, stale, or the server is offline. */
  population: number | null;
  compat: Compat;
  compatNote: string | null;
  /** compat 'incompatible': why nobody can play there from webAC (CompatEntry.reason); else null. */
  compatReason: string | null;
  registration: string | null;
  /** Where to register (http/https), or null. */
  registrationUrl: string | null;
  /** The era profile the server needs; null = end of retail. */
  era: string | null;
  /** CompatEntry.warning: a short note for a world that is enterable but limited from webAC; else null. */
  compatWarning: string | null;
  /** CompatEntry.perIpLimits: the server's per-address caps, which all webAC players share; else null. */
  perIpLimits: PerIpLimits | null;
}

export interface DirectoryBody {
  mode: 'multi';
  updatedAt: string | null;
  servers: DirectoryEntry[];
}

/** TreeStats status JSON → id (lower-case) → status. Malformed rows are skipped. */
export function parseTreeStatsStatus(json: unknown): Map<string, ServerStatus> {
  const out = new Map<string, ServerStatus>();
  const rows = (json as { servers?: unknown })?.servers;
  if (!Array.isArray(rows)) return out;
  for (const r of rows as Record<string, unknown>[]) {
    const guid = typeof r?.guid === 'string' ? r.guid.trim().toLowerCase() : '';
    const st = r?.status as Record<string, unknown> | undefined;
    if (!guid || !st || typeof st.online !== 'boolean') continue;
    out.set(guid, { online: st.online, lastSeen: typeof st.last_seen === 'string' ? st.last_seen : null });
  }
  return out;
}

/** TreeStats player counts JSON → server name (lower-case) → count. */
export function parsePlayerCounts(json: unknown): Map<string, PlayerCount> {
  const out = new Map<string, PlayerCount>();
  if (!Array.isArray(json)) return out;
  for (const r of json as Record<string, unknown>[]) {
    const name = typeof r?.server === 'string' ? r.server.trim().toLowerCase() : '';
    const count = Number(r?.count);
    if (!name || !Number.isFinite(count) || count < 0) continue;
    // "2026-10-04 16:09:42 UTC" → ISO
    const at = typeof r.date === 'string' ? Date.parse(r.date.replace(' UTC', 'Z').replace(' ', 'T')) : NaN;
    out.set(name, { count: Math.round(count), at: Number.isFinite(at) ? at : null });
  }
  return out;
}

/**
 * Sort order of the world list: online worlds by population (unknown counts
 * as 0) then name; worlds with unknown status next; offline last, by name.
 */
export function compareEntries(a: DirectoryEntry, b: DirectoryEntry): number {
  const rank = (e: DirectoryEntry) => (e.online === true ? 0 : e.online === null ? 1 : 2);
  return rank(a) - rank(b)
    || (b.population ?? 0) - (a.population ?? 0)
    || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
}

/**
 * The overlay entry, completed by live detection. Detection, once it has
 * answered, decides the era; until then (a server that was offline, or a
 * bridge that just started) an overlay era is the fallback, so a known
 * classic world is never entered as end of retail. GDL/GDLE servers are
 * never probed, so their overlay era always stands. A detected classic era
 * makes the world beta with its data-set note; a server that refused every
 * known login version is incompatible. An overlay block with a reason (a
 * world whose VPN check refuses the bridge) stands whatever detection says:
 * the probe may read that refusal as a version mismatch, and the reason is
 * what players need to see.
 */
export function withDetection(c: CompatEntry, d: Detection | undefined): CompatEntry {
  if (!d) return c;
  if (c.compat === 'incompatible' && c.reason) {
    const detected = withDetection({ ...c, compat: 'ok', note: undefined, reason: undefined }, d);
    return { ...detected, compat: 'incompatible', note: c.note, reason: c.reason };
  }
  // Drop what the overlay said about the era (its era, beta label and data note).
  const { era: overlayEra, note, compat, ...rest } = c;
  const base: CompatEntry = overlayEra === undefined ? c : { ...rest, compat: 'ok' };
  if (d.kind === 'unsupported') return { ...base, compat: 'incompatible', note: 'Unsupported client version' };
  if (d.era === null) return base;
  const out: CompatEntry = { ...base, compat: base.compat === 'ok' ? 'beta' : base.compat, era: d.era };
  const n = d.note ?? (overlayEra === undefined ? note : undefined);
  if (n !== undefined) out.note = n;
  return out;
}

export function buildDirectory(
  servers: readonly ServerEntry[],
  status: ReadonlyMap<string, ServerStatus>,
  counts: ReadonlyMap<string, PlayerCount>,
  opts: { now: number; compat?: CompatOverlay; detected?: (id: string) => Detection | undefined; egressWorlds?: ReadonlySet<string> },
): DirectoryEntry[] {
  const entries = servers.map((s): DirectoryEntry => {
    const st = status.get(s.id.toLowerCase());
    const pc = counts.get(s.name.toLowerCase());
    const fresh = pc !== undefined && (pc.at === null || opts.now - pc.at <= POPULATION_MAX_AGE_MS);
    const online = st ? st.online : null;
    const overlay = compatFor(s.id, s.emu, opts.compat ?? SERVER_COMPAT);
    // A never-probed era (AC1999) is the overlay's alone.
    const unprobed = overlay.era !== undefined && NO_PROBE_ERAS.has(overlay.era);
    const detected = withDetection(overlay, unprobed ? undefined : opts.detected?.(s.id));
    // An egress world (BRIDGE_EGRESS_SERVERS, egress.ts): every session leaves from its own address and
    // the bridge applies the per-address caps per player, so the shared-cap warning and limits no longer hold.
    const egress = opts.egressWorlds?.has(s.id.toLowerCase()) ?? false;
    const c: CompatEntry = egress ? { ...detected, warning: undefined, perIpLimits: undefined } : detected;
    return {
      id: s.id,
      name: s.name,
      emu: s.emu,
      type: s.type ?? null,
      description: s.description ?? null,
      website: s.website ?? null,
      discord: s.discord ?? null,
      online,
      lastSeen: st?.lastSeen ?? null,
      population: online !== false && fresh ? pc!.count : null,
      compat: c.compat,
      compatNote: c.note ?? null,
      compatReason: c.compat === 'incompatible' ? c.reason ?? null : null,
      registration: c.registration ?? null,
      registrationUrl: c.registrationUrl ?? null,
      era: c.era ?? null,
      compatWarning: c.compat === 'incompatible' ? null : c.warning ?? null,
      perIpLimits: c.perIpLimits ? { ...c.perIpLimits } : null,
    };
  });
  return entries.sort(compareEntries);
}

export interface ServerDirectoryOptions {
  /** The allowlist the bridge routes by (ServerRegistry.all). */
  servers: () => ServerEntry[];
  statusUrl?: string | null;
  countsUrl?: string | null;
  refreshMs?: number;
  fetchText?: FetchText;
  now?: () => number;
  log?: Logger;
  compat?: CompatOverlay;
  /** Live era detection, swept after each feed refresh. */
  detector?: EraDetector;
  /** BRIDGE_EGRESS_SERVERS world ids (lower-case): their rows drop the shared per-address warning and limits. */
  egressWorlds?: ReadonlySet<string>;
}

/** Cached TreeStats feeds + the merged body for GET /servers. */
export class ServerDirectory {
  private status = new Map<string, ServerStatus>();
  private counts = new Map<string, PlayerCount>();
  private updatedAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly opts: ServerDirectoryOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** First refresh in the background, then every refreshMs. Never throws. */
  start(): void {
    void this.refresh();
    const ms = this.opts.refreshMs ?? DEFAULT_DIRECTORY_REFRESH_MS;
    if (ms > 0) {
      this.timer = setInterval(() => { void this.refresh(); }, ms);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Fetch both feeds; each failure keeps that feed's last good copy. */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    const fetchText = this.opts.fetchText;
    const run = async () => {
      if (!fetchText) return;
      const statusUrl = this.opts.statusUrl === undefined ? TREESTATS_STATUS_URL : this.opts.statusUrl;
      const countsUrl = this.opts.countsUrl === undefined ? TREESTATS_COUNTS_URL : this.opts.countsUrl;
      let any = false;
      if (statusUrl) {
        try {
          const m = parseTreeStatsStatus(JSON.parse(await fetchText(statusUrl, 15_000)));
          if (m.size > 0) { this.status = m; any = true; }
        } catch (err) {
          this.log('warn', 'servers_status_fetch_failed', { url: statusUrl, error: (err as Error).message });
        }
      }
      if (countsUrl) {
        try {
          const m = parsePlayerCounts(JSON.parse(await fetchText(countsUrl, 15_000)));
          if (m.size > 0) { this.counts = m; any = true; }
        } catch (err) {
          this.log('warn', 'servers_counts_fetch_failed', { url: countsUrl, error: (err as Error).message });
        }
      }
      if (any) this.updatedAt = this.now();
      // In the background: a sweep probes servers one login at a time.
      const status = this.status;
      void this.opts.detector?.sweep(this.probeable(), (id) => status.get(id.toLowerCase())?.online ?? null);
    };
    this.inflight = run().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  /**
   * The servers the era detector may probe: every allowlisted one except
   * those whose overlay era is never probed (AC1999: another protocol, and
   * a probe login would create an account), whatever their emu says.
   */
  probeable(): ServerEntry[] {
    const overlay = this.opts.compat ?? SERVER_COMPAT;
    return this.opts.servers().filter((s) => {
      const era = compatFor(s.id, s.emu, overlay).era;
      return era === undefined || !NO_PROBE_ERAS.has(era);
    });
  }

  body(): DirectoryBody {
    return {
      mode: 'multi',
      updatedAt: this.updatedAt === null ? null : new Date(this.updatedAt).toISOString(),
      servers: buildDirectory(this.opts.servers(), this.status, this.counts, {
        now: this.now(), compat: this.opts.compat, detected: this.opts.detector && ((id) => this.opts.detector!.get(id)), egressWorlds: this.opts.egressWorlds,
      }),
    };
  }
}
