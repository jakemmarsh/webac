/**
 * Additional ACE Entity enums ported for wire-format and tooltip-rendering use.
 *
 * Source:
 *   reference/ACE/Source/ACE.Entity/Enum/Skill.cs       — sequential, retire-aware
 *   reference/ACE/Source/ACE.Entity/Enum/Channel.cs     — Flags enum for ChatChannel
 *   reference/ACE/Source/ACE.Entity/Enum/AccessLevel.cs — sequential admin tiers
 *
 * Naming divergence: ACE's enum is called `Skill`, but our existing
 * `interface Skill` in character/SkillSystem.ts represents per-character
 * skill STATE (level, training status, xp), not the skill ID. To avoid a
 * symbol collision we name the enum `SkillId` here — value semantics
 * are identical to ACE Skill.
 */

/** SkillId — sequential, order-load-bearing per ACE Skill.cs comment:
 *  "even though these are unnumbered, order is very important. values of
 *   'none' or commented as retired or unused --ABSOLUTELY CANNOT-- be removed."
 *  C# implicit numbering starts at 0 for None and increments by 1.
 */
export enum SkillId {
  None             = 0,
  Axe              = 1,   // Retired
  Bow              = 2,   // Retired
  Crossbow         = 3,   // Retired
  Dagger           = 4,   // Retired
  Mace             = 5,   // Retired
  MeleeDefense     = 6,
  MissileDefense   = 7,
  Sling            = 8,   // Retired
  Spear            = 9,   // Retired
  Staff            = 10,  // Retired
  Sword            = 11,  // Retired
  ThrownWeapon     = 12,  // Retired
  UnarmedCombat    = 13,  // Retired
  ArcaneLore       = 14,
  MagicDefense     = 15,
  ManaConversion   = 16,
  Spellcraft       = 17,  // Unimplemented
  ItemTinkering    = 18,
  AssessPerson     = 19,
  Deception        = 20,
  Healing          = 21,
  Jump             = 22,
  Lockpick         = 23,
  Run              = 24,
  Awareness        = 25,  // Unimplemented
  ArmsAndArmorRepair = 26, // Unimplemented
  AssessCreature   = 27,
  WeaponTinkering  = 28,
  ArmorTinkering   = 29,
  MagicItemTinkering = 30,
  CreatureEnchantment = 31,
  ItemEnchantment  = 32,
  LifeMagic        = 33,
  WarMagic         = 34,
  Leadership       = 35,
  Loyalty          = 36,
  Fletching        = 37,
  Alchemy          = 38,
  Cooking          = 39,
  Salvaging        = 40,
  TwoHandedCombat  = 41,
  Gearcraft        = 42,  // Retired
  VoidMagic        = 43,
  HeavyWeapons     = 44,
  LightWeapons     = 45,
  FinesseWeapons   = 46,
  MissileWeapons   = 47,
  Shield           = 48,
  DualWield        = 49,
  Recklessness     = 50,
  SneakAttack      = 51,
  DirtyFighting    = 52,
  Challenge        = 53,  // Unimplemented
  Summoning        = 54,
}

/** Retired melee skill IDs — per SkillExtensions.RetiredMelee in Skill.cs. */
export const RETIRED_MELEE_SKILLS: ReadonlyArray<SkillId> = Object.freeze([
  SkillId.Axe,
  SkillId.Dagger,
  SkillId.Mace,
  SkillId.Spear,
  SkillId.Staff,
  SkillId.Sword,
  SkillId.UnarmedCombat,
]);

/** Retired missile skill IDs — per SkillExtensions.RetiredMissile. */
export const RETIRED_MISSILE_SKILLS: ReadonlyArray<SkillId> = Object.freeze([
  SkillId.Bow,
  SkillId.Crossbow,
  SkillId.Sling,
  SkillId.ThrownWeapon,
]);

/** Union of both retired lists — per SkillExtensions.RetiredWeapons. */
export const RETIRED_WEAPON_SKILLS: ReadonlyArray<SkillId> = Object.freeze([
  ...RETIRED_MELEE_SKILLS,
  ...RETIRED_MISSILE_SKILLS,
]);

/** Skill IDs flagged "Unimplemented" in ACE source. */
export const UNIMPLEMENTED_SKILLS: ReadonlyArray<SkillId> = Object.freeze([
  SkillId.Spellcraft,
  SkillId.Awareness,
  SkillId.ArmsAndArmorRepair,
  SkillId.Challenge,
]);

/** Display label per SkillExtensions.AddSpaces space-insertion convention. */
export function skillIdLabel(s: SkillId): string {
  const name = SkillId[s];
  if (!name) return '';
  // Insert space before capitals (preserving the first), per AC client convention.
  return name.replace(/([A-Z][a-z])/g, ' $1').trim();
}

/**
 * Channel — Flags enum for chat channels per Channel.cs.
 * Used by FAITHFUL.6/33 ChatChannel wire format. Values are the bit
 * positions the server expects in 0x147 (Group Chat) and the GameAction
 * 0x147 (ChatChannel send).
 */
export enum Channel {
  Undef                   = 0x00000000,
  Abuse                   = 0x00000001,
  Admin                   = 0x00000002,
  Audit                   = 0x00000004,
  Advocate1               = 0x00000008,
  Advocate2               = 0x00000010,
  Advocate3               = 0x00000020,
  QA1                     = 0x00000040,
  QA2                     = 0x00000080,
  Debug                   = 0x00000100,
  Sentinel                = 0x00000200,
  Help                    = 0x00000400,
  AllBroadcast            = 0x00000401,
  ValidChans              = 0x0000073F,
  Fellow                  = 0x00000800,
  Vassals                 = 0x00001000,
  Patron                  = 0x00002000,
  Monarch                 = 0x00004000,
  AlArqas                 = 0x00008000,
  Holtburg                = 0x00010000,
  Lytelthorpe             = 0x00020000,
  Nanto                   = 0x00040000,
  Rithwic                 = 0x00080000,
  Samsur                  = 0x00100000,
  Shoushi                 = 0x00200000,
  Yanshi                  = 0x00400000,
  Yaraq                   = 0x00800000,
  TownChans               = 0x00FF8000,
  CoVassals               = 0x01000000,
  AllegianceBroadcast     = 0x02000000,
  FellowBroadcast         = 0x04000000,
  SocietyCelHanBroadcast  = 0x08000000,
  SocietyEldWebBroadcast  = 0x10000000,
  SocietyRadBloBroadcast  = 0x20000000,
  Olthoi                  = 0x40000000,
  GhostChans              = 0x7F007800,
  // AllChans = 0x7F007F3F — TypeScript number range loses precision on this
  // exact bit pattern when combined with the sign-extended Olthoi flag, so
  // it's expressed as a separate const below.
}

/** AllChans — per Channel.cs final entry. Kept out of the enum to avoid the
 *  numeric-literal-edge-case TS sometimes hits with high-bit unions. */
export const CHANNEL_ALL_CHANS = 0x7F007F3F;

/**
 * TurbineChatChannel — sequential channel IDs for the Turbine chat backend
 * (0xF7DE TurbineChat opcode). Distinct from the `Channel` flags-enum above:
 *   - `Channel` is a flags bitfield used for the in-world ChatChannel (0x147)
 *     event and the @-prefixed admin channels.
 *   - `TurbineChatChannel` is a sequential plain-int ID used by the
 *     Turbine chat server backend (general/trade/LFG/roleplay/society).
 *
 * Sourced from `reference/ACE/Source/ACE.Server/Entity/TurbineChatChannel.cs`.
 * Values 1-10 are the canonical retail constants. Allegiance channel IDs are
 * DYNAMIC per-player (sent via SetTurbineChatChannels at login) — they don't
 * have a fixed numeric value, so callers should treat any unknown channel ID
 * as `Allegiance` (the default fallback).
 */
export enum TurbineChatChannel {
  Allegiance           = 1, // placeholder for the per-player allegiance ID
  General              = 2,
  Trade                = 3,
  LFG                  = 4,
  Roleplay             = 5,
  Society              = 6,
  SocietyCelestialHand = 7,
  SocietyEldrytchWeb   = 8,
  SocietyRadiantBlood  = 9,
  Olthoi               = 10,
}

/**
 * Display label for the channel-bracket prefix in the retail chat panel.
 * Pre-FAITHFUL.346 the consumer hardcoded `[General]` for every TurbineChat
 * message, mislabeling /trade /lfg /roleplay /society / Olthoi traffic.
 *
 * Channel IDs that don't match any fixed constant are treated as the
 * caller's allegiance channel (per ACE SetTurbineChatChannels.cs which
 * ships the allegiance ID as a dynamic uint distinct from the fixed 2-10
 * range).
 */
export function turbineChannelLabel(channelId: number): string {
  switch (channelId) {
    case TurbineChatChannel.General:              return 'General';
    case TurbineChatChannel.Trade:                return 'Trade';
    case TurbineChatChannel.LFG:                  return 'LFG';
    case TurbineChatChannel.Roleplay:             return 'Roleplay';
    case TurbineChatChannel.Society:              return 'Society';
    case TurbineChatChannel.SocietyCelestialHand: return 'Celestial Hand';
    case TurbineChatChannel.SocietyEldrytchWeb:   return 'Eldrytch Web';
    case TurbineChatChannel.SocietyRadiantBlood:  return 'Radiant Blood';
    case TurbineChatChannel.Olthoi:               return 'Olthoi';
    default:                                      return 'Allegiance';
  }
}

/**
 * CORE.3.c — ChatMessageType (LogTextType) for a TurbineChat channel.
 *
 * The EoL client's floaty Chat Window 4 defaults to filter 0x78000000 —
 * text types 0x1B-0x1E — and titles itself "Chat Window 4: Channels"
 * (ChatInterface::PostInit @ 004f3dd0 case 5 + string table 0x23000001
 * entry 0x997aa55), i.e. the four Turbine global channels display with
 * these otherwise-unnamed types (LogTextTypeEnumMapper::LogTextTypeToString
 * returns "Unknown" for them — they exist only for channel filtering).
 * The General→0x1B … Roleplay→0x1E order is inferred from channel-id order;
 * any permutation routes identically since all four bits belong to the same
 * default filter. Society/Olthoi and the dynamic allegiance channel predate
 * no floaty default: allegiance text uses ChatMessageType.Allegiance and
 * the rest stay ChatMessageType.Channel.
 */
export function turbineChannelMessageType(channelId: number): number {
  switch (channelId) {
    case TurbineChatChannel.General:  return 0x1b;
    case TurbineChatChannel.Trade:    return 0x1c;
    case TurbineChatChannel.LFG:      return 0x1d;
    case TurbineChatChannel.Roleplay: return 0x1e;
    // ChatRoomTracker::GetChatFormat @ 005cd7c0: the society rooms 0x20, Olthoi 0x12.
    case TurbineChatChannel.Society:
    case TurbineChatChannel.SocietyCelestialHand:
    case TurbineChatChannel.SocietyEldrytchWeb:
    case TurbineChatChannel.SocietyRadiantBlood: return 0x20;
    case TurbineChatChannel.Olthoi:   return 0x12;
    default:                          return 0x12; // ChatMessageType.Allegiance (dynamic id)
  }
}

/** AccessLevel — per AccessLevel.cs (sequential 0–5). */
export enum AccessLevel {
  Player    = 0,
  Advocate  = 1,
  Sentinel  = 2,
  Envoy     = 3,
  Developer = 4,
  Admin     = 5,
}

export function accessLevelLabel(a: AccessLevel): string {
  return AccessLevel[a] ?? '';
}

/**
 * CharacterOptions1 — Flags enum used in PlayerDescription (inbound) and
 * SetCharacterOptions (outbound 0x01A1). Per CharacterOptions1.cs.
 *
 * 32 bits including 6 NotUsedN reserved slots. These gate gameplay-visible
 * HUD/control behavior (AutoTarget, AutoRepeatAttack, ToggleRun, etc.) so
 * a faithful client must honor the exact bit positions.
 */
export enum CharacterOptions1 {
  NotUsed1                            = 0x00000001,
  AutoRepeatAttack                    = 0x00000002,
  IgnoreAllegianceRequests            = 0x00000004,
  IgnoreFellowshipRequests            = 0x00000008,
  NotUsed2                            = 0x00000010,
  NotUsed3                            = 0x00000020,
  AllowGive                           = 0x00000040,
  ViewCombatTarget                    = 0x00000080,
  ShowTooltips                        = 0x00000100,
  UseDeception                        = 0x00000200,
  ToggleRun                           = 0x00000400,
  StayInChatMode                      = 0x00000800,
  AdvancedCombatUI                    = 0x00001000,
  AutoTarget                          = 0x00002000,
  NotUsed4                            = 0x00004000,
  VividTargetingIndicator             = 0x00008000,
  DisableMostWeatherEffects           = 0x00010000,
  IgnoreTradeRequests                 = 0x00020000,
  FellowshipShareXP                   = 0x00040000,
  AcceptLootPermits                   = 0x00080000,
  FellowshipShareLoot                 = 0x00100000,
  SideBySideVitals                    = 0x00200000,
  CoordinatesOnRadar                  = 0x00400000,
  SpellDuration                       = 0x00800000,
  NotUsed5                            = 0x01000000,
  DisableHouseRestrictionEffects      = 0x02000000,
  DragItemOnPlayerOpensSecureTrade    = 0x04000000,
  DisplayAllegianceLogonNotifications = 0x08000000,
  UseChargeAttack                     = 0x10000000,
  AutoAcceptFellowRequest             = 0x20000000,
  HearAllegianceChat                  = 0x40000000,
  UseCraftSuccessDialog               = 0x80000000,
}

/** CharacterOptions1 Default — per CharacterOptions1.cs comment: 1355064650.
 *  TS bitwise ops produce signed int32 (HearAllegianceChat=0x40000000 |
 *  UseCraftSuccessDialog=0x80000000 wraps to negative). Use unsigned via >>>0. */
export const CHARACTER_OPTIONS1_DEFAULT = (
  CharacterOptions1.AutoRepeatAttack |
  CharacterOptions1.IgnoreFellowshipRequests |
  CharacterOptions1.AllowGive |
  CharacterOptions1.ShowTooltips |
  CharacterOptions1.ToggleRun |
  CharacterOptions1.AutoTarget |
  CharacterOptions1.VividTargetingIndicator |
  CharacterOptions1.FellowshipShareXP |
  CharacterOptions1.CoordinatesOnRadar |
  CharacterOptions1.SpellDuration |
  CharacterOptions1.UseChargeAttack |
  CharacterOptions1.HearAllegianceChat
) >>> 0;

/**
 * CharacterOptions2 — Flags enum used in PlayerDescription + SetCharacterOptions.
 * Per CharacterOptions2.cs. 32 bits including 6 NotUsedN slots.
 *
 * Includes the HUD-impacting ShowHelm / ShowCloak / DisableDistanceFog and the
 * chat-filter HearGeneralChat / HearTradeChat / HearLFGChat / HearRoleplayChat /
 * HearSocietyChat / HearPKDeath.
 */
export enum CharacterOptions2 {
  PersistentAtDay              = 0x00000001,
  DisplayDateOfBirth           = 0x00000002,
  DisplayChessRank             = 0x00000004,
  DisplayFishingSkill          = 0x00000008,
  DisplayNumberDeaths          = 0x00000010,
  DisplayAge                   = 0x00000020,
  TimeStamp                    = 0x00000040,
  SalvageMultiple              = 0x00000080,
  HearGeneralChat              = 0x00000100,
  HearTradeChat                = 0x00000200,
  HearLFGChat                  = 0x00000400,
  HearRoleplayChat             = 0x00000800,
  AppearOffline                = 0x00001000,
  DisplayNumberCharacterTitles = 0x00002000,
  MainPackPreferred            = 0x00004000,
  LeadMissileTargets           = 0x00008000,
  UseFastMissiles              = 0x00010000,
  FilterLanguage               = 0x00020000,
  ConfirmVolatileRareUse       = 0x00040000,
  HearSocietyChat              = 0x00080000,
  ShowHelm                     = 0x00100000,
  DisableDistanceFog           = 0x00200000,
  UseMouseTurning              = 0x00400000,
  ShowCloak                    = 0x00800000,
  LockUI                       = 0x01000000,
  HearPKDeath                  = 0x02000000,
  NotUsed1                     = 0x04000000,
  NotUsed2                     = 0x08000000,
  NotUsed3                     = 0x10000000,
  NotUsed4                     = 0x20000000,
  NotUsed5                     = 0x40000000,
  NotUsed6                     = 0x80000000,
}

/** CharacterOptions2 Default — per CharacterOptions2.cs comment: 9733888. */
export const CHARACTER_OPTIONS2_DEFAULT = (
  CharacterOptions2.HearGeneralChat |
  CharacterOptions2.HearTradeChat |
  CharacterOptions2.HearLFGChat |
  CharacterOptions2.LeadMissileTargets |
  CharacterOptions2.ConfirmVolatileRareUse |
  CharacterOptions2.ShowHelm |
  CharacterOptions2.ShowCloak
) >>> 0;

/**
 * FAITHFUL.570 — CharacterOption int (PlayerOption / SetSingleCharacterOption
 * key, 0x00..0x34) → which u32 bitfield holds it on the wire + the exact mask.
 *
 * Per ACE `reference/ACE/Source/ACE.Entity/Enum/CharacterOption.cs` each
 * CharacterOption is tagged with EITHER a `[CharacterOptions1(…)]` OR a
 * `[CharacterOptions2(…)]` attribute that points at the masks in the two
 * `[Flags]` enums above. That C#-attribute lookup is reflected here as a
 * plain literal map so the client can BIT-DECODE a CharacterOptions1 +
 * CharacterOptions2 pair (e.g. from PlayerDescription) back into per-option
 * boolean state at login time.
 *
 * Without this map the LOAD side of `SetSingleCharacterOption` (the FAITHFUL
 * .372 save-side ships option flips → ACE persists them as CO1/CO2 bits in
 * the player DB) has nothing to do at login — server-persisted prefs reset
 * to defaults until the user manually re-toggles each setting. The save
 * side was wired in .372; the load side from PlayerDescription is .570.
 *
 * Source: `reference/ACE/Source/ACE.Entity/Enum/CharacterOption.cs:11-178`.
 */
export const CHARACTER_OPTION_BIT_MAP: Record<number, { field: 1 | 2; mask: number }> = {
  0x00: { field: 1, mask: CharacterOptions1.AutoRepeatAttack },
  0x01: { field: 1, mask: CharacterOptions1.IgnoreAllegianceRequests },
  0x02: { field: 1, mask: CharacterOptions1.IgnoreFellowshipRequests },
  0x03: { field: 1, mask: CharacterOptions1.IgnoreTradeRequests },
  0x04: { field: 1, mask: CharacterOptions1.DisableMostWeatherEffects },
  0x05: { field: 2, mask: CharacterOptions2.PersistentAtDay },
  0x06: { field: 1, mask: CharacterOptions1.AllowGive },
  0x07: { field: 1, mask: CharacterOptions1.ViewCombatTarget },
  0x08: { field: 1, mask: CharacterOptions1.ShowTooltips },
  0x09: { field: 1, mask: CharacterOptions1.UseDeception },
  0x0A: { field: 1, mask: CharacterOptions1.ToggleRun },
  0x0B: { field: 1, mask: CharacterOptions1.StayInChatMode },
  0x0C: { field: 1, mask: CharacterOptions1.AdvancedCombatUI },
  0x0D: { field: 1, mask: CharacterOptions1.AutoTarget },
  0x0E: { field: 1, mask: CharacterOptions1.VividTargetingIndicator },
  0x0F: { field: 1, mask: CharacterOptions1.FellowshipShareXP },
  0x10: { field: 1, mask: CharacterOptions1.AcceptLootPermits },
  0x11: { field: 1, mask: CharacterOptions1.FellowshipShareLoot },
  0x12: { field: 1, mask: CharacterOptions1.AutoAcceptFellowRequest },
  0x13: { field: 1, mask: CharacterOptions1.SideBySideVitals },
  0x14: { field: 1, mask: CharacterOptions1.CoordinatesOnRadar },
  0x15: { field: 1, mask: CharacterOptions1.SpellDuration },
  0x16: { field: 1, mask: CharacterOptions1.DisableHouseRestrictionEffects },
  0x17: { field: 1, mask: CharacterOptions1.DragItemOnPlayerOpensSecureTrade },
  0x18: { field: 1, mask: CharacterOptions1.DisplayAllegianceLogonNotifications },
  0x19: { field: 1, mask: CharacterOptions1.UseChargeAttack },
  0x1A: { field: 1, mask: CharacterOptions1.UseCraftSuccessDialog },
  0x1B: { field: 1, mask: CharacterOptions1.HearAllegianceChat },
  0x1C: { field: 2, mask: CharacterOptions2.DisplayDateOfBirth },
  0x1D: { field: 2, mask: CharacterOptions2.DisplayAge },
  0x1E: { field: 2, mask: CharacterOptions2.DisplayChessRank },
  0x1F: { field: 2, mask: CharacterOptions2.DisplayFishingSkill },
  0x20: { field: 2, mask: CharacterOptions2.DisplayNumberDeaths },
  0x21: { field: 2, mask: CharacterOptions2.TimeStamp },
  0x22: { field: 2, mask: CharacterOptions2.SalvageMultiple },
  0x23: { field: 2, mask: CharacterOptions2.HearGeneralChat },
  0x24: { field: 2, mask: CharacterOptions2.HearTradeChat },
  0x25: { field: 2, mask: CharacterOptions2.HearLFGChat },
  0x26: { field: 2, mask: CharacterOptions2.HearRoleplayChat },
  0x27: { field: 2, mask: CharacterOptions2.AppearOffline },
  0x28: { field: 2, mask: CharacterOptions2.DisplayNumberCharacterTitles },
  0x29: { field: 2, mask: CharacterOptions2.MainPackPreferred },
  0x2A: { field: 2, mask: CharacterOptions2.LeadMissileTargets },
  0x2B: { field: 2, mask: CharacterOptions2.UseFastMissiles },
  0x2C: { field: 2, mask: CharacterOptions2.FilterLanguage },
  0x2D: { field: 2, mask: CharacterOptions2.ConfirmVolatileRareUse },
  0x2E: { field: 2, mask: CharacterOptions2.HearSocietyChat },
  0x2F: { field: 2, mask: CharacterOptions2.ShowHelm },
  0x30: { field: 2, mask: CharacterOptions2.DisableDistanceFog },
  0x31: { field: 2, mask: CharacterOptions2.UseMouseTurning },
  0x32: { field: 2, mask: CharacterOptions2.ShowCloak },
  0x33: { field: 2, mask: CharacterOptions2.LockUI },
  0x34: { field: 2, mask: CharacterOptions2.HearPKDeath },
};

/**
 * FAITHFUL.570 — bit-decode helper. Returns true iff the CharacterOption is
 * SET in the supplied (CharacterOptions1, CharacterOptions2) pair. Returns
 * false for unknown option ints (i.e. anything outside 0x00..0x34) so a
 * future ACE addition doesn't accidentally read as "on" against stale data.
 */
export function characterOptionIsSet(option: number, co1: number, co2: number): boolean {
  const m = CHARACTER_OPTION_BIT_MAP[option];
  if (!m) return false;
  const bits = m.field === 1 ? co1 : co2;
  return (bits & m.mask) !== 0;
}

/**
 * Placement — per ACE Placement.cs. Item attachment / orientation slot used
 * by the original AC client to position wielded/equipped/dropped items.
 *
 * Includes 13 `XXXUnknown*` sentinels at out-of-sequence integer values that
 * ACE has not yet mapped to a name. We retain them exactly so any future ACE
 * commit that names one of them will trip the assertion below + we can match
 * the AC client's behavior of treating them as opaque integer slots.
 */
export enum Placement {
  Default              = 0,
  RightHandCombat      = 1,
  RightHandNonCombat   = 2,
  LeftHand             = 3,
  Belt                 = 4,
  Quiver               = 5,
  Shield               = 6,
  LeftWeapon           = 7,
  LeftUnarmed          = 8,
  SpecialCrowssbowBolt = 51,
  MissileFlight        = 52,
  Resting              = 101,
  Other                = 102,
  Hook                 = 103,
  Random1              = 121,
  Random2              = 122,
  Random3              = 123,
  Random4              = 124,
  Random5              = 125,
  Random6              = 126,
  Random7              = 127,
  Random8              = 128,
  Random9              = 129,
  Random10             = 130,
  XXXUnknownA          = 0x0000000A,
  XXXUnknownF          = 0x0000000F,
  XXXUnknown14         = 0x00000014,
  XXXUnknown1E         = 0x0000001E,
  XXXUnknown20         = 0x00000020,
  XXXUnknown3C         = 0x0000003C,
  XXXUnknown63         = 0x00000063,
  XXXUnknown68         = 0x00000068,
  XXXUnknown69         = 0x00000069,
  XXXUnknown6A         = 0x0000006A,
  XXXUnknown78         = 0x00000078,
  XXXUnknown84         = 0x00000084,
  XXXUnknownF0         = 0x000000F0,
  XXXUnknown3F2        = 0x000003F2,
}

/** ContainerType — per ACE ContainerType.cs. */
export enum ContainerType {
  NonContainer = 0,
  Container    = 1,
  Foci         = 2,
}

/** HoldKey — per ACE HoldKey.cs. Movement-mode hold-state. */
export enum HoldKey {
  Invalid = 0x0,
  None    = 0x1,
  Run     = 0x2,
}

/** PortalFlags — per ACE PortalFlags.cs (Flags enum). */
export enum PortalFlags {
  ExactMatch = 0x1,
  PortalSide = 0x2,
}

/**
 * FactionBits — per ACE FactionBits.cs (Flags enum). Society affiliation.
 * Includes the `ValidFactions` aggregate as a const since TS Flags enums
 * can't expose a member computed from other members of the same enum.
 */
export enum FactionBits {
  None          = 0x0,
  CelestialHand = 0x1,
  EldrytchWeb   = 0x2,
  RadiantBlood  = 0x4,
}

/** ValidFactions = CelestialHand | EldrytchWeb | RadiantBlood. Per ACE source. */
export const FACTION_BITS_VALID =
  FactionBits.CelestialHand | FactionBits.EldrytchWeb | FactionBits.RadiantBlood;

/** Per FactionBitsExtensions.ToSentence. Returns the spaced-display name. */
export function factionBitsLabel(f: FactionBits): string {
  switch (f) {
    case FactionBits.None: return 'None';
    case FactionBits.CelestialHand: return 'Celestial Hand';
    case FactionBits.EldrytchWeb: return 'Eldrytch Web';
    case FactionBits.RadiantBlood: return 'Radiant Blood';
    default: return '';
  }
}

/** MotionFlags — per ACE MotionFlags.cs (Flags byte). */
export enum MotionFlags {
  None             = 0x0,
  StickToObject    = 0x1,
  StandingLongJump = 0x2,
}

/**
 * BasePropertyType — per ACE BasePropertyType.cs. Sequential 0-21.
 * (ACE renamed this from "PropertyType" to avoid ambiguity with the
 *  PropertyType enum under ACE.Entity.Enum.Properties.)
 */
export enum BasePropertyType {
  Invalid      = 0,
  Bool         = 1,
  Integer      = 2,
  LongInteger  = 3,
  Float        = 4,
  Vector       = 5,
  Color        = 6,
  String       = 7,
  StringInfo   = 8,
  Enum         = 9,
  DataFile     = 10,
  Waveform     = 11,
  InstanceID   = 12,
  Position     = 13,
  TimeStamp    = 14,
  Bitfield32   = 15,
  Bitfield64   = 16,
  Array        = 17,
  Struct       = 18,
  StringToken  = 19,
  PropertyName = 20,
  TriState     = 21,
}

/**
 * ChatNetworkBlobType — per ACE ChatNetworkBlobType.cs.
 * Identifies the Turbine Chat (0xF7DE) message type. Carries direction
 * (Server→Client = EVENT/RESPONSE, Client→Server = REQUEST) and encoding
 * (Binary vs XMLRPC).
 */
export enum ChatNetworkBlobType {
  NETBLOB_UNKNOWN           = 0,
  NETBLOB_EVENT_BINARY      = 1,  // S→C
  NETBLOB_EVENT_XMLRPC      = 2,  // S→C
  NETBLOB_REQUEST_BINARY    = 3,  // C→S
  NETBLOB_REQUEST_XMLRPC    = 4,  // C→S
  NETBLOB_RESPONSE_BINARY   = 5,  // S→C
  NETBLOB_RESPONSE_XMLRPC   = 6,  // S→C
}

/**
 * ChatNetworkBlobDispatchType — per ACE ChatNetworkBlobDispatchType.cs.
 * Names the async-RPC method invoked over the Turbine Chat (0xF7DE)
 * channel. The client emits SENDTOROOMBYID for normal channel chat
 * (/general, /trade, /allegiance, /lfg, /roleplay); the other methods
 * are used by name-resolution + room-management RPCs.
 */
export enum ChatNetworkBlobDispatchType {
  ASYNCMETHOD_UNKNOWN                 = 0,
  ASYNCMETHOD_SENDTOROOMBYNAME        = 1,
  ASYNCMETHOD_SENDTOROOMBYID          = 2,
  ASYNCMETHOD_CREATEROOM              = 3,
  ASYNCMETHOD_INVITECLIENTTOROOMBYID  = 4,
  ASYNCMETHOD_EJECTCLIENTFROMROOMBYID = 5,
}

/**
 * Trailing extra-data block size of a Turbine Chat SendToRoomByID request,
 * in bytes. Per ACE GameMessageTurbineChat.cs:107 the writer emits the
 * literal `0x0Cu` before the speakerID/hResult/chatType triple — that's
 * 12 bytes = 3 × uint32. ACE TurbineChatHandler.cs:57 reads it back as
 * "// Always 0x0C". Symbolic so the structural relationship to the trailing
 * fields is obvious from the source.
 */
export const TURBINE_CHAT_EXTRA_DATA_SIZE = 0x0C;

/**
 * PhysicsState — per ACE PhysicsState.cs. Flags enum.
 *
 * Server-sent uint32 in CreateObject's physics description block (right after
 * the timestamps). Drives visibility, collision, gravity, missile-flag,
 * particle-emitter behavior on the client.
 */
export enum PhysicsState {
  Static                        = 0x00000001,
  Unused1                       = 0x00000002,
  Ethereal                      = 0x00000004,
  ReportCollisions              = 0x00000008,
  IgnoreCollisions              = 0x00000010,
  NoDraw                        = 0x00000020,
  Missile                       = 0x00000040,
  Pushable                      = 0x00000080,
  AlignPath                     = 0x00000100,
  PathClipped                   = 0x00000200,
  Gravity                       = 0x00000400,
  LightingOn                    = 0x00000800,
  ParticleEmitter               = 0x00001000,
  Unused2                       = 0x00002000,
  Hidden                        = 0x00004000,
  ScriptedCollision             = 0x00008000,
  HasPhysicsBSP                 = 0x00010000,
  Inelastic                     = 0x00020000,
  HasDefaultAnim                = 0x00040000,
  HasDefaultScript              = 0x00080000,
  Cloaked                       = 0x00100000,
  ReportCollisionsAsEnvironment = 0x00200000,
  EdgeSlide                     = 0x00400000,
  Sledding                      = 0x00800000,
  Frozen                        = 0x01000000,
}

/**
 * ObjectDescriptionFlag — per ACE ObjectDescriptionFlag.cs. Flags enum.
 *
 * Server-sent uint32 in CreateObject's weenie data block — categorizes
 * an object (Vendor, Door, Corpse, Healer, Portal, LifeStone, etc.) so the
 * client can dispatch interaction UI without needing a weenie lookup.
 *
 * IncludesSecondHeader gates a 2nd WeenieHeaderFlag uint8 byte; the rest
 * are category bits the client uses to drive cursor hints, right-click menu
 * options, and admin UI.
 */
export enum ObjectDescriptionFlag {
  None                   = 0x00000000,
  Openable               = 0x00000001,
  Inscribable            = 0x00000002,
  Stuck                  = 0x00000004,
  Player                 = 0x00000008,
  Attackable             = 0x00000010,
  PlayerKiller           = 0x00000020,
  HiddenAdmin            = 0x00000040,
  UiHidden               = 0x00000080,
  Book                   = 0x00000100,
  Vendor                 = 0x00000200,
  PkSwitch               = 0x00000400,
  NpkSwitch              = 0x00000800,
  Door                   = 0x00001000,
  Corpse                 = 0x00002000,
  LifeStone              = 0x00004000,
  Food                   = 0x00008000,
  Healer                 = 0x00010000,
  Lockpick               = 0x00020000,
  Portal                 = 0x00040000,
  Admin                  = 0x00100000,
  FreePkStatus           = 0x00200000,
  ImmuneCellRestrictions = 0x00400000,
  RequiresPackSlot       = 0x00800000,
  Retained               = 0x01000000,
  PkLiteStatus           = 0x02000000,
  IncludesSecondHeader   = 0x04000000,
  BindStone              = 0x08000000,
  VolatileRare           = 0x10000000,
  WieldOnUse             = 0x20000000,
  WieldLeft              = 0x40000000,
}

/**
 * Map a DamageType flag to its canonical ACE display name.
 *
 * Mirrors `DamageType.GetName()` from
 * `reference/ACE/Source/ACE.Entity/Enum/DamageType.cs`:
 *   Slash    → "Slashing"
 *   Pierce   → "Piercing"
 *   Bludgeon → "Bludgeoning"
 *   Cold     → "Cold"
 *   Fire     → "Fire"
 *   Acid     → "Acid"
 *   Electric → "Electric"
 *   Health   → "Health"
 *   Stamina  → "Stamina"
 *   Mana     → "Mana"
 *   Nether   → "Nether"
 *   Base     → "Base"
 *   Undef    → "Undefined"
 *
 * Note the gerund forms for physical types ("Slashing" not "Slash") — pre-
 * FAITHFUL.106 we had 3 separate local copies of this table, 2 of which used
 * the short "Slash" form (vs ACE's "Slashing") + 1 of which omitted Health /
 * Stamina / Mana / Nether entirely (combat chat would silently render those
 * drain types as "unknown damage").
 *
 * For "Slashing" / "Piercing" / etc. inside chat sentences ("...for X points
 * of <name> damage"), callers should `.toLowerCase()` the result.
 *
 * Returns the bare numeric flag (`"DamageType #X"`) for any input the table
 * doesn't recognize, so future ACE additions surface visibly instead of
 * silently rendering as the empty string.
 */
export function damageTypeName(damageType: number): string {
  const NAMES: Record<number, string> = {
    0x0:        'Undefined',
    0x1:        'Slashing',
    0x2:        'Piercing',
    0x4:        'Bludgeoning',
    0x8:        'Cold',
    0x10:       'Fire',
    0x20:       'Acid',
    0x40:       'Electric',
    0x80:       'Health',
    0x100:      'Stamina',
    0x200:      'Mana',
    0x400:      'Nether',
    0x10000000: 'Base',
  };
  return NAMES[damageType] ?? `DamageType #${damageType}`;
}

/**
 * Retail appraisal damage-type formatter — mirrors the EoL client's
 * `AppraisalSystem::DamageTypeToString` @ 005b4200
 * (reference/client-eol/decomp/acclient-decompiled.c:422307).
 *
 * The retail function walks the DAMAGE_TYPE bits in a fixed order and
 * concatenates a name per set bit, so composite masks (multi-strike weapons
 * like Sword of Lost Light, Slash|Pierce = 3) render "Slashing/Piercing" —
 * never a raw enum number. Names come from the acclient string table
 * (strings 24828-24846 in the binary): each type after the first is
 * appended via its "/"-prefixed variant ("/Piercing", "/Bludgeoning", …),
 * i.e. the join separator is "/" (NOT ", "). Two names differ from ACE's
 * server-side DamageType.GetName forms: Electric renders "Electrical" and
 * Base renders "Prismatic" (the retail term for rending-neutral Isparian
 * damage).
 *
 * Bits outside the walked set (Health / Stamina / Mana drains) contribute
 * nothing; a mask with none of the walked bits yields "" exactly like the
 * retail function leaves an empty buffer — callers skip the row on "".
 */
export function appraisalDamageTypeToString(mask: number): string {
  // (bit, name) pairs in the retail walk order @ 005b4200.
  const WALK: Array<[number, string]> = [
    [0x1,        'Slashing'],
    [0x2,        'Piercing'],
    [0x4,        'Bludgeoning'],
    [0x8,        'Cold'],
    [0x10,       'Fire'],
    [0x20,       'Acid'],
    [0x40,       'Electrical'],
    [0x400,      'Nether'],
    [0x10000000, 'Prismatic'],
  ];
  const parts: string[] = [];
  for (const [bit, name] of WALK) {
    if ((mask & bit) !== 0) parts.push(name);
  }
  return parts.join('/');
}

/**
 * Retail appraisal weapon-speed formatter — mirrors the EoL client's
 * `AppraisalSystem::WeaponTimeToString` @ 005b4970
 * (reference/client-eol/decomp/acclient-decompiled.c:422765).
 *
 * Retail never shows the bare WeaponTime number on examine: ItemExamineUI
 * builds "Speed: " + WeaponTimeToString(weapon_time) then sprintf's
 * "%s (%d)" (acclient-decompiled.c:174846-174850), so Lilitha's Bow
 * (WeaponTime 40) reads "Speed: Average (40)" — corroborated by
 * reference/images/hud/examine-bow.jpg.
 *
 * Threshold comparisons verbatim from the decompiled binary (param is a
 * signed long there):
 *   t < 0xb  (11) → "Very Fast"
 *   t < 0x1f (31) → "Fast"
 *   t ≤ 0x31 (49) → "Average"
 *   t < 0x50 (80) → "Slow"
 *   otherwise     → "Very Slow"
 *
 * The "Speed:  Unknown" case for a negative weapon_time lives at the retail
 * call site (before WeaponTimeToString is ever called), not in this
 * function — callers gate on `t < 0` themselves.
 */
export function weaponTimeToString(weaponTime: number): string {
  if (weaponTime < 0xb) return 'Very Fast';
  if (weaponTime < 0x1f) return 'Fast';
  if (weaponTime <= 0x31) return 'Average';
  if (weaponTime < 0x50) return 'Slow';
  return 'Very Slow';
}

/**
 * VitalKey — per ACE Vital.cs (named `Vital` in ACE source; renamed here
 * to avoid collision with the existing `Vital` interface in
 * `character/VitalSystem.ts` which represents the runtime state of a
 * client-side vital). Sequential `uint` enum used as the wire-format key
 * in PrivateUpdateVital / PublicUpdateVital messages.
 *
 * Distinct from `VitalId` (in VitalSystem) which is the client-side
 * struct ID with values 1=Health, 2=Stamina, 3=Mana. ACE's Vital
 * interleaves Max-vs-current for every vital:
 *   0 = Undefined
 *   1 = MaxHealth   (training data: ranks + cpSpent)
 *   2 = Health      (current value only)
 *   3 = MaxStamina
 *   4 = Stamina
 *   5 = MaxMana
 *   6 = Mana
 *
 * Used by onPrivateUpdateVital / onPrivateUpdateAttribute2ndLevel in
 * main.ts to dispatch incoming server vital updates to the right slot.
 */
export enum VitalKey {
  Undefined   = 0,
  MaxHealth   = 1,
  Health      = 2,
  MaxStamina  = 3,
  Stamina     = 4,
  MaxMana     = 5,
  Mana        = 6,
}

/**
 * WieldRequirementType — per ACE WieldRequirement.cs. Sequential, used as
 * the "kind" field in the wield-requirement triplet (kind, what, threshold)
 * stored as three adjacent PropertyInt rows on every equippable item:
 *
 *   PropertyInt 158 = WieldRequirements   (kind: WieldRequirement enum)
 *   PropertyInt 159 = WieldSkillType      (what: SkillId / PropertyAttribute /
 *                                          PropertyAttribute2nd / CreatureType /
 *                                          HeritageGroup — depends on kind)
 *   PropertyInt 160 = WieldDifficulty     (threshold: numeric value)
 *
 * Three additional triplets exist (270/271/272, 273/274/275, 276/277/278) so
 * a single item can stack up to 4 simultaneous wield requirements (e.g.
 * "Skill 350 in War Magic AND Level 80 AND Aluvian heritage").
 *
 * The wield-req appraisal row formats this triplet into human-readable text
 * via `formatWieldRequirement` below.
 */
export enum WieldRequirementType {
  Invalid             = 0,
  Skill               = 1,
  RawSkill            = 2,
  Attrib              = 3,
  RawAttrib           = 4,
  SecondaryAttrib     = 5,
  RawSecondaryAttrib  = 6,
  Level               = 7,
  Training            = 8,
  IntStat             = 9,   // unused in PY16
  BoolStat            = 10,  // unused in PY16
  CreatureType        = 11,
  HeritageType        = 12,
}

/**
 * Format a wield-requirement triplet into appraisal-panel text.
 *
 * Anchored to ACE Player_Inventory.cs:2125-2229 (`CheckWieldRequirement`)
 * for the kind→what→threshold semantics, plus AC-client tooltip conventions
 * for the text format.
 *
 * Caller supplies name-resolver callbacks so the formatter stays in
 * @ac/shared (no UI / DAT dependencies). Resolvers should return human-
 * readable names for the relevant ID type or `null` for unknown IDs.
 *
 * Example outputs:
 *   formatWieldRequirement(Skill, 34, 350)        → "Skill: War Magic — 350"
 *   formatWieldRequirement(Level, 0, 80)          → "Level — 80"
 *   formatWieldRequirement(HeritageType, 0, 1)    → "Heritage: Aluvian"
 *   formatWieldRequirement(CreatureType, 0, 25)   → "CreatureType: Olthoi"
 *   formatWieldRequirement(Training, 34, 3)       → "Specialized in War Magic"
 *   formatWieldRequirement(Attrib, 1, 250)        → "Strength — 250"
 *   formatWieldRequirement(SecondaryAttrib, 1, 200) → "Max Health — 200"
 */
export interface WieldRequirementResolvers {
  skillName?: (id: number) => string | null;
  heritageName?: (id: number) => string | null;
  creatureTypeName?: (id: number) => string | null;
}

export function formatWieldRequirement(
  kind: WieldRequirementType,
  what: number,
  threshold: number,
  resolvers: WieldRequirementResolvers = {},
): string {
  switch (kind) {
    case WieldRequirementType.Skill:
    case WieldRequirementType.RawSkill: {
      const name = resolvers.skillName?.(what) ?? `Skill #${what}`;
      return `Skill: ${name} — ${threshold}`;
    }
    case WieldRequirementType.Attrib:
    case WieldRequirementType.RawAttrib: {
      // PropertyAttribute 1=Strength..6=Self.
      const names = ['', 'Strength', 'Endurance', 'Quickness', 'Coordination', 'Focus', 'Self'];
      const name = names[what] ?? `Attribute #${what}`;
      return `${name} — ${threshold}`;
    }
    case WieldRequirementType.SecondaryAttrib:
    case WieldRequirementType.RawSecondaryAttrib: {
      // PropertyAttribute2nd 1=MaxHealth, 3=MaxStamina, 5=MaxMana.
      // FAITHFUL.294 — labels mirror ACE PropertyAttribute2ndExtensions.ToSentence
      // (reference/ACE/Source/ACE.Entity/Enum/Properties/PropertyAttribute2nd.cs:30-52):
      // ACE returns "Maximum Health" / "Maximum Stamina" / "Maximum Mana"
      // (not "Max ..."). The algorithmic fallback even has an explicit
      // `.Replace("Max", "Maximum")` step, confirming the canonical wording.
      const names: Record<number, string> = { 1: 'Maximum Health', 3: 'Maximum Stamina', 5: 'Maximum Mana' };
      const name = names[what] ?? `Vital #${what}`;
      return `${name} — ${threshold}`;
    }
    case WieldRequirementType.Level:
      return `Level — ${threshold}`;
    case WieldRequirementType.Training: {
      // Threshold = SkillAdvancementClass: 2=Trained, 3=Specialized.
      const tier = threshold === 3 ? 'Specialized' : threshold === 2 ? 'Trained' : `Tier ${threshold}`;
      const name = resolvers.skillName?.(what) ?? `Skill #${what}`;
      return `${tier} in ${name}`;
    }
    case WieldRequirementType.CreatureType: {
      const name = resolvers.creatureTypeName?.(threshold) ?? `CreatureType #${threshold}`;
      return `CreatureType: ${name}`;
    }
    case WieldRequirementType.HeritageType: {
      const name = resolvers.heritageName?.(threshold) ?? `Heritage #${threshold}`;
      return `Heritage: ${name}`;
    }
    case WieldRequirementType.IntStat:
      // PY16-unused per ACE source. Best-effort generic format.
      return `IntStat #${what} — ${threshold}`;
    case WieldRequirementType.BoolStat:
      return `BoolStat #${what} ${threshold ? 'true' : 'false'}`;
    case WieldRequirementType.Invalid:
    default:
      return '';
  }
}

/**
 * ParentLocation — per ACE ParentLocation.cs. Sequential, used to identify
 * where on a creature's body a wielded item is anchored. Carried in
 * `ParentEvent` (server tells observers "this item is now wielded here on
 * this creature") and resolved at attach time against the creature's
 * SetupModel.holdingLocations dictionary.
 *
 * Note: ACE source spells `Hearldry` (typo); preserved verbatim here so
 * cross-referencing reads identically. Future ACE rebases that fix the
 * spelling will surface as an audit-test diff.
 */
export enum ParentLocation {
  None        = 0,
  RightHand   = 1,
  LeftHand    = 2,
  Shield      = 3,
  Belt        = 4,
  Quiver      = 5,
  Hearldry    = 6,
  Mouth       = 7,
  LeftWeapon  = 8,
  LeftUnarmed = 9,
}

/**
 * CreatureProfileFlags — per ACE Network/Structure/CreatureProfile.cs (private
 * enum at top of file). Flags enum carried inside the CreatureProfile sub-
 * block of an IdentifyResponse payload, gating which optional fields follow.
 *
 * - ShowAttributes (0x8): when set, the parser reads 10 × uint32 attribute /
 *   vital fields (Strength, Endurance, Quickness, Coordination, Focus, Self,
 *   Stamina, Mana, StaminaMax, ManaMax).
 * - HasBuffsDebuffs (0x1): when set, the parser reads attributeHighlights
 *   (uint16) + attributeColors (uint16) — drives the red/green attribute
 *   tinting on the appraisal panel.
 * - Unknown1 (0x2), Unknown2 (0x4): reserved bits per ACE source.
 */
export enum CreatureProfileFlags {
  HasBuffsDebuffs = 0x1,
  Unknown1        = 0x2,
  Unknown2        = 0x4,
  ShowAttributes  = 0x8,
}

/**
 * AllegianceIndex — per ACE Network/Enum/AllegianceIndex.cs. Flags enum
 * carried in the `bitfield` uint32 of every AllegianceData record (inbound
 * AllegianceUpdate 0x0020, FellowshipFullUpdate, etc.).
 *
 * Gates conditional fields in the record body and surfaces per-member
 * Update-required, has-packed-level, has-allegiance-age, and may-passup-XP
 * status to the client UI.
 */
export enum AllegianceIndex {
  Undefined           = 0x0,
  LoggedIn            = 0x1,
  Update              = 0x2,
  HasAllegianceAge    = 0x4,
  HasPackedLevel      = 0x8,
  MayPassupExperience = 0x10,
}

/**
 * AttributeCache — per ACE AttributeCache.cs. Flags enum.
 *
 * Mask used by GameEventPlayerDescription / GameEventPlayerVitalsUpdate
 * to indicate which attributes/vitals follow in the wire payload. The
 * 9-bit serialization order is the bit order shown here (Strength..Mana).
 */
export enum AttributeCache {
  Undef        = 0x00000000,
  Strength     = 0x00000001,
  Endurance    = 0x00000002,
  Quickness    = 0x00000004,
  Coordination = 0x00000008,
  Focus        = 0x00000010,
  Self         = 0x00000020,
  Health       = 0x00000040,
  Stamina      = 0x00000080,
  Mana         = 0x00000100,
}

/** AttributeCache.Full — all 9 bits set (kept as const since TS Flags
 *  enums can't define members in terms of other members of the same enum). */
export const ATTRIBUTE_CACHE_FULL =
  AttributeCache.Strength |
  AttributeCache.Endurance |
  AttributeCache.Quickness |
  AttributeCache.Coordination |
  AttributeCache.Focus |
  AttributeCache.Self |
  AttributeCache.Health |
  AttributeCache.Stamina |
  AttributeCache.Mana;

/**
 * DescriptionPropertyFlag — per ACE GameEventPlayerDescription.cs (private enum).
 *
 * Top-level mask in the PlayerDescription wire format indicating which
 * property-bag sub-blocks follow. Bit-order matches serialization order.
 */
export enum DescriptionPropertyFlag {
  None           = 0x0000,
  PropertyInt32  = 0x0001,
  PropertyBool   = 0x0002,
  PropertyDouble = 0x0004,
  PropertyDid    = 0x0008,
  PropertyString = 0x0010,
  Position       = 0x0020,
  PropertyIid    = 0x0040,
  PropertyInt64  = 0x0080,
}

/**
 * DescriptionVectorFlag — per ACE GameEventPlayerDescription.cs (private enum).
 *
 * Second-level mask in the PlayerDescription wire format indicating which
 * vector sub-blocks (attribute table, skill table, spell book, enchantment
 * registry) follow.
 */
export enum DescriptionVectorFlag {
  None        = 0x0000,
  Attribute   = 0x0001,
  Skill       = 0x0002,
  Spell       = 0x0100,
  Enchantment = 0x0200,
}

/**
 * StipplingType — per ACE StipplingType.cs. Per-polygon culling hint in the
 * DAT cell-structure / environment-cell polygon records.
 *
 * Used by `EnvCellRenderer` to filter out portal-opening polygons (NoPos)
 * from the rendered mesh. NoUVS=0x14 is `0x10 | 0x4`, not a single bit —
 * it's a Stippling | NoPos composite that surfaces when a polygon has no
 * texture coordinates AND is portal-side-suppressed.
 */
export enum StipplingType {
  None     = 0x0,
  Positive = 0x1,
  Negative = 0x2,
  Both     = 0x3,
  NoPos    = 0x4,
  NoNeg    = 0x8,
  NoUVS    = 0x14,
}

/**
 * MovementStateFlag — per ACE MovementStateFlag.cs. Flags enum used in the
 * inbound InterpretedMotionState wire format (carried in MovementData of
 * CreateObject and MovementEvent). Distinct from RawMotionFlags which the
 * client uses on the outbound side — the two have DIFFERENT bit layouts.
 *
 * The 7-bit flag mask is packed as the low bits of a uint32; commands list
 * length rides at bit 7+ (i.e. `flags | (numCommands << 7)`).
 */
export enum MovementStateFlag {
  Invalid         = 0x0,
  CurrentStyle    = 0x1,
  ForwardCommand  = 0x2,
  ForwardSpeed    = 0x4,
  SideStepCommand = 0x8,
  SideStepSpeed   = 0x10,
  TurnCommand     = 0x20,
  TurnSpeed       = 0x40,
}

/**
 * RawMotionFlags — per ACE Network/Enum/RawMotionFlags.cs. Flags enum.
 *
 * Outbound MoveToState (GameAction 0xF61C) packs these into the low 11 bits
 * of `(flags & 0x7FF) | ((commandListLength & 0x1FFFFF) << 11)`. Each set
 * bit gates an additional uint32 (or float32 for *Speed) following the
 * packedFlags header, in flag-bit order.
 */
export enum RawMotionFlags {
  Invalid         = 0x0,
  CurrentHoldKey  = 0x1,
  CurrentStyle    = 0x2,
  ForwardCommand  = 0x4,
  ForwardHoldKey  = 0x8,
  ForwardSpeed    = 0x10,
  SideStepCommand = 0x20,
  SideStepHoldKey = 0x40,
  SideStepSpeed   = 0x80,
  TurnCommand     = 0x100,
  TurnHoldKey     = 0x200,
  TurnSpeed       = 0x400,
}

/**
 * IdentifyResponseFlags — per ACE IdentifyResponseFlags.cs. Flags enum.
 *
 * Server-sent uint32 in the appraisal/identify response (GameEventIdentify
 * response 0x00C9). Each bit set ⇔ the corresponding sub-block is appended
 * to the wire payload. Serialization order per AppraiseInfo.cs:761-775:
 *   Int → Int64 → Bool → Float → String → Did → SpellBook →
 *   Armor → Creature → Weapon → Hook → ArmorEnch → WeaponEnch →
 *   ResistEnch → ArmorLevels.
 *
 * Bit-number order is NOT byte order — the parser must use the documented
 * serialization order, NOT just iterate bits low-to-high.
 */
export enum IdentifyResponseFlags {
  None                      = 0x0000,
  IntStatsTable             = 0x0001,
  BoolStatsTable            = 0x0002,
  FloatStatsTable           = 0x0004,
  StringStatsTable          = 0x0008,
  SpellBook                 = 0x0010,
  WeaponProfile             = 0x0020,
  HookProfile               = 0x0040,
  ArmorProfile              = 0x0080,
  CreatureProfile           = 0x0100,
  ArmorEnchantmentBitfield  = 0x0200,
  ResistEnchantmentBitfield = 0x0400,
  WeaponEnchantmentBitfield = 0x0800,
  DidStatsTable             = 0x1000,
  Int64StatsTable           = 0x2000,
  ArmorLevels               = 0x4000,
}

/**
 * CombatStyle — per ACE CombatStyle.cs. Flags enum.
 *
 * Read from `PropertyInt.DefaultCombatStyle = 46` on every wieldable. Drives
 * which combat stance the player enters when wielding the item, which
 * holding-location frame to apply, and (combined with EquipMask) routes
 * left- vs right-hand attachment for missile weapons.
 *
 * Melee/Missile/All composites mirror ACE's bit-union aliases.
 */
export enum CombatStyle {
  Undef               = 0x00000,
  Unarmed             = 0x00001,
  OneHanded           = 0x00002,
  OneHandedAndShield  = 0x00004,
  TwoHanded           = 0x00008,
  Bow                 = 0x00010,
  Crossbow            = 0x00020,
  Sling               = 0x00040,
  ThrownWeapon        = 0x00080,
  DualWield           = 0x00100,
  Magic               = 0x00200,
  Atlatl              = 0x00400,
  ThrownShield        = 0x00800,
  Reserved1           = 0x01000,
  Reserved2           = 0x02000,
  Reserved3           = 0x04000,
  Reserved4           = 0x08000,
  StubbornMagic       = 0x10000,
  StubbornProjectile  = 0x20000,
  StubbornMelee       = 0x40000,
  StubbornMissile     = 0x80000,
  All                 = 0xFFFF,
}

/** CombatStyle composite unions per ACE source (computed-member style; kept
 *  as const since TypeScript Flags enums can't define members from other
 *  members of the same enum). */
export const COMBAT_STYLE_MELEE =
  CombatStyle.Unarmed |
  CombatStyle.OneHanded |
  CombatStyle.OneHandedAndShield |
  CombatStyle.TwoHanded |
  CombatStyle.DualWield;

export const COMBAT_STYLE_MISSILE =
  CombatStyle.Bow |
  CombatStyle.Crossbow |
  CombatStyle.Sling |
  CombatStyle.ThrownWeapon |
  CombatStyle.Atlatl |
  CombatStyle.ThrownShield;

/**
 * PositionFlags — per ACE PositionFlags.cs. Flags enum used in the
 * UpdatePosition (0xF748) and AutonomousPosition (0xF74A) wire formats.
 *
 * Indicates which fields are present in the position structure and which
 * quaternion components are omitted (treated as 0).
 */
export enum PositionFlags {
  None              = 0x00,
  HasVelocity       = 0x01,  // velocity vector is present
  HasPlacementID    = 0x02,  // placement id is present
  IsGrounded        = 0x04,  // object is grounded (flag only, no data)
  OrientationHasNoW = 0x08,  // orientation quaternion W omitted
  OrientationHasNoX = 0x10,  // orientation quaternion X omitted
  OrientationHasNoY = 0x20,  // orientation quaternion Y omitted
  OrientationHasNoZ = 0x40,  // orientation quaternion Z omitted
}

/**
 * Decode a UiEffects bitmask into human-readable badge labels (Magical,
 * Poisoned, Fire, Frost, etc.). Returns an empty array when the mask is 0
 * or only Undef is set. Order mirrors ACE source bit order.
 */
export function uiEffectsLabels(mask: number): string[] {
  if (!mask) return [];
  const out: string[] = [];
  if (mask & UiEffects.Magical) out.push('Magical');
  if (mask & UiEffects.Poisoned) out.push('Poisoned');
  if (mask & UiEffects.BoostHealth) out.push('Boost Health');
  if (mask & UiEffects.BoostMana) out.push('Boost Mana');
  if (mask & UiEffects.BoostStamina) out.push('Boost Stamina');
  if (mask & UiEffects.Fire) out.push('Fire');
  if (mask & UiEffects.Lightning) out.push('Lightning');
  if (mask & UiEffects.Frost) out.push('Frost');
  if (mask & UiEffects.Acid) out.push('Acid');
  if (mask & UiEffects.Bludgeoning) out.push('Bludgeoning');
  if (mask & UiEffects.Slashing) out.push('Slashing');
  if (mask & UiEffects.Piercing) out.push('Piercing');
  if (mask & UiEffects.Nether) out.push('Nether');
  return out;
}

/**
 * UiEffects — per ACE UiEffects.cs. Flags enum carried in the WeenieHeader
 * UiEffects field (read on every appraisable item; bit 0x080 of WeenieHeaderFlag).
 *
 * Drives icon-overlay glow/tint on inventory and paperdoll: Magical (blue
 * sparkle), Poisoned (green tint), Fire/Frost/Lightning/etc (elemental
 * overlay on weapons). Server sends 14 bits per item but the client must
 * pattern-match them to the corresponding overlay textures.
 */
export enum UiEffects {
  Undef        = 0x0000,
  Magical      = 0x0001,
  Poisoned     = 0x0002,
  BoostHealth  = 0x0004,
  BoostMana    = 0x0008,
  BoostStamina = 0x0010,
  Fire         = 0x0020,
  Lightning    = 0x0040,
  Frost        = 0x0080,
  Acid         = 0x0100,
  Bludgeoning  = 0x0200,
  Slashing     = 0x0400,
  Piercing     = 0x0800,
  Nether       = 0x1000,
}

/**
 * PhysicsDescriptionFlag — per ACE PhysicsDescriptionFlag.cs. Flags enum.
 *
 * Server-sent uint32 at the START of CreateObject's physics description
 * block — bit set ⇔ corresponding sub-field is present in the wire data.
 * Reading order is fixed by ACE source (WorldObject_Networking.cs:288+).
 *
 * Timestamps (0x000400) is reserved in the enum but the 9 ushort sequence
 * timestamps are always serialized unconditionally at the end of the
 * physics block, NOT gated by this flag. The bit exists only to preserve
 * a reserved slot in the [Flags] enum's bit layout.
 */
export enum PhysicsDescriptionFlag {
  None                   = 0x000000,
  CSetup                 = 0x000001,  // model resource (0x02xxxxxx)
  MTable                 = 0x000002,  // motion table (0x09xxxxxx)
  Velocity               = 0x000004,
  Acceleration           = 0x000008,
  Omega                  = 0x000010,
  Parent                 = 0x000020,
  Children               = 0x000040,
  ObjScale               = 0x000080,
  Friction               = 0x000100,
  Elasticity             = 0x000200,
  Timestamps             = 0x000400,  // reserved; not a conditional field
  STable                 = 0x000800,  // sound table (0x20xxxxxx)
  PeTable                = 0x001000,  // physics effect table
  DefaultScript          = 0x002000,
  DefaultScriptIntensity = 0x004000,
  Position               = 0x008000,
  Movement               = 0x010000,
  AnimationFrame         = 0x020000,
  Translucency           = 0x040000,
}
