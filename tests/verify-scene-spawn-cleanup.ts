/**
 * HARNESS.scene-spawn-leak — capture scenes that @create / @ci objects clean
 * them up (tools/capture-scenes.ts leftoversOf + SPAWNED_WCIDS). The 2026-10-01
 * GPU calibration showed a bookshelf in one side's house scene and a table in
 * the other's: spawned objects outlived their scene.
 */
import { describe, it, expect } from 'vitest';
import { SCENES, SPAWNED_WCIDS, leftoversOf } from '../tools/capture-scenes.js';

describe('scene spawn cleanup', () => {
  it('every scene whose page JS @creates an object declares the classes in spawns', () => {
    for (const s of SCENES) {
      const created = [...(s.evalJs ?? '').matchAll(/@create (\d+)/g)].map((m) => Number(m[1]));
      for (const wcid of created) expect(s.spawns ?? [], `${s.name} @creates ${wcid}`).toContain(wcid);
    }
    expect(SPAWNED_WCIDS).toEqual(expect.arrayContaining([1115, 143]));
  });

  it('leftoversOf: new inventory items + new dynamic objects of the declared classes, nothing else', () => {
    const before = { inv: [0x80000010], world: [0x80000100, 0x7a9b4001] };
    const after = {
      inv: [0x80000010, 0x80000020, 0x80000021],            // two items @ci'd by the scene
      world: [
        { guid: 0x80000100, wcid: 143 },                      // a chest that was already there: kept
        { guid: 0x80000200, wcid: 143 },                      // the chest the scene created: removed
        { guid: 0x80000300, wcid: 999 },                      // something else that walked in: kept
        { guid: 0x7a9b4002, wcid: 143 },                      // a landblock-placed chest: never touched
        { guid: 0x80000020, wcid: 258 },                      // an inventory item also listed in the world: once
      ],
    };
    // containers first (their contents go with them), then the scene's new inventory items
    expect(leftoversOf(before, after, [143])).toEqual([0x80000200, 0x80000020, 0x80000021]);
    expect(leftoversOf(before, { inv: before.inv, world: [] }, [143])).toEqual([]);
  });

  it('regressionHideParticles is only used on world scenes (it hides the particle systems for a regression shot)', () => {
    const flagged = SCENES.filter((s) => s.regressionHideParticles);
    expect(flagged.map((s) => s.name)).toContain('world-dungeon');
    for (const s of flagged) expect(s.teleport, s.name).toBeTruthy();
  });
});
