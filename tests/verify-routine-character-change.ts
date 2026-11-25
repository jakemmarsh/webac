/**
 * BUG.macro-runs-across-character-change (production 2026-11-25, trace 399de00dc21ab87c, Dark Majesty): a player
 * started a macro (nav + loot) on one character in a dungeon, logged out and entered with three other characters in
 * turn; the run never stopped (each later session's automation_summary said starts=0 running=true), so the next
 * character, at Holtburg, walked toward the first one's dungeon route point until nav_idle no_path.
 *
 * VirindiTank is a Decal plugin: each login starts it afresh with Run Macro off and the character's own profiles
 * (docs/vtank-macro-behavior.md §1 "Run Macro … off at login", §2 per-character profiles). RoutineEngine.loggedOut (a
 * deliberate logout, main.ts's CharacterLogOff) and RoutineEngine.enteredWorld (each world entry, with whether it is the
 * automatic resume) end the run ('logout'), and keep it through the resume of its own character
 * (docs/reconnect.md path 1) and a bridge handover (docs/bridge-handover.md: no world entry at all).
 *
 * Drives the real AgentApi / RoutineEngine on the fake host, the real AutomationReporter + WorldReporter session
 * wiring main.ts uses, and the bridge's sanitizer. Shared code: the same in end of retail, Dark Majesty and AC1999.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, MAP_COORD_ORIGIN } from '../packages/renderer/src/agent/AgentApi.ts';
import { AutomationReporter, type AutomationEvent } from '../packages/renderer/src/telemetry/AutomationReporter.ts';
import { WorldReporter } from '../packages/renderer/src/telemetry/WorldReporter.ts';
import { ALL_MODULES_OFF, emptyRoutineDoc, startingProfile, type RoutineDoc, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { sanitizeClientAutomation } from '../services/ws-tcp-bridge/src/clientAutomation.ts';
import { FakeHost, HOLTBURG, run } from './_harness/agentFake.ts';

const FIRST = 0x50000001;   // FakeHost's own character
const SECOND = 0x50000002;

/** Map coordinates `x`, `y` metres into the Holtburg landblock (as the routine engine tests write them). */
function M(x: number, y: number): string {
  const gx = ((HOLTBURG >>> 24) & 0xff) * 192 + x;
  const gy = ((HOLTBURG >>> 16) & 0xff) * 192 + y;
  const ew = gx / 240 - MAP_COORD_ORIGIN; const ns = gy / 240 - MAP_COORD_ORIGIN;
  return `${Math.abs(ns).toFixed(4)}${ns >= 0 ? 'N' : 'S'}, ${Math.abs(ew).toFixed(4)}${ew >= 0 ? 'E' : 'W'}`;
}

/** A nav + loot macro like the reporter's: a circular dungeon route. */
const hunt = (): RoutineProfile => ({
  name: 'Dungeon loop', modules: { ...ALL_MODULES_OFF, looting: true, navigation: true },
  initialState: 'Default', loot: [], buffSets: [], states: [{ name: 'Default', rules: [] }],
  macro: true, settings: { EnableCombat: false, EnableNav: true, EnableLooting: true },
  navRoute: 'loop', routes: [{ name: 'loop', mode: 'circular', points: [M(80, 60), M(120, 60), M(120, 100)] }],
});

const byOutcome = <T extends AutomationEvent['outcome']>(evs: AutomationEvent[], o: T) => evs.filter((e) => e.outcome === o) as Array<Extract<AutomationEvent, { outcome: T }>>;
/** The engine's private nav-failure count (the no_path watch), read and set as the resume must keep it. */
const navFails = (api: AgentApi) => api.routine as unknown as { navFails: number };

describe('BUG.macro-runs-across-character-change — the macro ends with the login, and only then', () => {
  let host: FakeHost;
  let api: AgentApi;
  let events: AutomationEvent[];
  let reports: string[];
  let reporter: AutomationReporter;
  let world: WorldReporter;
  const clock = { t: 1000 };

  /** main.ts's order at a world entry: the session starts, then the routine engine hears who entered. */
  const enter = (guid: number, resumed: boolean) => {
    host.me.guid = guid;
    world.enteredWorld(resumed);
    api.routine.enteredWorld(guid, resumed);
  };
  /** main.ts's CharacterLogOff: the routine stops, then the session's summary goes. */
  const logOut = () => { api.routine.loggedOut(); world.left('logout'); };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    api = new AgentApi(host);
    events = [];
    reports = [];
    reporter = new AutomationReporter({
      endpoint: 'http://x/client-preworld', build: 'abc1234', trace: 'feedc0de12345678', era: () => 'dm', server: () => 'harvestgain',
      now: () => clock.t, send: (_u, b) => { events.push(JSON.parse(b) as AutomationEvent); },
    });
    world = new WorldReporter({ endpoint: null, build: 'abc1234', trace: 'feedc0de12345678', era: () => 'dm', server: () => 'harvestgain', now: () => clock.t });
    world.onSessionStart(() => reporter.enteredWorld());
    world.onSessionEnd((exit) => reporter.worldLeft(exit));
    api.routine.onLifecycle = (e) => reporter.routine(e);
    api.routine.onReport = (t) => { reports.push(t); };
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('the report: logout, then another character enters — not running, one logout stop, in the first session\'s summary', () => {
    enter(FIRST, false);
    expect(api.routine.start(hunt(), 'player').ok).toBe(true);
    run(api, host, 1500);
    expect(api.routine.status()).toMatchObject({ running: true, nav: { route: 'loop' } });
    clock.t += 60_000;
    logOut();
    expect(api.routine.status().running).toBe(false);
    // The next character: nothing running, no route of the first one's, no walking toward it.
    enter(SECOND, false);
    host.sent.length = 0;
    const at = { x: host.me.x, y: host.me.y };
    run(api, host, 3000);
    expect(api.routine.status()).toMatchObject({ running: false, profile: null });
    expect(api.routine.status().nav).toBeUndefined();
    expect(Math.hypot(host.me.x - at.x, host.me.y - at.y)).toBeLessThan(0.01);
    // Reported once, as 'logout', in the session it ended (the production summary said running=true, starts=0 for every later one).
    const stops = byOutcome(events, 'routine_stopped');
    expect(stops).toEqual([expect.objectContaining({ reason: 'logout', kind: 'macro', driver: 'player' })]);
    const [sum] = byOutcome(events, 'automation_summary');
    expect(sum).toMatchObject({ exit: 'logout', running: false, starts: { player: 1 }, stops: { logout: 1, player: 0 } });
    for (const ev of events) expect(sanitizeClientAutomation(ev)).toEqual(ev);
    // A deliberate logout says nothing in chat (the chat goes with the world).
    expect(reports.join('\n')).not.toMatch(/Stopped/);
    // The second session used nothing: no summary for it.
    world.left('logout');
    expect(byOutcome(events, 'automation_summary')).toHaveLength(1);
  });

  it('the automatic resume of the same character: still running, its route position and nav failures kept', () => {
    enter(FIRST, false);
    api.routine.start(hunt(), 'player');
    run(api, host, 1500);
    navFails(api).navFails = 2;
    const before = api.routine.status();
    // An unexpected drop (world_left disconnected), then the resume re-enters the same character.
    world.left('disconnected');
    enter(FIRST, true);
    const after = api.routine.status();
    expect(after).toMatchObject({ running: true, profile: 'Dungeon loop', nav: before.nav });
    expect(navFails(api).navFails).toBe(2);
    expect(byOutcome(events, 'routine_stopped')).toEqual([]);
    run(api, host, 1500);
    expect(api.routine.status().running).toBe(true);
  });

  it('a bridge handover (the WebSocket swapped, no world entry): the run holds for it, then carries on', () => {
    enter(FIRST, false);
    api.routine.start(hunt(), 'player');
    run(api, host, 1000);
    // The draining bridge wants a calm moment; the run yields, the swap happens, the wish ends.
    let pending = true;
    const yields: boolean[] = [];
    Object.assign(host, { serverSwitchPending: () => pending, serverSwitchYield: (on: boolean) => { yields.push(on); } });
    run(api, host, 1000);
    pending = false;
    run(api, host, 1000);
    expect(api.routine.status()).toMatchObject({ running: true, profile: 'Dungeon loop', nav: { route: 'loop' } });
    // The hard cut instead: a drop and the resume of the same character.
    world.left('disconnected');
    enter(FIRST, true);
    expect(api.routine.status().running).toBe(true);
    expect(byOutcome(events, 'routine_stopped')).toEqual([]);
  });

  it('a deliberate logout, then the same character again: off, as VirindiTank\'s Run Macro is at every login', () => {
    enter(FIRST, false);
    api.routine.start(hunt(), 'player');
    run(api, host, 1000);
    logOut();
    enter(FIRST, false);
    run(api, host, 1000);
    expect(api.routine.status().running).toBe(false);
    expect(byOutcome(events, 'routine_stopped').map((e) => e.reason)).toEqual(['logout']);
  });

  it('a session that ended without a logout (the resume failed; a new login from the Disconnected screen): stopped at entry, said in chat, once', () => {
    enter(FIRST, false);
    api.routine.start(hunt(), 'player');
    run(api, host, 1000);
    world.left('disconnected');
    // Same character or another: a fresh login either way.
    enter(SECOND, false);
    expect(api.routine.status().running).toBe(false);
    expect(reports.some((t) => /Stopped "Dungeon loop".*macro starts off at each login/.test(t))).toBe(true);
    // The stop is in the new session's summary, even with nothing else used in it.
    world.left('logout');
    expect(byOutcome(events, 'automation_summary').at(-1)).toMatchObject({ running: false, starts: { player: 0 }, stops: { logout: 1 } });
    // A resume that came back as someone else is no resume of this run either.
    enter(SECOND, false);
    api.routine.start(hunt(), 'player');
    world.left('disconnected');
    enter(FIRST, true);
    expect(api.routine.status().running).toBe(false);
    expect(byOutcome(events, 'routine_stopped').map((e) => e.reason)).toEqual(['logout', 'logout']);
  });

  it('a run started before any character was in the world (the agent API at character select) is the first entry\'s', () => {
    // Character select after an earlier login: the page still knows that character, the screen says where we are.
    enter(SECOND, false);
    api.routine.loggedOut();
    host.screenName = 'character-select';
    api.routine.start(hunt(), 'agent');
    host.me.guid = FIRST;
    host.screenName = 'world';
    api.routine.enteredWorld(FIRST, false);
    expect(api.routine.status()).toMatchObject({ running: true, nav: { route: 'loop' } });
    // ...and then belongs to it: a resume keeps it, a new login stops it.
    api.routine.enteredWorld(FIRST, true);
    expect(api.routine.status().running).toBe(true);
    api.routine.enteredWorld(SECOND, false);
    expect(api.routine.status().running).toBe(false);
  });

  it('the next character starts from its own profile, and the logout stop leaves the stored profiles untouched', () => {
    // The VirindiTank window picks `status().profile ?? startingProfile(doc, character)` as it loads for a character
    // (VTankWindow.load). With the first character's run still going, the next one was shown (and ran) its profile.
    const doc: RoutineDoc = { ...emptyRoutineDoc('harvestgain', 'acct'), profiles: [hunt(), { ...hunt(), name: 'Town loop' }], characters: { Second: 'Town loop' } };
    const stored = JSON.stringify(doc);
    enter(FIRST, false);
    api.routine.start(doc.profiles[0], 'player');
    run(api, host, 1000);
    logOut();
    enter(SECOND, false);
    expect(api.routine.status().profile ?? startingProfile(doc, 'Second')).toBe('Town loop');
    expect(JSON.stringify(doc)).toBe(stored);
  });
});
