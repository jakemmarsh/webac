/**
 * BUG.ledge-step-off-hangs-in-air — tools/probe-ledge-drop.ts's spots and verdict (tools/lib/ledge-drop.ts).
 *
 * The probe stands a character on a dungeon ledge in each era, runs at the edge, jumps off and reads every frame of
 * the body; ledgeVerdict says PASS when it falls to the floor below. Here:
 *  - the verdict over hand-made sample runs (every outcome), and the teleport / heading helpers;
 *  - each spot over its era's own DAT cells (end of retail, ClassicACE CustomDM 1.60, Classic Dereth 1.1, AC1999
 *    through its overlay), driven through the shipped frame pieces (tests/_harness/liveFrames.ts): the start cell and
 *    floor, the run held at the edge (EdgeSlide), and where a jump off lands for a range of run speeds and Jump
 *    skills; those offline frames, fed to ledgeVerdict, read PASS, and the Mountain Keep wall jump flown without the
 *    ceiling check (the client before 4ae823b01) reads FAIL.
 */
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { getJumpVelocity } from '@ac/shared';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.ts';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.ts';
import {
  DEATH_LINE, LEDGE_SPOTS, SETTLE_MS, TELEPORT_JUMP_M, headingQuat, ledgeEra, ledgeVerdict, sampleTable, spotsFor, telelocCommand, turnDelta,
  type LedgeSample, type LedgeSpot,
} from '../tools/lib/ledge-drop.ts';
import { headingOf } from '../tools/lib/ac-wire.ts';
import { DAT_PATHS, dataPath } from './_harness/dat.ts';
import { ac1999Dats, dungeonNav, type DungeonNav } from './_harness/dungeonNav.ts';
import { liveFramesOver, type LiveFrameOptions } from './_harness/liveFrames.ts';

const spot = (id: string): LedgeSpot => LEDGE_SPOTS.find((s) => s.id === id)!;

/** A run: `ground` frames standing at the start, then an arc `frames` long from z0 to `land`, then `after` on the ground. */
function arc(s: LedgeSpot, o: { land: number; cell: number; endX?: number; endY?: number; frames?: number; after?: number; hangAt?: number }): LedgeSample[] {
  const out: LedgeSample[] = [];
  const dt = 1000 / 60;
  let t = 0;
  for (let i = 0; i < 30; i++) out.push({ t: (t += dt), x: s.start.x, y: s.start.y, z: s.start.z, cell: s.cell, onGround: true });
  const n = o.frames ?? 60;
  const ex = o.endX ?? s.start.x, ey = o.endY ?? s.start.y;
  for (let i = 1; i <= n; i++) {
    const k = i / n;
    const z = o.hangAt !== undefined && k > 0.3 ? o.hangAt : s.start.z + (o.land - s.start.z) * k * k + 0.5 * Math.sin(Math.PI * k);
    out.push({ t: (t += dt), x: s.start.x + (ex - s.start.x) * k, y: s.start.y + (ey - s.start.y) * k, z, cell: o.cell, onGround: false });
  }
  for (let i = 0; i < (o.after ?? 40); i++) out.push({ t: (t += dt), x: ex, y: ey, z: o.hangAt ?? o.land, cell: o.cell, onGround: true });
  return out;
}

describe('ledgeVerdict over sample runs (tools/lib/ledge-drop.ts)', () => {
  const pit = spot('mk-pit');
  const PIT = { land: -12, cell: 0x01d20128, endY: -74.5 };

  it('a fall to the floor below in time, in the expected cell: PASS', () => {
    const v = ledgeVerdict(pit, arc(pit, PIT));
    expect(v.outcome).toBe('PASS');
    expect(v.fallMs).toBeGreaterThan(900);
    expect(v.fallMs).toBeLessThan(pit.maxFallMs);
  });

  it('a body held at its take-off height over the pit: FAIL hung (landed there, or never came down)', () => {
    const landed = ledgeVerdict(pit, arc(pit, { ...PIT, land: 0, cell: 0, hangAt: 0 }));
    expect(landed).toMatchObject({ outcome: 'FAIL', reason: 'hung' });
    const floating = arc(pit, { ...PIT, land: 0, cell: 0, hangAt: 0, after: 0 });
    expect(ledgeVerdict(pit, floating)).toMatchObject({ outcome: 'FAIL', reason: 'hung' });
  });

  it('a landing in no cell, on the wrong floor, in another cell, or too slowly: FAIL with that reason', () => {
    expect(ledgeVerdict(pit, arc(pit, { ...PIT, cell: 0 })).reason).toBe('no-cell');
    expect(ledgeVerdict(pit, arc(pit, { ...PIT, land: -9 })).reason).toBe('wrong-floor');
    expect(ledgeVerdict(pit, arc(pit, { ...PIT, cell: 0x01d20129 })).reason).toBe('wrong-cell');
    expect(ledgeVerdict(pit, arc(pit, { ...PIT, frames: 260 })).reason).toBe('slow-fall');
  });

  it('a body that keeps falling, or lands and is then put back up: FAIL still-airborne / snapped-back', () => {
    expect(ledgeVerdict(pit, arc(pit, { ...PIT, after: 0 })).reason).toBe('still-airborne');
    const back = arc(pit, PIT);
    for (let i = 0; i < 10; i++) back.push({ ...back[back.length - 1], t: back[back.length - 1].t + 16, x: 90, y: -64.9, z: 0, cell: 0x01d202a6 });
    expect(ledgeVerdict(pit, back).reason).toBe('snapped-back');
  });

  it('never off the ground, or back down on the ledge short of the edge: INCONCLUSIVE (the input, not the bug)', () => {
    const held = arc(pit, PIT).slice(0, 30);
    expect(ledgeVerdict(pit, held)).toMatchObject({ outcome: 'INCONCLUSIVE', reason: 'never-left' });
    expect(ledgeVerdict(pit, arc(pit, { land: 0, cell: pit.cell, endY: -64.5 }))).toMatchObject({ outcome: 'INCONCLUSIVE', reason: 'never-crossed' });
    expect(ledgeVerdict(pit, [])).toMatchObject({ outcome: 'INCONCLUSIVE', reason: 'no-samples' });
  });

  it('the wall jump: back on the corridor floor PASS; past the wall (the old hang 10 m west) FAIL through-wall', () => {
    const wall = spot('mk-wall');
    expect(ledgeVerdict(wall, arc(wall, { land: 0, cell: 0x01d202a2, endX: 86.0 })).outcome).toBe('PASS');
    expect(ledgeVerdict(wall, arc(wall, { land: 0, cell: 0, endX: 75.8 }))).toMatchObject({ outcome: 'FAIL', reason: 'through-wall' });
  });

  it('a character killed or recalled mid-run reads INCONCLUSIVE died, never never-left (ClassicACE, 2026-11-08)', () => {
    // Health 0 on a frame.
    const killed = arc(pit, PIT).map((f, i) => ({ ...f, hp: i > 20 ? 0 : 40, atSpot: true }));
    expect(ledgeVerdict(pit, killed)).toMatchObject({ outcome: 'INCONCLUSIVE', reason: 'died' });
    // The lifestone recall: still standing, then a jump hundreds of metres in one frame, out of the dungeon.
    const held = arc(pit, PIT).slice(0, 30).map((f) => ({ ...f, hp: 40, atSpot: true }));
    const last = held[held.length - 1];
    const recalled = [...held, ...Array.from({ length: 20 }, (_, i) => ({ t: last.t + 16 * (i + 1), x: 33000, y: -2400, z: 94, cell: 0, onGround: true, hp: 40, atSpot: false }))];
    const v = ledgeVerdict(pit, recalled);
    expect(v).toMatchObject({ outcome: 'INCONCLUSIVE', reason: 'died' });
    expect(v.detail).toMatch(/moved \d+ m in one frame/);
    // Out of the landblock with no jump (the server's cell changed): died too.
    expect(ledgeVerdict(pit, held.map((f, i) => (i > 25 ? { ...f, atSpot: false } : f))).reason).toBe('died');
    // Only the chat line: still died, quoting it.
    const line = "You've lost 555 Pyreals!";
    expect(DEATH_LINE.test(line)).toBe(true);
    expect(ledgeVerdict(pit, held, { deathLine: line })).toMatchObject({ outcome: 'INCONCLUSIVE', reason: 'died' });
    expect(TELEPORT_JUMP_M).toBeGreaterThan(5);
  });

  it('a run that does not begin on the spot (the lifestone, another landblock) reads INCONCLUSIVE not-at-spot', () => {
    const lifestone = arc(pit, PIT).slice(0, 30).map((f) => ({ ...f, x: 33000, y: -2400, z: 94, atSpot: false }));
    expect(ledgeVerdict(pit, lifestone)).toMatchObject({ outcome: 'INCONCLUSIVE', reason: 'not-at-spot' });
    const nearby = arc(pit, PIT).map((f) => ({ ...f, atSpot: false }));
    expect(ledgeVerdict(pit, nearby).reason).toBe('not-at-spot');
    // Healthy frames on the spot still judge as before.
    expect(ledgeVerdict(pit, arc(pit, PIT).map((f) => ({ ...f, hp: 40, atSpot: true }))).outcome).toBe('PASS');
  });

  it('death lines: the vitae / pyreal-loss / died lines, not a kill of your own', () => {
    for (const l of ["You've lost 555 Pyreals!", 'You have died!', 'Your vitae penalty is now 95%', 'A Drudge Ravener has killed you!']) expect(DEATH_LINE.test(l), l).toBe(true);
    for (const l of ['You killed the Drudge Skulker!', 'Mosswart Creeper was smited.', 'You have been healed.']) expect(DEATH_LINE.test(l), l).toBe(false);
  });

  it('the safety commands per era: ACE family smite + heal; AC1999 instakill + attackable off + sethealth when hurt', () => {
    expect(ledgeEra('dm').safety(null)).toEqual(['@smite all', '@heal']);
    expect(ledgeEra('eor').safety({ cur: 10, max: 50 })).toEqual(['@smite all', '@heal']);
    expect(ledgeEra('1999').safety({ cur: 10, max: 50 })).toEqual(['@instakill 60', '@attackable off', '@sethealth 50']);
    expect(ledgeEra('1999').safety({ cur: 50, max: 50 })).toEqual(['@instakill 60', '@attackable off']);
    // Nothing that changes the body's collision (cloak / ethereal / invisible).
    for (const e of ['eor', 'dm', '1999']) for (const c of ledgeEra(e).safety({ cur: 1, max: 2 })) expect(c).not.toMatch(/cloak|ethereal|invis|ghost/i);
  });

  it('a landing needs SETTLE_MS of steady ground; the table keeps the take-off and landing frames', () => {
    expect(SETTLE_MS).toBeGreaterThanOrEqual(200);
    const r = arc(pit, PIT);
    const v = ledgeVerdict(pit, r);
    const rows = sampleTable(r, v, 1000);
    expect(rows.some((l) => /^\s+0 ms/.test(l))).toBe(true);
    expect(rows.length).toBeGreaterThan(5);
    expect(rows[rows.length - 1]).toMatch(/z -12\.00 {2}cell 0x01D20128 {2}ground/);
  });
});

describe('the teleport and facing helpers', () => {
  it('headingQuat round-trips through ac-wire headingOf (compass: 0 north, 90 east)', () => {
    for (const h of [0, 90, 180, 269, 270]) {
      const q = headingQuat(h);
      expect(headingOf({ rw: q.w, rz: q.z } as Parameters<typeof headingOf>[0])).toBeCloseTo(h, 6);
    }
  });

  it('one @teleloc form for every era: cell, bracketed origin, then qw qx qy qz', () => {
    expect(telelocCommand(spot('mk-pit'))).toBe('@teleloc 0x01D202A6 [90.000 -63.500 0.000] 0.000000 0.000000 0.000000 -1.000000');
    expect(telelocCommand(spot('1999-walkway'))).toBe('@teleloc 0x017E015A [21.000 -52.000 0.000] 0.707107 0.000000 0.000000 0.707107');
    // 8 words after the command: the AC1999 server reads the angles only when argc >= 8 (ClientCommands.cpp teleloc).
    expect(telelocCommand(spot('1999-upper')).split(' ').length - 1).toBe(8);
  });

  it('turnDelta takes the short way round', () => {
    expect(turnDelta(350, 10)).toBe(20);
    expect(turnDelta(10, 350)).toBe(-20);
    expect(turnDelta(90, 270)).toBe(-180);
    expect(turnDelta(0, 0)).toBe(0);
  });

  it('spots by era: two Mountain Keep spots for each ACE-family era, two tutorial spots for AC1999', () => {
    expect(spotsFor('eor').map((s) => s.id)).toEqual(['mk-pit', 'mk-wall']);
    expect(spotsFor('classicace-customdm').map((s) => s.id)).toEqual(['mk-pit', 'mk-wall']);
    expect(spotsFor('ac1999-retail').map((s) => s.id)).toEqual(['1999-walkway', '1999-upper']);
    expect(() => spotsFor('ac1999-retail', ['mk-pit'])).toThrow(/not checked for era/);
    expect(ledgeEra('dm').bridge).toBe('ws://localhost:9098');
    expect(ledgeEra('1999')).toMatchObject({ bridge: 'ws://localhost:9312', account: 'lgate99' });
  });
});

// ── The spots over each era's real cells ─────────────────────────────────────────────────────────────────────────

type Dats = { portal: DatDatabase; cell: DatDatabase };
const eraSet = (dir: string, portal: string, cell: string) => {
  const p = dataPath(`dat-sets/${dir}/${portal}`), c = dataPath(`dat-sets/${dir}/${cell}`);
  return { present: existsSync(p) && existsSync(c), open: (): Dats => ({ portal: new DatDatabase(new FileDatBytes(p)), cell: new DatDatabase(new FileDatBytes(c)) }) };
};
const ERA_DATS: Record<string, { present: boolean; open: () => Dats | undefined }> = {
  eor: { present: existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell), open: () => undefined },
  'classicace-customdm': eraSet('classicace-customdm-1.60', 'client_portal.dat', 'client_cell_1.dat'),
  'classic-dereth': eraSet('classic-dereth-1.1', 'client_portal.dat', 'client_cell_1.dat'),
  'ac1999-retail': { present: existsSync(dataPath('dat-sets/ac1999-retail/portal.dat')) && existsSync(dataPath('dat-sets/ac1999-retail/cell.dat')), open: () => ac1999Dats()! },
};

const SPEEDS = [3, 4.5, 6.5];
const SKILLS = [10, 100, 300];

function velocity(heading: number, speed: number): { vx: number; vy: number } {
  const h = (heading * Math.PI) / 180;
  return { vx: Math.sin(h) * speed, vy: Math.cos(h) * speed };
}

for (const [era, dats] of Object.entries(ERA_DATS)) {
  describe.skipIf(!dats.present)(`ledge spots over the ${era} cells (needs that era's DATs)`, () => {
    const navs = new Map<number, DungeonNav>();
    beforeAll(async () => {
      const d = dats.open();
      for (const s of spotsFor(era)) {
        const lb = (s.cell & 0xffff0000) >>> 0;
        if (!navs.has(lb)) navs.set(lb, await dungeonNav(lb, { ...(d ? { dats: d } : {}), statics: true }));
      }
    }, 240_000);

    for (const s of spotsFor(era)) {
      const lb = (s.cell & 0xffff0000) >>> 0;
      const BX = ((lb >>> 24) & 0xff) * 192, BY = ((lb >>> 16) & 0xff) * 192;
      const run = (at: { x: number; y: number; z: number }, opts: LiveFrameOptions, t0 = 0, into?: LedgeSample[]) =>
        liveFramesOver(navs.get(lb)!, lb, at, { ...opts, coast: true, onFrame: into ? (f) => into.push({ ...f, t: f.t + t0 }) : undefined });

      it(`${s.id}: the start is on the floor in ${'0x' + s.cell.toString(16).toUpperCase()}`, () => {
        const col = navs.get(lb)!.col;
        expect(col.findCellContaining(BX + s.start.x, BY + s.start.y, s.start.z + col.lowerSphereHeight) >>> 0).toBe(s.cell);
        expect(col.getFloorHeight(BX + s.start.x, BY + s.start.y, s.start.z + 0.5, 1)).toBeCloseTo(s.start.z, 2);
      });

      if (s.jump === 'run-jump') {
        it(`${s.id}: a run at the edge is held there (EdgeSlide), and a jump off it lands on ${s.landZ.join(' / ')} in the expected cell, read PASS`, () => {
          const walk = velocity(s.heading, 4);
          const pre: LedgeSample[] = [];
          const held = run(s.start, { walk: { vx: walk.vx, vy: walk.vy }, seconds: 1.5 }, 0, pre);
          expect(held.fell).toBe(false);
          expect(held.z).toBeCloseTo(s.start.z, 2);
          const gap = (s.edge.at - held[s.edge.axis]) * s.edge.dir; // how far short of the edge line the run stopped
          expect(gap).toBeGreaterThan(-0.1);
          expect(gap).toBeLessThan(1.2);
          for (const speed of SPEEDS) for (const skill of SKILLS) for (const power of [0.1, 0.6]) {
            const v = velocity(s.heading, speed);
            const frames = [...pre];
            const r = run({ x: held.x, y: held.y, z: held.z }, { jump: { ...v, up: getJumpVelocity(0, skill, power) }, seconds: 5 }, pre[pre.length - 1].t, frames);
            const what = `${s.id} speed ${speed} skill ${skill} power ${power}: ${JSON.stringify({ x: r.x, y: r.y, z: r.z, cell: r.cell.toString(16) })}`;
            expect(r.landed, what).toBe(true);
            expect(s.landZ.some((z) => Math.abs(r.z - z) < 0.05), what).toBe(true);
            expect(s.landCells, what).toContain(r.cell);
            const verdict = ledgeVerdict(s, frames);
            expect(verdict.outcome, `${what} → ${verdict.reason}: ${verdict.detail}`).toBe('PASS');
          }
        });

        it(`${s.id}: without EdgeSlide the run itself walks off and falls to the floor below (never held at the ledge's height)`, () => {
          const walk = velocity(s.heading, 4);
          const r = run(s.start, { walk: { vx: walk.vx, vy: walk.vy }, edgeSlide: false, seconds: 5 });
          expect(r.fell).toBe(true);
          expect(r.landed).toBe(true);
          expect(r.z).toBeLessThan(s.start.z - 4);
          expect(r.cell).not.toBe(0);
        });
      } else {
        it(`${s.id}: a full jump at the wall lands back on the take-off floor inside the room, read PASS; without the ceiling check (before 4ae823b01) a high Jump reads FAIL`, () => {
          const v = velocity(s.heading, 6);
          for (const skill of [10, 100, 450]) {
            const frames: LedgeSample[] = [];
            const r = run(s.start, { jump: { ...v, up: getJumpVelocity(0, skill, 1) }, seconds: 5 }, 0, frames);
            expect(r.landed).toBe(true);
            expect(r.z).toBeCloseTo(s.landZ[0], 2);
            expect(s.landCells).toContain(r.cell);
            expect(ledgeVerdict(s, frames).outcome).toBe('PASS');
          }
          const before: LedgeSample[] = [];
          run(s.start, { jump: { ...v, up: getJumpVelocity(0, 450, 0.85) }, ceilings: false, seconds: 5 }, 0, before);
          const old = ledgeVerdict(s, before);
          expect(old.outcome).toBe('FAIL');
          expect(['through-wall', 'hung', 'no-cell']).toContain(old.reason);
        });
      }
    }
  });
}
