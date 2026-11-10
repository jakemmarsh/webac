/**
 * tools/probe-ledge-drop.ts's data and verdict (BUG.ledge-step-off-hangs-in-air, live checks in every era).
 *
 * The bug: a body that left a dungeon ledge over a pit was held at its take-off height (9 of 16 Mountain Keep
 * off-plan landings at z 0 over open air, soldier.log 2026-10-17). Fixed by DungeonCollision.riseLimit +
 * fallPhysics.advanceAirborneFrame (4ae823b01) and the landing coast (0cff3b710). The probe stands a character at a
 * ledge, runs at it, jumps off and samples the body every frame; the verdict here reads the samples.
 *
 * Every spot is checked offline over the era's own DAT cells with the shipped collision code
 * (tests/verify-ledge-drop-probe-spots.ts): the start cell and floor, that a run is held at the edge (EdgeSlide,
 * CTransition::edge_slide), and where a jump off it lands for a range of run speeds and jump skills.
 */

/** An era the probe logs in to, with its local bridge and the live gate's admin account (tools/live-gate.sh). */
export interface LedgeEra {
  key: string;
  /** The client's ?era= id (null: end of retail). */
  id: string | null;
  label: string;
  bridge: string;
  /** An admin account on that server (null: name one with --account). */
  account: string | null;
  /** The admin command that sends the character back to town after the run (the live gate's characters must not be left in a dungeon). */
  home: string;
  /**
   * What an admin types to make a dungeon spot safe for a low-level character, given its health now and its max:
   * kill what is near and fill the health. Never cloaking / ethereal modes: those change the body's collision.
   */
  safety: (health: { cur: number; max: number } | null) => string[];
}

/**
 * ACE and ClassicACE (AdminCommands.cs): `@smite all` kills every monster in radar range; `@heal` restores health,
 * stamina and mana of the selection or, with nothing selected, yourself (the probe clears the selection first).
 */
const ACE_SAFETY = (): string[] => ['@smite all', '@heal'];
/**
 * The AC1999 server (ClientCommands.cpp): `@instakill <radius>` deals 1,000,000 to every attackable creature in the
 * radius (ADMIN_ACCESS); `@attackable off` stops monsters targeting you (ATTACKABLE_BOOL; no collision change);
 * `@sethealth <n>` (ADMIN_ACCESS) sets health, so it is sent only when short of the max. It has no @smite / @heal.
 */
const AC1999_SAFETY = (h: { cur: number; max: number } | null): string[] => [
  '@instakill 60', '@attackable off', ...(h && h.max > 0 && h.cur < h.max ? [`@sethealth ${Math.round(h.max)}`] : []),
];

export const LEDGE_ERAS: Record<string, LedgeEra> = {
  eor: { key: 'eor', id: null, label: 'End of retail (local ACE)', bridge: 'ws://localhost:9090', account: 'lgateeor', safety: ACE_SAFETY, home: '@telepoi Holtburg' },
  'classicace-customdm': { key: 'classicace-customdm', id: 'classicace-customdm', label: 'Dark Majesty (ClassicACE CustomDM, :9200)', bridge: 'ws://localhost:9098', account: 'lgatedm', safety: ACE_SAFETY, home: '@telepoi Holtburg' },
  'classic-dereth': { key: 'classic-dereth', id: 'classic-dereth', label: 'Dark Majesty (GDL-Classic, :9210)', bridge: 'ws://localhost:9099', account: null, safety: ACE_SAFETY, home: '@telepoi Holtburg' },
  'ac1999-retail': { key: 'ac1999-retail', id: 'ac1999-retail', label: 'Retail November 1999 (AC1999 server, :9310)', bridge: 'ws://localhost:9312', account: 'lgate99', safety: AC1999_SAFETY, home: '@teletown Holtburg' },
};

export function ledgeEra(key: string | undefined): LedgeEra {
  const k = !key || key === 'end-of-retail' ? 'eor' : key === 'dm' ? 'classicace-customdm' : key === 'gdl' ? 'classic-dereth' : key === '1999' || key === 'ac1999' ? 'ac1999-retail' : key;
  const e = LEDGE_ERAS[k];
  if (!e) throw new Error(`unknown era "${key}" (have: ${Object.keys(LEDGE_ERAS).join(', ')})`);
  return e;
}

export interface LedgeSpot {
  id: string;
  /** LEDGE_ERAS keys whose DATs hold this geometry (checked offline). */
  eras: string[];
  title: string;
  /** The cell the body starts in (teleloc target). */
  cell: number;
  /** Landblock-local start (AC metres: x east, y north, z up), on the floor. */
  start: { x: number; y: number; z: number };
  /** Compass heading to face and run (0 north, 90 east). */
  heading: number;
  /** The ledge: the body is over the drop once `axis` is past `at` in `dir`. */
  edge: { axis: 'x' | 'y'; at: number; dir: 1 | -1 };
  /** How the probe leaves: run at the edge then a short jump, or a full-charge jump (the wall-jump case). */
  jump: 'run-jump' | 'full-jump';
  /** Floor heights a correct landing may end on (the take-off floor itself for a wall-jump spot). */
  landZ: number[];
  /** Cells a correct landing ends in (offline). */
  landCells: number[];
  /** Box the body must never leave (landblock-local x / y): crossing it is passing through a wall. */
  bounds?: { minX?: number; maxX?: number; minY?: number; maxY?: number };
  /** Take-off to a settled landing, at most (ms). */
  maxFallMs: number;
  notes: string;
}

const MK = 0x01d20000, TUT1999 = 0x017e0000;
const c = (lb: number, cell: number): number => (lb | cell) >>> 0;

export const LEDGE_SPOTS: LedgeSpot[] = [
  {
    id: 'mk-pit', eras: ['eor', 'classicace-customdm', 'classic-dereth'],
    title: 'Mountain Keep: off the 0x02A6 ledge south into the pit (air cell 0x01D202A7), 6 or 12 m down',
    cell: c(MK, 0x2a6), start: { x: 90, y: -63.5, z: 0 }, heading: 180,
    edge: { axis: 'y', at: -65.0, dir: -1 },
    jump: 'run-jump', landZ: [-12, -6], landCells: [c(MK, 0x128), c(MK, 0x1ff)], maxFallMs: 3500,
    notes: 'A run south is held at about y -65.24, its centre r / 2 past the edge (EdgeSlide); a jump off lands on the -12 floor (0x01D20128, about y -74.5), '
      + 'or, slow and low, on the -6 bridge deck at about y -70 (in the air cell 0x01D201FF). '
      + 'Same cells in the end-of-retail, ClassicACE CustomDM 1.60 and Classic Dereth 1.1 DATs.',
  },
  {
    id: 'mk-wall', eras: ['eor', 'classicace-customdm', 'classic-dereth'],
    title: 'Mountain Keep: a full jump west at the 3 m corridor\'s wall (0x01D202A2), the original report',
    cell: c(MK, 0x2a2), start: { x: 86.6, y: -46.1, z: 0 }, heading: 269,
    edge: { axis: 'x', at: 85.4, dir: -1 },
    jump: 'full-jump', landZ: [0], landCells: [c(MK, 0x2a2)], bounds: { minX: 85.4 }, maxFallMs: 2500,
    notes: 'soldier.log 2026-10-17 02:25Z. The head meets the 3 m ceiling with the feet at about 1.15, the wall holds and '
      + 'the body lands back on the corridor floor. Before the fix a Jump 400+ character went up through the ceiling, '
      + 'over the wall and hung at z 0 in no cell, 10 m west. A low Jump never reaches the ceiling, so it only shows '
      + 'the wall holding; the probe prints the Jump skill.',
  },
  {
    id: '1999-walkway', eras: ['ac1999-retail'],
    title: 'AC1999 tutorial dungeon: off the z 0 walkway 0x017E015A west, 6 m down to 0x017E0120',
    cell: c(TUT1999, 0x15a), start: { x: 21, y: -52, z: 0 }, heading: 270,
    edge: { axis: 'x', at: 18.0, dir: -1 },
    jump: 'run-jump', landZ: [-6], landCells: [c(TUT1999, 0x120)], maxFallMs: 3000,
    notes: 'The walkway (x 18-21.5) runs between -6 floors; a run west is held at x 18.03 and a jump off lands on '
      + '0x017E0120 at about x 15.5 (its west wall stops the coast). The balcony fence (0x017E012E, needs Jump 65) '
      + 'is not on this path.',
  },
  {
    id: '1999-upper', eras: ['ac1999-retail'],
    title: 'AC1999 tutorial dungeon: off the z 6 room 0x017E0181 north, 6 m down to the walkway 0x017E015A',
    cell: c(TUT1999, 0x181), start: { x: 18, y: -58.5, z: 6 }, heading: 0,
    edge: { axis: 'y', at: -55.0, dir: 1 },
    jump: 'run-jump', landZ: [0], landCells: [c(TUT1999, 0x15a)], maxFallMs: 3000,
    notes: 'A run north is held at y -55.03; a jump off lands on the walkway 0x017E015A at about y -50 to -45.5.',
  },
];

export function spotsFor(era: string, ids?: string[] | null): LedgeSpot[] {
  const all = LEDGE_SPOTS.filter((s) => s.eras.includes(era));
  if (!ids?.length) return all;
  const out = ids.map((id) => {
    const s = LEDGE_SPOTS.find((x) => x.id === id);
    if (!s) throw new Error(`unknown spot "${id}" (have: ${LEDGE_SPOTS.map((x) => x.id).join(', ')})`);
    if (!s.eras.includes(era)) throw new Error(`spot "${id}" is not checked for era ${era} (its eras: ${s.eras.join(', ')})`);
    return s;
  });
  return out;
}

/** An AC frame's rotation for a compass heading (yaw about +Z, counter-clockwise from north: tools/lib/ac-wire.ts headingOf). */
export function headingQuat(compassDeg: number): { w: number; x: number; y: number; z: number } {
  const yaw = (-compassDeg * Math.PI) / 180;
  const r = (v: number) => (Math.abs(v) < 1e-12 ? 0 : v);
  const w = Math.cos(yaw / 2), z = Math.sin(yaw / 2);
  // q and -q are the same rotation: keep w >= 0 so the command reads as the heading's own angle.
  return w < 0 ? { w: r(-w), x: 0, y: 0, z: r(-z) } : { w: r(w), x: 0, y: 0, z: r(z) };
}

/**
 * The admin teleport, one form for every era: ACE / ClassicACE `@teleloc cell [x y z] qw qx qy qz`
 * (AdminCommands.HandleTeleportLOC trims the brackets) and the AC1999 server's `@teleloc <landcell> [x y z] w x y z`
 * (ClientCommands.cpp: skipBracketPrefix / skipBracketSuffix, angles read when 8 arguments are given).
 */
export function telelocCommand(spot: Pick<LedgeSpot, 'cell' | 'start' | 'heading'>): string {
  const q = headingQuat(spot.heading);
  const f = (v: number, d: number) => v.toFixed(d);
  return `@teleloc 0x${(spot.cell >>> 0).toString(16).toUpperCase().padStart(8, '0')} [${f(spot.start.x, 3)} ${f(spot.start.y, 3)} ${f(spot.start.z, 3)}] `
    + `${f(q.w, 6)} ${f(q.x, 6)} ${f(q.y, 6)} ${f(q.z, 6)}`;
}

/** Signed smallest turn (degrees) from compass heading `from` to `to`: positive = clockwise (turn right). */
export function turnDelta(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

/**
 * One frame of the body: landblock-local x / y, feet height z, the cell it is in by the client's collision (0 = none).
 * Live runs add `hp` (current health: 0 = dead) and `atSpot` (in a dungeon, the server told this landblock): a body
 * killed and sent to its lifestone is somewhere else entirely, and its frames say nothing about the ledge.
 */
export interface LedgeSample { t: number; x: number; y: number; z: number; cell: number; onGround: boolean; hp?: number; atSpot?: boolean }

/** A frame-to-frame move this long is a teleport (a lifestone recall), not physics: no fall covers it in one frame. */
export const TELEPORT_JUMP_M = 20;

/** A chat line that says the character died (ACE / ClassicACE vitae and pyreal-loss lines; the AC1999 server's death lines). */
export const DEATH_LINE = /you(?:'ve| have) lost \d[\d,]* pyreals|vitae|you have died|you've died|you died|killed you|has killed you|you are dead/i;

export interface LedgeVerdictOptions {
  /** A death line seen in the chat during the run (DEATH_LINE). */
  deathLine?: string | null;
}

export type LedgeOutcome = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

export interface LedgeVerdict {
  outcome: LedgeOutcome;
  /** pass | hung | no-cell | wrong-floor | wrong-cell | through-wall | slow-fall | still-airborne | snapped-back | never-left | never-crossed | no-samples | not-at-spot | died */
  reason: string;
  detail: string;
  takeoffT: number | null;
  landT: number | null;
  fallMs: number | null;
  peakZ: number | null;
  final: LedgeSample | null;
}

const Z_TOL = 0.35;
/** A landing counts once the body stays on the ground, its height steady, this long. */
export const SETTLE_MS = 300;

/**
 * How far past the edge line a body still stands on the ledge: an EdgeSlide body's centre stands up to r / 2 past it
 * (CTransition::check_walkable @ 0050aff0 at SPHEREPATH::check_walkables @ 0050c3e0's half radius; a player's feet
 * sphere is 0.48), as retail's did on the Mountain Keep walkway (0.238-0.240 m, BUG.edge-slide-check-walkable-overhang).
 */
export const LEDGE_OVERHANG_M = 0.24;
/** Over the drop: past the edge line by more than a body standing on the ledge overhangs it. */
const beyond = (spot: Pick<LedgeSpot, 'edge'>, s: Pick<LedgeSample, 'x' | 'y'>): boolean =>
  (s[spot.edge.axis] - spot.edge.at) * spot.edge.dir > LEDGE_OVERHANG_M + 0.01;
const fmt = (s: LedgeSample): string => `(${s.x.toFixed(2)}, ${s.y.toFixed(2)}, z ${s.z.toFixed(2)}) cell 0x${(s.cell >>> 0).toString(16).toUpperCase().padStart(8, '0')}${s.onGround ? '' : ' airborne'}`;

/**
 * The verdict from a run's samples (in time order). Take-off: the first frame off the ground (or below the take-off
 * floor). Landing: the first frame from which the body stays on the ground with a steady height for SETTLE_MS.
 */
export function ledgeVerdict(spot: LedgeSpot, samples: LedgeSample[], opts: LedgeVerdictOptions = {}): LedgeVerdict {
  const base = { takeoffT: null, landT: null, fallMs: null, peakZ: null, final: samples[samples.length - 1] ?? null };
  if (samples.length < 2) return { ...base, outcome: 'INCONCLUSIVE', reason: 'no-samples', detail: 'no frames sampled' };
  const z0 = spot.start.z;
  // Where the run began: on the spot, in its dungeon, alive. Anything else and the frames are not about this ledge.
  const first = samples[0];
  const off = Math.hypot(first.x - spot.start.x, first.y - spot.start.y);
  if (first.atSpot === false || off > 3 || Math.abs(first.z - z0) > 1.5 || first.hp === 0) {
    return { ...base, outcome: 'INCONCLUSIVE', reason: 'not-at-spot', detail: `the run began ${first.atSpot === false ? 'outside the spot\'s dungeon landblock' : `${off.toFixed(1)} m from the spot`}${first.hp === 0 ? ', dead' : ''}: ${fmt(first)}` };
  }
  // Killed (or recalled) during the run: health 0, a death line, a jump no fall covers, or out of the landblock.
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i], p = samples[i - 1];
    const why = s.hp === 0 ? 'health 0'
      : p && Math.hypot(s.x - p.x, s.y - p.y, s.z - p.z) > TELEPORT_JUMP_M ? `moved ${Math.hypot(s.x - p.x, s.y - p.y, s.z - p.z).toFixed(0)} m in one frame`
        : s.atSpot === false ? 'left the spot\'s dungeon landblock' : null;
    if (why) return { ...base, outcome: 'INCONCLUSIVE', reason: 'died', detail: `killed or recalled at t+${Math.round(s.t - first.t)} ms (${why})${opts.deathLine ? `; chat: "${opts.deathLine}"` : ''}: ${fmt(s)}` };
  }
  if (opts.deathLine) return { ...base, outcome: 'INCONCLUSIVE', reason: 'died', detail: `the chat says the character died: "${opts.deathLine}"` };
  const isDrop = Math.min(...spot.landZ) < z0 - 1;
  const ti = samples.findIndex((s) => !s.onGround || s.z < z0 - 0.3);
  if (ti < 0) {
    const last = samples[samples.length - 1];
    return { ...base, outcome: 'INCONCLUSIVE', reason: 'never-left', detail: `the body never left the ground (last ${fmt(last)})${beyond(spot, last) ? '' : ': held at the edge (EdgeSlide), as retail; the jump input did not land'}` };
  }
  const takeoff = samples[ti];
  const after = samples.slice(ti);
  const peakZ = Math.max(...after.map((s) => s.z));
  const b = spot.bounds;
  if (b) {
    const out = after.find((s) => (b.minX !== undefined && s.x < b.minX) || (b.maxX !== undefined && s.x > b.maxX) || (b.minY !== undefined && s.y < b.minY) || (b.maxY !== undefined && s.y > b.maxY));
    if (out) return { ...base, takeoffT: takeoff.t, peakZ, outcome: 'FAIL', reason: 'through-wall', detail: `left the room's bounds at t+${Math.round(out.t - takeoff.t)} ms: ${fmt(out)}` };
  }
  // The first settled landing.
  let li = -1;
  for (let i = 1; i < after.length; i++) {
    const s = after[i];
    if (!s.onGround) continue;
    let j = i;
    while (j + 1 < after.length && after[j + 1].onGround && Math.abs(after[j + 1].z - s.z) < 0.05) j++;
    if (after[j].t - s.t >= SETTLE_MS) { li = i; break; }
    i = j;
  }
  const last = after[after.length - 1];
  if (li < 0) {
    if (Math.abs(last.z - z0) < Z_TOL && beyond(spot, last)) {
      return { ...base, takeoffT: takeoff.t, peakZ, outcome: 'FAIL', reason: 'hung', detail: `still at the take-off height over the drop ${Math.round(last.t - takeoff.t)} ms after take-off: ${fmt(last)}` };
    }
    return { ...base, takeoffT: takeoff.t, peakZ, outcome: 'FAIL', reason: 'still-airborne', detail: `no settled landing ${Math.round(last.t - takeoff.t)} ms after take-off: ${fmt(last)}` };
  }
  const land = after[li];
  const fallMs = land.t - takeoff.t;
  const res = { ...base, takeoffT: takeoff.t, landT: land.t, fallMs, peakZ, final: last };
  // Where the body stood at the end (a server correction after landing shows here).
  const endZ = last.z;
  if (Math.abs(endZ - land.z) > 1) {
    return { ...res, outcome: 'FAIL', reason: 'snapped-back', detail: `landed at ${fmt(land)}, then moved to ${fmt(last)}` };
  }
  if (isDrop && Math.abs(land.z - z0) < Z_TOL) {
    if (beyond(spot, land)) return { ...res, outcome: 'FAIL', reason: 'hung', detail: `"landed" at the take-off height over the drop: ${fmt(land)}` };
    return { ...res, outcome: 'INCONCLUSIVE', reason: 'never-crossed', detail: `came down on the ledge itself, short of the edge: ${fmt(land)} (run again, or a longer run-up)` };
  }
  if (land.cell === 0 || last.cell === 0) {
    return { ...res, outcome: 'FAIL', reason: 'no-cell', detail: `landed in no cell: ${fmt(last.cell === 0 ? last : land)}` };
  }
  if (!spot.landZ.some((z) => Math.abs(land.z - z) < Z_TOL)) {
    return { ...res, outcome: 'FAIL', reason: 'wrong-floor', detail: `landed at z ${land.z.toFixed(2)}, expected ${spot.landZ.join(' or ')}: ${fmt(land)}` };
  }
  if (spot.landCells.length && !spot.landCells.includes(last.cell >>> 0)) {
    return { ...res, outcome: 'FAIL', reason: 'wrong-cell', detail: `landed on the right floor but in another cell than ${spot.landCells.map((x) => '0x' + x.toString(16).toUpperCase()).join(' / ')}: ${fmt(last)}` };
  }
  if (fallMs > spot.maxFallMs) {
    return { ...res, outcome: 'FAIL', reason: 'slow-fall', detail: `took ${Math.round(fallMs)} ms to land (at most ${spot.maxFallMs}): ${fmt(land)}` };
  }
  return { ...res, outcome: 'PASS', reason: 'pass', detail: `took off at ${fmt(takeoff)}, peak z ${peakZ.toFixed(2)}, landed in ${Math.round(fallMs)} ms at ${fmt(land)}` };
}

/** Every `step`-th sample plus the take-off / landing neighbourhoods, as table rows for a FAIL report. */
export function sampleTable(samples: LedgeSample[], v: Pick<LedgeVerdict, 'takeoffT' | 'landT'>, step = 6): string[] {
  const t0 = v.takeoffT ?? samples[0]?.t ?? 0;
  const near = (t: number, at: number | null) => at !== null && Math.abs(t - at) < 120;
  return samples
    .filter((s, i) => i % step === 0 || i === samples.length - 1 || near(s.t, v.takeoffT) || near(s.t, v.landT))
    .map((s) => `${String(Math.round(s.t - t0)).padStart(6)} ms  x ${s.x.toFixed(2).padStart(7)}  y ${s.y.toFixed(2).padStart(7)}  z ${s.z.toFixed(2).padStart(6)}  `
      + `cell 0x${(s.cell >>> 0).toString(16).toUpperCase().padStart(8, '0')}  ${s.onGround ? 'ground' : 'air'}`);
}
