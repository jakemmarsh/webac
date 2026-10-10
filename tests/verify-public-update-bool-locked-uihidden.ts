/**
 * FAITHFUL.364 — Apply PropertyBool.Locked + UiHidden broadcasts to the
 *  mirrored ServerObject.
 *
 * Sibling of FAITHFUL.344 (Int — RadarBlipColor/PlayerKillerStatus/
 * UiEffects) and FAITHFUL.345 (InstanceID — Wielder). Pre-fix the
 * `onPublicUpdatePropertyBool` consumer only console.log'd these,
 * leaving the mirrored ServerObject's `isLocked` / `uiHidden` fields
 * frozen at their CreateObject-time values. Visible bugs:
 *
 *   PropertyBool.Locked — ACE Chest.cs:251, Door.cs:220, Lock.cs:275,310
 *     broadcast lock-state changes. Without applying these:
 *       - Locked door icon stays on the cursor after lockpicking unlocks
 *         the door
 *       - Chest interaction prompt continues to say "Locked" after a key
 *         unlocks it
 *   PropertyBool.UiHidden — ACE Hook.cs:259 broadcasts the homeowner's
 *     "show item on hook" toggle. Without applying these:
 *       - Hook display item remains visible even after the homeowner
 *         hides it (until the observer leaves + re-enters visual range)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');
const SOM = readFileSync(resolve(REPO, 'packages/renderer/src/world/ServerObjectManager.ts'), 'utf8');

describe('PublicUpdatePropertyBool routes Locked + UiHidden (FAITHFUL.364)', () => {
  it('handler updates obj.isLocked when key === PropertyBool.Locked', () => {
    const block = MAIN.match(/onPublicUpdatePropertyBool:[\s\S]+?^      \},/m)?.[0] ?? '';
    expect(block).toMatch(/case PropertyBool\.Locked/);
    expect(block).toMatch(/obj\.isLocked\s*=\s*val/);
  });

  it('handler updates obj.uiHidden when key === PropertyBool.UiHidden', () => {
    const block = MAIN.match(/onPublicUpdatePropertyBool:[\s\S]+?^      \},/m)?.[0] ?? '';
    expect(block).toMatch(/case PropertyBool\.UiHidden/);
    expect(block).toMatch(/obj\.uiHidden\s*=\s*val/);
  });

  it('handler safely no-ops when the guid is unknown (obj is undefined)', () => {
    const block = MAIN.match(/onPublicUpdatePropertyBool:[\s\S]+?^      \},/m)?.[0] ?? '';
    expect(block).toMatch(/if \(obj\)/);
  });

  it('still logs the diagnostic line', () => {
    const block = MAIN.match(/onPublicUpdatePropertyBool:[\s\S]+?^      \},/m)?.[0] ?? '';
    expect(block).toContain('console.log(`[Property] PublicBool');
  });

  it('cites ACE emit sites for both keys', () => {
    const block = MAIN.match(/onPublicUpdatePropertyBool:[\s\S]+?^      \},/m)?.[0] ?? '';
    expect(block).toMatch(/Chest\.cs|Door\.cs|Lock\.cs/);
    expect(block).toContain('Hook.cs');
  });
});

describe('ServerObject declares the new optional bool mirror fields', () => {
  it('isLocked + uiHidden declared on ServerObject interface', () => {
    expect(SOM).toMatch(/isLocked\?:\s*boolean/);
    expect(SOM).toMatch(/uiHidden\?:\s*boolean/);
  });
});
