/**
 * UX.chargen-preview-no-placeholder — Jake on playwebac.com (2026-11-01):
 * "there's a lot of visible loading assets in character creation. basically
 * anything i change, the preview face flashes white for a second."
 *
 * Streamed DATs answer a read of a file that isn't resident with null and
 * fetch it, so a CharacterModelBuilder build that missed drew white
 * placeholder parts until the file landed. Retail's gmCG3DView::Update
 * @ 004ee9d0 read a local DAT and always swapped in a whole figure.
 *
 * Pinned here, all executing the shipped code:
 *  - PreviewBuildHold: the old picture stays until the new build's files
 *    resolve, the swap happens once they do, a superseded build is dropped,
 *    and the cap releases a stall (then late arrivals still complete it);
 *  - GameUI's chargen view through the real hold, with a builder stub whose
 *    streamed files are delayed per choice, and the real DatMiss signal;
 *  - the barber preview (verify-streamed-miss-not-cached.ts pins its arrival);
 *  - ChargenPrefetcher's order and bound (one set in flight, focus first);
 *  - per era (end of retail, Dark Majesty, AC1999) on the real DATs: every
 *    per-file leaf a real build reads is inside the prefetch's closure, so a
 *    warmed choice never misses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { noteDatMiss, noteDatMissResolved, DAT_ARRIVAL_COALESCE_MS } from '../packages/dat-parser/src/streaming/DatMiss.js';
import { PreviewBuildHold, PREVIEW_HOLD_CAP_MS, type PreviewHoldEnv } from '../packages/renderer/src/ui/PreviewBuildHold.js';
import {
  ChargenPrefetcher, chargenAppearanceIds, chargenBaseIds, chargenOptionIds, type ChargenPrefetchSources,
} from '../packages/renderer/src/models/ChargenPrefetch.js';
import type { SexCG } from '../packages/dat-parser/src/file-types/CharacterGenerator.js';
import { scriptedRandomSource } from '../packages/renderer/src/ui/ChargenRandomize.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

/** A deterministic env: a manual clock, manual timers, a manual arrival signal and miss counter. */
function fakeEnv() {
  let t = 0;
  let epoch = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  const listeners = new Set<() => void>();
  let nextId = 1;
  const env: PreviewHoldEnv = {
    now: () => t,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: t + ms, fn, id }); return id; },
    clearTimer: (h) => { const i = timers.findIndex((x) => x.id === h); if (i >= 0) timers.splice(i, 1); },
    onFilesArrived: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    missEpoch: () => epoch,
  };
  return {
    env,
    miss: () => { epoch++; },
    arrive: () => { for (const l of [...listeners]) l(); },
    advance: (ms: number) => {
      t += ms;
      for (;;) {
        const due = timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        due.fn();
      }
    },
    listenerCount: () => listeners.size,
  };
}

/** A build of `name` that reads files `needs`; misses (and returns a partial model) while any is in `delayed`. */
function figureBuilds(f: ReturnType<typeof fakeEnv>, delayed: Set<string>) {
  const runs: string[] = [];
  const build = (name: string, needs: string[] = [name]) => () => {
    runs.push(name);
    const missing = needs.some((n) => delayed.has(n));
    if (missing) f.miss();
    return { name, complete: !missing };
  };
  return { runs, build };
}

describe('PreviewBuildHold', () => {
  it('a complete build swaps in at once, in the caller\'s frame (whole DATs behave as before)', () => {
    const f = fakeEnv();
    const hold = new PreviewBuildHold<{ name: string }>(PREVIEW_HOLD_CAP_MS, f.env);
    const shown: Array<[string, boolean]> = [];
    const { build } = figureBuilds(f, new Set());
    expect(hold.request(build('a'), (m, sync) => shown.push([m.name, sync]))).toBe(true);
    expect(shown).toEqual([['a', true]]);
    expect(hold.holding).toBe(false);
    expect(f.listenerCount()).toBe(0);
  });

  it('the old picture stays until the new build\'s files resolve; the swap happens once they do', () => {
    const f = fakeEnv();
    const hold = new PreviewBuildHold<{ name: string; complete: boolean }>(PREVIEW_HOLD_CAP_MS, f.env);
    const delayed = new Set(['b-face']);
    const shown: Array<[string, boolean, boolean]> = [];
    const onReady = (m: { name: string; complete: boolean }, sync: boolean) => shown.push([m.name, m.complete, sync]);
    const { build } = figureBuilds(f, delayed);
    hold.request(build('a'), onReady);
    let misses = 0;
    expect(hold.request(build('b', ['b-face']), onReady, { onMiss: () => misses++ })).toBe(false);
    expect(misses).toBe(1);
    expect(hold.lastBuildMisses).toBe(1);
    expect(hold.holding).toBe(true);
    expect(shown).toEqual([['a', true, true]]); // b's partial model was never handed over
    f.arrive(); // another batch landed, b's face not yet
    f.advance(500);
    expect(shown).toHaveLength(1);
    delayed.delete('b-face');
    f.arrive();
    expect(shown).toEqual([['a', true, true], ['b', true, false]]); // swapped outside the caller's frame
    expect(hold.holding).toBe(false);
    expect(f.listenerCount()).toBe(0);
    f.advance(PREVIEW_HOLD_CAP_MS * 2); // the cap was disarmed: nothing else shows
    expect(shown).toHaveLength(2);
    expect(hold.stats.shownIncomplete).toBe(0);
  });

  it('a superseded pending build is discarded: only the latest choice is retried and shown', () => {
    const f = fakeEnv();
    const hold = new PreviewBuildHold<{ name: string; complete: boolean }>(PREVIEW_HOLD_CAP_MS, f.env);
    const delayed = new Set(['b-face', 'c-face']);
    const shown: string[] = [];
    const { runs, build } = figureBuilds(f, delayed);
    hold.request(build('a'), (m) => shown.push(m.name));
    hold.request(build('b', ['b-face']), (m) => shown.push(m.name));
    hold.request(build('c', ['c-face']), (m) => shown.push(m.name));
    expect(hold.stats.superseded).toBe(1);
    // b's files land first: b is gone, c still misses, nothing swaps.
    delayed.delete('b-face');
    f.arrive();
    expect(shown).toEqual(['a']);
    delayed.delete('c-face');
    f.arrive();
    expect(shown).toEqual(['a', 'c']);
    // b was built once (its own request) and never again.
    expect(runs.filter((r) => r === 'b')).toHaveLength(1);
  });

  it('a newer complete choice replaces a pending one at once', () => {
    const f = fakeEnv();
    const hold = new PreviewBuildHold<{ name: string; complete: boolean }>(PREVIEW_HOLD_CAP_MS, f.env);
    const delayed = new Set(['b-face']);
    const shown: string[] = [];
    const { build } = figureBuilds(f, delayed);
    hold.request(build('b', ['b-face']), (m) => shown.push(m.name));
    hold.request(build('c'), (m) => shown.push(m.name));
    expect(shown).toEqual(['c']);
    delayed.delete('b-face');
    f.arrive();
    f.advance(PREVIEW_HOLD_CAP_MS * 2);
    expect(shown).toEqual(['c']);
  });

  it('the cap releases a stall, anchored at the oldest unresolved choice; late arrivals still complete it', () => {
    const f = fakeEnv();
    const hold = new PreviewBuildHold<{ name: string; complete: boolean }>(1750, f.env);
    const delayed = new Set(['b-face', 'c-face']);
    const shown: Array<[string, boolean]> = [];
    const { build } = figureBuilds(f, delayed);
    hold.request(build('a'), (m) => shown.push([m.name, m.complete]));
    hold.request(build('b', ['b-face']), (m) => shown.push([m.name, m.complete]));
    f.advance(1000);
    // A newer choice does not restart the clock: the picture has been stale since b.
    hold.request(build('c', ['c-face']), (m) => shown.push([m.name, m.complete]));
    f.advance(749);
    expect(shown).toEqual([['a', true]]);
    f.advance(1);
    expect(shown).toEqual([['a', true], ['c', false]]); // the latest choice, as it is
    expect(hold.stats.shownIncomplete).toBe(1);
    // Its files land later: the complete figure replaces the partial one (never stranded).
    delayed.delete('c-face');
    f.arrive();
    expect(shown).toEqual([['a', true], ['c', false], ['c', true]]);
    expect(f.listenerCount()).toBe(0);
  });

  it('after a cap release, a file truly absent stops rebuilding after the bound', () => {
    const f = fakeEnv();
    const hold = new PreviewBuildHold<{ name: string; complete: boolean }>(100, f.env, 2);
    const { runs, build } = figureBuilds(f, new Set(['gone']));
    hold.request(build('b', ['gone']), () => {});
    f.advance(100);
    for (let i = 0; i < 6; i++) f.arrive();
    expect(runs).toHaveLength(1 + 1 + 2); // the request, the cap, two late rebuilds
    expect(f.listenerCount()).toBe(0);
  });

  it('a new choice after a cap release gets its own hold', () => {
    const f = fakeEnv();
    const hold = new PreviewBuildHold<{ name: string; complete: boolean }>(100, f.env);
    const delayed = new Set(['b-face', 'c-face']);
    const shown: Array<[string, boolean]> = [];
    const { build } = figureBuilds(f, delayed);
    hold.request(build('b', ['b-face']), (m) => shown.push([m.name, m.complete]));
    f.advance(100);
    expect(shown).toEqual([['b', false]]);
    hold.request(build('c', ['c-face']), (m) => shown.push([m.name, m.complete]));
    expect(hold.holding).toBe(true);
    f.arrive(); // c still missing: not shown, held
    expect(shown).toEqual([['b', false]]);
    f.advance(100);
    expect(shown).toEqual([['b', false], ['c', false]]);
  });

  it('cancel drops the pending build', () => {
    const f = fakeEnv();
    const hold = new PreviewBuildHold<{ name: string; complete: boolean }>(100, f.env);
    const delayed = new Set(['b-face']);
    const shown: string[] = [];
    const { build } = figureBuilds(f, delayed);
    hold.request(build('b', ['b-face']), (m) => shown.push(m.name));
    hold.cancel();
    delayed.clear();
    f.arrive();
    f.advance(500);
    expect(shown).toEqual([]);
    expect(f.listenerCount()).toBe(0);
  });
});

/** A WebGLRenderer double that records which figure each draw showed. */
function figureRenderer(drawn: string[]) {
  return {
    domElement: null,
    getContext: () => ({ isContextLost: () => false }),
    getRenderTarget: () => null, getClearAlpha: () => 1, setClearAlpha() {}, setRenderTarget() {}, clear() {},
    readRenderTargetPixels() {},
    render(scene: THREE.Object3D) {
      let name = '';
      scene.traverse((o) => { if (o.name.startsWith('fig:')) name = o.name; });
      drawn.push(name);
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, DAT_ARRIVAL_COALESCE_MS + 40));

describe('the chargen view holds its last whole figure (real GameUI, real DatMiss signal)', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H?.teardown());

  /** Chargen on the Appearance page with a builder whose files for hair style N are delayed while N is in `delayed`. */
  function openChargen(delayed: Set<number>, cap?: number) {
    const ui = H.ui;
    const drawn: string[] = [];
    const builds: number[] = [];
    const prefetched: Array<{ ids: readonly number[]; priority: string }> = [];
    ui.setUIHost({
      renderer: figureRenderer(drawn),
      characterModelBuilder: {
        buildCharacterModel: (_h: number, _g: number, a: { hairStyle: number }) => {
          builds.push(a.hairStyle);
          const missing = delayed.has(a.hairStyle);
          if (missing) noteDatMiss();
          const g = new THREE.Group();
          g.name = missing ? `fig:partial-${a.hairStyle}` : `fig:hair-${a.hairStyle}`;
          g.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
          return g;
        },
        getChargenClothingColors: () => null,
        getSexCG: () => tinySex(),
        sexes: () => [1, 2].flatMap((heritage) => [1, 2].map((gender) => ({ heritage, gender, sex: tinySex() }))),
        prefetchSources: tinySources,
      },
      appearanceManager: { loadPaletteColors: () => null, loadPaletteSet: () => null },
      prefetchPortalFiles: (ids: readonly number[], priority: string) => { prefetched.push({ ids, priority }); return Promise.resolve(); },
    });
    if (cap !== undefined) ui.chargenPreviewHold = new PreviewBuildHold(cap);
    ui.chargenRandomSource = scriptedRandomSource([0], [0]);
    ui.showCharacterCreate();
    ui.wizard.currentStep = 3; // Appearance
    ui.renderCharacterCreate(); // mounts the page and its .chargen-preview-canvas
    return { ui, drawn, builds, prefetched };
  }

  const setHair = (ui: { wizard: { appearance: { hairStyle: number } }; renderChargenPreview(r: boolean): void }, n: number) => {
    ui.wizard.appearance.hairStyle = n;
    ui.renderChargenPreview(true);
  };

  it('a choice whose files are streaming keeps the old face; it swaps in when they land, never partial', async () => {
    const delayed = new Set<number>();
    const { ui, drawn } = openChargen(delayed, 60_000);
    setHair(ui, 1);
    expect(drawn[drawn.length - 1]).toBe('fig:hair-1');
    delayed.add(2);
    setHair(ui, 2);
    // The new face's texture is not resident: the view redraws the old face.
    expect(drawn[drawn.length - 1]).toBe('fig:hair-1');
    expect(ui.chargenPreviewModel.name).toBe('fig:hair-1');
    // The hold retries its own build; the whole page must not repaint for it.
    expect(ui.chargenMissedDats).toBe(false);
    const before = drawn.length;
    delayed.delete(2);
    noteDatMissResolved();
    await settle();
    expect(drawn.length).toBe(before + 1); // redrawn without a click
    expect(drawn[drawn.length - 1]).toBe('fig:hair-2');
    expect(drawn.some((d) => d.includes('partial'))).toBe(false);
  });

  it('two quick choices while streaming: the stale one is dropped, only the latest ever draws', async () => {
    const delayed = new Set<number>([3, 4]);
    const { ui, drawn, builds } = openChargen(delayed, 60_000);
    delayed.delete(0);
    setHair(ui, 0);
    setHair(ui, 3);
    setHair(ui, 4);
    delayed.delete(3); // the superseded choice's files land first
    noteDatMissResolved();
    await settle();
    expect(drawn[drawn.length - 1]).toBe('fig:hair-0');
    delayed.delete(4);
    noteDatMissResolved();
    await settle();
    expect(drawn[drawn.length - 1]).toBe('fig:hair-4');
    expect(drawn).not.toContain('fig:hair-3');
    expect(builds.filter((b) => b === 3)).toHaveLength(1);
    expect(drawn.some((d) => d.includes('partial'))).toBe(false);
  });

  it('a held miss fetches that appearance\'s files at critical priority; chargen warms its choices in the background', () => {
    const delayed = new Set<number>([1]);
    const { ui, prefetched } = openChargen(delayed, 60_000);
    // Opening chargen: the focused heritage + sex's figure first, one set in flight, Background.
    expect(prefetched.length).toBeGreaterThan(0);
    expect(prefetched[0].priority).toBe('background');
    expect(prefetched[0].ids).toContain(0x01000001); // the setup's parts (tinySources.setupParts)
    expect(prefetched.filter((p) => p.priority === 'background')).toHaveLength(1);
    const before = prefetched.length;
    setHair(ui, 1); // hair style 1 of tinySex: ObjDesc textures 0x05000301, part 0x05000302
    const critical = prefetched.slice(before).filter((p) => p.priority === 'critical');
    expect(critical).toHaveLength(1);
    expect(critical[0].ids).toContain(0x05000301);
    expect(critical[0].ids).not.toContain(0x05000201); // not the other hair style
  });

  it('the cap releases a stall so the view still updates; the full face follows when it lands', async () => {
    const delayed = new Set<number>();
    const { ui, drawn } = openChargen(delayed, 120);
    setHair(ui, 1);
    delayed.add(6);
    setHair(ui, 6);
    expect(drawn[drawn.length - 1]).toBe('fig:hair-1');
    await new Promise((r) => setTimeout(r, 200));
    expect(drawn[drawn.length - 1]).toBe('fig:partial-6');
    delayed.delete(6);
    noteDatMissResolved();
    await settle();
    expect(drawn[drawn.length - 1]).toBe('fig:hair-6');
  });

  it('a new chargen starts from no figure, not the last session\'s', () => {
    const delayed = new Set<number>();
    const { ui, drawn } = openChargen(delayed, 60_000);
    setHair(ui, 1);
    expect(drawn[drawn.length - 1]).toBe('fig:hair-1');
    // Leave and open again with a first figure whose files are streaming.
    ui.uiManager.setScreen('character-select');
    const everything = { has: () => true } as unknown as Set<number>; // every file still streaming
    const again = openChargen(everything, 60_000);
    again.ui.renderChargenPreview(true);
    expect(again.drawn).toHaveLength(0); // the viewport stays empty rather than showing the old character
  });
});

// ── the prefetch ────────────────────────────────────────────────────────────

/** A tiny SexCG: every list has two entries with distinct ids per field. */
function tinySex(): SexCG {
  const od = (base: number) => ({ paletteId: 0, subPalettes: [], textureChanges: [{ partIndex: 16, oldTexture: base, newTexture: base + 1 }], animPartChanges: [{ partIndex: 16, partId: base + 2 }] });
  return {
    name: 'M', scale: 1, setupId: 0x02000001, soundTable: 0, iconImage: 0, basePalette: 0x0400007e, skinPalSet: 0x0f000001,
    physicsTable: 0, motionTable: 0x09000001, combatTable: 0, baseObjDesc: od(0x05000100),
    hairColorList: [0x0f000002], hairStyleList: [{ iconImage: 0x06000101, bald: false, alternateSetup: 0, objDesc: od(0x05000200) }, { iconImage: 0x06000102, bald: true, alternateSetup: 0x02000002, objDesc: od(0x05000300) }],
    eyeColorList: [0x04000201, 0x04000202],
    eyeStripList: [{ iconImage: 0x06000201, iconImageBald: 0x06000202, objDesc: od(0x05000400), objDescBald: od(0x05000500) }],
    noseStripList: [{ iconImage: 0x06000301, objDesc: od(0x05000600) }],
    mouthStripList: [{ iconImage: 0x06000401, objDesc: od(0x05000700) }],
    headgearList: [], shirtList: [{ name: 'Shirt', clothingTable: 0x10000001, weenieDefault: 0 }], pantsList: [], footwearList: [],
    clothingColorsList: [7],
  } as unknown as SexCG;
}

const tinySources: ChargenPrefetchSources = {
  loadPaletteSet: (id) => ({ paletteList: [id + 0x100, id + 0x101], getPaletteId: (h: number) => (h < 0.5 ? id + 0x100 : id + 0x101) }),
  loadClothingTable: () => ({
    id: 0x10000001,
    clothingBaseEffects: new Map([[0x02000001, { cloObjectEffects: [{ index: 9, modelId: 0x01000900, cloTextureEffects: [{ oldTexture: 0x05000900, newTexture: 0x05000901 }] }] }]]),
    clothingSubPalEffects: new Map([[7, { icon: 0, cloSubPalettes: [{ ranges: [], paletteSet: 0x0f000007 }] }], [8, { icon: 0, cloSubPalettes: [{ ranges: [], paletteSet: 0x0f000008 }] }]]),
  }) as never,
  setupParts: (id) => (id === 0x02000001 ? [0x01000001, 0x01000002] : [0x01000011]),
  chargenAnimations: () => [0x03000001, 0x03000002],
};

describe('ChargenPrefetch id sets', () => {
  const hex = (ids: readonly number[]) => new Set(ids.map((i) => i >>> 0));

  it('the base figure: the setup\'s parts (not the Setup, whose closure walks the motion table), the view animations, base ObjDesc, palettes', () => {
    const ids = hex(chargenBaseIds(tinySex(), tinySources, 1));
    expect(ids).toEqual(hex([0x01000001, 0x01000002, 0x03000001, 0x03000002, 0x0400007e, 0x05000101, 0x05000102, 0x0f000101, 0x0f000102]));
    expect(ids.has(0x02000001)).toBe(false);
    expect(ids.has(0x09000001)).toBe(false);
  });

  it('every option: each style\'s ObjDesc and strip icon, every colour shade, the alternate head setup, the clothes and only their offered templates', () => {
    const ids = hex(chargenOptionIds(tinySex(), tinySources, 1));
    for (const id of [0x05000201, 0x05000202, 0x05000301, 0x05000302, 0x05000401, 0x05000501, 0x05000601, 0x05000701,
      0x06000101, 0x06000102, 0x06000201, 0x06000202, 0x06000301, 0x06000401,
      0x0f000102, 0x0f000103, 0x04000201, 0x04000202, 0x01000011,
      0x01000900, 0x05000901, 0x0f000107, 0x0f000108]) {
      expect(ids.has(id), id.toString(16)).toBe(true);
    }
    expect(ids.has(0x0f000109)).toBe(false); // template 8 isn't in the sex's clothingColorsList
  });

  it('one appearance: just its choices at their shades', () => {
    const sex = tinySex();
    const a = { hairStyle: 1, hairColor: 0, eyesStrip: 0, eyeColor: 1, skinColor: 0, noseStyle: 0, mouthStyle: 0, headgearStyle: -1, headgearColor: 0,
      shirtStyle: 0, shirtColor: 0, pantsStyle: -1, pantsColor: 0, footwearStyle: -1, footwearColor: 0, skinHue: 0.9, hairHue: 0.1, shirtHue: 0.1 };
    const ids = hex(chargenAppearanceIds(sex, a, tinySources));
    expect(ids.has(0x05000301)).toBe(true); // hair style 1
    expect(ids.has(0x05000201)).toBe(false); // not hair style 0
    expect(ids.has(0x05000501)).toBe(true); // bald → the eye strip's bald ObjDesc
    expect(ids.has(0x05000401)).toBe(false);
    expect(ids.has(0x0f000102)).toBe(true); // skin at 0.9
    expect(ids.has(0x0f000101)).toBe(false);
    expect(ids.has(0x04000202)).toBe(true); // eye colour 1
    expect(ids.has(0x04000201)).toBe(false);
  });
});

describe('ChargenPrefetcher: bounded, focus first', () => {
  function harness() {
    const calls: Array<{ ids: readonly number[]; resolve: () => void; reject: (e: unknown) => void }> = [];
    const flight = { now: 0, max: 0 };
    const fetch = (ids: readonly number[]) => new Promise<void>((resolve, reject) => {
      flight.now++; flight.max = Math.max(flight.max, flight.now);
      const end = () => { flight.now--; };
      calls.push({ ids, resolve: () => { end(); resolve(); }, reject: (e) => { end(); reject(e); } });
    });
    const sexes = [1, 2, 3].flatMap((h) => [1, 2].map((g) => ({ heritage: h, gender: g, sex: tinySex() })));
    const pf = new ChargenPrefetcher(fetch, { sexes: () => sexes }, tinySources);
    /** Settle the newest outstanding fetch (ok or failed) and let the queue move. */
    const settleLast = async (ok = true) => {
      const c = calls[calls.length - 1];
      if (ok) c.resolve(); else c.reject(new Error('net'));
      await new Promise((r) => setTimeout(r, 0));
    };
    return { pf, calls, flight, settleLast };
  }

  it('one set in flight; the focused heritage + sex\'s figure then its options come first, then every base', async () => {
    const { pf, calls, flight, settleLast } = harness();
    pf.focus(2, 1);
    pf.warmBases();
    expect(calls).toHaveLength(1);
    expect(pf.fetched.map((f) => f.key)).toEqual(['base:2:1']);
    for (let i = 0; i < 7; i++) await settleLast();
    expect(pf.fetched.map((f) => f.key)).toEqual(['base:2:1', 'options:2:1', 'base:1:1', 'base:1:2', 'base:2:2', 'base:3:1', 'base:3:2']);
    expect(flight.max).toBe(1);
    expect(calls[1].ids.length).toBeGreaterThan(calls[0].ids.length); // the options set holds the base and more
  });

  it('a later focus jumps the queue; a set is fetched once; a failed one may be asked again', async () => {
    const { pf, flight, settleLast } = harness();
    pf.warmBases();
    pf.focus(3, 2); // while base:1:1 is in flight
    await settleLast();
    expect(pf.fetched.map((f) => f.key)).toEqual(['base:1:1', 'base:3:2']);
    await settleLast();
    expect(pf.fetched.map((f) => f.key)).toEqual(['base:1:1', 'base:3:2', 'options:3:2']);
    await settleLast(false); // options:3:2 fails
    for (let i = 0; i < 6; i++) await settleLast();
    pf.focus(3, 2);
    for (let i = 0; i < 3; i++) await settleLast();
    const keys = pf.fetched.map((f) => f.key);
    expect(keys.filter((k) => k === 'options:3:2')).toHaveLength(2);
    expect(keys.filter((k) => k === 'base:3:2')).toHaveLength(1);
    expect(keys.filter((k) => k === 'base:1:1')).toHaveLength(1);
    expect(flight.max).toBe(1);
  });

  it('an unknown heritage is ignored', () => {
    const { pf, calls } = harness();
    pf.focus(99, 1);
    expect(calls).toHaveLength(0);
  });
});

// ── per era: the prefetch covers what real builds read ──────────────────────

interface EraCase { name: string; portal: () => import('../packages/dat-parser/src/DatDatabase.js').DatDatabase | null; present: boolean }
const ERA_CASES: EraCase[] = [
  { name: 'end of retail', present: existsSync(DAT_PATHS.portal), portal: () => openDat(DAT_PATHS.portal) },
  { name: 'Dark Majesty (Classic Dereth 1.1)', present: existsSync('dat-sets/classic-dereth-1.1/client_portal.dat'), portal: () => openDat('dat-sets/classic-dereth-1.1/client_portal.dat') },
  {
    name: 'AC1999', present: existsSync('dat-sets/ac1999-retail/portal.dat'),
    portal: () => null, // filled in beforeAll (the overlay is its own instance)
  },
];

for (const era of ERA_CASES) {
  describe.skipIf(!era.present)(`${era.name}: every leaf a real chargen build reads is in the prefetch`, () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let real: any;
    beforeAll(async () => {
      if (era.name === 'AC1999') {
        const { ac1999Dats } = await import('./_harness/dungeonNav.js');
        real = ac1999Dats()!.portal;
      } else {
        real = era.portal();
      }
    });

    it('options cover random appearances; one appearance\'s critical set covers its own build', async () => {
      const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
      const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
      const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
      const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
      const { ClothingRenderer } = await import('../packages/renderer/src/models/ClothingRenderer.js');
      const { AppearanceManager } = await import('../packages/renderer/src/models/AppearanceManager.js');
      const { CharacterModelBuilder } = await import('../packages/renderer/src/models/CharacterModelBuilder.js');
      const { closureLeaves } = await import('../tools/lib/chargen-prefetch-plan.js');
      const { isPortalLeaf } = await import('../tools/lib/area-packs.js');
      const reads = new Set<number>();
      const db = new Proxy(real, {
        get(t, k) {
          if (k === 'getFileData') return (id: number) => { reads.add(id >>> 0); return t.getFileData(id); };
          const v = t[k];
          return typeof v === 'function' ? v.bind(t) : v;
        },
      });
      const tm = new TextureManager(db); const mf = new MaterialFactory(db, tm); const mr = new ModelRenderer(db, mf);
      const smr = new SetupModelRenderer(db, mr); const cr = new ClothingRenderer(db, smr, mr, mf); const am = new AppearanceManager(db);
      const builder = new CharacterModelBuilder(db, smr, cr, am);
      const sexes = builder.sexes();
      expect(sexes.length).toBeGreaterThan(0);
      // A few heritages per era (the first, the last, one between), both sexes' first.
      const picks = [sexes[0], sexes[Math.floor(sexes.length / 2)], sexes[sexes.length - 1]];
      const pick = (n: number, k: number) => (n > 0 ? (k * 7 + 3) % n : 0);
      for (const { heritage, gender, sex } of picks) {
        const optionLeaves = await closureLeaves(real, chargenOptionIds(sex, builder.prefetchSources, heritage));
        for (let k = 0; k < 2; k++) {
          const a = {
            hairStyle: pick(sex.hairStyleList.length, k), hairColor: pick(sex.hairColorList.length, k), eyesStrip: pick(sex.eyeStripList.length, k),
            eyeColor: pick(sex.eyeColorList.length, k), skinColor: 0, noseStyle: pick(sex.noseStripList.length, k), mouthStyle: pick(sex.mouthStripList.length, k),
            headgearStyle: sex.headgearList.length ? pick(sex.headgearList.length, k) : -1, headgearColor: 0,
            shirtStyle: pick(sex.shirtList.length, k), shirtColor: k, pantsStyle: pick(sex.pantsList.length, k), pantsColor: 0,
            footwearStyle: pick(sex.footwearList.length, k), footwearColor: 0,
            skinHue: 0.3 + 0.4 * k, hairHue: 0.8 - 0.5 * k, headgearHue: 0.5, shirtHue: 0.2, pantsHue: 0.9, footwearHue: 0.6,
          };
          const critical = await closureLeaves(real, chargenAppearanceIds(sex, a, builder.prefetchSources));
          reads.clear();
          builder.buildCharacterModel(heritage, gender, a);
          const leaves = [...reads].filter((id) => isPortalLeaf(id) && real.hasFile(id));
          expect(leaves.length).toBeGreaterThan(0);
          const notWarm = leaves.filter((id) => !optionLeaves.has(id)).map((id) => id.toString(16));
          expect(notWarm, `${era.name} heritage ${heritage} gender ${gender} #${k}`).toEqual([]);
          const notCritical = leaves.filter((id) => !critical.has(id)).map((id) => id.toString(16));
          expect(notCritical, `${era.name} heritage ${heritage} gender ${gender} #${k} (critical)`).toEqual([]);
        }
      }
    }, 120_000);
  });
}
