/**
 * PERF.slow-first-minute-diagnostics, second pass (2026-10-20). Production, build ac62d477: a Windows
 * RX 7900 XTX machine at Yaraq ran 294 ms frames with frameStep's own JS at 117 ms and 34.6 s of long
 * tasks in the minute, so ~22 s of main thread ran OUTSIDE frameStep, and nothing said where. The
 * first_minute event now carries frameStep's time by phase, the server-message and streamed-DAT
 * handler time with the longest call's op, the longest long task, the renderer's programs (live and
 * created in the minute, with the render time of the frames that created them), geometries,
 * textures, the scene's object count and the live server objects; the bridge keeps them, bounded.
 *
 * Drives the real WorldReporter, MainThreadCost meters, the streaming rebuild / retry paths and the
 * bridge sanitizer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WorldReporter, MAX_PHASE_KEYS, type WorldEvent, type FirstMinuteEvent } from '../packages/renderer/src/telemetry/WorldReporter';
import {
  FRAME_PHASES, PHASE, FramePhaseTimer, HandlerMeter, ProgramCreationCounter, connectionEventOp, opToken, streamHandlerCost, timedAgentTick,
} from '../packages/renderer/src/telemetry/MainThreadCost';
import { rebuildOnArrival } from '../packages/renderer/src/dat/streaming/StreamingDats';
import { runRetryingOnArrival } from '../packages/renderer/src/dat/streaming/RetryOnArrival';
import { sanitizeClientWorld, FRAME_PHASES as BRIDGE_PHASES } from '../services/ws-tcp-bridge/src/clientWorld';
import { CLIENT_PREWORLD_MAX_BODY } from '../services/ws-tcp-bridge/src/clientPreworld';

function rig() {
  const events: WorldEvent[] = [];
  const clock = { t: 1000 };
  const r = new WorldReporter({
    endpoint: 'http://x/client-preworld', build: 'abc1234', trace: 'feedc0de12345678', era: () => 'eor', server: () => 'levistras',
    now: () => clock.t, send: (_u, b) => { events.push(JSON.parse(b) as WorldEvent); },
  });
  const net = new HandlerMeter(() => clock.t);
  const stream = new HandlerMeter(() => clock.t);
  r.setHandlerMeters(net, stream);
  const programs = { created: 40 };
  r.setSources({
    screen: () => 'world',
    programsCreated: () => programs.created,
    rendererState: () => ({ programs: 61, geometries: 1800, textures: 950 }),
    sceneObjects: () => 23_456,
    serverObjects: () => 312,
  });
  r.setGpu('discrete', 'ANGLE (AMD, AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0, D3D11)');
  return { r, events, clock, net, stream, programs };
}

const first = (events: WorldEvent[]) => events.find((e) => e.outcome === 'first_minute') as FirstMinuteEvent;

/** A phase array with `ms` for the named phases, 0 elsewhere. */
function phases(ms: Partial<Record<typeof FRAME_PHASES[number], number>>): Float64Array {
  const a = new Float64Array(FRAME_PHASES.length);
  for (const [k, v] of Object.entries(ms)) a[PHASE[k as typeof FRAME_PHASES[number]]] = v!;
  return a;
}

describe('FramePhaseTimer — frameStep split at its phase boundaries', () => {
  it('each mark takes the time since the previous one; a phase marked twice adds up; begin clears', () => {
    const clock = { t: 0 };
    const ph = new FramePhaseTimer(() => clock.t);
    ph.begin(100);
    clock.t = 103; ph.mark(PHASE.tags);
    clock.t = 110; ph.mark(PHASE.anim);
    clock.t = 150; ph.mark(PHASE.sweep);
    clock.t = 152; ph.mark(PHASE.anim);
    clock.t = 232; ph.mark(PHASE.render);
    expect(ph.frameMs[PHASE.tags]).toBe(3);
    expect(ph.frameMs[PHASE.anim]).toBe(9);
    expect(ph.frameMs[PHASE.sweep]).toBe(40);
    expect(ph.frameMs[PHASE.render]).toBe(80);
    ph.begin(300);
    expect([...ph.frameMs].every((v) => v === 0)).toBe(true);
  });
});

describe('WorldReporter — where the first minute went', () => {
  it('phaseMs: the mean per measured frame, largest first, at most ten keys, 0.1 ms, empty phases left out', () => {
    const { r, events, clock } = rig();
    r.enteredWorld();
    for (let i = 0; i < 120; i++) {
      clock.t += 300;
      // every phase but 'sync' has time; physics alternates 2.2 / 0 (a 1.1 mean)
      r.frame(clock.t, true, 117, phases({
        tags: 0.2, physics: i % 2 ? 2.2 : 0, sweep: 0.3, anim: 12, camera: 0.4, fx: 3, stream: 9, hud: 5, lod: 1.5, warmup: 0.5, render: 80,
      }));
      if (i % 3 === 0) r.tick();
    }
    clock.t += 30_000; r.tick();
    const ev = first(events);
    expect(Object.keys(ev.phaseMs!)).toHaveLength(MAX_PHASE_KEYS);
    expect(Object.keys(ev.phaseMs!)).toEqual(['render', 'anim', 'stream', 'hud', 'fx', 'lod', 'physics', 'warmup', 'camera', 'sweep']);
    expect(ev.phaseMs).toMatchObject({ render: 80, anim: 12, stream: 9, physics: 1.1, lod: 1.5 });
    expect(ev.phaseMs).not.toHaveProperty('sync');   // no time: not sent
    expect(ev.phaseMs).not.toHaveProperty('tags');   // the 11th largest: cut
  });

  it('a page without phase timing (an older frame call) sends phaseMs and compileMs null', () => {
    const { r, events, clock } = rig();
    r.enteredWorld();
    for (let i = 0; i < 70; i++) { clock.t += 1000; r.frame(clock.t, true, 5); r.tick(); }
    const ev = first(events);
    expect(ev.phaseMs).toBeNull();
    expect(ev.compileMs).toBeNull();
  });

  it('handler time outside frameStep: totals, the longest call and its op; reset at each world entry', () => {
    const { r, events, clock, net, stream } = rig();
    net.time('objectCreate', () => { clock.t += 900; });          // before this entry: not counted
    r.enteredWorld();
    net.time('objectCreate', () => { clock.t += 40; });
    net.time(() => connectionEventOp({ type: 'message', data: { type: 'direct', opcode: 0xF745 } }), () => { clock.t += 350; });
    net.time('gameEvent', () => { clock.t += 10; });
    stream.time('bundle', () => { clock.t += 120; });
    stream.time('rebuild', () => { clock.t += 30; });
    r.longTask(0); // not supported here: longTaskMaxMs stays null
    for (let i = 0; i < 70; i++) { clock.t += 1000; r.frame(clock.t, true, 5); r.tick(); }
    const ev = first(events);
    expect(ev.netHandlerMs).toBe(400);
    expect(ev.streamHandlerMs).toBe(150);
    expect(ev.longestHandlerMs).toBe(350);
    expect(ev.longestHandlerOp).toBe('m:f745');
    expect(ev.longTaskMaxMs).toBeNull();
  });

  it('a streamed-DAT landing that is the longest call is named with an s: prefix', () => {
    const { r, events, clock, net, stream } = rig();
    r.enteredWorld();
    net.time('objectCreate', () => { clock.t += 40; });
    stream.time('pack_world', () => { clock.t += 700; });
    for (let i = 0; i < 70; i++) { clock.t += 1000; r.frame(clock.t, true, 5); r.tick(); }
    expect(first(events)).toMatchObject({ longestHandlerMs: 700, longestHandlerOp: 's:pack_world' });
  });

  it('the longest long task, inside the first minute only', () => {
    const { r, events, clock } = rig();
    (r as unknown as { longTasksSupported: boolean }).longTasksSupported = true;
    r.enteredWorld();
    r.longTask(120); r.longTask(2400); r.longTask(80);
    for (let i = 0; i < 70; i++) { clock.t += 1000; r.frame(clock.t, true, 5); r.tick(); }
    r.longTask(9000); // after the event
    expect(first(events)).toMatchObject({ longTaskMs: 2600, longTaskMaxMs: 2400 });
  });

  it('programs created in the minute, and compileMs = render + warmup of the frames that created them', () => {
    const { r, events, clock, programs } = rig();
    r.enteredWorld();                                // 40 programs existed before the world
    for (let i = 0; i < 100; i++) {
      clock.t += 300;
      if (i === 10 || i === 50) programs.created += 3; // a material rebuilt its program twice
      const compile = i === 10 || i === 50;
      r.frame(clock.t, true, 100, phases({ render: compile ? 400 : 60, warmup: compile ? 25 : 1, anim: 5 }));
      if (i % 3 === 0) r.tick();
    }
    clock.t += 40_000; r.tick();
    const ev = first(events);
    expect(ev.programsCreated).toBe(6);
    expect(ev.compileMs).toBe(850);
    expect(ev).toMatchObject({ programs: 61, geometries: 1800, textures: 950, sceneObjects: 23_456, serverObjects: 312 });
  });

  it('with no renderer or object sources the fields read null, not zero', () => {
    const events: WorldEvent[] = [];
    const clock = { t: 0 };
    const r = new WorldReporter({
      endpoint: 'http://x/client-preworld', build: 'b', trace: 'feedc0de12345678', era: () => 'eor', server: () => null,
      now: () => clock.t, send: (_u, b) => { events.push(JSON.parse(b) as WorldEvent); },
    });
    r.enteredWorld();
    for (let i = 0; i < 70; i++) { clock.t += 1000; r.frame(clock.t, true, 5, phases({ render: 3 })); r.tick(); }
    const ev = first(events);
    expect(ev).toMatchObject({
      netHandlerMs: null, streamHandlerMs: null, longestHandlerMs: null, longestHandlerOp: null,
      programs: null, geometries: null, textures: null, programsCreated: null, compileMs: null, sceneObjects: null, serverObjects: null,
    });
    expect(ev.phaseMs).toEqual({ render: 3 });
  });
});

describe('MainThreadCost meters', () => {
  it('a timed call inside another counts only in the outer one; a throwing handler still counts', () => {
    const clock = { t: 0 };
    const a = new HandlerMeter(() => clock.t);
    const b = new HandlerMeter(() => clock.t);
    a.time('outer', () => { clock.t += 5; b.time('inner', () => { clock.t += 20; }); clock.t += 5; });
    expect(a.totalMs).toBe(30);
    expect(b.totalMs).toBe(0);
    expect(() => a.time('boom', () => { clock.t += 7; throw new Error('x'); })).toThrow('x');
    expect(a.totalMs).toBe(37);
    b.time('after', () => { clock.t += 2; }); // the depth came back down
    expect(b.totalMs).toBe(2);
  });

  it('op tokens: a message by opcode, a game event by its type, others by event type; free text is cut down', () => {
    expect(connectionEventOp({ type: 'message', data: { type: 'direct', opcode: 0xF748 } })).toBe('m:f748');
    expect(connectionEventOp({ type: 'gameEvent', data: { type: 'event', opcode: 0xF7B0, eventType: 0x13 } })).toBe('ge:13');
    expect(connectionEventOp({ type: 'objectCreate', data: {} })).toBe('objectCreate');
    expect(opToken('a b/c<script>'.repeat(5))).toMatch(/^[A-Za-z0-9:_]{1,24}$/);
    expect(opToken('***')).toBe('other');
  });

  it('ProgramCreationCounter counts pushes onto three.js\'s program list and re-hooks a new list (context restore)', () => {
    const c = new ProgramCreationCounter();
    const info = { programs: [{}, {}] as unknown[] };
    expect(c.sample(info)).toBe(0);                 // programs from before the hook are not "created"
    info.programs.push({});                          // WebGLPrograms.acquireProgram: a new program
    expect(c.sample(info)).toBe(1);
    expect(info.programs).toHaveLength(3);
    info.programs.pop();                             // releaseProgram: the count is creations, not live
    expect(c.sample(info)).toBe(1);
    info.programs = [];                              // initGLContext after a restore: a new list
    c.sample(info);
    info.programs.push({}, {});
    expect(c.sample(info)).toBe(3);
    expect(c.sample(null)).toBe(3);
  });

  it('streamed-DAT rebuilds on arrival and arrival retries are timed in streamHandlerCost', async () => {
    streamHandlerCost.reset();
    const busy = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } };
    const store = {
      ensure: () => Promise.resolve(),
      scoped: <T>(fn: () => T) => ({ result: fn(), scope: { missed: false, keys: [] as number[] } }),
    };
    const closure = { ensure: () => Promise.resolve() };
    await rebuildOnArrival(store as never, closure as never, { missed: true, keys: [] } as never, () => busy(15));
    expect(streamHandlerCost.calls).toBe(1);
    expect(streamHandlerCost.totalMs).toBeGreaterThanOrEqual(14);
    expect(streamHandlerCost.longestOp).toBe('rebuild');

    let runs = 0;
    const missingOnce = {
      ensure: () => Promise.resolve(),
      scoped: <T>(fn: () => T) => ({ result: fn(), scope: { missed: runs === 1, keys: [] as number[] } }),
    };
    runRetryingOnArrival(missingOnce, () => { runs++; if (runs === 2) busy(25); });
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(2);
    expect(streamHandlerCost.calls).toBe(2);         // the first run is the caller's; the retry is a landing
    expect(streamHandlerCost.longestOp).toBe('retry');
    streamHandlerCost.reset();
  });
});

describe('PERF.agent-tick-cost — the frame top split so a report names the automation subsystem', () => {
  // Two field reports (2026-10-21) said only "tags": 56 and 86 ms a frame, all of it the agent tick of routine users.
  it('timedAgentTick marks the agent API, the routine inside it, UtilityBelt and Mag-Tools into their own phases', () => {
    const clock = { t: 0 };
    const ph = new FramePhaseTimer(() => clock.t);
    ph.begin(0);
    clock.t = 1; ph.mark(PHASE.nav);
    clock.t = 3; ph.mark(PHASE.tags);
    const agent = { tick(m?: { routineStart(): void; routineEnd(): void }) { clock.t += 2; m?.routineStart(); clock.t += 40; m?.routineEnd(); clock.t += 5; } };
    const ub = { tick() { clock.t += 7; } };
    const mag = { tick() { clock.t += 11; } };
    timedAgentTick({ agent, ub, ubOn: true, mag }, (p) => ph.mark(p));
    expect(ph.frameMs[PHASE.nav]).toBe(1);
    expect(ph.frameMs[PHASE.tags]).toBe(2);
    expect(ph.frameMs[PHASE.agent]).toBe(7);
    expect(ph.frameMs[PHASE.routine]).toBe(40);
    expect(ph.frameMs[PHASE.ub]).toBe(7);
    expect(ph.frameMs[PHASE.mag]).toBe(11);
    // UtilityBelt runs only where /ub does: none of its time, and Mag-Tools' still its own.
    ph.begin(clock.t);
    let ubRan = false;
    timedAgentTick({ agent, ub: { tick() { ubRan = true; } }, ubOn: false, mag: null }, (p) => ph.mark(p));
    expect(ubRan).toBe(false);
    expect(ph.frameMs[PHASE.routine]).toBe(40);
    expect(ph.frameMs[PHASE.ub]).toBe(0);
    expect(ph.frameMs[PHASE.mag]).toBe(0);
  });

  it('the report sends the new keys among its ten largest, and the bridge keeps them (old keys still accepted)', () => {
    const { r, events, clock } = rig();
    r.enteredWorld();
    for (let i = 0; i < 100; i++) {
      clock.t += 145;
      r.frame(clock.t, true, 60, phases({ nav: 0.2, tags: 0.3, agent: 3, routine: 52, ub: 0.4, mag: 0.6, render: 1.5, warmup: 0.8, physics: 0.1, anim: 0.2, hud: 0.25 }));
      if (i % 3 === 0) r.tick();
    }
    clock.t += 50_000; r.tick();
    const ev = first(events);
    expect(Object.keys(ev.phaseMs!).slice(0, 3)).toEqual(['routine', 'agent', 'render']);
    expect(Object.keys(ev.phaseMs!)).toHaveLength(MAX_PHASE_KEYS);
    expect(sanitizeClientWorld(ev)).toEqual(ev);
    // An older page's single "tags" key still passes.
    expect((sanitizeClientWorld({ ...ev, phaseMs: { tags: 56.2, render: 1.5 } }) as FirstMinuteEvent).phaseMs).toEqual({ tags: 56.2, render: 1.5 });
  });
});

describe('the bridge keeps the new fields, bounded', () => {
  function realEvent(): FirstMinuteEvent {
    const { r, events, clock, net, stream, programs } = rig();
    (r as unknown as { longTasksSupported: boolean }).longTasksSupported = true;
    r.enteredWorld();
    net.time('objectCreate', () => { clock.t += 450; });
    stream.time('bundle', () => { clock.t += 30; });
    r.longTask(3100);
    for (let i = 0; i < 100; i++) {
      clock.t += 294;
      if (i === 4) programs.created += 2;
      r.frame(clock.t, true, 117, phases({ tags: 0.4, physics: 4, sweep: 0.2, anim: 15, sync: 0.3, camera: 1, fx: 6, stream: 8, hud: 3, lod: 2, warmup: 1, render: 76 }));
      if (i % 3 === 0) r.tick();
    }
    clock.t += 40_000; r.tick();
    return first(events);
  }

  it('the renderer and the bridge agree on the phase names', () => {
    expect([...BRIDGE_PHASES]).toEqual([...FRAME_PHASES]);
  });

  it('a real event passes the sanitizer whole and fits the body limit at its largest', () => {
    const ev = realEvent();
    expect(ev.phaseMs).toBeTruthy();
    expect(ev.programsCreated).toBe(2);
    expect(sanitizeClientWorld(ev)).toEqual(ev);
    const largest = {
      ...ev, gpuName: 'x'.repeat(96), longestHandlerOp: 'x'.repeat(24), net: undefined,
      phaseMs: Object.fromEntries(FRAME_PHASES.slice(0, 10).map((p) => [p, 4999.9])),
    };
    expect(JSON.stringify(largest).length).toBeLessThan(CLIENT_PREWORLD_MAX_BODY);
  });

  it('out-of-range values are nulled; phaseMs drops unknown keys and bad values and holds at most ten', () => {
    const ev = realEvent() as unknown as Record<string, unknown>;
    const bad = sanitizeClientWorld({
      ...ev, netHandlerMs: -1, streamHandlerMs: 1e9, longestHandlerMs: 1.5, longestHandlerOp: 'drop table;', longTaskMaxMs: '5',
      programs: 1e7, programsCreated: -3, geometries: NaN, textures: 1e12, sceneObjects: 2.5, compileMs: 999_999, serverObjects: 'many',
    })!;
    expect(bad).toMatchObject({
      netHandlerMs: null, streamHandlerMs: null, longestHandlerMs: null, longestHandlerOp: null, longTaskMaxMs: null,
      programs: null, programsCreated: null, geometries: null, textures: null, sceneObjects: null, compileMs: null, serverObjects: null,
    });
    const ph = sanitizeClientWorld({ ...ev, phaseMs: { render: 80.04, evil: 3, anim: -1, hud: 9999, fx: 'x', stream: 2 } }) as FirstMinuteEvent;
    expect(ph.phaseMs).toEqual({ render: 80, stream: 2 });
    const all = Object.fromEntries(FRAME_PHASES.map((p) => [p, 1]));
    expect(Object.keys((sanitizeClientWorld({ ...ev, phaseMs: all }) as FirstMinuteEvent).phaseMs!)).toHaveLength(10);
    expect((sanitizeClientWorld({ ...ev, phaseMs: [1, 2] }) as FirstMinuteEvent).phaseMs).toBeNull();
    expect((sanitizeClientWorld({ ...ev, phaseMs: null }) as FirstMinuteEvent).phaseMs).toBeNull();
  });

  it('an older page that sends none of them gets none added', () => {
    const ev = realEvent() as unknown as Record<string, unknown>;
    const keys = ['phaseMs', 'netHandlerMs', 'streamHandlerMs', 'longestHandlerMs', 'longestHandlerOp', 'longTaskMaxMs',
      'programs', 'programsCreated', 'geometries', 'textures', 'sceneObjects', 'compileMs', 'serverObjects', 'fontSheetBad', 'canvas2dLost'];
    const older = { ...ev };
    for (const k of keys) delete older[k];
    const out = Object.keys(sanitizeClientWorld(older)!);
    for (const k of keys) expect(out).not.toContain(k);
  });
});
