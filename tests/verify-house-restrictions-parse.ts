/**
 * Parse HouseRestrictions inline (FAITHFUL.293).
 *
 * Pre-fix `parseCreateObject` and `parseApproachVendor` in
 * `packages/network/src/MessageSerializer.ts` bailed (return / break) when
 * the HouseRestrictions weenie header flag was set, dropping all weenie
 * fields after it (HookItemTypes, Monarch, HookType, IconOverlay,
 * IconUnderlay, MaterialType, Cooldown, CooldownDuration, PetOwner +
 * trailing 4-byte alignment) and producing partial weenie payloads
 * whenever a house-related object appeared in a CreateObject or vendor
 * inventory stream.
 *
 * The RestrictionDB wire format is well-defined in ACE
 * `Network/Structure/RestrictionDB.cs:74-105` —
 *
 *   uint32  Version
 *   uint32  OpenStatus     (bool serialized as Convert.ToUInt32 → 0/1)
 *   uint32  MonarchID      (ObjectGuid.Full — a single uint)
 *   uint16  count          (PackableHashTable header: # of guests)
 *   uint16  numBuckets     (header-num-buckets; 768 in retail)
 *   count × (uint32 guest guid, uint32 permission)   (0=dwelling, 1=storage)
 *
 * Fix introduces a small `skipRestrictionDB(reader)` helper that consumes
 * those bytes so the parsers can continue reading the remaining weenie
 * fields. The struct's payload doesn't surface anywhere on the client
 * (house ACL is server-side), so we skip the data instead of materializing
 * a struct — the only goal is correct cursor advancement.
 *
 * CONVERTED (source-pin census, 2026-08-15) from a source-text pin
 * (readFileSync + regex against MessageSerializer.ts's parser bodies,
 * never executing the parsers — CLAUDE.md's "Never Break Tests") to a
 * behavioral test. Drives the real `parseCreateObjectFromReader` and
 * `parseApproachVendor` with hand-built payloads whose weenie flags set
 * HouseRestrictions alongside neighboring fields (HookItemTypes, Monarch,
 * HookType, IconOverlay), so a byte-count regression in `skipRestrictionDB`
 * — or a reintroduced early return/break in either caller — desyncs the
 * reader and produces wrong field values, a thrown error, or a truncated
 * vendor item list, all of which the assertions below catch. Same
 * `BinaryReader` + hand-built-payload idiom as
 * tests/verify-create-object-final-align.ts (also FAITHFUL.166/.293
 * siblings sharing `parseCreateObjectFromReader`).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BinaryReader,
  parseCreateObject,
  parseCreateObjectFromReader,
  parseApproachVendor,
} from '@ac/network';

const REPO = resolve(__dirname, '..');

/* ================================================================ */
/*  Byte-builder helpers — same DataView idiom as                    */
/*  verify-create-object-final-align.ts / verify-obj-scale-applied.ts */
/* ================================================================ */

function u16(n: number): number[] {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff, true);
  return Array.from(b);
}
function u32(n: number): number[] {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return Array.from(b);
}
function f32(n: number): number[] {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, n, true);
  return Array.from(b);
}
/** String16L: u16 length + bytes, padded so (2+len) is a multiple of 4. */
function string16(s = ''): number[] {
  const bytes = [...s].map((c) => c.charCodeAt(0));
  const out = [...u16(bytes.length), ...bytes];
  const totalRead = 2 + bytes.length;
  const rem = totalRead % 4;
  if (rem !== 0) out.push(...Array(4 - rem).fill(0));
  return out;
}
/** Pad a growing byte array to the next 4-byte boundary (mirrors r.align(4)). */
function alignTo4(bytes: number[]): void {
  const rem = bytes.length % 4;
  if (rem !== 0) bytes.push(...Array(4 - rem).fill(0));
}
/**
 * RestrictionDB wire bytes per ACE RestrictionDBExtensions.Write
 * (reference/ACE/Source/ACE.Server/Network/Structure/RestrictionDB.cs:74-105):
 * u32 Version + u32 OpenStatus + u32 MonarchID + u16 count + u16 numBuckets
 * + count × (u32 guestGuid, u32 permission).
 */
function restrictionDBBytes(entries: [number, number][]): number[] {
  return [
    ...u32(0x10000002), // Version
    ...u32(1), // OpenStatus = true
    ...u32(0x12340000), // MonarchID
    ...u16(entries.length),
    ...u16(768), // numBuckets
    ...entries.flatMap(([guid, perm]) => [...u32(guid), ...u32(perm)]),
  ];
}

// Bit values from MessageSerializer.ts's (unexported `const enum`)
// WeenieHeaderFlag — see MessageSerializer.ts:3124-3159.
const WHF = {
  Monarch: 0x00000040,
  HouseRestrictions: 0x04000000,
  HookType: 0x10000000,
  HookItemTypes: 0x20000000,
  IconOverlay: 0x40000000,
};

/* ================================================================ */
/*  parseCreateObjectFromReader — HouseRestrictions branch           */
/* ================================================================ */

/**
 * Builds a minimal CreateObject payload whose weenie flags set
 * HouseRestrictions together with HookItemTypes/Monarch/HookType/
 * IconOverlay (all four of the fields that sit AFTER the RestrictionDB
 * block in read order) with one guest entry in the RestrictionDB, so a
 * wrong byte count in skipRestrictionDB desyncs every field that follows.
 */
function buildCreateObjectPayload(): Uint8Array {
  const bytes: number[] = [
    ...u32(0x50004001), // guid
    0x11, 0, 0, 0, // modelByte=0x11, numSubPalettes/numTexChanges/numAnimParts=0
    ...u32(0), // physFlags = 0 (no optional physics blocks)
    ...u32(0), // physicsState
    ...Array(18).fill(0), // 9x u16 sequence timestamps
  ];
  alignTo4(bytes); // r.align(4) after model+physics+sequence data
  const weenieFlags = WHF.HouseRestrictions | WHF.HookItemTypes | WHF.Monarch | WHF.HookType | WHF.IconOverlay;
  bytes.push(
    ...u32(weenieFlags),
    ...string16(''), // name
    ...u16(2000), // weenieClassId (packed dword, <=0x7FFF => 2 bytes)
    ...u16(0x0010), // iconId (packed dword; +0x06000000 type mask)
    ...u32(1), // itemType
    ...u32(0), // objectDescFlags = 0 (no second header)
  );
  alignTo4(bytes); // r.align(4) after objectDescFlags
  bytes.push(
    ...restrictionDBBytes([[0x12345678, 1]]), // HouseRestrictions branch: 1 guest entry
    ...u32(0xdead0001), // HookItemTypes (read-and-discarded)
    ...u32(0xdead0002), // Monarch (read-and-discarded)
    ...u16(0xd003), // HookType (read-and-discarded)
    ...u16(0x0044), // IconOverlay (packed dword; +0x06000000 type mask)
  );
  return new Uint8Array(bytes);
}

describe('parseCreateObjectFromReader — HouseRestrictions branch (FAITHFUL.293) — behavioral', () => {
  it('reads past a HouseRestrictions RestrictionDB block and correctly parses every field after it', () => {
    const r = new BinaryReader(buildCreateObjectPayload());
    const obj = parseCreateObjectFromReader(r);
    expect(obj.guid).toBe(0x50004001);
    expect(obj.weenieClassId).toBe(2000);
    expect(obj.iconId).toBe(0x06000010);
    // The real regression guard: if skipRestrictionDB consumed the wrong
    // byte count, this would read garbage (or throw on an out-of-bounds
    // access) instead of the packed dword actually written after
    // HookItemTypes/Monarch/HookType.
    expect(obj.iconOverlayId).toBe(0x06000044);
    // Cursor ends 4-byte aligned exactly at the payload's true end —
    // proves every intervening field (including the RestrictionDB guest
    // entry) was consumed at its real wire width, not guessed.
    expect(r.position).toBe(buildCreateObjectPayload().length);
  });

  it('parseCreateObject (Uint8Array entry point) delegates to the same body and returns the same fields', () => {
    const obj = parseCreateObject(buildCreateObjectPayload());
    expect(obj).not.toBeNull();
    expect(obj!.iconOverlayId).toBe(0x06000044);
  });
});

/* ================================================================ */
/*  parseApproachVendor — HouseRestrictions branch                   */
/* ================================================================ */

/**
 * GameDataOnly item entry: packed(stackSize|pwdType<<24) + guid + weenie
 * header (no model/physics section — see parseApproachVendor's comment).
 */
function buildVendorItem(opts: {
  guid: number;
  weenieClassId: number;
  iconRaw: number;
  weenieFlags: number;
  restrictionEntries?: [number, number][];
}): number[] {
  const bytes: number[] = [
    ...u32(0xff000001), // packed: pwdType=0xFF, stackSize=1
    ...u32(opts.guid),
    ...u32(opts.weenieFlags),
    ...string16(''), // name
    ...u16(opts.weenieClassId),
    ...u16(opts.iconRaw), // iconId (+0x06000000 type mask)
    ...u32(1), // itemType
    ...u32(0), // objectDescFlags = 0 (no second header)
  ];
  alignTo4(bytes);
  if (opts.weenieFlags & WHF.HouseRestrictions) {
    bytes.push(...restrictionDBBytes(opts.restrictionEntries ?? []));
  }
  if (opts.weenieFlags & WHF.IconOverlay) {
    bytes.push(...u16(0x0055)); // IconOverlay packed dword
  }
  alignTo4(bytes); // r.align(4) at the end of each item's parse
  return bytes;
}

function buildVendorPayload(): Uint8Array {
  const item1 = buildVendorItem({
    guid: 0x50005001,
    weenieClassId: 3000,
    iconRaw: 0x0020,
    weenieFlags: WHF.HouseRestrictions | WHF.IconOverlay,
    restrictionEntries: [[0xaaaa0001, 0]],
  });
  const item2 = buildVendorItem({
    guid: 0x50005002,
    weenieClassId: 3001,
    iconRaw: 0x0030,
    weenieFlags: 0, // plain item, no HouseRestrictions — proves the loop kept going
  });
  const bytes: number[] = [
    ...u32(0x50000001), // vendorGuid
    ...u32(0), // merchandiseItemTypes
    ...u32(0), // merchandiseMinValue
    ...u32(0), // merchandiseMaxValue
    ...u32(1), // dealMagicalItems
    ...f32(1.0), // buyPrice
    ...f32(1.0), // sellPrice
    ...u32(0), // alternateCurrency
    ...u32(0), // altCurrencyAmount
    ...string16(''), // altCurrencyName
    ...u32(2), // numItems
    ...item1,
    ...item2,
  ];
  return new Uint8Array(bytes);
}

describe('parseApproachVendor — HouseRestrictions branch (FAITHFUL.293) — behavioral', () => {
  it('parses a HouseRestrictions merchandise item fully AND keeps parsing subsequent items', () => {
    const result = parseApproachVendor(buildVendorPayload());
    expect(result).not.toBeNull();
    // Pre-fix, the `break` on HouseRestrictions would silently stop the
    // merchandise stream after item 1 (or item 1 would desync and throw,
    // dropping to 0 items via the outer catch). Both items surviving,
    // with item 2's independent fields intact, proves the reader stayed
    // in sync across the HouseRestrictions block.
    expect(result!.items.length).toBe(2);
    expect(result!.items[0].guid).toBe(0x50005001);
    expect(result!.items[0].weenieClassId).toBe(3000);
    expect(result!.items[0].iconOverlayId).toBe(0x06000055);
    expect(result!.items[1].guid).toBe(0x50005002);
    expect(result!.items[1].weenieClassId).toBe(3001);
    expect(result!.items[1].iconId).toBe(0x06000030);
  });
});

/* ================================================================ */
/*  ACE source pin — wire format ground truth for the builders above */
/* ================================================================ */

const ACE_RESTRICTION = resolve(
  REPO,
  'reference/ACE/Source/ACE.Server/Network/Structure/RestrictionDB.cs',
);

describe.skipIf(!aceReferenceExists(ACE_RESTRICTION))('ACE source pin — RestrictionDB wire format', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_RESTRICTION, 'utf8');
  });

  it("Write() emits exactly: Version + OpenStatus + MonarchID.Full + Dict<ObjectGuid, uint>", () => {
    const m = src.match(/public static void Write\(this BinaryWriter writer, RestrictionDB restrictions\)\s*\{([\s\S]+?)\}/);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body).toMatch(/writer\.Write\(restrictions\.Version\)/);
    expect(body).toMatch(/writer\.Write\(Convert\.ToUInt32\(restrictions\.OpenStatus\)\)/);
    expect(body).toMatch(/writer\.Write\(restrictions\.MonarchID\.Full\)/);
    expect(body).toMatch(/writer\.Write\(restrictions\.Table\)/);
  });

  it('Table dictionary Write() emits PackableHashTable header (u16 count, u16 buckets) + each entry as (u32 guid, u32 permission)', () => {
    const m = src.match(/public static void Write\(this BinaryWriter writer, Dictionary<ObjectGuid, uint> db\)\s*\{([\s\S]+?)\}/);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body).toMatch(/PackableHashTable\.WriteHeader\(writer, db\.Count, headerNumBuckets\)/);
    expect(body).toMatch(/writer\.Write\(kvp\.Key\.Full\)/);
    expect(body).toMatch(/writer\.Write\(kvp\.Value\)/);
  });
});
