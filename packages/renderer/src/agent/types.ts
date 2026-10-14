/**
 * The agent API's wire shapes: what `window.__acAgent` returns to an LLM
 * player (through tools/ac-agent) and, later, what the first-party
 * automation layer (docs/automation-and-plugins.md) reads. Everything here
 * is plain JSON so it crosses page.evaluate unchanged.
 */

/** Coarse object kinds an agent reasons about (derived from ItemType / WeenieType / flags). */
export type AgentObjectKind =
  | 'monster' | 'npc' | 'player' | 'vendor' | 'corpse' | 'door' | 'portal' | 'lifestone'
  | 'container' | 'item' | 'other';

export interface AgentObject {
  guid: number;
  name: string;
  kind: AgentObjectKind;
  /** Horizontal distance from the player, metres. */
  dist: number;
  /** Compass bearing from the player, degrees (0 = north, 90 = east). */
  bearing: number;
  /** Bearing relative to the player's facing, degrees in (-180, 180]; negative = to the left. */
  relBearing: number;
  /** Height difference (object − player), metres. */
  dz: number;
  /** Health fraction 0..1 when the client knows it (selected / queried creatures). */
  health?: number;
  /** Stack size for stackable items. */
  stack?: number;
  /** Creature level, when the server has sent it. */
  level?: number;
  /** Doors only: true when it stands open (Using an open door closes it), false when shut. */
  open?: boolean;
  /**
   * Doors only: it won't open by hand. Its ItemUseable is No (a "doordungeonactivated" door), or a Use of it got
   * retail's "You can't open or close this Door that way": something linked to it (a lever, switch or pressure plate)
   * opens it.
   */
  notByHand?: boolean;
  /** Monsters only: its death has begun (the corpse follows); not a target. */
  dying?: boolean;
  /** Set on a remembered place that is out of view: seconds since it was last seen. */
  seenAgo?: number;
  /** Monsters only: how many of its attacks on you (hits, misses, evades) the last 10 s of combat lines named. */
  attackingYou?: number;
  /**
   * Monsters only, when not yet attacking you: it is coming at you, and how the client knows: "running at you" (its
   * server MoveToObject is aimed at you: ACE Monster_Navigation chasing its AttackTarget), "turned to face you" (a
   * TurnToObject at you, before a charge or a spell), or "closing, 6 m nearer in 3 s" (its own movement toward you).
   */
  comingAtYou?: string;
  /**
   * Monsters only: what this kind of creature (by name) was seen doing to you this session, from the server's own
   * lines: "casts Frost Bolt II (40), Drain Health Other II; hits up to 6". Nothing hidden: only what a player saw.
   */
  seen?: string;
  /**
   * The target only: a wall, the ground or a solid object stands this far (m) along the straight line to it, so a
   * bolt or arrow would hit that instead (the client's own missile collision; creatures are not counted).
   */
  lineOfFireBlockedAt?: number;
  /** What stands there: an object's name, "a wall", "the ceiling", "the floor or ground". */
  lineOfFireBlocker?: string;
  /** The blocked line is a missile's arc (a bow or thrown weapon ready), not a bolt's straight line. */
  lineOfFireArc?: boolean;
  /**
   * The target only: the client released it (its cell is out of the 3×3 landblocks the server keeps you updated
   * on: CPhysicsObj::leave_visibility): not drawn, frozen where it was last seen, deleted 25 s later. Not there to act on.
   */
  outOfSight?: boolean;
}

export interface AgentVital { cur: number; max: number }

export interface AgentSelf {
  guid: number;
  name: string;
  level: number;
  health: AgentVital;
  stamina: AgentVital;
  mana: AgentVital;
  /** Map coordinates "42.1N, 33.6E", or null indoors / in a dungeon. */
  coords: string | null;
  /** Current cell id as hex ("0xA9B40019"). */
  cell: string;
  indoors: boolean;
  /** Global position (metres): x east, y north, z up. */
  pos: { x: number; y: number; z: number };
  /** Facing as a compass bearing, degrees (0 = north, 90 = east). */
  heading: number;
  combatMode: 'peace' | 'melee' | 'missile' | 'magic' | 'unknown';
  /** The mode the server last put you in (combatMode is the client's, which changes on the request); unset until the server says. */
  serverMode?: 'peace' | 'melee' | 'missile' | 'magic' | 'unknown';
  /** What the agent's own motor task is doing ("walking to …"), if anything. */
  task: string | null;
  dead: boolean;
  burden?: string;
  pyreals?: number;
  xp?: { total: number; unassigned: number };
}

/**
 * What a stream overlay (tools/stream/) shows about a character, read without touching anything a player's own
 * look consumes (observe's chat since last look): vitals, level, XP, where, what Claude is doing and its goal line.
 */
export interface AgentVitals {
  name: string;
  level: number;
  health: AgentVital;
  stamina: AgentVital;
  mana: AgentVital;
  /**
   * toNext: what the character panel's "XP for next level" shows; levelStart: the total XP the current level began at
   * (the portal XpTable's level list), for a progress bar. Null when the client doesn't know it yet.
   */
  xp: { total: number; unassigned: number; toNext: number | null; levelStart: number | null } | null;
  /** Map coordinates "42.1N, 33.6E", or null indoors / in a dungeon (then `cell` says where). */
  coords: string | null;
  cell: string;
  indoors: boolean;
  dead: boolean;
  combatMode: AgentSelf['combatMode'];
  /** The agent's own motor task ("walking to …"), if any. */
  task: string | null;
  /** Claude's goal line (ac_goal), if set. */
  goal: string | null;
}

export type AgentChatKind = 'tell' | 'say' | 'emote' | 'channel' | 'system' | 'combat' | 'magic' | 'other';

export interface AgentChatLine {
  seq: number;
  /** ms since page load. */
  t: number;
  kind: AgentChatKind;
  text: string;
}

export interface AgentEvent {
  seq: number;
  t: number;
  type:
    | 'chat' | 'object-added' | 'object-removed' | 'death' | 'target-died' | 'target-lost' | 'task-done'
    | 'vitals-low' | 'level-up' | 'portal' | 'screen' | 'dialog' | 'attacked'
    /** The server failed a use (UseDone with a WeenieError): its name, for codes retail shows no text for. */
    | 'use-failed'
    /** More creatures attacking you than a moment ago (the attack lines of the last 10 s, each placed on its creature). */
    | 'attackers-up'
    /** A spell came at you (landed, resisted, failed to affect you), or a creature nearby spoke a spell's words. */
    | 'cast-at-you'
    /** A monster started coming at you (its MoveTo / TurnTo aimed at you, or closing on you), before it lands a hit. */
    | 'aggro'
    /** A monster started coming at (or fighting) one of your fellows. */
    | 'fellow-aggro'
    /** A fellow's health fell below the mark (60% by default, fellow_below per wait), or a single drop took a quarter of it. */
    | 'fellow-low';
  text: string;
  guid?: number;
  /** Chat lines: the ChatMessageType the line came in as (Chat Message Capture's colour filter). */
  chatType?: number;
}

export type AgentScreen = 'world' | 'portal-space' | 'character-select' | 'character-create' | 'loading' | 'unknown';

/** AGENT.hosted-mcp-connector step 2 — the tab's own state for ac_status. */
export interface AgentStatus {
  screen: AgentScreen;
  /** The character in the world, or null at character select / loading. */
  character: string | null;
  /** The account's characters as the select screen lists them. */
  characters: Array<{ name: string; pendingDeletion: boolean }>;
  /** Claude's goal line (ac_goal), or null. */
  goal: string | null;
  /** Who acts (agent/claudeControl.ts): Claude, the player who took over, or paused by the player. Absent locally. */
  control?: 'claude' | 'player' | 'paused';
}

export interface AgentObservation {
  screen: AgentScreen;
  me: AgentSelf | null;
  target: AgentObject | null;
  nearby: AgentObject[];
  /** Total objects in range before the `max` cut. */
  nearbyTotal: number;
  /** NPCs, vendors, portals and lifestones seen earlier and now out of view, nearest first (last-known positions). */
  remembered: AgentObject[];
  /** Open dialogs (popups, confirmations), oldest first; answer with ac_dialog. */
  dialogs: AgentDialog[];
  /** Open windows (Inventory, Social (fellowship), Container …); close with ac_close. */
  windows?: string[];
  /** Your active enchantments (the effects UI), seconds left; -1 = permanent. Other players' are not visible to a client. */
  buffs?: Array<{ name: string; remaining: number; beneficial?: boolean }>;
  /** Buffs you know that aren't up on you (self-only ones first), to cast with ac_cast. */
  buffsMissing?: string[];
  /**
   * Your fellows (not you): health %, and distance and compass direction when in view, else out of sight.
   * Without it a player stood waiting for a partner 490 m away to buff him (Bulwark, 2026-10-10).
   */
  fellows?: Array<{
    name: string; healthPct: number; dist?: number; bearing?: number; /** Metres up (+) or down (−) when 2 m or more. */ dz?: number;
    /** Monsters on them or coming at them, as the client sees it: "Rust Gromnie L8 on them, Shadow L26 running at them 20 m off". */
    threats?: string;
  }>;
  /**
   * In a fellowship with nobody else in it: a fellow logged out (the server takes them out, as retail did) and /f
   * reaches no one. Arcanist and Bulwark each sat in a separate fellowship waiting on the other's /f, 2026-10-10.
   */
  fellowshipAlone?: boolean;
  /**
   * Body slots nothing you wear covers (the paperdoll's bare spots: head, hands, feet …), and the pack items that would
   * cover one. A player sees them at a glance; Arcanist played to level 19 with no gloves (2026-10-14).
   */
  gearEmpty?: { slots: string[]; packFits: string[] };
  /**
   * Attack lines of the last 10 s naming a creature none of whose name stands within reach (a swing from 8 m, a spell
   * from 60 m): out of sight, or a missile from afar. Named, never pinned on a far one of that name.
   */
  attackersUnplaced?: Array<{ name: string; count: number }>;
  /** Chat / system lines since the previous observe (or the last N on the first call). */
  chat: AgentChatLine[];
  /** Highest event seq seen; pass it to waitFor/events to get only newer ones. */
  seq: number;
}

export interface AgentDialog {
  text: string;
  buttons: string[];
}

export interface AgentVendor {
  name: string;
  guid: number;
  /**
   * What the vendor sells, with the merchandise row's per-unit price. `service`: a buff the vendor casts on you when
   * you buy it (ItemType TYPE_SERVICE 0x100000, ACE PropertyBool.VendorService: Vendor.ApplyService), not an item.
   */
  items: Array<{ guid: number; name: string; price: number; stack?: number; service?: boolean }>;
  /** "Pyreals", or the alternate currency the vendor trades in. */
  currency: string;
}

export interface AgentTrade {
  partner: string;
  yours: string[];
  theirs: string[];
  youAccepted: boolean;
  theyAccepted: boolean;
}

export interface AgentTracePoint {
  /** seconds ago */
  ago: number;
  cell: string;
  x: number;
  y: number;
  z: number;
  heading: number;
  mode: string;
  task: string | null;
  /** Camera boom length range over the half second (min, max), metres; a wide range while standing still = camera jitter. */
  camera?: [number, number];
}

export interface AgentItem {
  guid: number;
  name: string;
  /** Where it is: 'pack' (main pack), a side-pack name, or 'equipped'. */
  where: string;
  /** In a side pack: that pack's guid (two packs can share a name). */
  inside?: number;
  stack?: number;
  value?: number;
  burden?: number;
  /** Equipped slot names when worn/wielded. */
  slot?: string;
  type?: string;
  /** UiEffects (PropertyInt 18) from its public description, e.g. a summoning essence's element glow. */
  uiEffects?: number;
  /** ACE ItemType bits from its public description (MeleeWeapon 0x1, MissileWeapon 0x100, Caster 0x8000…). */
  itemType?: number;
  /** AmmoType (arrow 1, quarrel 2, atlatl dart 4) from its public description: launchers and ammunition. */
  ammoType?: number;
  /** Not worn: the slots it could be worn or wielded in (its ValidLocations as EquipMask names). */
  fits?: string;
  /** Its weenie class id. */
  wcid?: number;
  /** From its public description (salvaging): MaterialType, units in a salvage bag (Structure), workmanship (a bag's average) and the ObjectDescriptionFlags (Retained 0x01000000). */
  materialType?: number;
  structure?: number;
  workmanship?: number;
  objectDescFlags?: number;
  /** Worn: the EquipMask slots it occupies (its CurrentWieldedLocation; a coat holds several). */
  mask?: number;
  /** The EquipMask slots it can be worn or wielded in (ValidLocations, PropertyInt 9), as a number. */
  validLocations?: number;
  /** The body it covers (ClothingPriority, PropertyInt 4: ACE CoverageMask), when the public description sent one. */
  coverage?: number;
  /** An appraisal of it has arrived (its armor level and wield requirements are then known). */
  appraised?: boolean;
  /** ArmorLevel (PropertyInt 28) from its appraisal: what the examine window shows, enchantments included. */
  armorLevel?: number;
  /** Its wield requirements from its appraisal, in the examine window's words; `met` when your character sheet says. */
  wieldReqs?: Array<{ text: string; met?: boolean }>;
}

export interface AgentSpell {
  id: number;
  name: string;
  school: string;
  level?: number;
  /** A self-only spell (the spell table's SelfTargeted flag): cast goes on you with no target. */
  self?: boolean;
  /** A buff: beneficial (SpellFlags.Beneficial 0x4) with a duration (an enchantment, not an instant heal). */
  buff?: boolean;
  /** The spell table's family (category), difficulty (power) and duration in seconds (the macro's planners). */
  category?: number;
  power?: number;
  duration?: number;
  /** It flies to its target as a missile (the spell table's MetaSpellType Projectile / LifeProjectile / EnchantmentProjectile): walls stop it. */
  projectile?: boolean;
  /** How far it reaches for you, metres (the spell examine's Range: its range grows with your ranks in the school's skill). */
  range?: number;
}

/** Result of every action: ok + a human line the LLM can read. */
export interface AgentResult {
  ok: boolean;
  message: string;
  [k: string]: unknown;
}

export interface AgentWaitFilter {
  /** Event types to wake on (default: any). */
  types?: AgentEvent['type'][];
  /** Wake on chat lines matching this regex (case-insensitive). */
  chatMatch?: string;
  /** Only events newer than this seq (default: now). */
  sinceSeq?: number;
  /** Wake (as vitals-low) when health falls below this fraction of its max (default mark without it: 0.5). */
  healthBelow?: number;
  /** Likewise for mana and stamina (no default mark for them). */
  manaBelow?: number;
  staminaBelow?: number;
  /** Wake (as fellow-low) when a fellow's health falls below this fraction (default mark without it: 0.6). */
  fellowBelow?: number;
}
