/**
 * The Holtburg scriveners' building (end of retail, landblock 0xA9B3, 2026-10-16 10:55–11:06Z): Arcanist bought from
 * the Scrivener of War Magic and stood in cell 0xA9B30102 behind him. Every walk out (walk_to Renald the Eldest, a
 * follow of Bulwark) stalled in place for minutes, Used "Door" #7a9b3006 six times and gave up ("tried the door, which
 * stayed shut: locked"). Two causes, both reproduced here on the real cells:
 *  1. #7a9b3006 is the UPSTAIRS balcony door (z 119, over the ground-floor doorways at z 116): the walk's
 *     door-in-the-doorway match was 2D, so it detoured to a door 3 m overhead and Used it again and again (each Use
 *     swings an ACE door the other way: Door.ActOnUse), then called it locked after two silent Uses.
 *  2. The Scrivener of War Magic stands beside the doorway out of 0x0102: the walk's probe leaves creatures out (they
 *     move), so every search led through his body and the body stood against him.
 * The world: ACE-World-16PY-Patches 6 LandBlockExtendedData/A9B3.sql (doors weenie 412 "door-aluvian-house", Setup
 * 0x0200027C, PhysicsState 8, unlocked; the scriveners weenies 20205–20226, Setups 0x02000001 / 0x0200004E,
 * PhysicsState 0x200418), the cells and their statics from the cell DAT. DAT-gated: loads in beforeAll.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import type { DungeonNav } from './_harness/dungeonNav.js';
import type { Ac1999Fixture } from './_harness/ac1999Fixtures.js';

const LB = 0xa9b30000;
const door = (guid: number, x: number, y: number, z: number, qw: number, qz: number): Ac1999Fixture => ({
  guid, wcid: 412, name: 'Door', cell: LB, x, y, z, quat: { w: qw, x: 0, y: 0, z: qz }, setupId: 0x0200027c, itemType: 128, physicsState: 8, locked: false, door: true,
});
const npc = (guid: number, wcid: number, name: string, cell: number, x: number, y: number, z: number, qw: number, qz: number, setupId: number): Ac1999Fixture => ({
  guid, wcid, name, cell: (LB | cell) >>> 0, x, y, z, quat: { w: qw, x: 0, y: 0, z: qz }, setupId, itemType: 0x10, physicsState: 0x200418, locked: false, door: false,
});
const FIXTURES: Ac1999Fixture[] = [
  door(0x7a9b3004, 180.2, 77.59, 116.01, 1, 0),
  door(0x7a9b3005, 184.695, 82.545, 115.995, 0.707107, 0.707107),
  door(0x7a9b3006, 183.245, 83.895, 118.995, 1, 0),
  door(0x7a9b3007, 182.21, 80.19, 119, 0.707107, 0.707107),
  npc(0x7a9b3009, 20217, 'Apprentice Scrivener of Life Magic', 0x102, 184.705, 85.6623, 116.005, -0.640611, -0.767865, 0x02000001),
  npc(0x7a9b300a, 20205, 'Apprentice Scrivener of Creature Magic', 0x103, 178.117, 85.9785, 116.005, 0.34272, -0.939438, 0x0200004e),
  npc(0x7a9b3016, 20209, 'Journeyman Scrivener of Creature Magic', 0x108, 184.464, 86.8825, 119.005, -0.561384, -0.827555, 0x0200004e),
  npc(0x7a9b3017, 20210, 'Scrivener of Creature Magic', 0x108, 182.096, 88.1446, 119.005, -0.287065, -0.957911, 0x0200004e),
  npc(0x7a9b3018, 20226, 'Scrivener of War Magic', 0x100, 182.336, 87.0061, 116.005, -0.001401, -0.999999, 0x0200004e),
  npc(0x7a9b3013, 43354, 'Scrivener of Void Magic', 0x103, 177.444, 79.747, 116.005, 0.812668, -0.582727, 0x02000001),
];

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('Holtburg scriveners (landblock 0xA9B3, end of retail)', () => {
  let nav: DungeonNav;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.js');
    nav = await dungeonNav(LB, { statics: true });
  }, 120_000);
  afterEach(() => vi.useRealTimers());

  for (const start of [{ x: 182.8, y: 87.9, z: 116 }, { x: 183.3, y: 87.2, z: 116.815 }]) {
    it(`walks out of 0x0102 from (${start.x}, ${start.y}) past the scrivener, never Using the door upstairs`, async () => {
      vi.useFakeTimers();
      const { DungeonHost } = await import('./_harness/dungeonWalk.js');
      const host = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB, { fixtures: FIXTURES, creatures: true });
      host.objectReach = (g) => (host.object(g)?.itemType ?? 0) & 0x10 ? 0.4 : 0;
      try {
        // The front vestibule (0x0105), inside the front door #7a9b3004: the way out toward Renald.
        const r = await host.walk(0xa9b30102, start, { cell: 0xa9b30105, x: 180.2, y: 78.6, z: 116, name: 'Front hall', itemType: 0 }, { within: 1, maxMs: 120_000 });
        expect(r, host.traces.join('\n')).toMatchObject({ ok: true });
        expect(host.sent.filter((s) => s === 'use 7a9b3006' || s === 'use 7a9b3007'), host.traces.join('\n')).toEqual([]);
        expect(host.traces.filter((l) => /\blocked\b|did not open/.test(l))).toEqual([]);
      } finally {
        host.dispose();
      }
    }, 120_000);
  }
});
