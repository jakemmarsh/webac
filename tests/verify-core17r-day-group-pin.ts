/**
 * CORE.17.r — the world-town-day sky was not reproducible across identical
 * `capture-ui-screens.ts --scenes` runs (blue with cirrus at 22:53Z, overcast
 * white at 22:58Z, time of day frozen at noon and weather forced off in
 * both). Cause: the sky's DAY GROUP is a ChanceOfOccur-weighted Math.random()
 * roll at SkyboxRenderer construction and again at every in-game day
 * boundary; freezeTimeOfDay() holds the phase and the cloud UV scroll but
 * never the roll, so a session that rolled one of the region's 6 Sunny /
 * 4 Clear groups drew a blue sky and one that rolled a Cloudy / Rainy group
 * drew an overcast one (the Rainy rain domes are weather objects the harness
 * already hides — the overcast base sky is not).
 *
 * Retail ground truth found on the way (decompiled EoL client): the group was
 * never a roll. SkyDesc::CalcPresentDayGroup @ 00500e10 (every sky tick via
 * CRegionDesc::CalcDayGroup @ 004fe9a0 ← GameSky::UseTime @ 005075b0) hashes
 * the absolute Derethian day: h = (current_year * days_per_year +
 * current_day) * 0x6a42fdb2 - 0x7541e9ae (int32); u = (float)h (+2^32 if
 * negative); idx = floor((float)num_groups * u * 2^-32); idx >= num_groups
 * → 0. current_year / current_day come from GameTime::CalcDayBegin @
 * 005a6400 (year_length = day_length * days_per_year). chance_of_occur is
 * read by nothing but UnPack / Pack / the ctor. So the same server day gave
 * every client the same sky; ours (GAP.3) drew a Math.random() roll.
 *
 * Under test: (1) the hash + CalcDayBegin ports, pinned to values computed
 * from the retail formula; (2) SkyboxRenderer.pinDayGroup(index | name |
 * null) — the diagnostic pin the scene harness sets per scene. Behavioural:
 * the real renderer is driven through day boundaries with a real listener
 * wired like main.ts.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import {
  SkyboxRenderer, retailDayGroupIndex, absoluteDayFromClock, aceEmuTicksNow, ACE_EMU_EPOCH_MS,
} from '../packages/renderer/src/effects/SkyboxRenderer.js';
import fs from 'node:fs';
import { openDat } from './_harness/dat.js';

function timeEntry(begin: number) {
  return {
    begin, dirBright: 1, dirHeading: 0, dirPitch: 45, dirColor: 0xffffffff,
    ambBright: 0.5, ambColor: 0xffffffff, minWorldFog: 0, maxWorldFog: 1000,
    worldFogColor: 0xffffffff, worldFog: 0, skyObjReplace: [],
  };
}

function skyObject(gfx: number, properties = 0) {
  return {
    beginTime: 0, endTime: 0, beginAngle: 0, endAngle: 0,
    texVelocityX: 0, texVelocityY: 0,
    defaultGFXObjectId: gfx, defaultPESObjectId: 0, properties,
  };
}

type Group = { name: string; chance?: number; objects?: ReturnType<typeof skyObject>[] };

/** A SkyDesc in the EoL shape: repeated names, equal weights, per-group sky objects. */
function makeSkyDesc(groups: Group[]) {
  return {
    tickSize: 30, lightTickSize: 30,
    dayGroups: groups.map((g) => ({
      chanceOfOccur: g.chance ?? 5, dayName: g.name,
      skyObjects: g.objects ?? [],
      skyTime: [timeEntry(0), timeEntry(0.5)],
    })),
  } as never;
}

const EOL_LIKE: Group[] = [
  { name: 'Sunny', objects: [skyObject(0x010015ee)] },
  { name: 'Sunny', objects: [skyObject(0x010015ee), skyObject(0x01004c36)] },
  { name: 'Clear', objects: [skyObject(0x010015ee)] },
  { name: 'Cloudy', objects: [skyObject(0x01004c35)] },
  { name: 'Rainy', objects: [skyObject(0x01004c35), skyObject(0x01004c42, 0x4), skyObject(0x01004c44, 0x5)] },
];

function stubModelRenderer() {
  return {
    createMesh: () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial()));
      return g;
    },
  } as never;
}

/** Drive the renderer through `days` full solo-mode days (dayLength 10 s). */
function runDays(sky: SkyboxRenderer, days: number): void {
  for (let d = 0; d < days; d++) for (let i = 0; i < 10; i++) sky.update(1.01);
}

describe('CORE.17.r — pinDayGroup holds the sky\'s day group for deterministic capture', () => {
  it('lists the region\'s day groups in DAT order with their weights', () => {
    const sky = new SkyboxRenderer(makeSkyDesc(EOL_LIKE), { dayLength: 10 } as never);
    expect(sky.dayGroups.map((g) => g.name)).toEqual(['Sunny', 'Sunny', 'Clear', 'Cloudy', 'Rainy']);
    expect(sky.dayGroups.map((g) => g.index)).toEqual([0, 1, 2, 3, 4]);
    expect(sky.dayGroups.every((g) => g.chanceOfOccur === 5)).toBe(true);
    expect(sky.dayGroupIndex).toBe(sky.dayGroups.findIndex((g) => g.name === sky.dayGroupName)
      >= 0 ? sky.dayGroupIndex : -1);
    expect(sky.dayGroupIndex).toBeGreaterThanOrEqual(0);
    expect(sky.isDayGroupPinned).toBe(false);
  });

  it('pins by name to the FIRST matching group in DAT order and notifies the listener', () => {
    const sky = new SkyboxRenderer(makeSkyDesc(EOL_LIKE), { dayLength: 10 } as never);
    const seen: string[] = [];
    sky.onDayGroupChange = (n) => seen.push(n);
    // Start from a group that is certainly not the pin target.
    expect(sky.pinDayGroup('Rainy')).toBe(true);
    seen.length = 0;
    expect(sky.pinDayGroup('Sunny')).toBe(true);
    expect(sky.dayGroupName).toBe('Sunny');
    expect(sky.dayGroupIndex).toBe(0);
    expect(sky.isDayGroupPinned).toBe(true);
    expect(seen).toEqual(['Sunny']);
  });

  it('pins by DAT index, so a specific Sunny variant can be chosen', () => {
    const sky = new SkyboxRenderer(makeSkyDesc(EOL_LIKE), { dayLength: 10 } as never);
    expect(sky.pinDayGroup(1)).toBe(true);
    expect(sky.dayGroupIndex).toBe(1);
    expect(sky.dayGroupName).toBe('Sunny');
    expect(sky.pinDayGroup(3)).toBe(true);
    expect(sky.dayGroupName).toBe('Cloudy');
  });

  it('refuses an unknown name or an out-of-range index and leaves the state untouched', () => {
    const sky = new SkyboxRenderer(makeSkyDesc(EOL_LIKE), { dayLength: 10 } as never);
    sky.pinDayGroup('Cloudy');
    const seen: string[] = [];
    sky.onDayGroupChange = (n) => seen.push(n);
    expect(sky.pinDayGroup('Snowy')).toBe(false);
    expect(sky.pinDayGroup(5)).toBe(false);
    expect(sky.pinDayGroup(-1)).toBe(false);
    expect(sky.pinDayGroup(1.5)).toBe(false);
    expect(sky.dayGroupName).toBe('Cloudy');
    expect(sky.dayGroupIndex).toBe(3);
    expect(sky.isDayGroupPinned).toBe(true);
    expect(seen).toEqual([]);
  });

  it('pinning the group that is already active fires no rebuild', () => {
    const sky = new SkyboxRenderer(makeSkyDesc(EOL_LIKE), { dayLength: 10 } as never);
    sky.pinDayGroup(2);
    const seen: string[] = [];
    sky.onDayGroupChange = (n) => seen.push(n);
    expect(sky.pinDayGroup(2)).toBe(true);
    expect(sky.pinDayGroup('Clear')).toBe(true);
    expect(seen).toEqual([]);
  });

  it('a pinned group holds across in-game day boundaries (the roll that broke the captures)', () => {
    const sky = new SkyboxRenderer(makeSkyDesc(EOL_LIKE), { dayLength: 10 } as never);
    sky.pinDayGroup('Clear');
    const seen: string[] = [];
    sky.onDayGroupChange = (n) => seen.push(n);
    runDays(sky, 40);
    expect(seen).toEqual([]);
    expect(sky.dayGroupName).toBe('Clear');
    expect(sky.dayGroupIndex).toBe(2);
  });

  it('pinDayGroup(null) unpins and the daily retail day hash rules again', () => {
    const sky = new SkyboxRenderer(makeSkyDesc([{ name: 'Sunny' }, { name: 'Rainy' }]), { dayLength: 10 } as never);
    sky.pinDayGroup('Sunny');
    expect(sky.pinDayGroup(null)).toBe(true);
    expect(sky.isDayGroupPinned).toBe(false);
    const day0 = sky.currentAbsoluteDay;
    const perDay: string[] = [];
    runDays(sky, 1);
    for (let d = 1; d <= 40; d++) { perDay.push(sky.dayGroupName); runDays(sky, 1); }
    for (let d = 1; d <= 40; d++) expect(perDay[d - 1]).toBe(['Sunny', 'Rainy'][retailDayGroupIndex(day0 + d, 2)]);
    expect(new Set(perDay).size).toBe(2);
  });

  it('with freezeTimeOfDay the pin is still needed: the freeze does not choose the group', () => {
    // Two renderers frozen at the same noon can still differ in day group —
    // exactly the CORE.17.r symptom. Pinning both makes them agree.
    const a = new SkyboxRenderer(makeSkyDesc(EOL_LIKE), { dayLength: 10 } as never);
    const b = new SkyboxRenderer(makeSkyDesc(EOL_LIKE), { dayLength: 10 } as never);
    a.freezeTimeOfDay(0.5);
    b.freezeTimeOfDay(0.5);
    a.pinDayGroup(0);
    b.pinDayGroup(0);
    a.update(1); b.update(1);
    expect(a.dayGroupIndex).toBe(0);
    expect(b.dayGroupIndex).toBe(0);
    expect(a.currentTimeOfDay).toBeCloseTo(0.5, 10);
    expect(b.currentTimeOfDay).toBeCloseTo(0.5, 10);
  });

  it('wired like main.ts, a pin swaps the sky object set to the pinned group\'s DAT objects', () => {
    const sky = new SkyboxRenderer(makeSkyDesc(EOL_LIKE), { dayLength: 10 } as never);
    const mr = stubModelRenderer();
    sky.initSkyObjects(mr);
    sky.onDayGroupChange = () => sky.rebuildSkyObjects(mr);
    sky.pinDayGroup('Rainy');
    expect(sky.skyObjectsGroup?.children.length).toBe(3);
    sky.pinDayGroup('Sunny');
    expect(sky.skyObjectsGroup?.children.length).toBe(1);
    sky.pinDayGroup(1);
    expect(sky.skyObjectsGroup?.children.length).toBe(2);
    // and the day boundary leaves the pinned set alone
    runDays(sky, 5);
    expect(sky.skyObjectsGroup?.children.length).toBe(2);
    expect(sky.dayGroupIndex).toBe(1);
  });
});

describe('CORE.17.r — retail SkyDesc::CalcPresentDayGroup + GameTime::CalcDayBegin ports', () => {
  it('walks the retail hash sequence (first 40 absolute days, 2 and 20 groups)', () => {
    // Computed from the decompiled formula: h = d*0x6a42fdb2 - 0x7541e9ae (int32),
    // u = float32(h) (+2^32 if negative), idx = floor(float32(n) * u * 2^-32).
    const two = Array.from({ length: 40 }, (_, d) => retailDayGroupIndex(d, 2)).join('');
    expect(two).toBe('1101010010101101010010101101011010100101');
    const twenty = Array.from({ length: 40 }, (_, d) => retailDayGroupIndex(d, 20));
    expect(twenty).toEqual([10, 19, 7, 15, 4, 12, 0, 8, 17, 5, 13, 2, 10, 18, 7, 15, 3, 11, 0, 8,
      16, 5, 13, 1, 10, 18, 6, 14, 3, 11, 19, 8, 16, 4, 13, 1, 9, 18, 6, 14]);
  });

  it('day 0: h = -0x7541e9ae is negative, so u = float32(h) + 2^32', () => {
    // -0x7541e9ae + 2^32 = 2327254610 → float32 2327254528 → * 2 / 2^32 = 1.083… → 1
    expect(retailDayGroupIndex(0, 2)).toBe(1);
    expect(retailDayGroupIndex(0, 20)).toBe(10);
  });

  it('spreads 100k consecutive days evenly over 20 groups (no weighting by ChanceOfOccur)', () => {
    const hist = new Array(20).fill(0);
    for (let d = 0; d < 100000; d++) hist[retailDayGroupIndex(d, 20)]++;
    for (const n of hist) expect(Math.abs(n - 5000)).toBeLessThan(50);
  });

  it('never returns an out-of-range index and returns 0 without groups', () => {
    for (let d = -5000; d < 5000; d += 7) {
      const i = retailDayGroupIndex(d, 20);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(20);
    }
    expect(retailDayGroupIndex(123, 0)).toBe(0);
    expect(retailDayGroupIndex(123, 1)).toBe(0);
  });

  const GT = { zeroTimeOfYear: 3600, zeroYear: 10, dayLength: 7620, daysPerYear: 360 };

  it('CalcDayBegin: absolute day = (floor(t / year_length) + zero_year) * days_per_year + floor((t mod year_length) / day_length)', () => {
    // ticks 0 → t = 3600 → year 10, day 0 → 3600
    expect(absoluteDayFromClock(0, GT)).toBe(3600);
    // one tick short of the first day boundary (t = 7619.999) is still day 0
    expect(absoluteDayFromClock(7620 - 3600 - 0.001, GT)).toBe(3600);
    expect(absoluteDayFromClock(7620 - 3600, GT)).toBe(3601);
    // the year rolls at t = 360 * 7620: year 11, day 0 → 3960
    expect(absoluteDayFromClock(7620 * 360 - 3600, GT)).toBe(3960);
    expect(absoluteDayFromClock(7620 * 360 - 3600 - 1, GT)).toBe(3959);
  });

  it('ACE Timers.PortalYearTicks: seconds since 2017-01-31 17:00 UTC, the retail sunset in Eastern time', () => {
    expect(ACE_EMU_EPOCH_MS).toBe(Date.parse('2017-01-31T17:00:00Z'));
    expect(aceEmuTicksNow(ACE_EMU_EPOCH_MS)).toBe(0);
    expect(aceEmuTicksNow(ACE_EMU_EPOCH_MS + 7620 * 1000)).toBe(7620);
    expect(aceEmuTicksNow(ACE_EMU_EPOCH_MS - 1000)).toBe(0);
  });

  it('a renderer built now sits on the day ACE would report now', () => {
    const sky = new SkyboxRenderer(makeSkyDesc(EOL_LIKE), GT as never);
    const day = absoluteDayFromClock(aceEmuTicksNow(), GT);
    expect(Math.abs(sky.currentAbsoluteDay - day)).toBeLessThanOrEqual(1); // a boundary may pass mid-test
    expect(sky.dayGroupIndex).toBe(retailDayGroupIndex(sky.currentAbsoluteDay, EOL_LIKE.length));
  });
});

const hasDat = fs.existsSync('dat/client_portal.dat');
let datSky: SkyboxRenderer;

describe.skipIf(!hasDat)('CORE.17.r — EoL portal.dat region: the hashed group is one of the 20 real day groups', () => {
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { RegionDesc } = await import('../packages/dat-parser/src/file-types/RegionDesc.js');
    const db = openDat('dat/client_portal.dat');
    const rd = new RegionDesc(new DatReader(db.getFileData(0x13000000)!));
    datSky = new SkyboxRenderer(rd.skyInfo, rd.gameTime);
  });

  it('carries 20 groups in DAT order: Sunny first, so the harness pin "Sunny" is #0', () => {
    const names = datSky.dayGroups.map((g) => g.name);
    expect(names.length).toBe(20);
    expect(names[0]).toBe('Sunny');
    expect(names.filter((n) => n === 'Sunny').length).toBe(6);
    expect(names.filter((n) => n === 'Clear').length).toBe(3); // GAP.3's census said 4 Clear / 7 Rainy; the DAT is 3 / 8
    expect(names.filter((n) => n === 'Cloudy').length).toBe(3);
    expect(names.filter((n) => n === 'Rainy').length).toBe(8);
    expect(datSky.dayGroups.every((g) => g.chanceOfOccur === 5)).toBe(true);
  });

  it('today\'s group is the retail hash of today\'s absolute day', () => {
    const idx = retailDayGroupIndex(datSky.currentAbsoluteDay, 20);
    expect(datSky.dayGroupIndex).toBe(idx);
    expect(datSky.dayGroupName).toBe(datSky.dayGroups[idx].name);
  });

  it('pinning by name lands on the first Sunny / Rainy group in DAT order', () => {
    expect(datSky.pinDayGroup('Sunny')).toBe(true);
    expect(datSky.dayGroupIndex).toBe(0);
    expect(datSky.pinDayGroup('Rainy')).toBe(true);
    expect(datSky.dayGroupIndex).toBe(3);
    datSky.pinDayGroup(null);
  });
});

describe('CORE.17.r — freezeTimeOfDay also pins the cloud scroll phase', () => {
  // Live probe (verification/core17r): two sessions pinned to the same
  // group and frozen at the same noon still differed in 76 % of sky pixels —
  // the cloud UV offset is cloudUvTime × texVelocity, and cloudUvTime had
  // accumulated for however long each session took to log in before the
  // freeze. A freeze now resets it, so the scroll phase is the same in
  // every frozen capture.
  function texturedModelRenderer() {
    return {
      createMesh: () => {
        const g = new THREE.Group();
        g.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ map: new THREE.Texture() })));
        return g;
      },
    } as never;
  }
  function cloudOffsets(sky: SkyboxRenderer): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    sky.skyObjectsGroup?.traverse((c) => {
      if (c instanceof THREE.Mesh) {
        const m = c.material as THREE.MeshBasicMaterial;
        if (m.map) out.push([m.map.offset.x, m.map.offset.y]);
      }
    });
    return out;
  }
  const cloud = { name: 'Cloudy', objects: [{ ...skyObject(0x01004c35), texVelocityX: 0.013, texVelocityY: -0.013 }] };

  it('a freeze zeroes the accumulated cloud scroll, so two sessions frozen at the same phase agree', () => {
    const a = new SkyboxRenderer(makeSkyDesc([cloud]), { dayLength: 7620, zeroTimeOfYear: 3600, zeroYear: 10, daysPerYear: 360 } as never);
    const b = new SkyboxRenderer(makeSkyDesc([cloud]), { dayLength: 7620, zeroTimeOfYear: 3600, zeroYear: 10, daysPerYear: 360 } as never);
    a.initSkyObjects(texturedModelRenderer());
    b.initSkyObjects(texturedModelRenderer());
    // different login durations before the freeze
    for (let i = 0; i < 90; i++) a.update(1);
    for (let i = 0; i < 37; i++) b.update(1);
    a.updateTimeOfDay(0.5); b.updateTimeOfDay(0.5);
    expect(cloudOffsets(a)).not.toEqual(cloudOffsets(b));
    a.freezeTimeOfDay(0.5); b.freezeTimeOfDay(0.5);
    a.update(3); b.update(11);
    expect(cloudOffsets(a)).toEqual(cloudOffsets(b));
    expect(cloudOffsets(a)[0][0] + 0).toBe(0); // (0 × v) % 1 is ±0
    expect(cloudOffsets(a)[0][1] + 0).toBe(0);
    // and unfreezing resumes the scroll from that pinned phase
    a.freezeTimeOfDay(null);
    a.update(10);
    expect(cloudOffsets(a)[0][0]).toBeCloseTo((10 * 0.013) % 1, 10);
  });
});
