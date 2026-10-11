/**
 * tools/screen-regression-lib.ts — the all-screens regression pass's diff and
 * verdict logic, driven with real PNG bytes (pngjs) so it runs everywhere.
 */
import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import {
  diffPair, judge, formatReport, kindFor, mergeNoise, thresholdFor, clusterThresholdFor, largestChangedCluster,
  isBlankWorld, dominantColour, DEFAULT_THRESHOLDS, DEFAULT_CLUSTER_FLOORS, type PairDiff,
} from '../tools/screen-regression-lib';

function png(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): Buffer {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = paint(x, y); const i = (y * w + x) * 4;
    p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b; p.data[i + 3] = 255;
  }
  return PNG.sync.write(p);
}
const grey = png(100, 100, () => [80, 80, 80]);
// A 10x10 block of white: 1% of the frame.
const withBlock = png(100, 100, (x, y) => (x < 10 && y < 10 ? [255, 255, 255] : [80, 80, 80]));
// One changed pixel: 0.01% of this frame, above the panel bar (0.001%;
// panels have zero same-code noise) but far inside scene noise.
const onePixel = png(100, 100, (x, y) => (x === 50 && y === 50 ? [255, 0, 0] : [80, 80, 80]));

describe('diffPair', () => {
  it('identical PNGs are unchanged with no diff image', () => {
    const d = diffPair('hud-overview', 'panel', grey, grey);
    expect(d).toMatchObject({ status: 'unchanged', changedPixels: 0, ratio: 0 });
    expect(d.diffPng).toBeUndefined();
  });
  it('a 1% block change is "changed" for a panel and writes a diff image', () => {
    const d = diffPair('inventory', 'panel', grey, withBlock);
    expect(d.status).toBe('changed');
    expect(d.changedPixels).toBe(100);
    expect(d.ratio).toBeCloseTo(0.01, 5);
    expect(PNG.sync.read(d.diffPng!).width).toBe(100);
  });
  it('per-kind thresholds: a 1% change is within scene noise; panels (zero noise) flag even one pixel in 10k', () => {
    // Scene fixtures sit on black: a flat non-black frame is a blank world (isBlankWorld).
    const dark = png(100, 100, () => [0, 0, 0]);
    const darkBlock = png(100, 100, (x, y) => (x < 10 && y < 10 ? [255, 255, 255] : [0, 0, 0]));
    const darkPixel = png(100, 100, (x, y) => (x === 50 && y === 50 ? [255, 0, 0] : [0, 0, 0]));
    expect(diffPair('scenes/holtburg', 'scene', dark, darkBlock).status).toBe('unchanged');
    expect(diffPair('scenes/holtburg', 'scene', dark, darkPixel).status).toBe('unchanged');
    expect(diffPair('map', 'panel', grey, onePixel).status).toBe('changed');
    expect(DEFAULT_THRESHOLDS.scene).toBeGreaterThan(DEFAULT_THRESHOLDS.panel);
  });
  it('missing sides and size mismatches are reported, never silently unchanged', () => {
    expect(diffPair('map', 'panel', null, grey).status).toBe('missing-base');
    expect(diffPair('map', 'panel', grey, null).status).toBe('missing-head');
    expect(diffPair('map', 'panel', grey, png(50, 50, () => [80, 80, 80])).status).toBe('size-mismatch');
  });
});

describe('judge', () => {
  const d = (name: string, status: PairDiff['status']): PairDiff =>
    ({ name, kind: 'panel', status, changedPixels: status === 'unchanged' ? 0 : 500, totalPixels: 1e4, ratio: status === 'unchanged' ? 0 : 0.05, largestCluster: 0 });
  const diffs = [d('inventory', 'changed'), d('social-friends', 'changed'), d('map', 'changed'), d('options', 'unchanged'), d('char-skills', 'unchanged'), d('preworld/login', 'missing-head')];

  it('splits by declared intent, with prefix* matching', () => {
    const v = judge(diffs, ['inventory', 'social-*', 'char-skills']);
    expect(v.expected.map((x) => x.name)).toEqual(['inventory', 'social-friends']);
    expect(v.unexpected.map((x) => x.name)).toEqual(['map', 'preworld/login']);
    expect(v.expectedButUnchanged.map((x) => x.name)).toEqual(['char-skills']);
    expect(v.unchanged.map((x) => x.name)).toEqual(['options']);
  });
  it('patterns match with or without the preworld/ and scenes/ folder', () => {
    const pre = [d('preworld/char-create-skills', 'changed'), d('scenes/world-town-day', 'changed'), d('scenes/world-town-day.hud', 'changed'), d('map', 'changed')];
    const v = judge(pre, ['char-create*', 'world-town-day']);
    expect(v.expected.map((x) => x.name)).toEqual(['preworld/char-create-skills', 'scenes/world-town-day', 'scenes/world-town-day.hud']);
    expect(v.unexpected.map((x) => x.name)).toEqual(['map']);
    // The full name still works, and a bare name never matches a different folder's capture.
    expect(judge(pre, ['scenes/world-*']).expected.map((x) => x.name)).toEqual(['scenes/world-town-day', 'scenes/world-town-day.hud']);
    expect(judge([d('preworld/login', 'changed')], ['log']).unexpected).toHaveLength(1);
  });
  it('the report leads with the undeclared changes', () => {
    const r = formatReport(judge(diffs, ['inventory']), 'aaaa', 'bbbb');
    expect(r).toContain('**3 capture(s) changed that the task did not declare.**');
    expect(r.indexOf('UNEXPECTED')).toBeLessThan(r.indexOf('Declared and changed'));
    expect(formatReport(judge([d('options', 'unchanged')], []), 'a', 'b')).toContain('**No undeclared screen changes.**');
  });
});

describe('noise floor', () => {
  it('thresholdFor: kind default until calibration saw more noise, then 1.5x + margin', () => {
    expect(thresholdFor('options', 'panel', {})).toBe(DEFAULT_THRESHOLDS.panel);
    expect(thresholdFor('options', 'panel', { options: 0.000005 })).toBe(DEFAULT_THRESHOLDS.panel);
    expect(thresholdFor('options', 'panel', { options: 0 })).toBe(DEFAULT_THRESHOLDS.panel);
    expect(thresholdFor('scenes/world-running', 'scene', { 'scenes/world-running': 0.1366 })).toBeCloseTo(0.2054, 4);
  });
  it('mergeNoise REPLACES stale floors (legacy / other date / other renderer), keeps the max within one date+renderer, skips missing, sorts keys', () => {
    // OPS.screen-regression-thresholds (2026-09-26): floors used to be max-forever,
    // so one noisy calibration loosened a capture for good.
    const d = (name: string, ratio: number, largestCluster = 10, status: PairDiff['status'] = 'changed'): PairDiff =>
      ({ name, kind: 'scene', status, changedPixels: 1, totalPixels: 1, ratio, largestCluster });
    const run = { date: '2026-09-26', renderer: 'SwiftShader' };
    const prev = {
      legacy: 0.2,
      old: { ratio: 0.1, cluster: 900, date: '2026-09-01', renderer: 'SwiftShader' },
      otherGpu: { ratio: 0.1, cluster: 900, date: '2026-09-26', renderer: 'Apple M3' },
      today: { ratio: 0.05, cluster: 300, date: '2026-09-26', renderer: 'SwiftShader' },
      untouched: { ratio: 0.3, cluster: 5, date: '2026-01-01', renderer: 'x' },
    };
    const m = mergeNoise(prev, [
      d('legacy', 0.01, 40), d('old', 0.02, 50), d('otherGpu', 0.03, 60), d('today', 0.01, 700), d('new', 0.04, 70),
      d('gone', 1, 0, 'missing-head'),
    ], run);
    expect(m).toEqual({
      legacy: { ratio: 0.01, cluster: 40, ...run },
      new: { ratio: 0.04, cluster: 70, ...run },
      old: { ratio: 0.02, cluster: 50, ...run },
      otherGpu: { ratio: 0.03, cluster: 60, ...run },
      today: { ratio: 0.05, cluster: 700, ...run },
      untouched: prev.untouched,
    });
    expect(Object.keys(m)).toEqual(['legacy', 'new', 'old', 'otherGpu', 'today', 'untouched']);
  });
  it('a noisy capture\'s change inside its floor is unchanged; above it, changed', () => {
    // Both bars from the same floor, as screen-regression.ts computes them.
    const floor = (ratio: number, cluster?: number) => ({ inventory: cluster === undefined ? ratio : { ratio, cluster } });
    const run = (f: ReturnType<typeof floor>) =>
      diffPair('inventory', 'panel', grey, withBlock, thresholdFor('inventory', 'panel', f), clusterThresholdFor('inventory', 'panel', f)).status;
    expect(run(floor(0.009))).toBe('unchanged'); // 1% < 1.4%; legacy entry: cluster not judged yet
    expect(run(floor(0.001))).toBe('changed');
    expect(run(floor(0.009, 120))).toBe('unchanged'); // 100 px block < 1.5x120+64
    expect(run(floor(0.009, 10))).toBe('changed'); // the 100 px block is a real region above this capture's cluster noise
  });
  it('kindFor: portal space animates, so it judges as a scene', () => {
    expect(kindFor('preworld', 'portal-space')).toBe('scene');
    expect(kindFor('preworld', 'login')).toBe('preworld');
    expect(kindFor('', 'inventory')).toBe('panel');
    expect(kindFor('scenes', 'world-town-day')).toBe('scene');
  });
  it('a broken same-code capture (the world never drew on one side) is not recorded as noise', () => {
    const d: PairDiff = { name: 'scenes/storage', kind: 'scene', status: 'changed', changedPixels: 1, totalPixels: 1, ratio: 0.92, largestCluster: 1 };
    const run = { date: '2026-09-26', renderer: 'SwiftShader' };
    expect(mergeNoise({}, [d], run)).toEqual({});
    expect(mergeNoise({ 'scenes/storage': 0.02 }, [d], run)).toEqual({ 'scenes/storage': 0.02 });
  });
  it('thresholdFor reads both the legacy number and the {ratio, cluster, …} entry', () => {
    const e = { ratio: 0.1366, cluster: 5000, date: '2026-09-26', renderer: 'SwiftShader' };
    expect(thresholdFor('scenes/world-running', 'scene', { 'scenes/world-running': e })).toBeCloseTo(0.2054, 4);
  });
  it('clusterThresholdFor: kind default uncalibrated; Infinity for a legacy ratio-only entry; 1.5x+64 above the default', () => {
    expect(clusterThresholdFor('scenes/x', 'scene', {})).toBe(DEFAULT_CLUSTER_FLOORS.scene);
    expect(clusterThresholdFor('scenes/x', 'scene', { 'scenes/x': 0.17 })).toBe(Infinity);
    expect(clusterThresholdFor('scenes/x', 'scene', { 'scenes/x': { ratio: 0.17, cluster: 200 } })).toBe(DEFAULT_CLUSTER_FLOORS.scene);
    expect(clusterThresholdFor('scenes/x', 'scene', { 'scenes/x': { ratio: 0.17, cluster: 4000 } })).toBe(6064);
  });
});

describe('largest changed cluster (OPS.screen-regression-thresholds)', () => {
  const W = 200, H = 200;
  // Scene frames on black: a flat non-black frame would be a blank world (isBlankWorld).
  const bg = png(W, H, () => [0, 0, 0]);
  // Speckle: 400 isolated pixels on a 10 px lattice = 1% of the frame, no two within one 4x4 cell's reach.
  const speckle = png(W, H, (x, y) => (x % 10 === 5 && y % 10 === 5 ? [255, 255, 255] : [0, 0, 0]));
  // A "panel" appearing: one solid 40x40 block = 4% of the frame... and a smaller 30x30 one = 2.25%.
  const panel = png(W, H, (x, y) => (x >= 100 && x < 130 && y >= 100 && y < 130 ? [200, 150, 60] : [0, 0, 0]));

  it('largestChangedCluster: 8-connected over 4x4 cells, counts changed pixels', () => {
    const mask = new Uint8Array(20 * 20);
    for (let x = 0; x < 6; x++) mask[2 * 20 + x] = 1; // a 6 px line
    mask[19 * 20 + 19] = 1; // far speck
    // Two glyph strokes 2 px apart join through adjacent cells.
    mask[10 * 20 + 10] = 1; mask[10 * 20 + 13] = 1; mask[11 * 20 + 13] = 1;
    expect(largestChangedCluster(mask, 20, 20)).toBe(6);
    expect(largestChangedCluster(new Uint8Array(400), 20, 20)).toBe(0);
  });
  it('frame-wide speckle stays small; a solid panel-sized region is one big cluster', () => {
    const s = diffPair('scenes/world-running', 'scene', bg, speckle, 0.5, 1000);
    expect(s.changedPixels).toBe(400);
    expect(s.largestCluster).toBe(1);
    expect(s.status).toBe('unchanged');
    const p = diffPair('scenes/world-running', 'scene', bg, panel, 0.5, 1000);
    expect(p.largestCluster).toBe(900);
  });
  it('a whole-panel change fails on its cluster even when the frame-wide ratio floor is huge (world-running tolerated 26.7%)', () => {
    const big = png(W, H, (x, y) => (x >= 20 && x < 60 && y >= 20 && y < 60 ? [200, 150, 60] : [0, 0, 0])); // 1600 px
    const noisyFloor = { 'scenes/world-running': { ratio: 0.1776, cluster: 300, date: '2026-09-26', renderer: 'SwiftShader' } };
    const t = thresholdFor('scenes/world-running', 'scene', noisyFloor);
    const c = clusterThresholdFor('scenes/world-running', 'scene', noisyFloor);
    expect(t).toBeCloseTo(0.2669, 3);
    const d = diffPair('scenes/world-running', 'scene', bg, big, t, c);
    expect(d.ratio).toBeLessThan(t); // the old ratio-only judge called this unchanged
    expect(d).toMatchObject({ status: 'changed', reason: 'cluster', largestCluster: 1600 });
    expect(formatReport(judge([d], []), 'a', 'b')).toMatch(/changed \(cluster\) .* \| 1600 \|/);
  });
});

describe('scene HUD layer (`scenes/<name>.hud`)', () => {
  it('judges as kind hud at panel strictness, not scene noise', () => {
    expect(kindFor('scenes', 'world-running.hud')).toBe('hud');
    expect(DEFAULT_THRESHOLDS.hud).toBe(DEFAULT_THRESHOLDS.panel);
    expect(diffPair('scenes/world-running.hud', 'hud', grey, onePixel).status).toBe('changed');
  });
  it('declaring a scene with --expect declares its HUD layer too', () => {
    const d = (name: string): PairDiff => ({ name, kind: 'hud', status: 'changed', changedPixels: 5, totalPixels: 1e4, ratio: 0.0005, largestCluster: 5 });
    const v = judge([d('scenes/hud-inventory-over-world.hud'), d('scenes/world-night.hud')], ['scenes/hud-inventory-over-world']);
    expect(v.expected.map((x) => x.name)).toEqual(['scenes/hud-inventory-over-world.hud']);
    expect(v.unexpected.map((x) => x.name)).toEqual(['scenes/world-night.hud']);
  });
});

describe('blank world (HARNESS.scene-capture-blank-world)', () => {
  // The 2026-09-27 failure: the world canvas lost its context and showed the
  // page background (white then) behind an intact HUD: a dark 20% strip here.
  // HUD art is textured, never one flat colour.
  const hud = (x: number, y: number): [number, number, number] => [(x * 13 + y * 7) % 200, (x * 5 + y * 17) % 160, 60 + ((x * y) % 90)];
  const blank = png(100, 100, (x, y) => (y >= 80 ? hud(x, y) : [255, 255, 255]));
  const blank2 = png(100, 100, (x, y) => (y >= 80 ? hud(x + 1, y) : [255, 255, 255]));
  // Today's background is #111 (a live loseContext() on 2026-10-11).
  const blankDark = png(100, 100, (x, y) => (y >= 80 ? hud(x, y) : [17, 17, 17]));
  // The trade-over-world shape: the HUD strip AND a centre panel (30% wide) open over the blank world.
  const blankPanel = png(100, 100, (x, y) => (y >= 80 || (x >= 35 && x < 65 && y >= 20 && y < 80) ? hud(x, y) : [17, 17, 17]));
  // A real world: textured (no colour repeats much), even when bright.
  const textured = png(100, 100, (x, y) => [(x * 7 + y * 3) % 256, (x * 3 + y * 11) % 256, 200 + ((x + y) % 50)]);
  // world-town-far's shape: a flat white sky over the whole top half, textured ground below.
  const whiteSky = png(100, 100, (x, y) => (y < 50 ? [255, 255, 255] : [(x * 5) % 256, 90 + (y % 40), 40]));
  // A dungeon's unlit void: pure black over most of the frame.
  const dungeonVoid = png(100, 100, (x, y) => (x >= 40 && x < 60 ? [120, 100, 80] : [0, 0, 0]));

  it('dominantColour: the most common exact RGB over a row band, and its share', () => {
    expect(dominantColour(PNG.sync.read(blank))).toEqual({ rgb: 0xffffff, fraction: 0.8 });
    expect(dominantColour(PNG.sync.read(blank), 50)).toEqual({ rgb: 0xffffff, fraction: 0.6 });
    expect(dominantColour(PNG.sync.read(blankDark), 0, 80)).toEqual({ rgb: 0x111111, fraction: 1 });
  });
  it('isBlankWorld: the page background behind the HUD (white or #111, with or without an open panel) is blank', () => {
    expect(isBlankWorld(blank)).toBe(true);
    expect(isBlankWorld(blankDark)).toBe(true);
    expect(isBlankWorld(blankPanel)).toBe(true);
  });
  it('isBlankWorld: a textured world, a flat white sky over real ground, and a black dungeon void are not', () => {
    expect(isBlankWorld(textured)).toBe(false);
    expect(isBlankWorld(whiteSky)).toBe(false);
    expect(isBlankWorld(dungeonVoid)).toBe(false);
  });
  it('blank on BOTH sides is broken, not unchanged (it used to hide every world regression in the scene)', () => {
    const same = diffPair('scenes/hud-combat', 'scene', blank, blank);
    expect(same).toMatchObject({ status: 'broken', blank: 'both' });
    expect(diffPair('scenes/hud-combat', 'scene', textured, blank).blank).toBe('head');
    expect(diffPair('scenes/hud-combat', 'scene', blank2, textured).blank).toBe('base');
    // A declared scene is still flagged: a blank capture can't show the intended change.
    const v = judge([same], ['hud-combat']);
    expect(v.unexpected.map((d) => d.name)).toEqual(['scenes/hud-combat']);
    expect(v.expected).toEqual([]);
    expect(formatReport(v, 'a', 'b')).toContain('blank world: both');
  });
  it('panels and HUD layers are not judged for a blank world (white DOM is legitimate there)', () => {
    expect(diffPair('options', 'panel', blank, blank).status).toBe('unchanged');
    expect(diffPair('scenes/hud-combat.hud', 'hud', blank, blank).status).toBe('unchanged');
  });
  it('calibration never records a broken capture as noise', () => {
    const merged = mergeNoise({}, [diffPair('scenes/hud-combat', 'scene', blank, blank)], { date: '2026-10-11', renderer: 'x' });
    expect(merged).toEqual({});
  });
});

describe('acquireRunLock — one screen-regression run at a time', () => {
  it('takes a free or stale lock and refuses one held by a live other process', async () => {
    const { acquireRunLock } = await import('../tools/screen-regression-lib.js');
    const alive = (pids: number[]) => (pid: number) => pids.includes(pid);
    expect(acquireRunLock(null, 100, alive([]))).toEqual({ holder: 100 });
    expect(acquireRunLock('200\n', 100, alive([200]))).toBeNull(); // live other run
    expect(acquireRunLock('200', 100, alive([]))).toEqual({ holder: 100 }); // stale lock
    expect(acquireRunLock('100', 100, alive([100]))).toEqual({ holder: 100 }); // our own
    expect(acquireRunLock('garbage', 100, alive([]))).toEqual({ holder: 100 });
  });
});
