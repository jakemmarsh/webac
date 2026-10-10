/** Game type enums from ACE.Entity.Enum — creature types, item types, equipment masks */

/**
 * CreatureType — anchored against reference/ACE/Source/ACE.Entity/Enum/CreatureType.cs.
 *
 * Numeric IDs MUST match ACE exactly because the server sends these on the wire
 * in PropertyInt.CreatureType / IdentifyResponse / encounter spawn messages. The
 * previous local enum was missing Rockslide (43) plus 20+ later additions, so
 * every CreatureType ≥ 43 was off by 1+ (Grievver was 43 here vs 44 in ACE, etc.).
 */
export enum CreatureType {
  Invalid = 0,
  Olthoi = 1,
  Banderling = 2,
  Drudge = 3,
  Mosswart = 4,
  Lugian = 5,
  Tumerok = 6,
  Mite = 7,
  Tusker = 8,
  PhyntosWasp = 9,
  Rat = 10,
  Auroch = 11,
  Cow = 12,
  Golem = 13,
  Undead = 14,
  Gromnie = 15,
  Reedshark = 16,
  Armoredillo = 17,
  Fae = 18,
  Virindi = 19,
  Wisp = 20,
  Knathtead = 21,
  Shadow = 22,
  Mattekar = 23,
  Mumiyah = 24,
  Rabbit = 25,
  Sclavus = 26,
  ShallowsShark = 27,
  Monouga = 28,
  Zefir = 29,
  Skeleton = 30,
  Human = 31,
  Shreth = 32,
  Chittick = 33,
  Moarsman = 34,
  OlthoiLarvae = 35,
  Slithis = 36,
  Deru = 37,
  FireElemental = 38,
  Snowman = 39,
  Unknown = 40,
  Bunny = 41,
  LightningElemental = 42,
  Rockslide = 43,
  Grievver = 44,
  Niffis = 45,
  Ursuin = 46,
  Crystal = 47,
  HollowMinion = 48,
  Scarecrow = 49,
  Idol = 50,
  Empyrean = 51,
  Hopeslayer = 52,
  Doll = 53,
  Marionette = 54,
  Carenzi = 55,
  Siraluun = 56,
  AunTumerok = 57,
  HeaTumerok = 58,
  Simulacrum = 59,
  AcidElemental = 60,
  FrostElemental = 61,
  Elemental = 62,
  Statue = 63,
  Wall = 64,
  AlteredHuman = 65,
  Device = 66,
  Harbinger = 67,
  DarkSarcophagus = 68,
  Chicken = 69,
  GotrokLugian = 70,
  Margul = 71,
  BleachedRabbit = 72,
  NastyRabbit = 73,
  GrimacingRabbit = 74,
  Burun = 75,
  Target = 76,
  Ghost = 77,
  Fiun = 78,
  Eater = 79,
  Penguin = 80,
  Ruschk = 81,
  Thrungus = 82,
  ViamontianKnight = 83,
  Remoran = 84,
  Swarm = 85,
  Moar = 86,
  EnchantedArms = 87,
  Sleech = 88,
  Mukkir = 89,
  Merwart = 90,
  Food = 91,
  ParadoxOlthoi = 92,
  Harvest = 93,
  Energy = 94,
  Apparition = 95,
  Aerbax = 96,
  Touched = 97,
  BlightedMoarsman = 98,
  GearKnight = 99,
  Gurog = 100,
  Anekshay = 101,
}

/**
 * Display label for a CreatureType, mirroring ACE's
 * `SkillExtensions.AddSpaces` / `CreatureType.ToString` convention —
 * space-insertion before each interior capital, matching the AC client's
 * canonical retail wording. e.g. `OlthoiLarvae` → "Olthoi Larvae",
 * `EnchantedArms` → "Enchanted Arms", `GearKnight` → "Gear Knight".
 *
 * Anchored to `reference/ACE/Source/ACE.Entity/Enum/CreatureType.cs`.
 *
 * Used by the appraisal panel's Slayer + WieldRequirement-CreatureType
 * rows (FAITHFUL.307) and by anyone else that needs a player-facing
 * CreatureType name without bringing in the full enum names map.
 *
 * Returns `null` for unknown IDs so callers can chain a `??` fallback
 * (e.g. `CreatureType #N`) without rendering a misleading empty string.
 */
export function creatureTypeName(id: number): string | null {
  const name = CreatureType[id];
  if (!name || name === 'Invalid') return null;
  return name.replace(/([A-Z][a-z])/g, ' $1').trim();
}

export enum ItemType {
  None = 0x00000000,
  MeleeWeapon = 0x00000001,
  Armor = 0x00000002,
  Clothing = 0x00000004,
  Jewelry = 0x00000008,
  Creature = 0x00000010,
  Food = 0x00000020,
  Money = 0x00000040,
  Misc = 0x00000080,
  MissileWeapon = 0x00000100,
  Container = 0x00000200,
  Useless = 0x00000400,
  Gem = 0x00000800,
  SpellComponents = 0x00001000,
  Writable = 0x00002000,
  Key = 0x00004000,
  Caster = 0x00008000,
  Portal = 0x00010000,
  Lockable = 0x00020000,
  PromissoryNote = 0x00040000,
  ManaStone = 0x00080000,
  Service = 0x00100000,
  MagicWieldable = 0x00200000,
  CraftCookingBase = 0x00400000,
  CraftAlchemyBase = 0x00800000,
  CraftFletchingBase = 0x02000000,
  CraftAlchemyIntermediate = 0x04000000,
  CraftFletchingIntermediate = 0x08000000,
  LifeStone = 0x10000000,
  TinkeringTool = 0x20000000,
  TinkeringMaterial = 0x40000000,
  // ACE.Entity.Enum.ItemType.cs has Gameboard as the high bit. JS bit-and against
  // 0x80000000 returns a negative int because of 32-bit signed coercion; consumers
  // should treat it as an unsigned flag (`(itemType >>> 0) & ItemType.Gameboard`).
  Gameboard = 0x80000000,
}

export enum EquipMask {
  None = 0x00000000,
  HeadWear = 0x00000001,
  ChestWear = 0x00000002,
  AbdomenWear = 0x00000004,
  UpperArmWear = 0x00000008,
  LowerArmWear = 0x00000010,
  HandWear = 0x00000020,
  UpperLegWear = 0x00000040,
  LowerLegWear = 0x00000080,
  FootWear = 0x00000100,
  ChestArmor = 0x00000200,
  AbdomenArmor = 0x00000400,
  UpperArmArmor = 0x00000800,
  LowerArmArmor = 0x00001000,
  UpperLegArmor = 0x00002000,
  LowerLegArmor = 0x00004000,
  NeckWear = 0x00008000,
  WristWearLeft = 0x00010000,
  WristWearRight = 0x00020000,
  FingerWearLeft = 0x00040000,
  FingerWearRight = 0x00080000,
  MeleeWeapon = 0x00100000,
  Shield = 0x00200000,
  MissileWeapon = 0x00400000,
  MissileAmmo = 0x00800000,
  Held = 0x01000000,
  TwoHanded = 0x02000000,
  TrinketOne = 0x04000000,
  Cloak = 0x08000000,
  SigilOne = 0x10000000,
  SigilTwo = 0x20000000,
  SigilThree = 0x40000000,
  // FAITHFUL.67 — composite flags from ACE EquipMask.cs that were missing.
  // Clothing = 0x80000000 | HeadWear..FootWear, used by `is clothing?` checks
  // when the server emits a composite EquipMask. All = 0x7FFFFFFF spans all
  // 31 real slot bits; CanGoInReadySlot is an alias for All per ACE.
  Clothing = 0x800001FF,
  All = 0x7FFFFFFF,
  CanGoInReadySlot = 0x7FFFFFFF,
}

/**
 * Confirmation types — server-initiated modal-dialog kinds.
 * Anchored against reference/ACE/Source/ACE.Entity/Enum/ConfirmationType.cs.
 * Used both inbound (in GameEventConfirmationRequest payload) and outbound
 * (in GameActionConfirmationResponse payload).
 */
export enum ConfirmationType {
  Undefined = 0x00,
  SwearAllegiance = 0x01,
  AlterSkill = 0x02,
  AlterAttribute = 0x03,
  Fellowship = 0x04,
  CraftInteraction = 0x05,
  Augmentation = 0x06,
  Yes_No = 0x07,
}

export enum DamageType {
  Undef = 0x0000,
  Slash = 0x0001,
  Pierce = 0x0002,
  Bludgeon = 0x0004,
  Cold = 0x0008,
  Fire = 0x0010,
  Acid = 0x0020,
  Electric = 0x0040,
  Health = 0x0080,
  Stamina = 0x0100,
  Mana = 0x0200,
  Nether = 0x0400,
  Base = 0x10000000,
}

/**
 * Bitmask of all physical (non-elemental, non-vital-drain) damage types:
 * Slash | Pierce | Bludgeon. Used for routing hit sounds (metallic vs
 * elemental clang/sizzle) and for material-resistance branching.
 */
export const DAMAGE_TYPE_PHYSICAL_MASK =
  DamageType.Slash | DamageType.Pierce | DamageType.Bludgeon;

/** True if any physical damage bit is set on the given damageType bitfield. */
export function isPhysicalDamage(damageType: number): boolean {
  return (damageType & DAMAGE_TYPE_PHYSICAL_MASK) !== 0;
}

/**
 * RadarColor — anchored against reference/ACE/Source/ACE.Entity/Enum/RadarColor.cs.
 *
 * Stored as uint8 on PropertyDataId.RadarBlipColor and rides on every CreateObject
 * for any radar-tracked entity (creatures, NPCs, vendors, portals, lifestones,
 * fellowship members, hostiles). Drives the radar dot color in the minimap.
 *
 * NOTE: 0x10 (BrightGreen) was previously missing — without it, fellowship-member
 * dots fell through to the default color. The 12 alias entries (Admin, Advocate,
 * Creature, …) mirror ACE source verbatim so callers can use semantic names.
 */
export enum RadarColor {
  Default = 0x00,
  Blue = 0x01,
  Gold = 0x02,
  White = 0x03,
  Purple = 0x04,
  Red = 0x05,
  Pink = 0x06,
  Green = 0x07,
  Yellow = 0x08,
  Cyan = 0x09,
  BrightGreen = 0x10,
  // Aliases — same numeric values, semantic names per ACE source.
  Admin = Cyan,
  Advocate = Pink,
  Creature = Gold,
  LifeStone = Blue,
  NPC = Yellow,
  PlayerKiller = Red,
  Portal = Purple,
  Sentinel = Cyan,
  Vendor = Yellow,
  Fellowship = BrightGreen,
  FellowshipLeader = BrightGreen,
  PKLite = Pink,
}

/**
 * Authoritative WeenieClassName.coinstack id (pyreal gold currency).
 *
 * Source: reference/ACE/Source/ACE.Server/Factories/Enum/WeenieClassName.cs:253
 *   `coinstack = 273`
 * Used as ACE's canonical coin-stack constant — see
 * `Player_Commerce.cs:54` (`coinStackWcid = (uint)WeenieClassName.W_COINSTACK_CLASS`)
 * and `Player_Death.cs:495,515` (death-drop coin filtering).
 *
 * Defined here so consumer code (inventory pyreal-total display, vendor
 * commerce paths) can name the currency rather than carry the wcid as a
 * magic literal.
 */
export const COINSTACK_WCID = 273;
