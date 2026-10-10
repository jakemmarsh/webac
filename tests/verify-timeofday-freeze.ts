/**
 * SkyboxRenderer.freezeTimeOfDay — deterministic lighting for capture tooling.
 *
 * BUG THIS FIXES (found 2026-09-07 while building the whole-screen scene
 * capture pass): every capture tool that claimed to "pin time of day so A/B
 * frames are lighting-identical" — tools/capture-overlay-pool-ab.ts and the
 * other perf A/B harnesses, and the new scene harness — pinned it by calling
 * acDebug.setTimeOfDay(), which only writes the phase once. SkyboxRenderer's
 * per-frame update() re-derives the phase from the server game clock and
 * overwrites it immediately.
 *
 * Measured against the live stack (tools/probe-timeofday-pin.ts): set 0.00,
 * returned 0.0000, and one second later the skybox read 0.4639 — then kept
 * creeping. The pin never held, so a `world-night` scene capture came out in
 * broad daylight, and perf A/B runs kept attributing large pixel diffs to a
 * "per-session sky reroll" that was really the unfrozen clock.
 *
 * These tests drive the REAL SkyboxRenderer on BOTH clock paths (free-run and
 * server-synced), because it is the server-synced path that broke in practice.
 */
import { describe, it, expect } from 'vitest';
import { SkyboxRenderer } from '../packages/renderer/src/effects/SkyboxRenderer.js';
import type { GameTime } from '../packages/dat-parser/src/file-types/RegionDesc.js';

const EOL_GAME_TIME: GameTime = {
  zeroTimeOfYear: 3600, zeroYear: 10, dayLength: 7620, daysPerYear: 360,
  yearSpec: 'P.Y.', timesOfDay: [], daysOfTheWeek: [], seasons: [],
};

function timeEntry(begin: number) {
  return {
    begin, dirBright: 1, dirHeading: 0, dirPitch: 45, dirColor: 0xffffffff,
    ambBright: 0.5, ambColor: 0xffffffff, minWorldFog: 0, maxWorldFog: 1000,
    worldFogColor: 0xffffffff, worldFog: 0, skyObjReplace: [],
  };
}

function makeSkyDesc(names: string[]) {
  return {
    tickSize: 30, lightTickSize: 30,
    dayGroups: names.map((dayName) => ({
      chanceOfOccur: 5, dayName, skyObjects: [], skyTime: [timeEntry(0), timeEntry(0.5)],
    })),
  } as never;
}

const newSky = () => new SkyboxRenderer(makeSkyDesc(['Sunny']), EOL_GAME_TIME);

describe('freezeTimeOfDay: the regression that made setTimeOfDay useless for capture', () => {
  it('REPRO — without a freeze, the server-synced clock overwrites an explicit phase on the next update', () => {
    const sky = newSky();
    sky.syncGameClock(7620 * 50 - 3600); // phase 0
    sky.update(0);

    sky.updateTimeOfDay(0.0);              // what every capture tool used to do
    expect(sky.currentTimeOfDay).toBeCloseTo(0.0, 10); // it does apply...
    sky.update(762);                        // ...and one frame later it is gone
    expect(sky.currentTimeOfDay).toBeCloseTo(0.1, 10);
  });

  it('a freeze holds the phase across many updates on the SERVER-SYNCED clock', () => {
    const sky = newSky();
    sky.syncGameClock(7620 * 50 - 3600);
    sky.update(0);

    sky.freezeTimeOfDay(0.0);
    for (let i = 0; i < 20; i++) sky.update(762); // 2 full in-game days
    expect(sky.currentTimeOfDay).toBeCloseTo(0.0, 10);
  });

  it('a freeze holds the phase on the free-run (solo, no server clock) path', () => {
    const sky = newSky();
    sky.freezeTimeOfDay(0.25);
    for (let i = 0; i < 20; i++) sky.update(762);
    expect(sky.currentTimeOfDay).toBeCloseTo(0.25, 10);
  });

  it('releasing the freeze resumes normal advancement', () => {
    const sky = newSky();
    sky.syncGameClock(7620 * 50 - 3600);
    sky.update(0);
    sky.freezeTimeOfDay(0.0);
    sky.update(762);
    expect(sky.currentTimeOfDay).toBeCloseTo(0.0, 10);

    sky.freezeTimeOfDay(null);
    expect(sky.isTimeOfDayFrozen).toBe(false);
    sky.update(762);
    expect(sky.currentTimeOfDay).not.toBeCloseTo(0.0, 5);
  });

  it('freeze holds with AlwaysDaylightOutdoors on (which never touches the clock)', () => {
    const sky = newSky();
    sky.setForceDaylight(true);
    sky.freezeTimeOfDay(0.0);
    sky.update(762);
    expect(sky.currentTimeOfDay).toBeCloseTo(0.0, 10); // freeze, not noon
  });

  it('normalises an out-of-range phase the same way updateTimeOfDay does', () => {
    const sky = newSky();
    sky.freezeTimeOfDay(1.25);
    expect(sky.currentTimeOfDay).toBeCloseTo(0.25, 10);
    sky.freezeTimeOfDay(-0.25);
    expect(sky.currentTimeOfDay).toBeCloseTo(0.75, 10);
  });

  it('reports its own state so a capture harness can assert the pin took', () => {
    const sky = newSky();
    expect(sky.isTimeOfDayFrozen).toBe(false);
    sky.freezeTimeOfDay(0.5);
    expect(sky.isTimeOfDayFrozen).toBe(true);
    sky.freezeTimeOfDay(null);
    expect(sky.isTimeOfDayFrozen).toBe(false);
  });
});
