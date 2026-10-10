/**
 * 2026-10-03 resource sweep: the session soak's decisions (tools/perf-soak-lib.ts),
 * the page's graphics-context health counters (ui/ContextHealth.ts), and the
 * harness alarm that refuses broken frames (tools/lib/game-session.ts fatalReason).
 */
import { describe, it, expect } from 'vitest';
import { frameStats, sessionBudgetBreaches, HITCH_P99_MS, MAX_FRAME_MS, hostSummary, sampleHost, soakCharacterName } from '../tools/perf-soak-lib.ts';
import { recordContextEvent, describeCanvas, installContextHealth, type ContextHealth } from '../packages/renderer/src/ui/ContextHealth.ts';
import { fatalReason } from '../tools/lib/game-session.ts';

describe('frameStats', () => {
  it('reports p99, worst frame and >50 ms hitches; ignores junk deltas', () => {
    const f = [...Array(98).fill(16.7), 40, 120, NaN, -3, 0];
    expect(frameStats(f)).toEqual({ n: 100, p99: 40, max: 120, over50: 1 });
    expect(frameStats([])).toEqual({ n: 0, p99: 0, max: 0, over50: 0 });
  });
});

describe('sessionBudgetBreaches', () => {
  const ok = { n: 100, p99: 18, max: 30, over50: 0 };
  const s = (phase: string, over: Partial<{ nodes: number; listeners: number; domCanvases: number; webglLost: number; canvas2dLost: number; frames: typeof ok }> = {}) =>
    ({ phase, nodes: 1000, listeners: 1400, domCanvases: 60, webglLost: 0, canvas2dLost: 0, frames: ok, ...over });
  const firstStop = s('idle');

  it('passes a healthy session', () => {
    expect(sessionBudgetBreaches([s('running'), s('ui'), s('combat'), s('chat')], { firstStop, last: s('after-gc') })).toEqual([]);
  });
  it('fails on any graphics context loss', () => {
    expect(sessionBudgetBreaches([s('ui', { canvas2dLost: 1 })], { firstStop, last: s('after-gc') }).join()).toMatch(/context lost 1/);
  });
  it('fails when UI counts pile up past +25% (with slack for small counts)', () => {
    expect(sessionBudgetBreaches([], { firstStop, last: s('after-gc', { nodes: 1300 }) }).join()).toMatch(/nodes 1000 → 1300/);
    expect(sessionBudgetBreaches([], { firstStop, last: s('after-gc', { domCanvases: 94 }) })).toEqual([]);    // 60*1.25+20 = 95
    expect(sessionBudgetBreaches([], { firstStop, last: s('after-gc', { domCanvases: 96 }) }).join()).toMatch(/domCanvases/);
  });
  it('enforces hitch budgets on the real GPU only, and never on teleport arrival', () => {
    const slow = s('ui', { frames: { n: 100, p99: HITCH_P99_MS.ui + 1, max: MAX_FRAME_MS.ui + 1, over50: 5 } });
    const r = sessionBudgetBreaches([slow, s('arrived', { frames: { n: 50, p99: 300, max: 400, over50: 20 } })], { firstStop, last: s('after-gc') });
    expect(r).toEqual([`ui frame p99 ${HITCH_P99_MS.ui + 1} ms (> ${HITCH_P99_MS.ui} ms)`, `ui worst frame ${MAX_FRAME_MS.ui + 1} ms (> ${MAX_FRAME_MS.ui} ms)`]);
    expect(sessionBudgetBreaches([slow], { firstStop, last: s('after-gc') }, false)).toEqual([]);
  });
});

describe('ContextHealth', () => {
  const fresh = (): ContextHealth => ({ webglLost: 0, webglRestored: 0, canvas2dLost: 0, canvas2dRestored: 0, events: [] });
  it('counts WebGL and 2D losses/restores and describes the canvas', () => {
    const h = fresh();
    const canvas = { id: 'game', className: 'world main', width: 1600, height: 900, dataset: {} };
    expect(recordContextEvent(h, 'webglcontextlost', canvas, 1)).toBe(true);
    expect(recordContextEvent(h, 'webglcontextrestored', canvas, 2)).toBe(true);
    expect(recordContextEvent(h, 'contextlost', { width: 18, height: 16, dataset: {} }, 3)).toBe(true);
    expect(h).toMatchObject({ webglLost: 1, webglRestored: 1, canvas2dLost: 1, canvas2dRestored: 0 });
    expect(h.events[0]).toEqual({ type: 'webglcontextlost', canvas: 'canvas#game.world 1600x900', at: 1 });
    expect(describeCanvas(null)).toBe('?');
  });
  it("skips portal space's deliberate release and unrelated events", () => {
    const h = fresh();
    expect(recordContextEvent(h, 'webglcontextlost', { dataset: { acIntentionalLoss: '1' } })).toBe(false);
    expect(recordContextEvent(h, 'click', { dataset: {} })).toBe(false);
    expect(h.webglLost).toBe(0);
  });
  it('installs capture-phase listeners once on the window', () => {
    const added: Array<[string, boolean]> = [];
    const win = { addEventListener: (t: string, _f: unknown, capture: boolean) => { added.push([t, capture]); } } as unknown as Window;
    const h1 = installContextHealth(win);
    const h2 = installContextHealth(win);
    expect(h1).toBe(h2);
    expect(added).toEqual([['webglcontextlost', true], ['webglcontextrestored', true], ['contextlost', true], ['contextrestored', true]]);
  });
});

describe('harness fatalReason', () => {
  const base = { crashed: false, webglLost: 0, canvas2dLost: 0, pageErrors: [], events: [] as Array<{ type: string; canvas: string }> };
  it('a crash or any context loss is fatal; page errors alone are not', () => {
    expect(fatalReason(base)).toBeNull();
    expect(fatalReason({ ...base, pageErrors: ['TypeError: x'] })).toBeNull();
    expect(fatalReason({ ...base, crashed: true })).toBe('the page crashed');
    expect(fatalReason({ ...base, canvas2dLost: 2, events: [{ type: 'contextlost', canvas: 'canvas 18x16' }] }))
      .toBe('graphics context lost (0 WebGL, 2 2D; last on canvas 18x16)');
  });
});

// PERF.gpu-soak-hitch-ee124a12: a soak run beside other work says so in its
// summary (and so in the GPU worker's result headline).
describe('hostSummary', () => {
  const quiet = { load1: 2.1, otherBrowsers: 0, retailClients: 0, reason: null };
  it('is null with no host readings and "host quiet" when nothing else ran', () => {
    expect(hostSummary([{ phase: 'idle' }])).toBeNull();
    expect(hostSummary([{ phase: 'running', host: quiet }, { phase: 'running', host: { ...quiet, load1: 3.4 } }]))
      .toBe('host quiet: load1 max 3.4, other Playwright browsers max 0, retail client not seen');
  });
  it('starts HOST CONTENDED and names the reasons when any sample was contended', () => {
    const busy = { load1: 5, otherBrowsers: 1, retailClients: 0, reason: '1 other Playwright browser(s)' };
    const line = hostSummary([{ phase: 'running', host: quiet }, { phase: 'running', host: busy }, { phase: 'ui', host: busy }]);
    expect(line).toMatch(/^HOST CONTENDED in 2\/3 samples \(1 other Playwright browser\(s\)\): load1 max 5\.0, other Playwright browsers max 1/);
  });
  it('keeps only the per-sample fields of a contention reading', () => {
    expect(sampleHost(undefined)).toBeUndefined();
    expect(sampleHost({ ...quiet, cpus: 16, top: ['99% node'] } as never)).toEqual(quiet);
  });
});

describe('soakCharacterName', () => {
  it('names a letters-only character for a dedicated probe account', () => {
    expect(soakCharacterName('fxprobe3')).toBe('Soakfxprobed');
    expect(soakCharacterName('TestAcjs2')).toBe('Soaktestacjsc');
  });
  it('never creates one on the default shared account', () => {
    expect(soakCharacterName(undefined)).toBeUndefined();
    expect(soakCharacterName('')).toBeUndefined();
  });
});
