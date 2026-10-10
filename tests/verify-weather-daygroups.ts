/**
 * CORE.9 / GAP.3 — weather is DAT-driven via RegionDesc day groups.
 *
 * Ground truth (EoL portal.dat region 0x13000000): 20 DayGroups — 6 Sunny,
 * 4 Clear, 3 Cloudy, 7 Rainy — each with ChanceOfOccur=5 (equal weights →
 * ~35% rainy in-game days), re-rolled per in-game day. The Rainy groups
 * carry the rain itself as SKY OBJECTS: two scrolling-texture rain domes
 * (0x1004c42 properties=0x4, texVel(0.02,-2); 0x1004c44 properties=0x5,
 * texVel(0.02,-1.7)). Per the decompiled client (GameSky::MakeObject /
 * GameSky::Draw / SmartBox::EnableWeather):
 *   - properties&0x4 = weather object, drawn only while
 *     LScape::weather_enabled (the DisableMostWeatherEffects gate);
 *   - properties&0x1 = after-sky object, drawn AFTER the landscape with
 *     DEPTHTEST_ALWAYS (rain in front of terrain);
 *   - the sky_obj set is recreated when the day group changes
 *     (GameSky::CreateDeletePhysicsObjects).
 * CORE.9 removed the old hand-rolled WeatherEffect point cloud (2000 white
 * falling dots — read as perpetual snow, and rendered indoors); the DAT
 * layers above are the retail rain.
 *
 * Under test:
 *  1. SkyboxRenderer advances the day at the timeOfDay wrap (new in-game
 *     day), takes the group the retail day hash names (CORE.17.r —
 *     SkyDesc::CalcPresentDayGroup, not a ChanceOfOccur roll) and fires
 *     onDayGroupChange when it differs.
 *  2. Weather-flagged sky objects are kept, gated by setWeatherEnabled,
 *     and after-sky objects draw over the world (transparent pass, late
 *     render order). CORE.9.d: EVERY sky object renders (retail
 *     GameSky::MakeObject makes no class distinction) — static domes are
 *     no longer skipped, and before-sky objects draw in DAT index order.
 *  3. rebuildSkyObjects swaps the mesh set for the current group while
 *     preserving scene parent and group visibility (hidden while indoors).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { SkyboxRenderer, retailDayGroupIndex } from '../packages/renderer/src/effects/SkyboxRenderer.js';

function timeEntry(begin: number) {
  return {
    begin, dirBright: 1, dirHeading: 0, dirPitch: 45, dirColor: 0xffffffff,
    ambBright: 0.5, ambColor: 0xffffffff, minWorldFog: 0, maxWorldFog: 1000,
    worldFogColor: 0xffffffff, worldFog: 0, skyObjReplace: [],
  };
}

function skyObject(over: Partial<Record<string, number>> = {}) {
  return {
    beginTime: 0, endTime: 0, beginAngle: 0, endAngle: 0,
    texVelocityX: 0, texVelocityY: 0,
    defaultGFXObjectId: 0x01004c42, defaultPESObjectId: 0,
    properties: 0,
    ...over,
  };
}

function makeSkyDesc(names: string[], skyObjects: ReturnType<typeof skyObject>[] = []) {
  return {
    tickSize: 30, lightTickSize: 30,
    dayGroups: names.map((dayName) => ({
      chanceOfOccur: 5, dayName,
      skyObjects,
      skyTime: [timeEntry(0), timeEntry(0.5)],
    })),
  } as never;
}

/** Minimal ModelRenderer stub: every GfxObj id resolves to one textured mesh. */
function stubModelRenderer(matParams: ConstructorParameters<typeof THREE.MeshStandardMaterial>[0] = {}) {
  return {
    createMesh: () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial(matParams)));
      return g;
    },
  } as never;
}

/** The pivots initSkyObjects added (children of the sky_objects group). */
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

describe('GAP.3 / CORE.17.r — the day group changes at the day boundary, by the retail day hash', () => {
  it('walks the retail SkyDesc::CalcPresentDayGroup sequence day by day and notifies on each CHANGE', () => {
    const sky = new SkyboxRenderer(makeSkyDesc(['Sunny', 'Rainy']), { dayLength: 10 } as never);
    const seen: string[] = [];
    sky.onDayGroupChange = (name) => seen.push(name);
    const day0 = sky.currentAbsoluteDay;
    const perDay: string[] = [sky.dayGroupName];
    // drive through several full days — the wrap advances the day once per day
    for (let day = 0; day < 40; day++) {
      for (let i = 0; i < 10; i++) sky.update(1.01); // 10× ~0.1 day steps
      perDay.push(sky.dayGroupName);
    }
    expect(sky.currentAbsoluteDay).toBe(day0 + 40);
    // every day's group is the retail hash of that absolute day (no randomness)
    for (let d = 0; d <= 40; d++) {
      expect(perDay[d]).toBe(['Sunny', 'Rainy'][retailDayGroupIndex(day0 + d, 2)]);
    }
    // the hash walks both groups within any 40-day window; the listener saw
    // exactly the changes (never a same-group "re-roll")
    expect(new Set(perDay).size).toBe(2);
    let changes = 0;
    for (let d = 1; d <= 40; d++) if (perDay[d] !== perDay[d - 1]) changes++;
    expect(seen.length).toBe(changes);
    for (const n of seen) expect(['Sunny', 'Rainy']).toContain(n);
  });

  it('is deterministic: two renderers built on the same day agree, day after day', () => {
    const a = new SkyboxRenderer(makeSkyDesc(['Sunny', 'Rainy']), { dayLength: 10 } as never);
    const b = new SkyboxRenderer(makeSkyDesc(['Sunny', 'Rainy']), { dayLength: 10 } as never);
    expect(a.currentAbsoluteDay).toBe(b.currentAbsoluteDay);
    for (let day = 0; day < 20; day++) {
      for (let i = 0; i < 10; i++) { a.update(1.01); b.update(1.01); }
      expect(a.dayGroupName).toBe(b.dayGroupName);
    }
  });

  it('forceDaylight pins only the lighting: the days (and so the day group) still advance', () => {
    // DECOMP.always-daylight-scope — GameSky::UseTime's CalcDayGroup runs on
    // the real clock; m_fAlwaysDaylight is read only by set_landscape_lighting.
    const sky = new SkyboxRenderer(makeSkyDesc(['Sunny', 'Rainy']), { dayLength: 10 } as never);
    sky.setForceDaylight(true);
    const day0 = sky.currentAbsoluteDay;
    for (let i = 0; i < 100; i++) sky.update(5);
    expect(sky.currentAbsoluteDay).toBe(day0 + 50);
  });
});

describe('CORE.9 — weather sky objects (properties bits per decomp GameSky)', () => {
  // The EoL Rainy group's real shape: back rain dome (0x4), front rain dome
  // (0x5 = weather+after-sky), a plain cloud layer, and a static dome
  // (CORE.9.d: rendered like every other sky object — retail's sky boxes
  // ARE the sky; nothing is skipped).
  const rainyObjects = [
    skyObject({ properties: 0x4, texVelocityX: 0.02, texVelocityY: -2 }),
    skyObject({ properties: 0x5, texVelocityX: 0.02, texVelocityY: -1.7, defaultGFXObjectId: 0x01004c44 }),
    skyObject({ texVelocityX: 0.013, texVelocityY: -0.013, defaultGFXObjectId: 0x01004c35 }),
    skyObject({ defaultGFXObjectId: 0x010015f0 }),
  ];

  function makeRainySky(): SkyboxRenderer {
    const sky = new SkyboxRenderer(makeSkyDesc(['Rainy'], rainyObjects), { dayLength: 10 } as never);
    sky.initSkyObjects(stubModelRenderer());
    sky.updateTimeOfDay(0.5);
    return sky;
  }

  it('keeps every sky object, static domes included (CORE.9.d)', () => {
    const sky = makeRainySky();
    // rain domes + cloud + static dome all created, in DAT index order
    expect(pivots(sky).length).toBe(4);
    const names = pivots(sky).map(p => p.name);
    expect(names.some(n => n.startsWith('sky_obj_0_'))).toBe(true);
    expect(names.some(n => n.startsWith('sky_obj_1_'))).toBe(true);
    expect(names.some(n => n.startsWith('sky_obj_2_'))).toBe(true);
    expect(names.some(n => n.startsWith('sky_obj_3_'))).toBe(true);
  });

  it('a weather object with no texture velocity is still kept (properties&0x4 alone)', () => {
    const sky = new SkyboxRenderer(
      makeSkyDesc(['Rainy'], [skyObject({ properties: 0x4 })]), { dayLength: 10 } as never);
    sky.initSkyObjects(stubModelRenderer());
    expect(pivots(sky).length).toBe(1);
  });

  it('setWeatherEnabled(false) hides ONLY the weather objects; re-enable restores them', () => {
    const sky = makeRainySky();
    const [back, front, cloud] = pivots(sky);
    expect(back.visible).toBe(true);
    expect(front.visible).toBe(true);
    expect(cloud.visible).toBe(true);

    sky.setWeatherEnabled(false);
    expect(sky.isWeatherEnabled).toBe(false);
    expect(back.visible).toBe(false);
    expect(front.visible).toBe(false);
    expect(cloud.visible).toBe(true);

    // per-frame timeline updates must not resurrect gated weather objects
    sky.updateTimeOfDay(0.6);
    expect(back.visible).toBe(false);
    expect(front.visible).toBe(false);

    sky.setWeatherEnabled(true);
    expect(back.visible).toBe(true);
    expect(front.visible).toBe(true);
  });

  it('weather objects initialize hidden when weather is already disabled', () => {
    const sky = new SkyboxRenderer(makeSkyDesc(['Rainy'], rainyObjects), { dayLength: 10 } as never);
    sky.setWeatherEnabled(false);
    sky.initSkyObjects(stubModelRenderer());
    sky.updateTimeOfDay(0.5);
    const [back, front, cloud] = pivots(sky);
    expect(back.visible).toBe(false);
    expect(front.visible).toBe(false);
    expect(cloud.visible).toBe(true);
  });

  it('preserves the DAT surface Additive bit (rain streaks add, not alpha-wash)', () => {
    // The Rainy rain-dome surfaces (0x80000c5, type 0x10112) carry the
    // Additive bit; MaterialFactory encodes that as AdditiveBlending on
    // the source material. The sky material swap must keep dst=ONE.
    const sky = new SkyboxRenderer(
      makeSkyDesc(['Rainy'], [skyObject({ properties: 0x4, texVelocityX: 0.02, texVelocityY: -2 })]),
      { dayLength: 10 } as never);
    sky.initSkyObjects(stubModelRenderer({ blending: THREE.AdditiveBlending }));
    const mat = pivotMaterial(pivots(sky)[0]);
    expect(mat.blendDst).toBe(THREE.OneFactor);

    // and a plain (non-additive) cloud keeps alpha compositing
    const sky2 = new SkyboxRenderer(
      makeSkyDesc(['Cloudy'], [skyObject({ texVelocityX: 0.013, texVelocityY: 0.013 })]),
      { dayLength: 10 } as never);
    sky2.initSkyObjects(stubModelRenderer());
    expect(pivotMaterial(pivots(sky2)[0]).blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
  });

  it('scrolling layers clone a shared texture so per-object UV offsets do not alias', () => {
    // TextureManager caches textures by id: both rain domes resolve the
    // same rain texture but scroll at different DAT velocities — sharing
    // one instance made the offsets fight (last writer wins).
    const sharedTex = new THREE.Texture();
    const sky = new SkyboxRenderer(
      makeSkyDesc(['Rainy'], [
        skyObject({ properties: 0x4, texVelocityX: 0.02, texVelocityY: -2 }),
        skyObject({ properties: 0x5, texVelocityX: 0.02, texVelocityY: -1.7 }),
      ]),
      { dayLength: 10 } as never);
    sky.initSkyObjects(stubModelRenderer({ map: sharedTex }));
    const [a, b] = pivots(sky).map(p => pivotMaterial(p).map);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(sharedTex);
    expect(b).not.toBe(sharedTex);
    expect(a).not.toBe(b);
  });

  it('after-sky objects (properties&0x1) draw over the world; before-sky behind it', () => {
    const sky = makeRainySky();
    const [back, front, cloud] = pivots(sky);
    // front rain dome: retail after_sky_cell pass — transparent pass, late order
    expect(front.renderOrder).toBeGreaterThan(0);
    expect(pivotMaterial(front).transparent).toBe(true);
    expect(pivotMaterial(front).depthTest).toBe(false);
    // back dome + cloud: sky pass behind the world, DAT index order
    // (CORE.9.d: -50 + index, always negative)
    expect(back.renderOrder).toBe(-50);
    expect(pivotMaterial(back).transparent).toBe(false);
    expect(cloud.renderOrder).toBe(-48);
    expect(cloud.renderOrder).toBeGreaterThan(back.renderOrder);
    expect(cloud.renderOrder).toBeLessThan(0);
  });
});

describe('CORE.9 — rebuildSkyObjects (retail GameSky::CreateDeletePhysicsObjects)', () => {
  it('replaces the mesh set in place, preserving scene parent and visibility', () => {
    const sky = new SkyboxRenderer(
      makeSkyDesc(['Rainy'], [skyObject({ properties: 0x4, texVelocityX: 0.02, texVelocityY: -2 })]),
      { dayLength: 10 } as never);
    const stub = stubModelRenderer();
    sky.initSkyObjects(stub);
    const scene = new THREE.Scene();
    scene.add(sky.skyObjectsGroup!);
    const oldGroup = sky.skyObjectsGroup!;

    // indoors: main hides the group; a rebuild must not resurrect it
    oldGroup.visible = false;
    sky.rebuildSkyObjects(stub);

    const newGroup = sky.skyObjectsGroup!;
    expect(newGroup).not.toBe(oldGroup);
    expect(newGroup.visible).toBe(false);
    expect(newGroup.parent).toBe(scene);
    expect(oldGroup.parent).toBe(null);
    // exactly one sky_objects group in the scene
    expect(scene.children.filter(c => c.name === 'sky_objects').length).toBe(1);
    expect(newGroup.children.length).toBe(1);
  });

  it('day-group re-roll listener can rebuild to the new group\'s object set', () => {
    // Two groups with DIFFERENT object counts: rolling between them and
    // rebuilding must track the active group's set.
    const desc = {
      tickSize: 30, lightTickSize: 30,
      dayGroups: [
        { chanceOfOccur: 5, dayName: 'Sunny', skyObjects: [skyObject()], skyTime: [timeEntry(0), timeEntry(0.5)] },
        {
          chanceOfOccur: 5, dayName: 'Rainy',
          skyObjects: [
            skyObject({ properties: 0x4, texVelocityX: 0.02, texVelocityY: -2 }),
            skyObject({ properties: 0x5, texVelocityX: 0.02, texVelocityY: -1.7 }),
          ],
          skyTime: [timeEntry(0), timeEntry(0.5)],
        },
      ],
    } as never;
    const sky = new SkyboxRenderer(desc, { dayLength: 10 } as never);
    const stub = stubModelRenderer();
    sky.initSkyObjects(stub);
    sky.onDayGroupChange = () => sky.rebuildSkyObjects(stub);
    // roll days until we've seen both groups' mesh sets
    const seenCounts = new Set<number>();
    for (let day = 0; day < 60 && seenCounts.size < 2; day++) {
      for (let i = 0; i < 10; i++) sky.update(1.01);
      seenCounts.add(pivots(sky).length);
    }
    // Sunny group: its single static dome renders (CORE.9.d) → 1 pivot;
    // Rainy group: both weather domes kept → 2 pivots.
    expect(seenCounts.has(1)).toBe(true);
    expect(seenCounts.has(2)).toBe(true);
  });
});
