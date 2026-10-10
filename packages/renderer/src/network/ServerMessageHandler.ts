/**
 * ServerMessageHandler — dispatches all server messages to typed handlers.
 *
 * Routes GameEvent (0xF7B0), direct messages, and property updates
 * through a centralized event system so the rest of the client can
 * subscribe to specific message types without touching the raw network layer.
 */

import {
  GameMessageOpcode,
  GameEventType,
  getGameEventTypeName,
  BinaryReader,
  parseCreateObject,
  parseApproachVendor,
  parseFellowshipFullUpdate,
  parseFellowshipUpdateFellow,
  parseAllegianceUpdate,
  parseFriendsListUpdate,
  parseEnchantmentData,
  parseEnchantmentFromReader,
  parseViewContents,
} from '@ac/network';
import type { GameMessage, GameEventMessage, DirectMessage, CreateObjectData, ApproachVendorData, FellowshipData, FellowData, AllegianceData, FriendsListData, ViewContentsItem } from '@ac/network';
import { PositionFlags, IdentifyResponseFlags, AllegianceIndex, CreatureProfileFlags, ChatNetworkBlobType, ChessMoveType } from '@ac/shared';

// ─── Event types emitted by the handler ───────────────────────────

export interface UpdatePositionData {
  guid: number;
  flags: number;
  landblock: number;
  x: number; y: number; z: number;
  rw: number; rx: number; ry: number; rz: number;
  velocityX?: number; velocityY?: number; velocityZ?: number;
  instanceSequence: number;
  positionSequence: number;
  teleportSequence: number;
  forcePositionSequence: number;
}

export interface AutonomousPositionData {
  guid: number;
  x: number; y: number; z: number;
  rw: number; rx: number; ry: number; rz: number;
  instanceSequence: number;
  serverControlSequence: number;
  teleportSequence: number;
  forcePositionSequence: number;
  contact: number;
}

export interface ObjectDeleteData {
  guid: number;
  instanceSequence: number;
}

export interface MovementEventData {
  guid: number;
  movementData: Uint8Array; // raw InterpretedMotionState for later parsing
  instanceSequence: number;
}

export interface SetStateData {
  guid: number;
  /** Per ACE `PhysicsState` flags enum — current physics state bitfield. */
  physicsState: number;
  /** Per ACE `Sequence.SequenceType.ObjectInstance` — increments when an
   *  object is re-created in place; consumers gate state writes against
   *  it to drop stale updates from a prior incarnation. Wire type is
   *  ushort (2 bytes) per `SequenceManager.cs:170-171` → UShortSequence. */
  instanceSequence: number;
  /** Per ACE `Sequence.SequenceType.ObjectState` — per-object monotonic
   *  counter the original AC client used to discard stale physics-state
   *  packets. Pre-FAITHFUL.338 this field was never read (cursor stopped
   *  2 bytes early — the parser read instanceSequence then bailed).
   *  Consumers that don't sequence-check can ignore this value. Wire
   *  type is ushort (2 bytes), same as instanceSequence. */
  stateSequence: number;
}

export interface SoundEventData {
  guid: number;
  soundId: number;
  volume: number;
}

/**
 * PlayScriptId (0xF754): guid + a PhysicsScript DID (0x33…) the object plays
 * directly (retail SmartBox::HandlePlayScriptID @ 00452020). Not the
 * PScriptType enum — that is PlayEffect (0xF755, PlayEffectData).
 */
export interface PlayScriptData {
  guid: number;
  scriptId: number;
}

export interface HearSpeechData {
  message: string;
  senderName: string;
  senderGuid: number;
  chatType: number;
  /**
   * FAITHFUL.336 — present only for ranged speech (HearRangedSpeech, opcode
   * 0x02BC). Per ACE GameMessageHearRangedSpeech.cs the wire format inserts
   * a `float range` field between senderID and chatMessageType. Local /say
   * doesn't carry this field. Distance in world units (meters) at which the
   * speech was emitted — useful for fade-with-distance text rendering.
   *
   * Pre-FAITHFUL.336 the parser used the same shape for both Speech and
   * RangedSpeech, which meant for /shout (ranged) the bits of `range` were
   * read as `chatType` and the actual chatType was never read at all.
   * Float32 bit patterns like 0x43480000 (200.0) don't match any
   * ChatMessageType enum, so /shout messages rendered with the default
   * grey color instead of the canonical retail color.
   */
  range?: number;
}

export interface PropertyUpdateData {
  guid: number;
  key: number;
  value: number | bigint | boolean | string;
}

export interface VitalUpdateData {
  sequence: number;
  key: number;
  value: number;
  // For PrivateUpdateVital (full): also has initLevel, levelFromCP, cpSpent
  initLevel?: number;
  levelFromCP?: number;
  cpSpent?: number;
}

export interface AttributeUpdateData {
  sequence: number;
  key: number;
  initLevel: number;
  levelFromCP: number;
  cpSpent: number;
}

export interface SkillUpdateData {
  sequence: number;
  key: number;
  advancementClass: number;
  points: number;
  initLevel?: number;
  levelFromCP?: number;
  cpSpent?: number;
  resistanceOfLastCheck?: number;
  lastUsedTime?: number;
}

export interface UpdateHealthData {
  guid: number;
  healthFraction: number;
}

export interface CombatNotificationData {
  attackerName: string;
  defenderName: string;
  damageType: number;
  severity: number;
  damage: number;
  bodyPart: number;
  critical: boolean;
  attackConditions: number;
}

export interface BookPageData {
  authorId: number;
  authorName: string;
  /** False when the text was not sent (ACE never sends it with BookData): the client asks per page. */
  textIncluded: boolean;
  /** Anyone may edit the page (Book.cs IgnoreAuthor). */
  ignoreAuthor: boolean;
  pageText: string;
}

export interface BookDataResponse {
  bookGuid: number;
  maxPages: number;
  pages: BookPageData[];
  inscription: string;
  /** The scribe's guid (0 = none): gmBookUI titles a scribed book with its inscription. */
  inscriptionAuthorId: number;
  inscriptionAuthor: string;
}

/**
 * Single-page read response, per GameEventBookPageDataResponse.cs:
 *   bookID u32 + pageIndex int32 + authorId u32 + authorName String16L
 *   + authorAccount String16L (hidden for non-admins) + flags u32 (0xFFFF0002)
 *   + textIncluded u32 + ignoreAuthor u32 + pageText String16L.
 * Sent by Player_Book.cs ReadBookPage in reply to GameActionType.BookPageData.
 */
export interface BookPageDataResponse {
  bookGuid: number;
  pageIndex: number;
  authorId: number;
  authorName: string;
  ignoreAuthor: boolean;
  pageText: string;
}

/**
 * Wire format shared by BookAddPageResponse/BookModifyPageResponse/BookDeletePageResponse
 * per GameEventBookAddPageResponse.cs/GameEventBookModifyPageResponse.cs/GameEventBookDeletePageResponse.cs:
 *   bookGuid u32 + page int32 (0-based) + success uint32 (bool).
 */
export interface BookPageEditResponse {
  bookGuid: number;
  page: number;
  success: boolean;
}

/**
 * Per-contract tracker entry. Wire format per ACE
 * reference/ACE/Source/ACE.Server/Network/Structure/ContractTracker.cs:
 *   Version u32 + ContractId u32 + Stage u32 + TimeWhenDone f64 + TimeWhenRepeats f64.
 * Stages: Available=1, InProgress=2, DoneOrPendingRepeat=3, ProgressCounter=4+ (with offset).
 */
export interface ContractTrackerEntry {
  version: number;
  contractId: number;
  stage: number;
  timeWhenDone: number;
  timeWhenRepeats: number;
}

export interface IdentifyResponseData {
  guid: number;
  flags: number;
  /** The appraisal succeeded (wire uint32 after the flags). Absent in hand-built data = treat as success. */
  success?: boolean;
  propertiesInt?: Map<number, number>;
  propertiesInt64?: Map<number, bigint>;
  propertiesBool?: Map<number, boolean>;
  propertiesFloat?: Map<number, number>;
  propertiesString?: Map<number, string>;
  propertiesDataID?: Map<number, number>;
  propertiesInstanceID?: Map<number, number>;
  /** Intrinsic spells on the item (plain spell IDs from the SpellBook section). */
  spellBook?: number[];
  /**
   * Active enchantments currently applied to this item (spell IDs with the
   * 0x80000000 EnchantmentMask bit stripped). Per ACE AppraiseInfo.cs:21.
   */
  activeEnchantments?: number[];
  /**
   * Weapon appraisal panel — flag 0x0020, wire format per
   * reference/ACE/Source/ACE.Server/Network/Structure/WeaponProfile.cs.
   * Numbers already include enchantments folded in by the server.
   */
  weaponProfile?: {
    damageType: number;
    weaponTime: number;            // speed (lower = faster)
    weaponSkill: number;            // ACE Skill enum
    damage: number;                 // max damage
    damageVariance: number;
    damageMod: number;
    weaponLength: number;
    maxVelocity: number;
    weaponOffense: number;
    maxVelocityEstimated: number;
  };
  /**
   * Armor appraisal panel — flag 0x0080, wire format per
   * reference/ACE/Source/ACE.Server/Network/Structure/ArmorProfile.cs.
   * Each float is effective resistance level (typically -2.0..+2.0).
   * Order MUST match ACE: Slashing, Piercing, Bludgeoning, Cold, Fire, Acid, Nether, Lightning.
   */
  armorProfile?: {
    slashing: number;
    piercing: number;
    bludgeoning: number;
    cold: number;
    fire: number;
    acid: number;
    nether: number;
    lightning: number;
  };
  /**
   * Creature appraisal panel — flag 0x0100, wire format per
   * reference/ACE/Source/ACE.Server/Network/Structure/CreatureProfile.cs.
   * Always includes Health/HealthMax; attributes appear only when assess
   * succeeded (CreatureProfileFlags.ShowAttributes = 0x8).
   */
  creatureProfile?: {
    profileFlags: number;
    health: number; healthMax: number;
    // Present iff profileFlags & CreatureProfileFlags.ShowAttributes
    attributes?: {
      strength: number; endurance: number; quickness: number;
      coordination: number; focus: number; self: number;
      stamina: number; mana: number; staminaMax: number; manaMax: number;
    };
    // Present iff profileFlags & CreatureProfileFlags.HasBuffsDebuffs
    attributeHighlights?: number; attributeColors?: number;
  };
  /**
   * Hook profile — flag 0x0040, 12 bytes per HookProfile.cs:
   * HookFlags u32 + ValidLocations u32 (EquipMask) + AmmoType u32.
   */
  hookProfile?: {
    hookFlags: number;       // Inscribable=0x1, IsHealer=0x2, IsFood=0x4, IsLockpick=0x8
    validLocations: number;  // EquipMask
    ammoType: number;        // AmmoType enum
  };
  /** Armor enchantment bitfield — flag 0x0200, 2 u16s. */
  armorEnchantment?: { highlight: number; color: number };
  /** Weapon enchantment bitfield — flag 0x0800, 2 u16s. */
  weaponEnchantment?: { highlight: number; color: number };
  /** Resist enchantment bitfield — flag 0x0400, 2 u16s. */
  resistEnchantment?: { highlight: number; color: number };
  /**
   * Per-body-part armor levels — flag 0x4000, 9 × uint32 per ArmorLevel.cs.
   * Used by the character-panel armor breakdown.
   * Order: Head, Chest, Abdomen, UpperArm, LowerArm, Hand, UpperLeg, LowerLeg, Foot.
   * ACE adds 9999 to any body part with all-unenchantable layers so the client
   * displays an asterisk ("AL 250*"). Consumers should mask off that bit before
   * showing the numeric value.
   */
  armorLevels?: {
    head: number; chest: number; abdomen: number;
    upperArm: number; lowerArm: number; hand: number;
    upperLeg: number; lowerLeg: number; foot: number;
  };
}

export interface TurbineChatData {
  type: number;
  channelId: number;
  senderName: string;
  message: string;
  senderGuid: number;
  isSystemMessage: boolean;
  /** ACE chatNetworkBlobDispatchType — added FAITHFUL.169. Usually 1 for SendToRoomChatEvent. */
  blobDispatchType?: number;
  /** ACE ChatType enum (allegiance/general/trade/LFG/...) — added FAITHFUL.169. */
  chatType?: number;
}

export interface TransientStringData {
  message: string;
}

/** One character-squelch entry from GameEventSetSquelchDB — SquelchInfo.cs's
 *  Filters list always repeats a single mask value 4x (SquelchInfo's
 *  single-filter constructor), so only the first is kept. */
export interface SquelchEntry {
  name: string;
  mask: number;
  /** SquelchInfo.Account — ACE SquelchDB.cs ships account squelches inside
   *  the Characters table flagged Account=true; the retail squelch panel's
   *  "Type" column (Character/Account, states 0x10000056/57 on layout
   *  0x21000060's row template) and its account-aware Remove button key
   *  off this flag. */
  account: boolean;
}

export interface SetSquelchDBData {
  entries: SquelchEntry[];
  /** Player.SquelchGlobal — the account-wide `/filter` mask, sent as the
   *  trailing Globals SquelchInfo (0 filters when unset). */
  globalMask: number;
}

export interface TellData {
  message: string;
  senderName: string;
  /** Sender's ObjectGuid (per ACE GameEventTell.cs WriteGuid(senderID)). */
  senderGuid: number;
  /** Target's ObjectGuid (the local player when this arrives — useful for
   *  multi-character clients distinguishing which character the tell was
   *  routed to). Per ACE GameEventTell.cs WriteGuid(targetID).
   *
   *  Pre-FAITHFUL.334 this field was skipped and the next field
   *  (`chatMessageType`) was mis-read as `chatType` — meaning `chatType`
   *  actually carried the targetID guid value, never the chat color
   *  type. Nothing consumed it so no visible bug, but future readers
   *  expecting an enum value would have gotten a random uint32. */
  targetGuid: number;
  /** ACE ChatMessageType enum (e.g. Tell, OutgoingTell, AllegianceTell).
   *  Per ACE GameEventTell.cs Write((uint)chatMessageType). */
  chatType: number;
}

export interface ObjDescEventData {
  guid: number;
  basePalette: number;
  subPalettes: { paletteId: number; offset: number; length: number }[];
  textureChanges: { partIndex: number; oldTexture: number; newTexture: number }[];
  animPartChanges: { partIndex: number; partId: number }[];
  /** ObjectInstance sequence at time of the desc change (per ACE SerializeUpdateModelData). */
  instanceSequence: number;
  /** ObjectVisualDesc sequence after the change is applied. */
  visualDescSequence: number;
}

/**
 * Wire format from ACE GameMessageParentEvent.cs:
 *   creatureGuid (uint32) — the wearer/holder (player or creature)
 *   wieldedGuid  (uint32) — the item being parented (weapon, shield, ...)
 *   parentLocation (uint32)  — ParentLocation enum (RightHand=1, LeftHand=2, Shield=3, ...)
 *   placement      (uint32)  — Placement enum (idle pose, etc.)
 *   instanceSequence (uint32) — wearer's ObjectInstance sequence at this event
 *   positionSequence (uint32) — wielded item's ObjectPosition sequence at this event
 */
export interface ParentEventData {
  creatureGuid: number;
  wieldedGuid: number;
  parentLocation: number;
  placement: number;
  instanceSequence: number;
  positionSequence: number;
}

export interface InventoryPutData {
  itemGuid: number;
  containerGuid: number;
  slot: number;
  itemType: number;
}

export interface WieldObjectData {
  itemGuid: number;
  location: number;
}

export interface VendorInfoData {
  vendorGuid: number;
  parsed: ApproachVendorData | null;
  rawPayload: Uint8Array;
}

export interface PlayerDescriptionData {
  rawPayload: Uint8Array; // Full PlayerDescription is complex — parse incrementally
}

// ─── Handler callback map ─────────────────────────────────────────

type HandlerFn<T = void> = T extends void ? () => void : (data: T) => void;

export interface ServerMessageHandlers {
  // Connection lifecycle (from direct messages, forwarded by ClientConnection)
  onPlayerCreate?: (payload: Uint8Array) => void;
  onObjectCreate?: (data: CreateObjectData) => void;
  /**
   * UpdateObject (0xF7DB) — same wire format as ObjectCreate (ACE
   * WorldObject_Networking.cs:28-32 `SerializeUpdateObject` literally calls
   * `SerializeCreateObject`). Semantically: "refresh an existing object" vs
   * ObjectCreate's "new object." Fires from Tailoring, Aetheria, RecipeManager,
   * Hook, generic WorldObject (any object whose desc changes), Player (admin
   * vision toggle).
   */
  onObjectUpdate?: (data: CreateObjectData) => void;
  onObjectDelete?: HandlerFn<ObjectDeleteData>;

  // Position & movement
  onUpdatePosition?: HandlerFn<UpdatePositionData>;
  onMovementEvent?: HandlerFn<MovementEventData>;
  onSetState?: HandlerFn<SetStateData>;
  onPlayerTeleport?: HandlerFn<void>;
  onAutonomousPosition?: HandlerFn<AutonomousPositionData>;
  onParentEvent?: HandlerFn<ParentEventData>;

  // Appearance
  onObjDescEvent?: HandlerFn<ObjDescEventData>;

  // Sound & effects
  onSound?: HandlerFn<SoundEventData>;
  onPlayScript?: HandlerFn<PlayScriptData>;
  onPlayEffect?: HandlerFn<{ guid: number; effectId: number; scale: number }>;

  // Chat & text
  onHearSpeech?: HandlerFn<HearSpeechData>;
  onHearRangedSpeech?: HandlerFn<HearSpeechData>;
  onTurbineChat?: HandlerFn<TurbineChatData>;
  onTransientString?: HandlerFn<TransientStringData>;
  onTell?: HandlerFn<TellData>;
  onEmoteText?: HandlerFn<{ senderGuid: number; senderName: string; message: string }>;
  onSoulEmote?: HandlerFn<{ senderGuid: number; senderName: string; message: string }>;

  // Player property updates
  onPrivateUpdatePropertyInt?: HandlerFn<PropertyUpdateData>;
  onPrivateUpdatePropertyInt64?: HandlerFn<PropertyUpdateData>;
  onPrivateUpdatePropertyBool?: HandlerFn<PropertyUpdateData>;
  onPrivateUpdatePropertyFloat?: HandlerFn<PropertyUpdateData>;
  onPrivateUpdatePropertyString?: HandlerFn<PropertyUpdateData>;
  onPrivateUpdatePropertyDataID?: HandlerFn<PropertyUpdateData>;
  onPrivateUpdatePropertyInstanceID?: HandlerFn<PropertyUpdateData>;

  // Public property updates (for other objects)
  onPublicUpdatePropertyInt?: HandlerFn<PropertyUpdateData>;
  onPublicUpdatePropertyInt64?: HandlerFn<PropertyUpdateData>;
  onPublicUpdatePropertyBool?: HandlerFn<PropertyUpdateData>;
  onPublicUpdatePropertyFloat?: HandlerFn<PropertyUpdateData>;
  onPublicUpdatePropertyString?: HandlerFn<PropertyUpdateData>;
  onPublicUpdatePropertyDataID?: HandlerFn<PropertyUpdateData>;
  onPublicUpdatePropertyInstanceID?: HandlerFn<PropertyUpdateData>;

  // Session/account lifecycle (FAITHFUL.168)
  onAccountBoot?: HandlerFn<{ reason: string }>;
  onAccountBanned?: HandlerFn<{ secondsUntilExpiry: number; reason: string }>;
  onCharacterDelete?: HandlerFn<void>;
  onCharacterLogOff?: HandlerFn<void>;
  onPrivateUpdatePosition?: HandlerFn<{
    sequence: number;
    positionType: number;
    landblockId: number;
    x: number; y: number; z: number;
    qw: number; qx: number; qy: number; qz: number;
  }>;
  /**
   * FAITHFUL.581 — `GameMessagePublicUpdatePosition` (0x02DC) shipped for
   * non-local objects. Same shape as PrivateUpdatePosition but with a `guid`
   * sandwiched between the sequence prefix and the positionType — server
   * uses it to broadcast Sanctuary/recall destination updates for visible
   * characters (e.g. ally moves their lifestone, you see the marker on
   * the radar move). Wire per ACE
   * `GameMessagePublicUpdatePosition.cs`: u8 seq + u32 guid + u32 type +
   * Position blob (landblock u32 + 3 f32 + quaternion 4 f32).
   */
  onPublicUpdatePosition?: HandlerFn<{
    sequence: number;
    guid: number;
    positionType: number;
    landblockId: number;
    x: number; y: number; z: number;
    qw: number; qx: number; qy: number; qz: number;
  }>;
  onAdminEnvirons?: HandlerFn<{ environChangeType: number }>;

  // Physics state for visible objects (broadcast/smartbox queue)
  onVectorUpdate?: HandlerFn<{
    guid: number;
    velocity: { x: number; y: number; z: number };
    omega: { x: number; y: number; z: number };
    instanceSequence: number;
    vectorSequence: number;
  }>;
  onPickupEvent?: HandlerFn<{
    guid: number;
    instanceSequence: number;
    positionSequence: number;
  }>;

  // Vitals/attributes/skills
  onPrivateUpdateVital?: HandlerFn<VitalUpdateData>;
  onPrivateUpdateAttribute2ndLevel?: HandlerFn<VitalUpdateData>;
  onPrivateUpdateAttribute?: HandlerFn<AttributeUpdateData>;
  onPrivateUpdateSkill?: HandlerFn<SkillUpdateData>;

  /**
   * FAITHFUL.581 — `GameMessagePublicUpdateVital` (0x02E8) ships OTHER
   * objects' (fellowship members, summoned pets, visible NPCs) vital
   * changes. Wire per ACE: u8 seq + u32 guid + u32 Attribute2nd + u32
   * ranks + u32 baseValue + u32 totalInvestment + u32 currentValue.
   * Lets us live-update fellow vital bars + pet health between bulk
   * FellowshipUpdateFellow broadcasts.
   */
  onPublicUpdateVital?: HandlerFn<{
    sequence: number;
    guid: number;
    attribute: number;     // PropertyAttribute2nd
    ranks: number;
    baseValue: number;
    totalInvestment: number;
    currentValue: number;
  }>;

  // GameEvent handlers (eventType-specific)
  onPlayerDescription?: HandlerFn<PlayerDescriptionData>;
  onUpdateHealth?: HandlerFn<UpdateHealthData>;
  onIdentifyResponse?: HandlerFn<IdentifyResponseData>;
  onInventoryPut?: HandlerFn<InventoryPutData>;
  onWieldObject?: HandlerFn<WieldObjectData>;
  onInventoryPutIn3D?: HandlerFn<{ itemGuid: number }>;
  onApproachVendor?: HandlerFn<VendorInfoData>;
  onUseDone?: HandlerFn<{ errorType: number }>;

  // Title events
  onCharacterTitle?: HandlerFn<{ activeTitleId: number; titleIds: number[] }>;
  onUpdateTitle?: HandlerFn<{ titleId: number; setAsDisplay: boolean }>;

  // Book events
  onBookData?: HandlerFn<BookDataResponse>;
  onBookPageData?: HandlerFn<BookPageDataResponse>;
  onBookAddPageResponse?: HandlerFn<BookPageEditResponse>;
  onBookModifyPageResponse?: HandlerFn<BookPageEditResponse>;
  onBookDeletePageResponse?: HandlerFn<BookPageEditResponse>;

  // Combat events
  onAttackerNotification?: HandlerFn<CombatNotificationData>;
  onDefenderNotification?: HandlerFn<CombatNotificationData>;
  onEvasionAttacker?: HandlerFn<{ targetName: string }>;
  onEvasionDefender?: HandlerFn<{ attackerName: string }>;
  /**
   * GameEventVictimNotification.cs — wire format is JUST the deathMessage
   * string. ACE does not ship a killer guid in this private notification
   * (the killer's name is already embedded in the death message text).
   *
   * GameMessagePlayerKilled (broadcast) DOES ship victim+killer guids but
   * routes to onPlayerKilled below (separate handler), not here.
   */
  onVictimNotification?: HandlerFn<{ message: string }>;
  /**
   * GameEventKillerNotification.cs — wire format is JUST the deathMessage
   * string. ACE does not ship a victim guid or an XP-granted field.
   * (Pre-FAITHFUL.333 we invented a bogus `victimGuid` + `xpGranted` by
   * reading bytes past the end of the payload — the "earned X experience
   * points" chat line consumed garbage data.) The actual XP-on-kill chat
   * line is emitted separately by ACE via GameMessageSystemChat with
   * ChatMessageType.Advancement, which already routes through
   * onServerMessage in our existing dispatcher.
   */
  onKillerNotification?: HandlerFn<{ message: string }>;
  /**
   * GameMessagePlayerKilled (direct opcode 0x019E) — broadcast to all
   * observers in the death zone. Wire: `deathMessage` string + victim
   * ObjectGuid + killer ObjectGuid (per `GameMessagePlayerKilled.cs`).
   * Separate from VictimNotification because retail had a real need to
   * distinguish "your own death (private)" from "someone else died
   * nearby (broadcast)" — different chat colors.
   */
  onPlayerKilled?: HandlerFn<{ message: string; victimGuid: number; killerGuid: number }>;
  onAttackDone?: HandlerFn<{ errorType: number }>;
  onCombatCommenceAttack?: HandlerFn<void>;
  /**
   * GameEventAllegianceAllegianceUpdateDone (0x01C8) — end-of-update flush
   * sentinel from Player_Allegiance.cs / Allegiance.cs / AllegianceManager.cs.
   * Wire: uint32 WeenieError errorType (per GameEventAllegianceAllegianceUpdateDone.cs).
   * Every live stock-ACE call site currently passes WeenieError.None (0) and
   * ships a separate GameEventWeenieError on real failure, so this is
   * observably benign against stock ACE today — but the field is real, not
   * deprecated, so we read and surface it rather than discarding it.
   */
  onAllegianceUpdateDone?: HandlerFn<{ errorType: number }>;

  /** FAITHFUL.272 — ack for an outbound GameActionPingRequest. The packet
   *  carries no payload (per GameEventPingResponse.cs, size=4 is just the
   *  event header); the round-trip arrival time IS the signal. main.ts
   *  uses this to drive the 'server-load' HUD indicator off ping latency. */
  onPingResponse?: HandlerFn<void>;

  // Magic
  onMagicUpdateSpell?: HandlerFn<{ spellId: number }>;
  onMagicUpdateEnchantment?: HandlerFn<{ enchantment: import('@ac/network').EnchantmentData | null; rawPayload: Uint8Array }>;
  onMagicRemoveEnchantment?: HandlerFn<{ spellId: number; layerId: number }>;
  onMagicRemoveMultipleEnchantments?: HandlerFn<{ enchantments: Array<{ spellId: number; layerId: number }> }>;
  onMagicPurgeEnchantments?: HandlerFn<void>;
  /**
   * `GameEventMagicPurgeBadEnchantments.cs:7-10` — "Silently remove all
   * negative enchantments from a player." Distinct from
   * MagicPurgeEnchantments (which wipes ALL); the Bad variant should
   * leave beneficial buffs intact. FAITHFUL.350.
   */
  onMagicPurgeBadEnchantments?: HandlerFn<void>;
  /**
   * FAITHFUL.362 — ACE `SquelchManager.cs:295` ships SetSquelchDB on
   * login + after each squelch-state change. Carries the full list of
   * character names the player has squelched (via the
   * `Character.PropertiesSquelch` server-side persistence), each with its
   * per-channel SquelchMask, plus the account-wide `globalMask` from
   * `Player.SquelchGlobal` (the `/filter` command). Used by the client to
   * populate its local `SquelchState` so both restore correctly across
   * re-logins without the user re-issuing /squelch add or /filter.
   * Wire format per `SquelchDB.cs:158-198` + `SquelchInfo.cs:50-65`.
   */
  onSetSquelchDB?: HandlerFn<SetSquelchDBData>;
  /**
   * FAITHFUL.363 — Per-player dynamic chat channel IDs sent by ACE
   * `GameEventSetTurbineChatChannels.cs:7-21` at login. The fixed 2-10
   * channel IDs (General/Trade/LFG/Roleplay/Olthoi + 3 societies) come
   * from `TurbineChatChannel.cs` constants; allegiance + society IDs
   * are unique per player and are needed to label incoming
   * ChannelBroadcast/TurbineChat messages whose channelId would
   * otherwise fall back to a generic "Allegiance" label.
   */
  onSetTurbineChatChannels?: HandlerFn<{ allegiance: number; society: number }>;
  /** GameEventMagicRemoveSpell.cs: spellbook entry removed (e.g. spell item expired). */
  onMagicRemoveSpell?: HandlerFn<{ spellId: number; layer: number }>;
  /** GameEventMagicUpdateMultipleEnchantments.cs: bulk enchantment refresh (login sync). */
  onMagicUpdateMultipleEnchantments?: HandlerFn<{
    enchantments: Array<import('@ac/network').EnchantmentData>;
  }>;

  // Inventory events
  onViewContents?: HandlerFn<{ containerGuid: number; items: ViewContentsItem[] }>;
  /** GameEventCloseGroundContainer.cs: ground/corpse container closed by server. */
  onCloseGroundContainer?: HandlerFn<{ containerGuid: number }>;
  /**
   * GameMessageSetStackSize (0x0197): broadcast when a stack's StackSize property
   * changes. Sent after splits, merges, partial consumption (arrows, components,
   * food), vendor buy/sell across an existing stack, etc.
   * Per ACE: writer.Write(sequence), WriteGuid(guid), Write((uint)StackSize),
   * Write((uint)Value).
   */
  onSetStackSize?: HandlerFn<{ sequence: number; guid: number; stackSize: number; value: number }>;
  /**
   * GameMessageInventoryRemoveObject (0x0024): item left inventory via
   * consume/destroy (TryConsumeFromInventoryWithNetworking), give, spend, or
   * corpse-transfer-on-death (Player_Inventory.cs:124,226,3096 and
   * TryRemoveFromInventoryWithNetworking's GiveItem/SpendItem/ToCorpseOnDeath
   * cases). NOT sent for ground drops — that's the separate
   * GameEventInventoryPutObjectIn3D (onInventoryPutIn3D), which plays the
   * drop chime. Distinct handler so consume/give/corpse-transfer don't
   * incorrectly play the ground-drop sound.
   */
  onInventoryRemove?: HandlerFn<{ itemGuid: number }>;

  // Fellowship
  onFellowshipFullUpdate?: HandlerFn<{ parsed: FellowshipData | null; rawPayload: Uint8Array }>;
  onFellowshipDisband?: HandlerFn<void>;
  onFellowshipUpdateFellow?: HandlerFn<{ fellow: FellowData | null; updateType: number; rawPayload: Uint8Array }>;

  // Allegiance
  onAllegianceUpdate?: HandlerFn<{ parsed: AllegianceData | null; rawPayload: Uint8Array }>;
  /** GameEventAllegianceLoginNotification.cs: allegiance member came online or went offline. */
  onAllegianceLoginNotification?: HandlerFn<{ playerGuid: number; isLoggedIn: boolean }>;

  // Friends
  onFriendsListUpdate?: HandlerFn<{ parsed: FriendsListData | null; rawPayload: Uint8Array }>;

  // Server messages
  onServerMessage?: HandlerFn<{ message: string; chatType: number }>;
  onPopupString?: HandlerFn<{ message: string }>;
  onWeenieError?: HandlerFn<{ errorType: number }>;
  onWeenieErrorWithString?: HandlerFn<{ errorType: number; message: string }>;
  onCommunicationTransientString?: HandlerFn<TransientStringData>;

  // Trade negotiation (player↔player). Per ACE GameEvent*Trade.cs.
  onRegisterTrade?: HandlerFn<{ initiatorGuid: number; partnerGuid: number }>;
  onAddToTrade?: HandlerFn<{ objectGuid: number; tradeSide: number; slot: number }>;
  onAcceptTradeEvt?: HandlerFn<{ whoAcceptedGuid: number }>;
  onDeclineTradeEvt?: HandlerFn<{ whoDeclinedGuid: number }>;
  onResetTradeEvt?: HandlerFn<{ whoResetGuid: number }>;
  onCloseTradeEvt?: HandlerFn<{ endReason: number }>;
  onClearTradeAcceptance?: HandlerFn<void>;
  onTradeFailure?: HandlerFn<{ objectGuid: number; reason: number }>;

  // Salvage (Ust/tinkering-tool result). Per ACE GameEventSalvageOperationsResult.cs.
  onSalvageResult?: HandlerFn<{
    skill: number;
    bonusSalvage: number;
    results: Array<{ materialType: number; workmanship: number; units: number }>;
  }>;

  // Housing — primary status & rent events (simple wire formats parsed here).
  // The struct-based events (HouseProfile, HouseData, UpdateHAR, UpdateRentPayment,
  // HouseUpdateRestrictions) carry rich nested payloads (HouseProfile, HouseAccess,
  // RestrictionDB, HousePayment list); they currently surface as raw payload until
  // structured parsers land.
  onHouseStatus?: HandlerFn<{ weenieError: number }>;
  onHouseUpdateRentTime?: HandlerFn<{ rentTime: number }>;
  onHouseTransaction?: HandlerFn<{ noticeType: number }>;
  onHouseAvailableHouses?: HandlerFn<{
    houseType: number;
    locations: number[];
    totalAvailable: number;
  }>;
  onHouseProfileRaw?: HandlerFn<{ crystalGuid: number; rawPayload: Uint8Array }>;

  // Fully-parsed HouseProfile per
  // reference/ACE/Source/ACE.Server/Network/Structure/HouseProfile.cs.
  onHouseProfile?: HandlerFn<{
    crystalGuid: number;
    dwellingId: number;
    ownerId: number;
    bitmask: number;           // HouseBitfield flags
    minLevel: number; maxLevel: number;     // -1 if no requirement
    minAllegRank: number; maxAllegRank: number;
    maintenanceFree: boolean;
    houseType: number;
    ownerName: string;
    buy: Array<{ num: number; paid: number; weenieId: number; name: string; pluralName: string }>;
    rent: Array<{ num: number; paid: number; weenieId: number; name: string; pluralName: string }>;
  }>;
  onHouseDataRaw?: HandlerFn<{ rawPayload: Uint8Array }>;

  // Fully-parsed HouseData per reference/ACE/Source/ACE.Server/Network/Structure/HouseData.cs:
  //   BuyTime u32 + RentTime u32 + HouseType u32 + MaintenanceFree u32 (bool)
  //   + Buy List<HousePayment> + Rent List<HousePayment> + Position (Cell + Vec3 + Quat).
  onHouseData?: HandlerFn<{
    buyTime: number;        // unix timestamp when purchased
    rentTime: number;       // unix timestamp when current maintenance period began
    houseType: number;      // 1=cottage, 2=villa, 3=mansion, 4=apartment
    maintenanceFree: boolean;
    buy: Array<{ num: number; paid: number; weenieId: number; name: string; pluralName: string }>;
    rent: Array<{ num: number; paid: number; weenieId: number; name: string; pluralName: string }>;
    position: {
      cell: number;
      x: number; y: number; z: number;
      rw: number; rx: number; ry: number; rz: number;
    };
  }>;
  onHouseUpdateHARRaw?: HandlerFn<{ rawPayload: Uint8Array }>;

  // Fully-parsed UpdateHAR (house access records / guest list) per
  // reference/ACE/Source/ACE.Server/Network/Structure/HouseAccess.cs:
  //   Version u32 + Bitmask u32 + MonarchID u32 + GuestList Dict<ObjectGuid, GuestInfo> + Roommates List<ObjectGuid>.
  // openStatus is decoded here (HARBitfield.OpenHouse = 0x1) to match the
  // sibling onHouseUpdateRestrictions handler, which decodes its own
  // openStatus bit at parse time rather than leaving it to the consumer.
  onHouseUpdateHAR?: HandlerFn<{
    version: number;
    bitmask: number;
    openStatus: boolean;
    monarchId: number;
    guests: Array<{ guid: number; storageAccess: boolean; name: string }>;
    roommates: number[];
  }>;
  onHouseUpdateRestrictionsRaw?: HandlerFn<{
    sequence: number; objectGuid: number; rawPayload: Uint8Array;
  }>;

  // Fully-parsed restriction-db update per
  // reference/ACE/Source/ACE.Server/Network/Structure/RestrictionDB.cs.
  // Per-user permission table: 0 = dwelling access, 1 = storage access too.
  onHouseUpdateRestrictions?: HandlerFn<{
    sequence: number;
    objectGuid: number;
    version: number;
    openStatus: boolean;
    monarchId: number;
    permissions: Array<{ playerGuid: number; storageAccess: boolean }>;
  }>;
  onHouseUpdateRentPaymentRaw?: HandlerFn<{ rawPayload: Uint8Array }>;

  // Fully-parsed rent payment list per
  // reference/ACE/Source/ACE.Server/Network/Structure/HousePayment.cs.
  // Each entry: Num int32 + Paid int32 + WeenieID u32 + Name String16L + PluralName String16L.
  onHouseUpdateRentPayment?: HandlerFn<{
    payments: Array<{
      num: number; paid: number; weenieId: number; name: string; pluralName: string;
    }>;
  }>;

  // Portal storm warnings (server tells client about looming portal storms).
  // Per ACE GameEventPortalStorm*.cs.
  onPortalStorm?: HandlerFn<void>;
  onPortalStormBrewing?: HandlerFn<{ extent: number }>;
  onPortalStormImminent?: HandlerFn<{ extent: number }>;
  onPortalStormSubsided?: HandlerFn<void>;

  // Modal confirmation dialogs (trade requests, swearing allegiance, etc.) per ACE GameEventConfirmation*.cs.
  onConfirmationRequest?: HandlerFn<{
    confirmationType: number;
    context: number;
    text: string;
  }>;
  onConfirmationDone?: HandlerFn<{ confirmationType: number; contextId: number }>;

  // Silent enchantment removal (no chat output per ACE comment).
  onMagicDispelEnchantment?: HandlerFn<{ spellId: number; layer: number }>;
  onMagicDispelMultipleEnchantments?: HandlerFn<{
    spells: Array<{ spellId: number; layer: number }>;
  }>;

  // /age command response.
  onQueryAgeResponse?: HandlerFn<{ targetName: string; age: string }>;

  // Barber UI initialization. Per ACE GameEventStartBarber.cs — 14 u32 + 2 int32 (option1, option2).
  onStartBarber?: HandlerFn<{
    paletteBaseDID: number;
    headObjectDID: number;
    hairTexture: number; defaultHairTexture: number;
    eyesTextureDID: number; defaultEyesTextureDID: number;
    noseTextureDID: number; defaultNoseTextureDID: number;
    mouthTextureDID: number; defaultMouthTextureDID: number;
    skinPaletteDID: number; hairPaletteDID: number; eyesPaletteDID: number;
    setupTableId: number;
    option1: number; option2: number;
  }>;

  // /querymana response per GameEventQueryItemManaResponse.cs: target u32 + mana f32 + success u32.
  onQueryItemManaResponse?: HandlerFn<{ targetGuid: number; mana: number; success: number }>;

  // Single-contract update per GameEventSendClientContractTracker.cs.
  // ContractTracker wire: Version u32 + ContractId u32 + Stage u32 + TimeWhenDone f64 + TimeWhenRepeats f64.
  // Then DeleteContract u32 + SetAsDisplayContract u32. Total 36 bytes.
  onContractTracker?: HandlerFn<{
    contract: ContractTrackerEntry;
    deleteContract: boolean;
    setAsDisplayContract: boolean;
  }>;

  // Full contract table dump per GameEventSendClientContractTrackerTable.cs.
  // PackableHashTable header (count u16 + buckets u16) then count × (key u32 + ContractTracker 28 bytes).
  onContractTrackerTable?: HandlerFn<{
    numBuckets: number;
    contracts: Array<{ key: number; entry: ContractTrackerEntry }>;
  }>;

  // Allegiance info response — playerGuid u32 + AllegianceProfile (struct, surfaced raw).
  onAllegianceInfoResponseRaw?: HandlerFn<{ playerGuid: number; rawPayload: Uint8Array }>;

  // Partial structured AllegianceProfile parse per
  //   reference/ACE/Source/ACE.Server/Network/Structure/AllegianceProfile.cs
  //   + Network/Structure/AllegianceHierarchy.cs.
  //
  // Header fields up through approvedVassal are decoded; monarch + records
  // (each a variable-length AllegianceData per AllegianceData.cs) remain in
  // recordsRaw because they're recursive structs with per-record length variance.
  // Consumers that need full hierarchy can drive a follow-up AllegianceData parser
  // over recordsRaw using recordCount.
  onAllegianceInfo?: HandlerFn<{
    playerGuid: number;
    totalMembers: number;
    totalVassals: number;
    recordCount: number;       // monarch + patron + vassals
    oldVersion: number;        // 0x000B in retail
    officers: Array<{ guid: number; officerLevel: number }>;
    officerTitles: string[];
    monarchBroadcastTime: number;
    monarchBroadcastsToday: number;
    spokesBroadcastTime: number;
    spokesBroadcastsToday: number;
    motd: string;
    motdSetBy: string;
    chatRoomId: number;
    bindPoint: {
      cell: number;
      x: number; y: number; z: number;
      rw: number; rx: number; ry: number; rz: number;
    };
    allegianceName: string;
    nameLastSetTime: number;
    isLocked: boolean;
    approvedVassal: number;
    /** Raw bytes for monarchData (if recordCount > 0) + records list. Variable-length per AllegianceData.cs. */
    recordsRaw: Uint8Array;
    /**
     * Fully parsed allegiance records per AllegianceData.cs Write. If recordCount > 0,
     * the FIRST entry is the monarch's data (no preceding treeParent guid); the remaining
     * (recordCount - 1) entries each have a preceding ObjectGuid treeParent identifying
     * who they're swearing to.
     *
     * On parse failure (any record's variable-length name overflows), this is undefined
     * and consumers should fall back to recordsRaw.
     */
    records?: Array<{
      treeParent?: number;       // present for entries after the monarch
      characterID: number;
      cpCached: number;
      cpTithed: number;
      bitfield: number;           // AllegianceIndex flags
      gender: number;             // 1=Male, 2=Female
      heritageGroup: number;
      rank: number;
      level?: number;             // present iff bitfield & 0x8 (HasPackedLevel)
      loyalty: number;
      leadership: number;
      timeOnline?: number;        // present iff bitfield & 0x4 (HasAllegianceAge)
      allegianceAge?: number;     // present iff bitfield & 0x4
      uTimeOnline?: bigint;       // present iff !(bitfield & 0x4)
      name: string;
    }>;
  }>;

  // Chess minigame events. ChessColor enum: None=-1, White=0, Black=1
  // (per reference/ACE/Source/ACE.Entity/Enum/ChessColor.cs). Per ACE
  // GameEventStartGame.cs / GameOver.cs / JoinGameResponse.cs /
  // MoveResponse.cs / OpponentStalemate.cs / OpponentTurn.cs.
  onChessStartGame?: HandlerFn<{ boardGuid: number; color: number }>;
  onChessGameOver?: HandlerFn<{ boardGuid: number; teamWinner: number }>;
  onChessJoinGameResponse?: HandlerFn<{ boardGuid: number; color: number }>;
  onChessMoveResponse?: HandlerFn<{ boardGuid: number; result: number }>;
  onChessOpponentStalemate?: HandlerFn<{
    boardGuid: number; color: number; stalemate: boolean;
  }>;
  onChessOpponentTurnRaw?: HandlerFn<{
    boardGuid: number; color: number; rawMoveData: Uint8Array;
  }>;

  // Structured opponent-turn event per
  // reference/ACE/Source/ACE.Server/Network/Structure/ChessMoveData.cs Write:
  //   moveType int32 + playerGuid u32 + variable body.
  //   moveType values per ChessMoveType (default-indexed C# enum):
  //     Grid=4: to (X i32 + Y i32, 8 bytes).
  //     FromTo=5: from + to ChessPieceCoord (16 bytes). (Only type used in live play.)
  //     SelectedPiece=6: pieceGuid u32.
  onChessOpponentTurn?: HandlerFn<{
    boardGuid: number;
    color: number;
    moveType: number;
    playerGuid: number;
    from?: { x: number; y: number };
    to?: { x: number; y: number };
    pieceGuid?: number;
  }>;

  // Turbine chat channel management.
  // ChannelIndex: 0-3 concatenated (count u32 + N × String16L) blocks — one
  // each for IsAdmin/IsArch-or-Sentinel/IsAdvocate, since those flags aren't
  // mutually exclusive (admin/abuse/audit/etc. channel names).
  // ChannelList: count u32 + N × String16L player names currently on that channel.
  onChannelIndex?: HandlerFn<{ channels: string[] }>;
  onChannelList?: HandlerFn<{ players: string[] }>;

  // Channel chat broadcasts (allegiance, fellowship, society, etc.) — ACE Channel enum.
  onChannelBroadcast?: HandlerFn<{ channel: number; senderName: string; message: string }>;

  // Inventory save error from server (e.g. drop failed mid-transaction).
  onInventoryServerSaveFailed?: HandlerFn<{ itemGuid: number; errorType: number }>;

  // Fellowship membership changes from server.
  onFellowshipQuit?: HandlerFn<{ playerId: number }>;
  onFellowshipDismiss?: HandlerFn<{ playerId: number }>;
}

// ─── Message Handler ──────────────────────────────────────────────

export class ServerMessageHandler {
  private handlers: ServerMessageHandlers = {};
  private loggedOpcodes = new Set<string>();

  setHandlers(handlers: ServerMessageHandlers): void {
    this.handlers = handlers;
  }

  /**
   * FAITHFUL.394 — Read-only accessor used when one handler needs to
   * dispatch into another. Without this,
   * delegate callers can't reach the live handler reference because
   * the handlers struct was captured before assignment.
   */
  getHandlers(): Readonly<ServerMessageHandlers> {
    return this.handlers;
  }

  /**
   * Process a deserialized GameMessage from the network layer.
   */
  handleMessage(msg: GameMessage): void {
    if (msg.type === 'direct') {
      this.handleDirectMessage(msg);
    } else if (msg.type === 'event') {
      this.handleGameEvent(msg);
    }
    // GameAction messages are client→server, should not arrive here
  }

  private handleDirectMessage(msg: DirectMessage): void {
    const r = new BinaryReader(msg.payload);

    switch (msg.opcode) {
      // ── Object lifecycle ──
      case GameMessageOpcode.ObjectCreate: {
        const obj = parseCreateObject(msg.payload);
        if (obj) this.handlers.onObjectCreate?.(obj);
        break;
      }
      case GameMessageOpcode.UpdateObject: {
        // ACE WorldObject_Networking.cs:28-32 — SerializeUpdateObject is
        // literally a one-liner delegating to SerializeCreateObject. So the
        // wire format is byte-for-byte identical to ObjectCreate; only the
        // opcode + downstream semantic intent differ. Fires from Tailoring,
        // Aetheria, RecipeManager, Hook, generic WorldObject (any object
        // whose desc changes), Player_admin (admin-vision toggle).
        const obj = parseCreateObject(msg.payload);
        if (obj) this.handlers.onObjectUpdate?.(obj);
        break;
      }
      case GameMessageOpcode.PlayerCreate:
        this.handlers.onPlayerCreate?.(msg.payload);
        break;
      case GameMessageOpcode.ObjectDelete: {
        const guid = r.readUInt32();
        const instanceSequence = r.remaining >= 2 ? r.readUInt16() : 0;
        this.handlers.onObjectDelete?.({ guid, instanceSequence });
        break;
      }

      // ── Position & Movement ──
      case GameMessageOpcode.UpdatePosition:
        this.handleUpdatePosition(msg.payload);
        break;
      case GameMessageOpcode.AutonomousPosition:
        this.handleAutonomousPosition(msg.payload);
        break;
      case GameMessageOpcode.MovementEvent: {
        const guid = r.readUInt32();
        const instanceSequence = r.readUInt16();
        const movementData = r.readBytes(r.remaining);
        this.handlers.onMovementEvent?.({ guid, movementData, instanceSequence });
        break;
      }
      case GameMessageOpcode.SetState: {
        // FAITHFUL.338 — wire is `guid u32 + physicsState u32 +
        // instanceSequence u16 + stateSequence u16` per ACE
        // `GameMessageSetState.cs:9-15`. The sequence-type registry at
        // `SequenceManager.cs:170-171` registers BOTH ObjectInstance and
        // ObjectState as `UShortSequence` (2 bytes each via
        // `BitConverter.GetBytes(ushort)` in `UShortSequence.cs:42-44`),
        // so the total payload is 12 bytes (NOT 16).
        // Pre-fix read uint16 for instanceSequence (correct width) but
        // never read stateSequence at all — ACE clients used it to
        // ignore stale physics-state packets when out-of-order arrival
        // could apply a stale "dead" state after a respawn.
        const guid = r.readUInt32();
        const physicsState = r.readUInt32();
        const instanceSequence = r.remaining >= 2 ? r.readUInt16() : 0;
        const stateSequence = r.remaining >= 2 ? r.readUInt16() : 0;
        this.handlers.onSetState?.({ guid, physicsState, instanceSequence, stateSequence });
        break;
      }
      case GameMessageOpcode.ParentEvent: {
        // FAITHFUL.339 — wire format per ACE GameMessageParentEvent.cs:11-17:
        //   u32 creatureGuid + u32 wieldedGuid + i32 parentLocation +
        //   i32 placement + u16 instanceSequence + u16 positionSequence
        // = 20 bytes total. Both sequences are UShortSequence (2 bytes
        // each per SequenceManager.cs:170-171 + UShortSequence.cs:42-44),
        // NOT uint32. Pre-fix this read uint32 for instanceSequence,
        // which consumed the WHOLE 4-byte trailer; positionSequence's
        // bytes were silently included in instanceSequence's high 16
        // bits, and the `r.remaining >= 4` guard then returned 0 for
        // positionSequence. Consumer (attachWieldedToPlayer) doesn't
        // sequence-check, but the wire-format truth was wrong.
        const creatureGuid = r.readUInt32();
        const wieldedGuid = r.readUInt32();
        const parentLocation = r.readUInt32();
        const placement = r.readUInt32();
        const instanceSequence = r.remaining >= 2 ? r.readUInt16() : 0;
        const positionSequence = r.remaining >= 2 ? r.readUInt16() : 0;
        this.handlers.onParentEvent?.({
          creatureGuid, wieldedGuid, parentLocation, placement,
          instanceSequence, positionSequence,
        });
        break;
      }

      // ── Teleport ──
      case GameMessageOpcode.PlayerTeleport:
        this.handlers.onPlayerTeleport?.();
        break;

      // ── Sound & Effects ──
      case GameMessageOpcode.Sound: {
        const guid = r.readUInt32();
        const soundId = r.readUInt32();
        const volume = r.readFloat32();
        this.handlers.onSound?.({ guid, soundId, volume });
        break;
      }
      case GameMessageOpcode.PlayScriptId: {
        const guid = r.readUInt32();
        const scriptId = r.readUInt32();
        this.handlers.onPlayScript?.({ guid, scriptId });
        break;
      }
      case GameMessageOpcode.PlayEffect: {
        const guid = r.readUInt32();
        const effectId = r.readUInt32();
        const scale = r.readFloat32();
        this.handlers.onPlayEffect?.({ guid, effectId, scale });
        break;
      }

      // ── Chat ──
      case GameMessageOpcode.HearSpeech:
        this.handleHearSpeech(msg.payload, false);
        break;
      case GameMessageOpcode.HearRangedSpeech:
        this.handleHearSpeech(msg.payload, true);
        break;
      case GameMessageOpcode.EmoteText: {
        const senderGuid = r.readUInt32();
        const senderName = r.readString16();
        const message = r.readString16();
        this.handlers.onEmoteText?.({ senderGuid, senderName, message });
        break;
      }
      case GameMessageOpcode.SoulEmote: {
        const senderGuid = r.readUInt32();
        const senderName = r.readString16();
        const message = r.readString16();
        this.handlers.onSoulEmote?.({ senderGuid, senderName, message });
        break;
      }
      case GameMessageOpcode.TurbineChat:
        this.handleTurbineChat(msg.payload);
        break;
      case GameMessageOpcode.ServerMessage: {
        const message = r.readString16();
        const chatType = r.readUInt32();
        this.handlers.onServerMessage?.({ message, chatType });
        break;
      }

      // ── Appearance ──
      case GameMessageOpcode.ObjDescEvent:
        this.handleObjDescEvent(msg.payload);
        break;

      // ── Property updates ──
      case GameMessageOpcode.PrivateUpdatePropertyInt: {
        const seq = r.readUInt8();
        const key = r.readUInt32();
        const value = r.readInt32();
        this.handlers.onPrivateUpdatePropertyInt?.({ guid: 0, key, value });
        break;
      }
      case GameMessageOpcode.PublicUpdatePropertyInt: {
        const seq = r.readUInt8();
        const guid = r.readUInt32();
        const key = r.readUInt32();
        const value = r.readInt32();
        this.handlers.onPublicUpdatePropertyInt?.({ guid, key, value });
        break;
      }
      case GameMessageOpcode.PublicUpdatePropertyInt64: {
        // ACE GameMessagePublicUpdatePropertyInt64.cs: seq(u8) + guid(u32) + property(u32) + value(int64).
        const seq = r.readUInt8();
        const guid = r.readUInt32();
        const key = r.readUInt32();
        const value = r.readInt64();
        this.handlers.onPublicUpdatePropertyInt64?.({ guid, key, value });
        break;
      }
      case GameMessageOpcode.PublicUpdatePropertyBool: {
        // ACE GameMessagePublicUpdatePropertyBool.cs: seq(u8) + guid(u32) + property(u32) + value(u32 0/1).
        const seq = r.readUInt8();
        const guid = r.readUInt32();
        const key = r.readUInt32();
        const value = r.readUInt32() !== 0;
        this.handlers.onPublicUpdatePropertyBool?.({ guid, key, value });
        break;
      }
      case GameMessageOpcode.PublicUpdatePropertyFloat: {
        // ACE GameMessagePublicUpdatePropertyFloat.cs: seq(u8) + guid(u32) + property(u32) + value(double).
        const seq = r.readUInt8();
        const guid = r.readUInt32();
        const key = r.readUInt32();
        const value = r.readFloat64();
        this.handlers.onPublicUpdatePropertyFloat?.({ guid, key, value });
        break;
      }
      case GameMessageOpcode.PublicUpdatePropertyString: {
        // ACE GameMessagePublicUpdatePropertyString.cs has a DIFFERENT field order
        // from the other public-update variants: seq(u8) + property(u32) + guid(u32)
        // + Align(4) + WriteString16L.
        const seq = r.readUInt8();
        const key = r.readUInt32();
        const guid = r.readUInt32();
        r.align(4);
        const value = r.readString16();
        this.handlers.onPublicUpdatePropertyString?.({ guid, key, value });
        break;
      }
      case GameMessageOpcode.PublicUpdatePropertyDataID: {
        // ACE GameMessagePublicUpdateDataID.cs: seq(u8) + guid(u32) + property(u32) + value(u32).
        const seq = r.readUInt8();
        const guid = r.readUInt32();
        const key = r.readUInt32();
        const value = r.readUInt32();
        this.handlers.onPublicUpdatePropertyDataID?.({ guid, key, value });
        break;
      }
      case GameMessageOpcode.PublicUpdateInstanceId: {
        // ACE GameMessagePublicUpdateInstanceID.cs: seq(u8) + WriteGuid(worldObject.Guid)
        // + (uint)property + WriteGuid(instanceGuid). 13 bytes total.
        //   Sequence is ByteSequence (1 byte) per SequenceManager.cs:178 default — same trap
        //   as FAITHFUL.157/158. Fires heavily from Player_Inventory.cs (Container/Wielder),
        //   Creature_Death.cs (corpse looting), House.cs (HouseOwner), AdminCommands.
        //   Pre-FAITHFUL.160 these fell through to logUnhandled → silent peer-state drift
        //   (other-player wields/unwields, corpse loot transfers, house ownership flips).
        const seq = r.readUInt8();
        const guid = r.readUInt32();
        const key = r.readUInt32();
        const value = r.readUInt32();
        this.handlers.onPublicUpdatePropertyInstanceID?.({ guid, key, value });
        break;
      }
      case GameMessageOpcode.PrivateUpdatePropertyInt64: {
        const seq = r.readUInt8();
        const key = r.readUInt32();
        const value = r.readInt64();
        this.handlers.onPrivateUpdatePropertyInt64?.({ guid: 0, key, value });
        break;
      }
      case GameMessageOpcode.PrivateUpdatePropertyBool: {
        const seq = r.readUInt8();
        const key = r.readUInt32();
        const value = r.readUInt32() !== 0;
        this.handlers.onPrivateUpdatePropertyBool?.({ guid: 0, key, value });
        break;
      }
      case GameMessageOpcode.PrivateUpdatePropertyFloat: {
        const seq = r.readUInt8();
        const key = r.readUInt32();
        const value = r.readFloat64();
        this.handlers.onPrivateUpdatePropertyFloat?.({ guid: 0, key, value });
        break;
      }
      case GameMessageOpcode.PrivateUpdatePropertyString: {
        // FAITHFUL.340 — ACE GameMessagePrivateUpdatePropertyString.cs:11-14
        // calls `Writer.Align()` after the sequence + property fields:
        //   Writer.Write(seq);           // 1 byte (ByteSequence)
        //   Writer.Write((uint)prop);    // 4 bytes
        //   Writer.Align();              // pad to 4-byte boundary (3 bytes here)
        //   Writer.WriteString16L(val);
        // Pre-fix the parser read the string16 immediately after the
        // property uint32 (no align), so the first 3 bytes of the string
        // length prefix were being read out of the alignment-pad zeros.
        // For most string property updates the length is < 256 so the
        // ushort low byte happens to match a zero-padding byte by luck
        // (length 0 → reads 0x0000, which IS valid for "empty string"),
        // but any non-empty string update would yield garbage. The sibling
        // PublicUpdatePropertyString parser at the matching opcode already
        // applies `r.align(4)` correctly — this was the missing alignment.
        const seq = r.readUInt8();
        const key = r.readUInt32();
        r.align(4);
        const value = r.readString16();
        this.handlers.onPrivateUpdatePropertyString?.({ guid: 0, key, value });
        break;
      }
      case GameMessageOpcode.PrivateUpdatePropertyDataID: {
        const seq = r.readUInt8();
        const key = r.readUInt32();
        const value = r.readUInt32();
        this.handlers.onPrivateUpdatePropertyDataID?.({ guid: 0, key, value });
        break;
      }
      case GameMessageOpcode.PrivateUpdatePropertyInstanceID: {
        const seq = r.readUInt8();
        const key = r.readUInt32();
        const value = r.readUInt32();
        this.handlers.onPrivateUpdatePropertyInstanceID?.({ guid: 0, key, value });
        break;
      }

      // ── Vital/Attribute/Skill updates ──
      case GameMessageOpcode.PrivateUpdateVital: {
        // FAITHFUL.567 — same name-inversion trap as PrivateUpdateAttribute
        // (FAITHFUL.566). ACE GameMessagePrivateUpdateVital.cs:11-17 wire
        // order:
        //   u8  seq
        //   u32 (uint)Vital
        //   u32 Ranks         (= CreatureVital.cs:82-86 → propertiesAttribute2nd.LevelFromCP)
        //                       — XP-purchased raises count
        //   u32 StartingValue (= CreatureVital.cs:49-53 → propertiesAttribute2nd.InitLevel)
        //                       — initial base
        //   u32 ExperienceSpent
        //   u32 Current
        // The PREVIOUS parser stored Ranks in `initLevel` and StartingValue
        // in `levelFromCP`. The downstream consumer at main.ts:6406 calls
        // `playerState.vitals.setRaises(maxVitalId, data.levelFromCP ?? 0)`
        // expecting `levelFromCP` to be the raises count — but it was
        // receiving the unchanged StartingValue, so every max-vital update
        // (training/spec/raise) wiped the local raises count to the base
        // and the displayed max-vital training tier was wrong.
        const seq = r.readUInt8();
        const key = r.readUInt32();
        const levelFromCP = r.readUInt32(); // ACE.Ranks (raises count)
        const initLevel = r.readUInt32();   // ACE.StartingValue (base)
        const cpSpent = r.readUInt32();
        const value = r.readUInt32();
        this.handlers.onPrivateUpdateVital?.({ sequence: seq, key, value, initLevel, levelFromCP, cpSpent });
        break;
      }
      case GameMessageOpcode.PrivateUpdateAttribute2ndLevel: {
        const seq = r.readUInt8();
        const key = r.readUInt32();
        const value = r.readUInt32();
        this.handlers.onPrivateUpdateAttribute2ndLevel?.({ sequence: seq, key, value });
        break;
      }
      case GameMessageOpcode.PrivateUpdateAttribute: {
        // FAITHFUL.566 — ACE GameMessagePrivateUpdateAttribute.cs:11-15 wire layout
        // (21 bytes incl. opcode header):
        //   u8  sequence (ByteSequence per SequenceManager.cs:178 default)
        //   u32 (uint)PropertyAttribute
        //   u32 creatureAttribute.Ranks         ← maps to LevelFromCP via
        //                                         CreatureAttribute.cs:71-75 getter
        //                                         (= XP-purchased raises count)
        //   u32 creatureAttribute.StartingValue ← maps to InitLevel via
        //                                         CreatureAttribute.cs:38-42 getter
        //                                         (= base value at character creation)
        //   u32 creatureAttribute.ExperienceSpent
        // The PREVIOUS parser read Ranks INTO `initLevel` and StartingValue INTO
        // `levelFromCP`, inverting the semantics for the downstream consumer:
        //   playerState.attributes.setInnate(attrId, data.initLevel)   // got Ranks
        //   playerState.attributes.setRaises(attrId, data.levelFromCP) // got StartingValue
        // `getCurrent()` = innate + raises hides the swap (addition is commutative)
        // but every separate display of innate vs raises was wrong, AND the raise-
        // chime check `data.levelFromCP > priorRaises` compared old StartingValue
        // vs old StartingValue (which never changes on a raise) so the chime never
        // fired. Read in ACE order with semantic names so the consumer's
        // setInnate(initLevel)/setRaises(levelFromCP) calls match retail.
        const seq = r.readUInt8();
        const key = r.readUInt32();
        const levelFromCP = r.readUInt32(); // ACE.Ranks (the raises count)
        const initLevel = r.readUInt32();   // ACE.StartingValue (the base value)
        const cpSpent = r.readUInt32();
        this.handlers.onPrivateUpdateAttribute?.({ sequence: seq, key, initLevel, levelFromCP, cpSpent });
        break;
      }
      case GameMessageOpcode.PrivateUpdateSkill: {
        // ACE GameMessagePrivateUpdateSkill.cs:11-23 — wire layout (33 bytes):
        //   u8  sequence (ByteSequence per SequenceManager.cs:178 default)
        //   u32 (uint)Skill                                    — skill enum value
        //   u32 Ranks (CreatureSkill.Ranks is `ushort`!)       ← Writer.Write(ushort) = 2 bytes
        //                                                       Wait — `ranks` IS ushort in the C#
        //                                                       struct. So this is 2 bytes.
        //   u16 adjustPP (literal 1)
        //   u32 (uint)AdvancementClass
        //   u32 ExperienceSpent
        //   u32 InitLevel                                      — bonus points (training/specialized)
        //   u32 ResistanceAtLastCheck
        //   f64 LastUsedTime
        // The PREVIOUS implementation read advancementClass as u16 and skipped the
        // adjustPP field entirely — every subsequent field was misaligned by 2 bytes.
        const seq = r.readUInt8();
        const key = r.readUInt32();
        const ranks = r.readUInt16();
        const adjustPP = r.readUInt16();
        const advancementClass = r.readUInt32();
        const cpSpent = r.readUInt32();
        const initLevel = r.readUInt32();
        const resistanceOfLastCheck = r.readUInt32();
        const lastUsedTime = r.readFloat64();
        this.handlers.onPrivateUpdateSkill?.({
          sequence: seq, key,
          // Maintain backward-compat field names for existing consumers; the
          // semantic mapping is: points = ranks (old name was a misnomer),
          // levelFromCP intentionally elided (the original field never existed
          // on the wire — it was a parsing accident that consumed adjustPP).
          advancementClass, points: ranks, initLevel, levelFromCP: 0,
          cpSpent, resistanceOfLastCheck, lastUsedTime,
        });
        break;
      }

      // ── Inventory (direct messages) ──
      case GameMessageOpcode.InventoryRemoveObject: {
        // guid of item removed from inventory — consume/destroy, give, spend,
        // or corpse-transfer-on-death (Player_Inventory.cs:124,226,3096).
        // NOT a ground drop; routed to onInventoryRemove, distinct from the
        // ground-drop-only onInventoryPutIn3D handler.
        const itemGuid = r.readUInt32();
        this.handlers.onInventoryRemove?.({ itemGuid });
        break;
      }
      case GameMessageOpcode.PlayerKilled: {
        // FAITHFUL.333 — wire format is `message + victimGuid + killerGuid`
        // per ACE `GameMessagePlayerKilled.cs:11-13`. Pre-fix only one guid
        // was read (mislabeled `killerGuid` — actually victimGuid) and the
        // killerGuid was silently dropped.
        const message = r.readString16();
        const victimGuid = r.readUInt32();
        const killerGuid = r.readUInt32();
        this.handlers.onPlayerKilled?.({ message, victimGuid, killerGuid });
        break;
      }
      case GameMessageOpcode.SetStackSize: {
        // ACE GameMessageSetStackSize.cs:12-15:
        //   Writer.Write(GetNextSequence(UpdatePropertyInt, StackSize))  — UpdatePropertyInt is a
        //     ByteSequence (SequenceManager.cs:178 default case = `new ByteSequence(false)`),
        //     so this is a SINGLE BYTE on the wire, not a uint32.
        //   Writer.WriteGuid(guid)                                       — uint32
        //   Writer.Write((uint)StackSize)                                — uint32
        //   Writer.Write((uint)Value)                                    — uint32
        // Total = 1 + 4 + 4 + 4 = 13 bytes.
        const sequence = r.readUInt8();
        const guid = r.readUInt32();
        const stackSize = r.readUInt32();
        const value = r.readUInt32();
        this.handlers.onSetStackSize?.({ sequence, guid, stackSize, value });
        break;
      }

      case GameMessageOpcode.VectorUpdate: {
        // ACE GameMessageVectorUpdate.cs (32-byte payload, SmartboxQueue):
        //   WriteGuid(worldObject.Guid)              — u32
        //   Writer.Write(velocity:  Vector3)         — 3 × f32 (12 bytes)
        //   Writer.Write(omega:     Vector3)         — 3 × f32 (12 bytes)
        //   Writer.Write(GetCurrentSequence(ObjectInstance)) — u16 (UShortSequence)
        //   Writer.Write(GetNextSequence(ObjectVector))      — u16 (UShortSequence)
        // Fires from SpellProjectile.cs:238 (every projectile motion update),
        // Player.cs:954 (jump arc velocity update). Pre-FAITHFUL.161 fell
        // through to default → logUnhandled, silently dropping all peer
        // velocity changes (visible spell projectile trajectories did not
        // get the smoothing data the server provides).
        const guid = r.readUInt32();
        const velocity = { x: r.readFloat32(), y: r.readFloat32(), z: r.readFloat32() };
        const omega = { x: r.readFloat32(), y: r.readFloat32(), z: r.readFloat32() };
        const instanceSequence = r.readUInt16();
        const vectorSequence = r.readUInt16();
        this.handlers.onVectorUpdate?.({ guid, velocity, omega, instanceSequence, vectorSequence });
        break;
      }
      case GameMessageOpcode.PickupEvent: {
        // ACE GameMessagePickupEvent.cs (8-byte payload, SmartboxQueue):
        //   Writer.Write(targetItem.Guid.Full)                 — u32
        //   Writer.Write(GetCurrentSequence(ObjectInstance))    — u16 (UShortSequence)
        //   Writer.Write(GetNextSequence(ObjectPosition))       — u16 (UShortSequence)
        // Fires from Player_Missile.cs:335 (ammo grab), Creature_Death.cs:681
        // (corpse loot transfer — paired with the PublicUpdateInstanceID
        //  Container/Wielder flips that FAITHFUL.160 just wired up),
        // Player_Tracking.cs:100, Player_Inventory.cs:404, Creature_*
        // combat ammo grabs. Pre-FAITHFUL.161 fell through to logUnhandled.
        const guid = r.readUInt32();
        const instanceSequence = r.readUInt16();
        const positionSequence = r.readUInt16();
        this.handlers.onPickupEvent?.({ guid, instanceSequence, positionSequence });
        break;
      }

      // ── Session/account lifecycle (ACE-emitted, low-volume) ──
      case GameMessageOpcode.AccountBoot: {
        // ACE GameMessageBootAccount.cs: optional String16L reason. ACE may
        // write zero bytes if reason==null (no length prefix at all), so the
        // safe parse is "read string if remaining >= 2."
        const reason = r.remaining >= 2 ? r.readString16() : '';
        this.handlers.onAccountBoot?.({ reason });
        break;
      }
      case GameMessageOpcode.AccountBanned: {
        // ACE GameMessageAccountBanned.cs:
        //   Writer.Write((uint)tsBanExpiration.TotalSeconds)
        //   if (Reason != null) Writer.WriteString16L(Reason)
        const secondsUntilExpiry = r.readUInt32();
        const reason = r.remaining >= 2 ? r.readString16() : '';
        this.handlers.onAccountBanned?.({ secondsUntilExpiry, reason });
        break;
      }
      case GameMessageOpcode.CharacterDelete:
        // ACE GameMessageCharacterDelete.cs: empty payload (base ctor hint 4 = just opcode prefix).
        this.handlers.onCharacterDelete?.();
        break;
      case GameMessageOpcode.CharacterLogOff:
        // ACE GameMessageCharacterLogOff.cs: empty payload.
        this.handlers.onCharacterLogOff?.();
        break;
      case GameMessageOpcode.PrivateUpdatePosition: {
        // ACE GameMessagePrivateUpdatePosition.cs (37-byte payload):
        //   Writer.Write(GetNextSequence(SequenceType.UpdatePosition, positionType)) — u8 ByteSequence
        //   Writer.Write((uint)positionType)                                          — u32
        //   pos.Serialize(Writer): u32 landblockId + 3×f32 position + 4×f32 rotation = 32 bytes
        // Fires ONLY from Creature_Death.cs:559 for PositionType.LastOutsideDeath
        // (so the client knows where their corpse landed after dying outdoors).
        const sequence = r.readUInt8();
        const positionType = r.readUInt32();
        const landblockId = r.readUInt32();
        const x = r.readFloat32();
        const y = r.readFloat32();
        const z = r.readFloat32();
        const qw = r.readFloat32();
        const qx = r.readFloat32();
        const qy = r.readFloat32();
        const qz = r.readFloat32();
        this.handlers.onPrivateUpdatePosition?.({
          sequence, positionType, landblockId, x, y, z, qw, qx, qy, qz,
        });
        break;
      }
      case GameMessageOpcode.AdminEnvirons: {
        // ACE GameMessageAdminEnvirons.cs: just u32 EnvironChangeType enum.
        // Admin GM tool — toggles environment effects on/off for the player.
        const environChangeType = r.readUInt32();
        this.handlers.onAdminEnvirons?.({ environChangeType });
        break;
      }

      // ── Messages we acknowledge but don't process yet ──
      case GameMessageOpcode.CharacterList:
      case GameMessageOpcode.DDD_Interrogation:
      case GameMessageOpcode.DDD_EndDDD:
      case GameMessageOpcode.CharacterError:
      case GameMessageOpcode.CharacterCreateResponse:
      case GameMessageOpcode.CharacterEnterWorldServerReady:
      case GameMessageOpcode.ServerName:
      case GameMessageOpcode.DDD_BeginDDD:
      case GameMessageOpcode.DDD_DataMessage:
        // These are handled by ClientConnection directly
        break;

      // FAITHFUL.602 — DDD_ErrorMessage (0xF7E4) was the single ACE-sendable
      // opcode with no case (fell through to logUnhandled). ACE only sends it
      // from DDD_RequestDataMessage when DAT patching is disabled
      // (DDDHandler.cs:195-228) — a request this client never makes (DATs
      // load locally and DDD_InterrogationResponse reports matching
      // iterations, so the server always takes the DDD_EndDDD branch).
      // Payload per GameMessageDDDErrorMessage.cs: resourceType u32 +
      // dataId u32 + errorType u32. Read + surface a console warning so the
      // dispatch surface is 100% covered.
      case GameMessageOpcode.DDD_ErrorMessage: {
        const resourceType = r.readUInt32();
        const dataId = r.readUInt32();
        const errorType = r.readUInt32();
        console.warn(`[AC] DDD_ErrorMessage: resourceType=0x${resourceType.toString(16)} dataId=0x${dataId.toString(16)} errorType=${errorType}`);
        break;
      }

      // ─────────────────────────────────────────────────────────────
      // FAITHFUL.581 — Real handlers for opcodes FAITHFUL.580 had
      // documented as silent-no-ops. Per GOAL.md "100% parity", silence
      // is not acceptable when the data is on the wire — we parse and
      // dispatch so future iterations can route into UI / animation /
      // social systems without re-discovering the wire format.
      // ─────────────────────────────────────────────────────────────

      // Note: `Motion` (0xF74C) is an ALIAS for `MovementEvent` (same
      // opcode) per `packages/network/src/GameMessageOpcode.ts:60-61` and
      // ACE's `GameMessageOpcode.cs`. The MovementEvent case earlier in
      // this switch already drives NPC/creature animations via
      // `ServerObjectManager.handleMovementEvent`. No separate handler
      // needed.

      // PublicUpdatePosition (0x02DC) — `GameMessagePublicUpdatePosition`
      // ships position updates for visible objects scoped to a single
      // PositionType (e.g. Sanctuary, LinkedLifestone, HouseBoot, etc.).
      // Wire format per
      // `reference/ACE/Source/ACE.Server/Network/GameMessages/Messages/GameMessagePublicUpdatePosition.cs`:
      //   u8 seq (UpdatePosition is a ByteSequence per SequenceManager.cs
      //          default arm) + u32 guid + u32 positionType + Position
      //   blob (u32 landblock + 3 f32 + 4 f32 quaternion = 32 bytes).
      // Distinct from `UpdatePosition` (0xF748) which broadcasts the
      // high-frequency move-update and from `PrivateUpdatePosition`
      // (0x02DB) which is the local-player equivalent. The Public
      // variant matters when allies update their Sanctuary / linked
      // lifestone — radar markers + map pins need to follow them.
      case GameMessageOpcode.PublicUpdatePosition: {
        const sequence = r.readUInt8();
        const guid = r.readUInt32();
        const positionType = r.readUInt32();
        const landblockId = r.readUInt32();
        const x = r.readFloat32();
        const y = r.readFloat32();
        const z = r.readFloat32();
        const qw = r.readFloat32();
        const qx = r.readFloat32();
        const qy = r.readFloat32();
        const qz = r.readFloat32();
        this.handlers.onPublicUpdatePosition?.({
          sequence, guid, positionType, landblockId, x, y, z, qw, qx, qy, qz,
        });
        break;
      }

      // PublicUpdateVital (0x02E8) — `GameMessagePublicUpdateVital` ships
      // OTHER objects' (fellowship members, summoned pets, visible NPCs)
      // vital changes. Wire format per
      // `reference/ACE/Source/ACE.Server/Network/GameMessages/Messages/GameMessagePublicUpdateVital.cs`:
      //   u8 seq (UpdateAttribute2ndLevel is a ByteSequence per
      //          SequenceManager.cs default arm) + u32 guid + u32
      //   attribute (PropertyAttribute2nd) + u32 ranks + u32 baseValue +
      //   u32 totalInvestment + u32 currentValue.
      // Distinct from `PrivateUpdateVital` (which we DO handle for the
      // local player). Lets us live-update fellow vital bars + pet
      // health between bulk FellowshipUpdateFellow broadcasts.
      case GameMessageOpcode.PublicUpdateVital: {
        const sequence = r.readUInt8();
        const guid = r.readUInt32();
        const attribute = r.readUInt32();
        const ranks = r.readUInt32();
        const baseValue = r.readUInt32();
        const totalInvestment = r.readUInt32();
        const currentValue = r.readUInt32();
        this.handlers.onPublicUpdateVital?.({
          sequence, guid, attribute, ranks, baseValue, totalInvestment, currentValue,
        });
        break;
      }

      // BUG.character-restore-response-shadowed-dead-code — CharacterRestoreResponse
      // used to have its own case here, but it aliases the same wire opcode
      // (0xF643) as CharacterCreateResponse (see GameMessageOpcode.ts), so a
      // plain switch always matched the earlier CharacterCreateResponse
      // no-op case above and this one was unreachable dead code. Correct
      // disambiguation needs client-side send-context (was a CharacterCreate
      // request actually outstanding?) that only ClientConnection tracks —
      // it now parses + emits `characterRestoreResponse` itself (see
      // ClientConnection.ts's CharacterCreateResponse case and
      // parseCharacterRestoreResponse in MessageSerializer.ts); consumed in
      // main.ts's `case 'characterRestoreResponse'`, not here.

      // GAP.89 — Client→server-only opcodes. Each is marked in ACE.Server
      // with a `[GameMessage(GameMessageOpcode.X, SessionState...)]`
      // attribute, which in ACE's dispatch framework designates a handler
      // for messages FROM the client — a compliant server never sends
      // these to us, so they are structurally unreachable in real play.
      // Explicit tolerant no-op (not the anonymous default) so the
      // coverage audit can confirm every enum opcode's fate is documented,
      // matching FAITHFUL.53's precedent for deprecated-but-tolerated
      // GameEvents.
      case GameMessageOpcode.CharacterCreate:           // ACE.Server/Network/Handlers/CharacterHandler.cs:26
      case GameMessageOpcode.CharacterEnterWorld:        // CharacterHandler.cs:198
      case GameMessageOpcode.CharacterEnterWorldRequest: // CharacterHandler.cs:183
      case GameMessageOpcode.CharacterRestore:           // CharacterHandler.cs:331
      case GameMessageOpcode.ForceObjectDescSend:        // ACE.Server/Network/Handlers/ControlHandler.cs:8
      case GameMessageOpcode.GetServerVersion:           // ACE.Server/Network/Handlers/GetServerVersionHandler.cs:10
      case GameMessageOpcode.FriendsOld:                 // ACE.Server/Network/Handlers/FriendsOldHandler.cs:9
      case GameMessageOpcode.DDD_RequestDataMessage:     // ACE.Server/Network/Handlers/DDDHandler.cs:195
      case GameMessageOpcode.DDD_InterrogationResponse:  // DDDHandler.cs:24
        break;

      // GDLE sends SetTurbineChatChannels as a top-level 0x0295 message
      // (Client.cpp CClient::EnterWorld: SendNetMessage(PRIVATE_MSG), no
      // 0xF7B0 wrapper) with the same ten uint32s ACE puts in the event.
      case GameEventType.SetTurbineChatChannels as number:
        this.dispatchTurbineChatChannels(r);
        break;

      // GAP.89 — Enum opcodes ported from the original retail wire protocol
      // (present in PacketOpCodeNames.cs's debug name table and/or the
      // GameMessageOpcode.cs enum) for which ACE.Server has NO code path
      // that ever constructs or sends a message — confirmed by a
      // full-source grep of reference/ACE/Source finding zero
      // GameMessage*.cs class or EnqueueSend call for any of these.
      // ACE never emits them; tolerated (not silently logged) in case a
      // non-stock server does, per the same FAITHFUL.53 precedent.
      case GameMessageOpcode.PublicUpdateSkill:          // no GameMessagePublicUpdateSkill.cs in ACE.Server
      case GameMessageOpcode.PrivateUpdateSkillLevel:    // no GameMessagePrivateUpdateSkillLevel.cs in ACE.Server
      case GameMessageOpcode.PublicUpdateSkillLevel:     // no GameMessagePublicUpdateSkillLevel.cs in ACE.Server
      case GameMessageOpcode.PublicUpdateAttribute:      // no GameMessagePublicUpdateAttribute.cs in ACE.Server
      case GameMessageOpcode.PositionAndMovement:        // no GameMessagePositionAndMovement.cs in ACE.Server
      case GameMessageOpcode.DDD_BeginPullDDD:           // no references anywhere in ACE.Server source
      case GameMessageOpcode.DDD_IterationData:          // no references anywhere in ACE.Server source
        break;

      default:
        this.logUnhandled('direct', msg.opcode);
    }
  }

  private handleGameEvent(msg: GameEventMessage): void {
    const eventType = msg.eventType as GameEventType;
    try {
      this.dispatchGameEvent(eventType, msg);
    } catch (e) {
      console.error(
        `[AC] handleGameEvent error for ${GameEventType[eventType] ?? eventType} (objectGuid=${msg.objectGuid}):`,
        e
      );
    }
  }

  private dispatchGameEvent(eventType: GameEventType, msg: GameEventMessage): void {
    const r = new BinaryReader(msg.payload);

    switch (eventType) {
      case GameEventType.PlayerDescription:
        this.handlers.onPlayerDescription?.({ rawPayload: msg.payload });
        break;

      case GameEventType.UpdateHealth: {
        const guid = r.readUInt32();
        const healthFraction = r.readFloat32();
        this.handlers.onUpdateHealth?.({ guid, healthFraction });
        break;
      }

      case GameEventType.IdentifyObjectResponse:
        this.handleIdentifyResponse(msg.payload);
        break;

      case GameEventType.InventoryPutObjInContainer: {
        const itemGuid = r.readUInt32();
        const containerGuid = r.readUInt32();
        const slot = r.readUInt32();
        const itemType = r.readUInt32();
        this.handlers.onInventoryPut?.({ itemGuid, containerGuid, slot, itemType });
        break;
      }

      case GameEventType.WieldObject: {
        const itemGuid = r.readUInt32();
        const location = r.readUInt32();
        this.handlers.onWieldObject?.({ itemGuid, location });
        break;
      }

      case GameEventType.InventoryPutObjectIn3D: {
        const itemGuid = r.readUInt32();
        this.handlers.onInventoryPutIn3D?.({ itemGuid });
        break;
      }

      case GameEventType.ApproachVendor: {
        const parsed = parseApproachVendor(msg.payload);
        // vendorGuid comes from the payload's own leading uint32 (parsed.vendorGuid —
        // written first thing by GameEventApproachVendor.cs:14 `Writer.Write(vendor.Guid.Full)`),
        // NOT from the GameEvent header's msg.objectGuid. GameEventMessage.cs's base ctor
        // (reference/ACE/Source/ACE.Server/Network/GameEvent/GameEventMessage.cs:19-21) always
        // writes session.Player.Guid into that header field for every GameEvent type, so
        // msg.objectGuid is never the vendor's guid — same dead-field mislabeling class as the
        // ViewContents containerGuid fix (GAP.86 2026-07-23c). main.ts's onApproachVendor already
        // only reads parsed.vendorGuid and ignores this top-level field, so this had no live
        // gameplay impact, but the field was wrong and misleading.
        this.handlers.onApproachVendor?.({ vendorGuid: parsed?.vendorGuid ?? 0, parsed, rawPayload: msg.payload });
        break;
      }

      case GameEventType.UseDone: {
        const errorType = r.readUInt32();
        this.handlers.onUseDone?.({ errorType });
        break;
      }

      // ── Combat ──
      case GameEventType.AttackerNotification:
        this.handleAttackerNotification(msg.payload);
        break;
      case GameEventType.DefenderNotification:
        this.handleDefenderNotification(msg.payload);
        break;
      case GameEventType.EvasionAttackerNotification: {
        const targetName = r.readString16();
        this.handlers.onEvasionAttacker?.({ targetName });
        break;
      }
      case GameEventType.EvasionDefenderNotification: {
        const attackerName = r.readString16();
        this.handlers.onEvasionDefender?.({ attackerName });
        break;
      }
      case GameEventType.VictimNotification: {
        // FAITHFUL.333 — wire is JUST `deathMessage` per
        // `GameEventVictimNotification.cs:9-12`. Pre-fix this read a bogus
        // `killerGuid` past the end of the payload (raising RangeError on
        // strict reads, or pulling junk bytes from fragment padding).
        const message = r.readString16();
        this.handlers.onVictimNotification?.({ message });
        break;
      }
      case GameEventType.KillerNotification: {
        // FAITHFUL.333 — wire is JUST `deathMessage` per
        // `GameEventKillerNotification.cs:9-12`. Pre-fix this read a bogus
        // `victimGuid` + `xpGranted` past the end of the payload, and
        // main.ts then mistakenly emitted "You've earned N experience
        // points." from the garbage value (or never, when guard returned 0).
        // XP-on-kill chat is delivered separately via GameMessageSystemChat
        // with ChatMessageType.Advancement (which already routes through
        // onServerMessage).
        const message = r.readString16();
        this.handlers.onKillerNotification?.({ message });
        break;
      }

      // ── Magic ──
      case GameEventType.MagicUpdateSpell: {
        // FAITHFUL.335 — ACE GameEventMagicUpdateSpell.cs writes `ushort
        // spellId + ushort layer` (4 bytes total). Pre-fix read uint32
        // which happened to produce the right numeric spellId for all
        // current ACE spells (layer=0, spellId < 65536), but mis-shapes
        // the wire format and would silently corrupt the value if a
        // spellId ≥ 65536 ever appeared. Layer is documented as "unused?"
        // in the ACE source — we still read past it to keep cursor
        // positioned for any future trailer fields.
        const spellId = r.readUInt16();
        r.readUInt16(); // layer (unused per ACE source comment)
        this.handlers.onMagicUpdateSpell?.({ spellId });
        break;
      }
      case GameEventType.MagicUpdateEnchantment: {
        const enchantment = parseEnchantmentData(msg.payload);
        this.handlers.onMagicUpdateEnchantment?.({ enchantment, rawPayload: msg.payload });
        break;
      }
      case GameEventType.MagicRemoveEnchantment: {
        const spellId = r.readUInt16();
        const layerId = r.readUInt16();
        this.handlers.onMagicRemoveEnchantment?.({ spellId, layerId });
        break;
      }
      case GameEventType.MagicPurgeEnchantments:
        this.handlers.onMagicPurgeEnchantments?.();
        break;

      // ── Chat GameEvents ──
      case GameEventType.Tell: {
        // FAITHFUL.334 — full ACE wire format per `GameEventTell.cs:14-19`:
        //   string16 message + string16 senderName + uint32 senderID +
        //   uint32 targetID + uint32 chatMessageType + uint32 0 trailer.
        // Pre-fix the targetID slot was skipped and the chatMessageType
        // slot was mis-read as chatType (so chatType actually carried the
        // targetID's guid value, not the ChatMessageType enum). The
        // trailing 0u — undocumented in ACE's xml comments but present in
        // retail pcaps per the source — is read and ignored.
        const message = r.readString16();
        const senderName = r.readString16();
        const senderGuid = r.readUInt32();
        const targetGuid = r.readUInt32();
        const chatType = r.readUInt32();
        r.skip(4); // 0u trailer (per ACE source)
        this.handlers.onTell?.({ message, senderName, senderGuid, targetGuid, chatType });
        break;
      }

      case GameEventType.CommunicationTransientString: {
        const message = r.readString16();
        this.handlers.onCommunicationTransientString?.({ message });
        break;
      }

      case GameEventType.PopupString: {
        const message = r.readString16();
        this.handlers.onPopupString?.({ message });
        break;
      }

      // ── Fellowship ──
      case GameEventType.FellowshipFullUpdate: {
        const parsed = parseFellowshipFullUpdate(msg.payload);
        this.handlers.onFellowshipFullUpdate?.({ parsed, rawPayload: msg.payload });
        break;
      }
      case GameEventType.FellowshipDisband:
        this.handlers.onFellowshipDisband?.();
        break;
      case GameEventType.FellowshipUpdateFellow: {
        const result = parseFellowshipUpdateFellow(msg.payload);
        this.handlers.onFellowshipUpdateFellow?.({ fellow: result?.fellow ?? null, updateType: result?.updateType ?? 0, rawPayload: msg.payload });
        break;
      }

      // ── Inventory viewing ──
      case GameEventType.ViewContents: {
        const parsed = parseViewContents(msg.payload);
        if (parsed) this.handlers.onViewContents?.({ containerGuid: parsed.containerGuid, items: parsed.items });
        break;
      }

      // ── Weenie errors ──
      case GameEventType.WeenieError: {
        const errorType = r.readUInt32();
        this.handlers.onWeenieError?.({ errorType });
        break;
      }
      case GameEventType.WeenieErrorWithString: {
        const errorType = r.readUInt32();
        const message = r.readString16();
        this.handlers.onWeenieErrorWithString?.({ errorType, message });
        break;
      }

      // ── Allegiance ──
      case GameEventType.AllegianceUpdate: {
        const parsed = parseAllegianceUpdate(msg.payload);
        this.handlers.onAllegianceUpdate?.({ parsed, rawPayload: msg.payload });
        break;
      }

      // ── Friends ──
      case GameEventType.FriendsListUpdate: {
        const parsed = parseFriendsListUpdate(msg.payload);
        this.handlers.onFriendsListUpdate?.({ parsed, rawPayload: msg.payload });
        break;
      }

      // ── Character Title events ──
      case GameEventType.CharacterTitle: {
        try {
          const r = new BinaryReader(msg.payload);
          r.readUInt32(); // unknown flag (always 1)
          const activeTitleId = r.readUInt32();
          const count = r.readUInt32();
          const titleIds: number[] = [];
          for (let i = 0; i < count; i++) {
            titleIds.push(r.readUInt32());
          }
          this.handlers.onCharacterTitle?.({ activeTitleId, titleIds });
        } catch (e) {
          console.warn('[AC] CharacterTitle parse error:', e);
        }
        break;
      }
      case GameEventType.UpdateTitle: {
        try {
          const r = new BinaryReader(msg.payload);
          const titleId = r.readUInt32();
          const setAsDisplay = r.readUInt32() !== 0;
          this.handlers.onUpdateTitle?.({ titleId, setAsDisplay });
        } catch (e) {
          console.warn('[AC] UpdateTitle parse error:', e);
        }
        break;
      }
      case GameEventType.BookDataResponse: {
        try {
          const r = new BinaryReader(msg.payload);
          const bookGuid = r.readUInt32();
          const maxPages = r.readUInt32();
          r.readUInt32(); // numPages (usually same as maxPages)
          r.readUInt32(); // maxCharsPerPage
          const pageCount = r.readUInt32();
          const pages: BookPageData[] = [];
          for (let i = 0; i < pageCount; i++) {
            const authorId = r.readUInt32();
            const authorName = r.readString16();
            r.readString16(); // authorAccount (hidden)
            r.readUInt32(); // flags
            const textIncluded = r.readUInt32() !== 0;
            const ignoreAuthor = r.readUInt32() !== 0;
            let pageText = '';
            if (textIncluded) {
              pageText = r.readString16();
            }
            pages.push({ authorId, authorName, textIncluded, ignoreAuthor, pageText });
          }
          const inscription = r.readString16();
          const inscriptionAuthorId = r.readUInt32();
          const inscriptionAuthor = r.readString16();
          this.handlers.onBookData?.({ bookGuid, maxPages, pages, inscription, inscriptionAuthorId, inscriptionAuthor });
        } catch (e) {
          console.warn('[AC] BookDataResponse parse error:', e);
        }
        break;
      }
      case GameEventType.BookAddPageResponse: {
        try {
          const r = new BinaryReader(msg.payload);
          const bookGuid = r.readUInt32();
          const page = r.readInt32();
          const success = r.readUInt32() !== 0;
          this.handlers.onBookAddPageResponse?.({ bookGuid, page, success });
        } catch (e) {
          console.warn('[AC] BookAddPageResponse parse error:', e);
        }
        break;
      }
      case GameEventType.BookModifyPageResponse: {
        try {
          const r = new BinaryReader(msg.payload);
          const bookGuid = r.readUInt32();
          const page = r.readInt32();
          const success = r.readUInt32() !== 0;
          this.handlers.onBookModifyPageResponse?.({ bookGuid, page, success });
        } catch (e) {
          console.warn('[AC] BookModifyPageResponse parse error:', e);
        }
        break;
      }
      case GameEventType.BookDeletePageResponse: {
        try {
          const r = new BinaryReader(msg.payload);
          const bookGuid = r.readUInt32();
          const page = r.readInt32();
          const success = r.readUInt32() !== 0;
          this.handlers.onBookDeletePageResponse?.({ bookGuid, page, success });
        } catch (e) {
          console.warn('[AC] BookDeletePageResponse parse error:', e);
        }
        break;
      }
      // Wire format per GameEventBookPageDataResponse.cs (sent by the live
      // GameActionBookPageData 0x00AE handler → Player_Book.cs ReadBookPage —
      // ACE's "completely unused" comment refers to the retail client never
      // sending the request, but our bookPageData() API does):
      //   bookID u32 + pageIndex int32 + authorId u32 + authorName String16L
      //   + authorAccount String16L + flags u32 + textIncluded u32
      //   + ignoreAuthor u32 + pageText String16L.
      case GameEventType.BookPageDataResponse: {
        try {
          const rd = new BinaryReader(msg.payload);
          const bookGuid = rd.readUInt32();
          const pageIndex = rd.readInt32();
          const authorId = rd.readUInt32();
          const authorName = rd.readString16();
          rd.readString16(); // authorAccount (hidden for non-admins)
          rd.readUInt32(); // flags (0xFFFF0002)
          const textIncluded = rd.readUInt32();
          const ignoreAuthor = rd.readUInt32() !== 0;
          let pageText = '';
          if (textIncluded) {
            pageText = rd.readString16();
          }
          this.handlers.onBookPageData?.({ bookGuid, pageIndex, authorId, authorName, ignoreAuthor, pageText });
        } catch (e) {
          console.warn('[AC] BookPageDataResponse parse error:', e);
        }
        break;
      }
      // Wire format: uint32 containerGuid (GameEventCloseGroundContainer.cs).
      // Server signals the client to close a ground/corpse container UI (e.g. on
      // distance, on owner-action, on container destroyed).
      case GameEventType.CloseGroundContainer: {
        const containerGuid = r.readUInt32();
        this.handlers.onCloseGroundContainer?.({ containerGuid });
        break;
      }
      // Wire format: uint32 playerGuid + uint32 isLoggedIn (GameEventAllegianceLoginNotification.cs).
      // Server informs the client when an allegiance member comes online or
      // goes offline so the allegiance roster + chat status update.
      case GameEventType.AllegianceLoginNotification: {
        const playerGuid = r.readUInt32();
        const isLoggedIn = r.readUInt32() !== 0;
        this.handlers.onAllegianceLoginNotification?.({ playerGuid, isLoggedIn });
        break;
      }
      // Wire format: uint32 count + N × Enchantment (GameEventMagicUpdateMultipleEnchantments.cs).
      // Used at login + on Refresh to bulk-replace the client's active-enchantment list.
      case GameEventType.MagicUpdateMultipleEnchantments: {
        const count = r.readUInt32();
        const enchantments: Array<import('@ac/network').EnchantmentData> = [];
        for (let i = 0; i < count; i++) {
          try {
            enchantments.push(parseEnchantmentFromReader(r));
          } catch (e) {
            console.warn('[AC] MagicUpdateMultipleEnchantments parse error at index', i, e);
            break;
          }
        }
        this.handlers.onMagicUpdateMultipleEnchantments?.({ enchantments });
        break;
      }
      case GameEventType.PingResponse:
        // FAITHFUL.272 — PingResponse carries no payload (size=4 header
        // only per GameEventPingResponse.cs); the round-trip arrival is
        // the signal. Fire the handler so the renderer can compute
        // latency for the 'server-load' HUD indicator.
        this.handlers.onPingResponse?.();
        break;
      case GameEventType.SetSquelchDB: {
        // FAITHFUL.362 — ACE SquelchManager.cs:295 sends this on login +
        // after each squelch-state change. Pre-fix the dispatcher
        // silently consumed it, so the client-side `squelchedNames` Set
        // started empty every login even though the SERVER-persisted
        // squelch state (via ModifyCharacterSquelch) was preserved.
        // Visible bug: re-logging then waiting for a squelched player
        // to chat — their messages appeared until the user re-issued
        // /squelch add.
        //
        // Wire format per ACE SquelchDB.cs:158-198:
        //   accountHash:    PackableHashTable header (always empty in retail) = 4 bytes
        //   characterHash:  PackableHashTable header + N × (key u32 + SquelchInfo)
        //   globals:        SquelchInfo
        //
        // SquelchInfo per SquelchInfo.cs:50-65:
        //   filters: u32 count + N × u32 SquelchMask
        //   playerName: s16L
        //   account: u32 bool
        //
        // BUG.squelch-mask-per-channel-discarded — the per-entry
        // SquelchMask (SquelchDB.cs:144 `Filters[0].HasFlag(squelchMask)`)
        // and the trailing Globals SquelchInfo (Player.SquelchGlobal, the
        // `/filter` command) are real, server-enforced state, not
        // vestigial — keep Filters[0] (SquelchInfo's single-filter ctor
        // repeats one value 4x, per its own "not sure why this is sent
        // 4x" comment) and actually read the Globals block instead of
        // stopping the parse before it.
        try {
          const accountCount = r.readUInt16();
          r.readUInt16(); // accountBuckets (unused)
          for (let i = 0; i < accountCount; i++) {
            r.readString16(); // accountName
            r.readUInt32();   // accountId
          }
          const charCount = r.readUInt16();
          r.readUInt16(); // charBuckets (unused)
          const entries: SquelchEntry[] = [];
          for (let i = 0; i < charCount; i++) {
            r.readUInt32(); // characterGuid (unused — we squelch by name)
            const filterCount = r.readUInt32();
            let mask = 0;
            for (let j = 0; j < filterCount; j++) {
              const filter = r.readUInt32();
              if (j === 0) mask = filter;
            }
            const playerName = r.readString16();
            // SquelchInfo.Account — true for account-wide squelches (ACE
            // ships them in the Characters table per SquelchDB.cs's own
            // comment); drives the squelch panel's Type column.
            const account = r.readUInt32() !== 0;
            if (playerName) entries.push({ name: playerName, mask, account });
          }
          // Globals SquelchInfo (SquelchDB.cs's ctor only adds a filter
          // when a global mask is actually set, so filterCount is 0 or 1
          // here — never the 4x repeat used for character entries).
          const globalFilterCount = r.readUInt32();
          let globalMask = 0;
          for (let j = 0; j < globalFilterCount; j++) {
            const filter = r.readUInt32();
            if (j === 0) globalMask = filter;
          }
          r.readString16(); // Globals.PlayerName (always empty)
          r.readUInt32();   // Globals.Account (always false)
          this.handlers.onSetSquelchDB?.({ entries, globalMask });
        } catch (e) {
          console.warn('[AC] SetSquelchDB parse error:', e);
        }
        break;
      }
      case GameEventType.SetTurbineChatChannels: {
        // FAITHFUL.363 — ACE GameEventSetTurbineChatChannels.cs:7-21
        // ships 10 uint32 values:
        //   allegiance (dynamic per-player ID, 0 if no allegiance)
        //   General, Trade, LFG, Roleplay   (fixed 2-5)
        //   Olthoi                          (fixed 10)
        //   society (dynamic per-player ID, 0 if not in a society)
        //   SocietyCelestialHand, SocietyEldrytchWeb, SocietyRadiantBlood
        //                                   (fixed 7-9)
        // Pre-fix the dispatcher silently consumed this. The dynamic
        // allegiance + society IDs are needed to correctly label
        // incoming ChannelBroadcast / TurbineChat messages: the
        // `turbineChannelLabel(channelId)` helper otherwise falls back
        // to "Allegiance" for ALL unknown IDs, so a player's society
        // chat would mislabel as "Allegiance" (its dynamic ID isn't
        // any of the fixed 2-10 set).
        this.dispatchTurbineChatChannels(r);
        break;
      }
      case GameEventType.AllegianceUpdateDone: {
        // GameEventAllegianceAllegianceUpdateDone.cs (0x01C8) — NOT deprecated,
        // 4 live ACE call sites (GameActionAllegianceUpdateRequest.cs,
        // Player_Allegiance.cs, Allegiance.cs, AllegianceManager.cs) write a
        // real uint32 WeenieError errorType. Read it rather than discarding.
        const errorType = r.remaining >= 4 ? r.readUInt32() : 0;
        this.handlers.onAllegianceUpdateDone?.({ errorType });
        break;
      }
      case GameEventType.ItemAppraiseDone:
      case GameEventType.FellowshipUpdateDone:
      case GameEventType.GetInscriptionResponse:
        // GameEventFellowshipFellowUpdateDone.cs (0x01C9) and GameEventInscriptionResponse.cs (0x00C3)
        // are both marked DEPRECATED in ACE source — the original AC client has no handler for them.
        // A 1-to-1 faithful reproduction matches that behavior: silently consume the bytes so an
        // unexpected emission from a non-stock server doesn't blow up the connection.
        //
        // SetSquelchDB/SetTurbineChatChannels (login chat-channel config) and
        // ItemAppraiseDone (appraise-flow terminator) carry no per-event state
        // we need beyond their arrival signal — silently consume.
        break;
      case GameEventType.AttackDone: {
        // Server signals current attack is complete. Payload: uint32 WeenieError.
        // WeenieError.None (0) = attack succeeded, restart power bar for next swing.
        const errorType = r.remaining >= 4 ? r.readUInt32() : 0;
        this.handlers.onAttackDone?.({ errorType });
        break;
      }
      case GameEventType.CombatCommenceAttack: {
        // Server signals auto-repeat: commence next attack swing.
        this.handlers.onCombatCommenceAttack?.();
        break;
      }
      case GameEventType.MagicRemoveMultipleEnchantments: {
        // List of (spellId uint16, layerId uint16) pairs
        const removeCount = r.readUInt32();
        const enchantments: Array<{ spellId: number; layerId: number }> = [];
        for (let i = 0; i < removeCount; i++) {
          enchantments.push({ spellId: r.readUInt16(), layerId: r.readUInt16() });
        }
        this.handlers.onMagicRemoveMultipleEnchantments?.({ enchantments });
        break;
      }
      // ── Trade negotiation events ─────────────────────────────────
      // Wire formats from reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEvent*Trade*.cs
      case GameEventType.RegisterTrade: {
        // initiatorGuid u32 + partnerGuid u32 + 0L (8 bytes pad)
        const initiatorGuid = r.readUInt32();
        const partnerGuid = r.readUInt32();
        this.handlers.onRegisterTrade?.({ initiatorGuid, partnerGuid });
        break;
      }
      case GameEventType.AddToTrade: {
        // objectGuid u32 + tradeSide u32 (1=Self, 2=Partner) + slot u32
        const objectGuid = r.readUInt32();
        const tradeSide = r.readUInt32();
        const slot = r.remaining >= 4 ? r.readUInt32() : 0;
        this.handlers.onAddToTrade?.({ objectGuid, tradeSide, slot });
        break;
      }
      case GameEventType.AcceptTrade: {
        // whoAcceptedGuid u32
        const whoAcceptedGuid = r.readUInt32();
        this.handlers.onAcceptTradeEvt?.({ whoAcceptedGuid });
        break;
      }
      case GameEventType.DeclineTrade: {
        const whoDeclinedGuid = r.readUInt32();
        this.handlers.onDeclineTradeEvt?.({ whoDeclinedGuid });
        break;
      }
      case GameEventType.ResetTrade: {
        const whoResetGuid = r.readUInt32();
        this.handlers.onResetTradeEvt?.({ whoResetGuid });
        break;
      }
      case GameEventType.CloseTrade: {
        // endTradeReason u32 (1=Normal, 2=EnteredCombat, 0x51=Canceled)
        const endReason = r.readUInt32();
        this.handlers.onCloseTradeEvt?.({ endReason });
        break;
      }
      case GameEventType.ClearTradeAcceptance: {
        this.handlers.onClearTradeAcceptance?.();
        break;
      }
      case GameEventType.TradeFailure: {
        // objectGuid u32 + reason u32 (WeenieError)
        const objectGuid = r.readUInt32();
        const reason = r.readUInt32();
        this.handlers.onTradeFailure?.({ objectGuid, reason });
        break;
      }
      // ── Salvage result event ─────────────────────────────────────
      // Wire format from reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventSalvageOperationsResult.cs:
      //   skill u32 + 0 u32 (unused guid list count) + resultCount u32 +
      //   [materialType u32 + workmanship f64 + units u32] × resultCount + bonusSalvage u32
      case GameEventType.SalvageOperationsResult: {
        const skill = r.readUInt32();
        r.readUInt32(); // unused "not salvagable item guid list" count — always 0 per ACE
        const resultCount = r.readUInt32();
        const results: Array<{ materialType: number; workmanship: number; units: number }> = [];
        for (let i = 0; i < resultCount; i++) {
          const materialType = r.readUInt32();
          const workmanship = r.readFloat64();
          const units = r.readUInt32();
          results.push({ materialType, workmanship, units });
        }
        const bonusSalvage = r.remaining >= 4 ? r.readUInt32() : 0;
        this.handlers.onSalvageResult?.({ skill, bonusSalvage, results });
        break;
      }
      case GameEventType.MagicPurgeBadEnchantments:
        // FAITHFUL.350 — distinct from MagicPurgeEnchantments. Wire format
        // is identical (no payload), but the SEMANTIC is "remove only
        // negative enchantments" per ACE GameEventMagicPurgeBadEnchantments.cs.
        // Routing to the wrong handler (the all-clear variant) would wipe
        // beneficial buffs too — anti-faithful for the GM "purge debuffs"
        // command and similar PvE encounters that intentionally clear
        // debuffs but preserve buffs.
        this.handlers.onMagicPurgeBadEnchantments?.();
        break;
      // Wire format: uint16 spellId + uint16 layer (GameEventMagicRemoveSpell.cs).
      // Remove a spell from the player's spellbook entirely (vs MagicRemoveEnchantment
      // which removes an *active* buff). Sent when a learned-from-item spell expires.
      case GameEventType.MagicRemoveSpell: {
        const spellId = r.readUInt16();
        const layer = r.remaining >= 2 ? r.readUInt16() : 0; // ACE comment: "unused?"
        this.handlers.onMagicRemoveSpell?.({ spellId, layer });
        break;
      }
      // ── ChannelBroadcast: allegiance/fellowship/society/society-internal chat ──
      // Wire format from GameEventChannelBroadcast.cs:
      //   channel u32 + senderName string16L (empty when echoing back to sender)
      //   + messageText string16L
      case GameEventType.ChannelBroadcast: {
        const channel = r.readUInt32();
        const senderName = r.readString16();
        const message = r.readString16();
        this.handlers.onChannelBroadcast?.({ channel, senderName, message });
        break;
      }
      // ── InventoryServerSaveFailed: itemGuid u32 + WeenieError u32 ──
      // Sent ~180 times in ACE server source — covers nearly every drop/equip
      // failure that the simpler WeenieError event doesn't cover.
      case GameEventType.InventoryServerSaveFailed: {
        const itemGuid = r.readUInt32();
        const errorType = r.remaining >= 4 ? r.readUInt32() : 0;
        this.handlers.onInventoryServerSaveFailed?.({ itemGuid, errorType });
        break;
      }
      // ── FellowshipQuit: playerId u32 (per GameEventFellowshipQuit.cs) ──
      case GameEventType.FellowshipQuit: {
        const playerId = r.readUInt32();
        this.handlers.onFellowshipQuit?.({ playerId });
        break;
      }
      // ── FellowshipDismiss: playerId u32 (per GameEventFellowshipDismiss.cs) ──
      case GameEventType.FellowshipDismiss: {
        const playerId = r.readUInt32();
        this.handlers.onFellowshipDismiss?.({ playerId });
        break;
      }
      // ── Housing events ───────────────────────────────────────────
      // Simple wire formats parsed here. Struct-based events surface raw.
      case GameEventType.HouseStatus: {
        // GameEventHouseStatus.cs: WeenieError u32 (typically BadParam=2)
        const weenieError = r.readUInt32();
        this.handlers.onHouseStatus?.({ weenieError });
        break;
      }
      case GameEventType.UpdateRentTime: {
        // GameEventHouseUpdateRentTime.cs: rentTime u32 (unix timestamp)
        const rentTime = r.readUInt32();
        this.handlers.onHouseUpdateRentTime?.({ rentTime });
        break;
      }
      case GameEventType.HouseTransaction: {
        // GameEventHouseTransaction.cs: noticeType u32
        const noticeType = r.readUInt32();
        this.handlers.onHouseTransaction?.({ noticeType });
        break;
      }
      case GameEventType.AvailableHouses: {
        // GameEventHouseAvailableHouses.cs:
        //   HouseType u32 + List<uint> locations (count u32 + N × u32) + totalAvailable int32
        const houseType = r.readUInt32();
        const count = r.readUInt32();
        const locations: number[] = [];
        for (let i = 0; i < count; i++) locations.push(r.readUInt32());
        const totalAvailable = r.readUInt32() | 0; // int32 (treat sign-extended)
        this.handlers.onHouseAvailableHouses?.({ houseType, locations, totalAvailable });
        break;
      }
      case GameEventType.HouseProfile: {
        // GameEventHouseProfile.cs: crystalGuid u32 + HouseProfile.
        // HouseProfile.cs Write: DwellingID u32 + OwnerID u32 + Bitmask u32 +
        //   MinLevel int32 + MaxLevel int32 + MinAllegRank int32 + MaxAllegRank int32 +
        //   MaintenanceFree u32 + Type u32 + OwnerName S16L + Buy List + Rent List.
        const crystalGuid = r.readUInt32();
        const rawPayload = msg.payload.slice(r.position);
        this.handlers.onHouseProfileRaw?.({ crystalGuid, rawPayload });
        try {
          const dwellingId = r.readUInt32();
          const ownerId = r.readUInt32();
          const bitmask = r.readUInt32();
          const minLevel = r.readUInt32() | 0;
          const maxLevel = r.readUInt32() | 0;
          const minAllegRank = r.readUInt32() | 0;
          const maxAllegRank = r.readUInt32() | 0;
          const maintenanceFree = r.readUInt32() !== 0;
          const houseType = r.readUInt32();
          const ownerName = r.readString16();
          const readPaymentList = () => {
            const count = r.readUInt32();
            const out: Array<{ num: number; paid: number; weenieId: number; name: string; pluralName: string }> = [];
            for (let i = 0; i < count; i++) {
              out.push({
                num: r.readInt32(), paid: r.readInt32(), weenieId: r.readUInt32(),
                name: r.readString16(), pluralName: r.readString16(),
              });
            }
            return out;
          };
          const buy = readPaymentList();
          const rent = readPaymentList();
          this.handlers.onHouseProfile?.({
            crystalGuid, dwellingId, ownerId, bitmask,
            minLevel, maxLevel, minAllegRank, maxAllegRank,
            maintenanceFree, houseType, ownerName, buy, rent,
          });
        } catch (e) {
          console.warn('[AC] HouseProfile structured parse error:', e);
        }
        break;
      }
      case GameEventType.HouseData: {
        this.handlers.onHouseDataRaw?.({ rawPayload: msg.payload });
        // Structured parse per HouseData.cs Write.
        try {
          const r2 = new BinaryReader(msg.payload);
          const buyTime = r2.readUInt32();
          const rentTime = r2.readUInt32();
          const houseType = r2.readUInt32();
          const maintenanceFree = r2.readUInt32() !== 0;
          // Buy + Rent are List<HousePayment>: count u32 + N × HousePayment
          //   HousePayment = Num int32 + Paid int32 + WeenieID u32 + Name S16L + PluralName S16L.
          const readPaymentList = () => {
            const count = r2.readUInt32();
            const out: Array<{ num: number; paid: number; weenieId: number; name: string; pluralName: string }> = [];
            for (let i = 0; i < count; i++) {
              out.push({
                num: r2.readInt32(),
                paid: r2.readInt32(),
                weenieId: r2.readUInt32(),
                name: r2.readString16(),
                pluralName: r2.readString16(),
              });
            }
            return out;
          };
          const buy = readPaymentList();
          const rent = readPaymentList();
          // Position struct
          const position = {
            cell: r2.readUInt32(),
            x: r2.readFloat32(), y: r2.readFloat32(), z: r2.readFloat32(),
            rw: r2.readFloat32(), rx: r2.readFloat32(), ry: r2.readFloat32(), rz: r2.readFloat32(),
          };
          this.handlers.onHouseData?.({
            buyTime, rentTime, houseType, maintenanceFree, buy, rent, position,
          });
        } catch (e) {
          console.warn('[AC] HouseData structured parse error:', e);
        }
        break;
      }
      case GameEventType.UpdateHAR: {
        this.handlers.onHouseUpdateHARRaw?.({ rawPayload: msg.payload });
        // Structured per HouseAccess.cs Write:
        //   Version u32 + Bitmask u32 + MonarchID u32 +
        //   GuestList PackableHashTable<ObjectGuid, GuestInfo> +
        //   Roommates List<ObjectGuid>.
        // GuestInfo = ItemStoragePermission u32 + GuestName S16L.
        try {
          const r2 = new BinaryReader(msg.payload);
          const version = r2.readUInt32();
          const bitmask = r2.readUInt32();
          const monarchId = r2.readUInt32();
          const guestCount = r2.readUInt16();
          r2.readUInt16(); // numBuckets (unused)
          const guests: Array<{ guid: number; storageAccess: boolean; name: string }> = [];
          for (let i = 0; i < guestCount; i++) {
            const guid = r2.readUInt32();
            const storageAccess = r2.readUInt32() !== 0;
            const name = r2.readString16();
            guests.push({ guid, storageAccess, name });
          }
          const roommateCount = r2.readUInt32();
          const roommates: number[] = [];
          for (let i = 0; i < roommateCount; i++) roommates.push(r2.readUInt32());
          this.handlers.onHouseUpdateHAR?.({
            version, bitmask, openStatus: (bitmask & 0x1) !== 0, monarchId, guests, roommates,
          });
        } catch (e) {
          console.warn('[AC] UpdateHAR structured parse error:', e);
        }
        break;
      }
      case GameEventType.HouseUpdateRestrictions: {
        // ACE GameEventHouseUpdateRestrictions.cs:11-15 writes:
        //   Writer.Write(obj.Sequences.GetNextSequence(SequenceType.UpdateRestrictionDB))
        //   Writer.Write(obj.Guid.Full)
        //   Writer.Write(restrictions)
        // GetNextSequence returns `byte[]` (per `SequenceManager.cs:17-19`),
        // and UpdateRestrictionDB falls into the `default` switch arm at
        // `SequenceManager.cs:178-180` which constructs a `ByteSequence`
        // whose `NextBytes` is `new byte[] { NextValue }` — i.e. ONE byte
        // on the wire, not four. Pre-fix the parser read `sequence` as
        // uint32, drifting the cursor 3 bytes and silently corrupting
        // `objectGuid` (3 bytes from the real guid + 1 byte from
        // RestrictionDB.Version), the raw payload offset, and then every
        // downstream field (Version, OpenStatus, MonarchID, count,
        // permission entries). Visible bug: the house permission UI
        // received a garbage monarchId + zero or huge `count` causing the
        // structured parse to either throw a RangeError (caught by the
        // try/catch into a console.warn) or render zero/garbage
        // permission entries instead of the actual guest list.
        //
        // RestrictionDB.cs Write: Version u32 + OpenStatus u32 (bool) +
        //   MonarchID u32 + PackableHashTable<ObjectGuid, uint>
        //   (count u16 + buckets u16 + N × (key u32 + value u32)).
        const sequence = r.readUInt8();
        const objectGuid = r.readUInt32();
        const rawPayload = msg.payload.slice(r.position);
        this.handlers.onHouseUpdateRestrictionsRaw?.({ sequence, objectGuid, rawPayload });
        try {
          const r2 = new BinaryReader(rawPayload);
          const version = r2.readUInt32();
          const openStatus = r2.readUInt32() !== 0;
          const monarchId = r2.readUInt32();
          const count = r2.readUInt16();
          r2.readUInt16(); // numBuckets (unused on client read)
          const permissions: Array<{ playerGuid: number; storageAccess: boolean }> = [];
          for (let i = 0; i < count; i++) {
            const playerGuid = r2.readUInt32();
            const value = r2.readUInt32();
            permissions.push({ playerGuid, storageAccess: value !== 0 });
          }
          this.handlers.onHouseUpdateRestrictions?.({
            sequence, objectGuid, version, openStatus, monarchId, permissions,
          });
        } catch (e) {
          console.warn('[AC] HouseUpdateRestrictions structured parse error:', e);
        }
        break;
      }
      case GameEventType.UpdateRentPayment: {
        // Surface raw for backward compat + parse structured.
        // Per GameEventHouseUpdateRentPayment.cs + HousePayment.cs Write(List):
        //   count u32 + N × HousePayment (Num int32 + Paid int32 + WeenieID u32 + Name S16L + PluralName S16L).
        this.handlers.onHouseUpdateRentPaymentRaw?.({ rawPayload: msg.payload });
        try {
          const r2 = new BinaryReader(msg.payload);
          const count = r2.readUInt32();
          const payments: Array<{
            num: number; paid: number; weenieId: number; name: string; pluralName: string;
          }> = [];
          for (let i = 0; i < count; i++) {
            payments.push({
              num: r2.readInt32(),
              paid: r2.readInt32(),
              weenieId: r2.readUInt32(),
              name: r2.readString16(),
              pluralName: r2.readString16(),
            });
          }
          this.handlers.onHouseUpdateRentPayment?.({ payments });
        } catch (e) {
          console.warn('[AC] UpdateRentPayment structured parse error:', e);
        }
        break;
      }
      // ── Portal storm warnings ────────────────────────────────────
      case GameEventType.MiscPortalStorm:
        this.handlers.onPortalStorm?.();
        break;
      case GameEventType.MiscPortalStormBrewing: {
        // GameEventPortalStormBrewing.cs: extent f32
        const extent = r.readFloat32();
        this.handlers.onPortalStormBrewing?.({ extent });
        break;
      }
      case GameEventType.MiscPortalStormImminent: {
        const extent = r.readFloat32();
        this.handlers.onPortalStormImminent?.({ extent });
        break;
      }
      case GameEventType.MiscPortalStormSubsided:
        this.handlers.onPortalStormSubsided?.();
        break;
      // ── Confirmation dialogs ─────────────────────────────────────
      case GameEventType.ConfirmationRequest: {
        // GameEventConfirmationRequest.cs: ConfirmationType u32 + context u32 + String16L text
        const confirmationType = r.readUInt32();
        const context = r.readUInt32();
        const text = r.readString16();
        this.handlers.onConfirmationRequest?.({ confirmationType, context, text });
        break;
      }
      case GameEventType.ConfirmationDone: {
        const confirmationType = r.readUInt32();
        const contextId = r.readUInt32();
        this.handlers.onConfirmationDone?.({ confirmationType, contextId });
        break;
      }
      // ── Silent enchantment dispel (no chat output) ───────────────
      case GameEventType.MagicDispelEnchantment: {
        // GameEventMagicDispelEnchantment.cs: SpellId u16 + Layer u16
        const spellId = r.readUInt16();
        const layer = r.readUInt16();
        this.handlers.onMagicDispelEnchantment?.({ spellId, layer });
        break;
      }
      case GameEventType.MagicDispelMultipleEnchantments: {
        // Per LayeredSpell.cs Write(List<LayeredSpell>): count u32 + N × (SpellId u16 + Layer u16)
        const count = r.readUInt32();
        const spells: Array<{ spellId: number; layer: number }> = [];
        for (let i = 0; i < count; i++) {
          spells.push({ spellId: r.readUInt16(), layer: r.readUInt16() });
        }
        this.handlers.onMagicDispelMultipleEnchantments?.({ spells });
        break;
      }
      // ── /age response ────────────────────────────────────────────
      case GameEventType.QueryAgeResponse: {
        // GameEventQueryAgeResponse.cs: targetName String16L + age String16L
        const targetName = r.readString16();
        const age = r.readString16();
        this.handlers.onQueryAgeResponse?.({ targetName, age });
        break;
      }
      // ── /querymana response ─────────────────────────────────────
      case GameEventType.QueryItemManaResponse: {
        // GameEventQueryItemManaResponse.cs: target u32 + mana f32 + success u32
        const targetGuid = r.readUInt32();
        const mana = r.readFloat32();
        const success = r.readUInt32();
        this.handlers.onQueryItemManaResponse?.({ targetGuid, mana, success });
        break;
      }
      // ── Contract tracker (quest UI) ─────────────────────────────
      case GameEventType.SendClientContractTracker: {
        // 28-byte ContractTracker + DeleteContract u32 + SetAsDisplayContract u32
        const entry = readContractTracker(r);
        const deleteContract = r.readUInt32() !== 0;
        const setAsDisplayContract = r.readUInt32() !== 0;
        this.handlers.onContractTracker?.({
          contract: entry, deleteContract, setAsDisplayContract,
        });
        break;
      }
      case GameEventType.SendClientContractTrackerTable: {
        // PackableHashTable header: count u16 + numBuckets u16, then count × (key u32 + ContractTracker)
        const count = r.readUInt16();
        const numBuckets = r.readUInt16();
        const contracts: Array<{ key: number; entry: ContractTrackerEntry }> = [];
        for (let i = 0; i < count; i++) {
          const key = r.readUInt32();
          const entry = readContractTracker(r);
          contracts.push({ key, entry });
        }
        this.handlers.onContractTrackerTable?.({ numBuckets, contracts });
        break;
      }
      // ── Allegiance info response (player query) ─────────────────
      case GameEventType.AllegianceInfoResponse: {
        // GameEventAllegianceInfoResponse.cs: playerGuid u32 + AllegianceProfile.
        // AllegianceProfile.Write: totalMembers u32 + totalVassals u32 + AllegianceHierarchy.
        // AllegianceHierarchy.Write: recordCount u16 + oldVersion u16 + officers Dict
        //   (PackableHashTable header + N × (guid + level u32)) + officerTitles List<String16L>
        //   + 4 broadcast counters u32 + motd S16L + motdSetBy S16L + chatRoomId u32 +
        //   bindPoint Position (Cell u32 + Vec3 + Quaternion) + allegianceName S16L +
        //   nameLastSetTime u32 + isLocked u32 + approvedVassal int32 + optional monarchData/records.
        const playerGuid = r.readUInt32();
        const rawPayload = msg.payload.slice(r.position);
        this.handlers.onAllegianceInfoResponseRaw?.({ playerGuid, rawPayload });
        try {
          const totalMembers = r.readUInt32();
          const totalVassals = r.readUInt32();
          const recordCount = r.readUInt16();
          const oldVersion = r.readUInt16();
          // Officers PackableHashTable header (count u16 + buckets u16) + N × (guid u32 + level u32)
          const officerCount = r.readUInt16();
          r.readUInt16(); // numBuckets, unused on read
          const officers: Array<{ guid: number; officerLevel: number }> = [];
          for (let i = 0; i < officerCount; i++) {
            officers.push({ guid: r.readUInt32(), officerLevel: r.readUInt32() });
          }
          // officerTitles List<string>: count u32 + N × String16L
          const titleCount = r.readUInt32();
          const officerTitles: string[] = [];
          for (let i = 0; i < titleCount; i++) officerTitles.push(r.readString16());
          const monarchBroadcastTime = r.readUInt32();
          const monarchBroadcastsToday = r.readUInt32();
          const spokesBroadcastTime = r.readUInt32();
          const spokesBroadcastsToday = r.readUInt32();
          const motd = r.readString16();
          const motdSetBy = r.readString16();
          const chatRoomId = r.readUInt32();
          // Position: Cell u32 + Vec3 (3 f32) + Quaternion (W,X,Y,Z f32)
          const bindPoint = {
            cell: r.readUInt32(),
            x: r.readFloat32(), y: r.readFloat32(), z: r.readFloat32(),
            rw: r.readFloat32(), rx: r.readFloat32(), ry: r.readFloat32(), rz: r.readFloat32(),
          };
          const allegianceName = r.readString16();
          const nameLastSetTime = r.readUInt32();
          const isLocked = r.readUInt32() !== 0;
          const approvedVassal = (r.readUInt32() | 0);
          const recordsStart = r.position;
          const recordsRaw = msg.payload.slice(recordsStart);
          // Try to parse the variable-length records list. recordCount entries:
          // entry 0 is the monarch (NO treeParent prefix), entries 1..recordCount-1
          // each have a preceding ObjectGuid treeParent.
          let records: AllegianceRecord[] | undefined;
          try {
            const list: AllegianceRecord[] = [];
            for (let i = 0; i < recordCount && r.remaining > 0; i++) {
              if (i === 0) {
                list.push(readAllegianceData(r));
              } else {
                const treeParent = r.readUInt32();
                const rec = readAllegianceData(r);
                rec.treeParent = treeParent;
                list.push(rec);
              }
            }
            records = list;
          } catch (recordErr) {
            console.warn('[AC] AllegianceData records parse error (falling back to recordsRaw):', recordErr);
            records = undefined;
          }
          this.handlers.onAllegianceInfo?.({
            playerGuid, totalMembers, totalVassals,
            recordCount, oldVersion,
            officers, officerTitles,
            monarchBroadcastTime, monarchBroadcastsToday,
            spokesBroadcastTime, spokesBroadcastsToday,
            motd, motdSetBy, chatRoomId, bindPoint,
            allegianceName, nameLastSetTime, isLocked, approvedVassal,
            recordsRaw, records,
          });
        } catch (e) {
          console.warn('[AC] AllegianceInfoResponse partial parse error:', e);
        }
        break;
      }
      // ── Chess minigame events ────────────────────────────────────
      // boardGuid u32 + color/result int32 — 8 bytes for the simple ones.
      case GameEventType.StartGame: {
        const boardGuid = r.readUInt32();
        const color = r.readUInt32() | 0;
        this.handlers.onChessStartGame?.({ boardGuid, color });
        break;
      }
      case GameEventType.GameOver: {
        const boardGuid = r.readUInt32();
        const teamWinner = r.readUInt32() | 0;
        this.handlers.onChessGameOver?.({ boardGuid, teamWinner });
        break;
      }
      case GameEventType.JoinGameResponse: {
        const boardGuid = r.readUInt32();
        const color = r.readUInt32() | 0; // -1 = failure
        this.handlers.onChessJoinGameResponse?.({ boardGuid, color });
        break;
      }
      case GameEventType.MoveResponse: {
        const boardGuid = r.readUInt32();
        const result = r.readUInt32() | 0;
        this.handlers.onChessMoveResponse?.({ boardGuid, result });
        break;
      }
      case GameEventType.OpponentStalemate: {
        const boardGuid = r.readUInt32();
        const color = r.readUInt32() | 0;
        const stalemate = (r.readUInt32() | 0) !== 0;
        this.handlers.onChessOpponentStalemate?.({ boardGuid, color, stalemate });
        break;
      }
      case GameEventType.OpponentTurn: {
        // boardGuid u32 + color int32 + ChessMoveData
        const boardGuid = r.readUInt32();
        const color = r.readUInt32() | 0;
        const rawMoveData = msg.payload.slice(r.position);
        this.handlers.onChessOpponentTurnRaw?.({ boardGuid, color, rawMoveData });
        // Structured ChessMoveData parse — moveType int32 + playerGuid u32 + variable body.
        try {
          const r2 = new BinaryReader(rawMoveData);
          const moveType = r2.readUInt32() | 0;
          const playerGuid = r2.readUInt32();
          let from: { x: number; y: number } | undefined;
          let to: { x: number; y: number } | undefined;
          let pieceGuid: number | undefined;
          // ChessMoveType wire values per ACE source: Grid=4, FromTo=5,
          // SelectedPiece=6 (default-indexed C# enum, written as int32 by
          // ACE.Server/Network/Structure/ChessMoveData.cs:Write). Pre-FAITHFUL.117
          // this code dispatched on 1/2/3 which matched no part of ACE source —
          // FromTo (the only type actually used in live play per ACE comment
          // "only ChessMoveType.FromTo used?") silently fell through.
          if (moveType === ChessMoveType.Grid) {
            to = { x: r2.readUInt32() | 0, y: r2.readUInt32() | 0 };
          } else if (moveType === ChessMoveType.FromTo) {
            from = { x: r2.readUInt32() | 0, y: r2.readUInt32() | 0 };
            to = { x: r2.readUInt32() | 0, y: r2.readUInt32() | 0 };
          } else if (moveType === ChessMoveType.SelectedPiece) {
            pieceGuid = r2.readUInt32();
          }
          this.handlers.onChessOpponentTurn?.({
            boardGuid, color, moveType, playerGuid, from, to, pieceGuid,
          });
        } catch (e) {
          console.warn('[AC] OpponentTurn ChessMoveData parse error:', e);
        }
        break;
      }
      // ── Turbine chat channel mgmt ───────────────────────────────
      case GameEventType.ChannelIndex: {
        // GameEventChannelIndex.cs: up to three independent (not else-if)
        // count u32 + N × String16L blocks concatenated back to back — one
        // each for IsAdmin (8 names), IsArch||IsSentinel (7 names), and
        // IsAdvocate (5 names). These flags aren't mutually exclusive, so a
        // GM account can have 0-3 blocks in one payload; loop until the
        // reader runs out of bytes.
        const channels: string[] = [];
        while (r.remaining > 0) {
          const count = r.readUInt32();
          for (let i = 0; i < count; i++) channels.push(r.readString16());
        }
        this.handlers.onChannelIndex?.({ channels });
        break;
      }
      case GameEventType.ChannelList: {
        // GameEventChannelList.cs: count u32 + N × String16L player names.
        const count = r.readUInt32();
        const players: string[] = [];
        for (let i = 0; i < count; i++) players.push(r.readString16());
        this.handlers.onChannelList?.({ players });
        break;
      }
      // ── Barber initialization ────────────────────────────────────
      case GameEventType.StartBarber: {
        // GameEventStartBarber.cs: 14 u32 (palettes/textures/setup) + 2 int32 (options)
        this.handlers.onStartBarber?.({
          paletteBaseDID: r.readUInt32(),
          headObjectDID: r.readUInt32(),
          hairTexture: r.readUInt32(),
          defaultHairTexture: r.readUInt32(),
          eyesTextureDID: r.readUInt32(),
          defaultEyesTextureDID: r.readUInt32(),
          noseTextureDID: r.readUInt32(),
          defaultNoseTextureDID: r.readUInt32(),
          mouthTextureDID: r.readUInt32(),
          defaultMouthTextureDID: r.readUInt32(),
          skinPaletteDID: r.readUInt32(),
          hairPaletteDID: r.readUInt32(),
          eyesPaletteDID: r.readUInt32(),
          setupTableId: r.readUInt32(),
          option1: r.readUInt32() | 0,
          option2: r.readUInt32() | 0,
        });
        break;
      }

      default:
        this.logUnhandled('event', eventType);
    }
  }

  // ─── Complex message parsers ────────────────────────────────────

  private handleUpdatePosition(payload: Uint8Array): void {
    const r = new BinaryReader(payload);
    const guid = r.readUInt32();
    const flags = r.readUInt32();

    // PositionPack format per ACE PositionFlags.cs.
    const landblock = r.readUInt32();
    const x = r.readFloat32();
    const y = r.readFloat32();
    const z = r.readFloat32();

    // Rotation: each OrientationHasNoX flag bit means that component is OMITTED (assumed 0)
    let rw = 0, rx = 0, ry = 0, rz = 0;
    if ((flags & PositionFlags.OrientationHasNoW) === 0) rw = r.readFloat32();
    if ((flags & PositionFlags.OrientationHasNoX) === 0) rx = r.readFloat32();
    if ((flags & PositionFlags.OrientationHasNoY) === 0) ry = r.readFloat32();
    if ((flags & PositionFlags.OrientationHasNoZ) === 0) rz = r.readFloat32();

    let velocityX, velocityY, velocityZ;
    if (flags & PositionFlags.HasVelocity) {
      velocityX = r.readFloat32();
      velocityY = r.readFloat32();
      velocityZ = r.readFloat32();
    }

    if (flags & PositionFlags.HasPlacementID) {
      r.readUInt32(); // placementId
    }

    // PositionFlags.IsGrounded — flag only, no data to read

    // Instance timestamps (always present)
    const instanceSequence = r.readUInt16();
    const positionSequence = r.readUInt16();
    const teleportSequence = r.readUInt16();
    const forcePositionSequence = r.readUInt16();

    this.handlers.onUpdatePosition?.({
      guid, flags, landblock, x, y, z, rw, rx, ry, rz,
      velocityX, velocityY, velocityZ,
      instanceSequence, positionSequence, teleportSequence, forcePositionSequence,
    });
  }

  private handleAutonomousPosition(payload: Uint8Array): void {
    // GameMessageAutonomousPosition.cs: Guid, then Position.Serialize(w, true,
    // false) -- writeQuaternion=true, writeLandblock=false, so NO flags field
    // and NO landblock field (unlike UpdatePosition's PositionPack), just an
    // unconditional x/y/z + full wxyz quaternion. Then 4 ushort sequences
    // (ObjectInstance, ObjectServerControl, ObjectTeleport,
    // ObjectForcePosition -- note ObjectServerControl here, not ObjectPosition
    // as UpdatePosition uses) and a trailing uint32 "contact" flag that
    // UpdatePosition never writes.
    const r = new BinaryReader(payload);
    const guid = r.readUInt32();
    const x = r.readFloat32();
    const y = r.readFloat32();
    const z = r.readFloat32();
    const rw = r.readFloat32();
    const rx = r.readFloat32();
    const ry = r.readFloat32();
    const rz = r.readFloat32();
    const instanceSequence = r.readUInt16();
    const serverControlSequence = r.readUInt16();
    const teleportSequence = r.readUInt16();
    const forcePositionSequence = r.readUInt16();
    const contact = r.readUInt32();

    this.handlers.onAutonomousPosition?.({
      guid, x, y, z, rw, rx, ry, rz,
      instanceSequence, serverControlSequence, teleportSequence, forcePositionSequence,
      contact,
    });
  }

  private handleHearSpeech(payload: Uint8Array, ranged: boolean): void {
    // FAITHFUL.336 — RangedSpeech wire format inserts an extra `range`
    // float32 between senderID and chatMessageType per
    // `GameMessageHearRangedSpeech.cs:9-15`:
    //   string16 messageText + string16 senderName + uint32 senderID
    //   + float32 range + uint32 chatMessageType
    // Plain HearSpeech (`GameMessageHearSpeech.cs:8-13`) does NOT have
    // the range field. Pre-fix both parsed with the same shape, so
    // RangedSpeech read the range's bit pattern as chatType and never
    // touched the actual chatType. /shout messages were rendering with
    // the default grey color instead of the canonical retail magenta.
    const r = new BinaryReader(payload);
    const message = r.readString16();
    const senderName = r.readString16();
    const senderGuid = r.readUInt32();
    const range = ranged ? r.readFloat32() : undefined;
    const chatType = r.readUInt32();

    const handler = ranged ? this.handlers.onHearRangedSpeech : this.handlers.onHearSpeech;
    handler?.({ message, senderName, senderGuid, chatType, range });
  }

  private handleTurbineChat(payload: Uint8Array): void {
    try {
      const r = new BinaryReader(payload);
      // ACE GameMessageTurbineChat.cs wire format (NETBLOB_EVENT_BINARY=1, lines 79-114):
      //   u32 firstSize       — placeholder, patched at end
      //   u32 chatNetworkBlobType
      //   u32 chatNetworkBlobDispatchType
      //   u32 1u              — targetType
      //   u32 0x000B00B5      — targetID
      //   u32 1u              — transportType
      //   u32 0x000B00B5      — transportID
      //   u32 0u              — cookie
      //   u32 secondSize      — placeholder, patched at end
      //   u32 channel
      //   UnicodeStr senderName  — 1-byte length (high bit set = 2-byte ext) + UTF-16 bytes
      //   UnicodeStr message     — same encoding
      //   u32 0x0Cu
      //   u32 senderID
      //   u32 0u              — hResult
      //   u32 chatType
      // Pre-FAITHFUL.169 parser read only 9 of these 17 fields and mislabeled:
      //   - blobDispatchType read as "always 0" (it carries blobDispatchType, usually 1)
      //   - targetType (1u) read as channelId (real channel is 5 fields later)
      //   - transportID (0x000B00B5) read as senderGuid (real one is later)
      //   - secondSize+channel bytes interpreted as a UTF-8 string16
      // Effect: every TurbineChat message silently fell into the try/catch.
      r.readUInt32(); // firstSize — placeholder
      const type = r.readUInt32();

      if (type === ChatNetworkBlobType.NETBLOB_EVENT_BINARY) {
        const blobDispatchType = r.readUInt32();
        r.readUInt32(); // targetType (1u)
        r.readUInt32(); // targetID (0x000B00B5)
        r.readUInt32(); // transportType (1u)
        r.readUInt32(); // transportID (0x000B00B5)
        r.readUInt32(); // cookie (0u)
        r.readUInt32(); // secondSize — placeholder
        const channelId = r.readUInt32();
        const senderName = readUnicodeStr(r);
        const message = readUnicodeStr(r);
        r.readUInt32(); // 0x0Cu sentinel
        const senderGuid = r.readUInt32();
        r.readUInt32(); // hResult (0u)
        const chatType = r.readUInt32();

        this.handlers.onTurbineChat?.({
          type, channelId, senderName, message, senderGuid, isSystemMessage: false,
          blobDispatchType, chatType,
        });
      } else if (type === ChatNetworkBlobType.NETBLOB_RESPONSE_BINARY) {
        // FAITHFUL.532 — RESPONSE_BINARY is the server's per-request ACK
        // following a client TurbineChat send (responseID/methodID/hResult
        // only — no message text per ACE GameMessageTurbineChat.cs:115-136).
        // Pre-fix this fired `onTurbineChat` with `isSystemMessage: true`
        // + `message: ''`, and the renderer's onTurbineChat handler
        // (main.ts:5387) rendered `[System] ${data.message}` — yielding
        // a phantom empty `[System] ` line in the chat log every time
        // the local client sent a channel message. ACK has no user-facing
        // payload — drop silently.
        return;
      }
    } catch {
      // TurbineChat format varies, gracefully ignore parse errors
    }
  }

  private handleObjDescEvent(payload: Uint8Array): void {
    const r = new BinaryReader(payload);
    const guid = r.readUInt32();

    const modelByte = r.readUInt8(); // 0x11
    const numSubPalettes = r.readUInt8();
    const numTexChanges = r.readUInt8();
    const numAnimParts = r.readUInt8();

    let basePalette = 0;
    const subPalettes: ObjDescEventData['subPalettes'] = [];
    if (numSubPalettes > 0) {
      basePalette = r.readPackedDwordOfKnownType(0x04000000);
    }
    for (let i = 0; i < numSubPalettes; i++) {
      const paletteId = r.readPackedDwordOfKnownType(0x04000000);
      const rawOffset = r.readUInt8();
      const rawLength = r.readUInt8();
      subPalettes.push({
        paletteId,
        offset: rawOffset * 8,
        length: (rawLength === 0 ? 256 : rawLength) * 8,
      });
    }

    const textureChanges: ObjDescEventData['textureChanges'] = [];
    for (let i = 0; i < numTexChanges; i++) {
      textureChanges.push({
        partIndex: r.readUInt8(),
        oldTexture: r.readPackedDwordOfKnownType(0x05000000),
        newTexture: r.readPackedDwordOfKnownType(0x05000000),
      });
    }

    const animPartChanges: ObjDescEventData['animPartChanges'] = [];
    for (let i = 0; i < numAnimParts; i++) {
      animPartChanges.push({
        partIndex: r.readUInt8(),
        partId: r.readPackedDwordOfKnownType(0x01000000),
      });
    }

    // Per ACE WorldObject_Networking.cs:255 SerializeModelData ends with
    // `writer.Align();` (default 4-byte boundary). The two trailing UShort
    // sequence numbers from SerializeUpdateModelData lines 52-53 follow:
    //   writer.Write(GetCurrentSequence(SequenceType.ObjectInstance));    // u16
    //   writer.Write(GetNextSequence(SequenceType.ObjectVisualDesc));     // u16
    r.align(4);
    const instanceSequence = r.readUInt16();
    const visualDescSequence = r.readUInt16();

    this.handlers.onObjDescEvent?.({
      guid, basePalette, subPalettes, textureChanges, animPartChanges,
      instanceSequence, visualDescSequence,
    });
  }

  private handleAttackerNotification(payload: Uint8Array): void {
    // Wire format from ACE GameEventAttackerNotification.cs:
    //   string16 defenderName  +  uint32 damageType  +  double percent
    //   uint32 damage  +  uint32 critical  +  ulong attackConditions
    // Notably AttackerNotification has NO body-part / damage-location field
    // (that's only on DefenderNotification). Reading uint32 in place of the
    // 8-byte double caused 4-byte slippage and the 1.07e9 garbage damage
    // numbers seen in COMBAT.2.
    const r = new BinaryReader(payload);
    const defenderName = r.readString16();
    const damageType = r.readUInt32();
    const severity = r.readFloat64();
    const damage = r.readUInt32();
    const critical = r.readUInt32() !== 0;
    // attackConditions is `ulong` on the wire (8 bytes). The actual flag enum
    // fits in 4 bits so we read the low uint32 and skip the upper 4 zero bytes.
    const attackConditions = r.readUInt32();
    r.skip(4);
    this.handlers.onAttackerNotification?.({
      attackerName: '', defenderName, damageType, severity, damage, bodyPart: 0, critical, attackConditions,
    });
  }

  private handleDefenderNotification(payload: Uint8Array): void {
    // Wire format from ACE GameEventDefenderNotification.cs:
    //   string16 attackerName  +  uint32 damageType  +  double percent
    //   uint32 damage  +  uint32 damageLocation  +  uint32 critical
    //   ulong attackConditions  +  Align()
    const r = new BinaryReader(payload);
    const attackerName = r.readString16();
    const damageType = r.readUInt32();
    const severity = r.readFloat64();
    const damage = r.readUInt32();
    const bodyPart = r.readUInt32();
    const critical = r.readUInt32() !== 0;
    const attackConditions = r.readUInt32();
    r.skip(4);
    this.handlers.onDefenderNotification?.({
      attackerName, defenderName: '', damageType, severity, damage, bodyPart, critical, attackConditions,
    });
  }

  private handleIdentifyResponse(payload: Uint8Array): void {
    // ACE IdentifyResponseFlags (NOT generic property flags!):
    // 0x0001 = IntStatsTable, 0x0002 = BoolStatsTable, 0x0004 = FloatStatsTable,
    // 0x0008 = StringStatsTable, 0x0010 = SpellBook, 0x0020 = WeaponProfile,
    // 0x0040 = HookProfile, 0x0080 = ArmorProfile, 0x0100 = CreatureProfile,
    // 0x1000 = DidStatsTable, 0x2000 = Int64StatsTable
    // Serialization order: Int, Int64, Bool, Float, String, Did, Spell, Armor, Creature, Weapon, Hook
    const r = new BinaryReader(payload);
    let result: IdentifyResponseData | undefined;
    try {
      const guid = r.readUInt32();
      const flags = r.readUInt32();
      // The appraisal succeeded (ACE Player.SuccessfulAppraise / IdentifyObject
      // Response `Success`): a failed creature appraisal shows "???" /
      // health-only rows (CreatureExamineUI — ui/examine/CreatureAppraisalText).
      const success = r.readUInt32() !== 0;

      result = { guid, flags, success };

      // 1. IntStatsTable
      if (flags & IdentifyResponseFlags.IntStatsTable) {
        const count = r.readUInt16();
        r.readUInt16(); // bucketSize
        result.propertiesInt = new Map();
        for (let i = 0; i < count; i++) {
          result.propertiesInt.set(r.readUInt32(), r.readInt32());
        }
      }
      // 2. Int64StatsTable
      if (flags & IdentifyResponseFlags.Int64StatsTable) {
        const count = r.readUInt16();
        r.readUInt16();
        result.propertiesInt64 = new Map();
        for (let i = 0; i < count; i++) {
          const key = r.readUInt32();
          result.propertiesInt64.set(key, r.readInt64());
        }
      }
      // 3. BoolStatsTable
      if (flags & IdentifyResponseFlags.BoolStatsTable) {
        const count = r.readUInt16();
        r.readUInt16();
        result.propertiesBool = new Map();
        for (let i = 0; i < count; i++) {
          result.propertiesBool.set(r.readUInt32(), r.readUInt32() !== 0);
        }
      }
      // 4. FloatStatsTable
      if (flags & IdentifyResponseFlags.FloatStatsTable) {
        const count = r.readUInt16();
        r.readUInt16();
        result.propertiesFloat = new Map();
        for (let i = 0; i < count; i++) {
          result.propertiesFloat.set(r.readUInt32(), r.readFloat64());
        }
      }
      // 5. StringStatsTable
      if (flags & IdentifyResponseFlags.StringStatsTable) {
        const count = r.readUInt16();
        r.readUInt16();
        result.propertiesString = new Map();
        for (let i = 0; i < count; i++) {
          result.propertiesString.set(r.readUInt32(), r.readString16());
        }
      }
      // 6. DidStatsTable
      if (flags & IdentifyResponseFlags.DidStatsTable) {
        const count = r.readUInt16();
        r.readUInt16();
        result.propertiesDataID = new Map();
        for (let i = 0; i < count; i++) {
          result.propertiesDataID.set(r.readUInt32(), r.readUInt32());
        }
      }
      // 7. SpellBook: u32 count + N × u32 spellIds.
      //    Per ACE AppraiseInfo.cs:21 + Network/Structure/PackableList.cs:
      //    intrinsic spells = plain ID, active enchantments = (ID | 0x80000000).
      if (flags & IdentifyResponseFlags.SpellBook) {
        const count = r.readUInt32();
        result.spellBook = [];
        result.activeEnchantments = [];
        const ENCHANTMENT_MASK = 0x80000000;
        for (let i = 0; i < count; i++) {
          const raw = r.readUInt32() >>> 0;
          if (raw & ENCHANTMENT_MASK) {
            result.activeEnchantments.push(raw & ~ENCHANTMENT_MASK);
          } else {
            result.spellBook.push(raw);
          }
        }
      }
      // 8. ArmorProfile — 8 floats per ArmorProfile.cs:67-77.
      //    Order: Slash, Pierce, Bludgeon, Cold, Fire, Acid, Nether, Lightning.
      if (flags & IdentifyResponseFlags.ArmorProfile) {
        result.armorProfile = {
          slashing: r.readFloat32(),
          piercing: r.readFloat32(),
          bludgeoning: r.readFloat32(),
          cold: r.readFloat32(),
          fire: r.readFloat32(),
          acid: r.readFloat32(),
          nether: r.readFloat32(),
          lightning: r.readFloat32(),
        };
      }
      // 9. CreatureProfile — variable length per CreatureProfile.cs:79-107.
      //    profileFlags u32 + health u32 + healthMax u32, then:
      //    if ShowAttributes (0x8): 6 attribute u32s + stam u32 + mana u32 + stamMax u32 + manaMax u32 (40 bytes)
      //    if HasBuffsDebuffs (0x1): highlights u16 + colors u16
      if (flags & IdentifyResponseFlags.CreatureProfile) {
        const pf = r.readUInt32();
        const cp: NonNullable<typeof result.creatureProfile> = {
          profileFlags: pf,
          health: r.readUInt32(),
          healthMax: r.readUInt32(),
        };
        if (pf & CreatureProfileFlags.ShowAttributes) {
          cp.attributes = {
            strength: r.readUInt32(),
            endurance: r.readUInt32(),
            quickness: r.readUInt32(),
            coordination: r.readUInt32(),
            focus: r.readUInt32(),
            self: r.readUInt32(),
            stamina: r.readUInt32(),
            mana: r.readUInt32(),
            staminaMax: r.readUInt32(),
            manaMax: r.readUInt32(),
          };
        }
        if (pf & CreatureProfileFlags.HasBuffsDebuffs) {
          cp.attributeHighlights = r.readUInt16();
          cp.attributeColors = r.readUInt16();
        }
        result.creatureProfile = cp;
      }
      // 10. WeaponProfile — 60 bytes per WeaponProfile.cs:
      //    DamageType u32 + WeaponTime u32 + WeaponSkill u32 + Damage u32 +
      //    DamageVariance f64 + DamageMod f64 + WeaponLength f64 + MaxVelocity f64 +
      //    WeaponOffense f64 + MaxVelocityEstimated u32. (WeaponDefense goes elsewhere.)
      //    WeaponTime and Damage are read SIGNED: retail's appraisal tests them
      //    `< 0` for "Unknown" (a failed 1999 appraisal sends -1), and ACE's
      //    are uints clamped to Math.Max(0, …) far below 2^31, so every value
      //    an end-of-retail server sends reads the same.
      if (flags & IdentifyResponseFlags.WeaponProfile) {
        result.weaponProfile = {
          damageType: r.readUInt32(),
          weaponTime: r.readInt32(),
          weaponSkill: r.readUInt32(),
          damage: r.readInt32(),
          damageVariance: r.readFloat64(),
          damageMod: r.readFloat64(),
          weaponLength: r.readFloat64(),
          maxVelocity: r.readFloat64(),
          weaponOffense: r.readFloat64(),
          maxVelocityEstimated: r.readUInt32(),
        };
      }
      // 11. HookProfile — 12 bytes per HookProfile.cs.
      if (flags & IdentifyResponseFlags.HookProfile) {
        result.hookProfile = {
          hookFlags: r.readUInt32(),
          validLocations: r.readUInt32(),
          ammoType: r.readUInt32(),
        };
      }
      // Bitfield order in AppraiseInfo.cs:761-775: Armor first, then Weapon, then Resist.
      // (Bit number order ≠ byte order here either.)
      if (flags & IdentifyResponseFlags.ArmorEnchantmentBitfield) {
        result.armorEnchantment = { highlight: r.readUInt16(), color: r.readUInt16() };
      }
      if (flags & IdentifyResponseFlags.WeaponEnchantmentBitfield) {
        result.weaponEnchantment = { highlight: r.readUInt16(), color: r.readUInt16() };
      }
      if (flags & IdentifyResponseFlags.ResistEnchantmentBitfield) {
        result.resistEnchantment = { highlight: r.readUInt16(), color: r.readUInt16() };
      }
      // 12. ArmorLevels — 9 × u32 per ArmorLevel.cs. Always last.
      if (flags & IdentifyResponseFlags.ArmorLevels) {
        result.armorLevels = {
          head: r.readUInt32(),
          chest: r.readUInt32(),
          abdomen: r.readUInt32(),
          upperArm: r.readUInt32(),
          lowerArm: r.readUInt32(),
          hand: r.readUInt32(),
          upperLeg: r.readUInt32(),
          lowerLeg: r.readUInt32(),
          foot: r.readUInt32(),
        };
      }

      this.handlers.onIdentifyResponse?.(result);
    } catch (e) {
      console.warn('[AC] IdentifyResponse parse error at position', r.position, 'of', payload.byteLength, ':', e);
      // Mirror PlayerDescriptionParser's partial-result recovery: sections
      // already parsed onto `result` before the throw are still valid and
      // more useful to the appraisal UI than dropping the whole response.
      if (result) {
        this.handlers.onIdentifyResponse?.(result);
      }
    }
  }

  // ─── Debug logging ──────────────────────────────────────────────

  /** The ten uint32s of SetTurbineChatChannels (see the GameEvent case). */
  private dispatchTurbineChatChannels(r: BinaryReader): void {
    const allegiance = r.readUInt32();
    r.readUInt32(); // General (fixed 2)
    r.readUInt32(); // Trade (fixed 3)
    r.readUInt32(); // LFG (fixed 4)
    r.readUInt32(); // Roleplay (fixed 5)
    r.readUInt32(); // Olthoi (fixed 10)
    const society = r.readUInt32();
    r.readUInt32(); // SocietyCelestialHand (fixed 7)
    r.readUInt32(); // SocietyEldrytchWeb (fixed 8)
    r.readUInt32(); // SocietyRadiantBlood (fixed 9)
    this.handlers.onSetTurbineChatChannels?.({ allegiance, society });
  }

  private logUnhandled(type: string, code: number): void {
    const key = `${type}:0x${code.toString(16)}`;
    if (!this.loggedOpcodes.has(key)) {
      this.loggedOpcodes.add(key);
      const name = type === 'event' ? getGameEventTypeName(code) : `0x${code.toString(16).toUpperCase()}`;
      console.log(`[ServerMsg] Unhandled ${type}: ${name}`);
    }
  }
}

/**
 * AllegianceData record reader. Wire format per
 *   reference/ACE/Source/ACE.Server/Network/Structure/AllegianceData.cs Write.
 * Variable-length: 24 bytes header + conditional level (4 bytes if HasPackedLevel) +
 * 4 bytes loyalty/leadership + 8 bytes age block + String16L name (padded to 4).
 *
 * Caller must already know whether this entry is the monarch (no treeParent prefix)
 * or a vassal (4-byte treeParent guid prefix) — that distinction is positional, not
 * encoded in the AllegianceData payload itself.
 */
type AllegianceRecord = NonNullable<NonNullable<ServerMessageHandlers['onAllegianceInfo']> extends ((arg: infer A) => unknown) ? A : never>['records'] extends (infer R)[] | undefined ? R : never;

/**
 * Read an ACE TurbineChat-style Unicode string per GameMessageTurbineChat.cs:95-105.
 *
 * Length encoding:
 *   if length < 128 (high bit clear): 1 byte length
 *   else: 1 ushort with bit pattern (0x80 | (length << 8)) — high bit set in
 *     the low byte signals 2-byte form; the actual length lives in the high byte
 * Body: `length` UTF-16 LE code units = `length * 2` bytes.
 *
 * ACE writes via `Encoding.Unicode.GetBytes(...)` which is UTF-16 LE on Windows/.NET.
 */
function readUnicodeStr(r: BinaryReader): string {
  const firstByte = r.readUInt8();
  let length: number;
  if ((firstByte & 0x80) === 0) {
    length = firstByte;
  } else {
    // Two-byte form: low byte already has 0x80 set; high byte carries the length
    const highByte = r.readUInt8();
    length = highByte;
  }
  const byteCount = length * 2;
  const bytes = r.readBytes(byteCount);
  return new TextDecoder('utf-16le').decode(bytes);
}

function readAllegianceData(r: BinaryReader): AllegianceRecord {
  const characterID = r.readUInt32();
  const cpCached = r.readUInt32();
  const cpTithed = r.readUInt32();
  const bitfield = r.readUInt32();
  const gender = r.readUInt8();
  const heritageGroup = r.readUInt8();
  const rank = r.readUInt16();
  const level = (bitfield & AllegianceIndex.HasPackedLevel) ? r.readUInt32() : undefined;
  const loyalty = r.readUInt16();
  const leadership = r.readUInt16();
  let timeOnline: number | undefined;
  let allegianceAge: number | undefined;
  let uTimeOnline: bigint | undefined;
  if (bitfield & AllegianceIndex.HasAllegianceAge) {
    timeOnline = r.readUInt32();
    allegianceAge = r.readUInt32();
  } else {
    // ACE writes ulong (8 bytes). Combine two u32s into a bigint.
    const lo = r.readUInt32() >>> 0;
    const hi = r.readUInt32() >>> 0;
    uTimeOnline = (BigInt(hi) << BigInt(32)) | BigInt(lo);
  }
  const name = r.readString16();
  return {
    characterID, cpCached, cpTithed, bitfield, gender, heritageGroup, rank,
    level, loyalty, leadership, timeOnline, allegianceAge, uTimeOnline, name,
  } as AllegianceRecord;
}

/** ContractTracker reader — 28 bytes per ACE ContractTracker.cs:137-148. */
function readContractTracker(r: BinaryReader): ContractTrackerEntry {
  return {
    version: r.readUInt32(),
    contractId: r.readUInt32(),
    stage: r.readUInt32(),
    timeWhenDone: r.readFloat64(),
    timeWhenRepeats: r.readFloat64(),
  };
}
