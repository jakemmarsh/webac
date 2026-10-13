/**
 * Mag-Tools' corpse and player trackers (docs/plugin-specs/magtools.md §5.3, §5.4), rebuilt clean-room
 * from the spec's facts over events the host feeds.
 *
 * Ours, where it differs (spec §12 #8): Track Fellow Corpses and Track Permitted Corpses work (upstream's
 * are placeholders): a fellow's corpse, and the corpse of someone who granted you permission to loot it.
 * The player list re-sorts on every read (upstream throttles that to every 10 s for lag).
 */
import { mtCoordsText, mtDateTime, mtDayTime, type MtTextStore } from './format.js';
import type { MtOptions } from './options.js';

/** My corpses are kept 7 days, anyone else's 2 hours (spec §5.3). */
export const MT_CORPSE_KEEP_MINE_MS = 7 * 24 * 3600_000;
export const MT_CORPSE_KEEP_OTHER_MS = 2 * 3600_000;
/** A corpse heavier than this may be a kill of mine: appraise it and read "Killed by <me>." (spec §5.3). */
export const MT_CORPSE_KILL_BURDEN = 6000;
/** A release within this many metres is the corpse decaying (spec §5.3). */
export const MT_CORPSE_DECAY_RANGE = 10;
/** Column widths: Time / Name / Coords / Id (hidden). */
export const MT_CORPSE_COLUMNS = [53, 162, 100, 0] as const;
export const MT_PLAYER_COLUMNS = [75, 140, 100, 0] as const;
export const MT_TRACKER_HEADER = ['Time', 'Name', 'Coords', 'Id'] as const;

/** A position: the cell id (landblock in the top 16 bits) and the cell-local metres. */
export interface MtWhere {
  cell: number;
  x: number;
  y: number;
  z: number;
}

/** A corpse as the host sees it: on create, and again once its appraisal arrives. */
export interface MtCorpseSeen extends MtWhere {
  id: number;
  name: string;
  /** PropertyInt EncumbranceVal (5). */
  burden?: number;
  /** Whether its appraisal has arrived (longDesc then holds PropertyString LongDesc, "Killed by <name>."). */
  appraised: boolean;
  longDesc?: string | null;
}

export interface MtCorpseEntry extends MtWhere {
  id: number;
  name: string;
  /** When it was tracked (ms since the epoch). */
  time: number;
  /** One of my own corpses (kept 7 days). */
  mine: boolean;
}

export interface MtTrackerRow {
  id: number;
  cells: [string, string, string, string];
}

export interface MtCorpseTrackerOpts {
  me: () => string;
  options: MtOptions;
  now?: () => number;
  /** Where the persistent list lives (per server + character); kept when Keep Persistent Stats is on. */
  store?: () => MtTextStore | null;
  /** Your fellowship's member names (Track Fellow Corpses). */
  fellows?: () => readonly string[];
  /** Names of players who granted you permission to loot their corpse (Track Permitted Corpses). */
  permittedBy?: () => readonly string[];
}

const sameSpot = (a: MtWhere, b: MtWhere) =>
  (a.cell >>> 16) === (b.cell >>> 16) && Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= 1;
/** "Corpse of <owner>" → the owner. */
const ownerOf = (name: string) => name.replace(/^Corpse of /, '');

export class MtCorpseTracker {
  /** Newest first. */
  private entries: MtCorpseEntry[] = [];
  private readonly now: () => number;

  constructor(private readonly opts: MtCorpseTrackerOpts) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Whether Track Fellow Corpses can work (the host gave the fellowship read); else its checkbox isn't drawn. */
  get tracksFellows(): boolean { return !!this.opts.fellows; }
  /** Whether Track Permitted Corpses can work (the host gave the permission read). */
  get tracksPermitted(): boolean { return !!this.opts.permittedBy; }

  /**
   * A corpse was created or appraised. Returns 'appraise' when the host should ask for its appraisal
   * (a heavy corpse that may be my kill) and call again with the long description.
   */
  seen(c: MtCorpseSeen): 'appraise' | null {
    const o = this.opts.options;
    if (!o.bool('CorpseTracker.Enabled')) return null;
    const old = this.entries.find((e) => e.id === c.id);
    if (old) {
      if (sameSpot(old, c)) return null;
      // A reused id somewhere else: the old entry goes.
      this.entries = this.entries.filter((e) => e !== old);
      this.changed();
    }
    const me = this.opts.me();
    const mine = me !== '' && c.name.includes(me);
    let track = mine || o.bool('CorpseTracker.TrackAllCorpses');
    if (!track && o.bool('CorpseTracker.TrackFellowCorpses') && this.opts.fellows) {
      const owner = ownerOf(c.name);
      track = this.opts.fellows().some((f) => f !== me && f === owner);
    }
    if (!track && o.bool('CorpseTracker.TrackPermittedCorpses') && this.opts.permittedBy) {
      const owner = ownerOf(c.name);
      track = this.opts.permittedBy().includes(owner);
    }
    if (!track && (c.burden ?? 0) > MT_CORPSE_KILL_BURDEN) {
      if (!c.appraised) return 'appraise';
      track = me !== '' && (c.longDesc ?? '').includes(me);
    }
    if (!track) return null;
    this.entries.unshift({ id: c.id, name: c.name, cell: c.cell, x: c.x, y: c.y, z: c.z, time: this.now(), mine });
    this.changed();
    return null;
  }

  /** You opened a corpse: a tracked one is done with. */
  opened(id: number): void {
    const n = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length !== n) this.changed();
  }

  /** An object left your view, `distance` metres from you: within 10 m that's the corpse decaying. */
  released(id: number, distance: number): void {
    if (distance > MT_CORPSE_DECAY_RANGE) return;
    this.opened(id);
  }

  /** Drop the expired entries (mine after 7 days, the rest after 2 hours). */
  expire(now = this.now()): void {
    const n = this.entries.length;
    this.entries = this.entries.filter((e) => now - e.time < (e.mine ? MT_CORPSE_KEEP_MINE_MS : MT_CORPSE_KEEP_OTHER_MS));
    if (this.entries.length !== n) this.changed();
  }

  list(): readonly MtCorpseEntry[] {
    this.expire();
    return this.entries;
  }

  /** The list's rows: `ddd HH:mm`, name, coords, id. */
  rows(): MtTrackerRow[] {
    return this.list().map((e) => ({ id: e.id, cells: [mtDayTime(e.time), e.name, mtCoordsText(e.cell, e.x, e.y), String(e.id)] }));
  }

  /** Clear History: the list and its stored copy. */
  clear(): void {
    this.entries = [];
    try { this.opts.store?.()?.remove(); } catch { /* storage blocked */ }
  }

  /** Read the stored list back (at login, once the store points at this character). */
  load(): void {
    this.entries = [];
    try {
      const raw = this.opts.store?.()?.get();
      if (raw) this.entries = (JSON.parse(raw) as MtCorpseEntry[]).filter((e) => typeof e.id === 'number' && typeof e.time === 'number');
    } catch { /* unreadable: start empty */ }
    this.expire();
  }

  private changed(): void {
    if (!this.opts.options.bool('CorpseTracker.Persistent')) return;
    try { this.opts.store?.()?.set(JSON.stringify(this.entries)); } catch { /* storage blocked */ }
  }
}

/** Another player as the host sees it (a CreateObject or a move). */
export interface MtPlayerSeen extends MtWhere {
  id: number;
  name: string;
}

export interface MtPlayerEntry extends MtWhere {
  id: number;
  name: string;
  /** Last seen (ms since the epoch). */
  time: number;
}

export interface MtPlayerTrackerOpts {
  me: () => string;
  options: MtOptions;
  now?: () => number;
  /** Where the persistent list lives (per server + character); kept when Keep Persistent Stats is on. */
  store?: () => MtTextStore | null;
}

/** The player list's stored copy is rewritten at most this often. */
export const MT_PLAYER_SAVE_MS = 10_000;

export class MtPlayerTracker {
  private readonly byName = new Map<string, MtPlayerEntry>();
  private dirty = false;
  private savedAt = -Infinity;
  private readonly now: () => number;

  constructor(private readonly opts: MtPlayerTrackerOpts) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Another player was created or moved: upsert by name. */
  seen(p: MtPlayerSeen): void {
    if (!this.opts.options.bool('PlayerTracker.Enabled') || p.name === this.opts.me()) return;
    const now = this.now();
    this.byName.set(p.name, { id: p.id, name: p.name, cell: p.cell, x: p.x, y: p.y, z: p.z, time: now });
    // Players move constantly: the stored copy is written at most every 10 s (flush() at logoff writes the rest).
    this.dirty = true;
    if (now - this.savedAt >= MT_PLAYER_SAVE_MS) this.flush();
  }

  /** Write the stored copy now if anything changed (the host calls it at logoff). */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.savedAt = this.now();
    if (this.opts.options.bool('PlayerTracker.Persistent')) this.save();
  }

  /** Newest first, ties by ordinal name. */
  list(): MtPlayerEntry[] {
    return [...this.byName.values()].sort((a, b) => b.time - a.time || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** The list's rows: `yy/MM/dd HH:mm`, name, coords, the last-known id. */
  rows(): MtTrackerRow[] {
    return this.list().map((e) => ({ id: e.id, cells: [mtDateTime(e.time), e.name, mtCoordsText(e.cell, e.x, e.y), String(e.id)] }));
  }

  clear(): void {
    this.byName.clear();
    this.dirty = false;
    try { this.opts.store?.()?.remove(); } catch { /* storage blocked */ }
  }

  load(): void {
    this.byName.clear();
    try {
      const raw = this.opts.store?.()?.get();
      if (raw) for (const e of JSON.parse(raw) as MtPlayerEntry[]) if (typeof e.name === 'string' && typeof e.time === 'number') this.byName.set(e.name, e);
    } catch { /* unreadable: start empty */ }
  }

  private save(): void {
    try { this.opts.store?.()?.set(JSON.stringify([...this.byName.values()])); } catch { /* storage blocked */ }
  }
}
