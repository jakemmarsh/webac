/**
 * BUG.agent-pace-run-default-off: the agent's pace is intent (walk or run), mapped to the hold-run key (Shift) through
 * RunAsDefaultMovement (AgentApi.paceShift). The hold-run key inverts the option (CameraController.isRunning:
 * `runIsDefault ? !shiftHeld : shiftHeld`): with it on Shift walks, with it off W alone walks and Shift runs.
 *
 * Before, the walk task held Shift for "walk" (`this.key('ShiftLeft', !!slow)`), so with the option off a walk_to
 * walked the whole trip and RAN its careful last metres, a portal approach and a jump's take-off, the opposite of what
 * it meant. Both settings are driven here through the real AgentApi on the fake host (tests/_harness/agentFake.ts,
 * whose body walks at 3.12 m/s when Shift === runDefault and runs at 4 m/s otherwise).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const ARCANIST = 0x50000002;

/** Is the fake body running now (W held, and the hold-run key not flipping the option)? */
const running = (host: FakeHost): boolean => host.keys.has('ShiftLeft') !== host.runDefault;

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

for (const runDefault of [false, true]) {
  const setting = runDefault ? 'RunAsDefaultMovement on' : 'RunAsDefaultMovement off';
  describe(`agent pace with ${setting}`, () => {
    let host: FakeHost;
    let api: AgentApi;
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      host = new FakeHost();
      host.runDefault = runDefault;
      api = new AgentApi(host);
    });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it('a long walk_to a fellow standing still runs the trip and walks only the last metres', async () => {
      host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 120 });
      const ticks: Array<{ d: number; run: boolean }> = [];
      const r = await settle(api, host, api.walkTo(ARCANIST, { within: 2, timeoutMs: 60_000 }), 60_000, () => {
        if (!host.keys.has('KeyW')) return;
        const a = host.objs.get(ARCANIST)!;
        ticks.push({ d: Math.hypot(a.x - host.me.x, a.y - host.me.y), run: running(host) });
      });
      expect(r!.message).toMatch(/^arrived/);
      const far = ticks.filter((t) => t.d > 2 + AgentApi.APPROACH_WALK_M + 1);
      const near = ticks.filter((t) => t.d < 2 + AgentApi.APPROACH_WALK_M - 0.5);
      expect(far.length).toBeGreaterThan(100);
      // The trip is a run: with the option off that is Shift held; with it on, no Shift.
      expect(far.every((t) => t.run)).toBe(true);
      // The last metres to a fellow standing still are a walk, so the body stops by them.
      expect(near.length).toBeGreaterThan(0);
      expect(near.every((t) => !t.run)).toBe(true);
    });

    it('follow and stay_with run the whole way (the hold-run key as the option needs it)', async () => {
      host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 50 });
      host.fellows = () => [{ guid: ARCANIST, name: 'Claude Arcanist', health: { cur: 40, max: 50 }, stamina: { cur: 40, max: 50 }, mana: { cur: 40, max: 50 } }];
      let wTicks = 0, walkTicks = 0;
      const sample = (): void => { if (host.keys.has('KeyW')) { wTicks++; if (!running(host)) walkTicks++; } };
      const lead = (): void => { host.objs.get(ARCANIST)!.y += 0.35; };
      await settle(api, host, api.follow('Claude Arcanist', { within: 4, durationMs: 30_000 }), 40_000, () => { lead(); sample(); });
      expect(wTicks).toBeGreaterThan(20);
      expect(walkTicks).toBe(0);
      api.stopMoving();
      wTicks = 0; walkTicks = 0;
      const r = await settle(api, host, api.walkTo('150m north', { within: 2, stayWith: 'Claude Arcanist', timeoutMs: 600_000 }), 200_000, () => { lead(); sample(); });
      expect(r).toMatchObject({ ok: true });
      expect(wTicks).toBeGreaterThan(100);
      expect(walkTicks).toBe(0);
    });

    it('a jump over a gap: the take-off is walked (only in its last metres), the run before it is a run, and it lands', async () => {
      const inX = (x: number): boolean => x > 70 && x < 90;
      host.floors = (x, y) => (inX(x) && y > 0 && y < 60 ? (y < 30 || y > 32.5 ? [94, 50] : [50]) : []);
      host.add({ guid: 0x80000062, name: 'Far Ledge Post', x: 80, y: 40, z: 94 });
      const walkedAt: number[] = [];
      let ranBefore = 0;
      const key = host.key;
      host.key = (code: string, down: boolean) => {
        key(code, down);
        if (host.keys.has('KeyW') && host.me.y < 30 && !host.airborne) { if (running(host)) ranBefore++; else walkedAt.push(host.me.y); }
      };
      const p = api.walkTo('Far Ledge Post', { within: 1.5, timeoutMs: 60_000 });
      run(api, host, 40_000);
      const r = await p;
      expect(r).toMatchObject({ ok: true });
      expect(r.message).toMatch(/jumped once/);
      expect(ranBefore).toBeGreaterThan(0);
      expect(walkedAt.length).toBeGreaterThan(0);
      // Walked only within 3 m of the gap's edge (y 30), never from the start of the walk (y 20).
      for (const y of walkedAt) expect(y).toBeGreaterThan(26);
      // The leap's pace is the one the planner flew (jumpLaunch's walk = the pace, whatever the option).
      expect(host.launches.length).toBe(1);
      expect(host.launches[0].walk).toBe(true);
    });

    it('ac_jump (intent): forward alone is a running jump, walk=true a walking one', () => {
      const shiftDuring = (opts: Parameters<AgentApi['jump']>[0]): boolean => {
        api.jump(opts);
        const held = host.keys.has('ShiftLeft');
        vi.advanceTimersByTime(1000);
        expect(host.keys.has('ShiftLeft')).toBe(false);
        expect(host.keys.has('KeyW')).toBe(false);
        return held;
      };
      // Running forward: Shift held only where it runs (option off).
      expect(shiftDuring({ forward: true })).toBe(!runDefault);
      // Walking forward: Shift held only where it walks (option on).
      expect(shiftDuring({ forward: true, walk: true })).toBe(runDefault);
      // A standing jump touches no pace.
      expect(shiftDuring({})).toBe(false);
    });

    it('a plugin\'s jump (UB jump[s…], VTank / routine Jump with Shift) holds the Shift KEY literally, whatever the option', () => {
      // The plugins press a literal Shift (reference/plugin-specs/magtools.md 10.9 "with optional Shift and W/Z/X/C held";
      // UB's jump[s] the same), so with RunAsDefaultMovement off their `s` jump is a running jump, as on retail.
      // (verify-ub-commands.ts pins that /ub jumpsw reaches jump() as shift: true; ubHost passes it straight through.)
      const keysDuring = (opts: Parameters<AgentApi['jump']>[0]): { shift: boolean; run: boolean } => {
        api.jump(opts);
        const out = { shift: host.keys.has('ShiftLeft'), run: running(host) };
        vi.advanceTimersByTime(1000);
        expect(host.keys.has('ShiftLeft')).toBe(false);
        return out;
      };
      // `sw`: Shift held, so a walk with the option on and a RUN with it off.
      expect(keysDuring({ forward: true, shift: true })).toEqual({ shift: true, run: !runDefault });
      // `w`: no Shift, so a run with the option on and a walk with it off.
      expect(keysDuring({ forward: true, shift: false })).toEqual({ shift: false, run: runDefault });
      // `s` alone: Shift held.
      expect(keysDuring({ shift: true }).shift).toBe(true);
    });

    it('UB setmotion Walk holds the walk pace; letting go of it lets go of Shift', () => {
      expect(api.holdMotion('Forward', true)).toBe(true);
      expect(api.holdMotion('Walk', true)).toBe(true);
      expect(host.keys.has('KeyW')).toBe(true);
      expect(running(host)).toBe(false);
      expect(api.holdMotion('Walk', false)).toBe(true);
      expect(host.keys.has('ShiftLeft')).toBe(false);
      api.holdMotion('Forward', false);
    });
  });
}

describe('the player\'s own keys are untouched', () => {
  it('nothing in a walk task presses Shift for a player pressing it themselves: the agent only maps its own pace', () => {
    vi.useFakeTimers();
    try {
      const host = new FakeHost();
      host.runDefault = false;
      const api = new AgentApi(host);
      // No agent task: the agent holds nothing, and calls the host's key for nothing.
      const calls: string[] = [];
      const key = host.key;
      host.key = (code, down) => { calls.push(`${code}:${down}`); key(code, down); };
      run(api, host, 2000);
      expect(calls).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});
