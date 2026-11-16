/**
 * PERF.hud-vitals-per-frame (2026-11-15) — GameUI.updateHUD runs every frame
 * and updateVitalBarDAT formatted three toLocaleString pairs and wrote three
 * inline clip-path styles each time (~2 % of a 10x-throttled frame in the
 * Holtburg academy). It now writes the clip and formats / paints the text only
 * when they change. Pins: the same output as before for every change, no
 * writes while nothing changes, and a reset cache (a rebuilt HUD) repaints.
 *
 * Drives the real GameUI under happy-dom (tests/_harness/dom.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('updateVitalBarDAT writes only what changed', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  function rig() {
    const fill = domWindow.document.createElement('div');
    const text = domWindow.document.createElement('div');
    text.dataset.elementId = '10000376';
    let clipWrites = 0;
    let clip = '';
    Object.defineProperty(fill.style, 'clipPath', { configurable: true, get: () => clip, set: (v: string) => { clip = v; clipWrites++; } });
    const painted: string[] = [];
    ui.vitalsHandle = { setText: (_id: number, t: string) => { painted.push(t); } };
    return { fill, text, painted, clipWrites: () => clipWrites, clip: () => clip };
  }

  it('paints the retail text and clip once, then nothing while the vital holds', () => {
    const r = rig();
    const s = { current: 1234.7, max: 2000, fraction: 1234.7 / 2000, regenRate: 0 };
    let last = '';
    last = ui.updateVitalBarDAT(r.fill, r.text, s, last);
    expect(last).toBe(`${(1234).toLocaleString()}/${(2000).toLocaleString()}`);
    expect(r.painted).toEqual([last]);
    expect(r.clip()).toBe(`inset(0 ${((1 - s.fraction) * 100).toFixed(1)}% 0 0)`);
    expect(r.clipWrites()).toBe(1);
    for (let i = 0; i < 100; i++) last = ui.updateVitalBarDAT(r.fill, r.text, s, last);
    expect(r.painted.length).toBe(1);
    expect(r.clipWrites()).toBe(1);
  });

  it('a change repaints exactly what changed; a reset cache repaints the same text', () => {
    const r = rig();
    const s = { current: 50, max: 100, fraction: 0.5, regenRate: 0 };
    let last = ui.updateVitalBarDAT(r.fill, r.text, s, '');
    // Sub-point regen: the floored text and the 0.1 % clip step stay put.
    s.current = 50.4; s.fraction = 0.5004;
    last = ui.updateVitalBarDAT(r.fill, r.text, s, last);
    expect(r.painted).toEqual(['50/100']);
    expect(r.clipWrites()).toBe(1);
    // A real change: both move.
    s.current = 61; s.fraction = 0.61;
    last = ui.updateVitalBarDAT(r.fill, r.text, s, last);
    expect(r.painted).toEqual(['50/100', '61/100']);
    expect(r.clip()).toBe('inset(0 39.0% 0 0)');
    expect(r.clipWrites()).toBe(2);
    // renderHUD resets lastText to '' (fresh canvases): the same values paint again.
    last = ui.updateVitalBarDAT(r.fill, r.text, s, '');
    expect(last).toBe('61/100');
    expect(r.painted).toEqual(['50/100', '61/100', '61/100']);
    // A new fill element (a rebuilt HUD) takes its clip at once.
    const r2 = rig();
    ui.updateVitalBarDAT(r2.fill, r2.text, s, '');
    expect(r2.clip()).toBe('inset(0 39.0% 0 0)');
  });
});
