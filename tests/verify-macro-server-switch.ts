/**
 * BUG.macro-hard-cut-every-deploy — a running macro yields for a bridge deploy's handover (docs/bridge-handover.md).
 *
 * A macro is always fighting, so the page never found the safe moment the planned handover needs and every macro tab
 * took the drain's hard cut and a re-login (Coldeve 2026-11-07 22:41Z and 00:26Z: three tabs each deploy). Now, while
 * DrainHandover wants a move (yieldWanted), the real RoutineEngine yields, unnoticed (Jake, 2026-11-07): only in a lull
 * it has anyway (nothing in Monster Range, no loot or buff due), never mid-fight or mid-leg; it goes to peace, pulls
 * nothing new, keeps walking its route where nothing is near, fights back what comes at it, says nothing in chat or the
 * window. DrainHandover's own safety rules (unchanged) then find the moment, and the macro carries on at its next step.
 * Bounded by HANDOVER_YIELD_MAX_MS; players not running a routine are never held. The handover report says how long the
 * macro yielded (yieldedMs), and the bridge keeps that field. Each test reports the visible pause.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, MAP_COORD_ORIGIN } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import {
  DrainHandover, HANDOVER_COMBAT_QUIET_MS, HANDOVER_POLL_MS, HANDOVER_SAFE_HOLD_MS, HANDOVER_YIELD_MAX_MS,
} from '../packages/renderer/src/session/DrainHandover.ts';
import { PreworldReporter } from '../packages/renderer/src/telemetry/PreworldReporter.ts';
import { vtStatusText } from '../packages/renderer/src/ui/automation/vtActivity.ts';
import { sanitizeClientPreworld } from '../services/ws-tcp-bridge/src/clientPreworld.ts';
import { ALL_MODULES_OFF, emptyVtankData, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { FakeHost, HOLTBURG, run } from './_harness/agentFake.ts';

/** Map coordinates of a landblock-local point in HOLTBURG. */
function M(x: number, y: number): string {
  const gx = ((HOLTBURG >>> 24) & 0xff) * 192 + x;
  const gy = ((HOLTBURG >>> 16) & 0xff) * 192 + y;
  const ew = gx / 240 - MAP_COORD_ORIGIN; const ns = gy / 240 - MAP_COORD_ORIGIN;
  return `${Math.abs(ns).toFixed(4)}${ns >= 0 ? 'N' : 'S'}, ${Math.abs(ew).toFixed(4)}${ew >= 0 ? 'E' : 'W'}`;
}

const macro = (over: Partial<RoutineProfile> = {}): RoutineProfile => ({
  name: 'Hunt', modules: { ...ALL_MODULES_OFF, vitals: true, combat: true, navigation: true },
  initialState: 'Default', loot: [], buffSets: [], routes: [], states: [{ name: 'Default', rules: [] }],
  macro: true, settings: { AttackDistance: 20, EnableLooting: false, EnableBuffing: false },
  ...over,
});

const SKULKER = 0x80007001;
const SLINKER = 0x80007002;
const MOSSWART = 0x80007003;
const monster = (guid: number, name: string, x: number, y: number) => ({ guid, name, itemType: 0x10, objectDescFlags: 0x10, x, y });

/**
 * The page as main.ts wires it: the real AgentApi + RoutineEngine over the fake host, the real DrainHandover whose
 * safety reads the fake's stance, the last swing either way (the page's lastCombatAt) and creatures chasing.
 */
function page() {
  const host = new FakeHost();
  let lastCombatAt: number | null = null;
  let seeking = 0;
  let ticker: (() => void) | null = null;
  let nextPoll = 0;
  const handovers: number[] = [];
  const reports: Array<{ reason: string; path: string; ms: number; token?: string | null; yieldedMs?: number }> = [];
  const drain = new DrainHandover({
    now: () => host.t,
    safety: () => ({
      inWorld: true, entering: false, combatStance: host.me.combatMode !== 'peace', dead: host.me.dead, portalSpace: false,
      trade: false, vendor: false, dialog: null, lastCombatAt, hostilesSeeking: seeking,
    }),
    handover: () => { handovers.push(host.t); },
    report: (r) => { reports.push(r); },
    setInterval: (fn) => { ticker = fn; return 1; },
    clearInterval: () => { ticker = null; },
  });
  Object.assign(host, { serverSwitchPending: () => drain.yieldWanted(), serverSwitchYield: (on: boolean) => drain.noteYield(on) });
  // Every swing of ours is combat (the page's attack notification).
  const attack = host.attack;
  host.attack = (g, p, h) => { lastCombatAt = host.t; host.me.combatMode = 'melee'; attack(g, p, h); };
  const api = new AgentApi(host);
  const step = async (ms: number) => {
    for (let t = 0; t < ms; t += 100) {
      run(api, host, 100);
      if (host.t >= nextPoll) { nextPoll = host.t + HANDOVER_POLL_MS; ticker?.(); }
      await vi.advanceTimersByTimeAsync(100);
    }
  };
  /** A monster's swing at you: the CombatEnemy line (attackingYou) and the page's lastCombatAt. */
  const hitBy = (name: string) => { lastCombatAt = host.t; api.pushChat(`The ${name} hits your chest for 3 points of bludgeoning damage!`, 0x15); };
  const attacksOn = (g: number) => host.sent.filter((x) => x.startsWith(`attack ${g.toString(16)}`)).length;
  /** Let the macro's attack on `g` land and the monster die (as the routine-engine tests do). */
  const kill = async (g: number) => {
    for (let i = 0; i < 60 && !attacksOn(g); i++) await step(100);
    expect(attacksOn(g), api.routine.history().join('\n')).toBeGreaterThan(0);
    host.pending = false;
    host.dying.add(g);
    await step(300);
    host.objs.delete(g);
    await step(300);
  };
  return {
    host, api, drain, handovers, reports, step, hitBy, attacksOn, kill,
    setSeeking: (n: number) => { seeking = n; },
  };
}

describe('a running macro yields for a bridge deploy\'s handover, in a lull it has anyway', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** The player-facing lines the run printed (chat), to show the yield says nothing there. */
  const chatOf = (api: AgentApi): string[] => {
    const out: string[] = [];
    api.routine.onReport = (t) => { out.push(t); };
    return out;
  };

  it('mid-fight: every monster in range is fought as usual; the yield starts in the lull after, the handover follows, and the macro carries on', async () => {
    const pg = page();
    const { host, api, drain } = pg;
    const chat = chatOf(api);
    host.add(monster(SKULKER, 'Drudge Skulker', 80, 30));
    host.add(monster(SLINKER, 'Drudge Slinker', 86, 34));
    api.routine.start(macro());
    for (let i = 0; i < 60 && !pg.attacksOn(SKULKER); i++) await pg.step(100);
    expect(pg.attacksOn(SKULKER)).toBe(1);
    // The deploy's notice arrives mid-fight: nothing visible changes while monsters stand in Monster Range.
    drain.onDraining(true);
    await pg.step(2000);
    expect(api.routine.status().serverSwitch).toBeUndefined();
    await pg.kill(SKULKER);
    // The Slinker in range is the macro's next target, as without a deploy.
    for (let i = 0; i < 60 && !pg.attacksOn(SLINKER); i++) await pg.step(100);
    expect(pg.attacksOn(SLINKER)).toBe(1);
    expect(api.routine.status().serverSwitch).toBeUndefined();
    await pg.kill(SLINKER);
    // The lull after the last kill: peace (as Peace Mode When Idle), and the yield.
    await pg.step(1000);
    const since = api.routine.status().serverSwitch?.since;
    expect(since).toBeDefined();
    expect(host.me.combatMode).toBe('peace');
    expect(api.routine.history().join('\n')).toMatch(/server switch: yielding for it in this lull/);
    // Nothing said in chat, nothing in the VTank window's status line.
    expect(chat.filter((l) => /switch/i.test(l))).toEqual([]);
    expect(vtStatusText(api.routine.status(), true)).not.toMatch(/switch/i);
    // The page's own rules find the safe moment: 15 s after the last swing, held 2 s.
    for (let i = 0; i < 300 && !pg.handovers.length; i++) await pg.step(100);
    expect(pg.handovers).toHaveLength(1);
    // The visible pause: from the lull to the move, the quiet period after the last swing plus the hold.
    const pause = pg.handovers[0] - since!;
    expect(pause).toBeGreaterThan(HANDOVER_COMBAT_QUIET_MS - 2000);
    expect(pause).toBeLessThanOrEqual(HANDOVER_COMBAT_QUIET_MS + HANDOVER_SAFE_HOLD_MS + 1000);
    drain.onResult({ ok: true, ms: 230 });
    expect(pg.reports).toHaveLength(1);
    expect(pg.reports[0]).toMatchObject({ reason: 'safe', path: 'adopt', ms: 230 });
    expect(pg.reports[0].yieldedMs).toBe(pause);
    // Over at the run's next step (half a second at most).
    await pg.step(500);
    expect(api.routine.status().serverSwitch).toBeUndefined();
    expect(api.routine.history().join('\n')).toMatch(/server switch: over after \d+ s; carrying on in "Default"/);
    // A newcomer is fought as ever.
    host.add(monster(MOSSWART, 'Mosswart', 80, 26));
    for (let i = 0; i < 60 && !pg.attacksOn(MOSSWART); i++) await pg.step(100);
    expect(pg.attacksOn(MOSSWART)).toBe(1);
    api.routine.stop();
  });

  it('a VirindiTank profile (its own planners) yields the same way: only after its fight, in the lull', async () => {
    const pg = page();
    const { host, api, drain } = pg;
    // An empty spell table is enough for the melee planner (no spells known).
    Object.assign(host, { spellTableData: () => ({ spells: new Map() }), skillList: () => [] });
    host.add(monster(SKULKER, 'Drudge Skulker', 80, 30));
    api.routine.start(macro({ vtank: emptyVtankData(), ruleFiring: 'once' } as Partial<RoutineProfile>));
    for (let i = 0; i < 100 && !pg.attacksOn(SKULKER); i++) await pg.step(100);
    expect(pg.attacksOn(SKULKER), api.routine.history().join('\n')).toBeGreaterThan(0);
    drain.onDraining(true);
    // The planner's attack wait (10 s) ends with the Skulker alive and in range: no lull, the fight goes on.
    await pg.step(12_000);
    expect(api.routine.status().serverSwitch).toBeUndefined();
    await pg.kill(SKULKER);
    await pg.step(2000);
    const since = api.routine.status().serverSwitch?.since;
    expect(since).toBeDefined();
    expect(host.me.combatMode).toBe('peace');
    for (let i = 0; i < 300 && !pg.handovers.length; i++) await pg.step(100);
    expect(pg.handovers).toHaveLength(1);
    expect(pg.handovers[0] - since!).toBeLessThanOrEqual(HANDOVER_COMBAT_QUIET_MS + HANDOVER_SAFE_HOLD_MS + 1000);
    drain.onResult({ ok: true, ms: 210 });
    expect(pg.reports[0].yieldedMs).toBeGreaterThan(0);
    await pg.step(500);
    expect(api.routine.status().serverSwitch).toBeUndefined();
    api.routine.stop();
  });

  it('on a route with nothing near: it never stops walking; the move happens on the way, the route point sequence unchanged', async () => {
    const pg = page();
    const { host, api, drain } = pg;
    api.routine.start(macro({
      settings: { EnableCombat: false, EnableNav: true, EnableLooting: false, EnableBuffing: false },
      routes: [{ name: 'Loop', mode: 'circular', points: [M(80, 32), M(80, 48), M(80, 64), M(80, 80)] }], navRoute: 'Loop',
    }));
    for (let i = 0; i < 100 && (api.routine.status().nav?.point ?? 0) < 1; i++) await pg.step(100);
    expect(api.routine.status().nav?.point).toBe(1);
    drain.onDraining(true);
    // The leg under way ends; the next leg starts as ever, now as the yield's ("walking").
    const track: Array<{ t: number; y: number; point: number }> = [];
    for (let i = 0; i < 100 && !pg.handovers.length; i++) { await pg.step(100); track.push({ t: host.t, y: host.me.y, point: api.routine.status().nav!.point }); }
    expect(pg.handovers).toHaveLength(1);
    expect(api.routine.history().join('\n')).toMatch(/server switch: yielding for it in this lull/);
    // The visible pause: none. Every half second of the yield the character moved on.
    for (let k = 5; k < track.length; k += 5) expect(track[k].y - track[k - 5].y).toBeGreaterThan(1);
    // Points in order, none skipped.
    const points = [...new Set(track.map((x) => x.point))];
    expect(points).toEqual(points.slice().sort((a, b) => a - b));
    drain.onResult({ ok: true, ms: 180 });
    expect(pg.reports[0].yieldedMs).toBeLessThan(HANDOVER_SAFE_HOLD_MS + 2000);
    await pg.step(3000);
    expect(api.routine.status().serverSwitch).toBeUndefined();
    expect(api.routine.history().join('\n')).toMatch(/carrying on in "Default", route "Loop" point \d/);
    api.routine.stop();
  });

  it('attacked during the yield: it fights back, and the handover waits until that fight has been over long enough', async () => {
    const pg = page();
    const { host, api, drain } = pg;
    api.routine.start(macro());
    drain.onDraining(true);
    await pg.step(1000);
    expect(api.routine.status().serverSwitch?.phase).toBe('holding');
    // A Mosswart walks up and hits you.
    host.add(monster(MOSSWART, 'Mosswart', 80, 22));
    pg.setSeeking(1);
    pg.hitBy('Mosswart');
    await pg.step(1000);
    expect(pg.attacksOn(MOSSWART)).toBe(1);
    expect(api.routine.history().join('\n')).toMatch(/server switch: Mosswart on you: fighting it off first/);
    await pg.step(5000);
    expect(pg.handovers).toHaveLength(0);
    pg.setSeeking(0);
    await pg.kill(MOSSWART);
    await pg.step(2000);
    expect(host.me.combatMode).toBe('peace');
    expect(pg.handovers).toHaveLength(0);
    await pg.step(HANDOVER_COMBAT_QUIET_MS + HANDOVER_SAFE_HOLD_MS);
    expect(pg.handovers).toHaveLength(1);
    drain.onResult({ ok: true, ms: 300 });
    expect(pg.reports[0].yieldedMs).toBeGreaterThan(HANDOVER_COMBAT_QUIET_MS);
    api.routine.stop();
  });

  it('a monster wandering into range during the yield, not on you, is not pulled', async () => {
    const pg = page();
    const { host, api, drain } = pg;
    api.routine.start(macro());
    drain.onDraining(true);
    await pg.step(1000);
    expect(api.routine.status().serverSwitch).toBeDefined();
    host.add(monster(SLINKER, 'Drudge Slinker', 86, 34));
    await pg.step(HANDOVER_SAFE_HOLD_MS + 1000);
    expect(pg.attacksOn(SLINKER)).toBe(0);
    expect(pg.handovers).toHaveLength(1);
    drain.onResult({ ok: true, ms: 150 });
    for (let i = 0; i < 60 && !pg.attacksOn(SLINKER); i++) await pg.step(100);
    expect(pg.attacksOn(SLINKER)).toBe(1);
    api.routine.stop();
  });

  it('no lull within the cap (always something in range): it is never held, and the hard cut follows as before', async () => {
    const pg = page();
    const { host, api, drain } = pg;
    host.add(monster(MOSSWART, 'Mosswart', 80, 22));
    api.routine.start(macro());
    drain.onDraining(true);
    // A Mosswart that never dies keeps hitting.
    pg.setSeeking(1);
    for (let t = 0; t < HANDOVER_YIELD_MAX_MS + 4000; t += 2000) { pg.hitBy('Mosswart'); await pg.step(2000); expect(api.routine.status().serverSwitch).toBeUndefined(); }
    expect(drain.yieldWanted()).toBe(false);
    expect(pg.handovers).toHaveLength(0);
    drain.onSessionDropped();
    await pg.step(9000);
    drain.onEnteredWorld();
    expect(pg.reports).toEqual([{ reason: 'hard_cut', path: 'relogin', ms: 9000 }]);
    api.routine.stop();
  });

  it('a lull with fighting after it until the cap: the yield ends at the cap, and the hard cut reports how long it held', async () => {
    const pg = page();
    const { host, api, drain } = pg;
    api.routine.start(macro());
    drain.onDraining(true);
    await pg.step(1000);
    expect(api.routine.status().serverSwitch).toBeDefined();
    host.add(monster(MOSSWART, 'Mosswart', 80, 22));
    pg.setSeeking(1);
    for (let t = 0; t < HANDOVER_YIELD_MAX_MS; t += 2000) { pg.hitBy('Mosswart'); await pg.step(2000); }
    expect(drain.yieldWanted()).toBe(false);
    await pg.step(1000);
    expect(api.routine.status().serverSwitch).toBeUndefined();
    expect(api.routine.history().join('\n')).toMatch(/server switch: over after \d+ s/);
    expect(pg.handovers).toHaveLength(0);
    drain.onSessionDropped();
    await pg.step(9000);
    drain.onEnteredWorld();
    expect(pg.reports[0]).toMatchObject({ reason: 'hard_cut', path: 'relogin' });
    expect(pg.reports[0].yieldedMs).toBeGreaterThan(HANDOVER_YIELD_MAX_MS - 3000);
    // Counted up to the cap (the run lets go at its next step, when the fight's step under way ends).
    expect(pg.reports[0].yieldedMs).toBeLessThanOrEqual(HANDOVER_YIELD_MAX_MS);
    api.routine.stop();
  });

  it('a player with no routine running is never held; an agent playing by hand is told what the move needs', async () => {
    const pg = page();
    const { host, api, drain } = pg;
    host.add(monster(SKULKER, 'Drudge Skulker', 80, 30));
    drain.onDraining(true);
    expect(drain.yieldWanted()).toBe(true);
    await pg.step(1000);
    expect(host.sent).toEqual([]);
    const text = formatObservation(api.observe());
    expect(text).toMatch(/SERVER SWITCH PENDING: .*Finish the fight you are in, start no new one, go to peace mode and wait/);
    await pg.step(HANDOVER_SAFE_HOLD_MS + 1000);
    expect(pg.handovers).toHaveLength(1);
    drain.onResult({ ok: true, ms: 120 });
    expect(pg.reports).toEqual([{ reason: 'safe', path: 'adopt', ms: 120 }]);
    expect(formatObservation(api.observe())).not.toMatch(/SERVER SWITCH/);
  });

  it('a bridge that cannot hand over wants no yield: the macro fights on as before', async () => {
    const pg = page();
    const { host, api, drain } = pg;
    host.add(monster(SKULKER, 'Drudge Skulker', 80, 30));
    api.routine.start(macro());
    drain.onDraining(false);
    await pg.step(2000);
    expect(drain.yieldWanted()).toBe(false);
    expect(api.routine.status().serverSwitch).toBeUndefined();
    expect(pg.attacksOn(SKULKER)).toBe(1);
    api.routine.stop();
  });

  it('a stop during the yield ends it', async () => {
    const pg = page();
    const { api, drain } = pg;
    api.routine.start(macro());
    drain.onDraining(true);
    await pg.step(1000);
    expect(api.routine.status().serverSwitch).toBeDefined();
    api.routine.stop();
    await pg.step(HANDOVER_SAFE_HOLD_MS + 1000);
    drain.onResult({ ok: true, ms: 90 });
    expect(pg.reports[0].yieldedMs).toBeGreaterThanOrEqual(500);
    expect(pg.reports[0].yieldedMs).toBeLessThan(2000);
  });
});

describe('the yield on the wire', () => {
  it('the reporter sends yieldedMs on a handover and the bridge keeps it; nonsense is dropped', () => {
    const posted: string[] = [];
    const r = new PreworldReporter({
      endpoint: 'https://bridge.test/client-preworld', build: 'b1', era: () => 'eor', server: () => 'coldeve',
      screen: () => 'world', send: (_url, body) => { posted.push(body); return Promise.resolve(); }, trace: 'abcdefgh12',
    });
    r.handover({ reason: 'safe', path: 'adopt', ms: 312, yieldedMs: 18_400.4 });
    r.handover({ reason: 'hard_cut', path: 'relogin', ms: 9100, yieldedMs: 120_000 });
    r.handover({ reason: 'safe', path: 'adopt', ms: 200 });
    const bodies = posted.map((p) => sanitizeClientPreworld(JSON.parse(p)));
    expect(bodies[0]).toMatchObject({ outcome: 'handover', handoverMs: 312, reason: 'safe', path: 'adopt', yieldedMs: 18_400 });
    expect(bodies[1]).toMatchObject({ reason: 'hard_cut', path: 'relogin', yieldedMs: 120_000 });
    expect(bodies[2]).not.toHaveProperty('yieldedMs');
    expect(sanitizeClientPreworld({ outcome: 'handover', handoverMs: 5, yieldedMs: -3 })).not.toHaveProperty('yieldedMs');
    expect(sanitizeClientPreworld({ outcome: 'enter_ok', yieldedMs: 5 })).not.toHaveProperty('yieldedMs');
  });
});
