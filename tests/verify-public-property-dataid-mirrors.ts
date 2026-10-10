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
 * this suite now drives that real function directly. The Number.isFinite/
 * val>0 guard stays in main.ts's closure (not extracted, since it's a
 * generic wire-sanity check rather than PropertyDataId-specific mapping
 * logic) so that one assertion remains a narrow text check.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyPropertyDataIdUpdate, type ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

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

  it('main.ts still guards against non-finite + non-positive values before delegating', () => {
    const block = MAIN.match(/onPublicUpdatePropertyDataID:[\s\S]+?\n      \},/)?.[0] ?? '';
    const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).toMatch(/Number\.isFinite\(val\)/);
    expect(code).toMatch(/val\s*>\s*0/);
  });

  it('cites FAITHFUL.380 in the docblock', () => {
    expect(MAIN).toMatch(/FAITHFUL\.380/);
  });
});
