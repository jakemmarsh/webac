/**
 * FAITHFUL.380 — PublicUpdatePropertyDataID mirrors Setup (1),
 *  MotionTable (2), SoundTable (3), Icon (8) onto ServerObject so
 *  downstream paths see server-current values.
 *
 * Pre-fix only Icon was mirrored (FAITHFUL.378). When ACE broadcast a
 * model swap (Setup), motion-table swap (MotionTable), or weapon hit-
 * sound swap (SoundTable), the ServerObject mirror stayed frozen at
 * CreateObject-time values — meaning a subsequent appearance-rebuild
 * (FAITHFUL.276) or animation playback would use the stale DID.
 *
 * Examples of when ACE broadcasts:
 *  - Polymorph spells → Setup change
 *  - Mount/dismount → MotionTable change
 *  - Weapon swap → SoundTable change (hit-sound bank)
 *
 * ACE refs:
 *   reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyDataId.cs:6-8 →
 *     Setup=1, MotionTable=2, SoundTable=3
 *   reference/ACE/Source/ACE.Server/WorldObjects/Player_Properties.cs:1158-1168
 *     → broadcast wire path
 *
 * CONVERTED from a source-text pin (regex-matched the raw switch cases
 * inline in main.ts's onPublicUpdatePropertyDataID) to a behavioral test
 * per CLAUDE.md ("Never Break Tests" — source-text pins catch nothing).
 * BUG.icon-overlay-underlay-dropped pulled the switch out of main.ts into
 * `applyPropertyDataIdUpdate` (packages/renderer/src/world/
 * ServerObjectManager.ts) so it's a plain function main.ts delegates to —
 * this suite now drives that real function directly. The value guard moved
 * with the rest of the consumer into network/applyPublicPropertyDataId.ts
 * (GAP.gdle-qualities-remove-events), so it is driven for real too.
 */
import { describe, it, expect } from 'vitest';
import { applyPropertyDataIdUpdate, type ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';
import { applyPublicPropertyDataIdUpdate } from '../packages/renderer/src/network/applyPublicPropertyDataId.js';

function baseObj(): ServerObject {
  return {
    guid: 1, name: '', weenieClassId: 0, setupId: 0, iconId: 0, itemType: 0,
    physicsState: 0, position: null, worldX: 0, worldY: 0, worldZ: 0,
    radarColor: 0, radarBehavior: 0, usable: 0, targetType: 0, useRadius: 0.6, stackSize: 0, mesh: null, basePalette: 0,
    subPalettes: [], textureChanges: [], animPartChanges: [], motionTableId: 0,
    soundTableId: 0, objectDescFlags: 0, wielderId: 0, wieldedLocation: 0,
    parentLocation: 0,
    collisionRadius: 0, blockRadius: 0, collisionHeight: 0,
    cellId: 0, healthCurrent: 0, healthMax: 0, staminaCurrent: 0,
    staminaMax: 0, manaCurrent: 0, manaMax: 0, lastStateSequence: -1, lastVisualDescSeq: -1,
  };
}

describe('PublicUpdatePropertyDataID mirrors Setup/MotionTable/SoundTable/Icon (FAITHFUL.380)', () => {
  const cases: Array<[string, number, keyof ServerObject]> = [
    ['Setup → setupId', 1, 'setupId'],
    ['MotionTable → motionTableId', 2, 'motionTableId'],
    ['SoundTable → soundTableId', 3, 'soundTableId'],
    ['Icon → iconId (FAITHFUL.378 still wired)', 8, 'iconId'],
  ];

  it.each(cases)('handles %s', (_name, key, field) => {
    const obj = baseObj();
    applyPropertyDataIdUpdate(obj, key, 0x06001234);
    expect(obj[field]).toBe(0x06001234);
  });

  it('the consumer skips non-finite and zero values for Setup (an object never loses its Setup)', () => {
    const obj = baseObj();
    obj.setupId = 0x02000001;
    const deps = { getObject: () => obj, inventory: { applyPublicPropertyDataId: () => false }, onInventoryItemChanged: () => {}, log: () => {} };
    applyPublicPropertyDataIdUpdate({ guid: 1, key: 1, value: Number.NaN }, deps);
    applyPublicPropertyDataIdUpdate({ guid: 1, key: 1, value: 0 }, deps);
    expect(obj.setupId).toBe(0x02000001);
    applyPublicPropertyDataIdUpdate({ guid: 1, key: 1, value: 0x02000002 }, deps);
    expect(obj.setupId).toBe(0x02000002);
  });
});
