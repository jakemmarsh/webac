/**
 * FAITHFUL.526 — Radar isIndoors flips to true inside surface buildings.
 *
 *  ACE `LandblockId.cs:71` defines Indoors as
 *    `(Raw & 0xFFFF) >= 0x100`
 *  — true for ANY interior cell within a landblock (cell IDs 0x0100+),
 *  which covers BOTH dungeons AND surface-building EnvCells (e.g. inside
 *  a Holtburg hut on an outdoor landblock).
 *
 *  ACE `Player.cs:78` then ties radar range to that flag:
 *    `CurrentRadarRange => Location.Indoors ? 25.0f : 75.0f`
 *
 *  Pre-fix `gameUI.hudState.isIndoors = playerInDungeon` only flipped to
 *  true for dungeon landblocks. Walking into a small surface building
 *  kept the radar at the 75m outdoor range — visibly wrong (radar still
 *  showed distant outdoor creatures through walls, vs retail's
 *  immediate 25m clamp the moment you crossed the doorway).
 *
 *  Fix: or-in the player's surface interior cell (CORE.14.b BSP
 *  containment, `currentSurfaceCellId`). VISUAL.radar-coord-plate-missing-pit
 *  (2026-10-04) — this used to be the building shells' XZ-bbox `wasInside`,
 *  which counted the Xarabydun pit's outdoor rim as indoors.
 *
 *  REND.per-frame-allocations — both main.ts sites now call the shipped
 *  RadarBlips.radarIsIndoors, and the range the radar populate
 *  (RadarDotFeed) and drawRadar use is radarRangeFor; this suite drives
 *  those instead of source-grepping main.ts (converted from a text pin).
 */
import { describe, it, expect } from 'vitest';
import {
  radarIsIndoors, radarRangeFor, RADAR_RANGE_INDOORS, RADAR_RANGE_OUTDOORS, RadarDotFeed,
  type RadarFeedObject,
} from '../packages/renderer/src/ui/RadarBlips.js';

describe('FAITHFUL.526 — isIndoors covers surface buildings', () => {
  it('a dungeon is indoors', () => {
    expect(radarIsIndoors(true, 0)).toBe(true);
  });

  it('standing in ANY surface interior cell is indoors (ORed with playerInDungeon) — the cell, not the building footprint', () => {
    expect(radarIsIndoors(false, 0xA9B4016A)).toBe(true); // a Holtburg hut cell
    expect(radarIsIndoors(false, 0)).toBe(false);          // outdoors
    // VISUAL.radar-coord-plate-missing-pit — the Xarabydun rim is outdoor
    // cell 0x934B0021 though it lies inside the pit building's footprint
    expect(radarIsIndoors(false, 0x934B0021)).toBe(false);
  });

  it('radar range follows ACE Player.cs CurrentRadarRange: 25 m indoors, 75 m outdoors', () => {
    expect(RADAR_RANGE_INDOORS).toBe(25);
    expect(RADAR_RANGE_OUTDOORS).toBe(75);
    expect(radarRangeFor(radarIsIndoors(false, 0xA9B4016A))).toBe(25);
    expect(radarRangeFor(radarIsIndoors(false, 0))).toBe(75);
  });

  it('stepping into a hut clamps the radar populate to the indoor range the same frame', () => {
    const feed = new RadarDotFeed<RadarFeedObject>();
    const creature: RadarFeedObject = { guid: 1, worldX: 40, worldY: 0, worldZ: 0, radarColor: 2, name: 'Drudge' };
    const ctx = {
      playerWorldX: 0, playerWorldZ: 0, playerFeetY: 0, range: 0,
      fellows: null, fellowshipLeaderGuid: 0, playerMonarchGuid: undefined, playerPKStatus: undefined,
      eligible: () => true,
    };
    ctx.range = radarRangeFor(radarIsIndoors(false, 0));
    expect(feed.build([creature], ctx).map(d => d.guid)).toEqual([1]); // 40 m < 74
    ctx.range = radarRangeFor(radarIsIndoors(false, 0xA9B4016A));
    expect(feed.build([creature], ctx)).toHaveLength(0); // 40 m ≥ 24 — through the walls no more
  });
});
