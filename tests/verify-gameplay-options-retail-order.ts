/**
 * BUG.gameplay-options-entry-order (2026-10-20, Levistras report: "trying out
 * web version effectively wiped my main").
 *
 * The retail client packs each PackObjPropertyCollection hash table by walking
 * its buckets in order (key % g_bucketSizes[idx], 11 for index 0) and can only
 * load a table in that order. webAC wrote each chat window's struct in a fixed
 * order with the text-type filter 0x1000007f (bucket 9) before x/y/w/h
 * (buckets 5-8), and opacity 0x10000080 (bucket 10) before 0x81/0x8c
 * (bucket 0). ACE stores the blob verbatim, and the retail client then hung
 * entering the world with that character: black world, empty vitals.
 *
 * Verified with the real retail client against local ACE on 2026-10-20 (same
 * character, only the stored blob changed): the webAC blob below hangs; with
 * no blob, filters only, or geometry only it loads; the SAME entries re-emitted
 * in bucket order load (either order inside bucket 9). The two "retail" blobs
 * below were written by the retail client itself (floaty window 1 opened; Combat
 * unticked on the main window).
 */
import { describe, it, expect } from 'vitest';
import { BinaryReader, parseGameplayOptions, serializeGameplayOptions } from '@ac/network';
import { ChatOptionsRepair, CHAT_OPTIONS_REPAIR_DELAY_MS } from '../packages/renderer/src/session/PlayerModuleSave';

const hex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));
const parse = (b: Uint8Array) => parseGameplayOptions(new BinaryReader(b));

/** Stored by a webAC session (local ACE, character Obsprobe): hangs the retail client. */
const WEBAC_HANGING_BLOB = hex(
  '0200000000018C0000108C000010080000008B00001000008B00001000067F0000107F0000101C100000000000008600001086000010000000008700001087000010230000008800001088000010FA0000008900001089000010680000008A0000108A000010008B00001000067F0000107F000010000C0400000000008600001086000010000000008700001087000010910000008800001088000010FA0000008900001089000010680000008A0000108A000010008B00001000067F0000107F00001000000800000000008600001086000010000000008700001087000010FF0000008800001088000010FA0000008900001089000010680000008A0000108A000010008B00001000067F0000107F000010000000780000000086000010860000100000000087000010870000106D0100008800001088000010FA0000008900001089000010680000008A0000108A000010008B00001000028800001088000010620200008900001089000010780000008B00001000008B00001000057F0000107F000010FFFFFFFB000000008600001086000010000000008700001087000010A302000088000010880000109A0100008900001089000010640000000000',
);
/** Written by the retail client: floaty chat window 1 (id 2) opened. */
const RETAIL_BLOB_WINDOW_OPENED = hex(
  '0200000000018C0000108C000010110000008B00001000008B00001000018A0000108A000010018B00001000008B00001000008B00001000008B00001000008B00001000008B00001000008B00001000008B00001000008B00001000008B00001000008B00001000008B00001000008B00001000008B00001000008B0000100000000000',
);
/** Written by the retail client: Combat unticked on the main chat window (id 8). */
const RETAIL_BLOB_MAIN_FILTER = hex(
  '0200000000018C0000108C000010110000008B00001000008B00001000008B00001000008B00001000008B00001000008B00001000008B00001000008B00001000017F0000107F000010BFFF9FFB000000008B00001000008B00001000008B00001000008B00001000008B00001000008B00001000008B00001000008B00001000008B0000100000',
);

/** Keys of every struct in the placement array, in written order (walks our own output). */
function structKeyOrders(blob: Uint8Array): number[][] {
  const r = new BinaryReader(blob);
  r.skip(4);
  r.readUInt8();
  const top = r.readUInt8();
  const out: number[][] = [];
  for (let t = 0; t < top; t++) {
    const k = r.readUInt32(); r.readUInt32();
    if (k === 0x10000080 || k === 0x10000081) { r.skip(4); continue; }
    const n = r.readUInt32();
    for (let i = 0; i < n; i++) {
      r.readUInt32(); r.readUInt8();
      const c = r.readUInt8();
      const keys: number[] = [];
      for (let j = 0; j < c; j++) {
        const key = r.readUInt32(); r.readUInt32(); keys.push(key);
        r.skip(key === 0x1000007f ? 8 : key === 0x1000008a ? 1 : 4);
      }
      out.push(keys);
    }
  }
  return out;
}

describe('BUG.gameplay-options-entry-order — stored blobs', () => {
  it('the webAC blob that hung the retail client is flagged needsRepair', () => {
    const d = parse(WEBAC_HANGING_BLOB);
    expect(d).not.toBeNull();
    expect(d!.needsRepair).toBe(true);
  });

  it('blobs the retail client wrote itself are not flagged', () => {
    const a = parse(RETAIL_BLOB_WINDOW_OPENED);
    const b = parse(RETAIL_BLOB_MAIN_FILTER);
    expect(a?.chatWindows.get(2)).toEqual({ visible: true });
    expect(b?.chatWindows.get(8)?.filter).toBe(0xFB9FFFBFn);
    expect(a?.needsRepair).toBeUndefined();
    expect(b?.needsRepair).toBeUndefined();
  });

  it('re-serializing the hanging blob keeps every option and comes out in retail order', () => {
    const before = parse(WEBAC_HANGING_BLOB)!;
    const after = parse(serializeGameplayOptions(before))!;
    expect(after.needsRepair).toBeUndefined();
    expect(after.chatWindows).toEqual(before.chatWindows);
  });

  it('re-serializing a retail blob reproduces retail bytes apart from the array length', () => {
    // Retail always writes 17 placement elements; we write up to the highest window id
    // (a shorter array loads: GetChatOptionStructure grows it on demand, and verified live).
    const ours = serializeGameplayOptions(parse(RETAIL_BLOB_MAIN_FILTER)!);
    const retail = RETAIL_BLOB_MAIN_FILTER;
    expect(Buffer.from(ours.subarray(0, 14)).equals(Buffer.from(retail.subarray(0, 14)))).toBe(true);
    const tail = Buffer.from('7F0000107F000010BFFF9FFB00000000', 'hex');
    expect(Buffer.from(ours).includes(tail)).toBe(true);
  });
});

describe('BUG.gameplay-options-entry-order — serializer writes retail bucket order', () => {
  it('a window with filter, geometry and visibility writes 86, 87, 88, 89, then 7f/8a (bucket 9)', () => {
    const blob = serializeGameplayOptions({
      chatWindows: new Map([[2, { filter: 0x101cn, x: 1, y: 2, w: 3, h: 4, visible: true }]]),
    });
    const [, win2] = structKeyOrders(blob);
    expect(win2.map((k) => (k >>> 0) % 11)).toEqual([5, 6, 7, 8, 9, 9]);
    expect(win2.slice(0, 4)).toEqual([0x10000086, 0x10000087, 0x10000088, 0x10000089]);
  });

  it('a titled window (0x8d, bucket 1) round-trips in order', () => {
    const data = { chatWindows: new Map([[3, { filter: 2n, x: 5, w: 9, visible: true, title: 'Loot' }]]) };
    const back = parse(serializeGameplayOptions(data))!;
    expect(back.needsRepair).toBeUndefined();
    expect(back.chatWindows.get(3)).toEqual(data.chatWindows.get(3));
  });

  it('every struct and the top-level table are in ascending bucket order', () => {
    const blob = serializeGameplayOptions({
      defaultOpacity: 0.25, activeOpacity: 0.75,
      chatWindows: new Map([
        [2, { filter: 1n, x: 0, y: 35, w: 250, h: 104, visible: false }],
        [8, { filter: 0xFBFFFFFFn, x: 0, y: 675, w: 410, h: 100 }],
      ]),
    });
    expect(parse(blob)?.needsRepair).toBeUndefined();
    for (const keys of structKeyOrders(blob)) {
      const buckets = keys.map((k) => (k >>> 0) % 11);
      expect(buckets).toEqual([...buckets].sort((a, b) => a - b));
    }
  });
});

describe('BUG.gameplay-options-entry-order — ChatOptionsRepair', () => {
  const harness = () => {
    const resaves: number[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const repair = new ChatOptionsRepair({
      resave: () => resaves.push(1),
      schedule: (fn, ms) => timers.push({ fn, ms }),
    });
    return { repair, resaves, timers };
  };

  it('re-saves once, after LoginComplete, when the login module needs repair', () => {
    const { repair, resaves, timers } = harness();
    repair.noteLoginModule(parse(WEBAC_HANGING_BLOB));
    expect(timers).toHaveLength(0);
    repair.loginCompleteSent();
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(CHAT_OPTIONS_REPAIR_DELAY_MS);
    timers[0].fn();
    expect(resaves).toHaveLength(1);
    repair.loginCompleteSent(); // a later teleport's LoginComplete
    expect(timers).toHaveLength(1);
  });

  it('does nothing for a retail-ordered module, no module, or an unreadable one', () => {
    for (const stored of [parse(RETAIL_BLOB_MAIN_FILTER), null, undefined]) {
      const { repair, timers } = harness();
      repair.noteLoginModule(stored);
      repair.loginCompleteSent();
      expect(timers).toHaveLength(0);
    }
  });

  it('a later character login without a bad module clears a pending repair', () => {
    const { repair, timers } = harness();
    repair.noteLoginModule(parse(WEBAC_HANGING_BLOB));
    repair.noteLoginModule(parse(RETAIL_BLOB_WINDOW_OPENED));
    repair.loginCompleteSent();
    expect(timers).toHaveLength(0);
  });
});
