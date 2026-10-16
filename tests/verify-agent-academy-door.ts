/**
 * The Training Academy start room (end of retail, landblock 0x7202, 2026-10-16): walk_to the Society Greeter
 * (#8000c42f, cell 0x720201AD) from 0x720201B1, a closed Door (#77202033) in the doorway between. Live, the stall
 * fallback Used the door the walk's detour was going to open, then the detour Used it again on arriving, which
 * swung it shut (ACE Door.ActOnUse toggles an unlocked door); the walk judged it "did not open", routed round it and
 * gave up "stuck 6.1 m short". The walk now Uses the door once, and goes through.
 *
 * The real collision of the landblock's cells (dungeonNav), its doorway graph, and the door as the server places it:
 * ACE-World-16PY-Patches 6 LandBlockExtendedData/7202.sql (0x77202033, weenie 12705 "Academy Practice Area Door",
 * cell 0x720201B4 at (15.0489, -29.9918, 0), quat (-0.707107, 0, 0, -0.707107)), Setup 0x020005DA, PhysicsState 24
 * (9 WeenieDefaults/SQL/Door/Misc/12705). DAT-gated: the cell DAT loads in beforeAll.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import type { DungeonNav } from './_harness/dungeonNav.js';

const LB = 0x72020000;
const DOOR = 0x77202033;

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('Training Academy door 0x77202033 (landblock 0x7202, end of retail)', () => {
  let nav: DungeonNav;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.js');
    nav = await dungeonNav(LB);
  }, 120_000);
  afterEach(() => vi.useRealTimers());

  it('opens the shut door once and walks through to the Society Greeter', async () => {
    vi.useFakeTimers();
    const { DungeonHost } = await import('./_harness/dungeonWalk.js');
    const host = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB, {
      fixtures: [{
        guid: DOOR, wcid: 12705, name: 'Door', cell: 0x720201b4, x: 15.0489, y: -29.9918, z: 0,
        quat: { w: -0.707107, x: 0, y: 0, z: -0.707107 }, setupId: 0x020005da, itemType: 128, physicsState: 24, locked: false, door: true,
      }],
    });
    try {
      // Where the live walk began its last leg (21903.9, 352.3) = landblock-local (15.9, -31.7); the greeter at (9.8, -31.7).
      const r = await host.walk(0x720201b1, { x: 15.9, y: -31.7, z: 0 }, { cell: 0x720201ad, x: 9.8, y: -31.7, z: 0, name: 'Society Greeter', itemType: 0x10 }, { within: 1.5, maxMs: 120_000 });
      expect(r, host.traces.join('\n')).toMatchObject({ ok: true });
      expect(host.sent.filter((s) => s === `use ${DOOR.toString(16)}`)).toHaveLength(1);
      expect(host.traces.filter((l) => /did not open|routing round/.test(l))).toEqual([]);
    } finally {
      host.dispose();
    }
  }, 120_000);
});
