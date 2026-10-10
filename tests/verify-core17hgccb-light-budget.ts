/**
 * CORE.17.h.g.c.c.b — the retail world-light pool: Render::world_lights'
 * distance-sorted static + dynamic lists under SetDegradeLevelInternal's
 * caps (max_static_lights 40 / max_dynamic_lights 7 at deg_mul 0; 20 / 5 at
 * −1; 60 / 10 at +1), fed from the visible cells only, plus the device
 * measures (uniform-budget cap, program-variant fillers) and the viewer
 * light's active test (SmartBox::RenderNormalMode: an outdoor viewer draws
 * under useSunlightSet(1) — sun only).
 *
 * Behavioral: drives the real DatLightBudget over a three.js scene graph.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  DatLightBudget, RETAIL_STARTUP_LIGHT_CAPS, RETAIL_OBJECT_LIGHT_SLOTS,
  deviceLightLimit, paddedLightCount, ancestorsVisible,
  DEVICE_UNIFORM_RESERVE, UNIFORM_VECTORS_PER_POINT_LIGHT, DEFAULT_FILLER_STEP,
} from '../packages/renderer/src/effects/DatLightBudget.js';
import { degradeLevelDerived, DegMulController } from '../packages/renderer/src/models/DegradeLod.js';
import { viewerLightActive, createViewerLight } from '../packages/renderer/src/effects/ViewerLight.js';

function datLight(x: number, opts: { dynamic?: boolean; parent?: THREE.Object3D } = {}): THREE.PointLight {
  const l = new THREE.PointLight(0xffffff, 1, 10, 1);
  l.position.set(x, 0, 0);
  l.userData.datLight = true;
  if (opts.dynamic) l.userData.datLightDynamic = true;
  l.visible = false;
  opts.parent?.add(l);
  return l;
}

function fillerCount(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => { if (o.userData.datLightFiller && o.visible) n++; });
  return n;
}

describe('CORE.17.h.g.c.c.b — the static list takes the retail cap, not 8', () => {
  it('startup caps are 40 static / 7 dynamic (.data 0x81ec94 / 0x81ec98) and match degradeLevelDerived(0)', () => {
    expect(RETAIL_STARTUP_LIGHT_CAPS).toEqual({ maxStaticLights: 40, maxDynamicLights: 7 });
    const d = degradeLevelDerived(0);
    expect(d.maxStaticLights).toBe(RETAIL_STARTUP_LIGHT_CAPS.maxStaticLights);
    expect(d.maxDynamicLights).toBe(RETAIL_STARTUP_LIGHT_CAPS.maxDynamicLights);
    expect(RETAIL_OBJECT_LIGHT_SLOTS).toBe(8);
  });

  it('enables the nearest max_static_lights (40) of 60 static lights, sorted from the origin', () => {
    const root = new THREE.Group();
    const lights: THREE.PointLight[] = [];
    for (let i = 0; i < 60; i++) lights.push(datLight(i * 5, { parent: root })); // 0..295
    root.updateMatrixWorld(true);
    const budget = new DatLightBudget(root);
    budget.update(new THREE.Vector3(0, 0, 0), 0);
    expect(budget.lightCount).toBe(60);
    expect(budget.activeCount).toBe(40);
    for (let i = 0; i < 60; i++) expect(lights[i].visible).toBe(i < 40);
    // the origin moves to the far end — the list re-sorts to the far 40
    budget.update(new THREE.Vector3(295, 0, 0), 1);
    for (let i = 0; i < 60; i++) expect(lights[i].visible).toBe(i >= 20);
    const c = budget.census();
    expect(c).toMatchObject({ known: 60, pooled: 60, staticActive: 40, dynamicActive: 0, fillers: 0 });
    expect(c.caps).toEqual({ maxStaticLights: 40, maxDynamicLights: 7 });
  });

  it('the lists are split: dynamic lights count against max_dynamic_lights only', () => {
    const root = new THREE.Group();
    const statics = Array.from({ length: 10 }, (_, i) => datLight(i, { parent: root }));
    const dynamics = Array.from({ length: 10 }, (_, i) => datLight(100 + i, { parent: root, dynamic: true }));
    root.updateMatrixWorld(true);
    const budget = new DatLightBudget(root);
    budget.update(new THREE.Vector3(0, 0, 0), 0, { maxStaticLights: 3, maxDynamicLights: 7 });
    expect(statics.map(l => l.visible)).toEqual([true, true, true, false, false, false, false, false, false, false]);
    // the dynamics are far away yet all 7 slots are theirs — separate list
    expect(dynamics.filter(l => l.visible).length).toBe(7);
    expect(dynamics.slice(0, 7).every(l => l.visible)).toBe(true);
    expect(dynamics.slice(7).some(l => l.visible)).toBe(false);
    expect(budget.census()).toMatchObject({ staticActive: 3, dynamicActive: 7 });
  });

  it('consumes DegMulController.derived: deg_mul −1 → 20 / 5, +1 → 60 / 10', () => {
    const root = new THREE.Group();
    const statics = Array.from({ length: 70 }, (_, i) => datLight(i, { parent: root }));
    const dynamics = Array.from({ length: 12 }, (_, i) => datLight(200 + i, { parent: root, dynamic: true }));
    root.updateMatrixWorld(true);
    const ctl = new DegMulController();
    const budget = new DatLightBudget(root);
    ctl.set(-1);
    budget.update(new THREE.Vector3(), 0, ctl.derived);
    expect(statics.filter(l => l.visible).length).toBe(20);
    expect(dynamics.filter(l => l.visible).length).toBe(5);
    ctl.set(1);
    budget.update(new THREE.Vector3(), 1, ctl.derived);
    expect(statics.filter(l => l.visible).length).toBe(60);
    expect(dynamics.filter(l => l.visible).length).toBe(10);
    ctl.set(0);
    budget.update(new THREE.Vector3(), 2, ctl.derived);
    expect(statics.filter(l => l.visible).length).toBe(40);
    expect(dynamics.filter(l => l.visible).length).toBe(7);
  });

  it('a light under a hidden cell group is not pooled (CEnvCell::visible_cell_table), and returns when the cell shows', () => {
    const root = new THREE.Group();
    const shown = new THREE.Group();
    const hidden = new THREE.Group();
    hidden.visible = false;
    root.add(shown, hidden);
    const near = datLight(1, { parent: hidden });   // nearest, but its cell is hidden
    const far = datLight(50, { parent: shown });
    root.updateMatrixWorld(true);
    expect(ancestorsVisible(near)).toBe(false);
    expect(ancestorsVisible(far)).toBe(true);
    const budget = new DatLightBudget(root);
    budget.update(new THREE.Vector3(), 0, { maxStaticLights: 1, maxDynamicLights: 0 });
    expect(near.visible).toBe(false);
    expect(far.visible).toBe(true);
    expect(budget.census()).toMatchObject({ known: 2, pooled: 1, staticActive: 1 });
    hidden.visible = true;
    budget.update(new THREE.Vector3(), 1, { maxStaticLights: 1, maxDynamicLights: 0 }); // same gather, per-frame visibility
    expect(near.visible).toBe(true);
    expect(far.visible).toBe(false);
  });

  it('static positions are cached at gather time; dynamic lights are re-read every update', () => {
    const root = new THREE.Group();
    const s = datLight(0, { parent: root });
    const d = datLight(0, { parent: root, dynamic: true });
    root.updateMatrixWorld(true);
    const budget = new DatLightBudget(root);
    budget.update(new THREE.Vector3(), 0, { maxStaticLights: 1, maxDynamicLights: 1 });
    expect(s.visible && d.visible).toBe(true);
    // a second static light appears nearer than the first, which walks away —
    // within the refresh window the first is still ranked at its cached spot
    const s2 = datLight(5, { parent: root });
    s.position.set(100, 0, 0);
    d.position.set(100, 0, 0);
    root.updateMatrixWorld(true);
    budget.update(new THREE.Vector3(), 100, { maxStaticLights: 1, maxDynamicLights: 1 });
    expect(s2.visible).toBe(false);          // not gathered yet
    expect(s.visible).toBe(true);
    expect(d.visible).toBe(true);            // the only dynamic light — still in
    // after the refresh, s2 (5 m) wins over s (100 m)
    budget.invalidate();
    budget.update(new THREE.Vector3(), 200, { maxStaticLights: 1, maxDynamicLights: 1 });
    expect(s2.visible).toBe(true);
    expect(s.visible).toBe(false);
  });

  it('equal distances keep insertion order (insert_light inserts after equals)', () => {
    const root = new THREE.Group();
    const a = datLight(3, { parent: root });
    const b = datLight(3, { parent: root });
    root.updateMatrixWorld(true);
    const budget = new DatLightBudget(root);
    budget.update(new THREE.Vector3(), 0, { maxStaticLights: 1, maxDynamicLights: 0 });
    expect(a.visible).toBe(true);
    expect(b.visible).toBe(false);
  });
});

describe('CORE.17.h.g.c.c.b — device measures (invisible)', () => {
  it('deviceLightLimit: (the light stage\'s MAX_*_UNIFORM_VECTORS − reserve) / 4, floored at the 8 object slots, unlimited when unknown', () => {
    expect(deviceLightLimit(1024)).toBe(Math.floor((1024 - DEVICE_UNIFORM_RESERVE) / UNIFORM_VECTORS_PER_POINT_LIGHT));
    expect(deviceLightLimit(224)).toBe(40);
    expect(deviceLightLimit(64)).toBe(RETAIL_OBJECT_LIGHT_SLOTS);
    expect(deviceLightLimit(0)).toBe(Infinity);
    expect(deviceLightLimit(NaN)).toBe(Infinity);
  });

  it('deviceMaxLights caps the enabled total, dynamic lights taking their slots first', () => {
    const root = new THREE.Group();
    const statics = Array.from({ length: 20 }, (_, i) => datLight(i, { parent: root }));
    const dynamics = Array.from({ length: 4 }, (_, i) => datLight(100 + i, { parent: root, dynamic: true }));
    root.updateMatrixWorld(true);
    const budget = new DatLightBudget(root, { deviceMaxLights: 10 });
    budget.update(new THREE.Vector3(), 0);
    expect(dynamics.filter(l => l.visible).length).toBe(4);
    expect(statics.filter(l => l.visible).length).toBe(6);
    expect(statics.slice(0, 6).every(l => l.visible)).toBe(true);
    expect(budget.census()).toMatchObject({ staticActive: 6, dynamicActive: 4, deviceMaxLights: 10 });
  });

  it('paddedLightCount rounds up to the step, never past the device cap, and leaves 0 at 0', () => {
    expect(paddedLightCount(0, 8, Infinity)).toBe(0);
    expect(paddedLightCount(1, 8, Infinity)).toBe(8);
    expect(paddedLightCount(8, 8, Infinity)).toBe(8);
    expect(paddedLightCount(9, 8, Infinity)).toBe(16);
    expect(paddedLightCount(38, 8, 40)).toBe(40);
    expect(paddedLightCount(38, 0, 40)).toBe(38);
    expect(paddedLightCount(38, 1, 40)).toBe(38);
    expect(DEFAULT_FILLER_STEP).toBe(8);
  });

  it('fillers: zero-intensity lights pad the enabled count to a multiple of the step and retire as it shrinks', () => {
    const root = new THREE.Group();
    const statics = Array.from({ length: 11 }, (_, i) => datLight(i, { parent: root }));
    root.updateMatrixWorld(true);
    const budget = new DatLightBudget(root, { fillerStep: 8 });
    budget.update(new THREE.Vector3(), 0);
    expect(statics.every(l => l.visible)).toBe(true);
    expect(budget.activeCount).toBe(11);
    expect(budget.fillerCount).toBe(5);
    expect(fillerCount(root)).toBe(5);
    let fillerIntensity = -1;
    root.traverse((o) => { if (o.userData.datLightFiller) fillerIntensity = (o as THREE.PointLight).intensity; });
    expect(fillerIntensity).toBe(0);
    // the fillers are not gathered as DAT lights on the next refresh
    budget.invalidate();
    budget.update(new THREE.Vector3(), 5000);
    expect(budget.lightCount).toBe(11);
    // cap at 3 → 3 enabled + 5 fillers = 8
    budget.update(new THREE.Vector3(), 5001, { maxStaticLights: 3, maxDynamicLights: 0 });
    expect(budget.activeCount).toBe(3);
    expect(budget.fillerCount).toBe(5);
    // nothing enabled → no fillers at all (outdoors stays the cheapest program)
    budget.update(new THREE.Vector3(), 5002, { maxStaticLights: 0, maxDynamicLights: 0 });
    expect(budget.activeCount).toBe(0);
    expect(budget.fillerCount).toBe(0);
    expect(fillerCount(root)).toBe(0);
    // the step is probe-mutable: 0 turns the padding off for a live A/B
    budget.fillerStep = 0;
    budget.update(new THREE.Vector3(), 5003, { maxStaticLights: 3, maxDynamicLights: 0 });
    expect(budget.activeCount).toBe(3);
    expect(budget.fillerCount).toBe(0);
  });

  it('capsOverride (probe A/B hook) replaces the caps passed in', () => {
    const root = new THREE.Group();
    const statics = Array.from({ length: 12 }, (_, i) => datLight(i, { parent: root }));
    root.updateMatrixWorld(true);
    const budget = new DatLightBudget(root);
    budget.capsOverride = { maxStaticLights: 8, maxDynamicLights: 0 };
    budget.update(new THREE.Vector3(), 0, RETAIL_STARTUP_LIGHT_CAPS);
    expect(statics.filter(l => l.visible).length).toBe(8);
    expect(budget.census().caps).toEqual({ maxStaticLights: 8, maxDynamicLights: 0 });
    budget.capsOverride = null;
    budget.update(new THREE.Vector3(), 1, RETAIL_STARTUP_LIGHT_CAPS);
    expect(statics.filter(l => l.visible).length).toBe(12);
  });
});

describe('CORE.17.h.g.c.c.b — the viewer light is active only inside a cell (useSunlight == 0)', () => {
  it('RenderNormalMode\'s test: low word < 0x100 is outdoors (sun only); an env cell is active; 0 is outdoors', () => {
    expect(viewerLightActive(0)).toBe(false);
    expect(viewerLightActive(0xa9b40000)).toBe(false);   // landblock, no cell
    expect(viewerLightActive(0xa9b400ff)).toBe(false);   // land cell 0xff
    expect(viewerLightActive(0xa9b40100)).toBe(true);    // first env cell
    expect(viewerLightActive(0x86020115)).toBe(true);    // Training Academy
    expect(viewerLightActive(0x8602ffff)).toBe(true);
  });

  it('the viewer light is not a DAT light — the budget never toggles it', () => {
    const root = new THREE.Group();
    const vl = createViewerLight();
    vl.visible = true;
    root.add(vl);
    datLight(1, { parent: root });
    root.updateMatrixWorld(true);
    const budget = new DatLightBudget(root);
    budget.update(new THREE.Vector3(), 0, { maxStaticLights: 0, maxDynamicLights: 0 });
    expect(budget.lightCount).toBe(1);
    expect(vl.visible).toBe(true);
  });
});
