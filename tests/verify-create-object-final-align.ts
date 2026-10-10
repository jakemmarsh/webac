/**
 * FAITHFUL.166 — parseCreateObject was missing the final Align(4) per ACE
 * WorldObject_Networking.cs:220 SerializeCreateObject.
 *
 * Per ACE source (WorldObject_Networking.cs):
 *   private void SerializeCreateObject(...)
 *   {
 *       writer.WriteGuid(Guid);
 *       SerializeModelData(writer);              // own writer.Align() at line 255
 *       SerializePhysicsData(writer, ...);
 *       writer.Write((uint)weenieFlags);
 *       writer.WriteString16L(Name ?? string.Empty);
 *       ... many conditional writes ...
 *       writer.Align();   ← line 220, MISSING from our parser
 *   }
 *
 * Practical impact today: the parseCreateObject caller doesn't read from
 * the buffer after the function returns, so the missing align is silent.
 * But the FAITHFUL goal is byte-exact wire-format parity — the parser
 * cursor must match ACE's writer position so any future consumer (e.g.
 * a multi-message dispatch that packs multiple GameMessages into one
 * fragment) reads from the correct offset.
 *
 * CONVERTED (source-pin census, 2026-08-14) from a source-text pin
 * (readFileSync + regex against MessageSerializer.ts's parseCreateObject
 * source text, never executing the parser — CLAUDE.md's "Never Break
 * Tests") to a behavioral test. Because the align only moves a cursor
 * that `parseCreateObject`'s `Uint8Array`-in/`CreateObjectData`-out
 * contract never exposes, genuinely observing it requires seeing the
 * reader's position after parsing — so `parseCreateObjectFromReader`
 * (a reader-in variant sharing the exact same parse body) was added to
 * `@ac/network` for exactly this purpose, mirroring the existing
 * `BinaryReader` + `r.position` idiom already used in
 * tests/verify-binary-reader-int64.ts and
 * tests/verify-hear-speech-wire-format.ts. This adds no new behavior —
 * `parseCreateObject` still delegates to it under its existing try/catch.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BinaryReader, parseCreateObject, parseCreateObjectFromReader } from '@ac/network';

const REPO = resolve(__dirname, '..');
const ACE_NET = resolve(REPO, 'reference/ACE/Source/ACE.Server/WorldObjects/WorldObject_Networking.cs');

describe.skipIf(!aceReferenceExists(ACE_NET))('ACE source pin: SerializeCreateObject ends with writer.Align()', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_NET, 'utf8');
  });

  it('SerializeCreateObject body ends with writer.Align()', () => {
    // Extract the SerializeCreateObject function body. C#-style brace counting:
    // start at the function signature, walk forward counting { and } to find
    // the matching closing brace.
    const startIdx = src.search(/private void SerializeCreateObject\(BinaryWriter writer, bool gamedataonly/);
    expect(startIdx).toBeGreaterThan(0);
    let depth = 0;
    let i = startIdx;
    // Advance to the first '{'.
    while (i < src.length && src[i] !== '{') i++;
    const bodyStart = i;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = src.slice(bodyStart, i + 1);
    // The last writer.X(...) call in the function body must be writer.Align().
    const writes = [...body.matchAll(/writer\.[A-Z][A-Za-z]+\(/g)].map(m => m[0]);
    expect(writes[writes.length - 1]).toBe('writer.Align(');
  });
});

// DEBT.test-harness-hygiene: the former comment-citation pin on
// MessageSerializer.ts ("documents WorldObject_Networking.cs:220") is dropped —
// the final align it annotates is executed below (cursor lands on 60, not 57).

/* ================================================================ */
/*  Synthetic CreateObject payload builder                          */
/*  Mirrors the exact read order of parseCreateObject               */
/*  (packages/network/src/MessageSerializer.ts): model header (no    */
/*  sub-blocks), zero-flag physics header, 9 zeroed sequence u16s,   */
/*  then a weenie header with ONLY WeenieHeaderFlag.RadarBlipColor    */
/*  set (weenieFlags = 0x00100000) — a single conditional 1-byte      */
/*  read chosen so the pre-final-align cursor lands on a NON-4-       */
/*  aligned offset, giving the trailing r.align(4) real work to do.   */
/*  Same number-array + DataView idiom as                             */
/*  tests/verify-obj-scale-applied.ts / verify-default-script-        */
/*  override.ts.                                                      */
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

const RADAR_BLIP_COLOR_BIT = 0x00100000; // WeenieHeaderFlag.RadarBlipColor

function buildPayload(): Uint8Array {
  const bytes: number[] = [
    ...u32(0x50003001),        // guid
    0x11, 0, 0, 0,              // modelByte=0x11, numSubPalettes/numTexChanges/numAnimParts=0
    ...u32(0),                  // physFlags = 0 (no optional physics blocks)
    ...u32(0),                  // physicsState
    ...Array(18).fill(0),       // 9x u16 sequence timestamps
    0, 0,                       // align(4) pad (34 -> 36)
    ...u32(RADAR_BLIP_COLOR_BIT), // weenieFlags
    ...u16(0), 0, 0,             // name: string16 length=0, self-aligned pad
    ...u16(1000),                // weenieClassId (packed dword, <=0x7FFF => 2 bytes)
    ...u16(0x0010),              // iconId (packed dword, <=0x7FFF => 2 bytes; +0x06000000 type mask)
    ...u32(1),                   // itemType
    ...u32(0),                   // objectDescFlags = 0 (no second header)
    // 56 bytes so far, 56 % 4 === 0 — the mid-function align(4) at
    // MessageSerializer.ts:3466 is a deliberate no-op here.
    0x07,                        // radarColor (WeenieHeaderFlag.RadarBlipColor, the only bit set)
    // 57 bytes total: NOT 4-aligned. Only the trailing r.align(4) under
    // test can bring the cursor to the expected 60.
  ];
  return new Uint8Array(bytes);
}

describe('Integration (FAITHFUL.166) — behavioral', () => {
  it('parseCreateObjectFromReader leaves the reader 4-byte aligned at the true ACE end offset', () => {
    const r = new BinaryReader(buildPayload());
    const obj = parseCreateObjectFromReader(r);
    // Sanity: the hand-built payload parsed the fields we expect.
    expect(obj.guid).toBe(0x50003001);
    expect(obj.weenieClassId).toBe(1000);
    expect(obj.iconId).toBe(0x06000010);
    expect(obj.radarColor).toBe(0x07);
    // The real assertion: without ACE's trailing align(4), the cursor
    // would stop at 57 (the last byte actually read). With it, the
    // cursor advances to the next 4-byte boundary: 60.
    expect(r.position).toBe(60);
  });

  it('parseCreateObject (Uint8Array entry point) still returns the same parsed fields', () => {
    // parseCreateObject discards the reader, but it must delegate to the
    // exact same body — this guards the refactor that split the two.
    const obj = parseCreateObject(buildPayload());
    expect(obj).not.toBeNull();
    expect(obj!.guid).toBe(0x50003001);
    expect(obj!.radarColor).toBe(0x07);
  });
});
