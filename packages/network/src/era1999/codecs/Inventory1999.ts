/**
 * Milestone M6a of the 1999 adapter: inventory, containers, vendors, giving and
 * appraisal (docs/ac1999-support.md). No capture of these exists yet; layouts are
 * the AC1999 server's readers (ClientEvents.cpp ProcessEvent, PhatSDK
 * VendorProfile.cpp ItemProfile::UnPack) and writers (ObjectMsgs.cpp InventoryMove /
 * InventoryEquip / InventoryDrop / IdentifyObject, Monster.cpp, Container.cpp,
 * Player.cpp, WeenieObject.cpp, Vendor.cpp SendVendorInventory, PhatSDK
 * Appraisal.cpp), checked against the KB's 1999 builder catalog
 * (messages/client-to-server/0xF7B1-GameAction.md, Inventory/, Vendor/, Item/).
 * The end-of-retail side is ACE's GameAction readers / GameEvent writers as our
 * MessageSerializer builders and ServerMessageHandler use them.
 *
 * ── Client → server (0xF7B1 [u32 seq][u32 type][payload], group 5) ──
 *   Same type, same payload (re-emitted field by field, so a short EoL action fails here):
 *   0x19 PutItemInContainer {item, container, placement}   0x1A GetAndWieldItem {item, location}
 *   0x1B DropItem {item}   0x35 UseWithTarget {source, target}   0x54 StackableMerge {from, to, amount}
 *   0x55 StackableSplitToContainer {stack, container, place, amount}   0x56 StackableSplitTo3D {stack, amount}
 *   0x19B StackableSplitToWield {stack, location, amount}   0xCD GiveObjectRequest {target, item, amount}
 *   0x195 NoLongerViewingContents {container}   0x263 QueryItemMana {item; 0 = clear: the server ignores 0}
 *   0x5F Buy / 0x60 Sell  EoL: u32 vendor, u32 n, n × {i32 amount, u32 item}
 *                         1999: u32 vendor, u32 n, n × ItemProfile {u32 amount (24 bits; a non-zero
 *                         high byte means a PublicWeenieDesc follows, so it is masked), u32 item}
 *   0xBF SetInscription   EoL: u32 item, String16 → 1999: u32 item, AcString (the server's ReadString
 *                         reads the length's bytes, NUL included, and aligns)
 *   0xC8 IdentifyObject is Movement1999's (identical; the 1999 server's APPRAISE). 1999's own 0xCA
 *   RequestAppraisal (FellowPanel, answered by 0x1CA) has no end-of-retail action.
 *   0x195 / 0xBF / 0x263: the server reads them; the KB has not yet located their 1999 builders.
 *
 * ── Server → client ──
 *   Wrapped in 0xF7B0 by the server (SendNetMessage event=TRUE): the EoL envelope. Each is also
 *   registered flat (the 1999 client's dispatcher reads them flat), which becomes an EoL event for
 *   the player's guid and next event sequence (Player1999's session state). Same layout as end of retail:
 *     0x22 InventoryPutObjInContainer {item, container, slot, type}   0x23 WieldObject {item, location}
 *     0x19A InventoryPutObjectIn3D {item}   0x52 CloseGroundContainer {container}
 *     0xA0 InventoryServerSaveFailed {item, error}   0x264 QueryItemManaResponse {item, f32, u32}
 *   0x62 ApproachVendor  1999: u32 vendor, VendorProfile {u32 itemTypes, i32 min, i32 max, i32 magic,
 *                        f32 buy, f32 sell} (24 bytes: no alternate currency), u32 n,
 *                        n × {u32 0xFF000000|amount24, u32 item, 1999 PublicWeenieDesc}
 *                        EoL: the same profile + u32 altCurrency 0, u32 0, String16 "", u32 n,
 *                        n × {same two u32, EoL WeenieDesc}. The descriptor goes through the
 *                        registered 0xF745 codec (Objects1999), so it reads exactly as an ObjectCreate's.
 *   0xC9 IdentifyObjectResponse  1999 (Appraisal.cpp AppraisalProfile::Pack): u32 object, u32 flags,
 *        i32 success, then by bit in this order: 0x1 creature {u32 flags, u32 level (0xFFFFFFFF
 *        unknown), i32 health, i32 maxHealth, [0x8: str, end, quick, coord, focus, self, stam, mana,
 *        maxStam, maxMana], [0x4: u32 creatureType], [0x2: u32 allegianceRank, u32 followers,
 *        3 × u32, AcString gender, heritage, profession, fellowship, monarch, 6 face DIDs (eyes,
 *        nose, mouth textures; hair, eyes, skin palettes)], [0x1: u32 enchantment bits]};
 *        0x2 weapon {u32 damageType, i32 time, u32 skill, i32 damage, f64 variance, length,
 *        maxVelocity, defense, offense}; 0x4 armor 7 × f32 (slash … electric, no nether);
 *        0x8 {mass, Value, EncumbVal}; 0x20 {u32, u32} (unread by the client); 0x200 LockpickSuccess%;
 *        0x80 / 0x100 book pages used / page capacity; 0x4000 Open; 0x800 Locked; 0x2000 BoosterEnum;
 *        0x1000 BoostValue; 0x8000 ArmorLevel; 0x40 ResistLockpick; 0x4000000 AcString Craftsman;
 *        0x10 AcString inscription, scribe, scribe account; 0x400 Use; 0x20000 LongDesc;
 *        0x40000 ShortDesc; 0x10000 {MinLevel, MaxLevel, AcString portal destination};
 *        0x80000 {Structure, MaxStructure}; 0x100000 / 0x200000 / 0x400000 armor / weapon / resist
 *        enchantment bits; 0x800000 magic {difficulty, spellcraft, rankLimit, curMana, maxMana,
 *        u32 manaCost, u32 (an f32) manaRate, AcString heritage restriction, skillLevelLimit, u32 skill,
 *        AcString spell names, AcString spell descriptions, f64 range fallback}; 0x1000000 mana stone
 *        {f64 efficiency, u32 curMana}; 0x2000000 AcString enchantments (UnPack @ 0x005e0fa0 in the
 *        1999 client.exe reads exactly these, in this order). 0xFFFFFFFF in a fixed section = absent.
 *        The 1999-only fields (spell names / descriptions, enchantments, mana rate, range fallback)
 *        ride under @ac/shared APPRAISAL_1999_STRING / _FLOAT keys, past every STypes range; the
 *        1999 item page (ui/examine/ItemAppraisalText1999.ts) reads them.
 *        → EoL: the property-table form (Int/Bool/Float/String/DID tables keyed by the same
 *        STypes, which 1999 and end of retail share), CreatureProfile {flags 0x8|0x1 only, health,
 *        maxHealth, attributes, u16+u16 enchantment bits = the 1999 u32}, WeaponProfile (+ Float 29
 *        WeaponDefense), ArmorProfile (8 floats), the three enchantment bitfields (u32 = u16+u16).
 *        The character block becomes Strings Sex 3 / HeritageGroup 4 / Template 5 / Fellowship 10 /
 *        MonarchsName 11 and MonarchsTitle 21, Ints Gender 113 / HeritageGroup 188 (from the names),
 *        AllegianceRank 30, AllegianceFollowers 35, the face DIDs 9/10/11/15/16/17.
 *   Flat (SendNetMessage event=FALSE):
 *     0x197 SetStackSize  1999: {guid, stack, value} (no sequence byte) → EoL u8 sequence (synthesized,
 *           +1 per object) + the same
 *     0x24 InventoryRemoveObject {guid} → same
 *   0x196 ViewContents and 0x1C7 UseDone are Movement1999's; 0xF749 / 0xF74A are Objects1999's;
 *   0x1C AttemptFailed (→ WeenieError) is Combat1999's.
 *
 * Lossy:
 *   - Appraisal: 1999 sends the item's spell NAMES, not ids, so the EoL spell book is empty (the
 *     names ride under APPRAISAL_1999_STRING.spellNames); 1999 armor has no nether mod (sent as 0);
 *     1999 weapons have no damage modifier (sent as 1.0) or estimated-velocity flag (0); the creature
 *     block's three unknown dwords, the mass sentinel and block 0x20's two dwords are dropped.
 *     A flag bit UnPack doesn't read refuses the message.
 *   - Buy / Sell: amounts are 24 bits in 1999.
 *   - Vendor: no alternate currency in 1999 (sent as 0 / "").
 */
import { BinaryReader, BinaryWriter } from '../../MessageSerializer.js';
import { Group1999, eol, type AdapterContext, type Codecs1999, type Outbound1999 } from '../Adapter1999.js';
import { Reader1999, Writer1999 } from '../Wire1999.js';
import type { Player1999State } from './Player1999.js';
import { APPRAISAL_1999_FLOAT, APPRAISAL_1999_INT, APPRAISAL_1999_STRING } from '@ac/shared';

/** The F7B0 envelope's fields, when the message arrived wrapped. */
interface Envelope { guid: number; sequence: number }
type BodyCodec = (r: Reader1999, env: Envelope, ctx: AdapterContext) => Uint8Array[];

export interface Inventory1999Options {
  /**
   * The player module's session state (Player1999.ts), read lazily: its guid and event sequence
   * envelope a flat 1999 message that becomes an EoL GameEvent (as Combat1999 does).
   */
  player?: () => Player1999State | null;
}

const NONE = 0xffffffff;

/** Property ids (ACE PropertyInt/Bool/Float/String/DataId; 1999 STypes use the same numbers). */
const P = {
  IntCreatureType: 2, IntEncumbVal: 5, IntValue: 19, IntLevel: 25, IntArmorLevel: 28, IntAllegianceRank: 30,
  IntAllegianceFollowers: 35, IntResistLockpick: 38, IntMinLevel: 86, IntMaxLevel: 87, IntBoosterEnum: 89,
  IntBoostValue: 90, IntMaxStructure: 91, IntStructure: 92, IntItemSpellcraft: 106, IntItemCurMana: 107,
  IntItemMaxMana: 108, IntItemDifficulty: 109, IntItemAllegianceRankLimit: 110, IntGender: 113,
  IntItemSkillLevelLimit: 115, IntItemManaCost: 117, IntLockpickSuccessPercent: 173, IntAppraisalPages: 174,
  IntAppraisalMaxPages: 175, IntHeritageGroup: 188,
  BoolOpen: 2, BoolLocked: 3,
  FloatWeaponDefense: 29, FloatItemEfficiency: 87,
  StrSex: 3, StrHeritageGroup: 4, StrTemplate: 5, StrInscription: 7, StrScribeName: 8, StrFellowship: 10,
  StrMonarchsName: 11, StrUse: 14, StrShortDesc: 15, StrLongDesc: 16, StrItemHeritageRestriction: 19,
  StrMonarchsTitle: 21, StrScribeAccount: 23, StrCraftsmanName: 25, StrPortalDestination: 38,
  DidEyesTexture: 9, DidNoseTexture: 10, DidMouthTexture: 11, DidHairPalette: 15, DidEyesPalette: 16,
  DidSkinPalette: 17, DidItemSkillLimit: 37,
} as const;

/** The 1999 AppraisalProfile bits the server writes (Appraisal.cpp); anything else has an unknown layout. */
/** The 1999 AppraisalProfile bits whose layout UnPack @ 0x005e0fa0 (1999 client.exe) reads; any other bit refuses the message. */
const APPRAISAL_KNOWN_1999 = 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20 | 0x40 | 0x80 | 0x100 | 0x200 | 0x400 | 0x800 | 0x1000
  | 0x2000 | 0x4000 | 0x8000 | 0x10000 | 0x20000 | 0x40000 | 0x80000 | 0x100000 | 0x200000 | 0x400000 | 0x800000
  | 0x1000000 | 0x2000000 | 0x4000000;

/** EoL HeritageGroup / Gender from the 1999 char-gen names the appraisal carries. */
const HERITAGE_BY_NAME: Record<string, number> = { aluvian: 1, "gharu'ndim": 2, gharundim: 2, sho: 3 };
const GENDER_BY_NAME: Record<string, number> = { male: 1, female: 2 };

function eolEvent(env: Envelope, type: number, build: (w: BinaryWriter) => void): Uint8Array {
  return eol(0xf7b0, (w) => {
    w.writeUInt32(env.guid);
    w.writeUInt32(env.sequence);
    w.writeUInt32(type);
    build(w);
  });
}

function align4(w: BinaryWriter): void {
  while (w.position % 4) w.writeUInt8(0);
}

function tableHeader(w: BinaryWriter, count: number): void {
  w.writeUInt16(count);
  w.writeUInt16(count > 0x40 ? 0x80 : 0x40); // buckets: read and ignored by every EoL reader
}

// ── Appraisal ─────────────────────────────────────────────────────────────

/** 1999 AppraisalProfile (after the object id) → EoL IdentifyObjectResponse body (after the object id). */
function appraisal(r: Reader1999, w: BinaryWriter): void {
  const flags = r.u32();
  const unknown = flags & ~APPRAISAL_KNOWN_1999;
  if (unknown) throw new Error(`AppraisalProfile flags 0x${flags.toString(16)} carry bits 0x${unknown.toString(16)} of unknown layout`);
  const success = r.i32();
  const has = (bit: number) => (flags & bit) !== 0;

  const ints = new Map<number, number>();
  const bools = new Map<number, number>();
  const floats = new Map<number, number>();
  const strings = new Map<number, string>();
  const dids = new Map<number, number>();
  const intIfSet = (key: number, v: number) => { if (v >>> 0 !== NONE) ints.set(key, v | 0); };
  const strIfSet = (key: number, s: string) => { if (s) strings.set(key, s); };

  let creature: { flags: number; health: number; maxHealth: number; attrs: number[] | null; ench: number } | null = null;
  if (has(0x1)) {
    const cf = r.u32();
    const level = r.u32();
    const health = r.i32();
    const maxHealth = r.i32();
    const attrs = cf & 0x8 ? Array.from({ length: 10 }, () => r.u32()) : null;
    if (cf & 0x4) ints.set(P.IntCreatureType, r.u32());
    if (cf & 0x2) {
      ints.set(P.IntAllegianceRank, r.u32());
      ints.set(P.IntAllegianceFollowers, r.u32());
      // +0x40 / +0x44: the character's Loyalty and Leadership, which the 1999 character examine panel
      // prints under "No Allegiance" (CharExaminePanel::SetAppraiseInfo @ 0x0050f760 via 0x00463eb0 /
      // 0x005a2670); +0x88 has no reader.
      ints.set(APPRAISAL_1999_INT.loyalty, r.u32() | 0);
      ints.set(APPRAISAL_1999_INT.leadership, r.u32() | 0);
      r.u32();
      const gender = r.acString();
      const heritage = r.acString();
      const profession = r.acString();
      const fellowship = r.acString();
      const monarch = r.acString();
      strIfSet(P.StrSex, gender);
      strIfSet(P.StrHeritageGroup, heritage);
      strIfSet(P.StrTemplate, profession);
      strIfSet(P.StrFellowship, fellowship);
      strIfSet(P.StrMonarchsName, monarch);
      strIfSet(P.StrMonarchsTitle, monarch);
      const g = GENDER_BY_NAME[gender.toLowerCase()];
      if (g) ints.set(P.IntGender, g);
      const h = HERITAGE_BY_NAME[heritage.toLowerCase()];
      if (h) ints.set(P.IntHeritageGroup, h);
      for (const key of [P.DidEyesTexture, P.DidNoseTexture, P.DidMouthTexture, P.DidHairPalette, P.DidEyesPalette, P.DidSkinPalette]) {
        const v = r.u32();
        if (v) dids.set(key, v);
      }
    }
    const ench = cf & 0x1 ? r.u32() : 0;
    intIfSet(P.IntLevel, level);
    creature = { flags: (cf & 0x8) | (ench ? 0x1 : 0), health, maxHealth, attrs, ench };
  }

  let weapon: { type: number; time: number; skill: number; damage: number; variance: number; length: number; maxVelocity: number; offense: number } | null = null;
  if (has(0x2)) {
    const type = r.u32(), time = r.i32(), skill = r.u32(), damage = r.i32();
    const variance = r.f64(), length = r.f64(), maxVelocity = r.f64(), defense = r.f64(), offense = r.f64();
    floats.set(P.FloatWeaponDefense, defense);
    weapon = { type, time, skill, damage, variance, length, maxVelocity, offense };
  }

  const armor = has(0x4) ? Array.from({ length: 7 }, () => r.f32()) : null;

  if (has(0x8)) {
    r.u32(); // mass: always the absent sentinel, never read by the 1999 client
    intIfSet(P.IntValue, r.u32());
    intIfSet(P.IntEncumbVal, r.u32());
  }
  if (has(0x20)) { r.u32(); r.u32(); } // +0x24 / +0x28: no Inq mapping, nothing in the 1999 client reads them
  if (has(0x200)) ints.set(P.IntLockpickSuccessPercent, r.i32());
  // +0x30 / +0x34: a book's pages used / page capacity — "%d of %d pages full." (ItemExaminePanel @ 0x0050cc00).
  if (has(0x80)) intIfSet(P.IntAppraisalPages, r.u32());
  if (has(0x100)) intIfSet(P.IntAppraisalMaxPages, r.u32());
  if (has(0x800)) bools.set(P.BoolLocked, r.u32() ? 1 : 0);
  if (has(0x2000)) ints.set(P.IntBoosterEnum, r.i32());
  if (has(0x1000)) ints.set(P.IntBoostValue, r.i32());
  if (has(0x4000)) bools.set(P.BoolOpen, r.u32() ? 1 : 0);
  if (has(0x8000)) ints.set(P.IntArmorLevel, r.i32());
  if (has(0x40)) ints.set(P.IntResistLockpick, r.i32());
  if (has(0x4000000)) strIfSet(P.StrCraftsmanName, r.acString());
  if (has(0x10)) {
    strIfSet(P.StrInscription, r.acString());
    strIfSet(P.StrScribeName, r.acString());
    strIfSet(P.StrScribeAccount, r.acString());
  }
  if (has(0x400)) strIfSet(P.StrUse, r.acString());
  if (has(0x20000)) strIfSet(P.StrLongDesc, r.acString());
  if (has(0x40000)) strIfSet(P.StrShortDesc, r.acString());
  if (has(0x10000)) {
    intIfSet(P.IntMinLevel, r.u32());
    intIfSet(P.IntMaxLevel, r.u32());
    // Kept as sent, " " included: the 1999 panel draws the level section only when this string is
    // non-empty (gate 0x005df880), and the AC1999 server's " " filler is what opens that gate.
    strIfSet(P.StrPortalDestination, r.acString());
  }
  if (has(0x80000)) {
    intIfSet(P.IntStructure, r.u32());
    intIfSet(P.IntMaxStructure, r.u32());
  }
  const armorEnch = has(0x100000) ? r.u32() : null;
  const weaponEnch = has(0x200000) ? r.u32() : null;
  const resistEnch = has(0x400000) ? r.u32() : null;
  if (has(0x800000)) {
    intIfSet(P.IntItemDifficulty, r.u32());
    intIfSet(P.IntItemSpellcraft, r.u32());
    intIfSet(P.IntItemAllegianceRankLimit, r.u32());
    intIfSet(P.IntItemCurMana, r.u32());
    intIfSet(P.IntItemMaxMana, r.u32());
    intIfSet(P.IntItemManaCost, r.u32()); // +0x70: "Mana Cost: %d." (0x004207d0)
    const rate = new DataView(new Uint32Array([r.u32()]).buffer).getFloat32(0, true); // +0x74: a dword the panel loads as a float
    if (rate !== 0) floats.set(APPRAISAL_1999_FLOAT.manaRate, rate);
    strIfSet(P.StrItemHeritageRestriction, r.acString());
    intIfSet(P.IntItemSkillLevelLimit, r.u32());
    const skill = r.u32();
    if (skill) dids.set(P.DidItemSkillLimit, skill);
    strIfSet(APPRAISAL_1999_STRING.spellNames, r.acString()); // end of retail carries spell ids; 1999 the names
    strIfSet(APPRAISAL_1999_STRING.spellDescriptions, r.acString());
    const range = r.f64();
    if (range !== -1) floats.set(APPRAISAL_1999_FLOAT.rangeFallback, range);
  }
  if (has(0x1000000)) {
    // Mana stone: +0x118 f64 efficiency (InqFloat 0x57), then +0x68 current mana again.
    const efficiency = r.f64();
    if (efficiency !== -1) floats.set(P.FloatItemEfficiency, efficiency);
    intIfSet(P.IntItemCurMana, r.u32());
  }
  if (has(0x2000000)) strIfSet(APPRAISAL_1999_STRING.enchantments, r.acString());

  let out = 0;
  if (ints.size) out |= 0x1;
  if (bools.size) out |= 0x2;
  if (floats.size) out |= 0x4;
  if (strings.size) out |= 0x8;
  if (dids.size) out |= 0x1000;
  if (armor) out |= 0x80;
  if (creature) out |= 0x100;
  if (weapon) out |= 0x20;
  if (armorEnch !== null) out |= 0x200;
  if (weaponEnch !== null) out |= 0x800;
  if (resistEnch !== null) out |= 0x400;

  w.writeUInt32(out);
  w.writeUInt32(success ? 1 : 0);
  if (ints.size) { tableHeader(w, ints.size); for (const [k, v] of ints) { w.writeUInt32(k); w.writeInt32(v); } }
  if (bools.size) { tableHeader(w, bools.size); for (const [k, v] of bools) { w.writeUInt32(k); w.writeUInt32(v); } }
  if (floats.size) { tableHeader(w, floats.size); for (const [k, v] of floats) { w.writeUInt32(k); w.writeFloat64(v); } }
  if (strings.size) { tableHeader(w, strings.size); for (const [k, v] of strings) { w.writeUInt32(k); w.writeString16(v); } }
  if (dids.size) { tableHeader(w, dids.size); for (const [k, v] of dids) { w.writeUInt32(k); w.writeUInt32(v); } }
  if (armor) {
    // EoL order: slash, pierce, bludgeon, cold, fire, acid, NETHER, electric. 1999 has no nether.
    for (let i = 0; i < 6; i++) w.writeFloat32(armor[i]);
    w.writeFloat32(0);
    w.writeFloat32(armor[6]);
  }
  if (creature) {
    w.writeUInt32(creature.flags);
    w.writeUInt32(creature.health >>> 0);
    w.writeUInt32(creature.maxHealth >>> 0);
    if (creature.attrs) for (const v of creature.attrs) w.writeUInt32(v);
    if (creature.flags & 0x1) w.writeUInt32(creature.ench); // u16 highlight + u16 color
  }
  if (weapon) {
    w.writeUInt32(weapon.type);
    w.writeInt32(weapon.time);
    w.writeUInt32(weapon.skill);
    w.writeInt32(weapon.damage);
    w.writeFloat64(weapon.variance);
    w.writeFloat64(1.0); // damage modifier: not in 1999
    w.writeFloat64(weapon.length);
    w.writeFloat64(weapon.maxVelocity);
    w.writeFloat64(weapon.offense);
    w.writeUInt32(0); // max velocity estimated: not in 1999
  }
  if (armorEnch !== null) w.writeUInt32(armorEnch);
  if (weaponEnch !== null) w.writeUInt32(weaponEnch);
  if (resistEnch !== null) w.writeUInt32(resistEnch);
}

// ── Vendor ────────────────────────────────────────────────────────────────

/** Byte length of the synthetic ObjectCreate prefix (guid, empty ObjDesc, empty PhysicsDesc) in both eras. */
const CREATE_PREFIX = 40;

/**
 * One 1999 PublicWeenieDesc at `r` → the EoL WeenieDesc, through the registered 0xF745 codec
 * (Objects1999), so a vendor ware reads exactly as an ObjectCreate's descriptor. The descriptor is
 * spliced after an empty ObjDesc + PhysicsDesc; both prefixes are 40 bytes and the descriptor starts
 * 4-aligned in both messages, so the AcString padding (relative to the message start) is unchanged.
 */
function weenieDesc(c: Codecs1999, r: Reader1999, ctx: AdapterContext): Uint8Array {
  const create = c.inbound.get(0xf745);
  if (!create) throw new Error('no 0xF745 codec to read the vendor wares\' descriptors');
  if (r.pos % 4) throw new Error(`vendor ware descriptor at unaligned offset ${r.pos}`);
  const prefix = new Writer1999().u32(0xf745).u32(0).u8(0x11).u8(0).u8(0).u8(0).u32(0).u32(0);
  for (let i = 0; i < 9; i++) prefix.u16(0);
  prefix.align4();
  const head = prefix.toBytes();
  if (head.length !== CREATE_PREFIX) throw new Error('ObjectCreate prefix length changed');
  const rest = r.data.subarray(r.pos);
  const buf = new Uint8Array(head.length + rest.length);
  buf.set(head);
  buf.set(rest, head.length);
  const sub = new Reader1999(buf, 4);
  const quiet: AdapterContext = { ...ctx, log: (m) => { if (!/unread trailing bytes/.test(m)) ctx.log(m); } };
  const [out] = create(sub, quiet, buf);
  if (!out) throw new Error('vendor ware descriptor did not translate');
  r.pos += sub.pos - CREATE_PREFIX;
  return out.subarray(CREATE_PREFIX);
}

function approachVendor(c: Codecs1999, r: Reader1999, w: BinaryWriter, ctx: AdapterContext): void {
  w.writeUInt32(r.u32()); // vendor
  w.writeUInt32(r.u32()); // item types
  w.writeInt32(r.i32()); // min value
  w.writeInt32(r.i32()); // max value
  w.writeInt32(r.i32()); // magic
  w.writeFloat32(r.f32()); // buy price
  w.writeFloat32(r.f32()); // sell price
  w.writeUInt32(0); // alternate currency: not in 1999
  w.writeUInt32(0);
  w.writeString16('');
  const n = r.u32();
  w.writeUInt32(n);
  for (let i = 0; i < n; i++) {
    const packed = r.u32();
    const item = r.u32();
    w.writeUInt32(packed);
    w.writeUInt32(item);
    if (!(packed & 0xff000000)) throw new Error(`vendor ware 0x${item.toString(16)} has no descriptor`);
    align4(w);
    w.writeBytes(weenieDesc(c, r, ctx));
  }
}

// ── Registration ──────────────────────────────────────────────────────────

/** A GameAction whose 1999 payload is end of retail's `n` dwords. */
function dwords(n: number) {
  return (m: Uint8Array): Outbound1999[] => {
    if (m.length < 12 + 4 * n) throw new RangeError(`action payload ${m.length - 12} bytes, expected ${4 * n}`);
    return [{ message: m.slice(0, 12 + 4 * n), group: Group1999.ClientAction }];
  };
}

/** A 1999 0xF7B1 action built from the EoL action's sequence and type. */
function action1999(eolMsg: Uint8Array, build: (w: Writer1999, r: BinaryReader) => void): Outbound1999[] {
  const r = new BinaryReader(eolMsg);
  r.readUInt32();
  const seq = r.readUInt32();
  const type = r.readUInt32();
  const w = new Writer1999().u32(0xf7b1).u32(seq).u32(type);
  build(w, r);
  return [{ message: w.toBytes(), group: Group1999.ClientAction }];
}

export function registerInventory1999(c: Codecs1999, opts: Inventory1999Options = {}): void {
  const flatEnv = (ctx: AdapterContext, op: number): Envelope => {
    const st = opts.player?.() ?? null;
    if (!st || !st.guid) ctx.log(`[1999] flat 0x${op.toString(16)} before the player guid was known; event guid 0`);
    return { guid: st?.guid ?? 0, sequence: st ? ++st.eventSequence : 0 };
  };

  /** Register a 1999 event both 0xF7B0-wrapped (by inner type) and flat (by opcode). */
  const both = (op: number, codec: BodyCodec) => {
    c.inbound.set(op, (r, ctx) => codec(r, flatEnv(ctx, op), ctx));
    c.inboundEvent.set(op, (r, ctx) => {
      const guid = r.u32();
      const sequence = r.u32();
      r.u32(); // inner type
      return codec(r, { guid, sequence }, ctx);
    });
  };
  /** An event whose layout is end of retail's: `n` dwords. */
  const same = (op: number, n: number) => both(op, (r, env) => [eolEvent(env, op, (w) => { for (let i = 0; i < n; i++) w.writeUInt32(r.u32()); })]);

  // ── Inbound ──
  same(0x22, 4); // InventoryPutObjInContainer
  same(0x23, 2); // WieldObject
  same(0x19a, 1); // InventoryPutObjectIn3D
  same(0x52, 1); // CloseGroundContainer
  same(0xa0, 2); // InventoryServerSaveFailed
  same(0x264, 3); // QueryItemManaResponse (u32, f32, u32: copied as bits)
  both(0x62, (r, env, ctx) => [eolEvent(env, 0x62, (w) => approachVendor(c, r, w, ctx))]);
  both(0xc9, (r, env) => [eolEvent(env, 0xc9, (w) => { w.writeUInt32(r.u32()); appraisal(r, w); })]);

  const stackSequence = new Map<number, number>();
  c.inbound.set(0x197, (r) => {
    const guid = r.u32();
    const stack = r.u32();
    const value = r.u32();
    const seq = ((stackSequence.get(guid) ?? 0) + 1) & 0xff;
    stackSequence.set(guid, seq);
    return [eol(0x197, (w) => { w.writeUInt8(seq); w.writeUInt32(guid); w.writeUInt32(stack); w.writeUInt32(value); })];
  });
  c.inbound.set(0x24, (r) => [eol(0x24, (w) => w.writeUInt32(r.u32()))]);

  // ── Outbound ──
  const out = (type: number, codec: (m: Uint8Array, ctx: AdapterContext) => Outbound1999[] | null) => c.outboundAction.set(type, codec);
  out(0x19, dwords(3)); // PutItemInContainer
  out(0x1a, dwords(2)); // GetAndWieldItem
  out(0x1b, dwords(1)); // DropItem
  out(0x35, dwords(2)); // UseWithTarget
  out(0x54, dwords(3)); // StackableMerge
  out(0x55, dwords(4)); // StackableSplitToContainer
  out(0x56, dwords(2)); // StackableSplitTo3D
  out(0x19b, dwords(3)); // StackableSplitToWield
  out(0xcd, dwords(3)); // GiveObjectRequest
  out(0x195, dwords(1)); // NoLongerViewingContents
  out(0x263, dwords(1)); // QueryItemMana

  for (const type of [0x5f, 0x60]) {
    out(type, (m, ctx) => action1999(m, (w, r) => {
      w.u32(r.readUInt32()); // vendor
      const n = r.readUInt32();
      w.u32(n);
      for (let i = 0; i < n; i++) {
        const amount = r.readInt32();
        const item = r.readUInt32();
        if (amount < 0 || amount > 0x7fffff) ctx.log(`[1999] ${type === 0x5f ? 'Buy' : 'Sell'} amount ${amount} doesn't fit 1999's 24 bits; masked`);
        w.u32(amount & 0xffffff).u32(item);
      }
    }));
  }

  out(0xbf, (m) => action1999(m, (w, r) => { w.u32(r.readUInt32()); w.acString(r.readString16()); }));
}
