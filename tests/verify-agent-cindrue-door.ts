/**
 * Holtburg's Archmage Cindrue building (end of retail, landblock 0xA9B4, 2026-10-16 18:38–18:41Z, build a0ae4b87):
 * Arcanist bought from Archmage Cindrue upstairs (cell 0xA9B4011B, z 69) and walked out; Bulwark followed. Each
 * walk planned the doorway route down the stairwell (0x011B → 0x011E → 0x0117) and out through the east vestibule
 * 0x0119, whose outer doorway holds Door #7a9b400a (z 66). Still upstairs, the route's next doorway was already the
 * vestibule's, so the walk took its "shut door in the doorway ahead" detour at once: a 2D search to the door found the
 * upper floor right over it (0x011B covers (158.7, 133.5) at z 69), and the walk Used the door from 3 m above. ACE's
 * Use walks the player to the door first (Player.CreateMoveToChain, UseRadius 2, weenie 412) and never got there; the
 * walk waited its 8 s, read "did not open yet", Used it again (the server cancelled the first, UseDone), waited 8 s
 * more and routed round it, and the next key press cancelled the second Use (UseDone 100 ms after "routing round
 * it": no third Use was sent). The door never toggled. Both walkers lost ~20 s at it and Bulwark stood upstairs
 * against the wall meanwhile.
 * The world: ACE-World-16PY-Patches 6 LandBlockExtendedData/A9B4.sql (doors weenie 412 Setup 0x020019FF PhysicsState
 * 8, ResetInterval 300 s, UseRadius 2; Archmage Cindrue 2304, Asenala 49518, Monyra the Jeweler 716), cells and
 * statics from the cell DAT. DungeonHost `serverMoveTo` makes a Use wait for the body to reach the door as ACE does.
 * DAT-gated: loads in beforeAll.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import type { DungeonNav } from './_harness/dungeonNav.js';
import type { Ac1999Fixture } from './_harness/ac1999Fixtures.js';

const LB = 0xa9b40000;
const door = (guid: number, x: number, y: number, z: number, qw: number, qz: number): Ac1999Fixture => ({
  guid, wcid: 412, name: 'Door', cell: LB, x, y, z, quat: { w: qw, x: 0, y: 0, z: qz }, setupId: 0x020019ff, itemType: 128, physicsState: 8, locked: false, door: true,
});
const npc = (guid: number, wcid: number, name: string, cell: number, x: number, y: number, z: number, qw: number, qz: number, setupId: number): Ac1999Fixture => ({
  guid, wcid, name, cell: (LB | cell) >>> 0, x, y, z, quat: { w: qw, x: 0, y: 0, z: qz }, setupId, itemType: 0x10, physicsState: 0x200418, locked: false, door: false,
});
const FIXTURES: Ac1999Fixture[] = [
  door(0x7a9b4009, 148.525, 131.611, 66, -0.924213, 0.381878),
  door(0x7a9b400a, 159.73, 133.93, 66, 0.381878, 0.924213),
  npc(0x7a9b4033, 2304, 'Archmage Cindrue', 0x11b, 152.347, 132.546, 69.005, -0.375336, -0.926889, 0x0200004e),
  npc(0x7a9b4077, 49518, 'Asenala', 0x11b, 155.743, 129.897, 69.0058, -0.926086, -0.377311, 0x02001a10),
  npc(0x7a9b4020, 716, 'Monyra the Jeweler', 0x117, 157.19, 135.298, 66.12, 0.972978, 0.230899, 0x0200004e),
];

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('Archmage Cindrue building (landblock 0xA9B4, end of retail)', () => {
  let nav: DungeonNav;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.js');
    nav = await dungeonNav(LB, { statics: true, ground: 66 });
  }, 120_000);
  afterEach(() => vi.useRealTimers());

  it('walks down from Cindrue and out the east door: Uses it only from its own floor, once, and it opens', async () => {
    vi.useFakeTimers();
    const { DungeonHost } = await import('./_harness/dungeonWalk.js');
    const host = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB, { fixtures: FIXTURES, creatures: true, serverMoveTo: true });
    host.objectReach = (g) => (host.object(g)?.itemType ?? 0) & 0x10 ? 0.4 : 0;
    // Where the body stood for each Use: on the door's floor (z 66), not the upper room's (z 69) over it.
    const usedFrom: number[] = [];
    const use = host.use;
    host.use = (g: number) => { usedFrom.push(host.me.z); return use(g); };
    try {
      const r = await host.walk(0xa9b4011b, { x: 153.6, y: 133.6, z: 69 }, { cell: LB | 0x36, x: 162, y: 136.2, z: 66, name: 'Outside the east door', itemType: 0 }, { within: 1.5, maxMs: 120_000 });
      expect(r, host.traces.join('\n')).toMatchObject({ ok: true });
      expect(host.usesCancelled, host.traces.join('\n')).toEqual([]);
      expect(host.doorToggles, host.traces.join('\n')).toEqual(['7a9b400a open']);
      expect(usedFrom.map((z) => Math.round(z))).toEqual([66]);
      expect(host.traces.filter((l) => /did not open|routing round it/.test(l))).toEqual([]);
    } finally {
      host.dispose();
    }
  }, 120_000);
});
