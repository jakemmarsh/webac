/**
 * BUG.retail-obsprobe-world-entry-stack-overflow (filed 2026-10-12, root-caused
 * 2026-11-07): the real end-of-retail client stack-overflowed (EoR 0x5AECF6 =
 * IDList::GetNodeByNum +6, decomp 0x005ADC40) on every world entry of
 * testacjs3/+Obsprobe on local ACE. Same root cause as
 * BUG.gameplay-options-entry-order (fixed 2026-10-20, 101d12cd8): the
 * GameplayOptions blob a webAC session stored was out of retail's hash-bucket
 * order. This file pins the mechanism that turns that blob into a crash or a
 * hang, with the real bytes.
 *
 * The chain, all from the decomp:
 *  1. CPlayerSystem::Handle_PlayerDescription @ 0x005636a0 unpacks the
 *     PlayerModule, then reads the ContentProfile list (PackableList::UnPack
 *     @ 0x0055af50) and the InventoryPlacement list from wherever the module's
 *     unpack left the cursor. ACE writes the stored blob raw, so nothing
 *     re-synchronises the two (GameEventPlayerDescription.cs: blob, then
 *     Inventory.Count + (guid, ContainerType) pairs, then equipped triples).
 *  2. PlayerModule::UnPack @ 0x005d49d0 unpacks m_colGameplayOptions through
 *     PackUsingSerialize<PackObj>::UnPack @ 0x005d50d0, which advances the
 *     cursor by Archive::GetCurrentPosition (m_currOffset) whether or not the
 *     archive failed, then aligns to 4. Its result is ignored.
 *  3. SerializeIntrusiveHashTable @ 0x004294c0 reads each entry, then
 *     add_for_unpacking @ 0x0069a7c0 refuses a key whose bucket
 *     (key % g_bucketSizes[idx]) is lower than the previous entry's, and the
 *     table raises the archive error (Archive::RaiseError @ 0x0040a6f0). From
 *     then on every read returns nothing (Archive::PeekBytes @ 0x0040a910), so
 *     m_currOffset freezes just past the first out-of-order entry.
 *  4. The rest of the blob is then read as the inventory list. For +Obsprobe's
 *     blob the "count" is 0x00871000 (8.8 million) and the list runs far past
 *     the message. ACCObjectMaint::ViewObjectContents @ 0x00558a70 files every
 *     pair whose second word is non-zero into the player's _containersList.
 *  5. Then CPlayerSystem::InitializePlayer @ 0x00563570 runs
 *     ACCWeenieObject::RemoveContentsFromDestructionQueue @ 0x0058ca20 on the
 *     player, which recurses into every listed container that exists as an
 *     object, with no visited set. A garbage pair naming the player itself
 *     (or any loop) recurses until the stack is gone; the leaf it dies in is
 *     IDList::GetByNum -> GetNodeByNum, the crash address. When there is no
 *     loop, CPlayerSystem::AttemptSendLoginCompleteNotification @ 0x00562f20
 *     waits for ACCWeenieObject::AllContainedObjectsExist @ 0x0058c000, which
 *     is false for ids that never arrive, so LoginComplete is never sent:
 *     the "black world, empty vitals" hang seen on 2026-10-20. Which one a run
 *     gets depends on the memory past the message, not on our bytes.
 *
 * The model below is a test-side transcription of steps 2-4 (no shipped code
 * reads PlayerDescription the retail way); the tests run it against the
 * shipped serializer, parser and the repair trigger.
 */
import { describe, it, expect } from 'vitest';
import { BinaryReader, parseGameplayOptions, serializeGameplayOptions } from '@ac/network';
import { WEBAC_HANGING_BLOB, RETAIL_BLOB_WINDOW_OPENED, RETAIL_BLOB_MAIN_FILTER } from './_harness/gameplay-options-blobs';

const parse = (b: Uint8Array) => parseGameplayOptions(new BinaryReader(b));

// g_bucketSizeArray (.rdata 0x794670), g_numBucketSizes = 23.
const BUCKETS = [
  11, 23, 47, 89, 191, 383, 761, 1531, 3067, 6143, 12281, 24571, 49139, 98299,
  196597, 393209, 786431, 1572853, 3145721, 6291449, 12582893, 25165813, 50331599,
];

/** The retail Archive in unpacking mode: once in error, reads return null and the offset stays put. */
class RetailArchive {
  off = 0;
  err = false;
  constructor(private readonly b: Uint8Array) {}
  private take(n: number): number | null {
    if (this.err) return null;
    if (this.off + n > this.b.length) { this.err = true; return null; }
    const at = this.off;
    this.off += n;
    return at;
  }
  u8(): number { const at = this.take(1); return at === null ? 0 : this.b[at]; }
  u16(): number { const at = this.take(2); return at === null ? 0 : this.b[at] | (this.b[at + 1] << 8); }
  u32(): number {
    const at = this.take(4);
    return at === null ? 0 : (this.b[at] | (this.b[at + 1] << 8) | (this.b[at + 2] << 16) | (this.b[at + 3] << 24)) >>> 0;
  }
  skip(n: number): void { this.take(n); }
  /** SB_As32Bit_Compressed::Serialize @ 0x005be430. */
  packed(): number {
    const b0 = this.u8();
    if ((b0 & 0x80) === 0) return b0;
    const b1 = this.u8();
    if ((b0 & 0x40) === 0) return ((b0 & 0x7f) << 8) | b1;
    const s = this.u16();
    return ((((b0 & 0x3f) << 8) | b1) << 16 | s) >>> 0;
  }
  sizeLeft(): number { return this.b.length - this.off; }
  raise(): void { this.err = true; }
}

/** BaseProperty value by MasterProperty 0x39000001 type of the chat-option ids. */
function retailValue(a: RetailArchive, name: number): void {
  switch (name) {
    case 0x1000007f: a.skip(8); return; // Bitfield64
    case 0x10000080: case 0x10000081: a.skip(4); return; // Float
    case 0x10000086: case 0x10000087: case 0x10000088: case 0x10000089: a.skip(4); return; // Integer
    case 0x1000008a: a.skip(1); return; // Bool
    case 0x1000008b: retailTable(a); return; // Struct (StructPropertyValue @ 0x00429490)
    case 0x1000008c: { // Array: SmartArray<BaseProperty,1>::Serialize @ 0x00427fe0
      const n = a.u32();
      if (a.sizeLeft() < n) { a.raise(); return; }
      for (let i = 0; i < n && !a.err; i++) retailValue(a, a.u32());
      return;
    }
    case 0x1000008d: { // StringInfo::Serialize @ 0x0042deb0
      if (a.u8() === 1) a.skip(a.packed() * 2); else a.skip(8);
      const override = a.u8();
      if (override > 1) { a.raise(); return; }
      if (override === 1) for (let i = 0; i < 3; i++) a.skip(a.packed());
      a.u8();
      if (a.packed() !== 0) a.raise(); // StringInfoData entries never occur in chat titles
      return;
    }
    default: a.raise(); // no MasterProperty desc for it
  }
}

/** SerializeIntrusiveHashTable @ 0x004294c0 (unpacking) with add_for_unpacking @ 0x0069a7c0. */
function retailTable(a: RetailArchive): void {
  const idx = a.u8();
  if (idx >= BUCKETS.length) { a.raise(); return; }
  const n = a.packed();
  if (a.sizeLeft() < n) { a.raise(); return; }
  let prevBucket = -1;
  for (let i = 0; i < n; i++) {
    const key = a.u32();
    const name = a.u32();
    retailValue(a, name);
    if (a.err) return;
    const bucket = key % BUCKETS[idx];
    if (bucket < prevBucket) { a.raise(); return; }
    prevBucket = bucket;
  }
}

/**
 * Where PlayerModule::UnPack leaves the PlayerDescription cursor after the
 * GameplayOptions collection (relative to the blob's start, which ACE puts on
 * a 4-byte boundary), and whether the collection unpacked cleanly.
 */
function retailModuleEnd(blob: Uint8Array): { cursor: number; failed: boolean; stoppedAt: number } {
  const a = new RetailArchive(blob);
  a.u32(); // AutoStoreVersionArchive version
  retailTable(a);
  return { cursor: (a.off + 3) & ~3, failed: a.err, stoppedAt: a.off };
}

interface ContentProfile { iid: number; containerProperties: number }
interface Placement { iid: number; loc: number; priority: number }

/** ACE GameEventPlayerDescription: blob raw, then the inventory and equipped lists. */
function aceTail(blob: Uint8Array, inv: ContentProfile[], worn: Placement[]): Uint8Array {
  const words: number[] = [inv.length];
  for (const c of inv) words.push(c.iid, c.containerProperties);
  words.push(worn.length);
  for (const w of worn) words.push(w.iid, w.loc, w.priority);
  const out = new Uint8Array(blob.length + words.length * 4);
  out.set(blob);
  const dv = new DataView(out.buffer);
  words.forEach((v, i) => dv.setUint32(blob.length + i * 4, v >>> 0, true));
  return out;
}

/** Handle_PlayerDescription's list reads after the module (PackableList::UnPack @ 0x0055af50; it has no bound, we stop at the message end). */
function retailReadLists(msg: Uint8Array, blob: Uint8Array) {
  const { cursor, failed, stoppedAt } = retailModuleEnd(blob);
  const dv = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  let at = cursor;
  const count = dv.getUint32(at, true); at += 4;
  const profiles: ContentProfile[] = [];
  let runsPastMessage = false;
  for (let i = 0; i < count; i++) {
    if (at + 8 > msg.length) { runsPastMessage = true; break; }
    profiles.push({ iid: dv.getUint32(at, true), containerProperties: dv.getUint32(at + 4, true) });
    at += 8;
  }
  let placements: Placement[] | null = null;
  if (!runsPastMessage && at + 4 <= msg.length) {
    const n = dv.getUint32(at, true); at += 4;
    placements = [];
    for (let i = 0; i < n && at + 12 <= msg.length; i++, at += 12) {
      placements.push({ iid: dv.getUint32(at, true), loc: dv.getUint32(at + 4, true), priority: dv.getUint32(at + 8, true) });
    }
  }
  return { failed, stoppedAt, cursor, count, profiles, placements, runsPastMessage, end: at };
}

// +Obsprobe's shape on local ACE (ace_shard, 2026-11-07): loose items first, then side packs.
const INVENTORY: ContentProfile[] = [
  { iid: 0x800016d5, containerProperties: 0 }, // Practice Arrow
  { iid: 0x8000080b, containerProperties: 0 }, // Tunic
  { iid: 0x800011ad, containerProperties: 0 }, // Practice Wand
  { iid: 0x8000581a, containerProperties: 0 }, // Torch
  { iid: 0x8000e984, containerProperties: 0 }, // Rusted Dirk
  { iid: 0x80000591, containerProperties: 1 }, // Pack
  { iid: 0x8000061b, containerProperties: 1 }, // Sack
  { iid: 0x8000e98d, containerProperties: 1 }, // Sack
  { iid: 0x8000f196, containerProperties: 1 }, // Sack
  { iid: 0x8000f552, containerProperties: 1 }, // Sack
  { iid: 0x8000fb02, containerProperties: 1 }, // Sack
];
const WORN: Placement[] = [
  { iid: 0x80000612, loc: 0x200, priority: 0x0c00 }, // Shirt
  { iid: 0x80000613, loc: 0x1, priority: 0x4000 }, // Cap
  { iid: 0x80000617, loc: 0x400, priority: 0x0200 }, // Wide Breeches
  { iid: 0x80000618, loc: 0x100, priority: 0x10000 }, // Leather Boots
];

describe('BUG.retail-obsprobe-world-entry-stack-overflow — the stored blob desyncs PlayerDescription', () => {
  it('+Obsprobe\'s pre-fix blob stops the retail unpack at its second entry and reads 8.8 million garbage inventory rows', () => {
    const r = retailReadLists(aceTail(WEBAC_HANGING_BLOB, INVENTORY, WORN), WEBAC_HANGING_BLOB);
    expect(r.failed).toBe(true);
    // Window 1's struct: 0x7f (bucket 9), then 0x86 (bucket 5) is refused; the offset stays past it.
    expect(r.stoppedAt).toBe(58);
    expect(r.cursor).toBe(60);
    expect(r.count).toBe(0x00871000);
    expect(r.runsPastMessage).toBe(true);
    expect(r.placements).toBeNull();
    // The real inventory never reaches the player's lists as written.
    expect(r.profiles.slice(0, INVENTORY.length)).not.toEqual(INVENTORY);
  });

  it('the garbage containers include ids no object will ever have, so AllContainedObjectsExist never turns true', () => {
    const r = retailReadLists(aceTail(WEBAC_HANGING_BLOB, INVENTORY, WORN), WEBAC_HANGING_BLOB);
    const containers = r.profiles.filter((p) => p.containerProperties !== 0).map((p) => p.iid);
    expect(containers[0]).toBe(0x00231000);
    // Not a world-object id range at all (players 0x5xxxxxxx, items 0x8xxxxxxx, statics 0x7xxxxxxx).
    expect(containers.filter((id) => id < 0x50000000).length).toBeGreaterThan(0);
  });

  it('the repair re-save of the same options is read exactly: the inventory and worn lists come through intact', () => {
    const resaved = serializeGameplayOptions(parse(WEBAC_HANGING_BLOB)!);
    // buildSetCharacterOptionsPayload pads the payload tail to 4; ACE stores blob + pad.
    const stored = new Uint8Array((resaved.length + 3) & ~3);
    stored.set(resaved);
    const msg = aceTail(stored, INVENTORY, WORN);
    const r = retailReadLists(msg, stored);
    expect(r.failed).toBe(false);
    expect(r.profiles).toEqual(INVENTORY);
    expect(r.placements).toEqual(WORN);
    expect(r.end).toBe(msg.length);
  });

  it('blobs the retail client wrote itself are read exactly', () => {
    for (const blob of [RETAIL_BLOB_WINDOW_OPENED, RETAIL_BLOB_MAIN_FILTER]) {
      const r = retailReadLists(aceTail(blob, INVENTORY, WORN), blob);
      expect(r.failed).toBe(false);
      expect(r.profiles).toEqual(INVENTORY);
      expect(r.placements).toEqual(WORN);
    }
  });
});

/** A placement struct written in a caller-chosen entry order (the pre-fix serializer's shape, or any other). */
function writeBlobInOrder(windows: Array<Array<[number, number[]]>>): Uint8Array {
  const bytes: number[] = [];
  const u32 = (v: number) => bytes.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  u32(2);
  bytes.push(0, 1); // bucket index 0, one top-level entry
  u32(0x1000008c); u32(0x1000008c);
  u32(windows.length);
  for (const entries of windows) {
    u32(0x1000008b);
    bytes.push(0, entries.length);
    for (const [key, value] of entries) { u32(key); u32(key); bytes.push(...value); }
  }
  while (bytes.length % 4) bytes.push(0);
  return new Uint8Array(bytes);
}

describe('BUG.retail-obsprobe-world-entry-stack-overflow — the repair trigger matches what retail fails on', () => {
  // Deterministic LCG so a failure reproduces.
  let seed = 0x5aecf6;
  const rnd = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
  const VALUES: Record<number, number[]> = {
    0x1000007f: [0x1c, 0x10, 0, 0, 0, 0, 0, 0],
    0x10000086: [10, 0, 0, 0], 0x10000087: [20, 0, 0, 0],
    0x10000088: [0xfa, 0, 0, 0], 0x10000089: [0x68, 0, 0, 0],
    0x1000008a: [1],
  };
  const KEYS = Object.keys(VALUES).map(Number);

  it('for 300 random entry orders, needsRepair is set exactly when the retail unpack fails', () => {
    let failures = 0;
    for (let t = 0; t < 300; t++) {
      const windows: Array<Array<[number, number[]]>> = [];
      const nWin = 1 + rnd(5);
      for (let w = 0; w < nWin; w++) {
        const keys = KEYS.filter(() => rnd(3) !== 0);
        for (let i = keys.length - 1; i > 0; i--) { const j = rnd(i + 1); [keys[i], keys[j]] = [keys[j], keys[i]]; }
        windows.push(keys.map((k) => [k, VALUES[k]]));
      }
      const blob = writeBlobInOrder(windows);
      const retailFails = retailModuleEnd(blob).failed;
      if (retailFails) failures++;
      const ours = parse(blob);
      expect(ours).not.toBeNull();
      expect(ours!.needsRepair === true).toBe(retailFails);
      // Whatever was stored, the repair's re-save is one retail reads to the end.
      const resaved = serializeGameplayOptions(ours!);
      const end = retailModuleEnd(resaved);
      expect(end.failed).toBe(false);
      expect(end.stoppedAt).toBe(resaved.length);
    }
    // Both outcomes were exercised.
    expect(failures).toBeGreaterThan(20);
    expect(failures).toBeLessThan(300);
  });

  it('every serializer output (opacities, titles, up to 17 windows) is read by retail to its last byte', () => {
    for (let t = 0; t < 100; t++) {
      const chatWindows = new Map<number, Record<string, unknown>>();
      const nWin = 1 + rnd(17);
      for (let id = 1; id <= nWin; id++) {
        if (rnd(2)) continue;
        const o: Record<string, unknown> = {};
        if (rnd(2)) o.filter = BigInt(rnd(0x7fffffff)) << BigInt(rnd(32));
        if (rnd(2)) o.x = rnd(4000);
        if (rnd(2)) o.y = rnd(3000);
        if (rnd(2)) o.w = rnd(2000);
        if (rnd(2)) o.h = rnd(2000);
        if (rnd(2)) o.visible = rnd(2) === 1;
        if (rnd(4) === 0) o.title = 'Win' + rnd(100);
        chatWindows.set(id, o);
      }
      const data = { chatWindows, ...(rnd(2) ? { defaultOpacity: 0.25 } : {}), ...(rnd(2) ? { activeOpacity: 0.75 } : {}) };
      if (chatWindows.size === 0) chatWindows.set(8, { x: 1 });
      const blob = serializeGameplayOptions(data as Parameters<typeof serializeGameplayOptions>[0]);
      const end = retailModuleEnd(blob);
      expect(end.failed).toBe(false);
      expect(end.stoppedAt).toBe(blob.length);
      expect(parse(blob)?.needsRepair).toBeUndefined();
    }
  });
});
