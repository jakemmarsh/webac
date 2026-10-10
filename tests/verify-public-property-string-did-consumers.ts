/**
 * FAITHFUL.378 — PublicUpdatePropertyString (Name=1) +
 *  PublicUpdatePropertyDataID (Icon=8) actually mirror to the
 *  ServerObject + HUD target frame.
 *
 * Pre-fix both handlers were diagnostic-only. ACE broadcasts these for:
 *  - PropertyString.Name = 1 — @rename, allegiance officer affix
 *    updates, etc. (Player_AdminCommands.cs:1042 +
 *    Server_Allegiance.cs).
 *  - PropertyDataId.Icon = 8 — item icon swaps mid-life (charges
 *    depleted, condition flip).
 *
 * The 3D name label rerenders from `obj.name` each frame so updating
 * the mirror field is sufficient there. The HUD target panel captures
 * the name into its own state at selectTarget time, so a separate copy
 * is required when the renamed object is the current target.
 *
 * ACE refs:
 *   reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyString.cs:5
 *     → Name = 1
 *   reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyDataId.cs:14
 *     → Icon = 8
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

describe('PublicUpdatePropertyString consumes Name=1 (FAITHFUL.378)', () => {
  const block = MAIN.match(/onPublicUpdatePropertyString:[\s\S]+?\n      \},/)?.[0] ?? '';
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('branches on data.key === 1', () => {
    expect(code).toMatch(/data\.key === 1/);
  });

  it('mutates ServerObject.name when guid is known', () => {
    expect(code).toMatch(/obj\.name = val/);
  });

  it('updates HUD target-frame label when guid matches current target', () => {
    expect(code).toMatch(/currentTargetGuid === data\.guid/);
    expect(code).toMatch(/gameUI\.hudState\.target\.name = val/);
  });

  it('guards against empty-string + non-string broadcasts', () => {
    expect(code).toMatch(/typeof val === 'string'/);
    expect(code).toMatch(/val\.length\s*>\s*0/);
  });
});

// CONVERTED from a source-text pin to a behavioral test (BUG.icon-overlay-
// underlay-dropped pulled the switch out of main.ts into the exported
// `applyPropertyDataIdUpdate`; see verify-public-property-dataid-mirrors.ts
// for the full case coverage). The guard clause stays a text check since
// it's still inline in main.ts's closure.
describe('PublicUpdatePropertyDataID consumes Icon=8 (FAITHFUL.378)', () => {
  it('key=8 mutates ServerObject.iconId via applyPropertyDataIdUpdate', () => {
    const obj = baseObj();
    applyPropertyDataIdUpdate(obj, 8, 0x06005678);
    expect(obj.iconId).toBe(0x06005678);
  });

  it('main.ts guards against non-finite + non-positive values before delegating', () => {
    const block = MAIN.match(/onPublicUpdatePropertyDataID:[\s\S]+?\n      \},/)?.[0] ?? '';
    const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).toMatch(/Number\.isFinite\(val\)/);
    expect(code).toMatch(/val\s*>\s*0/);
  });
});

describe('Both handlers cite FAITHFUL.378', () => {
  it('citation present in main.ts', () => {
    expect(MAIN).toMatch(/FAITHFUL\.378/);
  });
});
