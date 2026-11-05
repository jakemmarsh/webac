/**
 * Reachability of the worlds no status feed watches (webac#22): the AC1999
 * worlds are not in Servers.xml, so TreeStats reports neither their status
 * nor a player count, and GET /servers listed them with `online: null`.
 *
 * The AC1999 server has no status endpoint and no player count anyone can
 * read without logging in (reference/ac1999 Network.cpp: LogPopulation only
 * writes Logs/population.log; the in-game player list needs a character).
 * What it does answer is the community server-tracker login: account
 * "acservertracker" gets STR_LOGIN_FAILED straight away, with no account
 * made and no client state kept (AuthenticateUserQuery::PerformQuery checks
 * it first). Any reply from the world's address means it is up. So these
 * worlds get a real `online`; their population stays unknown (null).
 *
 * Rate: one probe per world per directory refresh (~5 min), at most one
 * world at a time, and a probe stops at the first reply (each tracker login
 * is a query on the 1999 server's single DB thread; egress.ts
 * pathProbePollMs).
 *
 * The probe never reports a world offline: offline blocks entering it
 * (worldEnterBlock), and a missed probe is not proof the world is down (the
 * probe leaves from the bridge's main address, not the sessions' egress
 * addresses, and UDP drops). A reply is `online: true`; UNKNOWN_AFTER_MISSES
 * misses in a row put the world back to unknown (`online: null`).
 */
import type { Logger } from './log.js';
import type { ServerEntry } from './serverList.js';
import type { ServerStatus } from './serverDirectory.js';
import { AC1999_TRACKER_LOGIN, udpReplyProbe } from './egress.js';

/** Probe `address:port`; true on any reply from it. Never rejects. */
export type WorldProbe = (address: string, port: number) => Promise<boolean>;

/** A probe that never got a reply gives up after this long. */
export const WORLD_PROBE_DEADLINE_MS = 5_000;
/** Probes of one world are at least this far apart, however often refresh runs. */
export const WORLD_PROBE_MIN_INTERVAL_MS = 4 * 60 * 1000;
/** Misses in a row before a world that had replied goes back to unknown (never offline). */
export const UNKNOWN_AFTER_MISSES = 2;

/** The AC1999 server-tracker login probe (egress.ts AC1999_TRACKER_LOGIN), from the bridge's own address. */
export function trackerLoginProbe(deadlineMs = WORLD_PROBE_DEADLINE_MS): WorldProbe {
  return async (address, port) => {
    const r = await udpReplyProbe('ac1999-tracker', AC1999_TRACKER_LOGIN, { host: address, port }).run('0.0.0.0', deadlineMs);
    return r.ok;
  };
}

export interface WorldReachabilityOptions {
  probe: WorldProbe;
  /** Host → the address sessions use (targets.resolveTarget); null when it can't be reached. */
  resolve: (host: string) => Promise<string | null>;
  /** Servers never to probe (BRIDGE_SPP_SERVERS: they drop datagrams without the SPP header). */
  skip?: (s: ServerEntry) => boolean;
  now?: () => number;
  minIntervalMs?: number;
  log?: Logger;
}

interface Entry { online: true | null; lastSeen: string | null; misses: number; probedAt: number }

export class WorldReachability {
  private readonly results = new Map<string, Entry>();
  private inflight: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly opts: WorldReachabilityOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** The world's status (online only), or undefined while unknown: before a reply, after UNKNOWN_AFTER_MISSES misses, or skipped. */
  get(id: string): ServerStatus | undefined {
    const e = this.results.get(id.toLowerCase());
    if (!e || e.online === null) return undefined;
    return { online: e.online, lastSeen: e.lastSeen };
  }

  /** Probe each due world, one at a time. A sweep already running is joined, not doubled. Never rejects. */
  sweep(servers: readonly ServerEntry[]): Promise<void> {
    if (this.inflight) return this.inflight;
    const run = async () => {
      for (const s of servers) {
        if (this.opts.skip?.(s)) continue;
        const key = s.id.toLowerCase();
        const prev = this.results.get(key);
        if (prev && this.now() - prev.probedAt < (this.opts.minIntervalMs ?? WORLD_PROBE_MIN_INTERVAL_MS)) continue;
        let ok = false;
        try {
          const address = await this.opts.resolve(s.host);
          ok = address !== null && await this.opts.probe(address, s.port);
        } catch {
          ok = false;
        }
        const at = this.now();
        const misses = ok ? 0 : (prev?.misses ?? 0) + 1;
        const online = ok ? true : misses >= UNKNOWN_AFTER_MISSES ? null : prev?.online ?? null;
        const next: Entry = { online, lastSeen: ok ? new Date(at).toISOString() : prev?.lastSeen ?? null, misses, probedAt: at };
        this.results.set(key, next);
        if ((prev?.online ?? null) !== online) this.log(online === null ? 'warn' : 'info', 'world_reachability', { server: s.id, online, misses });
      }
    };
    this.inflight = run().finally(() => { this.inflight = null; });
    return this.inflight;
  }
}
