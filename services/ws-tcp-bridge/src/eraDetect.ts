/**
 * Which era profile each listed ACE-family server needs, found live with the
 * login-version probe (loginProbe.ts) instead of a per-server table.
 *
 * ClassicACE bumps its version literal with every DAT release (DatManager.cs:
 * EoR "1802", Infiltration "i104", CustomDM "c118"), so the literal a server
 * accepts names its DAT set. The bridge tries the literals of the era
 * profiles the client knows, in order, and stops at the first accepted one;
 * a stock ACE server answers "1802" on the first try. A server that refuses
 * every known literal needs a client we can't be yet (an older or newer
 * ClassicACE data release) and is listed as incompatible rather than letting
 * players walk into the boot.
 *
 * Servers.xml carries no era field, and GDL/GDLE servers have no version
 * check, so those (Seedsow, Snowreap) stay in the serverCompat overlay.
 * 1999 worlds (an AC1999 era in the overlay) are never probed.
 */
import type { Logger } from './log.js';
import type { ProbeLogin } from './loginProbe.js';
import type { ServerEntry } from './serverList.js';
import { CLASSIC_ERA_NOTE, type CompatOverlay, NO_PROBE_ERAS, compatFor } from './serverCompat.js';

export interface EraLiteral {
  version: string;
  /** Era profile id (packages/renderer/src/era/EraProfiles.ts); null = end of retail. */
  era: string | null;
  /** Launcher chip for a classic era. */
  note?: string;
}

/**
 * Every account-password era profile's login literal, end of retail first.
 * tests/verify-bridge-login-probe.ts holds this equal to ERA_PROFILES.
 */
export const ERA_LOGIN_LITERALS: readonly EraLiteral[] = Object.freeze([
  { version: '1802', era: null },
  { version: 'i104', era: 'classicace-infiltration', note: CLASSIC_ERA_NOTE },
  { version: 'c118', era: 'classicace-customdm', note: CLASSIC_ERA_NOTE },
]);

export type Detection =
  | { kind: 'era'; era: string | null; version: string; note: string | null; at: number }
  /** Booted for every known literal. */
  | { kind: 'unsupported'; classicAce: boolean; at: number };

export const DETECTION_TTL_MS = 6 * 60 * 60 * 1000;
/** Gap between two probe logins, so a sweep never bursts at anyone. */
export const PROBE_GAP_MS = 1500;

export interface EraDetectorOptions {
  probe: ProbeLogin;
  /** Host → the address sessions use (targets.resolveTarget); null when it can't be reached. */
  resolve: (host: string) => Promise<string | null>;
  /** True when probing now could take a player's slot (a per-IP-limited server the bridge has sessions to). */
  busy?: (server: ServerEntry) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: Logger;
  literals?: readonly EraLiteral[];
  /** The era overlay (default SERVER_COMPAT); servers it names a never-probed era for (AC1999) are skipped. */
  compat?: CompatOverlay;
}

export class EraDetector {
  private results = new Map<string, Detection>();
  private inflight: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: Logger;
  private readonly literals: readonly EraLiteral[];

  constructor(private readonly opts: EraDetectorOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = opts.log ?? (() => {});
    this.literals = opts.literals ?? ERA_LOGIN_LITERALS;
  }

  get(id: string): Detection | undefined {
    return this.results.get(id.toLowerCase());
  }

  /**
   * Probe every ACE-family server whose result is missing or older than the
   * TTL, one login at a time. `online(id)` false skips a server TreeStats
   * reports down. Single-flight; never throws.
   */
  sweep(servers: readonly ServerEntry[], online: (id: string) => boolean | null): Promise<void> {
    if (this.inflight) return this.inflight;
    const run = async () => {
      for (const s of servers) {
        if (s.emu.toUpperCase() !== 'ACE') continue;
        // Never probe a 1999 world: it speaks another protocol, and its server
        // auto-creates accounts, so a probe login would make one.
        const overlayEra = compatFor(s.id, s.emu, this.opts.compat).era;
        if (overlayEra !== undefined && NO_PROBE_ERAS.has(overlayEra)) continue;
        if (online(s.id) === false) continue;
        const prev = this.get(s.id);
        if (prev && this.now() - prev.at < DETECTION_TTL_MS) continue;
        if (this.opts.busy?.(s)) continue;
        try {
          await this.detect(s);
        } catch (err) {
          this.log('warn', 'era_probe_failed', { server: s.id, error: (err as Error).message });
        }
      }
    };
    this.inflight = run().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async detect(s: ServerEntry): Promise<void> {
    const address = await this.opts.resolve(s.host);
    if (!address) return;
    let classicAce = false;
    for (const lit of this.literals) {
      const v = await this.opts.probe(address, s.port, lit.version);
      await this.sleep(PROBE_GAP_MS);
      if (v.kind === 'accepted') {
        const prev = this.get(s.id);
        this.results.set(s.id.toLowerCase(), { kind: 'era', era: lit.era, version: lit.version, note: lit.note ?? null, at: this.now() });
        if (prev?.kind !== 'era' || prev.version !== lit.version) {
          this.log('info', 'era_detected', { server: s.id, name: s.name, version: lit.version, era: lit.era ?? 'eor' });
        }
        return;
      }
      if (v.kind !== 'version-rejected') return; // down, full, or an unexpected answer: keep what we had
      classicAce ||= v.classicAce;
    }
    this.results.set(s.id.toLowerCase(), { kind: 'unsupported', classicAce, at: this.now() });
    this.log('warn', 'era_unsupported', { server: s.id, name: s.name, tried: this.literals.map((l) => l.version) });
  }
}
