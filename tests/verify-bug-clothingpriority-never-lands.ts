/**
 * BUG.clothingpriority-never-lands — ClothingPriority used to be lost twice:
 *
 *  (a) parseCreateObject read the WeenieHeaderFlag.Priority uint (which ACE
 *      fills from item.ClothingPriority, WorldObject_Networking.cs:141-142)
 *      as a bare r.readUInt32() and assigned it to nothing, so the
 *      authoritative per-object source was discarded on every CreateObject.
 *  (b) The FAITHFUL.599 login stamp looped serverObjectManager.getObject()
 *      inside onPlayerDescription, but equipped-item CreateObjects arrive
 *      only afterward (ACE Player_Networking.cs:214-229: UIQueue 0x09
 *      flushes before SmartboxQueue 0x0A) — and the player's own equipment
 *      routes to playerState.inventory, never into ServerObjectManager — so
 *      the stamp was a runtime no-op and obj.clothingPriority was undefined
 *      for every object, always.
 *
 * Fix under test: the CreateObject parser captures the field (undefined when
 * the flag is absent — ACE writes the flag only for a non-null property, so
 * a wire 0 is a real CoverageMask value and must survive), and it lands on
 * both destinations: InventoryItem via buildInventoryEntry (own equipment)
 * and ServerObject via ServerObjectManager.createObject (world objects,
 * e.g. NPC-wielded items). The PlayerDescription equipped-item list writes
 * `ClothingPriority ?? 0` (GameEventPlayerDescription.cs:418-424), so it
 * strictly adds no information beyond the per-object field and the login
 * stamp was dropped rather than made ordering-safe.
 *
 * All suites drive the shipped code — no source-text pins.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { parseCreateObject } from '../packages/network/src/MessageSerializer.js';
import type { CreateObjectData } from '../packages/network/src/MessageSerializer.js';
import { buildInventoryEntry } from '../packages/renderer/src/network/objectSubjectRouting.js';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';

// ─── Wire writer mirroring BinaryReader semantics (same as
//     verify-structure-maxstructure.ts) ───
class Writer {
  private bytes: number[] = [];
  private get pos(): number { return this.bytes.length; }
  u8(v: number): this { this.bytes.push(v & 0xff); return this; }
  u16(v: number): this { this.bytes.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v: number): this {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  /** ACE packed DWORD, 2-byte form only (value must be < 0x8000). */
  packed(v: number): this {
    if (v >= 0x8000) throw new Error('packed() helper only supports the 2-byte form');
    return this.u16(v);
  }
  align(boundary = 4): this {
    const rem = this.pos % boundary;
    if (rem !== 0) for (let i = 0; i < boundary - rem; i++) this.u8(0);
    return this;
  }
  string16(s: string): this {
    this.u16(s.length);
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    const totalRead = 2 + s.length;
    const rem = totalRead % 4;
    if (rem !== 0) for (let i = 0; i < 4 - rem; i++) this.u8(0);
    return this;
  }
  toUint8Array(): Uint8Array { return new Uint8Array(this.bytes); }
}

// WeenieHeaderFlag bits exercised here (per ACE WeenieHeaderFlag.cs)
const FLAG_PRIORITY = 0x00040000;
const FLAG_RADAR_BLIP_COLOR = 0x00100000;
const FLAG_BURDEN = 0x00200000;

function buildCreateObjectPayload(opts: {
  weenieFlags?: number;
  clothingPriority?: number;
  radarColor?: number;
  burden?: number;
}): Uint8Array {
  const w = new Writer();
  w.u32(0x80031111); // guid
  w.u8(0x11).u8(0).u8(0).u8(0); // model header, no sub-blocks
  w.align(4);
  w.u32(0); // physFlags
  w.u32(0); // physicsState
  for (let i = 0; i < 9; i++) w.u16(0); // 9 sequence timestamps
  w.align(4);
  const flags = opts.weenieFlags ?? 0;
  w.u32(flags);
  w.string16(''); // name
  w.packed(300); // weenieClassId
  w.packed(1); // iconId -> 0x06000001
  w.u32(0); // itemType
  w.u32(0); // objectDescFlags (no second header)
  w.align(4);
  // Conditional weenie fields in parser read order — only the bits under
  // test are exercised (every other flag bit is off). Priority comes
  // before RadarBlipColor (u8) and Burden (u16) in the read order, so a
  // mis-sized Priority read would corrupt both trailing values.
  if (flags & FLAG_PRIORITY) w.u32(opts.clothingPriority ?? 0);
  if (flags & FLAG_RADAR_BLIP_COLOR) w.u8(opts.radarColor ?? 0);
  if (flags & FLAG_BURDEN) w.u16(opts.burden ?? 0);
  w.align(4);
  return w.toUint8Array();
}

describe('BUG.clothingpriority-never-lands — parseCreateObject captures WeenieHeaderFlag.Priority', () => {
  it('reads the uint off the wire and returns it as clothingPriority', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({
      weenieFlags: FLAG_PRIORITY,
      clothingPriority: 0x1000, // CoverageMask OuterwearChest
    }));
    expect(obj).not.toBeNull();
    expect(obj!.guid).toBe(0x80031111);
    expect(obj!.clothingPriority).toBe(0x1000);
  });

  it('preserves a real wire 0 (flag present, CoverageMask None) as 0, not undefined', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({
      weenieFlags: FLAG_PRIORITY,
      clothingPriority: 0,
    }));
    expect(obj).not.toBeNull();
    expect(obj!.clothingPriority).toBe(0);
  });

  it('returns undefined when the flag is absent (ACE property null — flag never written)', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({}));
    expect(obj).not.toBeNull();
    expect(obj!.clothingPriority).toBeUndefined();
  });

  it('framing parity: the uint is consumed exactly (RadarBlipColor u8 + Burden u16 after it still decode)', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({
      weenieFlags: FLAG_PRIORITY | FLAG_RADAR_BLIP_COLOR | FLAG_BURDEN,
      clothingPriority: 0x200,
      radarColor: 9,
      burden: 450,
    }));
    expect(obj).not.toBeNull();
    expect(obj!.clothingPriority).toBe(0x200);
    expect(obj!.radarColor).toBe(9);
    expect(obj!.burden).toBe(450);
  });
});

describe('BUG.clothingpriority-never-lands — buildInventoryEntry threads it onto the inventory item (own equipment path)', () => {
  const base = {
    weenieClassId: 300, name: 'Cloak', value: 10, burden: 50,
    stackSize: 1, maxStackSize: 1, containerId: 0, iconId: 0x06000001,
    validLocations: 0x8000000, itemType: 2, uiEffects: 0, usable: 0,
  };

  it('carries the parsed value through, including a real 0', () => {
    expect(buildInventoryEntry({ ...base, clothingPriority: 0x1000 }).clothingPriority).toBe(0x1000);
    expect(buildInventoryEntry({ ...base, clothingPriority: 0 }).clothingPriority).toBe(0);
  });

  it('stays undefined when the wire flag was not sent', () => {
    expect(buildInventoryEntry({ ...base }).clothingPriority).toBeUndefined();
  });
});

describe('BUG.clothingpriority-never-lands — ServerObjectManager.createObject seeds it (world-object path, e.g. NPC-wielded)', () => {
  function makeCreateData(clothingPriority: number | undefined): CreateObjectData {
    return {
      guid: 0x80035ace, name: 'Test Cloak', weenieClassId: 300, itemType: 2,
      position: null, setupId: 0, motionTableId: 0, iconId: 0x06000001,
      physicsState: 0, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
      basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [],
      containerId: 0, wielderId: 0x50001234, currentWieldedLocation: 0x8000000,
      clothingPriority, parentLocation: 0, validLocations: 0x8000000,
      stackSize: 0, maxStackSize: 0, value: 0, burden: 0,
      uiEffects: 0, usable: 0, useRadius: 0.6, combatUse: 0,
      velocityX: 0, velocityY: 0, velocityZ: 0, soundTableId: 0,
      objScale: 1, translucency: 0, defaultScript: 0, defaultScriptIntensity: 1,
      iconOverlayId: 0, iconUnderlayId: 0, cooldownId: 0, cooldownDuration: 0,
      structure: 0, maxStructure: 0, targetType: 0,
    } as CreateObjectData;
  }

  function makeManager(): ServerObjectManager {
    // setupId=0 + position=null short-circuits every mesh/terrain path, so
    // the renderer collaborators are never touched.
    return new ServerObjectManager(
      null as never, null as never, new THREE.Scene(),
    );
  }

  it('copies data.clothingPriority onto the persisted ServerObject', () => {
    const mgr = makeManager();
    mgr.createObject(makeCreateData(0x400));
    expect(mgr.getObject(0x80035ace)?.clothingPriority).toBe(0x400);
  });

  it('leaves it undefined when the wire flag was not sent', () => {
    const mgr = makeManager();
    mgr.createObject(makeCreateData(undefined));
    const obj = mgr.getObject(0x80035ace);
    expect(obj).toBeDefined();
    expect(obj!.clothingPriority).toBeUndefined();
  });
});
