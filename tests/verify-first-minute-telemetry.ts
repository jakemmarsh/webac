/**
 * RELEASE.first-minute — the page reports each world entry's first minute
 * (telemetry/WorldReporter.ts → POST /client-preworld → one `client_world`
 * line, services/ws-tcp-bridge/src/clientWorld.ts), and a longer session's
 * end (world_left).
 *
 * Drives the real reporter with a fake clock and frame source the way
 * main.ts does (enteredWorld at gameStarted, frame() per drawn frame, the
 * 1 s tick, the page's leave events), checks every payload against the
 * bridge's sanitizer (a real payload passes whole), and drives the real
 * bridge route. The era / server ids come from the same closures in every
 * era, so the payload's shape is era-independent; each era's id is pinned.
 */
import { describe, it, expect } from 'vitest';
import {
  WorldReporter, classifyGpu, unmaskedRenderer, FIRST_MINUTE_MS, HIST_MAX_MS, MAX_WORLD_EVENTS,
  type WorldEvent, type FirstMinuteEvent, type WorldLeftEvent, type WorldModal, type WorldScreen,
} from '../packages/renderer/src/telemetry/WorldReporter';
import { ErrorReporter } from '../packages/renderer/src/telemetry/ErrorReporter';
import { sanitizeClientWorld } from '../services/ws-tcp-bridge/src/clientWorld';
import { resolveBridgeConfig, type BridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil';
import { createBridgeServer } from '../services/ws-tcp-bridge/src/server';
import { renderPrometheus } from '../services/ws-tcp-bridge/src/metrics';
import { CLIENT_PREWORLD_MAX_BODY } from '../services/ws-tcp-bridge/src/clientPreworld';

const FIRST_MINUTE_KEYS = [
  'outcome', 'era', 'server', 'trace', 'build', 'exit', 'leftAfterMs', 'resumed', 'startedHidden', 'frames', 'worldFrames',
  'frameMedianMs', 'frameP95Ms', 'frameMaxMs', 'contextLost', 'gpu', 'dpr', 'canvasW', 'canvasH', 'renderScalePct', 'msaaOff', 'drawDistanceSteps', 'worldDrawnMs', 'screen',
  'unresolvedMisses', 'firstMoveMs', 'firstClickMs', 'keys', 'modal', 'modalMs', 'errors',
  'eid', // BUG.telemetry-duplicate-resend — the outbox's event id (verify-telemetry-duplicate-resend.ts)
].sort();
const WORLD_LEFT_BASE_KEYS = ['outcome', 'era', 'server', 'trace', 'build', 'exit', 'sessionMs', 'contextLost', 'errors', 'eid'].sort();
// BUG.hidden-tab-session-drop: the page adds hiddenMs / freezes / frozenMs to every world_left (endCause / closeCode
// on a drop only); the bridge keeps them only when sent, so an older page's event keeps the base keys.
const WORLD_LEFT_KEYS = [...WORLD_LEFT_BASE_KEYS, 'hiddenMs', 'freezes', 'frozenMs'].sort();

interface Rig {
  r: WorldReporter;
  events: WorldEvent[];
  clock: { t: number };
  state: { screen: WorldScreen; modal: WorldModal | null; moving: boolean; misses: number | null; errors: number; hidden: boolean };
}

function rig(era = 'eor', server: string | null = 'coldeve', endpoint: string | null = 'http://x/client-preworld'): Rig {
  const events: WorldEvent[] = [];
  const clock = { t: 1000 };
  const state: Rig['state'] = { screen: 'portal_space', modal: null, moving: false, misses: 3, errors: 2, hidden: false };
  const r = new WorldReporter({
    endpoint, build: 'abc1234', trace: 'feedc0de12345678', era: () => era, server: () => server,
    now: () => clock.t, send: (_u, b) => { events.push(JSON.parse(b) as WorldEvent); },
  });
  r.setSources({
    screen: () => state.screen, modal: () => state.modal, moving: () => state.moving,
    unresolvedMisses: () => state.misses, errors: () => state.errors,
    canvas: () => ({ width: 1366, height: 768 }), dpr: () => 1.333, hidden: () => state.hidden,
  });
  r.setGpu('integrated');
  return { r, events, clock, state };
}

/** Advance the clock by `ms` in frames of `step` ms; `drawn` says whether the world is visible. */
function run(g: Rig, ms: number, step: number, drawn: boolean): void {
  const end = g.clock.t + ms;
  while (g.clock.t < end) {
    g.clock.t += step;
    g.r.frame(g.clock.t, drawn);
    if (g.clock.t % 1000 < step) g.r.tick();
  }
}

describe('WorldReporter — first_minute', () => {
  it('a player who closes the tab 25 s in: when the world was drawn, frame times, input, the open popup, misses and errors', () => {
    const g = rig();
    g.r.enteredWorld();
    const enteredAt = g.clock.t;
    // Portal space for 4 s (frames run, the world is not drawn); the server's welcome popup opens at 1 s.
    g.state.modal = null;
    run(g, 1000, 16, false);
    g.state.modal = 'popup';
    g.r.tick();
    run(g, 3000, 16, false);
    g.state.screen = 'world';
    run(g, 6000, 16, true);
    // One 400 ms hitch.
    g.clock.t += 400; g.r.frame(g.clock.t, true);
    g.r.worldClick();
    const clickMs = g.clock.t - enteredAt;
    g.r.keyDown(); g.r.keyDown(); g.r.keyDown();
    g.state.moving = true;
    run(g, 100, 16, true);
    g.state.moving = false;
    g.state.errors = 5;
    run(g, 15_000, 33, true);
    expect(g.events).toHaveLength(0);
    g.r.left('closed_tab');
    expect(g.events).toHaveLength(1);
    const ev = g.events[0] as FirstMinuteEvent;
    expect(Object.keys(ev).sort()).toEqual(FIRST_MINUTE_KEYS);
    expect(ev).toMatchObject({
      outcome: 'first_minute', era: 'eor', server: 'coldeve', trace: 'feedc0de12345678', build: 'abc1234',
      exit: 'closed_tab', resumed: false, startedHidden: false, contextLost: false, gpu: 'integrated',
      dpr: 1.25, canvasW: 1300, canvasH: 700, renderScalePct: 100, msaaOff: false, drawDistanceSteps: 0, screen: 'world', unresolvedMisses: 3, keys: 3, modal: 'popup', errors: 3,
      frameMaxMs: 400,
    });
    // More 16 ms frames than 33 ms ones: the median is 16; the 33 ms frames are >5 %, so p95 is 33.
    expect(ev.frameMedianMs).toBe(16);
    expect(ev.frameP95Ms).toBe(33);
    expect(ev.leftAfterMs).toBeGreaterThan(25_000);
    expect(ev.leftAfterMs).toBeLessThan(26_000);
    expect(ev.worldDrawnMs).toBeGreaterThanOrEqual(4000);
    expect(ev.worldDrawnMs).toBeLessThan(4040);
    expect(ev.firstClickMs).toBe(clickMs);
    expect(ev.firstMoveMs).toBeGreaterThan(ev.firstClickMs!);
    expect(ev.frames).toBeGreaterThan(ev.worldFrames);
    expect(ev.modalMs).toBeGreaterThan(24_000);
    // The bridge keeps a real payload whole.
    expect(sanitizeClientWorld(ev)).toEqual(ev);
    // Leaving again (pagehide after beforeunload) sends nothing more.
    g.r.left('closed_tab');
    g.r.hidden();
    expect(g.events).toHaveLength(1);
  });

  it('still in the world at 60 s: exit still_in, leftAfterMs null; the session end later is one world_left', () => {
    const g = rig('ac1999', 'ac1999');
    g.r.enteredWorld();
    g.state.screen = 'world';
    run(g, FIRST_MINUTE_MS - 100, 16, true);
    expect(g.events).toHaveLength(0);
    run(g, 1200, 16, true);
    expect(g.events).toHaveLength(1);
    const ev = g.events[0] as FirstMinuteEvent;
    expect(ev).toMatchObject({ exit: 'still_in', leftAfterMs: null, era: 'ac1999', server: 'ac1999', modal: null, modalMs: null, firstMoveMs: null, firstClickMs: null, keys: 0 });
    expect(ev.worldDrawnMs).toBe(16);
    expect(ev.frameMedianMs).toBe(16);
    expect(sanitizeClientWorld(ev)).toEqual(ev);
    // After the minute frames and keys are no longer counted; the hidden tab is no exit.
    g.r.keyDown();
    g.r.hidden();
    expect(g.events).toHaveLength(1);
    g.clock.t += 600_000;
    g.r.left('logout');
    const left = g.events[1] as WorldLeftEvent;
    expect(Object.keys(left).sort()).toEqual(WORLD_LEFT_KEYS);
    expect(left).toMatchObject({ outcome: 'world_left', exit: 'logout', era: 'ac1999', contextLost: false, errors: 0 });
    expect(left.sessionMs).toBeGreaterThan(660_000);
    expect(sanitizeClientWorld(left)).toEqual(left);
    g.r.left('disconnected');
    expect(g.events).toHaveLength(2);
  });

  it('a hidden tab ends the first minute (exit hidden); a drop after it sends world_left', () => {
    const g = rig('dm', 'seedsow');
    g.r.enteredWorld();
    run(g, 2000, 16, false);
    g.r.hidden();
    const ev = g.events[0] as FirstMinuteEvent;
    expect(ev).toMatchObject({ exit: 'hidden', screen: 'portal_space', worldDrawnMs: null, worldFrames: 0, era: 'dm', server: 'seedsow' });
    g.r.left('disconnected');
    expect(g.events[1]).toMatchObject({ outcome: 'world_left', exit: 'disconnected' });
  });

  it('each world entry is its own session: a resume after a drop says so; a context loss is flagged', () => {
    const g = rig();
    g.r.enteredWorld();
    run(g, 500, 16, true);
    g.r.contextLostNow();
    g.r.left('disconnected');
    expect(g.events[0]).toMatchObject({ exit: 'disconnected', contextLost: true, resumed: false });
    g.state.hidden = true;
    g.r.enteredWorld(true);
    run(g, 500, 16, true);
    g.r.left('logout');
    expect(g.events[1]).toMatchObject({ outcome: 'first_minute', exit: 'logout', contextLost: false, resumed: true, startedHidden: true });
    expect((g.events[1] as FirstMinuteEvent).frames).toBeLessThan(40);
  });

  it('frame times: long frames land in the overflow bin; tab stalls over 5 s are not frames; nothing before enteredWorld counts', () => {
    const g = rig();
    g.r.frame(10, true);
    g.r.keyDown();
    g.r.worldClick();
    g.r.left('closed_tab');
    expect(g.events).toHaveLength(0);
    g.r.enteredWorld();
    let t = g.clock.t;
    for (let i = 0; i < 10; i++) { t += 300; g.r.frame(t, true); }
    t += 9000; g.r.frame(t, true);
    g.clock.t = t;
    g.r.left('closed_tab');
    const ev = g.events[0] as FirstMinuteEvent;
    expect(ev.frameMedianMs).toBe(HIST_MAX_MS);
    expect(ev.frameMaxMs).toBe(300);
    expect(ev.frames).toBe(11);
    expect(ev.keys).toBe(0);
    expect(ev.firstClickMs).toBeNull();
  });

  it('no endpoint sends nothing; a page sends at most MAX_WORLD_EVENTS; throwing sources never throw out', () => {
    const quiet = rig('eor', null, null);
    quiet.r.enteredWorld();
    quiet.r.left('closed_tab');
    expect(quiet.events).toHaveLength(0);
    const g = rig();
    for (let i = 0; i < MAX_WORLD_EVENTS + 5; i++) { g.r.enteredWorld(); g.r.left('logout'); }
    expect(g.events).toHaveLength(MAX_WORLD_EVENTS);
    const bad = rig();
    bad.r.setSources({
      screen: () => { throw new Error('x'); }, modal: () => { throw new Error('x'); }, moving: () => { throw new Error('x'); },
      unresolvedMisses: () => { throw new Error('x'); }, errors: () => { throw new Error('x'); }, canvas: () => { throw new Error('x'); },
      dpr: () => { throw new Error('x'); }, hidden: () => { throw new Error('x'); },
    });
    bad.r.enteredWorld();
    run(bad, 100, 16, true);
    bad.r.left('closed_tab');
    expect(bad.events[0]).toMatchObject({ screen: 'world', modal: null, unresolvedMisses: null, errors: 0, dpr: null, canvasW: null });
  });

  it('install(): pagehide is a closed tab, visibility hidden ends the minute, keys and canvas presses count, a context loss flags', () => {
    const g = rig();
    const handlers = new Map<string, Array<(e?: unknown) => void>>();
    const target = (prefix: string) => ({
      addEventListener: (type: string, fn: (e?: unknown) => void) => {
        const k = `${prefix}:${type}`;
        handlers.set(k, [...(handlers.get(k) ?? []), fn]);
      },
    });
    let interval: (() => void) | null = null;
    const win = { ...target('win'), setInterval: (fn: () => void) => { interval = fn; return 1; } };
    const doc = { ...target('doc'), visibilityState: 'visible' };
    g.r.install(win as never, doc as never, target('canvas') as never);
    const fire = (k: string, e?: unknown) => handlers.get(k)?.forEach((f) => f(e));
    g.r.enteredWorld();
    fire('doc:keydown', { repeat: false });
    fire('doc:keydown', { repeat: true });
    g.clock.t += 2000;
    fire('canvas:pointerdown');
    fire('canvas:webglcontextlost');
    g.state.modal = 'book';
    interval!();
    g.clock.t += 3000;
    fire('win:pagehide');
    expect(g.events[0]).toMatchObject({ exit: 'closed_tab', keys: 1, firstClickMs: 2000, contextLost: true, modal: 'book', modalMs: 3000 });
    g.r.enteredWorld();
    doc.visibilityState = 'hidden';
    fire('doc:visibilitychange');
    expect(g.events[1]).toMatchObject({ exit: 'hidden' });
  });
});

describe('the error count comes from ErrorReporter.reportCount', () => {
  it('counts every report, repeats and unsent ones included', () => {
    const er = new ErrorReporter({ endpoint: null, build: 'b', screen: () => 'world', send: () => {} });
    er.report('error', 'a');
    er.report('error', 'a');
    er.report('unhandledrejection', 'b');
    expect(er.reportCount).toBe(3);
  });
});

describe('classifyGpu — only the class leaves the page', () => {
  it.each([
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'discrete'],
    ['ANGLE (AMD, AMD Radeon RX 6700 XT Direct3D11 vs_5_0 ps_5_0, D3D11)', 'discrete'],
    ['ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'discrete'],
    ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated'],
    ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated'],
    ['ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated'],
    ['ANGLE (AMD, Radeon(TM) Vega 8 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'integrated'],
    ['ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Pro, Unspecified Version)', 'integrated'],
    ['Apple GPU', 'integrated'],
    ['Mali-G78', 'integrated'],
    ['Adreno (TM) 650', 'integrated'],
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'software'],
    ['llvmpipe (LLVM 15.0.7, 256 bits)', 'software'],
    ['ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)', 'software'],
    ['WebKit WebGL', 'unknown'],
    ['', 'unknown'],
  ] as const)('%s → %s', (s, cls) => {
    expect(classifyGpu(s)).toBe(cls);
  });

  it('unmaskedRenderer reads WEBGL_debug_renderer_info, null when hidden or throwing', () => {
    expect(unmaskedRenderer({ getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 0x9246 }), getParameter: (p) => (p === 0x9246 ? 'Apple M1' : null) })).toBe('Apple M1');
    expect(unmaskedRenderer({ getExtension: () => null, getParameter: () => 'x' })).toBeNull();
    expect(unmaskedRenderer({ getExtension: () => { throw new Error('lost'); }, getParameter: () => 'x' })).toBeNull();
    expect(unmaskedRenderer(null)).toBeNull();
  });
});

describe('sanitizeClientWorld', () => {
  const real = (): FirstMinuteEvent => {
    const g = rig();
    g.r.enteredWorld();
    run(g, 2000, 16, true);
    g.r.left('closed_tab');
    return g.events[0] as FirstMinuteEvent;
  };

  it('drops unknown fields, free text and out-of-bounds values', () => {
    const ev = sanitizeClientWorld({
      ...real(), name: 'Bob the Great', gpuString: 'NVIDIA GeForce RTX 4090', chat: 'hi there',
      exit: 'rage_quit', gpu: 'NVIDIA GeForce', screen: 'my-house', modal: 'Bob', dpr: 1.3, canvasW: 1366, keys: -1,
      frames: 1e9, frameMedianMs: 3.5, contextLost: 'yes', era: 'eor; drop', trace: 'NOTHEX!',
    })!;
    expect(JSON.stringify(ev)).not.toMatch(/bob|geforce|hi there|rage|house/i);
    expect(Object.keys(ev)).not.toContain('name');
    expect(ev).toMatchObject({
      outcome: 'first_minute', exit: null, gpu: null, screen: null, modal: null, dpr: null, canvasW: null, keys: null,
      frames: null, frameMedianMs: null, contextLost: null, era: null, trace: null,
    });
    expect(sanitizeClientWorld({ outcome: 'nope' })).toBeNull();
    expect(sanitizeClientWorld(null)).toBeNull();
    expect(sanitizeClientWorld([])).toBeNull();
  });

  it("world_left keeps only a real session end and its own fields", () => {
    expect(sanitizeClientWorld({ outcome: 'world_left', exit: 'still_in', sessionMs: 5 })).toMatchObject({ exit: null, sessionMs: 5 });
    expect(sanitizeClientWorld({ outcome: 'world_left', exit: 'hidden' })!.exit).toBeNull();
    const left = sanitizeClientWorld({ outcome: 'world_left', exit: 'logout', sessionMs: 90_000, keys: 5, frames: 10, gpu: 'discrete', eid: 'abcdef012345' })!;
    expect(left).toMatchObject({ exit: 'logout', sessionMs: 90_000 });
    expect(Object.keys(left).sort()).toEqual(WORLD_LEFT_BASE_KEYS);
  });
});

describe('POST /client-preworld with a world event', () => {
  function baseConfig(): BridgeConfig {
    const c = resolveBridgeConfig([], { BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none' });
    c.wsPort = 0;
    return c;
  }

  it('logs one client_world line (nulls left out), counts it by outcome, refuses junk', async () => {
    const logs: Array<[string, string, Record<string, unknown>]> = [];
    const bridge = createBridgeServer(baseConfig(), { log: (level, event, fields) => { logs.push([level, event, fields ?? {}]); } });
    const port = await bridge.listen();
    try {
      const post = (body: string) => fetch(`http://127.0.0.1:${port}/client-preworld`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body });
      const g = rig();
      g.r.enteredWorld();
      g.state.screen = 'world';
      run(g, 3000, 16, true);
      g.r.left('closed_tab');
      const body = JSON.stringify(g.events[0]);
      expect(body.length).toBeLessThan(CLIENT_PREWORLD_MAX_BODY);
      expect((await post(body)).status).toBe(204);
      const line = logs.find(l => l[1] === 'client_world')!;
      expect(line[0]).toBe('info');
      const { ip, ...fields } = line[2];
      expect(ip).toEqual(expect.any(String));
      expect(fields).toEqual(Object.fromEntries(Object.entries(g.events[0]).filter(([, v]) => v !== null)));
      expect(fields).toMatchObject({ outcome: 'first_minute', exit: 'closed_tab', screen: 'world', trace: 'feedc0de12345678' });
      expect(logs.some(l => l[1] === 'client_preworld')).toBe(false);
      expect(bridge.metrics.clientPreworld.get('first_minute')).toBe(1);
      expect(renderPrometheus(bridge.metrics, { mode: 'pinned', era: null, sessions: 0, perServer: [], serversList: null, uptimeSeconds: 0, draining: false }))
        .toContain('acbridge_client_preworld_total{outcome="first_minute"} 1');
      expect((await post(JSON.stringify({ outcome: 'world_left', exit: 'logout', sessionMs: 120_000 }))).status).toBe(204);
      expect(logs.filter(l => l[1] === 'client_world')[1][2]).toMatchObject({ outcome: 'world_left', exit: 'logout', sessionMs: 120_000 });
      // A pre-world event still logs client_preworld.
      expect((await post(JSON.stringify({ outcome: 'enter_ok', era: 'eor' }))).status).toBe(204);
      expect(logs.some(l => l[1] === 'client_preworld')).toBe(true);
    } finally {
      await bridge.shutdown();
    }
  });
});
