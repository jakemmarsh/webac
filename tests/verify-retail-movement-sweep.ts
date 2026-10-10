/**
 * MOVE.combination-sweep — our movement against the retail client on every
 * movement-key combination (tools/lib/movement-scenarios.ts SWEEP,
 * docs/movement-ab.md "Combination sweep"). The fixture is the retail side of
 * `tools/retail-movement-ab.ts report --tag sweep --fixture …`: what ACE
 * received from the real acclient.exe for each scripted key sequence.
 *
 * Each scenario replays the same physical keys, at the times the retail
 * client acted on them, through our real input path (tests/_harness/
 * movement-sim.ts) and checks:
 *   - the MoveToStates: the same raw motion states, byte for byte, in order
 *     (which commands, hold keys and speeds retail sends for each change);
 *   - every retail position sample within 0.45 m + 6 % of the distance (a
 *     sample is up to ~50 ms off: a frame of key jitter at 6.5 m/s), jumps
 *     excepted (the simulation has no flight);
 *   - the heading after the turns within 6°.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RUN_ANIM_SPEED } from '@ac/shared';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import { MotionStance } from '../packages/renderer/src/animation/MotionCommands.js';
import { SWEEP } from '../tools/lib/movement-scenarios.ts';
import { angleDiff, frameAt, retailKeyTimes, simulateKeys, type SimResult } from './_harness/movement-sim.js';
import { buildA9b4World } from './_harness/a9b4-world.js';

type TrackRow = [number, string, number, number, number, number, number];
interface GoldenScenario {
  style: string;
  displacement: { fwd: number; right: number };
  finalHeading: number;
  track: TrackRow[];
  moveToState: Array<{ t: number; bytes: string } & Record<string, unknown>>;
  jumps: Array<{ t: number; extent: number; v: number[] }>;
  counts: { mts: number; ap: number };
  serverMotions?: import('./_harness/movement-sim.js').ServerMotionRow[];
  serverCombat?: import('./_harness/movement-sim.js').ServerCombatRow[];
  attacks?: Array<{ t: number; cancel?: boolean; missile?: boolean }>;
  /** The lane doors' PhysicsState as the scenario began (t 0) and each change after (ACE holds an opened door Ethereal for 300 s). */
  objectStates?: Array<{ t: number; guid: number; state: number }>;
}
/** The fixture's style name (the report's CMD names, else a hex id) → the stance id. */
const styleId = (st: string): number => st === 'Magic' ? MotionStance.Magic : st === 'NonCombat' ? MotionStance.NonCombat : Number(st) >>> 0;
const FIXTURE = resolve(__dirname, 'fixtures/movement-ab/retail-sweep-2026-10-08.json');
const haveFixture = existsSync(FIXTURE);
const haveDat = existsSync(DAT_PATHS.portal);

const tolerance = (dist: number) => 0.45 + 0.06 * dist;

describe.skipIf(!haveDat || !haveFixture)('MOVE.combination-sweep — every movement-key combination against the retail client', () => {
  let golden: Record<string, GoldenScenario> = {};
  let runRate = 0;
  const sims = new Map<string, SimResult>();

  beforeAll(async () => {
    golden = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { scenarios: Record<string, GoldenScenario> }).scenarios;
    // The mover's run rate from its running jump's launch (get_leave_ground_velocity →
    // get_state_velocity: RunForward × run_anim_speed × run rate).
    // (A partial recording without it: the first recording's movers, the same characters — 1.635.)
    const jump = golden['sweep-jump-W-releaseair']?.jumps[0];
    runRate = jump ? jump.v[1] / RUN_ANIM_SPEED : 1.635;
    const portal = openDat(DAT_PATHS.portal);
    // The recording's lane, with its house, statics, the Cooking Forge and Thorolf.
    const services = await buildA9b4World();
    // In recording order: whether the server still had control carries over
    // from one scenario to the next, as it did in the retail client.
    let controlled = false;
    for (const name of Object.keys(golden)) {
      const s = SWEEP.find((x) => x.name === name);
      const g = golden[name];
      if (!s) continue;
      const keyTimes = retailKeyTimes(s.events, g.moveToState.map((m) => Number(m.t)), {
        attack: (g.attacks ?? []).filter((a) => !a.cancel).map((a) => a.t),
        cast: ((g as unknown as { casts?: { t: number }[] }).casts ?? []).map((c) => c.t),
      });
      const endMs = Math.max(g.track[g.track.length - 1]?.[0] ?? 0, keyTimes[keyTimes.length - 1], ...(g.serverMotions ?? []).map((m) => m.t)) + 1500;
      const combat = s.stance === 'melee' ? 'melee' as const : s.stance === 'missile' ? 'missile' as const : undefined;
      // No MoveToState to read the style from (a standing attack): the server's motions carry it.
      const style = !g.moveToState.length && g.serverMotions?.length ? (0x80000000 | g.serverMotions[g.serverMotions.length - 1].style) >>> 0 : styleId(g.style);
      const sim = simulateKeys({ portal, events: s.events, keyTimes, endMs, style, runRate, world: (now) => services({ slidingNormal: null }, (guid) => (g.objectStates ?? []).filter((o) => o.guid === guid && o.t <= now()).pop()?.state), serverMotions: g.serverMotions, startControlled: controlled, combat, serverCombat: g.serverCombat });
      controlled = sim.endControlledByServer;
      sims.set(s.name, sim);
    }
  });

  /** Scenarios not recorded yet, each with why (none: all 173 recorded by 2026-10-09). */
  const PENDING_RECORDING = new Set<string>();

  it('the fixture holds every sweep scenario but the ones listed as pending', () => {
    expect(SWEEP.filter((s) => !golden[s.name]).map((s) => s.name).sort()).toEqual([...PENDING_RECORDING].sort());
  });

  for (const s of SWEEP) {
    const isJump = s.name.startsWith('sweep-jump');
    it(`${s.name}: the same MoveToStates as retail, byte for byte`, (ctx) => {
      const g = golden[s.name];
      if (!sims.has(s.name)) return ctx.skip();
      const ours = sims.get(s.name)!.wire.flatMap((w) => (w.a.kind === 'moveToState' ? [w.a.bytes] : []));
      expect(ours).toEqual(g.moveToState.map((m) => m.bytes));
    });
    if (s.stance) {
      it(`${s.name}: the same attacks and CancelAttacks as retail, in order, each within 150 ms`, (ctx) => {
        const g = golden[s.name];
        if (!sims.has(s.name)) return ctx.skip();
        // A release is one event even when EndAttackRequest re-sends at the
        // slider's power in the same millisecond: whether it does depends on the
        // bar level against the slider (0.5), a tie the unobservable key-press
        // time decides (End sends nothing on press). CancelAttacks count one by one.
        const collapse = (xs: (readonly [string, number])[]) => xs.filter((x, i) => !(x[0] === 'attack' && i > 0 && xs[i - 1][0] === 'attack' && Math.abs(xs[i - 1][1] - x[1]) < 1));
        const retail = collapse((g.attacks ?? []).map((a) => [a.cancel ? 'cancelAttack' : 'attack', a.t] as const));
        const ours = collapse(sims.get(s.name)!.attacks.map((a) => [a.kind, a.t] as const));
        expect(ours.map((a) => a[0])).toEqual(retail.map((a) => a[0]));
        ours.forEach((a, i) => expect(Math.abs(a[1] - retail[i][1]), `${a[0]} #${i}`).toBeLessThanOrEqual(150));
      });
    }
    if (!isJump) {
      it(`${s.name}: every retail position sample within 0.45 m + 6%, and the heading within 6°`, (ctx) => {
        const g = golden[s.name];
        if (!sims.has(s.name)) return ctx.skip();
        // A server MoveTo / TurnTo (movement types 6–9) runs on MoveToManager,
        // which this replay does not drive: the live `ours` run compares those.
        if ((g.serverMotions ?? []).some((m) => m.type >= 6)) return ctx.skip();
        const { frames } = sims.get(s.name)!;
        const misses: string[] = [];
        for (const [t, kind, right, fwd] of g.track) {
          const f = frameAt(frames, t);
          if (Math.hypot(f.right - right, f.fwd - fwd) > tolerance(Math.hypot(right, fwd))) misses.push(`${kind}@${t}: retail (${right}, ${fwd}) ours (${f.right.toFixed(2)}, ${f.fwd.toFixed(2)})`);
        }
        expect(misses).toEqual([]);
        expect(angleDiff(frames[frames.length - 1].heading, g.finalHeading)).toBeLessThanOrEqual(6);
        // The resting spot (the last wire sample) within 0.5 m: the per-sample
        // allowance grows with the distance and hid a 1.2 m difference at the end
        // of a run.
        if (g.track.length) {
          const [t, , right, fwd] = g.track[g.track.length - 1];
          const f = frameAt(frames, t);
          const rest = Math.hypot(f.right - right, f.fwd - fwd);
          expect(rest).toBeLessThanOrEqual(0.5);
        }
      });
    }
  }
});
