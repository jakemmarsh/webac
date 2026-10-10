/**
 * CORE.3.f — chat-window options server round-trip.
 *
 * The retail client persists each chat window's x/y/w/h (options
 * 0x10000086-89), visibility (0x1000008a), text-type filter (0x1000007f)
 * and title (0x1000008d), plus the two chat opacities (0x10000080/81), in
 * the PlayerModule GameplayOptions PackObjPropertyCollection. ACE stores
 * the blob verbatim (GameActionSetCharacterOptions.cs:183-191 →
 * Character.GameplayOptions) and echoes it back inside PlayerDescription.
 *
 * Wire format pinned against the decompiled EoL client (see
 * packages/network/src/PlayerModuleOptions.ts for the per-function
 * anchors): PropertyCollection = u32 version + u8 bucketSizeIndex +
 * packed count + entries of (u32 hashKey + u32 propertyName + value);
 * the placement array (0x1000008c) holds one 0x1000008b struct per
 * window, indexed windowId-1 (PlayerModule::GetChatOptionStructure @
 * 005d5300); titles serialize as StringInfo (kind byte + length-prefixed
 * UTF-16 + override-strings flag + 3 PStrings + empty StringInfoData
 * table).
 */
import { describe, it, expect } from 'vitest';
import {
  parseGameplayOptions, serializeGameplayOptions,
  buildSetCharacterOptionsPayload, parseSetCharacterOptionsPayload,
  BinaryReader,
} from '@ac/network';
import type { GameplayOptionsData } from '@ac/network';
import { parsePlayerDescription } from '../packages/renderer/src/network/PlayerDescriptionParser';

/* ================================================================ */
/*  Byte-golden serialization (pins the decomp wire format)          */
/* ================================================================ */

describe('CORE.3.f — serializeGameplayOptions byte-golden vectors', () => {
  it('single window, x only — exact bytes', () => {
    const blob = serializeGameplayOptions({
      chatWindows: new Map([[1, { x: 5 }]]),
    });
    expect(Array.from(blob)).toEqual([
      0x02, 0x00, 0x00, 0x00,       // version 2 (AutoStoreVersionArchive)
      0x00,                          // top-level bucketSizeIndex
      0x01,                          // packed count 1
      0x8C, 0x00, 0x00, 0x10,       // hashKey   = placement array
      0x8C, 0x00, 0x00, 0x10,       // propName  = placement array
      0x01, 0x00, 0x00, 0x00,       // SmartArray count 1 (u32, NOT packed)
      0x8B, 0x00, 0x00, 0x10,       // element propName = placement struct
      0x00,                          // struct bucketSizeIndex
      0x01,                          // packed member count 1
      0x86, 0x00, 0x00, 0x10,       // hashKey   = X
      0x86, 0x00, 0x00, 0x10,       // propName  = X
      0x05, 0x00, 0x00, 0x00,       // u32 5
    ]);
  });

  it('custom title — exact StringInfo bytes (length-prefixed UTF-16, 3 override strings, empty table)', () => {
    const blob = serializeGameplayOptions({
      chatWindows: new Map([[2, { title: 'AB' }]]),
    });
    expect(Array.from(blob)).toEqual([
      0x02, 0x00, 0x00, 0x00, 0x00, 0x01,
      0x8C, 0x00, 0x00, 0x10, 0x8C, 0x00, 0x00, 0x10,
      0x02, 0x00, 0x00, 0x00,       // array count 2 (windowIds 1..2)
      0x8B, 0x00, 0x00, 0x10, 0x00, 0x00, // window 1: empty struct
      0x8B, 0x00, 0x00, 0x10, 0x00, 0x01, // window 2: 1 member
      0x8D, 0x00, 0x00, 0x10, 0x8D, 0x00, 0x00, 0x10, // title key+name
      0x01,                          // StringInfo kind 1 = literal
      0x02,                          // packed char count 2 — NO NUL terminator
      0x41, 0x00, 0x42, 0x00,       // 'A' 'B' UTF-16LE
      0x01,                          // override-strings flag (client always 1)
      0x00, 0x00, 0x00,             // 3 × empty PString<char>
      0x00,                          // StringInfoData table bucketSizeIndex
      0x00,                          // packed table count 0
    ]);
  });

  it('opacities serialize as top-level f32 entries 0x10000080/81', () => {
    const blob = serializeGameplayOptions({
      defaultOpacity: 0.5,
      activeOpacity: 1.0,
      chatWindows: new Map(),
    });
    expect(Array.from(blob)).toEqual([
      0x02, 0x00, 0x00, 0x00, 0x00, 0x02,
      0x80, 0x00, 0x00, 0x10, 0x80, 0x00, 0x00, 0x10,
      0x00, 0x00, 0x00, 0x3F,       // 0.5f
      0x81, 0x00, 0x00, 0x10, 0x81, 0x00, 0x00, 0x10,
      0x00, 0x00, 0x80, 0x3F,       // 1.0f
    ]);
  });
});

/* ================================================================ */
/*  Round-trip                                                       */
/* ================================================================ */

describe('CORE.3.f — serialize → parse round-trip', () => {
  it('full options state survives the round-trip', () => {
    const data: GameplayOptionsData = {
      defaultOpacity: 0.4,
      activeOpacity: 0.85,
      chatWindows: new Map([
        [2, { x: 10, y: 35, w: 250, h: 104, visible: true, filter: 0x101Cn, title: 'My Speech' }],
        [3, { x: 0, y: 145, w: 300, h: 200, visible: false, filter: 0x40C00n }],
        [5, { visible: true, filter: 0x78000000n, title: 'Chän L' }], // non-ASCII survives UTF-16
        [8, { filter: 0x1FBFFFFFFn }], // main chat — bit 32 (Society) exercises the u64 path
      ]),
    };
    const blob = serializeGameplayOptions(data);
    const parsed = parseGameplayOptions(new BinaryReader(blob, 0));
    expect(parsed).not.toBeNull();
    expect(parsed!.defaultOpacity).toBeCloseTo(0.4, 6);
    expect(parsed!.activeOpacity).toBeCloseTo(0.85, 6);
    // windowIds 1,4,6,7 were serialized as empty filler structs → absent.
    expect([...parsed!.chatWindows.keys()].sort()).toEqual([2, 3, 5, 8]);
    expect(parsed!.chatWindows.get(2)).toEqual({ x: 10, y: 35, w: 250, h: 104, visible: true, filter: 0x101Cn, title: 'My Speech' });
    expect(parsed!.chatWindows.get(3)).toEqual({ x: 0, y: 145, w: 300, h: 200, visible: false, filter: 0x40C00n });
    expect(parsed!.chatWindows.get(5)).toEqual({ visible: true, filter: 0x78000000n, title: 'Chän L' });
    expect(parsed!.chatWindows.get(8)).toEqual({ filter: 0x1FBFFFFFFn });
  });

  it('parse consumes exactly the blob (cursor lands at the end)', () => {
    const blob = serializeGameplayOptions({
      chatWindows: new Map([[2, { x: 1, y: 2, visible: true }]]),
    });
    const r = new BinaryReader(blob, 0);
    expect(parseGameplayOptions(r)).not.toBeNull();
    expect(r.position).toBe(blob.length);
  });
});

/* ================================================================ */
/*  Retail-shaped variants the serializer never emits                */
/* ================================================================ */

describe('CORE.3.f — parseGameplayOptions retail-shaped inputs', () => {
  it('kind-0 title (stringId/tableId reference) parses, title stays undefined', () => {
    // Hand-built: one window whose title is a string-table reference (the
    // default titles come from table 0x23000001).
    const bytes = [
      0x02, 0x00, 0x00, 0x00, 0x00, 0x01,
      0x8C, 0x00, 0x00, 0x10, 0x8C, 0x00, 0x00, 0x10,
      0x01, 0x00, 0x00, 0x00,
      0x8B, 0x00, 0x00, 0x10, 0x00, 0x01,
      0x8D, 0x00, 0x00, 0x10, 0x8D, 0x00, 0x00, 0x10,
      0x00,                         // kind 0 → stringId + tableId
      0x25, 0xAF, 0x97, 0x09,      // stringId 0x0997AF25
      0x01, 0x00, 0x00, 0x23,      // tableId 0x23000001
      0x00,                         // override-strings flag 0 (no 3 strings)
      0x00, 0x00,                   // empty StringInfoData table
    ];
    const parsed = parseGameplayOptions(new BinaryReader(new Uint8Array(bytes), 0));
    expect(parsed).not.toBeNull();
    // A window whose only stored option was the table-ref title parses to
    // no surfaced fields → omitted from the map (defaults apply).
    expect(parsed!.chatWindows.get(1)).toBeUndefined();
  });

  it('non-empty override strings parse (skipped by length prefix)', () => {
    const bytes = [
      0x02, 0x00, 0x00, 0x00, 0x00, 0x01,
      0x8C, 0x00, 0x00, 0x10, 0x8C, 0x00, 0x00, 0x10,
      0x01, 0x00, 0x00, 0x00,
      0x8B, 0x00, 0x00, 0x10, 0x00, 0x01,
      0x8D, 0x00, 0x00, 0x10, 0x8D, 0x00, 0x00, 0x10,
      0x01, 0x01, 0x58, 0x00,      // literal 'X'
      0x01,                         // override flag
      0x02, 0x61, 0x62,            // override string "ab" (packed len + bytes)
      0x00, 0x00,                   // two empty override strings
      0x00, 0x00,                   // empty StringInfoData table
    ];
    const parsed = parseGameplayOptions(new BinaryReader(new Uint8Array(bytes), 0));
    expect(parsed).not.toBeNull();
    expect(parsed!.chatWindows.get(1)).toEqual({ title: 'X' });
  });

  it('unknown property key aborts (returns null)', () => {
    const bytes = [
      0x02, 0x00, 0x00, 0x00, 0x00, 0x01,
      0xEF, 0xBE, 0xAD, 0xDE, 0xEF, 0xBE, 0xAD, 0xDE, // unknown key
      0x00, 0x00, 0x00, 0x00,
    ];
    expect(parseGameplayOptions(new BinaryReader(new Uint8Array(bytes), 0))).toBeNull();
  });

  it('truncated blob aborts (returns null) instead of parsing as empty', () => {
    const blob = serializeGameplayOptions({
      chatWindows: new Map([[2, { x: 1, title: 'Hello' }]]),
    });
    for (const cut of [3, 5, blob.length - 1]) {
      expect(parseGameplayOptions(new BinaryReader(blob.slice(0, cut), 0))).toBeNull();
    }
  });

  it('bucket-size index ≥ 23 (g_numBucketSizes) aborts like the retail unpacker', () => {
    const bytes = [0x02, 0x00, 0x00, 0x00, 0x17, 0x00]; // index 23 = first invalid
    expect(parseGameplayOptions(new BinaryReader(new Uint8Array(bytes), 0))).toBeNull();
  });
});

/* ================================================================ */
/*  SetCharacterOptions payload carries the blob (flag 0x200 + pad)  */
/* ================================================================ */

describe('CORE.3.f — buildSetCharacterOptionsPayload GameplayOptions section', () => {
  it('sets flag 0x200, appends the blob last, and zero-pads the payload to 4 bytes', () => {
    const blob = serializeGameplayOptions({
      chatWindows: new Map([[2, { visible: true }]]),
    });
    // This blob ends on a bool (1 byte) → length ≢ 0 (mod 4), so padding
    // must appear (retail PlayerModule::Pack @ 005d45c0 pads the tail).
    expect(blob.length % 4).not.toBe(0);
    const payload = buildSetCharacterOptionsPayload({
      options1: 0x50c4a54a,
      options2: 0x00948700,
      gameplayOptions: blob,
    });
    expect(payload.length % 4).toBe(0);
    const parsed = parseSetCharacterOptionsPayload(payload);
    expect(parsed.flags & 0x200).toBe(0x200);
    expect(parsed.options1).toBe(0x50c4a54a | 0); // int32 view
    expect(parsed.options2).toBe(0x00948700);
    // The stored section = blob + pad — exactly what ACE persists.
    expect(parsed.gameplayOptions).toBeDefined();
    expect(Array.from(parsed.gameplayOptions!.slice(0, blob.length))).toEqual(Array.from(blob));
    expect(parsed.gameplayOptions!.length % 4).toBe(0);
    for (const b of parsed.gameplayOptions!.slice(blob.length)) expect(b).toBe(0);
    // And the padded section still parses back to the same options.
    const rt = parseGameplayOptions(new BinaryReader(parsed.gameplayOptions!, 0));
    expect(rt).not.toBeNull();
    expect(rt!.chatWindows.get(2)).toEqual({ visible: true });
  });

  it('no gameplayOptions → flag unset and payload unchanged from the pre-CORE.3.f shape', () => {
    const payload = buildSetCharacterOptionsPayload({ options1: 7 });
    const parsed = parseSetCharacterOptionsPayload(payload);
    expect(parsed.flags & 0x200).toBe(0);
    expect(parsed.gameplayOptions).toBeUndefined();
    expect(payload.length).toBe(12); // flags + options1 + numTab1Spells
  });
});

/* ================================================================ */
/*  PlayerDescription integration — blob parses, placement follows   */
/* ================================================================ */

function buildDescWithBlob(blob: Uint8Array | null): Uint8Array {
  const buf = new ArrayBuffer(8192);
  const dv = new DataView(buf);
  let p = 0;
  const w32 = (v: number) => { dv.setUint32(p, v, true); p += 4; };
  const w8 = (v: number) => { dv.setUint8(p, v); p += 1; };
  w32(0); // propertyFlags
  w32(0); // weenieType
  w32(0); // vectorFlags
  w32(0); // attribute cache flags
  w32(blob ? 0x240 : 0x40);    // optionFlags: [GameplayOptions] | CharacterOptions2
  w32(0x12345678);             // CharacterOptions1
  w32(0);                      // single 0u spell-list placeholder
  w32(0x3FFF);                 // SpellbookFilters
  w32(0x00948700);             // CharacterOptions2
  if (blob) {
    for (const b of blob) w8(b);
    // Retail PlayerModule::Pack zero-pads the 0x01A1 tail to 4 bytes and
    // ACE stores blob+pad verbatim — mirror that here.
    while (p % 4 !== 0) w8(0);
  }
  w32(2);                      // inventoryCount
  w32(0x50000001); w32(0);
  w32(0x50000002); w32(1);
  w32(1);                      // equippedCount
  w32(0x60000001); w32(0x01); w32(0x64);
  return new Uint8Array(buf, 0, p);
}

describe('CORE.3.f — PlayerDescription parses the blob AND the placement tail', () => {
  it('chat-window options land in result.gameplayOptions; placements still read past blob + pad', () => {
    const blob = serializeGameplayOptions({
      defaultOpacity: 0.4,
      chatWindows: new Map([[2, { x: 40, y: 60, w: 250, h: 104, visible: true, title: 'Mine' }]]),
    });
    const result = parsePlayerDescription(buildDescWithBlob(blob));
    expect(result).not.toBeNull();
    expect(result!.gameplayOptions).not.toBeNull();
    expect(result!.gameplayOptions!.defaultOpacity).toBeCloseTo(0.4, 6);
    expect(result!.gameplayOptions!.chatWindows.get(2)).toEqual({ x: 40, y: 60, w: 250, h: 104, visible: true, title: 'Mine' });
    expect(result!.inventoryPlacement).toEqual([
      { guid: 0x50000001, containerType: 0 },
      { guid: 0x50000002, containerType: 1 },
    ]);
    expect(result!.equippedPlacement).toEqual([
      { guid: 0x60000001, wieldedLocation: 0x01, clothingPriority: 0x64 },
    ]);
  });

  it('no GameplayOptions flag → result.gameplayOptions null, placements read', () => {
    const result = parsePlayerDescription(buildDescWithBlob(null));
    expect(result).not.toBeNull();
    expect(result!.gameplayOptions).toBeNull();
    expect(result!.inventoryPlacement).toHaveLength(2);
  });

  it('unrecoverable blob → gameplayOptions null AND placement read refused (FAITHFUL.572 abort semantics)', () => {
    const bad = new Uint8Array([
      0x02, 0x00, 0x00, 0x00, 0x00, 0x01,
      0xEF, 0xBE, 0xAD, 0xDE, 0xEF, 0xBE, 0xAD, 0xDE, // unknown key
      0x00, 0x00,
    ]);
    const result = parsePlayerDescription(buildDescWithBlob(bad));
    expect(result).not.toBeNull();
    expect(result!.gameplayOptions).toBeNull();
    expect(result!.inventoryPlacement).toEqual([]);
    expect(result!.equippedPlacement).toEqual([]);
  });
});
