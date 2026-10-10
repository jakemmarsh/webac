/**
 * PlayerModuleOptions — the PackObjPropertyCollection "GameplayOptions" blob
 * (retail PlayerModule.m_colGameplayOptions) that carries chat-window
 * placement/visibility/filter/title + the two chat opacities.
 *
 * CORE.3.f — parse + serialize so chat-window options round-trip through the
 * server (ACE stores the blob verbatim in `Character.GameplayOptions` and
 * echoes it back inside PlayerDescription; GameActionSetCharacterOptions.cs:183-191
 * captures every remaining payload byte when flag 0x200 is set).
 *
 * Wire format pinned against the DECOMPILED EoL CLIENT (authoritative — it is
 * the only writer retail servers ever saw), not aclogview:
 *
 *   PackObjPropertyCollection (PackUsingSerialize<PackObj>):
 *     u32   version                  — AutoStoreVersionArchive header; retail = 2
 *     u8    bucketSizeIndex          — index into g_bucketSizes[23] =
 *                                      {11,23,47,89,191,383,761,1531,…}
 *                                      (IntrusiveHashTable::get_bucket_size_pointer
 *                                      @ 00427010; array @ .rdata 0x794670,
 *                                      g_numBucketSizes = 23 — resolved via
 *                                      acclient.pdb S_GDATA32 records)
 *     packed count                   — SB_As32Bit_Compressed::Serialize @ 005be430
 *                                      (the standard AC CompressedUInt32)
 *     count × entry:
 *       u32 hashKey                  — SerializeIntrusiveHashTable @ 004294c0
 *       u32 propertyName             — BaseProperty::Serialize @ 0042a090
 *                                      (equal to hashKey; aclogview called this
 *                                      second copy "m_pcPropertyDesc")
 *       value                        — by property id, see below
 *
 *   Value encodings (XxxPropertyValue::Serialize each write ONLY the raw value):
 *     0x1000007F TextType filter     — u64 (Bitfield64PropertyValue)
 *     0x10000080/81 opacity          — f32 (FloatPropertyValue @ 00424640)
 *     0x10000086-89 x/y/w/h          — u32 (IntegerPropertyValue)
 *     0x1000008A visibility          — u8  (BoolPropertyValue @ 004239c0)
 *     0x1000008B placement struct    — StructPropertyValue @ 00429490:
 *                                      u8 bucketSizeIndex + packed count +
 *                                      count × entry (recursive)
 *     0x1000008C placement array     — ArrayPropertyValue → SmartArray
 *                                      <BaseProperty,1>::Serialize @ 00427fe0:
 *                                      u32 count + count × (u32 propertyName +
 *                                      value) — NO per-element hashKey.
 *                                      Element index i = chat window id i+1
 *                                      (PlayerModule::GetChatOptionStructure @
 *                                      005d5300 indexes with windowId-1).
 *     0x1000008D title               — StringInfo::Serialize @ 0042deb0:
 *                                      u8 kind (1=literal, else stringId/tableId)
 *                                      kind 1 → packed charCount + charCount×u16
 *                                        (PStringBase<unsigned_short>::Serialize
 *                                        @ 004223b0 — LENGTH-PREFIXED, no NUL;
 *                                        FAITHFUL.572's aclogview-derived
 *                                        "NUL-terminated" skip was wrong, it
 *                                        only matched by byte-coincidence)
 *                                      kind ≠1 → u32 stringId + u32 tableId
 *                                      u8 overrideFlag — the game client always
 *                                        writes 1 followed by 3 × PString<char>
 *                                        (packed len + bytes; empty → 0x00 each)
 *                                      u8 bucketSizeIndex + packed count for the
 *                                        StringInfoData table (always empty here)
 *
 * Window ids (ChatInterface, attribute 0x1000007e): floaty windows 1-4 are
 * ids 2-5, the main chat is id 8. gmFloatyChatUI::UpdateFromPlayerModule @
 * 004ce3f0 reads x/y (0x86/87), w/h (0x88/89), visible (0x8a), title (0x8d)
 * per window plus the two top-level opacities (0x80/81); the per-window
 * text-type filter (0x7f) is read by ChatInterface::UpdateFromPlayerModule.
 */

import { BinaryReader, BinaryWriter } from './MessageSerializer.js';

// ─── Property ids (MasterProperty option keys) ──────────────────────────

export const CHAT_OPT_TEXT_TYPE = 0x1000007F;
export const CHAT_OPT_DEFAULT_OPACITY = 0x10000080;
export const CHAT_OPT_ACTIVE_OPACITY = 0x10000081;
export const CHAT_OPT_X = 0x10000086;
export const CHAT_OPT_Y = 0x10000087;
export const CHAT_OPT_WIDTH = 0x10000088;
export const CHAT_OPT_HEIGHT = 0x10000089;
export const CHAT_OPT_VISIBILITY = 0x1000008A;
export const CHAT_OPT_PLACEMENT = 0x1000008B;
export const CHAT_OPT_PLACEMENT_ARRAY = 0x1000008C;
export const CHAT_OPT_TITLE = 0x1000008D;

/**
 * g_numBucketSizes — the retail client rejects a serialized bucket-size
 * index ≥ 23 (SerializeIntrusiveHashTable RaiseError path), so we do too.
 */
const NUM_BUCKET_SIZES = 23;

// ─── Semantic model ─────────────────────────────────────────────────────

/** One chat window's persisted options (all fields optional on the wire). */
export interface ChatWindowOptions {
  /** Screen position — options 0x10000086/87 (gmFloatyChatUI::MoveTo). */
  x?: number;
  y?: number;
  /** Size — options 0x10000088/89 (gmFloatyChatUI::ResizeTo). */
  w?: number;
  h?: number;
  /** Open/closed — option 0x1000008a. */
  visible?: boolean;
  /** 64-bit ChatMessageType filter mask — option 0x1000007f. */
  filter?: bigint;
  /**
   * Custom title — option 0x1000008d (gmFloatyChatUI::SetWindowTitle).
   * Only literal (kind-1) StringInfos surface here; a stringId/tableId
   * reference (the default titles) parses but stays undefined so callers
   * fall back to the DAT default title.
   */
  title?: string;
}

/** Parsed GameplayOptions blob content. */
export interface GameplayOptionsData {
  /** Chat background opacity 0..1 while the entry is inactive — option 0x10000080. */
  defaultOpacity?: number;
  /** Chat background opacity 0..1 while the entry is focused — option 0x10000081. */
  activeOpacity?: number;
  /** windowId (1-based; floaties are 2-5, main chat is 8) → options. */
  chatWindows: Map<number, ChatWindowOptions>;
}

// ─── Packed u32 (SB_As32Bit_Compressed — the AC CompressedUInt32) ───────

/**
 * Bounds-checked u8 read — BinaryReader.readUInt8 returns `undefined` past
 * the end of the buffer (plain array index), which would let a truncated
 * blob "parse" as empty instead of aborting.
 */
function u8(r: BinaryReader): number {
  if (r.remaining < 1) throw new ParseAbort();
  return r.readUInt8();
}

function readPackedU32(r: BinaryReader): number {
  const b0 = u8(r);
  if ((b0 & 0x80) === 0) return b0;
  const b1 = u8(r);
  if ((b0 & 0x40) === 0) return ((b0 & 0x7F) << 8) | b1;
  const s = r.readUInt16();
  return ((((b0 & 0x3F) << 8) | b1) << 16 | s) >>> 0;
}

function writePackedU32(w: BinaryWriter, v: number): void {
  if (v < 0x80) {
    w.writeUInt8(v);
  } else if (v < 0x4000) {
    w.writeUInt8((v >> 8) | 0x80);
    w.writeUInt8(v & 0xFF);
  } else {
    w.writeUInt8(((v >>> 24) & 0x3F) | 0xC0);
    w.writeUInt8((v >>> 16) & 0xFF);
    w.writeUInt16(v & 0xFFFF);
  }
}

/**
 * Bucket-size index to serialize for a hashtable holding `count` elements.
 * Retail writes lower_bound(m_numBuckets) into g_bucketSizes; every table
 * this codec emits is small (≤ 11 entries), for which the retail table
 * state (default resize target g_bucketSizes[0] = 11) maps to index 0.
 * Self-round-trips: the unpacker resizes to g_bucketSizes[idx], whose own
 * lower_bound is idx again.
 */
function bucketSizeIndexFor(_count: number): number {
  return 0;
}

// ─── Parse ──────────────────────────────────────────────────────────────

class ParseAbort extends Error {}

function readTitleStringInfo(r: BinaryReader): string | undefined {
  const kind = u8(r);
  let literal: string | undefined;
  if (kind === 1) {
    const charCount = readPackedU32(r);
    if (charCount > r.remaining / 2) throw new ParseAbort();
    let s = '';
    for (let i = 0; i < charCount; i++) s += String.fromCharCode(r.readUInt16());
    literal = s;
  } else {
    r.skip(4 + 4); // stringId + tableId — caller keeps the DAT default title
  }
  const overrideFlag = u8(r);
  if (overrideFlag !== 0) {
    if (overrideFlag !== 1) throw new ParseAbort();
    // Three override PString<char>s — the game client always emits them
    // (StringInfo::Serialize local_1=1 for the plain-client program type).
    for (let i = 0; i < 3; i++) {
      const len = readPackedU32(r);
      if (len > r.remaining) throw new ParseAbort();
      r.skip(len);
    }
  }
  const tableBucketIdx = u8(r);
  if (tableBucketIdx >= NUM_BUCKET_SIZES) throw new ParseAbort();
  const tableCount = readPackedU32(r);
  // StringInfoData entries never occur in chat titles; their layout is
  // unknown-size so a non-empty table is unrecoverable.
  if (tableCount !== 0) throw new ParseAbort();
  return literal;
}

function readPlacementStruct(r: BinaryReader): ChatWindowOptions {
  const bucketIdx = u8(r);
  if (bucketIdx >= NUM_BUCKET_SIZES) throw new ParseAbort();
  const count = readPackedU32(r);
  const out: ChatWindowOptions = {};
  for (let i = 0; i < count; i++) {
    const hashKey = r.readUInt32();
    const name = r.readUInt32();
    if (name !== hashKey) throw new ParseAbort();
    switch (name) {
      case CHAT_OPT_TEXT_TYPE:
        out.filter = BigInt.asUintN(64, r.readInt64());
        break;
      case CHAT_OPT_X: out.x = r.readUInt32(); break;
      case CHAT_OPT_Y: out.y = r.readUInt32(); break;
      case CHAT_OPT_WIDTH: out.w = r.readUInt32(); break;
      case CHAT_OPT_HEIGHT: out.h = r.readUInt32(); break;
      case CHAT_OPT_VISIBILITY: out.visible = u8(r) !== 0; break;
      case CHAT_OPT_TITLE: {
        const t = readTitleStringInfo(r);
        if (t !== undefined) out.title = t;
        break;
      }
      default:
        // Unknown member — size unknowable, whole blob unrecoverable.
        throw new ParseAbort();
    }
  }
  return out;
}

/**
 * Parse the GameplayOptions blob in place from `r` (cursor at the blob's
 * first byte). On success the cursor rests just past the collection — the
 * caller must then `align(4)` (PlayerModule::UnPack @ 005d49d0 pads the
 * pack to a 4-byte boundary and ACE stores those pad bytes verbatim).
 *
 * Returns null when a structurally unknown key/value makes the remaining
 * bytes unrecoverable — the cursor is then unusable, exactly like the old
 * skip-only walk (FAITHFUL.572).
 */
export function parseGameplayOptions(r: BinaryReader): GameplayOptionsData | null {
  try {
    r.skip(4); // AutoStoreVersionArchive version (retail writes 2)
    const bucketIdx = u8(r);
    if (bucketIdx >= NUM_BUCKET_SIZES) throw new ParseAbort();
    const count = readPackedU32(r);
    const out: GameplayOptionsData = { chatWindows: new Map() };
    for (let i = 0; i < count; i++) {
      const hashKey = r.readUInt32();
      const name = r.readUInt32();
      if (name !== hashKey) throw new ParseAbort();
      switch (name) {
        case CHAT_OPT_DEFAULT_OPACITY: out.defaultOpacity = r.readFloat32(); break;
        case CHAT_OPT_ACTIVE_OPACITY: out.activeOpacity = r.readFloat32(); break;
        case CHAT_OPT_PLACEMENT_ARRAY: {
          const num = r.readUInt32();
          if (num > 64) throw new ParseAbort(); // sanity — retail caps at the desc's m_nMaxElements
          for (let idx = 0; idx < num; idx++) {
            const elemName = r.readUInt32();
            if (elemName !== CHAT_OPT_PLACEMENT) throw new ParseAbort();
            const winOpts = readPlacementStruct(r);
            if (Object.keys(winOpts).length > 0) out.chatWindows.set(idx + 1, winOpts);
          }
          break;
        }
        // Top-level scalars the retail client can also store outside the
        // array (InqOption reads them from the collection root) — parse
        // structurally so the walk survives, ignore semantically.
        case CHAT_OPT_TEXT_TYPE: r.skip(8); break;
        case CHAT_OPT_X: case CHAT_OPT_Y:
        case CHAT_OPT_WIDTH: case CHAT_OPT_HEIGHT: r.skip(4); break;
        case CHAT_OPT_VISIBILITY: u8(r); break;
        case CHAT_OPT_TITLE: readTitleStringInfo(r); break;
        case CHAT_OPT_PLACEMENT: readPlacementStruct(r); break;
        default:
          throw new ParseAbort();
      }
    }
    return out;
  } catch {
    return null;
  }
}

// ─── Serialize ──────────────────────────────────────────────────────────

function writeTitleStringInfo(w: BinaryWriter, title: string): void {
  w.writeUInt8(1); // literal string
  writePackedU32(w, title.length);
  for (let i = 0; i < title.length; i++) w.writeUInt16(title.charCodeAt(i));
  w.writeUInt8(1); // override-strings flag — plain client always writes 1
  writePackedU32(w, 0); // m_strOverride (empty)
  writePackedU32(w, 0);
  writePackedU32(w, 0);
  w.writeUInt8(bucketSizeIndexFor(0)); // empty StringInfoData table
  writePackedU32(w, 0);
}

function writePlacementStruct(w: BinaryWriter, opts: ChatWindowOptions): void {
  const entries: Array<[number, () => void]> = [];
  if (opts.filter !== undefined) {
    const f = opts.filter;
    entries.push([CHAT_OPT_TEXT_TYPE, () => {
      w.writeUInt32(Number(f & 0xFFFFFFFFn));
      w.writeUInt32(Number((f >> 32n) & 0xFFFFFFFFn));
    }]);
  }
  if (opts.x !== undefined) { const v = opts.x; entries.push([CHAT_OPT_X, () => w.writeUInt32(v)]); }
  if (opts.y !== undefined) { const v = opts.y; entries.push([CHAT_OPT_Y, () => w.writeUInt32(v)]); }
  if (opts.w !== undefined) { const v = opts.w; entries.push([CHAT_OPT_WIDTH, () => w.writeUInt32(v)]); }
  if (opts.h !== undefined) { const v = opts.h; entries.push([CHAT_OPT_HEIGHT, () => w.writeUInt32(v)]); }
  if (opts.visible !== undefined) {
    const v = opts.visible;
    entries.push([CHAT_OPT_VISIBILITY, () => w.writeUInt8(v ? 1 : 0)]);
  }
  if (opts.title !== undefined) {
    const t = opts.title;
    entries.push([CHAT_OPT_TITLE, () => writeTitleStringInfo(w, t)]);
  }
  w.writeUInt8(bucketSizeIndexFor(entries.length));
  writePackedU32(w, entries.length);
  for (const [id, writeValue] of entries) {
    w.writeUInt32(id); // hashtable key
    w.writeUInt32(id); // BaseProperty name
    writeValue();
  }
}

/**
 * Serialize a GameplayOptions blob the retail client (and this codec)
 * can read back. NOT padded — GameActionSetCharacterOptions payload
 * assembly pads the enclosing message to a 4-byte boundary, which is what
 * ACE captures and echoes.
 */
export function serializeGameplayOptions(data: GameplayOptionsData): Uint8Array {
  const w = new BinaryWriter(256);
  w.writeUInt32(2); // AutoStoreVersionArchive version — retail constant

  const top: Array<[number, () => void]> = [];
  if (data.defaultOpacity !== undefined) {
    const v = data.defaultOpacity;
    top.push([CHAT_OPT_DEFAULT_OPACITY, () => w.writeFloat32(v)]);
  }
  if (data.activeOpacity !== undefined) {
    const v = data.activeOpacity;
    top.push([CHAT_OPT_ACTIVE_OPACITY, () => w.writeFloat32(v)]);
  }
  const maxWindowId = Math.max(0, ...data.chatWindows.keys());
  if (maxWindowId > 0) {
    top.push([CHAT_OPT_PLACEMENT_ARRAY, () => {
      w.writeUInt32(maxWindowId);
      for (let idx = 0; idx < maxWindowId; idx++) {
        w.writeUInt32(CHAT_OPT_PLACEMENT); // element BaseProperty name
        writePlacementStruct(w, data.chatWindows.get(idx + 1) ?? {});
      }
    }]);
  }

  w.writeUInt8(bucketSizeIndexFor(top.length));
  writePackedU32(w, top.length);
  for (const [id, writeValue] of top) {
    w.writeUInt32(id); // hashtable key
    w.writeUInt32(id); // BaseProperty name
    writeValue();
  }
  return w.toBuffer();
}
