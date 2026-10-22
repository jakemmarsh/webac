/**
 * Milestones M2/M5 of the 1999 adapter: the player's description and the
 * property-update family (docs/ac1999-support.md). Layouts measured from the
 * real client's capture (tests/fixtures/ac1999-session-001.jsonl.gz: one
 * 0x0013 of 2,680 bytes, 0x000E ×5, 0x000F, 0x0029 ×4) and a live probe
 * against the local AC1999 server, then read against the server's writers:
 * PhatSDK/Qualities.cpp (CBaseQualities/CACQualities/Attribute/Skill/
 * SpellBookPage/Enchantment Pack), ObjectMsgs.cpp LoginCharacter and
 * WeenieObject.cpp Notify*StatUpdated. The end-of-retail side is ACE's
 * GameEventPlayerDescription / GameMessagePrivateUpdate* / PublicUpdate*,
 * as our PlayerDescriptionParser and ServerMessageHandler read them.
 *
 * ── 0x0013 PlayerDescription ──────────────────────────────────────────────
 * 1999: FLAT top-level message (no 0xF7B0 envelope, no guid). EoL: GameEvent
 * 0xF7B0 [player guid][event sequence][0x0013] + payload. The guid comes from
 * the session (0xF657 CharacterEnterWorld out, or 0xF746 PlayerCreate in).
 *
 *   1999                                           EoL
 *   u32 baseFlags, u32 weenieType                  u32 propertyFlags, u32 weenieType
 *   hash tables (u16 count, u16 buckets, entries)  same header; same table order
 *     0x01 Int     {u32 key, i32}                    Int: keys 21/22 move to Int64 (see below),
 *                                                     key 40 CombatMode 1/2/3/4 → 0x1/0x2/0x4/0x8;
 *                                                     every table's keys → key1999ToEoL
 *     0x80 Int64   never sent (1999 client has none)  0x80 Int64 {u32 key, i64}: TotalExperience(1)
 *                                                     ← Int 21, AvailableExperience(2) ← Int 22
 *     0x02 Bool    {u32 key, u32}                    same
 *     0x04 Float   {u32 key, f64}                    same
 *     0x10 String  {u32 key, AcString}               {u32 key, String16L}; Name(1) added from the
 *                                                     0x000F the server sends just before (1999's
 *                                                     description has no name; the client reads it
 *                                                     off that update)
 *     0x08 DID / 0x40 IID {u32 key, u32}             same
 *     0x20 Position {u32 key, cell, xyz, wxyz}       same (32 bytes)
 *   u32 derivedFlags, u32 wcid                     u32 vectorFlags (same bits), u32 hasHealth = 1
 *     0x001 AttributeCache u32 flags (same 9 bits)
 *       primary {field0, field1, field2}             {ranks, startingValue, xpSpent}
 *       — 1999 shows field0 alone as the value; the server folds init+raises into it and zeroes field1
 *         (AC1999::Remap1999AttributeForWire). → ranks 0, startingValue field0, xp field2.
 *       vital {raises, init, xpSpent, current}       same 4 × u32
 *     0x002 Skills {u32 id, u32 rank, i32 sac, u32 xp, u32 init, i32 resist, f64 lastUsed}
 *                                                   {u32 id, u16 ranks, u16 1, u32 sac, u32 xp, u32 init,
 *                                                     u32 resist, f64}. Ids match EoL (the 1999 SkillTable
 *                                                     uses 1–39 with EoL's numbering); id 0 is dropped.
 *                                                     SAC 1/2/3 are EoL's Untrained/Trained/Specialized.
 *     0x004 Body, 0x008 event filter, 0x010+ emote/create/page/generator tables: the server strips
 *           them; if one ever arrives the message is refused (they sit before the tail).
 *     0x100 SpellBook {u32 id, f32 charge, f32 0, f32 likelihood}   {i32 id, f32 charge}
 *     0x200 Enchantment registry u32 mask (1 mult, 2 add, 4 vitae; 8 cooldown never in 1999)
 *           1999 Enchantment {u32 spellId|layer<<16, u32 category, i32 power, f64 start, f64 dur,
 *           u32 caster, f32 degMod, f32 degLimit, f64 lastDeg, StatMod{u32,u32,f32}} = 60 bytes
 *           → EoL {u16 spell, u16 layer, u16 category, u16 hasSpellSet 0, …same…}
 *   PlayerModule: u32 selectorFlags, u32 options   u32 optionFlags (0x1 shortcuts, 0x20, 0x400),
 *                                                   u32 CharacterOptions1 = options (same bits:
 *                                                   ToggleRun 0x400 etc.)
 *     sel & 1: u32 n + n × {index, objectId, spellId}  n × {index, objectId, u16 spell, u16 layer}
 *     u32 n + n spell ids (the single spell bar)    8 spell lists: bar 0 = these, bars 1–7 empty
 *                                                   u32 SpellbookFilters = 0x3FFF (ACE's new-character
 *                                                   default; 1999 had no filters), no CO2, no window blob
 *   ContentProfile u32 n + {iid, containerProps}   inventory u32 n + {guid, containerType} (0/1/2 as-is)
 *   InventoryPlacement u32 n + {iid, loc, prio}    equipped u32 n + {guid, loc, prio}
 *
 * ── Property updates (1999: flat, NO sequence byte, objectId always present) ──
 *   [u32 op][u32 objectId][u32 key][value]. objectId == the player → the EoL Private* form (no guid),
 *   otherwise Public*. Every EoL update carries a ByteSequence; we synthesize one per
 *   (property type, key, object) that increases by one per message.
 *   0x0E Int      → 0x02CD / 0x02CE        (keys 21/22 → 0x02CF / 0x02D0 Int64 1/2; key 40 combat mode;
 *                                            key 188 HeritageGroup 0-based → 1-based). Every update,
 *                                            remove and table key goes through key1999ToEoL
 *   0x0F String   → 0x02D5 / 0x02D6        (AcString → String16L; Name remembered for 0x0013)
 *   0x11 DID      → 0x02D7 / 0x02D8
 *   0x2E Float    → 0x02D3 / 0x02D4
 *   0x43 Bool     → 0x02D1 / 0x02D2        (key 4 is 1999's PK flag → Int PlayerKillerStatus 134, 4 PK / 2 NPK)
 *   0x57 IID      → 0x02D9 / 0x02DA
 *   0x2D Position → 0x02DB / 0x02DC
 *   0x26 Attribute {f0,f1,f2}  → 0x02E3 (own only; EoL has no public attribute update)
 *   0x2C AttributeScalar value → 0x02E3 built from the last known record with the value replaced
 *   0x28 Skill (28-byte record) → 0x02DD (own only)
 *   0x10 SkillLevel rank / 0x2F SkillAdvancementClass sac → 0x02DD from the last known record
 *   0x29 Attribute2nd {raises, init, xp, current}: keys 1/3/5 → 0x02E7 PrivateUpdateVital;
 *        keys 2/4/6 → 0x02E9 PrivateUpdateAttribute2ndLevel (current); other objects → 0x02E8.
 *   0x1D1–0x1DE removes (odd = private [key], even = public [objectId][key]; the AC1999 server
 *        still prepends GDLE's u8 timestamp, so both widths are accepted) → the zero value as an
 *        update (0 / false / 0.0 / "" ), since neither ACE nor our handler has a remove; position
 *        removes are dropped.
 *   0x02CF / 0x02D0 / 0x02DB / 0x02DC / 0x02B8 / 0x02B9 (Int64 removes, handled end-of-retail-side
 *        by ServerMessageHandler): the AC1999 server still sends these GDLE leftovers in the
 *        end-of-retail layout (a 1999 client drops them); they pass through with the key renumbered.
 *
 * Lossy: the attribute raise count (1999 sends only the folded value), the spellbook's per-spell
 * likelihood (the charge rides in the EoL entry's f32), the derived wcid, spellbook filters / CharacterOptions2 (absent in 1999),
 * removes become zero values, position removes vanish.
 */
import { BinaryWriter } from '../../MessageSerializer.js';
import { eol, type AdapterContext, type Codecs1999, type InboundCodec } from '../Adapter1999.js';
import { Reader1999 } from '../Wire1999.js';

// End-of-retail opcodes (packages/network/src/GameMessageOpcode.ts).
const GAME_EVENT = 0xf7b0;
const EV_PLAYER_DESCRIPTION = 0x0013;
const OP = {
  PrivInt: 0x02cd, PubInt: 0x02ce, PrivInt64: 0x02cf, PubInt64: 0x02d0,
  PrivBool: 0x02d1, PubBool: 0x02d2, PrivFloat: 0x02d3, PubFloat: 0x02d4,
  PrivString: 0x02d5, PubString: 0x02d6, PrivDid: 0x02d7, PubDid: 0x02d8,
  PrivIid: 0x02d9, PubIid: 0x02da, PrivPosition: 0x02db, PubPosition: 0x02dc,
  PrivRemoveInt64: 0x02b8, PubRemoveInt64: 0x02b9,
  PrivSkill: 0x02dd, PrivAttribute: 0x02e3, PrivVital: 0x02e7, PubVital: 0x02e8, PrivVitalCurrent: 0x02e9,
} as const;

/** ACE PropertyInt / PropertyInt64 / PropertyString keys this codec rewrites. */
export const KEY = {
  IntTotalExperience: 21, IntAvailableExperience: 22, IntCombatMode: 40, IntPlayerKillerStatus: 134,
  IntHeritageGroup: 188,
  Int64TotalExperience: 1, Int64AvailableExperience: 2, StringName: 1, BoolPk1999: 4,
} as const;

/**
 * Int 188 HeritageGroup: the AC1999 server stores the 0-based CharGen index
 * (0 Aluvian, 1 Gharu'ndim, 2 Sho) on players and items alike (its
 * PhatSDK/GameEnums.h HeritageIndex; Client.cpp sets it from the char-create
 * index); end of retail holds the 1-based HeritageGroup enum (1 Aluvian …).
 * Negative values (an item's -1 "any heritage") pass through. Gender (Int 113)
 * needs nothing: the server stores the enum (1 Male, 2 Female), as EoL does.
 */
export function heritage1999ToEoL(v: number): number {
  return v >= 0 ? v + 1 : v;
}

/**
 * 1999 property key → end-of-retail key, per property type, or null when the key has no EoL
 * property (dropped, never passed on to be misread). The AC1999 server's STypeInt / Int64 /
 * Bool / Float / String / DID / IID / Position enums (PhatSDK/GameStatEnums.h) are sequential
 * and lack ACE's augmentation (and a few later) entries, so keys past the first gap sit lower
 * than the same name in ACE's Property*.cs / PositionType.cs. Matched name by name:
 *   Int      0–214 same; 215–260 +32 (… CharacterTitleId 229 → 261, NumCharacterTitles 230 → 262);
 *            261–266 +42; 267–281 +44; 282–343 +47 (… Enlightenment 343 → 390); 344+ none.
 *   Int64    0–2 same; 3–7 +1 (no AugmentationCost: ItemTotalXp … InteractionReqs; luminance
 *            5/6 → 6/7); 8+ none.
 *   String   0–47 same; 48–51 +1 (no AugmentationAddQuest: KillQuest2 … GearPlatingName); 52+ none.
 *   DID      0–52 same; 53 ProcSpell → 55; 54–58 +3 (AlternateCurrency … OlthoiDeathTreasureType;
 *            no AugmentationMutationFilter / Effect / CreateItem); 59+ none.
 *   Bool     0–130 same (105 is EXECUTING_EMOTE, ACE's Unknown105: nothing reads it); 131
 *            MERGE_LOCKED and 133 XPGAIN_BOOL are server-only with no EoL key: dropped.
 *   Float 0–171, IID 0–45, Position 0–27: identical; anything above is dropped.
 * Unmapped, the player's NUM_CHARACTER_TITLES (Int 230, set by LoadTitles) read as
 * AugmentationIncreasedCarryingCapacity: capacity Strength × 180 instead of the server's × 150
 * (EncumbranceSystem::EncumbranceCapacity(strength, 0)) in sessions whose description carried it.
 */
export type PropertyKind1999 = 'int' | 'int64' | 'bool' | 'float' | 'string' | 'did' | 'iid' | 'position';
const KEY_MAP_1999: Record<PropertyKind1999, { runs: ReadonlyArray<readonly [first: number, last: number, shift: number]>; end: number }> = {
  int: { runs: [[215, 260, 32], [261, 266, 42], [267, 281, 44], [282, 343, 47]], end: 344 },
  int64: { runs: [[3, 7, 1]], end: 8 },
  bool: { runs: [], end: 131 },
  float: { runs: [], end: 172 },
  string: { runs: [[48, 51, 1]], end: 52 },
  did: { runs: [[53, 53, 2], [54, 58, 3]], end: 59 },
  iid: { runs: [], end: 46 },
  position: { runs: [], end: 28 },
};
export function key1999ToEoL(kind: PropertyKind1999, key: number): number | null {
  const m = KEY_MAP_1999[kind];
  if (key >= m.end) return null;
  for (const [first, last, shift] of m.runs) if (key >= first && key <= last) return key + shift;
  return key;
}

/** A 1999 property table with its keys in end-of-retail numbering; keys with no EoL property are dropped. */
function remapTable<V>(kind: PropertyKind1999, t: Map<number, V>): Map<number, V> {
  const out = new Map<number, V>();
  for (const [k, v] of t) { const e = key1999ToEoL(kind, k); if (e !== null) out.set(e, v); }
  return out;
}

/** The EoL value of 1999 Int `key`, for the keys whose meaning differs. */
function int1999ToEoL(key: number, v: number): number {
  if (key === KEY.IntCombatMode) return combatMode1999ToEoL(v);
  if (key === KEY.IntHeritageGroup) return heritage1999ToEoL(v);
  return v;
}

/** 1999 wire combat mode (1 peace, 2 melee, 3 missile, 4 magic; AC1999Constants.h) → EoL CombatMode bits. */
export function combatMode1999ToEoL(v: number): number {
  return v === 3 ? 0x4 : v === 4 ? 0x8 : v;
}

export interface Attribute1999 { field0: number; field1: number; xp: number }
export interface Vital1999 { raises: number; init: number; xp: number; current: number }
export interface Skill1999 { rank: number; sac: number; xp: number; init: number; resist: number; lastUsed: number }
export interface Enchantment1999 {
  id: number; category: number; power: number; start: number; duration: number; caster: number;
  degradeModifier: number; degradeLimit: number; lastDegraded: number; smodType: number; smodKey: number; smodVal: number;
}

/** The parsed 1999 PlayerDescription (also what the tests assert against). */
export interface PlayerDescription1999 {
  weenieType: number;
  ints: Map<number, number>; int64s: Map<number, bigint>; bools: Map<number, number>; floats: Map<number, number>;
  strings: Map<number, string>; dids: Map<number, number>; iids: Map<number, number>;
  positions: Map<number, Uint8Array>;
  wcid: number;
  attributeFlags: number;
  attributes: Map<number, Attribute1999 | Vital1999>; // by AttributeCache bit
  skills: Map<number, Skill1999>;
  spells: Map<number, [number, number, number]>;
  enchantMask: number;
  enchantLists: Enchantment1999[][]; // mult, add, cooldown
  vitae: Enchantment1999 | null;
  selectorFlags: number; options: number;
  shortcuts: Array<{ index: number; objectId: number; spellId: number }>;
  spellBar: number[];
  inventory: Array<{ iid: number; containerProperties: number }>;
  equipped: Array<{ iid: number; loc: number; priority: number }>;
  derivedFlags: number; baseFlags: number;
}

/** What the player codecs remember across messages (exposed for tests). */
export interface Player1999State {
  guid: number;
  /** Name(1) string updates by object; the player's feeds the 0x0013 string table. */
  names: Map<number, string>;
  attributes: Map<number, Attribute1999>; // by attribute id 1..6
  skills: Map<number, Skill1999>;
  eventSequence: number;
  propertySequences: Map<string, number>;
}

const ATTR_BITS = [1, 2, 4, 8, 0x10, 0x20, 0x40, 0x80, 0x100];
/** AttributeCache bit → STypeAttribute id (Strength 1, Endurance 2, Quickness 3, Coordination 4, Focus 5, Self 6). */
const ATTR_ID_BY_BIT: Record<number, number> = { 1: 1, 2: 2, 4: 3, 8: 4, 0x10: 5, 0x20: 6 };

function readTable<T>(r: Reader1999, value: () => T): Map<number, T> {
  const count = r.u16();
  r.u16(); // buckets
  const m = new Map<number, T>();
  for (let i = 0; i < count; i++) { const key = r.u32(); m.set(key, value()); }
  return m;
}

function readEnchantment(r: Reader1999): Enchantment1999 {
  return {
    id: r.u32(), category: r.u32(), power: r.i32(), start: r.f64(), duration: r.f64(), caster: r.u32(),
    degradeModifier: r.f32(), degradeLimit: r.f32(), lastDegraded: r.f64(),
    smodType: r.u32(), smodKey: r.u32(), smodVal: r.f32(),
  };
}

/** The 1999 Enchantment in the EoL layout (spellId/layer and category/hasSpellSet split as u16; no set id). */
export function writeEnchantmentEoL(w: BinaryWriter, e: Enchantment1999): void {
  w.writeUInt32(e.id);
  w.writeUInt16(e.category & 0xffff);
  w.writeUInt16(0);
  w.writeInt32(e.power);
  w.writeFloat64(e.start);
  w.writeFloat64(e.duration);
  w.writeUInt32(e.caster);
  w.writeFloat32(e.degradeModifier);
  w.writeFloat32(e.degradeLimit);
  w.writeFloat64(e.lastDegraded);
  w.writeUInt32(e.smodType);
  w.writeUInt32(e.smodKey);
  w.writeFloat32(e.smodVal);
}

/** Parse a whole 1999 0x0013 (reader positioned after the opcode). Throws on a section 1999 servers never send. */
export function readPlayerDescription1999(r: Reader1999): PlayerDescription1999 {
  const baseFlags = r.u32();
  const weenieType = r.u32();
  const d: PlayerDescription1999 = {
    weenieType, baseFlags, ints: new Map(), int64s: new Map(), bools: new Map(), floats: new Map(), strings: new Map(),
    dids: new Map(), iids: new Map(), positions: new Map(), wcid: 0, attributeFlags: 0, attributes: new Map(),
    skills: new Map(), spells: new Map(), enchantMask: 0, enchantLists: [[], [], []], vitae: null,
    selectorFlags: 0, options: 0, shortcuts: [], spellBar: [], inventory: [], equipped: [], derivedFlags: 0,
  };
  // CBaseQualities::Pack order: Int, Int64, Bool, Float, String, DID, IID, Position.
  if (baseFlags & 0x01) d.ints = readTable(r, () => r.i32());
  if (baseFlags & 0x80) d.int64s = readTable(r, () => { const lo = r.u32(); const hi = r.i32(); return (BigInt(hi) << 32n) | BigInt(lo); });
  if (baseFlags & 0x02) d.bools = readTable(r, () => r.u32());
  if (baseFlags & 0x04) d.floats = readTable(r, () => r.f64());
  if (baseFlags & 0x10) d.strings = readTable(r, () => r.acString());
  if (baseFlags & 0x08) d.dids = readTable(r, () => r.u32());
  if (baseFlags & 0x40) d.iids = readTable(r, () => r.u32());
  if (baseFlags & 0x20) d.positions = readTable(r, () => r.bytes(32));

  const derived = r.u32();
  d.derivedFlags = derived;
  d.wcid = r.u32();
  if (derived & 0x001) {
    const flags = r.u32();
    d.attributeFlags = flags;
    for (const bit of ATTR_BITS) {
      if (!(flags & bit)) continue;
      if (bit < 0x40) d.attributes.set(bit, { field0: r.u32(), field1: r.u32(), xp: r.u32() });
      else d.attributes.set(bit, { raises: r.u32(), init: r.u32(), xp: r.u32(), current: r.u32() });
    }
  }
  if (derived & 0x002) {
    d.skills = readTable(r, () => ({ rank: r.u32() & 0xffff, sac: r.i32(), xp: r.u32(), init: r.u32(), resist: r.i32(), lastUsed: r.f64() }));
  }
  if (derived & 0x004) throw new Error('0x0013 carries a Body table (flag 0x4), which 1999 servers strip');
  if (derived & 0x100) d.spells = readTable(r, () => [r.f32(), r.f32(), r.f32()] as [number, number, number]);
  if (derived & 0x200) {
    const mask = r.u32();
    d.enchantMask = mask;
    const list = () => Array.from({ length: r.u32() }, () => readEnchantment(r));
    if (mask & 1) d.enchantLists[0] = list();
    if (mask & 2) d.enchantLists[1] = list();
    if (mask & 8) d.enchantLists[2] = list();
    if (mask & 4) d.vitae = readEnchantment(r);
  }
  const unsupported = derived & ~(0x001 | 0x002 | 0x004 | 0x100 | 0x200);
  if (unsupported) throw new Error(`0x0013 carries derived tables 0x${unsupported.toString(16)} (event filter/emote/create/page/generator)`);

  // PlayerModule (1999: PlayerModule_UnPack 0x4e47d0).
  d.selectorFlags = r.u32();
  d.options = r.u32();
  if (d.selectorFlags & 1) {
    const n = r.u32();
    for (let i = 0; i < n; i++) d.shortcuts.push({ index: r.u32(), objectId: r.u32(), spellId: r.u32() });
  }
  const bar = r.u32();
  for (let i = 0; i < bar; i++) d.spellBar.push(r.u32());
  const inv = r.u32();
  for (let i = 0; i < inv; i++) d.inventory.push({ iid: r.u32(), containerProperties: r.u32() });
  const eq = r.u32();
  for (let i = 0; i < eq; i++) d.equipped.push({ iid: r.u32(), loc: r.u32(), priority: r.u32() });
  return d;
}

function header(w: BinaryWriter, count: number): void {
  w.writeUInt16(count);
  w.writeUInt16(count > 0x40 ? 0x80 : 0x40); // buckets: read and ignored by every EoL reader
}

function writeInt64(w: BinaryWriter, v: bigint): void {
  w.writeUInt32(Number(v & 0xffffffffn));
  w.writeUInt32(Number((v >> 32n) & 0xffffffffn));
}

/** Pad to a 4-byte boundary of the whole message (the EoL Writer.Align after seq+key). */
function align(w: BinaryWriter): void {
  while (w.position % 4) w.writeUInt8(0);
}

/** The EoL PlayerDescription payload (after the 0xF7B0 event header) for a parsed 1999 description. */
export function writePlayerDescriptionEoL(w: BinaryWriter, d: PlayerDescription1999, name: string): void {
  const ints = remapTable('int', d.ints);
  const int64s = remapTable('int64', d.int64s);
  const bools = remapTable('bool', d.bools);
  const floats = remapTable('float', d.floats);
  const dids = remapTable('did', d.dids);
  const iids = remapTable('iid', d.iids);
  const positions = remapTable('position', d.positions);
  const xpTotal = ints.get(KEY.IntTotalExperience);
  const xpAvail = ints.get(KEY.IntAvailableExperience);
  ints.delete(KEY.IntTotalExperience);
  ints.delete(KEY.IntAvailableExperience);
  if (xpTotal !== undefined) int64s.set(KEY.Int64TotalExperience, BigInt(xpTotal >>> 0));
  if (xpAvail !== undefined) int64s.set(KEY.Int64AvailableExperience, BigInt(xpAvail >>> 0));
  for (const key of [KEY.IntCombatMode, KEY.IntHeritageGroup]) {
    const v = ints.get(key);
    if (v !== undefined) ints.set(key, int1999ToEoL(key, v));
  }
  const strings = remapTable('string', d.strings);
  if (name && !strings.has(KEY.StringName)) strings.set(KEY.StringName, name);

  let flags = 0;
  if (ints.size) flags |= 0x01;
  if (int64s.size) flags |= 0x80;
  if (bools.size) flags |= 0x02;
  if (floats.size) flags |= 0x04;
  if (strings.size) flags |= 0x10;
  if (dids.size) flags |= 0x08;
  if (iids.size) flags |= 0x40;
  if (positions.size) flags |= 0x20;
  w.writeUInt32(flags);
  w.writeUInt32(d.weenieType);
  if (ints.size) { header(w, ints.size); for (const [k, v] of ints) { w.writeUInt32(k); w.writeInt32(v); } }
  if (int64s.size) { header(w, int64s.size); for (const [k, v] of int64s) { w.writeUInt32(k); writeInt64(w, v); } }
  if (bools.size) { header(w, bools.size); for (const [k, v] of bools) { w.writeUInt32(k); w.writeUInt32(v); } }
  if (floats.size) { header(w, floats.size); for (const [k, v] of floats) { w.writeUInt32(k); w.writeFloat64(v); } }
  if (strings.size) { header(w, strings.size); for (const [k, v] of strings) { w.writeUInt32(k); w.writeString16(v); } }
  if (dids.size) { header(w, dids.size); for (const [k, v] of dids) { w.writeUInt32(k); w.writeUInt32(v); } }
  if (iids.size) { header(w, iids.size); for (const [k, v] of iids) { w.writeUInt32(k); w.writeUInt32(v); } }
  if (positions.size) { header(w, positions.size); for (const [k, v] of positions) { w.writeUInt32(k); w.writeBytes(v); } }

  const skills = [...d.skills].filter(([id]) => id !== 0);
  let vector = 0;
  if (d.derivedFlags & 0x001) vector |= 0x001;
  if (d.derivedFlags & 0x002) vector |= 0x002;
  if (d.derivedFlags & 0x100) vector |= 0x100;
  if (d.derivedFlags & 0x200) vector |= 0x200;
  w.writeUInt32(vector);
  w.writeUInt32(1); // hasHealth
  if (vector & 0x001) {
    w.writeUInt32(d.attributeFlags);
    for (const bit of ATTR_BITS) {
      const a = d.attributes.get(bit);
      if (!a) continue;
      if ('field0' in a) { w.writeUInt32(0); w.writeUInt32(a.field0); w.writeUInt32(a.xp); } else { w.writeUInt32(a.raises); w.writeUInt32(a.init); w.writeUInt32(a.xp); w.writeUInt32(a.current); }
    }
  }
  if (vector & 0x002) {
    header(w, skills.length);
    for (const [id, s] of skills) writeSkillEoL(w, id, s);
  }
  if (vector & 0x100) {
    header(w, d.spells.size);
    // End of retail's f32 here is ACE's constant 2.0, which nothing reads. A 1999 world puts the
    // spell's Charge there (SpellBookPage +0x4, always < 2.0: the same sentinel the 2005
    // SpellBookPage::UnPack splits the two forms on); the 1999 spell examine panel prints it.
    for (const [id, [charge]] of d.spells) { w.writeInt32(id); w.writeFloat32(charge); }
  }
  if (vector & 0x200) {
    w.writeUInt32(d.enchantMask & 0xf);
    const list = (l: Enchantment1999[]) => { w.writeUInt32(l.length); for (const e of l) writeEnchantmentEoL(w, e); };
    if (d.enchantMask & 1) list(d.enchantLists[0]);
    if (d.enchantMask & 2) list(d.enchantLists[1]);
    if (d.enchantMask & 8) list(d.enchantLists[2]);
    if (d.enchantMask & 4 && d.vitae) writeEnchantmentEoL(w, d.vitae);
  }

  // CharacterOptionDataFlag: Shortcut 0x1, SpellbookFilters 0x20, SpellLists8 0x400 (no CO2 0x40: 1999 has none).
  const optionFlags = (d.shortcuts.length ? 0x1 : 0) | 0x20 | 0x400;
  w.writeUInt32(optionFlags);
  w.writeUInt32(d.options);
  if (optionFlags & 0x1) {
    w.writeUInt32(d.shortcuts.length);
    for (const s of d.shortcuts) { w.writeUInt32(s.index); w.writeUInt32(s.objectId); w.writeUInt16(s.spellId & 0xffff); w.writeUInt16(s.spellId >>> 16); }
  }
  for (let bar = 0; bar < 8; bar++) {
    const ids = bar === 0 ? d.spellBar : [];
    w.writeUInt32(ids.length);
    for (const id of ids) w.writeUInt32(id);
  }
  w.writeUInt32(0x3fff); // SpellbookFilters: ACE's new-character default (all schools and levels)
  w.writeUInt32(d.inventory.length);
  for (const i of d.inventory) { w.writeUInt32(i.iid); w.writeUInt32(i.containerProperties); }
  w.writeUInt32(d.equipped.length);
  for (const e of d.equipped) { w.writeUInt32(e.iid); w.writeUInt32(e.loc); w.writeUInt32(e.priority); }
}

function writeSkillEoL(w: BinaryWriter, id: number, s: Skill1999): void {
  w.writeUInt32(id);
  w.writeUInt16(s.rank & 0xffff);
  w.writeUInt16(1);
  w.writeUInt32(s.sac);
  w.writeUInt32(s.xp);
  w.writeUInt32(s.init);
  w.writeUInt32(s.resist >>> 0);
  w.writeFloat64(s.lastUsed);
}

/**
 * Register the player-description and property-update codecs. Registers
 * after CharSelect (and any objects codec): it wraps an existing outbound
 * 0xF657 and inbound 0xF746 to learn the player's guid, and installs its own
 * 0xF746 (EoL PlayerCreate has the same layout) only when none is there.
 */
export function registerPlayer1999(c: Codecs1999): Player1999State {
  const st: Player1999State = {
    guid: 0, names: new Map(), attributes: new Map(), skills: new Map(), eventSequence: 0, propertySequences: new Map(),
  };
  const seq = (kind: string, key: number, obj: number): number => {
    const k = `${kind}:${key}:${obj}`;
    const next = ((st.propertySequences.get(k) ?? 0) + 1) & 0xff;
    st.propertySequences.set(k, next);
    return next;
  };
  const isOwn = (obj: number): boolean => st.guid !== 0 && obj === st.guid;

  // ── learning the player's guid ──
  const enterWorld = c.outbound.get(0xf657);
  if (enterWorld) {
    c.outbound.set(0xf657, (m, ctx) => {
      if (m.length >= 8) st.guid = new DataView(m.buffer, m.byteOffset, m.byteLength).getUint32(4, true);
      return enterWorld(m, ctx);
    });
  }
  const playerCreate = c.inbound.get(0xf746);
  c.inbound.set(0xf746, (r, ctx, raw) => {
    const guid = r.u32();
    st.guid = guid;
    if (playerCreate) return playerCreate(new Reader1999(raw, 4), ctx, raw);
    return [eol(0xf746, (w) => w.writeUInt32(guid))];
  });

  // ── 0x0013 PlayerDescription ──
  c.inbound.set(0x0013, (r, ctx) => {
    const d = readPlayerDescription1999(r);
    if (!st.guid) ctx.log('[1999] 0x0013 arrived before the player guid was known; event guid 0');
    if (r.remaining) ctx.log(`[1999] 0x0013 left ${r.remaining} bytes unread`);
    for (const [bit, a] of d.attributes) {
      const id = ATTR_ID_BY_BIT[bit];
      if (id && 'field0' in a) st.attributes.set(id, { ...a });
    }
    for (const [id, s] of d.skills) st.skills.set(id, { ...s });
    return [eol(GAME_EVENT, (w) => {
      w.writeUInt32(st.guid);
      w.writeUInt32(++st.eventSequence);
      w.writeUInt32(EV_PLAYER_DESCRIPTION);
      writePlayerDescriptionEoL(w, d, st.names.get(st.guid) ?? '');
    })];
  });

  // ── scalar property updates ──
  type Scalar = { kind: string; priv: number; pub: number; write: (w: BinaryWriter, v: number | string) => void };
  const intT: Scalar = { kind: 'int', priv: OP.PrivInt, pub: OP.PubInt, write: (w, v) => w.writeInt32(v as number) };
  const int64T: Scalar = { kind: 'int64', priv: OP.PrivInt64, pub: OP.PubInt64, write: (w, v) => writeInt64(w, BigInt((v as number) >>> 0)) };
  const boolT: Scalar = { kind: 'bool', priv: OP.PrivBool, pub: OP.PubBool, write: (w, v) => w.writeUInt32(v ? 1 : 0) };
  const floatT: Scalar = { kind: 'float', priv: OP.PrivFloat, pub: OP.PubFloat, write: (w, v) => w.writeFloat64(v as number) };
  const didT: Scalar = { kind: 'did', priv: OP.PrivDid, pub: OP.PubDid, write: (w, v) => w.writeUInt32(v as number) };
  const iidT: Scalar = { kind: 'iid', priv: OP.PrivIid, pub: OP.PubIid, write: (w, v) => w.writeUInt32(v as number) };

  /** One EoL scalar update: private [seq][key][value], public [seq][guid][key][value]. */
  const scalar = (t: Scalar, obj: number, key: number, value: number | string): Uint8Array => {
    const own = isOwn(obj);
    return eol(own ? t.priv : t.pub, (w) => {
      w.writeUInt8(seq(t.kind, key, obj));
      if (!own) w.writeUInt32(obj);
      w.writeUInt32(key);
      t.write(w, value);
    });
  };
  /** String updates: private [seq][key] align String16L; public [seq][key][guid] align String16L (ACE order). */
  const stringUpdate = (obj: number, key: number, value: string): Uint8Array => {
    const own = isOwn(obj);
    return eol(own ? OP.PrivString : OP.PubString, (w) => {
      w.writeUInt8(seq('string', key, obj));
      w.writeUInt32(key);
      if (!own) w.writeUInt32(obj);
      align(w);
      w.writeString16(value);
    });
  };
  /** The EoL key of a 1999 update's key, or null (logged) when it has no end-of-retail property. */
  const eolKey = (kind: PropertyKind1999, key: number, ctx: AdapterContext): number | null => {
    const k = key1999ToEoL(kind, key);
    if (k === null) ctx.log(`[1999] ${kind} property ${key} has no end-of-retail key; dropped`);
    return k;
  };
  /** Int update from a 1999 key (XP → Int64, values renumbered); [] when the key has no EoL property. */
  const intUpdate = (obj: number, key: number, value: number, ctx: AdapterContext): Uint8Array[] => {
    if (key === KEY.IntTotalExperience) return [scalar(int64T, obj, KEY.Int64TotalExperience, value)];
    if (key === KEY.IntAvailableExperience) return [scalar(int64T, obj, KEY.Int64AvailableExperience, value)];
    const k = eolKey('int', key, ctx);
    return k === null ? [] : [scalar(intT, obj, k, int1999ToEoL(key, value))];
  };

  c.inbound.set(0x0e, (r, ctx) => { const obj = r.u32(); const key = r.u32(); return intUpdate(obj, key, r.i32(), ctx); });
  c.inbound.set(0x0f, (r, ctx) => {
    const obj = r.u32(); const key = r.u32(); const value = r.acString();
    if (key === KEY.StringName) st.names.set(obj, value);
    const k = eolKey('string', key, ctx);
    return k === null ? [] : [stringUpdate(obj, k, value)];
  });
  c.inbound.set(0x11, (r, ctx) => {
    const obj = r.u32(); const k = eolKey('did', r.u32(), ctx); const value = r.u32();
    return k === null ? [] : [scalar(didT, obj, k, value)];
  });
  c.inbound.set(0x2e, (r, ctx) => {
    const obj = r.u32(); const k = eolKey('float', r.u32(), ctx); const value = r.f64();
    return k === null ? [] : [scalar(floatT, obj, k, value)];
  });
  c.inbound.set(0x43, (r, ctx) => {
    const obj = r.u32(); const key = r.u32(); const value = r.u32();
    // 1999 carries PK status as bool key 4 (AC1999Constants.h PK_STATUS_BOOL_KEY); EoL as Int 134.
    if (key === KEY.BoolPk1999) return [scalar(intT, obj, KEY.IntPlayerKillerStatus, value ? 0x4 : 0x2)];
    const k = eolKey('bool', key, ctx);
    return k === null ? [] : [scalar(boolT, obj, k, value)];
  });
  c.inbound.set(0x57, (r, ctx) => {
    const obj = r.u32(); const k = eolKey('iid', r.u32(), ctx); const value = r.u32();
    return k === null ? [] : [scalar(iidT, obj, k, value)];
  });
  c.inbound.set(0x2d, (r, ctx) => {
    const obj = r.u32(); const key1999 = r.u32(); const pos = r.bytes(32);
    const key = eolKey('position', key1999, ctx);
    if (key === null) return [];
    const own = isOwn(obj);
    return [eol(own ? OP.PrivPosition : OP.PubPosition, (w) => {
      w.writeUInt8(seq('position', key, obj));
      if (!own) w.writeUInt32(obj);
      w.writeUInt32(key);
      w.writeBytes(pos);
    })];
  });

  // ── attributes, skills, vitals ──
  const attributeUpdate = (key: number, a: Attribute1999): Uint8Array => eol(OP.PrivAttribute, (w) => {
    w.writeUInt8(seq('attribute', key, st.guid));
    w.writeUInt32(key);
    w.writeUInt32(0); // ranks: 1999 sends only the folded value
    w.writeUInt32(a.field0); // the 1999 client shows field0 alone
    w.writeUInt32(a.xp);
  });
  const skillUpdate = (key: number, s: Skill1999): Uint8Array => {
    const w = new BinaryWriter(48);
    w.writeUInt32(OP.PrivSkill);
    w.writeUInt8(seq('skill', key, st.guid));
    // ACE GameMessagePrivateUpdateSkill: the same record as the description entry, after the key.
    writeSkillEoL(w, key, s);
    return w.toBuffer();
  };
  const ownOnly = (name: string, ctx: AdapterContext, obj: number): boolean => {
    if (isOwn(obj)) return true;
    ctx.log(`[1999] ${name} for another object 0x${obj.toString(16)}; end of retail has no public form, dropped`);
    return false;
  };

  c.inbound.set(0x26, (r, ctx) => {
    const obj = r.u32(); const key = r.u32();
    const a = { field0: r.u32(), field1: r.u32(), xp: r.u32() };
    if (!ownOnly('0x26 UpdateAttribute', ctx, obj)) return [];
    st.attributes.set(key, a);
    return [attributeUpdate(key, a)];
  });
  c.inbound.set(0x2c, (r, ctx) => {
    const obj = r.u32(); const key = r.u32(); const value = r.u32();
    if (!ownOnly('0x2C UpdateAttributeScalar', ctx, obj)) return [];
    const a = { ...(st.attributes.get(key) ?? { field0: 0, field1: 0, xp: 0 }), field0: value, field1: 0 };
    st.attributes.set(key, a);
    return [attributeUpdate(key, a)];
  });
  const blankSkill = (): Skill1999 => ({ rank: 0, sac: 1, xp: 0, init: 0, resist: 0, lastUsed: 0 });
  c.inbound.set(0x28, (r, ctx) => {
    const obj = r.u32(); const key = r.u32();
    const s: Skill1999 = { rank: r.u32() & 0xffff, sac: r.i32(), xp: r.u32(), init: r.u32(), resist: r.i32(), lastUsed: r.f64() };
    if (!ownOnly('0x28 UpdateSkill', ctx, obj)) return [];
    st.skills.set(key, s);
    return [skillUpdate(key, s)];
  });
  c.inbound.set(0x10, (r, ctx) => {
    const obj = r.u32(); const key = r.u32(); const rank = r.u32();
    if (!ownOnly('0x10 UpdateSkillLevel', ctx, obj)) return [];
    const s = { ...(st.skills.get(key) ?? blankSkill()), rank };
    st.skills.set(key, s);
    return [skillUpdate(key, s)];
  });
  c.inbound.set(0x2f, (r, ctx) => {
    const obj = r.u32(); const key = r.u32(); const sac = r.u32();
    if (!ownOnly('0x2F UpdateSkillAdvancementClass', ctx, obj)) return [];
    const s = { ...(st.skills.get(key) ?? blankSkill()), sac };
    st.skills.set(key, s);
    return [skillUpdate(key, s)];
  });
  c.inbound.set(0x29, (r) => {
    const obj = r.u32(); const key = r.u32();
    const v: Vital1999 = { raises: r.u32(), init: r.u32(), xp: r.u32(), current: r.u32() };
    if (!isOwn(obj)) {
      return [eol(OP.PubVital, (w) => {
        w.writeUInt8(seq('vital', key, obj));
        w.writeUInt32(obj); w.writeUInt32(key);
        w.writeUInt32(v.raises); w.writeUInt32(v.init); w.writeUInt32(v.xp); w.writeUInt32(v.current);
      })];
    }
    if (key === 2 || key === 4 || key === 6) {
      return [eol(OP.PrivVitalCurrent, (w) => { w.writeUInt8(seq('vital', key, obj)); w.writeUInt32(key); w.writeUInt32(v.current); })];
    }
    return [eol(OP.PrivVital, (w) => {
      w.writeUInt8(seq('vital', key, obj));
      w.writeUInt32(key);
      w.writeUInt32(v.raises); w.writeUInt32(v.init); w.writeUInt32(v.xp); w.writeUInt32(v.current);
    })];
  });

  // ── removes 0x1D1–0x1DE → the zero value ──
  const removes: Array<[number, Scalar | 'string' | 'position']> = [
    [0x1d1, intT], [0x1d3, boolT], [0x1d5, floatT], [0x1d7, 'string'], [0x1d9, didT], [0x1db, iidT], [0x1dd, 'position'],
  ];
  for (const [privOp, t] of removes) {
    const make = (isPublic: boolean): InboundCodec => (r, ctx, raw) => {
      // 1999: [key] / [objectId][key]; the AC1999 server still writes GDLE's u8 timestamp first.
      const base = isPublic ? 12 : 8;
      if (raw.length === base + 1) r.u8();
      const obj = isPublic ? r.u32() : st.guid;
      const key = r.u32();
      if (t === 'position') { ctx.log('[1999] position remove has no end-of-retail form; dropped'); return []; }
      // A removed heritage is 0 (none) in both eras, not the index 0 (Aluvian).
      if (t === intT) return key === KEY.IntHeritageGroup ? [scalar(intT, obj, key, 0)] : intUpdate(obj, key, 0, ctx);
      const k = eolKey(t === 'string' ? 'string' : t.kind as PropertyKind1999, key, ctx);
      if (k === null) return [];
      if (t === 'string') return [stringUpdate(obj, k, '')];
      return [scalar(t, obj, k, 0)];
    };
    c.inbound.set(privOp, make(false));
    c.inbound.set(privOp + 1, make(true));
  }

  // ── GDLE leftovers the AC1999 server sends already in the end-of-retail layout ──
  // Same EoL layout, but the key is the server's 1999 numbering (luminance Int64 5/6 → 6/7):
  // [u32 op][u8 seq]([u32 guid] public)[u32 key][value].
  for (const [op, kind, keyAt] of [
    [OP.PrivInt64, 'int64', 5], [OP.PubInt64, 'int64', 9], [OP.PrivPosition, 'position', 5], [OP.PubPosition, 'position', 9],
    // GAP.gdle-qualities-remove-events — the Int64 removes (WeenieObject.cpp
    // NotifyInt64StatUpdated): [u8 seq]([u32 guid])[u32 key], no value.
    [OP.PrivRemoveInt64, 'int64', 5], [OP.PubRemoveInt64, 'int64', 9],
  ] as const) {
    c.inbound.set(op, (_r, ctx, raw) => {
      const out = raw.slice();
      const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
      if (out.length < keyAt + 4) return [out];
      const k = eolKey(kind, view.getUint32(keyAt, true), ctx);
      if (k === null) return [];
      view.setUint32(keyAt, k, true);
      return [out];
    });
  }

  return st;
}
