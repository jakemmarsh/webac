/**
 * PlayerDescriptionParser — parses GameEvent 0x0013 (PlayerDescription).
 *
 * Extracts attributes, vitals, level, XP, skills, and other character data
 * from the full character dump sent by the ACE server at login.
 *
 * Binary format reference: ACE GameEventPlayerDescription.cs
 */

import { BinaryReader, parseEnchantmentFromReader, EnchantmentData, parseGameplayOptions, GameplayOptionsData } from '@ac/network';
import { DescriptionPropertyFlag, DescriptionVectorFlag, AttributeCache, PropertyInt, PropertyInt64, PropertyString } from '@ac/shared';

const PF_INT32       = DescriptionPropertyFlag.PropertyInt32;
const PF_BOOL        = DescriptionPropertyFlag.PropertyBool;
const PF_DOUBLE      = DescriptionPropertyFlag.PropertyDouble;
const PF_DATA_ID     = DescriptionPropertyFlag.PropertyDid;
const PF_STRING      = DescriptionPropertyFlag.PropertyString;
const PF_POSITION    = DescriptionPropertyFlag.Position;
const PF_INSTANCE_ID = DescriptionPropertyFlag.PropertyIid;
const PF_INT64       = DescriptionPropertyFlag.PropertyInt64;

const VF_ATTRIBUTE   = DescriptionVectorFlag.Attribute;
const VF_SKILL       = DescriptionVectorFlag.Skill;
const VF_SPELL       = DescriptionVectorFlag.Spell;
const VF_ENCHANTMENT = DescriptionVectorFlag.Enchantment;

// Serialization order for the attribute-cache block in PlayerDescription
// matches the bit order of AttributeCache (Strength..Mana).
const AC_STRENGTH     = AttributeCache.Strength;
const AC_ENDURANCE    = AttributeCache.Endurance;
const AC_QUICKNESS    = AttributeCache.Quickness;
const AC_COORDINATION = AttributeCache.Coordination;
const AC_FOCUS        = AttributeCache.Focus;
const AC_SELF         = AttributeCache.Self;
const AC_HEALTH       = AttributeCache.Health;
const AC_STAMINA      = AttributeCache.Stamina;
const AC_MANA         = AttributeCache.Mana;

// ─── Result types ───────────────────────────────────────────────

/**
 * Position as serialized in PlayerDescription: 4 bytes landblock id +
 * 3 floats xyz + 4 floats quaternion (w,x,y,z) = 32 bytes.
 *
 * Identical wire format to PrivateUpdatePositionData.
 */
export interface PositionData {
  landblockId: number;
  x: number;
  y: number;
  z: number;
  qw: number;
  qx: number;
  qy: number;
  qz: number;
}

export interface AttributeData {
  ranks: number;       // levelFromCP (points raised via XP)
  startingValue: number; // innate creation value
  cpSpent: number;     // XP spent
}

export interface VitalData {
  ranks: number;       // points raised on max vital
  startingValue: number;
  cpSpent: number;
  current: number;     // current vital value
}

export interface SkillData {
  skillId: number;
  ranks: number;
  advancementClass: number; // 0=untrained, 1=trained, 2=specialized
  cpSpent: number;
  initLevel: number;   // creation bonus
}

export interface PlayerDescriptionResult {
  // Properties
  propertiesInt: Map<number, number>;
  propertiesInt64: Map<number, bigint>;
  propertiesBool: Map<number, boolean>;
  propertiesFloat: Map<number, number>;
  propertiesString: Map<number, string>;
  propertiesDataId: Map<number, number>;
  propertiesInstanceId: Map<number, number>;
  /**
   * Server-tracked positions: lifestone bind, portal ties, last portal,
   * sanctuary, etc. — keyed by PositionType.
   * Source: reference/ACE/Source/ACE.Entity/Enum/Properties/PositionType.cs
   */
  positions: Map<number, PositionData>;

  // Attributes (keyed by AC attribute order)
  strength: AttributeData | null;
  endurance: AttributeData | null;
  quickness: AttributeData | null;
  coordination: AttributeData | null;
  focus: AttributeData | null;
  self: AttributeData | null;

  // Vitals
  health: VitalData | null;
  stamina: VitalData | null;
  mana: VitalData | null;

  // Skills
  skills: SkillData[];

  // Spells (known spell IDs from login)
  spellIds: number[];
  /** A 1999 world's per-spell Charge (the spellbook entry's f32 when below ACE's 2.0); empty elsewhere. */
  spellCharges1999: Map<number, number>;

  /**
   * BUG.enchantment-registry-login-dropped — the player's full active-
   * enchantment registry as shipped in the login PlayerDescription (ACE
   * `GameEventPlayerDescription.cs:337-338` → `EnchantmentManager.SendRegistry`,
   * whose only call site is login — this is NOT redundant with the live
   * MagicUpdateEnchantment/MagicUpdateMultipleEnchantments broadcasts, which
   * only fire on later changes). Contains every Multiplicative/Additive/
   * Cooldown/Vitae entry, vitae included. Empty when the character has no
   * active enchantments (VF_ENCHANTMENT unset).
   */
  enchantments: EnchantmentData[];

  /**
   * BUG.enchantment-registry-login-dropped — convenience direct reference to
   * the single Vitae enchantment within `enchantments` (also present there),
   * or null if the character has no outstanding vitae penalty. Per ACE
   * `EnchantmentRegistry.Write` the Vitae category is a lone Enchantment with
   * no count prefix — see `EnchantmentMask.Vitae` in
   * `reference/ACE/Source/ACE.Server/Network/Structure/EnchantmentRegistry.cs`.
   */
  vitae: EnchantmentData | null;

  /**
   * FAITHFUL.569 — 8 spell-bar pages × N spell IDs each, sourced from
   * the SpellLists8 section of PlayerDescription (per ACE
   * `GameEventPlayerDescription.cs:364-378`). Each inner array contains
   * the spell IDs persisted via HandleActionAddSpellFavorite /
   * HandleActionRemoveSpellFavorite (Player_Character.cs:295-314). Used
   * by main.ts to call gameUI.setSpellData(spells, spellBars) so the
   * quickbar restores across logout. Always an array of length 8;
   * each inner array is empty if the page has no assigned spells or
   * the server didn't ship SpellLists8 (i.e. optionFlags bit unset).
   */
  spellBars: number[][];

  /**
   * BUG.shortcut-bar-restore-dropped — the player's toolbar item-shortcut
   * bar assignments, restored from `CharacterPropertiesShortcutBar` per ACE
   * `GameEventPlayerDescription.cs:345-362` / `Shortcut.cs:44-56`. Each
   * entry is `Index` (bar slot 0-8) + `ObjectId` (the assigned item's
   * guid) + a `LayeredSpell` (`SpellId`/`Layer` — ACE marks the field
   * "unused?" on the `Shortcut` class itself but still writes it on the
   * wire, so we still parse it for byte-alignment/possible future use).
   * Pre-fix the parser read the count then blindly skipped
   * `shortcutCount * 12` bytes, discarding every entry. Empty when the
   * player has no assigned toolbar shortcuts or the server didn't set
   * `CharacterOptionDataFlag.Shortcut`.
   */
  shortcuts: Array<{ index: number; objectId: number; spellId: number; layer: number }>;

  /**
   * FAITHFUL.570 — server-persisted CharacterOptions1 + CharacterOptions2
   * bitfields per ACE `GameEventPlayerDescription.cs:359,387` (CO1 is
   * UNCONDITIONAL; CO2 is gated on `CharacterOptionDataFlag.CharacterOptions2
   * = 0x40` but ACE always sets that bit at line 341 so CO2 is effectively
   * always present too).
   *
   * The SAVE side (.372) ships `SetSingleCharacterOption` to ACE and the
   * server persists into the `Character` row's CharacterOptions1/2 columns.
   * The LOAD side was missing pre-.570: PlayerDescriptionParser dropped
   * the values silently and the client's `optionsSettings` reset to its
   * built-in defaults every login, ignoring whatever the player set last
   * session. Per-option boolean decode lives in `@ac/shared`'s
   * `characterOptionIsSet(option, co1, co2)` against
   * `CHARACTER_OPTION_BIT_MAP`.
   *
   * Sentinel -1 means "not received from this PlayerDescription" — used
   * by the consumer to skip restore when an older-format payload arrives
   * (e.g. during a CharacterEnterWorldServerReady race) instead of
   * blindly wiping every option to the default-false state.
   */
  characterOptions1: number;
  characterOptions2: number;

  /**
   * FAITHFUL.570 — SpellbookFilters per ACE `GameEventPlayerDescription.cs
   * :384`. UNCONDITIONAL write even though there's a flag bit for it (the
   * `if (optionFlags & CharacterOptionDataFlag.SpellbookFilters)` line is
   * commented out — Writer.Write fires every login). The spellbook panel
   * filter checkboxes (school + level) round-trip via GameActionSpellbook
   * Filter; restoring this lets the panel render the user's last filter
   * selection on first open after login.
   */
  spellbookFilters: number;

  /**
   * VISUAL.134 — the player's "fill components" (desired-comps) rebuy book:
   * component wcid → quantityToRebuy. ACE serializes it as a PackableHashTable
   * (GameEventPlayerDescription.cs:381 Writer.WriteOld(fillComps); each entry =
   * SpellComponentId u32 + QuantityToRebuy u32, per PackableHashTable.cs:28-32).
   * Drives the components-panel rebuy count (VISUAL.56). Empty when none set.
   */
  desiredComps: Map<number, number>;

  /**
   * FAITHFUL.572 — server-persisted INVENTORY PLACEMENT ORDER per ACE
   * `GameEventPlayerDescription.cs:401-416`. ACE writes the player's full
   * inventory as `(uint count)` + N × `(uint guid + uint ContainerType)`,
   * ordered by `PlacementPosition` (the slot index the user dragged the
   * item to). Non-containers/foci come first, then containers + foci in
   * the side slots.
   *
   * Pre-FAITHFUL.572 the parser stopped at CharacterOptions2 and silently
   * dropped this section, so the client inventory grid showed items in
   * ObjectCreate arrival order instead of the user's saved layout. This
   * meant rearranging your pack after a logout/login was lost — a visible
   * UX regression vs retail AC (which preserved slot positions).
   *
   * Stored as an ordered array (not a Map) because the SEQUENCE is the
   * authoritative bit — slot 0 is the first entry, slot 1 the second, etc.
   * ContainerType is 0=NonContainer / 1=Container / 2=Foci per
   * `reference/ACE/Source/ACE.Entity/Enum/ContainerType.cs`. Empty when
   * the GameplayOptions block couldn't be skipped cleanly (e.g.
   * unrecognized PackObjPropertyCollection key).
   */
  inventoryPlacement: Array<{ guid: number; containerType: number }>;

  /**
   * FAITHFUL.572 — server-persisted EQUIPPED-ITEM list per ACE
   * `GameEventPlayerDescription.cs:418-424`. Ships `(uint count)` + N ×
   * `(uint guid + uint CurrentWieldedLocation + uint ClothingPriority)`.
   * Iteration order is `EquippedObjects.Values` which is Dictionary
   * insertion order on the server side — not load-bearing, but we
   * preserve it for parity. ClothingPriority drives the layer-blend
   * order on the player paperdoll (cloak under armor, etc.).
   */
  equippedPlacement: Array<{ guid: number; wieldedLocation: number; clothingPriority: number }>;

  /**
   * CORE.3.f — parsed GameplayOptions blob (the PackObjPropertyCollection
   * ACE echoes verbatim from `Character.GameplayOptions` when
   * `CharacterOptionDataFlag.GameplayOptions` is set): chat-window
   * placement/visibility/filter/title per window id + the two chat
   * opacities. Wire format + decompiled-client anchors in
   * `@ac/network` PlayerModuleOptions.ts. `null` when the server sent no
   * blob OR the blob had an unrecognized property key (in which case
   * the placement blocks after it are unreadable too — same abort
   * semantics as the FAITHFUL.572 skip-only walk this replaced).
   */
  gameplayOptions: GameplayOptionsData | null;

  // Convenience getters from properties
  level: number;
  totalExperience: bigint;
  availableExperience: bigint;
  name: string;
}

function readAttribute(r: BinaryReader): AttributeData {
  const ranks = r.readUInt32();
  const startingValue = r.readUInt32();
  const cpSpent = r.readUInt32();
  return { ranks, startingValue, cpSpent };
}

function readVital(r: BinaryReader): VitalData {
  const ranks = r.readUInt32();
  const startingValue = r.readUInt32();
  const cpSpent = r.readUInt32();
  const current = r.readUInt32();
  return { ranks, startingValue, cpSpent, current };
}

function readHashTableHeader(r: BinaryReader): { count: number; buckets: number } {
  const count = r.readUInt16();
  const buckets = r.readUInt16();
  return { count, buckets };
}

export function parsePlayerDescription(payload: Uint8Array): PlayerDescriptionResult | null {
  const r = new BinaryReader(payload);
  const result: PlayerDescriptionResult = {
      propertiesInt: new Map(),
      propertiesInt64: new Map(),
      propertiesBool: new Map(),
      propertiesFloat: new Map(),
      propertiesString: new Map(),
      propertiesDataId: new Map(),
      propertiesInstanceId: new Map(),
      positions: new Map(),
      strength: null, endurance: null, quickness: null,
      coordination: null, focus: null, self: null,
      health: null, stamina: null, mana: null,
      skills: [],
      spellIds: [],
      spellCharges1999: new Map(),
      enchantments: [],
      vitae: null,
      spellBars: [[], [], [], [], [], [], [], []],
      shortcuts: [],
      characterOptions1: -1,
      characterOptions2: -1,
      desiredComps: new Map<number, number>(),
      spellbookFilters: -1,
      inventoryPlacement: [],
      equippedPlacement: [],
      gameplayOptions: null,
      level: 1,
      totalExperience: 0n,
      availableExperience: 0n,
      name: '',
    };

  try {
    // ── Property flags + weenie type ──
    const propertyFlags = r.readUInt32();
    const _weenieType = r.readUInt32();

    // ── Property hash tables — ACE writes in THIS order (from GameEventPlayerDescription.cs) ──
    // 1. Int32(0x01), 2. Int64(0x80), 3. Bool(0x02), 4. Double(0x04),
    // 5. String(0x10), 6. DataId(0x08), 7. InstanceId(0x40), 8. Position(0x20)
    // NOTE: This does NOT match the flag bit order! ACE writes Int64 second, not last.

    if (propertyFlags & PF_INT32) {
      const { count } = readHashTableHeader(r);
      for (let i = 0; i < count; i++) {
        const key = r.readUInt32();
        const value = r.readInt32();
        result.propertiesInt.set(key, value);
      }
    }

    if (propertyFlags & PF_INT64) {
      const { count } = readHashTableHeader(r);
      for (let i = 0; i < count; i++) {
        const key = r.readUInt32();
        result.propertiesInt64.set(key, r.readInt64());
      }
    }

    if (propertyFlags & PF_BOOL) {
      const { count } = readHashTableHeader(r);
      for (let i = 0; i < count; i++) {
        const key = r.readUInt32();
        const value = r.readUInt32() !== 0;
        result.propertiesBool.set(key, value);
      }
    }

    if (propertyFlags & PF_DOUBLE) {
      const { count } = readHashTableHeader(r);
      for (let i = 0; i < count; i++) {
        const key = r.readUInt32();
        const value = r.readFloat64();
        result.propertiesFloat.set(key, value);
      }
    }

    if (propertyFlags & PF_STRING) {
      const { count } = readHashTableHeader(r);
      for (let i = 0; i < count; i++) {
        const key = r.readUInt32();
        const value = r.readString16();
        result.propertiesString.set(key, value);
      }
    }

    if (propertyFlags & PF_DATA_ID) {
      const { count } = readHashTableHeader(r);
      for (let i = 0; i < count; i++) {
        const key = r.readUInt32();
        const value = r.readUInt32();
        result.propertiesDataId.set(key, value);
      }
    }

    if (propertyFlags & PF_INSTANCE_ID) {
      const { count } = readHashTableHeader(r);
      for (let i = 0; i < count; i++) {
        const key = r.readUInt32();
        const value = r.readUInt32();
        result.propertiesInstanceId.set(key, value);
      }
    }

    if (propertyFlags & PF_POSITION) {
      // FAITHFUL.224 — pre-fix this block read the position type then
      // skip()'d the 32-byte position payload. Server's authoritative
      // bind locations (LinkedLifestone, LinkedPortalOne/Two, LastPortal,
      // Sanctuary, etc.) sent at login were silently dropped, so the
      // client's recall systems fell back to local defaults that didn't
      // match server state. Now stored on result.positions keyed by
      // PositionType for the main.ts login handler to consume.
      const { count } = readHashTableHeader(r);
      for (let i = 0; i < count; i++) {
        const positionType = r.readUInt32();
        const landblockId = r.readUInt32();
        const x = r.readFloat32();
        const y = r.readFloat32();
        const z = r.readFloat32();
        const qw = r.readFloat32();
        const qx = r.readFloat32();
        const qy = r.readFloat32();
        const qz = r.readFloat32();
        result.positions.set(positionType, { landblockId, x, y, z, qw, qx, qy, qz });
      }
    }

    // ── Vector flags ──
    const vectorFlags = r.readUInt32();
    const _hasHealth = r.readUInt32();

    // ── Attributes + Vitals ──
    if (vectorFlags & VF_ATTRIBUTE) {
      const attrFlags = r.readUInt32();

      if (attrFlags & AC_STRENGTH) result.strength = readAttribute(r);
      if (attrFlags & AC_ENDURANCE) result.endurance = readAttribute(r);
      if (attrFlags & AC_QUICKNESS) result.quickness = readAttribute(r);
      if (attrFlags & AC_COORDINATION) result.coordination = readAttribute(r);
      if (attrFlags & AC_FOCUS) result.focus = readAttribute(r);
      if (attrFlags & AC_SELF) result.self = readAttribute(r);
      if (attrFlags & AC_HEALTH) result.health = readVital(r);
      if (attrFlags & AC_STAMINA) result.stamina = readVital(r);
      if (attrFlags & AC_MANA) result.mana = readVital(r);
    }

    // ── Skills ──
    if (vectorFlags & VF_SKILL) {
      const { count } = readHashTableHeader(r);
      for (let i = 0; i < count; i++) {
        const skillId = r.readUInt32();
        const ranks = r.readUInt16(); // ushort in ACE (CreatureSkill.Ranks)
        r.readUInt16(); // always 1
        const advancementClass = r.readUInt32();
        const cpSpent = r.readUInt32();
        const initLevel = r.readUInt32();
        r.readUInt32(); // resistance of last check (always 0)
        r.readFloat64(); // last time used (always 0.0)
        result.skills.push({ skillId, ranks, advancementClass, cpSpent, initLevel });
      }
    }

    // ── Spells ──
    // ACE sends all known spells in PlayerDescription as a PackableHashTable:
    // count(u16) + buckets(u16) + [spellId(i32) + configValue(f32)] per spell
    if (vectorFlags & VF_SPELL) {
      const { count } = readHashTableHeader(r);
      for (let i = 0; i < count; i++) {
        const spellId = r.readInt32();
        // ACE's configValue, always 2.0. Below 2.0 it is a 1999 world's spell Charge
        // (SpellBookPage +0x4; the 1999 adapter writes it there): VISUAL.ac1999-spell-charge.
        const value = r.readFloat32();
        if (value < 2.0) result.spellCharges1999.set(spellId, value);
        result.spellIds.push(spellId);
      }
    }

    // ── Enchantments (BUG.enchantment-registry-login-dropped) ──
    // ACE GameEventPlayerDescription.cs:337-338 writes:
    //   `if (VF_ENCHANTMENT) { EnchantmentManager.SendRegistry(writer); }`
    // EnchantmentRegistry.Write (Network/Structure/EnchantmentRegistry.cs:9-22):
    //   u32 enchantmentMask
    //   if (Multiplicative): u32 count + N × Enchantment
    //   if (Additive):       u32 count + N × Enchantment
    //   if (Cooldown):       u32 count + N × Enchantment
    //   if (Vitae):          single Enchantment (no count prefix)
    // SendRegistry's only call site is login (EnchantmentManager.cs:1433-1438)
    // — this is NOT redundant with the live MagicUpdateEnchantment/
    // MagicUpdateMultipleEnchantments broadcasts, which only fire on later
    // changes. Reuses the same parseEnchantmentFromReader as the
    // MagicUpdateMultipleEnchantments (bulk) path for parity (@ac/network).
    //
    // FAITHFUL.569 — pre-fix the parser RETURNED right after Spells,
    // silently dropping every field after it including SpellLists8.
    if (vectorFlags & VF_ENCHANTMENT) {
      const enchantmentMask = r.readUInt32();
      // FAITHFUL.603 — mask values per ACE EnchantmentCategory.cs:
      //   Multiplicative=0x1, Additive=0x2, Vitae=0x4, Cooldown=0x8.
      // Pre-fix this had Cooldown=0x04 and Vitae=0x10 (invented values).
      // Consequence: for ANY character with vitae (= any character that has
      // ever died), mask bit 0x4 was treated as a cooldown LIST — the
      // count-less single vitae Enchantment's leading SpellID u16 (666)
      // was consumed as a u32 count, the parser walked 666 phantom
      // 60-byte enchantments off the end of the buffer, and the catch
      // block returned partial results: CO1/CO2/spell bars/spellbook
      // filters/inventory placement ALL silently reset to sentinels every
      // login. FAITHFUL.569/570/572's restores were dead on arrival for
      // every once-dead character. Found live during FAITHFUL.594
      // verification (parse abort at 30660 of 30620 bytes).
      const ENCH_MULTIPLICATIVE = 0x01;
      const ENCH_ADDITIVE       = 0x02;
      const ENCH_VITAE          = 0x04;
      const ENCH_COOLDOWN       = 0x08;
      const readEnchantmentList = (): void => {
        const n = r.readUInt32();
        for (let i = 0; i < n; i++) {
          result.enchantments.push(parseEnchantmentFromReader(r));
        }
      };
      if (enchantmentMask & ENCH_MULTIPLICATIVE) readEnchantmentList();
      if (enchantmentMask & ENCH_ADDITIVE) readEnchantmentList();
      if (enchantmentMask & ENCH_COOLDOWN) readEnchantmentList();
      if (enchantmentMask & ENCH_VITAE) {
        const vitae = parseEnchantmentFromReader(r);
        result.vitae = vitae;
        result.enchantments.push(vitae);
      }
    }

    // ── Character option flags + CharacterOptions1 ──
    // ACE GameEventPlayerDescription.cs:341-359:
    //   uint optionFlags        // CharacterOptionDataFlag bitfield
    //   uint CharacterOptions1  // the actual option bitmask (toggles)
    const CHAR_OPT_SHORTCUT          = 0x00000001;
    const CHAR_OPT_DESIRED_COMPS     = 0x00000008;
    const CHAR_OPT_CHARACTER_OPT2    = 0x00000040;
    const CHAR_OPT_GAMEPLAY_OPTIONS  = 0x00000200;
    const CHAR_OPT_SPELL_LISTS_8     = 0x00000400;
    const optionFlags = r.readUInt32();
    // FAITHFUL.570 — CO1 is UNCONDITIONAL in ACE (line 359). Surface it
    // so main.ts can call gameUI.restoreCharacterOptions(co1, co2) and
    // restore the user's last-session toggles instead of falling back
    // to the client's DEFAULTS dict.
    result.characterOptions1 = r.readUInt32();

    // ── Shortcuts (conditional on Shortcut bit, per Player_Description.cs:361-362) ──
    // ACE Shortcut.cs:51-56 writes: u32 count + N × Shortcut (12 bytes each:
    //   Index u32 + ObjectId u32 + Spell{SpellId u16 + Layer u16}).
    // BUG.shortcut-bar-restore-dropped — pre-fix this blindly skipped
    // shortcutCount*12 bytes to stay aligned; every entry's Index/ObjectId/
    // SpellId/Layer is now captured into result.shortcuts.
    if (optionFlags & CHAR_OPT_SHORTCUT) {
      const shortcutCount = r.readUInt32();
      for (let i = 0; i < shortcutCount; i++) {
        const index = r.readUInt32();
        const objectId = r.readUInt32();
        const spellId = r.readUInt16();
        const layer = r.readUInt16();
        result.shortcuts.push({ index, objectId, spellId, layer });
      }
    }

    // ── SpellLists8 (8 spell-bar pages) — the field this whole extension exists for ──
    // ACE GameEventPlayerDescription.cs:364-378: if SpellLists8 bit set,
    // writes 8 lists of (count u32 + N × spellId u32). Otherwise writes a
    // single u32 0u as filler so downstream parsers can still advance.
    if (optionFlags & CHAR_OPT_SPELL_LISTS_8) {
      for (let bar = 0; bar < 8; bar++) {
        const count = r.readUInt32();
        const bars = result.spellBars[bar];
        for (let i = 0; i < count; i++) {
          bars.push(r.readUInt32());
        }
      }
    } else {
      r.readUInt32(); // single 0u placeholder per ACE source line 377
    }

    // ── FAITHFUL.570 — DesiredComps + SpellbookFilters + CharacterOptions2 ──
    // ACE GameEventPlayerDescription.cs:380-387 writes (in this exact order):
    //   if DesiredComps bit set:
    //     PackableHashTable.WriteHeader(count u16, numBuckets u16=256)
    //     + N × (SpellComponentId u32 + QuantityToRebuy u32)
    //   SpellbookFilters u32 — UNCONDITIONAL (line 384's `if` is commented out)
    //   if CharacterOptions2 bit set: CharacterOptions2 u32
    //     (note: ACE always sets this bit on line 341 so it's effectively
    //      always sent, but we honor the bit check to stay byte-correct)
    //
    // GameplayOptions (variable-length byte[]) + inventory + equipment
    // follow, but we don't surface those here — dedicated event handlers
    // cover them and the spec-walk gets fiddly without explicit lengths.
    // Reading CO2 is enough; the cursor stops there.
    if (optionFlags & CHAR_OPT_DESIRED_COMPS) {
      // VISUAL.134 — read the fill-comps PackableHashTable entries (each is
      // SpellComponentId u32 + QuantityToRebuy u32, 8 bytes) into desiredComps
      // instead of skipping. Consumes exactly fillCount*8 bytes either way, so
      // the rest of the PlayerDescription walk stays byte-aligned.
      const fillCount = r.readUInt16();
      r.readUInt16(); // numBuckets (256)
      for (let i = 0; i < fillCount; i++) {
        const wcid = r.readUInt32();
        const qty = r.readUInt32();
        result.desiredComps.set(wcid, qty);
      }
    }
    result.spellbookFilters = r.readUInt32();
    if (optionFlags & CHAR_OPT_CHARACTER_OPT2) {
      result.characterOptions2 = r.readUInt32();
    }

    // ── FAITHFUL.572 — GameplayOptions byte[] + inventory/equipment placement ──
    // ACE GameEventPlayerDescription.cs:393-424 writes (in order):
    //   if (GameplayOptions bit set): byte[] (raw PackObjPropertyCollection — NO length prefix)
    //   uint inventoryCount + N × (uint guid + uint ContainerType)
    //   uint equippedCount  + M × (uint guid + uint CurrentWieldedLocation + uint ClothingPriority)
    //
    // The byte[] has no length header, so the only way to find the
    // inventory count is to walk PackObjPropertyCollection structurally.
    // CORE.3.f upgraded the FAITHFUL.572 skip-only walk to a real parse
    // (decomp-pinned format in @ac/network PlayerModuleOptions.ts) so the
    // chat-window options inside actually LOAD; on an unrecognized
    // OptionProperty key we still have to give up — no length prefix to
    // recover from.
    //
    // ALIGNMENT: the blob ACE stores is the tail of the retail 0x01A1
    // message, which PlayerModule::Pack @ 005d45c0 zero-pads to a 4-byte
    // boundary — so after the structural walk we must re-align exactly like
    // PlayerModule::UnPack @ 005d49d0 does before the placement blocks.
    // (The pre-CORE.3.f skip walk missed this — latent because a fresh ACE
    // DB has no blob until a client first ships one.)
    //
    // The placement order is what the user dragged items into during
    // their last session; pre-fix the inventory grid drew items in
    // ObjectCreate arrival order (a visible UX regression vs retail).
    let canReadPlacement = true;
    if (optionFlags & CHAR_OPT_GAMEPLAY_OPTIONS) {
      result.gameplayOptions = parseGameplayOptions(r);
      canReadPlacement = result.gameplayOptions !== null;
      if (canReadPlacement) r.align(4);
    }

    if (canReadPlacement) {
      const inventoryCount = r.readUInt32();
      for (let i = 0; i < inventoryCount; i++) {
        const guid = r.readUInt32();
        const containerType = r.readUInt32();
        result.inventoryPlacement.push({ guid, containerType });
      }
      const equippedCount = r.readUInt32();
      for (let i = 0; i < equippedCount; i++) {
        const guid = r.readUInt32();
        const wieldedLocation = r.readUInt32();
        const clothingPriority = r.readUInt32();
        result.equippedPlacement.push({ guid, wieldedLocation, clothingPriority });
      }
    } else {
      console.warn('[PlayerDescription] GameplayOptions blob had an unrecognized property key — placement order unread for this login');
    }

    // ── Extract convenience values from properties ──
    result.level = result.propertiesInt.get(PropertyInt.Level) ?? 1;
    result.totalExperience = result.propertiesInt64.get(PropertyInt64.TotalExperience) ?? 0n;
    result.availableExperience = result.propertiesInt64.get(PropertyInt64.AvailableExperience) ?? 0n;
    result.name = result.propertiesString.get(PropertyString.Name) ?? '';

    return result;
  } catch (e) {
    console.warn('[PlayerDescription] Parse error at position', r.position, 'of', payload.byteLength, ':', e);
    // Verification telemetry — console capture is flaky in automation, so
    // surface the abort position for post-login inspection.
    if (typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).__pdParseError = {
        position: r.position, byteLength: payload.byteLength, error: String(e),
      };
    }
    // Return partial results — properties already parsed are still valid
    result.level = result.propertiesInt.get(PropertyInt.Level) ?? 1;
    result.totalExperience = result.propertiesInt64.get(PropertyInt64.TotalExperience) ?? 0n;
    result.availableExperience = result.propertiesInt64.get(PropertyInt64.AvailableExperience) ?? 0n;
    result.name = result.propertiesString.get(PropertyString.Name) ?? '';
    return result;
  }
}
