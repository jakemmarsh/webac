/**
 * BUG.sky-steps-not-smooth (Jake, AC1999 on prod, 2026-11-01): "the sky seems to move like a few
 * pixels at a time rather than smoothly, so its jumping across the screen over time".
 *
 * SWEEP1999.world (783f7eb10) moved the whole of updateSkyObjectProperties onto 1999's 0.8 s
 * landscape tick (LScape_UseTime @ 0x442242 calls GameSky_UseTime inside its next_tick gate). That
 * function also carried the texture scroll and the arc angle:
 *  - texture scroll is never GameSky's in either client: CPhysics::UpdateTexVelocity @ 00509820
 *    (1999: 0x444160) advances it from CPhysics::UseTime on every physics quantum, so the 1999 rain
 *    sheet (v = −2 /s) jumped 1.6 texture-heights per tick;
 *  - the arc angle: retail 1999 did step it, but a moon's 0.13° step was half a pixel on 1999's
 *    480-line screens and is several pixels on today's, so it is placed every frame in every era
 *    (a browser-UX exception, CLAUDE.md). The arc WINDOW keeps the era's cadence.
 *
 * Drives the real SkyboxRenderer with the 1999 DAT's own values (Region 0x13000000 through
 * transcodeRegion1999: day 7620 s, tick 0.8 s, the moon 0x010015F5 at −20°→190° over day phase
 * 0.04→0.21, the Rainy sheet 0x01001642 at (0.02, −2) /s).
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { GameTime } from '../packages/dat-parser/src/file-types/RegionDesc.js';
import { SkyboxRenderer } from '../packages/renderer/src/effects/SkyboxRenderer.js';
import { AC1999_WORLD_RULES, EOR_WORLD_RULES } from '../packages/renderer/src/era/EraWorldRules.js';

const GAME_TIME: GameTime = {
  zeroTimeOfYear: 3600, zeroYear: 10, dayLength: 7620, daysPerYear: 360,
  yearSpec: 'P.Y.', timesOfDay: [], daysOfTheWeek: [], seasons: [],
};
const MOON = 0x010015f5;
const RAIN = 0x01001642;

function skyDesc() {
  const entry = (begin: number) => ({
    begin, dirBright: 1, dirHeading: 0, dirPitch: 45, dirColor: 0xffffffff,
    ambBright: 0.3, ambColor: 0xffffffff, minWorldFog: 0, maxWorldFog: 1000,
    worldFogColor: 0xffffffff, worldFog: 0, skyObjReplace: [],
  });
  return {
    tickSize: 0.800000011920929, lightTickSize: 15,
    dayGroups: [{
      chanceOfOccur: 5, dayName: 'Rainy', skyTime: [entry(0), entry(0.5)],
      skyObjects: [
        { beginTime: 0.03999999910593033, endTime: 0.20999999344348907, beginAngle: -20, endAngle: 190,
          texVelocityX: 0, texVelocityY: 0, defaultGFXObjectId: MOON, defaultPESObjectId: 0, properties: 0 },
        { beginTime: 0, endTime: 0, beginAngle: 0, endAngle: 0,
          texVelocityX: 0.019999999552965164, texVelocityY: -2, defaultGFXObjectId: RAIN, defaultPESObjectId: 0, properties: 1 },
      ],
    }],
  } as never;
}

function modelRenderer() {
  return {
    createMesh: (gfxId: number) => {
      const g = new THREE.Group();
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ map: new THREE.Texture() }));
      mesh.userData.surfaceId = gfxId;
      g.add(mesh);
      return g;
    },
    getSurface: () => ({ luminosity: 0 }),
  } as never;
}

interface Entry { skyObj: { defaultGFXObjectId: number }; mesh: THREE.Object3D; litMaterials: Array<{ material: THREE.MeshLambertMaterial }> }
const entryOf = (sky: SkyboxRenderer, gfx: number): Entry =>
  (sky as unknown as { skyObjectEntries: Entry[] }).skyObjectEntries.find(e => e.skyObj.defaultGFXObjectId === gfx)!;

/** A sky at day phase `phase` under the era's rules, its objects built. */
function skyAt(rules: typeof EOR_WORLD_RULES, phase: number): SkyboxRenderer {
  const sky = new SkyboxRenderer(skyDesc(), GAME_TIME);
  sky.skyObjectsOnTick = rules.skyObjectsOnTick;
  sky.initSkyObjects(modelRenderer());
  sky.syncGameClock(7620 * 100 + phase * 7620 - GAME_TIME.zeroTimeOfYear);
  sky.update(0);
  return sky;
}

/** Step 60 frames of 1/60 s; the moon's arc angle and the rain's v offset after each. */
function sixtyFrames(sky: SkyboxRenderer): { angles: number[]; rainV: number[] } {
  const moon = entryOf(sky, MOON);
  const rain = entryOf(sky, RAIN).litMaterials[0].material.map!;
  const angles: number[] = [];
  const rainV: number[] = [];
  for (let i = 0; i < 60; i++) {
    sky.update(1 / 60);
    angles.push(moon.mesh.rotation.z);
    rainV.push(rain.offset.y);
  }
  return { angles, rainV };
}

const distinct = (xs: number[]): number => new Set(xs).size;

describe('BUG.sky-steps-not-smooth: the sky objects move every frame in every era', () => {
  for (const [era, rules] of [['end of retail / Dark Majesty', EOR_WORLD_RULES], ['AC1999', AC1999_WORLD_RULES]] as const) {
    it(`${era}: the moon's arc angle advances on every frame, by the DAT rate`, () => {
      const sky = skyAt(rules, 0.1);
      const before = entryOf(sky, MOON).mesh.rotation.z;
      const { angles } = sixtyFrames(sky);
      expect(distinct(angles)).toBe(60);
      for (let i = 1; i < 60; i++) expect(angles[i]).toBeGreaterThan(angles[i - 1]);
      // 210° over 0.17 of a 7620 s day = 0.162°/s.
      const degPerSec = (210 / (0.17 * 7620));
      expect((angles[59] - before) * 180 / Math.PI).toBeCloseTo(degPerSec, 2);
    });

    it(`${era}: the rain sheet scrolls on every frame (CPhysics::UpdateTexVelocity)`, () => {
      const sky = skyAt(rules, 0.1);
      const { rainV } = sixtyFrames(sky);
      expect(distinct(rainV)).toBe(60);
      // v = −2 texture-heights per second: −1/30 per frame, wrapped into (−1, 1).
      for (let i = 1; i < 60; i++) {
        const d = ((rainV[i] - rainV[i - 1]) % 1 + 1.5) % 1 - 0.5;
        expect(d).toBeCloseTo(-2 / 60, 6);
      }
    });
  }

  it('AC1999: the timeline state keeps the 0.8 s tick (GameSky_UseTime inside LScape_UseTime\'s gate)', () => {
    const sky = skyAt(AC1999_WORLD_RULES, 0.1);
    const frame = vi.spyOn(sky as unknown as { updateSkyFrame(): void }, 'updateSkyFrame');
    sixtyFrames(sky);
    expect(frame.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(frame.mock.calls.length).toBeLessThanOrEqual(2); // 1 s of frames / 0.8 s
  });

  it('AC1999: past its window the moon holds its last angle until the tick hides it', () => {
    // 0.21 is the window's end; start one frame before it.
    const sky = skyAt(AC1999_WORLD_RULES, 0.20999999344348907 - 0.5 / 7620);
    const moon = entryOf(sky, MOON).mesh;
    expect(moon.visible).toBe(true);
    sky.update(1); // past the end, and a tick is due (1 s > 0.8 s)
    expect(moon.visible).toBe(false);
    const held = moon.rotation.z;
    expect(held * 180 / Math.PI).toBeLessThanOrEqual(190);
    sky.update(1 / 60);
    expect(moon.rotation.z).toBe(held);
  });

  it('a frozen capture clock holds the arc and the scroll still (freezeTimeOfDay)', () => {
    const sky = skyAt(AC1999_WORLD_RULES, 0.1);
    sky.freezeTimeOfDay(0.1);
    const { angles, rainV } = sixtyFrames(sky);
    expect(distinct(angles)).toBe(1);
    expect(distinct(rainV)).toBe(1);
    expect(rainV[0]).toBeCloseTo(0, 12);
  });
});
