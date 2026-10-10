/**
 * FAITHFUL.574 — parseCreateObject must surface `parentLocation` from the
 * PhysicsDescriptionFlag.Parent block. Pre-fix the parser read both
 * `wielderId` and `parentLocation` from the Parent block but stored
 * NEITHER (two `r.readUInt32()` reads with no assignment) — wielderId
 * was harmless because the WeenieHeaderFlag.Wielder block writes the
 * same value and that one was captured, but ParentLocation has no other
 * source on the wire.
 *
 * Wire format per ACE
 * `reference/ACE/Source/ACE.Server/WorldObjects/WorldObject_Networking.cs:358-362`:
 *
 *   if ((physicsDescriptionFlag & PhysicsDescriptionFlag.Parent) != 0)
 *   {
 *       writer.Write(WielderId ?? 0);
 *       writer.Write((uint)(ParentLocation ?? 0));
 *   }
 *
 * `ParentLocation` is the visual attachment point enum (RightHand=1,
 * LeftHand=2, Shield=3, ...) used to attach the wielded item's mesh to
 * a SetupModel `holdingLocations` slot. Pre-fix the equipped-item
 * visualization in main.ts had to DERIVE this from EquipMask +
 * DefaultCombatStyle via `wieldLocationFromMask` — which works for the
 * 4 weapon EquipMasks but returns `ParentLocation.None` for everything
 * else and can't represent unusual server-side overrides.
 *
 * The fix:
 * 1. CreateObjectData adds `parentLocation: number` (0 = no Parent block).
 * 2. parseCreateObject captures the second uint32 of the Parent block.
 * 3. ServerObject mirrors the field so the case-(b) "creature arrives
 *    after its wielded item" path can use it without re-querying the raw
 *    CreateObjectData.
 * 4. main.ts onObjectCreate prefers `data.parentLocation` over
 *    `wieldLocationFromMask(...)` when non-zero, for both the local-player
 *    and NPC/creature attach paths.
 */
import { describe, it, expect } from 'vitest';
import { attachOnItemCreate, heldItemsOf } from '../packages/renderer/src/world/WieldAttach.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCreateObject } from '@ac/network';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');
const SERVER_OBJ = readFileSync(resolve(REPO, 'packages/renderer/src/world/ServerObjectManager.ts'), 'utf-8');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');
const ACE_NW = readFileSync(resolve(REPO, 'reference/ACE/Source/ACE.Server/WorldObjects/WorldObject_Networking.cs'), 'utf-8');

/* ================================================================ */
/*  Synthetic CreateObject payload builder                          */
/*  Mirrors the exact read order of parseCreateObject               */
/*  (packages/network/src/MessageSerializer.ts) for the minimal     */
/*  fields this test cares about: model header (no sub-blocks),     */
/*  physics header with only the Parent bit (0x20) optionally set,  */
/*  9 zeroed sequence u16s, then a zero-flags weenie header (no      */
/*  optional weenie fields, empty name) so every downstream          */
/*  conditional read is skipped and the payload ends deterministically. */
/* ================================================================ */

function u32(n: number): number[] {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return Array.from(b);
}
function u16(n: number): number[] {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff, true);
  return Array.from(b);
}

function buildCreateObjectPayload(opts: { guid: number; hasParent: boolean; wielderId?: number; parentLocation?: number }): Uint8Array {
  const PARENT_BIT = 0x000020; // PhysicsDescFlag.Parent
  const physFlags = opts.hasParent ? PARENT_BIT : 0;
  const bytes: number[] = [
    ...u32(opts.guid),
    0x11, 0, 0, 0, // modelByte=0x11, numSubPalettes/numTexChanges/numAnimParts=0
    ...u32(physFlags),
    ...u32(0), // physicsState
  ];
  if (opts.hasParent) {
    bytes.push(...u32(opts.wielderId ?? 0)); // wielderId (discarded — duplicate of WeenieHeaderFlag.Wielder)
    bytes.push(...u32(opts.parentLocation ?? 0)); // parentLocation
  }
  bytes.push(...Array(18).fill(0)); // 9x u16 sequence timestamps
  bytes.push(0, 0); // align(4) pad (42 % 4 === 2)
  bytes.push(...u32(0)); // weenieFlags = 0 (no optional weenie fields)
  bytes.push(...u16(0)); // name length = 0
  bytes.push(0, 0); // readString16 pad (2 + 0 = 2, pad to 4)
  bytes.push(...u16(1)); // weenieClassId (packed dword, <= 0x7FFF => 2 bytes)
  bytes.push(...u16(2)); // iconId (packed dword, <= 0x7FFF => 2 bytes)
  bytes.push(...u32(0)); // itemType
  bytes.push(...u32(0)); // objectDescFlags = 0 (no second header, no house restrictions)
  return new Uint8Array(bytes);
}

describe('FAITHFUL.574 — parseCreateObject captures parentLocation from the wire', () => {
  it('Parent block present: returns the real ParentLocation value (RightHand=1)', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({ guid: 0x50000001, hasParent: true, wielderId: 0x50000099, parentLocation: 1 }));
    expect(obj).not.toBeNull();
    expect(obj!.guid).toBe(0x50000001);
    expect(obj!.parentLocation).toBe(1);
  });

  it('Parent block present: a different ParentLocation value (Shield=3) round-trips', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({ guid: 0x50000002, hasParent: true, parentLocation: 3 }));
    expect(obj!.parentLocation).toBe(3);
  });

  it('Parent block absent: parentLocation defaults to 0', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({ guid: 0x50000003, hasParent: false }));
    expect(obj!.parentLocation).toBe(0);
  });

  it('Parent block present: wielderId is consumed from the wire but not required to equal parentLocation (proves the two reads are independent, not the pre-fix bug where both were silently dropped)', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({ guid: 0x50000004, hasParent: true, wielderId: 0x5000abcd, parentLocation: 2 }));
    expect(obj!.parentLocation).toBe(2);
    expect(obj!.parentLocation).not.toBe(0x5000abcd);
  });
});

/* ================================================================ */
/*  ServerObject mirrors parentLocation + main.ts precedence wiring  */
/*  (secondary text checks — ServerObjectManager.createObject needs a */
/*  full DAT-backed asset pipeline to exercise end-to-end, so these    */
/*  anchor the wiring around the now-behaviorally-verified parser      */
/*  output above; primary coverage is the parseCreateObject block.)    */
/* ================================================================ */

describe('FAITHFUL.574 — ServerObject mirrors parentLocation', () => {
  it('ServerObject interface declares parentLocation: number', () => {
    expect(SERVER_OBJ).toMatch(/parentLocation:\s*number/);
  });

  it('createObject copies data.parentLocation onto the new ServerObject', () => {
    expect(SERVER_OBJ).toMatch(/parentLocation:\s*data\.parentLocation \|\| 0/);
  });

  it('mesh-rebuild path resets parentLocation to 0 (matches sibling wielderId/wieldedLocation resets)', () => {
    expect(SERVER_OBJ).toMatch(/currentWieldedLocation:\s*0,\s*parentLocation:\s*0/);
  });
});

describe('FAITHFUL.574 — main.ts onObjectCreate prefers parentLocation over wieldLocationFromMask', () => {
  it('local-player attach path: data.parentLocation || wieldLocationFromMask(...)', () => {
    expect(MAIN).toMatch(/data\.parentLocation \|\| wieldLocationFromMask\(data\.currentWieldedLocation,\s*data\.weenieClassId\)/);
  });

  // The creature paths are behavioral now (world/WieldAttach.ts): retail
  // HandleCreateObject parents by the PhysicsDesc Parent block alone, so
  // the EquipMask fallback is gone for other creatures' items.
  it('NPC/creature attach (item arrives first): the Parent block decides; no block, no attach', () => {
    expect(attachOnItemCreate({ guid: 0x81, physicsParentId: 0x50, parentLocation: 3 }, 0x5000000a)).toEqual({ holder: 0x50, location: 3 });
    expect(attachOnItemCreate({ guid: 0x81, physicsParentId: 0, parentLocation: 0 }, 0x5000000a)).toBeNull();
    expect(attachOnItemCreate({ guid: 0x81, physicsParentId: 0x50, parentLocation: 0 }, 0x5000000a)).toBeNull();
    expect(attachOnItemCreate({ guid: 0x81, physicsParentId: 0x5000000a, parentLocation: 1 }, 0x5000000a)).toBeNull(); // ours: the player path
  });

  it('NPC/creature attach (creature arrives after the item): records parented to it with a location', () => {
    const records = [
      { guid: 1, wielderId: 0x50, parentLocation: 1 },
      { guid: 2, wielderId: 0x50, parentLocation: 0 }, // worn, no Parent block
      { guid: 3, wielderId: 0x51, parentLocation: 3 },
    ];
    expect(heldItemsOf(0x50, records)).toEqual([{ item: 1, location: 1 }]);
  });
});

/* ================================================================ */
/*  ACE source still anchors the fix                                  */
/* ================================================================ */

describe('FAITHFUL.574 — ACE source still anchors the wire format', () => {
  it('ACE WorldObject_Networking.cs still writes WielderId then ParentLocation under the Parent bit', () => {
    expect(ACE_NW).toMatch(/PhysicsDescriptionFlag\.Parent\)[\s\S]+?writer\.Write\(WielderId \?\? 0\);[\s\S]+?writer\.Write\(\(uint\)\(ParentLocation \?\? 0\)\)/);
  });

  it('ACE WorldObject_Networking.cs still gates the Parent bit on (WielderId != null && ParentLocation != null)', () => {
    expect(ACE_NW).toMatch(/WielderId != null && ParentLocation != null[\s\S]+?physicsDescriptionFlag \|= PhysicsDescriptionFlag\.Parent/);
  });
});
