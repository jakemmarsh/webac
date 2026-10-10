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
  /** Doors only: true when it stands open (Using an open door closes it). */
  open?: boolean;
  /** Set on a remembered place that is out of view: seconds since it was last seen. */
  seenAgo?: number;
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
  /** What the agent's own motor task is doing ("walking to …"), if anything. */
  task: string | null;
  dead: boolean;
  burden?: string;
  pyreals?: number;
  xp?: { total: number; unassigned: number };
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
    | 'vitals-low' | 'level-up' | 'portal' | 'screen' | 'dialog' | 'attacked';
  text: string;
  guid?: number;
}

export type AgentScreen = 'world' | 'portal-space' | 'character-select' | 'character-create' | 'loading' | 'unknown';

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
  /** What the vendor sells, with the merchandise row's per-unit price. */
  items: Array<{ guid: number; name: string; price: number; stack?: number }>;
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
  stack?: number;
  value?: number;
  burden?: number;
  /** Equipped slot names when worn/wielded. */
  slot?: string;
  type?: string;
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
}
