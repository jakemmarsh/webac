/**
 * BUG.ac1999-point-light-falloff — the 1999 client lights every vertex's point lights through one
 * software function @ 0x583330 (static and dynamic lights, env cells and the objects in them),
 * where end of retail splits them between calc_point_light @ 0059c8b0 (static, env cells) and the
 * D3D hardware light (everything else). EraWorldRules.pointLight picks the formula; end of retail
 * and Dark Majesty are pinned unchanged.
 *
 * 0x583330 (light + 0x48 intensity, + 0x4c falloff, the DAT LightInfo's verbatim):
 *   D = light − vertex, d = |D|; if d < falloff: f = (0.5·d + side·N·D) × 0.6666667;
 *   if f > 0: I += intensity · f / (d² ≤ 1 ? d : d²·d).
 * The 1999 viewer light: SmartBox_SetBrightness @ 0x40df93 stores b·4.5 + b·4.5, and
 * SmartBox_set_viewer @ 0x40e2ad copies it into the light's intensity and falloff.
 *
 * Drives the shipped RetailLighting (JS mirrors + the real three.js Lambert shader patch +
 * applyRetailLighting's program key), EraWorldRules and ViewerLight.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { sliderBrightness, landscapeMinAmbient } from '../packages/renderer/src/era/EraWorldRules.js';
import {
  ac1999PointLight, applyRetailLighting, patchLambertVertex, pointLightCacheKey, pointLightRule,
  retailStaticPointLight, retailHardwarePointLight, retailLightRange, POINT_1999_DEFINE,
  AC1999_POINT_WRAP_BIAS, AC1999_POINT_WRAP_SCALE,
} from '../packages/renderer/src/models/RetailLighting.js';
import {
  createViewerLight, setViewerLightLevel, viewerLightLevel, VIEWER_LIGHT_FALLOFF, VIEWER_LIGHT_INTENSITY,
} from '../packages/renderer/src/effects/ViewerLight.js';
import {
  AC1999_MAX_LIGHT_CAPS, AC1999_STARTUP_LIGHT_CAPS, ac1999LightCaps, DatLightBudget, lightPoolRanksFromOwner,
} from '../packages/renderer/src/effects/DatLightBudget.js';
import { degradeLevelDerived } from '../packages/renderer/src/models/DegradeLod.js';

const R1999 = eraClientRules(eraProfile('ac1999-retail'));
const EOR = eraClientRules(eraProfile('eor'));
const DM = eraClientRules(eraProfile('classic-dereth'));

type V3 = [number, number, number];
const O: V3 = [0, 0, 0];
const UP: V3 = [0, 0, 1];
const WHITE: V3 = [1, 1, 1];

afterEach(() => { pointLightRule.value = 'd3d'; });

describe('the era rules', () => {
  it('1999 lights every point light in software (0x583330) with a brightness-driven viewer light; end of retail and Dark Majesty keep D3D', () => {
    expect(R1999.world.pointLight).toBe('software1999');
    expect(R1999.world.viewerLightPerBrightness).toBe(9);
    for (const r of [EOR, DM]) {
      expect(r.world.pointLight).toBe('d3d');
      expect(r.world.viewerLightPerBrightness).toBeNull();
    }
  });
});

describe('0x583330 — the 1999 point light, against hand-computed values', () => {
  it('the immediates: f = (0.5·d + N·D) × 0.6666667', () => {
    expect(AC1999_POINT_WRAP_BIAS).toBe(0.5);
    expect(AC1999_POINT_WRAP_SCALE).toBeCloseTo(2 / 3, 6);
  });

  it('straight overhead at 3 m, intensity 2, falloff 5: f = (1.5 + 3)·2/3 = 3, I = 2·3/27 = 0.2222', () => {
    expect(ac1999PointLight(O, UP, [0, 0, 3], 2, 5)).toBeCloseTo(2 * 3 / 27, 5);
  });

  it('inside a metre there is no 1/d²: 0.5 m overhead, intensity 1 → f = 0.5, I = f / d = 1', () => {
    expect(ac1999PointLight(O, UP, [0, 0, 0.5], 1, 5)).toBeCloseTo(1, 5);
    // and the sum is not capped per light (0x5834a0 clamps the vertex total, not each light)
    expect(ac1999PointLight(O, UP, [0, 0, 0.5], 3, 5)).toBeCloseTo(3, 5);
  });

  it('the wrap: a 90° wall takes a third, 120° nothing', () => {
    // N·D = 0, f = 1.5·2/3 = 1, I = 1 / 27
    expect(ac1999PointLight(O, UP, [3, 0, 0], 1, 5)).toBeCloseTo(1 / 27, 5);
    const a = (120 * Math.PI) / 180;
    expect(ac1999PointLight(O, UP, [3 * Math.sin(a), 0, 3 * Math.cos(a)], 1, 5)).toBeCloseTo(0, 6);
  });

  it('the range is the falloff itself (a hard edge), not falloff × 1.3 or × 1.5', () => {
    expect(ac1999PointLight(O, UP, [0, 0, 4.99], 1, 5)).toBeCloseTo(1 / (4.99 * 4.99), 5);
    expect(ac1999PointLight(O, UP, [0, 0, 5], 1, 5)).toBe(0);
    expect(ac1999PointLight(O, UP, [0, 0, 6], 1, 5)).toBe(0);
    // end of retail still reaches 6 m on both paths
    expect(retailStaticPointLight(O, UP, [0, 0, 6], WHITE, 1, 5)[0]).toBeGreaterThan(0);
    expect(retailHardwarePointLight(O, UP, [0, 0, 6], WHITE, 1, 5)[0]).toBeGreaterThan(0);
  });

  it('the back copy (side −1) takes the light of −N', () => {
    expect(ac1999PointLight(O, UP, [0, 0, -3], 2, 5, -1)).toBeCloseTo(2 * 3 / 27, 5);
    expect(ac1999PointLight(O, UP, [0, 0, -3], 2, 5)).toBe(0);
  });

  it('against end of retail at the same light: no (1 − d/range) window on env cells, and objects lose the hardware 1/d', () => {
    // a static light on an env cell at 3 m: EoL (1 − 3/6.5)·2·1/9 = 0.1197; 1999 2/9 = 0.2222
    const eol = retailStaticPointLight(O, UP, [0, 0, 3], WHITE, 2, 5)[0];
    expect(eol).toBeCloseTo((1 - 3 / 6.5) * 2 / 9, 5);
    expect(ac1999PointLight(O, UP, [0, 0, 3], 2, 5) / eol).toBeCloseTo(1 / (1 - 3 / 6.5), 5);
    // an object at 3 m: EoL hardware 2·1/3 = 0.667; 1999 0.2222
    expect(retailHardwarePointLight(O, UP, [0, 0, 3], WHITE, 2, 5)[0]).toBeCloseTo(2 / 3, 5);
  });
});

describe('the shader patch follows the rule', () => {
  const vsrc = THREE.ShaderLib.lambert.vertexShader;

  it('software1999 compiles the 0x583330 branch in for every kind with point lights; d3d leaves the shader as it was', () => {
    for (const kind of ['envcell', 'cellobject', 'object'] as const) {
      const v99 = patchLambertVertex(vsrc, kind, 'software1999');
      const eol = patchLambertVertex(vsrc, kind, 'd3d');
      expect(v99).toContain(`#define ${POINT_1999_DEFINE}\n`);
      expect(eol).not.toContain(`#define ${POINT_1999_DEFINE}`);
      // the same text otherwise: the branch is preprocessor-selected
      expect(v99.replace(`#define ${POINT_1999_DEFINE}\n`, '')).toBe(eol);
      // the default is the boot-time rule
      expect(patchLambertVertex(vsrc, kind)).toBe(eol);
    }
    const v = patchLambertVertex(vsrc, 'envcell', 'software1999');
    const branch = v.slice(v.indexOf(`#ifdef ${POINT_1999_DEFINE}`), v.indexOf('#else', v.indexOf(`#ifdef ${POINT_1999_DEFINE}`)));
    expect(branch).toContain('if ( d >= light.distance / 1.5 ) return vec3( 0.0 );');
    expect(branch).toContain('float f99 = ( 0.5 * d + dot( n, lv ) ) * 0.6666667;');
    expect(branch).toContain('return light.color * ( d * d <= 1.0 ? f99 / d : f99 / ( d * d * d ) );');
    // end of retail's calc_point_light and hardware term sit in the #else
    const rest = v.slice(v.indexOf('#else', v.indexOf(`#ifdef ${POINT_1999_DEFINE}`)));
    expect(rest).toContain('if ( light.decay < 0.0 ) {');
    expect(rest).toContain('return light.color * saturate( dot( n, lv ) / d ) / d;');
  });

  it('the program key carries the rule (end of retail\'s keys unchanged)', () => {
    expect(pointLightCacheKey('d3d')).toBe('');
    expect(pointLightCacheKey('software1999')).toBe('|acPoint:software1999');
    const eolMat = applyRetailLighting(new THREE.MeshLambertMaterial(), 'envcell');
    pointLightRule.value = 'software1999';
    const m99 = applyRetailLighting(new THREE.MeshLambertMaterial(), 'envcell');
    expect(eolMat.customProgramCacheKey()).not.toContain('acPoint');
    expect(m99.customProgramCacheKey()).toBe(`${eolMat.customProgramCacheKey()}|acPoint:software1999`);
    // the compile step injects the define the material was made under
    const shader = { vertexShader: vsrc, fragmentShader: THREE.ShaderLib.lambert.fragmentShader, uniforms: {} } as unknown as THREE.WebGLProgramParametersWithUniforms;
    pointLightRule.value = 'd3d';
    m99.onBeforeCompile(shader, {} as THREE.WebGLRenderer);
    expect(shader.vertexShader).toContain(`#define ${POINT_1999_DEFINE}`);
  });
});

describe('the viewer light', () => {
  it('end of retail: the fixed 2.25 / 10 whatever the slider', () => {
    for (const b of [0, 0.5, 1]) expect(viewerLightLevel(EOR.world.viewerLightPerBrightness, b)).toEqual({ intensity: VIEWER_LIGHT_INTENSITY, falloff: VIEWER_LIGHT_FALLOFF });
    expect(VIEWER_LIGHT_INTENSITY).toBe(2.25);
  });

  it('1999: intensity = falloff = b·4.5 + b·4.5 (0x40df93 → 0x40e2ad), 4.5 at the default', () => {
    expect(sliderBrightness(0)).toBe(0.5);
    expect(viewerLightLevel(R1999.world.viewerLightPerBrightness, sliderBrightness(0))).toEqual({ intensity: 4.5, falloff: 4.5 });
    expect(viewerLightLevel(R1999.world.viewerLightPerBrightness, sliderBrightness(1))).toEqual({ intensity: 9, falloff: 9 });
    // the same b as the landscape floor (min_ambient = b·0.3 + 0.2)
    expect(landscapeMinAmbient(R1999.world, 0)).toBeCloseTo(0.35, 6);
    const light = createViewerLight();
    setViewerLightLevel(light, viewerLightLevel(9, 0.5));
    expect(light.intensity).toBe(4.5);
    expect(light.distance).toBeCloseTo(retailLightRange(4.5), 6);
    // under the 1999 rule the shader's range is distance / 1.5 = the falloff, 4.5 m
    expect(light.distance / 1.5).toBeCloseTo(4.5, 6);
  });
});

describe('the 1999 light pool (0x43f7b0 / 0x43ffd0), EraWorldRules.lightPool', () => {
  function heldLight(root: THREE.Object3D, holderX: number, lightX: number): THREE.PointLight {
    const holder = new THREE.Object3D();
    holder.position.set(holderX, 0, 0);
    const l = new THREE.PointLight(0xffffff, 1, 10, 1);
    l.position.set(lightX, 0, 0); // the LightInfo offset, relative to its owner
    l.userData.datLight = true;
    l.visible = false;
    holder.add(l);
    root.add(holder);
    return l;
  }

  it('the era rules: 1999 its own pool, end of retail and Dark Majesty unchanged', () => {
    expect(R1999.world.lightPool).toBe('ac1999');
    expect(EOR.world.lightPool).toBe('eor');
    expect(DM.world.lightPool).toBe('eor');
  });

  it('caps: 20 + 10·L static, 7 + 3·L / 7 + 2·L dynamic, truncated (end of retail 40 + 20·L)', () => {
    expect(ac1999LightCaps(0)).toEqual(AC1999_STARTUP_LIGHT_CAPS);
    expect(AC1999_STARTUP_LIGHT_CAPS).toEqual({ maxStaticLights: 20, maxDynamicLights: 7 });
    expect(ac1999LightCaps(1)).toEqual(AC1999_MAX_LIGHT_CAPS);
    expect(AC1999_MAX_LIGHT_CAPS).toEqual({ maxStaticLights: 30, maxDynamicLights: 10 });
    expect(ac1999LightCaps(-1)).toEqual({ maxStaticLights: 10, maxDynamicLights: 5 });
    expect(ac1999LightCaps(0.5)).toEqual({ maxStaticLights: 25, maxDynamicLights: 8 }); // 8.5 -> 8
    expect(ac1999LightCaps(-0.15)).toEqual({ maxStaticLights: 18, maxDynamicLights: 6 }); // 18.5 -> 18, 6.7 -> 6
    expect(ac1999LightCaps(3)).toEqual({ maxStaticLights: 30, maxDynamicLights: 10 }); // clamped
    // end of retail's derivation is untouched
    expect(degradeLevelDerived(0)).toMatchObject({ maxStaticLights: 40, maxDynamicLights: 7 });
    expect(degradeLevelDerived(1)).toMatchObject({ maxStaticLights: 60, maxDynamicLights: 10 });
  });

  it('every era ranks a light by its owner origin (0054d1b0 / 0x43f7b0 measure from the frame they are handed)', () => {
    // A: owner 10 m away, light offset back to 1 m. B: owner 5 m away, light out at 9 m.
    const caps = { maxStaticLights: 1, maxDynamicLights: 7 };
    for (const rules of [EOR, DM, R1999]) {
      const root = new THREE.Group();
      const a = heldLight(root, 10, -9);
      const b = heldLight(root, 5, 4);
      root.updateMatrixWorld(true);
      const budget = new DatLightBudget(root);
      budget.rankFromHolder = lightPoolRanksFromOwner(rules.world.lightPool); // as main.ts does
      budget.update(new THREE.Vector3(0, 0, 0), 0, caps);
      expect([a.visible, b.visible]).toEqual([false, true]); // owners 10 m vs 5 m (not lights 1 m vs 9 m)
    }
    // the flag off (probes) ranks by the light's own position
    const root = new THREE.Group();
    const a = heldLight(root, 10, -9);
    const b = heldLight(root, 5, 4);
    root.updateMatrixWorld(true);
    const byLight = new DatLightBudget(root);
    byLight.update(new THREE.Vector3(0, 0, 0), 0, caps);
    expect([a.visible, b.visible]).toEqual([true, false]);
  });

  it('a light hung straight off the root (no owner) keeps its own position', () => {
    const root = new THREE.Group();
    const near = new THREE.PointLight(0xffffff, 1, 10, 1);
    near.position.set(1, 0, 0);
    near.userData.datLight = true;
    root.add(near);
    const owned = heldLight(root, 3, 0);
    root.updateMatrixWorld(true);
    const budget = new DatLightBudget(root);
    budget.rankFromHolder = true;
    budget.update(new THREE.Vector3(0, 0, 0), 0, { maxStaticLights: 1, maxDynamicLights: 7 });
    expect([near.visible, owned.visible]).toEqual([true, false]);
  });

  it('a full list keeps the nearest, a tie keeps the one already in the list, and the farthest drops', () => {
    const root = new THREE.Group();
    const first = heldLight(root, 3, 0);
    const tie = heldLight(root, -3, 0); // same distance, inserted after: behind `first`
    const near = heldLight(root, 1, 0);
    const far = heldLight(root, 7, 0);
    root.updateMatrixWorld(true);
    const budget = new DatLightBudget(root);
    budget.rankFromHolder = true;
    budget.update(new THREE.Vector3(0, 0, 0), 0, { maxStaticLights: 2, maxDynamicLights: 7 });
    expect([near.visible, first.visible, tie.visible, far.visible]).toEqual([true, true, false, false]);
    budget.update(new THREE.Vector3(0, 0, 0), 1, { maxStaticLights: 3, maxDynamicLights: 7 });
    expect([near.visible, first.visible, tie.visible, far.visible]).toEqual([true, true, true, false]);
  });

  it('a tracked static object light is ranked where its object is now, not where it was built', () => {
    const root = new THREE.Group();
    const obj = new THREE.Object3D();
    root.add(obj);
    const l = new THREE.PointLight(0xffffff, 1, 10, 1);
    l.userData.datLight = true;
    l.userData.datLightTracked = true; // a static object light (no datLightDynamic)
    obj.add(l);
    const other = heldLight(root, 5, 0);
    root.updateMatrixWorld(true);
    const budget = new DatLightBudget(root);
    budget.rankFromHolder = true;
    budget.track(l);
    obj.position.set(2, 0, 0);
    root.updateMatrixWorld(true);
    budget.update(new THREE.Vector3(0, 0, 0), 0, { maxStaticLights: 1, maxDynamicLights: 7 });
    expect([l.visible, other.visible]).toEqual([true, false]);
    obj.position.set(8, 0, 0);
    root.updateMatrixWorld(true);
    budget.update(new THREE.Vector3(0, 0, 0), 1, { maxStaticLights: 1, maxDynamicLights: 7 });
    expect([l.visible, other.visible]).toEqual([false, true]);
  });
});
