/**
 * CORE.9.d — sky render model matches retail GameSky.
 *
 * Ground truth (EoL portal.dat region 0x13000000, Sunny group; decompiled
 * client GameSky::MakeObject/Draw/UseTime @ 00506ee0/005075b0, material
 * setup ~399334-399357 with luminosity*0.01 at ~253762-253765):
 *  - obj[0] 0x10015ee is a 6-faced sky BOX with transparent=-1 (always
 *    visible) and a luminosity column that IS the day/night transition
 *    (lum=11 at night → 100 at midday, rotate=270). Retail draws it
 *    OPAQUE, unlit, Emissive = luminosity/100 — it is the sky itself.
 *  - obj[1] 0x10015ef is the star dome: transparent=0 at night (opaque
 *    stars) → 100 by day (invisible), luminosity=0 throughout (no
 *    emissive scaling — the texture draws as-is).
 *  - Every sky object is created and drawn in DAT index order
 *    (before_sky_cell); nothing is skipped as a "static dome".
 *
 * The pre-CORE.9.d model drew the sky box additive with INVERTED
 * luminosity (1-lum) over a procedural gradient — producing the Sunny
 * face-seam "V-lines" (additive overlap at face boundaries) and a
 * day-bright night sky (lum=11 at 1AM → 89% of the day sky added) — and
 * skipped the star dome entirely, so stars never rendered.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { SkyboxRenderer } from '../packages/renderer/src/effects/SkyboxRenderer.js';

/** Replace-table row (SkyObjectReplace). */
function rep(objectIndex: number, transparent: number, luminosity: number, rotate = 0) {
  return { objectIndex, gfxObjId: 0, rotate, transparent, luminosity, maxBright: luminosity };
}

function timeEntry(begin: number, skyObjReplace: ReturnType<typeof rep>[] = []) {
  return {
    begin, dirBright: 1, dirHeading: 0, dirPitch: 45, dirColor: 0xffffffff,
    ambBright: 0.5, ambColor: 0xffffffff, minWorldFog: 0, maxWorldFog: 1000,
    worldFogColor: 0xffffffff, worldFog: 0, skyObjReplace,
  };
}

function skyObject(over: Partial<Record<string, number>> = {}) {
  return {
    beginTime: 0, endTime: 0, beginAngle: 0, endAngle: 0,
    texVelocityX: 0, texVelocityY: 0,
    defaultGFXObjectId: 0x010015ee, defaultPESObjectId: 0,
    properties: 0,
    ...over,
  };
}

/**
 * Synthetic Sunny group mirroring the real DAT shape: sky box (idx 0,
 * tr=-1, lum 11 night / 100 day, rot=270) + star dome (idx 1, tr 0
 * night / 100 day, lum=0). Night at t=0, day at t=0.5.
 */
function makeSunnySky(): SkyboxRenderer {
  const desc = {
    tickSize: 30, lightTickSize: 30,
    dayGroups: [{
      chanceOfOccur: 5, dayName: 'Sunny',
      skyObjects: [
        skyObject({ defaultGFXObjectId: 0x010015ee }),
        skyObject({ defaultGFXObjectId: 0x010015ef }),
      ],
      skyTime: [
        timeEntry(0, [rep(0, -1, 11, 270), rep(1, 0, 0)]),
        timeEntry(0.5, [rep(0, -1, 100, 270), rep(1, 100, 0)]),
      ],
    }],
  } as never;
  const sky = new SkyboxRenderer(desc, { dayLength: 10 } as never);
  sky.initSkyObjects(stubModelRenderer());
  return sky;
}

/** Minimal ModelRenderer stub: every GfxObj id resolves to one textured mesh. */
function stubModelRenderer() {
  return {
    createMesh: () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial()));
      return g;
    },
  } as never;
}

function pivots(sky: SkyboxRenderer): THREE.Group[] {
  return (sky.skyObjectsGroup?.children ?? []) as THREE.Group[];
}

function pivotMaterial(pivot: THREE.Group): THREE.MeshBasicMaterial {
  let mat: THREE.MeshBasicMaterial | null = null;
  pivot.traverse((c) => {
    if (c instanceof THREE.Mesh && !mat) mat = c.material as THREE.MeshBasicMaterial;
  });
  if (!mat) throw new Error('pivot has no mesh material');
  return mat;
}

describe('CORE.9.d — base sky box (transparent=-1) drawn as THE sky', () => {
  it('renders opaque with normal blending, never additive', () => {
    const sky = makeSunnySky();
    const mat = pivotMaterial(pivots(sky)[0]);
    expect(mat.transparent).toBe(false);
    expect(mat.blending).toBe(THREE.NormalBlending);
    // behind the world: no depth interaction, drawn first
    expect(mat.depthTest).toBe(false);
    expect(mat.depthWrite).toBe(false);
  });

  it('brightness = luminosity/100 (NOT inverted): dark at night, full by day', () => {
    const sky = makeSunnySky();
    const mat = pivotMaterial(pivots(sky)[0]) as unknown as THREE.MeshLambertMaterial;

    // VISUAL.night-sky-vs-retail — the luminosity is the D3D material
    // Emissive (GameSky::UseTime → CMaterial::SetLuminositySimple), summed
    // with the world ambient + sun in gamma space by the retail-lit 'sky'
    // kind (RetailLighting), not a colour multiplier; the texel stays white.
    sky.updateTimeOfDay(0.0); // night: DAT lum=11
    expect(mat.emissive.r).toBeCloseTo(0.11, 2);
    // the old inverted model would have given 1-0.11=0.89 here
    expect(mat.emissive.r).toBeLessThan(0.2);
    expect(mat.color.r).toBe(1);
    expect(pivots(sky)[0].visible).toBe(true);

    sky.updateTimeOfDay(0.5); // day: DAT lum=100
    expect(mat.emissive.r).toBeCloseTo(1.0, 2);
    expect(pivots(sky)[0].visible).toBe(true);
  });

  it('stays visible at every hour (transparent=-1 = always visible)', () => {
    const sky = makeSunnySky();
    for (const t of [0.0, 0.05, 0.18, 0.25, 0.5, 0.75, 0.9, 0.99]) {
      sky.updateTimeOfDay(t);
      expect(pivots(sky)[0].visible).toBe(true);
    }
  });

  it('applies the DAT static rotation (rotate=270 about the vertical axis)', () => {
    const sky = makeSunnySky();
    sky.updateTimeOfDay(0.0);
    expect(pivots(sky)[0].rotation.y).toBeCloseTo(270 * Math.PI / 180, 5);
  });

  it('rotate is the PREVIOUS keyframe\'s heading, never interpolated (SkyDesc::GetSky @ 00501ec0)', () => {
    const desc = {
      tickSize: 30, lightTickSize: 30,
      dayGroups: [{
        chanceOfOccur: 5, dayName: 'Turning',
        skyObjects: [skyObject({ defaultGFXObjectId: 0x010015ee })],
        skyTime: [
          timeEntry(0, [rep(0, -1, 50, 90)]),
          timeEntry(0.5, [rep(0, -1, 50, 270)]),
        ],
      }],
    } as never;
    const sky = new SkyboxRenderer(desc, { dayLength: 10 } as never);
    sky.initSkyObjects(stubModelRenderer());
    sky.updateTimeOfDay(0.25); // halfway between the keyframes: a lerp would give 180
    expect(pivots(sky)[0].rotation.y).toBeCloseTo(90 * Math.PI / 180, 5);
    sky.updateTimeOfDay(0.75);
    expect(pivots(sky)[0].rotation.y).toBeCloseTo(270 * Math.PI / 180, 5);
  });
});

describe('CORE.9.d — star dome overlay (previously never rendered)', () => {
  it('is created (not skipped as a static dome)', () => {
    const sky = makeSunnySky();
    expect(pivots(sky).length).toBe(2);
    expect(pivots(sky)[1].name.startsWith('sky_obj_1_')).toBe(true);
  });

  it('opacity from the transparent column: opaque at night, invisible by day', () => {
    const sky = makeSunnySky();
    const mat = pivotMaterial(pivots(sky)[1]);

    sky.updateTimeOfDay(0.0); // night: tr=0 → opaque stars
    expect(mat.opacity).toBeCloseTo(1.0, 2);
    expect(pivots(sky)[1].visible).toBe(true);

    sky.updateTimeOfDay(0.5); // day: tr=100 → invisible
    expect(mat.opacity).toBeCloseTo(0.0, 2);
    expect(pivots(sky)[1].visible).toBe(false);
  });

  it('lum=0 draws the texture as-is (no emissive scaling to black)', () => {
    const sky = makeSunnySky();
    const mat = pivotMaterial(pivots(sky)[1]);
    sky.updateTimeOfDay(0.0);
    // the cloud formula (opacity * max(0.1, lum)) would give 0.1 here —
    // near-black stars. VISUAL.night-sky-vs-retail: the texel stays white and
    // retail LIGHTS it (Emissive 0 + the world ambient + the sun), which is
    // what dims the night stars to the ambient's purple.
    expect(mat.color.r).toBeCloseTo(1.0, 2);
    expect((mat as unknown as THREE.MeshLambertMaterial).emissive.r).toBe(0);
  });

  it('alpha-composites over the base sky (not additive)', () => {
    const sky = makeSunnySky();
    const mat = pivotMaterial(pivots(sky)[1]);
    expect(mat.blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
  });
});

describe('CORE.9.d — eye-plane epsilon offset (SwiftShader w=0 degeneracy)', () => {
  it('sky object group follows the camera at a small fixed offset, never dead-center', () => {
    // A perfectly camera-centered sky box puts horizon-ring vertices at
    // clip w=0 for 45°-multiple yaws; SwiftShader then rasterizes the face
    // as a uniform clamp-corner slab. The offset keeps w off exact zero.
    const sky = makeSunnySky();
    const cam = new THREE.Vector3(1000, 50, 2000);
    sky.updateSkyObjectPositions(cam);
    const p = sky.skyObjectsGroup!.position;
    expect(p.x).not.toBe(cam.x);
    expect(p.z).not.toBe(cam.z);
    // and x+z offsets must not cancel along the 45° diagonals
    expect(Math.abs((p.x - cam.x) + (p.z - cam.z))).toBeGreaterThan(0.1);
    expect(Math.abs((p.x - cam.x) - (p.z - cam.z))).toBeGreaterThan(0.1);
    // but stays visually negligible relative to the 189-unit box
    expect(p.distanceTo(cam)).toBeLessThan(3);
  });
});

describe('CORE.9.d — before-sky draw order (retail before_sky_cell)', () => {
  it('draws in DAT index order behind the world, over the fallback gradient', () => {
    const sky = makeSunnySky();
    const [box, stars] = pivots(sky);
    expect(box.renderOrder).toBeLessThan(stars.renderOrder);
    expect(stars.renderOrder).toBeLessThan(0);
    // the procedural gradient sphere is now only a no-DAT fallback: it
    // must draw before every sky object so the sky box covers it
    expect(sky.skyObject.renderOrder).toBeLessThan(box.renderOrder);
  });
});
