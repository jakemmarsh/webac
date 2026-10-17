/**
 * OBS.automation-usage — whether players use the in-game automation: the
 * page's AutomationReporter (telemetry/AutomationReporter.ts) → POST
 * /client-preworld → one `client_automation` line (services/ws-tcp-bridge/
 * src/clientAutomation.ts).
 *
 * Drives the real reporter from the real RoutineEngine (a FakeHost under the
 * real AgentApi, as verify-agent-routine-engine.ts does) and the real
 * WorldReporter's session start / end, checks each payload against the
 * bridge's sanitizer (a real payload passes whole), covers the per-page caps,
 * the sanitizer's rejection of unknown tokens and injected text, and the
 * bridge route. The era / server ids come from the same closures in every
 * era; each era's id is pinned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import {
  AutomationReporter, MAX_AUTOMATION_EVENTS, MAX_ROUTINE_EVENTS, importKind, routineKind,
  type AutomationEvent, type AutomationSummaryEvent,
} from '../packages/renderer/src/telemetry/AutomationReporter.ts';
import { WorldReporter } from '../packages/renderer/src/telemetry/WorldReporter.ts';
import { ALL_MODULES_OFF, EXAMPLE_HUNT_PROFILE, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { sanitizeClientAutomation, isAutomationOutcome } from '../services/ws-tcp-bridge/src/clientAutomation.ts';
import { CLIENT_PREWORLD_MAX_BODY } from '../services/ws-tcp-bridge/src/clientPreworld.ts';
import { resolveBridgeConfig, type BridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil.ts';
import { createBridgeServer } from '../services/ws-tcp-bridge/src/server.ts';
import { renderPrometheus } from '../services/ws-tcp-bridge/src/metrics.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const profile = (over: Partial<RoutineProfile> = {}): RoutineProfile => ({
  name: 'Secret Hunt Of Bob', modules: { ...ALL_MODULES_OFF, combat: true },
  initialState: 'Hunt', loot: [], buffSets: [], routes: [],
  states: [{ name: 'Hunt', rules: [] }],
  ...over,
});

interface Rig {
  r: AutomationReporter;
  world: WorldReporter;
  events: AutomationEvent[];
  clock: { t: number };
}

function rig(era = 'eor', server: string | null = 'coldeve', endpoint: string | null = 'http://x/client-preworld'): Rig {
  const events: AutomationEvent[] = [];
  const clock = { t: 1000 };
  const r = new AutomationReporter({
    endpoint, build: 'abc1234', trace: 'feedc0de12345678', era: () => era, server: () => server,
    now: () => clock.t, send: (_u, b) => { events.push(JSON.parse(b) as AutomationEvent); },
  });
  // main.ts's wiring: the world reporter's sessions are the automation reporter's.
  const world = new WorldReporter({ endpoint: null, build: 'abc1234', trace: 'feedc0de12345678', era: () => era, server: () => server, now: () => clock.t });
  world.onSessionStart(() => r.enteredWorld());
  world.onSessionEnd((exit) => r.worldLeft(exit));
  return { r, world, events, clock };
}

const byOutcome = <T extends AutomationEvent['outcome']>(evs: AutomationEvent[], o: T) => evs.filter((e) => e.outcome === o) as Array<Extract<AutomationEvent, { outcome: T }>>;

describe('AutomationReporter — the offer', () => {
  it('reports the bridge\'s answer once per distinct answer, with era and server', () => {
    const g = rig('ac1999', 'local-ac1999');
    g.r.automationAccess(true);
    g.r.previewAccess(true);
    // A relog asks again: the same answer sends nothing.
    g.r.automationAccess(true);
    g.r.previewAccess(true);
    expect(g.events).toEqual([{ outcome: 'automation_offered', era: 'ac1999', server: 'local-ac1999', trace: 'feedc0de12345678', build: 'abc1234', automation: true, preview: true, eid: expect.any(String) }]);
    // Another account on the same page (logged out, in again) without the automation: reported.
    g.r.automationAccess(false);
    g.r.previewAccess(false);
    expect(byOutcome(g.events, 'automation_offered').map((e) => [e.automation, e.preview])).toEqual([[true, true], [false, false]]);
  });

  it('no endpoint (no bridge), no events', () => {
    const g = rig('eor', null, null);
    g.r.automationAccess(true);
    g.r.previewAccess(true);
    expect(g.events).toEqual([]);
  });
});

describe('AutomationReporter — runs from the real RoutineEngine', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => { vi.useFakeTimers(); host = new FakeHost(); api = new AgentApi(host); });
  afterEach(() => vi.useRealTimers());

  it('start, a failing action (once per run), the player\'s stop with the run\'s length; no names leave the page', async () => {
    const g = rig();
    api.routine.onLifecycle = (e) => g.r.routine(e);
    g.world.enteredWorld();
    // A rule whose action throws every pass: the run notes each failure; one routine_error goes out.
    api.say = () => { throw new Error('Bob typed this'); };
    api.routine.start(profile({ states: [{ name: 'Hunt', rules: [{ label: 'Talk', when: [{ kind: 'always' }], do: [{ kind: 'say', text: 'hello from Bob' }] }] }] }), 'player');
    for (let i = 0; i < 4; i++) { run(api, host, 600); await vi.advanceTimersByTimeAsync(0); }
    g.clock.t += 90_000;
    api.routine.stop('stopped', 'player');
    const started = byOutcome(g.events, 'routine_started');
    const errors = byOutcome(g.events, 'routine_error');
    const stopped = byOutcome(g.events, 'routine_stopped');
    expect(started).toEqual([expect.objectContaining({ kind: 'rules', driver: 'player', nav: false, loot: false, example: false })]);
    expect(errors).toEqual([expect.objectContaining({ kind: 'rules', driver: 'player', where: 'rule' })]);
    expect(stopped).toEqual([expect.objectContaining({ kind: 'rules', driver: 'player', reason: 'player', runMs: 90_000 })]);
    expect(stopped[0].errors).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(g.events)).not.toMatch(/Bob|hello|Secret|Talk/);
    // The run's log still has the failure for the player and the agent.
    expect(api.routine.status().last.join('\n')).toContain('error: Bob typed this');
    // Every payload passes the bridge whole.
    for (const ev of g.events) expect(sanitizeClientAutomation(ev)).toEqual(ev);
  });

  it('stop reasons: died (StopMacroOnDeath), its own Stop rule, another start, the agent API\'s stop', async () => {
    const g = rig();
    api.routine.onLifecycle = (e) => g.r.routine(e);
    g.world.enteredWorld();
    // Died: VTank's StopMacroOnDeath (on by default).
    api.routine.start(profile({ macro: true }));
    host.me.dead = true;
    run(api, host, 600);
    host.me.dead = false;
    // Its own rule.
    api.routine.start(profile({ ruleFiring: 'once', states: [{ name: 'Hunt', rules: [{ label: 'Done', when: [{ kind: 'always' }], do: [{ kind: 'stop' }] }] }] }));
    run(api, host, 600); await vi.advanceTimersByTimeAsync(0);
    // Replaced, then the agent's stop.
    api.routine.start(structuredClone(EXAMPLE_HUNT_PROFILE));
    api.routine.start(profile());
    api.routine.stop('stopped', 'agent');
    expect(byOutcome(g.events, 'routine_stopped').map((e) => [e.kind, e.driver, e.reason])).toEqual([
      ['macro', 'agent', 'died'], ['meta', 'agent', 'rule'], ['rules', 'agent', 'replaced'], ['rules', 'agent', 'agent'],
    ]);
    expect(byOutcome(g.events, 'routine_started').map((e) => [e.kind, e.example, e.nav, e.loot])).toEqual([
      ['macro', false, false, false], ['meta', false, false, false], ['rules', true, true, true], ['rules', false, false, false],
    ]);
  });
});

describe('AutomationReporter — rate limits', () => {
  it('a meta that stops and restarts all evening: at most MAX_ROUTINE_EVENTS run events, the summary still counts every run', () => {
    const g = rig();
    g.world.enteredWorld();
    for (let i = 0; i < 50; i++) {
      g.r.routine({ type: 'start', profile: profile({ ruleFiring: 'once' }), driver: 'player' });
      g.r.routine({ type: 'error', where: 'macro' });
      g.r.routine({ type: 'error', where: 'macro' });
      g.clock.t += 60_000;
      g.r.routine({ type: 'stop', reason: 'rule' });
    }
    const runEvents = g.events.filter((e) => e.outcome !== 'automation_summary' && e.outcome !== 'automation_offered');
    expect(runEvents).toHaveLength(MAX_ROUTINE_EVENTS);
    g.world.left('logout');
    const [sum] = byOutcome(g.events, 'automation_summary');
    expect(sum).toMatchObject({ exit: 'logout', starts: { player: 50, agent: 0 }, stops: { rule: 50, player: 0 }, kinds: ['meta'], runMs: 50 * 60_000, running: false, errors: 100 });
  });

  it('the page never sends more than MAX_AUTOMATION_EVENTS in all', () => {
    const g = rig();
    for (let i = 0; i < 40; i++) {
      g.r.automationAccess(i % 2 === 0);
      g.r.previewAccess(true);
      g.world.enteredWorld();
      g.r.windowOpened('vtank');
      g.world.left('logout');
    }
    expect(g.events).toHaveLength(MAX_AUTOMATION_EVENTS);
  });

  it('unknown tokens from the page\'s own callers are mapped or refused, never sent', () => {
    const g = rig();
    g.world.enteredWorld();
    g.r.windowOpened('Bob\'s secret window');
    g.r.barClicked('<script>', true);
    g.r.imported('maybe' as never, ['x.met']);
    g.r.imported('ok', ['C:\\Users\\Bob\\hunt.met', 'Bob.utl', 'notes.txt']);
    g.r.routine({ type: 'start', profile: profile(), driver: 'claude' as never });
    g.r.routine({ type: 'error', where: 'kernel' as never });
    g.r.routine({ type: 'stop', reason: 'because Bob said so' as never });
    g.world.left('closed_tab');
    const run = byOutcome(g.events, 'routine_stopped')[0];
    expect(byOutcome(g.events, 'routine_started')[0].driver).toBe('agent');
    expect(byOutcome(g.events, 'routine_error')).toEqual([]);
    expect(run.reason).toBe('agent');
    const [sum] = byOutcome(g.events, 'automation_summary');
    expect(sum).toMatchObject({ windows: ['other'], barClicks: 1, imports: { ok: 1, partial: 0, failed: 0 }, importKinds: ['met', 'utl', 'other'] });
    expect(JSON.stringify(g.events)).not.toMatch(/Bob|script|claude|kernel|notes/);
  });
});

describe('AutomationReporter — the session summary', () => {
  it('the bar, the windows opened, a run still going and its time, imports; sent when the world session ends', () => {
    const g = rig('dm', 'harvestgain');
    g.r.automationAccess(true);
    g.r.previewAccess(true);
    // Imported at character select: counted in the session that follows.
    g.r.imported('partial', ['hunt.met', 'loop.nav']);
    g.world.enteredWorld();
    const enteredAt = g.clock.t;
    g.r.barOnScreen();
    g.r.barClicked('vtank', true);
    g.r.windowOpened('vtank');
    g.r.barClicked('vtank', false);
    g.r.barClicked('ub-dungeon', true);
    g.r.windowOpened('hotkeys');
    g.r.barToggled();
    g.clock.t += 5_000;
    g.r.routine({ type: 'start', profile: profile({ macro: true, navRoute: 'loop', routes: [{ name: 'loop', mode: 'circular', points: [] }] }), driver: 'player' });
    g.clock.t += 600_000;
    g.world.left('disconnected', { endCause: 'socket_closed' });
    const [sum] = byOutcome(g.events, 'automation_summary');
    expect(sum).toEqual({
      outcome: 'automation_summary', era: 'dm', server: 'harvestgain', trace: 'feedc0de12345678', build: 'abc1234', eid: expect.any(String),
      exit: 'disconnected', sessionMs: g.clock.t - enteredAt, offered: true, preview: true,
      barShown: true, barToggles: 1, barClicks: 3, windows: ['vtank', 'hotkeys', 'ub-dungeon'],
      starts: { player: 1, agent: 0 }, stops: { player: 0, agent: 0, died: 0, rule: 0, replaced: 0 }, kinds: ['macro'],
      runMs: 600_000, running: true, errors: 0,
      imports: { ok: 0, partial: 1, failed: 0 }, importKinds: ['met', 'nav'],
    } satisfies AutomationSummaryEvent & { eid: string });
    expect(sanitizeClientAutomation(sum)).toEqual(sum);
    expect(JSON.stringify(sum).length).toBeLessThan(CLIENT_PREWORLD_MAX_BODY);
    // The resume after the drop: the run carries on; its time counts from the new session.
    g.world.enteredWorld(true);
    g.clock.t += 30_000;
    g.r.routine({ type: 'stop', reason: 'player' });
    g.world.left('logout');
    const sums = byOutcome(g.events, 'automation_summary');
    expect(sums[1]).toMatchObject({ exit: 'logout', kinds: ['macro'], runMs: 30_000, running: false, starts: { player: 0, agent: 0 }, stops: { player: 1 }, windows: [], imports: { ok: 0, partial: 0, failed: 0 } });
    expect(byOutcome(g.events, 'routine_stopped')[0]).toMatchObject({ runMs: 630_000, reason: 'player', driver: 'player', kind: 'macro' });
  });

  it('a session that used nothing sends no summary (the offer alone says who could have)', () => {
    const g = rig();
    g.r.automationAccess(true);
    g.r.previewAccess(true);
    g.world.enteredWorld();
    g.r.barOnScreen();
    g.clock.t += 3_600_000;
    g.world.left('closed_tab');
    expect(g.events.map((e) => e.outcome)).toEqual(['automation_offered']);
  });

  it('the same payload shape in every era: only the era id differs', () => {
    for (const era of ['eor', 'dm', 'ac1999']) {
      const g = rig(era);
      g.world.enteredWorld();
      g.r.windowOpened(era === 'ac1999' ? 'splitpea' : 'magtools');
      g.world.left('logout');
      const [sum] = byOutcome(g.events, 'automation_summary');
      expect(sum.era).toBe(era);
      expect(sum.windows).toEqual([era === 'ac1999' ? 'splitpea' : 'magtools']);
      expect(sanitizeClientAutomation(sum)).toEqual(sum);
    }
  });

  it('helpers: a profile\'s kind and a file\'s import kind', () => {
    expect(routineKind({ macro: true, ruleFiring: 'once' })).toBe('macro');
    expect(routineKind({ ruleFiring: 'once' })).toBe('meta');
    expect(routineKind({})).toBe('rules');
    expect(['a.MET', 'b.nav', 'c.utl', 'd.usd', 'e.af', 'f.txt', 'noext'].map(importKind)).toEqual(['met', 'nav', 'utl', 'usd', 'af', 'other', 'other']);
  });
});

describe('sanitizeClientAutomation', () => {
  it('re-checks every field: unknown outcome or a non-object is refused; unknown tokens null, injected text dropped, numbers bounded', () => {
    expect(sanitizeClientAutomation({ outcome: 'world_left' })).toBeNull();
    expect(sanitizeClientAutomation([{ outcome: 'routine_started' }])).toBeNull();
    expect(sanitizeClientAutomation('routine_started')).toBeNull();
    expect(isAutomationOutcome('automation_summary')).toBe(true);
    expect(isAutomationOutcome('first_minute')).toBe(false);
    const started = sanitizeClientAutomation({
      outcome: 'routine_started', era: 'eor\nFAKE log line', server: 'a b', trace: 'NOTHEX!', build: '<script>', kind: 'vtank; rm -rf', driver: 'Bob',
      nav: 'yes', loot: 1, example: true, profile: 'Bob\'s secret', name: 'Bob', eid: 'x',
    })!;
    expect(started).toEqual({ outcome: 'routine_started', era: null, server: null, trace: null, build: null, kind: null, driver: null, nav: null, loot: null, example: true });
    const stopped = sanitizeClientAutomation({ outcome: 'routine_stopped', kind: 'meta', driver: 'player', reason: 'Bob quit', runMs: -5, errors: 1.5 })!;
    expect(stopped).toMatchObject({ reason: null, runMs: null, errors: null, kind: 'meta', driver: 'player' });
    expect(sanitizeClientAutomation({ outcome: 'routine_stopped', runMs: 8 * 24 * 3600_000 })).toMatchObject({ runMs: null });
    expect(sanitizeClientAutomation({ outcome: 'routine_error', where: 'Bob\'s rule' })).toMatchObject({ where: null });
    const sum = sanitizeClientAutomation({
      outcome: 'automation_summary', exit: 'hidden', sessionMs: 1000, offered: 'true', barShown: true, barClicks: 1e9,
      windows: ['vtank', 'Bob\'s window', 'vtank', '<img>'], kinds: 'macro', importKinds: ['met', 'exe'],
      starts: { player: 2, agent: 'many', bob: 7 }, stops: { died: 1, evil: 9 }, imports: ['ok'],
    })!;
    expect(sum).toMatchObject({
      exit: null, sessionMs: 1000, offered: null, barShown: true, barClicks: null,
      windows: ['vtank'], kinds: null, importKinds: ['met'],
      starts: { player: 2, agent: 0 }, stops: { player: 0, agent: 0, died: 1, rule: 0, replaced: 0 }, imports: null,
    });
    expect(JSON.stringify(sum)).not.toMatch(/Bob|img|evil|exe/);
    expect(Object.keys((sum as { starts: object }).starts)).toEqual(['player', 'agent']);
  });
});

describe('POST /client-preworld with an automation event', () => {
  function baseConfig(): BridgeConfig {
    const c = resolveBridgeConfig([], { BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none' });
    c.wsPort = 0;
    return c;
  }

  it('logs one client_automation line (nulls left out), counts it, drops a resend, refuses junk and floods on its own budget', async () => {
    const logs: Array<[string, string, Record<string, unknown>]> = [];
    const bridge = createBridgeServer(baseConfig(), { log: (level, event, fields) => { logs.push([level, event, fields ?? {}]); } });
    const port = await bridge.listen();
    try {
      const post = (body: string) => fetch(`http://127.0.0.1:${port}/client-preworld`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body });
      const g = rig();
      g.world.enteredWorld();
      g.r.windowOpened('vtank');
      g.r.routine({ type: 'start', profile: profile(), driver: 'player' });
      g.world.left('logout');
      const [startEv, summary] = g.events;
      expect((await post(JSON.stringify(startEv))).status).toBe(204);
      expect((await post(JSON.stringify(summary))).status).toBe(204);
      // The outbox's resend of the same event (same eid) is logged once.
      expect((await post(JSON.stringify(summary))).status).toBe(204);
      const lines = logs.filter((l) => l[1] === 'client_automation');
      expect(lines).toHaveLength(2);
      const { ip, ...fields } = lines[1][2];
      expect(ip).toEqual(expect.any(String));
      expect(lines[1][0]).toBe('info');
      expect(fields).toEqual(Object.fromEntries(Object.entries(summary).filter(([, v]) => v !== null)));
      expect(fields).not.toHaveProperty('offered'); // never asked (a dev page): left out, as client_world's nulls are
      expect(logs.some((l) => l[1] === 'client_preworld' || l[1] === 'client_world')).toBe(false);
      expect(bridge.metrics.clientAutomation.get('automation_summary')).toBe(1);
      expect(renderPrometheus(bridge.metrics, { mode: 'pinned', era: null, sessions: 0, perServer: [], serversList: null, uptimeSeconds: 0, draining: false }))
        .toContain('acbridge_client_automation_total{outcome="routine_started"} 1');
      // A field the page invented never reaches the log.
      expect((await post(JSON.stringify({ outcome: 'routine_error', where: 'rule', note: 'Bob\'s profile' }))).status).toBe(204);
      expect(JSON.stringify(logs.at(-1))).not.toContain('Bob');
      // Flood: automation's own budget (40 / 10 min) runs out; the pre-world events' budget is untouched.
      let refused = 0;
      for (let i = 0; i < 45; i++) if ((await post(JSON.stringify({ outcome: 'routine_error', where: 'loot' }))).status === 429) refused++;
      expect(refused).toBeGreaterThan(0);
      expect((await post(JSON.stringify({ outcome: 'enter_ok', era: 'eor' }))).status).toBe(204);
      expect(logs.some((l) => l[1] === 'client_preworld')).toBe(true);
    } finally {
      await bridge.shutdown();
    }
  });
});
