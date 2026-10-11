/**
 * AgentApi — the in-page API an LLM player (tools/ac-agent) and, later, the
 * first-party automation layer drive the client through
 * (docs/agent-play.md). Installed as `window.__acAgent` when the URL has
 * `?agent` (or debug tools are on); off otherwise.
 *
 * Everything it does goes through an AgentHost that main.ts builds from the
 * client's own functions — the same selection, use, attack, cast, chat and
 * inventory paths the UI calls — so the server sees exactly what a human's
 * client sends. This module owns only perception (observations, an event
 * ring) and the motor tasks an LLM is too slow to steer itself (walking to a
 * point, a swing loop, looting a corpse), stepped by `tick()` at ~10 Hz.
 *
 * Frames: positions are AC global metres (x east, y north, z up):
 * landblock (cell >>> 24, (cell >>> 16) & 0xff) × 192 + the landblock-local
 * origin. Headings are compass degrees (0 = north, 90 = east). The client's
 * playerYaw moves the body along (−sin yaw, −cos yaw) in (x, y), so compass
 * = yaw + 180° (tools/lib/cell-path.ts yawToward).
 */
import { avoidDisks, type AvoidDisk } from './portalAvoid.js';
import { PathSearch, floorPlan, straightWalk, type JumpSearch, type NavStep } from './navPlanner.js';
import { compassPoint } from './format.ts';
import { fallBudget, isDrop, reaimJump, safeDropHeight, type JumpKit, type JumpSpec } from './jumpPlan.js';
import { CELL_LENGTH, mapCoordinateText, mapCoordsOfCell } from '../ui/MapMarkers.js';
import type { RoutineProfile } from '@ac/shared';
import { RoutineEngine, type ItemPalette } from './RoutineEngine.ts';
import type { RoutineSyncResult } from './RoutineSync.ts';
import { vtankExprHost, vtankExpressions } from './VtankExprHost.ts';
import { CAST_NOT_LANDED } from './macro/castReply.ts';
import type {
  AgentChatKind, AgentChatLine, AgentDialog, AgentEvent, AgentTrade, AgentTracePoint, AgentVendor, AgentItem, AgentObject, AgentObjectKind, AgentObservation,
  AgentResult, AgentScreen, AgentSelf, AgentStatus, AgentSpell, AgentWaitFilter,
} from './types.ts';

// ── Host: what main.ts provides ─────────────────────────────────────────

/** Your fellowship as Auto Fellow Mgmt reads it (AgentHost.fellowshipInfo). */
export interface FellowshipInfo { leader: boolean; open: boolean; count: number; members?: string[]; handOff?: boolean; /** The fellows whose Share Loot is on (VTank's LootFellowCorpses). */ sharing?: string[] }

export interface AgentHostObject {
  guid: number;
  name: string;
  itemType: number;
  objectDescFlags: number;
  /** Landblock-local position; null when the object has none (carried, contained). */
  cell: number | null;
  x: number;
  y: number;
  z: number;
  level?: number;
  stack?: number;
  /** Set when wielded by / contained in something (not on the ground). */
  wielderId?: number;
  containerId?: number;
  /** Its ObjDesc subpalettes in order, offset and length in palette entries (what VTClassic's colour rules read). */
  palettes?: Array<{ id: number; offset: number; length: number }>;
  /** PhysicsState bits (ACE PhysicsState): an open door is Ethereal (0x4, ACE Door.Open). */
  physicsState?: number;
  /** UiEffects (PropertyInt 18) from its public description: Magical 0x1 glows (VTank's mana-donor look). */
  uiEffects?: number;
}

export interface AgentHostSelf {
  guid: number;
  name: string;
  level: number;
  health: { current: number; max: number };
  stamina: { current: number; max: number };
  mana: { current: number; max: number };
  /** The cell + landblock-local origin the server has us at. */
  cell: number;
  x: number;
  y: number;
  z: number;
  /** cameraController.playerYaw (radians). */
  yaw: number;
  combatMode: AgentSelf['combatMode'];
  /** The mode the server last put us in (its movement's stance, or its CombatMode property); unset until it says. */
  serverMode?: AgentSelf['combatMode'];
  dead: boolean;
  pyreals?: number;
  burden?: string;
  xpTotal?: number;
  xpUnassigned?: number;
}

export type CombatModeName = 'peace' | 'melee' | 'missile' | 'magic';
export type AttackHeightName = 'high' | 'medium' | 'low';

export interface AgentHost {
  screen(): AgentScreen;
  self(): AgentHostSelf | null;
  /**
   * Where the server last said you are: its own UpdatePosition echo of you (ACE Player_Tick sends one for each
   * position it accepts), landblock-local, with when it came (now() ms). Null until one has come; absent: unknown.
   * VirindiTank's checkpoints wait on it (the client runs a little ahead of the server).
   */
  serverSelfPosition?(): { cell: number; x: number; y: number; z: number; at: number } | null;
  objects(): Iterable<AgentHostObject>;
  object(guid: number): AgentHostObject | null;
  isAttackable(guid: number): boolean;
  /**
   * The straight line a bolt or arrow would fly from you to `guid`: `blockedAt` is the distance (m) of the first
   * wall, ground or solid object on it (creatures left out), null when it reaches the target. Absent / null: unknown.
   */
  lineOfFire?(guid: number): { dist: number; blockedAt: number | null } | null;
  /**
   * Dungeon sight: whether interior cell `to` is `from` itself or in its VisibleCells (the EnvCell's PVS, which
   * ACE's ObjectMaint uses to decide what it sends); null when unknown or not both interior cells of one landblock.
   */
  cellSees?(from: number, to: number): boolean | null;
  /** The creature's death has started (its object lingers through the death animation). */
  isDying(guid: number): boolean;
  targetGuid(): number | null;
  /** Health fraction of the selected target, when the server has answered the query. */
  targetHealth(): number | undefined;
  /** Every carried guid (pack, side packs, equipped). */
  carriedGuids(): Set<number>;
  inventory(): AgentItem[];
  spells(): AgentSpell[];
  characterSheet(): string;
  /**
   * Walk the player's body from `from` toward `to` with the client's own movement collision (agent
   * global metres; z = feet) and return where it stops; null when there is no floor. Never moves the player.
   */
  navProbe?(from: { x: number; y: number; z: number }, to: { x: number; y: number }): { x: number; y: number; z: number } | null;
  /** The walkable floor at a global (x, y) at or below feet height `fromZ` (+5 cm), from the client's collision; null = none. */
  navFloor?(x: number, y: number, fromZ: number): number | null;
  /** One airborne transition of the player's body (feet at from.z) moved (dx, dy) through the collision world; where it ends. Never moves the player. */
  navAirStep?(from: { x: number; y: number; z: number }, dx: number, dy: number): { x: number; y: number };
  /**
   * A standing long jump charged to `power` (0..1) with the player's own Jump skill and load: its
   * forward speed (run, or walk with Shift) and upward speed, m/s, and the seconds a full charge takes.
   */
  jumpLaunch?(power: number, walk: boolean): { forward: number; up: number; chargeSeconds: number };
  /**
   * How far a fixture's own collision reaches from its origin, metres (its widest blocking radius);
   * 0 for a creature, or for something that doesn't block. A walk to it stops that much farther out.
   */
  objectReach?(guid: number): number;
  /** Open windows by name (Inventory, Social (fellowship), Container, …). */
  openWindows?(): string[];
  /** Close one window by name, or 'all' (Escape's closeAllPanels and the container); null once closed, else why not. */
  closeWindow?(name: string): string | null;
  /** The fellowship pane as text. */
  fellowship?(): string;
  /** Your fellowship: leader or not, open or not, its size, its fellows' names (you included), and whether this era's client can hand leadership over (null: none). */
  fellowshipInfo?(): FellowshipInfo | null;
  /** Your fellows (not you) with their vitals (the macro's Helper). */
  fellows?(): Array<{ guid: number; name: string; health: { cur: number; max: number }; stamina: { cur: number; max: number }; mana: { cur: number; max: number } }>;
  /** Ask the server for what the pane would show (fellowship full update / AllegianceUpdate). */
  refreshSocial?(what: 'fellowship' | 'allegiance'): void;
  /** A fellowship-pane action (create name / recruit the selection / quit / leader name / dismiss name / open / close / disband); null once sent, else why not. */
  fellowshipAction?(action: string, arg?: string): string | null;
  /** The allegiance pane as text (patron, vassals, monarch). */
  allegiance?(): string;
  /** The pane's Swear for the selected player; null once sent, else why the button is disabled. */
  swearAllegiance?(): string | null;
  /** Break from your patron (no name) or kick a vassal by name; null once sent, else why not. */
  breakAllegiance?(name?: string): string | null;
  /** The subpalettes of an item in your own pack (it isn't a world object), offset and length in entries. */
  carriedPalettes?(guid: number): Array<{ id: number; offset: number; length: number }> | null;
  /** A palette's colour at `index` as 0xRRGGBB, or null while the palette isn't loaded (asking starts the load). */
  paletteColor?(paletteId: number, index: number): number | null;
  /** A skill's base and buffed values by AC skill id, or null when the character doesn't have it. */
  skill?(id: number): { base: number; buffed: number } | null;
  /** The main pack (slot 0) and side packs (1+): capacity and how many items each holds (Autocram). */
  packs?(): Array<{ slot: number; guid: number; capacity: number; count: number }>;
  /** What you carry with its pack slot, stack and weenie class (Autostack / Autocram). */
  itemSlots?(): Array<{ guid: number; name: string; packSlot: number; stack: number; maxStack: number; wcid: number; isPack: boolean; equipped: boolean }>;
  /** Move an item into a side pack, or merge it onto a stack, as a drag onto the inventory does. */
  placeItem?(guid: number, to: { packSlot: number } | { onto: number }): boolean;
  /** Split `amount` off a stack into the main pack (a shift-drag's StackableSplitToContainer). */
  splitStack?(guid: number, amount: number): boolean;
  /** Every skill with its training (the macro's planners). */
  skillList?(): Array<{ id: number; name: string; training: 'untrained' | 'trained' | 'specialized'; base: number; buffed: number }>;
  /** A spell's components by name, as the server will charge them: the formula the client's own cast pre-check walks (personalized, or scarabs and tapers with foci; SpellComponentCheck.appropriateSpellFormula), through the component table. */
  spellComponents?(spellId: number): string[];
  /**
   * Put items into the Ust (`toolGuid`) and salvage them, as the salvage panel's Salvage button does
   * (CreateTinkeringTool, gmSalvageUI::Salvage); bags of one material put in together combine. True once sent.
   * Absent when the era has no salvaging (EraFeatures 'salvage': the 1999 server has no handler).
   */
  salvage?(toolGuid: number, itemGuids: number[]): boolean;
  /** The era's recipe table (VTank AutoCraftItems; tools/build-craft-tables.ts), loaded on first ask. */
  craftTable?(): Promise<Array<[string, string, string, number, number, number, number]> | null>;
  /** The era's monster table ([name, weak elements, max health, species, immunities]; tools/build-monster-tables.ts), loaded on first ask. */
  monsterTable?(): Promise<Array<[string, string, number, number?, string?]> | null>;
  /** The era's drains and martyrs ([spellId, kind, factor, cap, multiplier]; tools/build-drain-tables.ts), loaded on first ask. */
  drainTable?(): Promise<Array<[number, 'd' | 'm' | 'r', number, number, number]> | null>;
  /** One of your character's int properties as the server last sent it (PlayerDescription / UpdateInt), e.g. SummoningMastery 362. */
  charInt?(id: number): number | undefined;
  /**
   * Is there room ahead of you for something to appear (a summoned pet, VTank's 3 m check)? The same walls,
   * terrain and solid objects a missile collides with, swept `metres` along the compass `heading`. null: can't tell.
   */
  roomAhead?(heading: number, metres: number): boolean | null;
  /** The era's special ammunition: [name, UseSpecialAmmo mask] (tools/build-ammo-tables.ts). */
  specialAmmoTable?(): Promise<Array<[string, number]> | null>;
  /** The era's spell table (the macro's planners build spell families from it). */
  spellTableData?(): { spells: Map<number, { name: string; desc: string; category: number; school: number; bitfield: number; power: number; duration?: number; baseMana?: number }> } | null;
  /** The items in the currently open container (corpse/chest), or null when none is open. */
  openContainer(): { guid: number; items: Array<{ guid: number; name: string; uiEffects?: number }> } | null;
  /** Open dialogs, oldest first. */
  dialogs(): AgentDialog[];
  /** The open book or note (gmBookUI): its object, title and pages; a page's text is null until the server has sent it. */
  book?(): { guid: number; title: string; pages: Array<{ author: string; text: string | null }> } | null;
  /** Ask for one page of the open book, as turning to it does (BookGetPageData); false when it is not open or already here. */
  bookPage?(index: number): boolean;
  /** Active enchantments by spell name with seconds left (what the effects UI shows). */
  activeSpells(): Array<{ spellId?: number; name: string; remaining: number; beneficial?: boolean }>;
  /** Seconds left on a shared item cooldown (an item's SharedCooldown id; the cooldown enchantment 0x8000 + id), 0 when none. */
  cooldownRemaining?(cooldownId: number): number;
  /** Free slots in the main pack. */
  freePackSlots(): number;
  /** Burden as a percent of capacity. */
  burdenPercent(): number;
  /** The camera boom's shortest / longest length since the last call (null in first person); for the trace. */
  cameraBoom(): { min: number; max: number } | null;
  /** Press the button labelled `label` (newest dialog first, or dialog `index`). */
  answerDialog(label: string, index?: number): boolean;
  /** True while an attack, cast or inventory request is in flight (the client refuses overlapping ones). */
  busy(): boolean;

  select(guid: number): boolean;
  use(guid: number): boolean;
  useWithTarget(source: number, target: number): boolean;
  setCombatMode(mode: CombatModeName): void;
  /**
   * One attack request on `guid`, as the attack button sends it (auto-enters
   * the equipment's combat mode first). With Repeat Attacks on, the server
   * keeps swinging until the target dies or the chain ends.
   */
  attack(guid: number, power: number, height: AttackHeightName): void;
  /** The combat bar's attack height, and setting it as its High / Medium / Low buttons do. */
  attackHeight?(): AttackHeightName;
  /** The combat bar's power / accuracy level (0..1), as the player set it. */
  attackPower?(): number;
  /** Set the combat bar's power / accuracy level (0..1), as its slider does. */
  setAttackPower?(p: number): void;
  setAttackHeight?(h: AttackHeightName): void;
  /** An attack request is in flight or the server's swing chain is running (no new request should go out). */
  attackPending(): boolean;
  cancelAttack(): void;
  cast(spellId: number, target: number | null): boolean;
  chat(text: string): void;
  key(code: string, down: boolean): void;
  setYaw(yaw: number): void;
  pickUp(guid: number): boolean;
  drop(guid: number): boolean;
  give(target: number, item: number, amount: number): boolean;
  wield(guid: number): boolean;
  /** `quiet`: the automation's own look (no Examine window), as VirindiTank's background IDs. */
  appraise(guid: number, quiet?: boolean): void;
  /** Appraisal text once the server has answered, else null. */
  appraisal(guid: number): string | null;
  /** The appraisal's property maps and spell names (loot rules on item properties), when one arrived. */
  appraisalData?(guid: number): { int: Record<number, number>; float: Record<number, number>; string: Record<number, string>; bool: Record<number, boolean>; did: Record<number, number>; spells: string[] } | null;
  /**
   * Doorway waypoints (landblock-local) between two cells of one landblock,
   * either of which may be outdoors (index < 0x100: through a building's
   * outside doorway), ending at `to`; null when there is no route
   * (cellPath.ts findRouteViaOutside over the cell DAT's EnvCell portals).
   */
  route(fromCell: number, from: { x: number; y: number; z: number }, toCell: number, to: { x: number; y: number; z: number }, opts?: { maxDrop?: number; closed?: Array<{ x: number; y: number; z: number }>; avoid?: Array<{ x: number; y: number; z: number }> }): Array<{ x: number; y: number; z: number; feet?: number; drop?: number; landing?: number }> | null;
  /** Press a key binding: an action name from the keymap ("Show/Hide Inventory") or a key code ("F9", "Ctrl+KeyI"). */
  press(input: string): AgentResult;
  /** Keymap actions matching `filter`, with their bound keys. */
  keyBindings(filter: string): Array<{ name: string; keys: string[] }>;
  /** The open vendor window, or null. */
  vendor(): AgentVendor | null;
  /** The vendor window's Buy / Sell (one item, `amount` units). */
  vendorBuy(guid: number, amount: number): boolean;
  vendorSell(guid: number, amount: number): boolean;
  /** The open secure-trade window, or null. */
  trade(): AgentTrade | null;
  tradeAction(action: 'add' | 'accept' | 'decline' | 'reset' | 'close', guid?: number): boolean;
  /** Spend XP on one raise of a named attribute / vital / skill; returns a message. */
  /** One raise of an attribute, vital or skill; refused (reached) when it is already at `upTo`. */
  raise(stat: string, upTo?: number): AgentResult & { name?: string; from?: number; to?: number; cost?: number; reached?: boolean };
  /** Train an untrained skill with skill credits (the skills panel's train button). */
  trainSkill(skill: string): AgentResult & { name?: string; cost?: number };
  logout(): void;
  /** The account's routines on the bridge (RoutineSync; AGENT.routine-store-auth). */
  accountRoutines?: { load(): Promise<RoutineSyncResult>; save(doc: unknown): Promise<RoutineSyncResult> };
  /** The account's characters on the select screen (AGENT.hosted-mcp-connector ac_status / ac_enter_world). */
  characterList?(): Array<{ name: string; pendingDeletion: boolean }>;
  /** Enter the world as this character the select screen's own way (select its row, then Enter): null when started, else why not. */
  enterCharacter?(name: string): string | null;
  /** Show Claude's goal line to the player (null clears it). */
  showGoal?(text: string | null): void;
  /** The 3D view as a JPEG (base64), for the hosted connector's ac_look / ac_screenshot. */
  screenshot?(): Promise<string | null>;
  /** This character's journal kept in the player's browser (the hosted connector's ac_journal / ac_note). */
  journalLoad?(): unknown;
  journalSave?(journal: unknown): boolean;
  now(): number;
  /** Wall-clock ms (Date.now()), for what outlives the page; absent = Date.now(). */
  wallClock?(): number;
}

// ── Pure helpers (exported for tests) ───────────────────────────────────

export const LANDBLOCK_SIZE = 192;
const DEG = 180 / Math.PI;

/** Landblock-local → AC global metres. */
export function toGlobal(cell: number, x: number, y: number): { x: number; y: number } {
  return { x: ((cell >>> 24) & 0xff) * LANDBLOCK_SIZE + x, y: ((cell >>> 16) & 0xff) * LANDBLOCK_SIZE + y };
}

export const normDeg = (d: number): number => ((d % 360) + 360) % 360;

/** Relative angle in (−180, 180]. */
export function relDeg(d: number): number {
  const r = normDeg(d);
  return r > 180 ? r - 360 : r;
}

/** Compass bearing (0 = N, 90 = E) from a to b in the global frame. */
export function bearing(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return normDeg(Math.atan2(b.x - a.x, b.y - a.y) * DEG);
}

export const yawToCompass = (yaw: number): number => normDeg(yaw * DEG + 180);
export const compassToYaw = (deg: number): number => (normDeg(deg) - 180) / DEG;

/**
 * "42.1N, 33.6E" (also "42.1n 33.6e", "42.1 N, 33.6 W") → global metres: the
 * centre of the 24 m cell the radar prints that text for ((c − 1024) × 0.1 +
 * 0.5 inverted; the same −101.95 origin as ACE Position.GetMapCoords).
 */
export const MAP_COORD_ORIGIN = 101.95;
export function parseMapCoords(text: string): { x: number; y: number } | null {
  const m = /(\d+(?:\.\d+)?)\s*([NS])\s*[, ]\s*(\d+(?:\.\d+)?)\s*([EW])/i.exec(text);
  if (!m) return null;
  const ns = Number(m[1]) * (/s/i.test(m[2]) ? -1 : 1);
  const ew = Number(m[3]) * (/w/i.test(m[4]) ? -1 : 1);
  return { x: (ew + MAP_COORD_ORIGIN) * 240, y: (ns + MAP_COORD_ORIGIN) * 240 };
}

/**
 * A walk_to offset as a player says it: a distance in metres and a direction, either a compass one ("10m north",
 * "25 m NE", "5 m south-west") or one relative to your facing ("5m ahead", "3 m left", "4m back"). `bearing` is the
 * compass bearing (0 = N, 90 = E); `turn` the angle from your facing (+ = right). Null when it isn't one.
 */
export function parseOffset(text: string): { dist: number; bearing?: number; turn?: number } | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*m(?:et(?:er|re)s?)?\s+(?:to\s+the\s+)?([a-z-]+)\s*$/i.exec(text);
  if (!m) return null;
  const dist = Number(m[1]);
  if (!(dist > 0) || dist > 2000) return null;
  const word = m[2].toLowerCase().replace(/-/g, '');
  const compass: Record<string, number> = {
    n: 0, north: 0, ne: 45, northeast: 45, e: 90, east: 90, se: 135, southeast: 135,
    s: 180, south: 180, sw: 225, southwest: 225, w: 270, west: 270, nw: 315, northwest: 315,
  };
  const relative: Record<string, number> = { ahead: 0, forward: 0, forwards: 0, right: 90, back: 180, backward: 180, backwards: 180, behind: 180, left: -90 };
  if (word in compass) return { dist, bearing: compass[word] };
  if (word in relative) return { dist, turn: relative[word] };
  return null;
}

/**
 * Whether an object in `cell` is inside the server's update range of a player in `myCell`: the player's
 * landblock and the eight round it. ACE (Landblock adjacents / ObjectMaint), GDLE and the 1999 server send
 * creatures' positions only that far; past it the client keeps the last one it got.
 */
export function inUpdateRange(myCell: number, cell: number): boolean {
  // (A creature first reaches the client only within 112.5 m: ObjectMaint.InitialClamp_Dist.)
  const dx = Math.abs(((myCell >>> 24) & 0xff) - ((cell >>> 24) & 0xff));
  const dy = Math.abs(((myCell >>> 16) & 0xff) - ((cell >>> 16) & 0xff));
  return dx <= 1 && dy <= 1;
}

/** ObjectDescriptionFlag bits (packages/shared ace-enums.ts). */
const ODF = { Player: 0x8, Attackable: 0x10, Vendor: 0x200, Door: 0x1000, Corpse: 0x2000, LifeStone: 0x4000, Portal: 0x40000 } as const;
/** ItemType bits (packages/shared game-types.ts). */
/** PhysicsState.Ethereal: ACE Door.Open sets it, Door.Close clears it. */
const PHYSICS_ETHEREAL = 0x4;
/** UtilityBelt's motion names → the retail default keys (KeybindDefaults; Walk is the run/walk hold). */
const MOTION_KEYS: Record<string, string> = {
  forward: 'KeyW', backward: 'KeyS', turnright: 'KeyD', turnleft: 'KeyA', straferight: 'KeyC', strafeleft: 'KeyZ', walk: 'ShiftLeft',
};
const IT = { Creature: 0x10, Container: 0x200 } as const;

export function classify(o: Pick<AgentHostObject, 'itemType' | 'objectDescFlags' | 'guid'>, attackable: boolean): AgentObjectKind {
  const f = o.objectDescFlags >>> 0;
  if (f & ODF.Player) return 'player';
  if (f & ODF.Corpse) return 'corpse';
  if (f & ODF.Portal) return 'portal';
  if (f & ODF.LifeStone) return 'lifestone';
  if (f & ODF.Door) return 'door';
  if (f & ODF.Vendor) return 'vendor';
  if (o.itemType & IT.Creature) return attackable ? 'monster' : 'npc';
  if (o.itemType & IT.Container) return 'container';
  return o.itemType ? 'item' : 'other';
}

/**
 * How far an object reaches from its origin for walk_to (AgentHost.objectReach). A fixture: its part-array
 * radius (Setup radius × scale, CPartArray::GetRadius @ 005180a0), the edge a Use is measured to; not the
 * creature blocking radius, which is 0 for every fixture (with that, a walk to the Holtburg lifestone never
 * arrived, 2026-10-09). A creature: its body, the blocking radius you stop against (its Setup's cylspheres,
 * else spheres, × scale: creatureBlockRadius). A shrine statue can be a creature: the Dark Majesty "Tusker
 * Shrine Statue" (ClassicACE CustomDM weenie 50178, ItemType Creature, Setup 0x02000E6C with one 2 m sphere,
 * scale 1.2) blocked a walk 2.7 m short while its reach read 0 (AGENT.walk-shrine-statue-reach, 2026-10-10).
 */
export function fixtureReach(o: { itemType?: number; collisionRadius?: number; blockRadius?: number }): number {
  if ((o.itemType ?? 0) & IT.Creature) return o.blockRadius && o.blockRadius > 0 ? o.blockRadius : 0;
  return o.collisionRadius && o.collisionRadius > 0 ? o.collisionRadius : 0;
}

const nameTokens = (s: string): string[] => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
const sameToken = (a: string, b: string): boolean => a === b || a === `${b}s` || b === `${a}s` || a === `${b}es` || b === `${a}es`;

/**
 * How well a name a player typed matches an object's name: 5 the same, 4 the
 * name contains it, 3 it contains the whole name ("Pine Lugian Hammer" for
 * an inventory "Lugian Hammer": the server's give line names an item with
 * its material, ACE GetNameWithMaterial), 2 every word of either is in the
 * other in any order or as a plural ("hammer lugian", "Lugian Hammers"),
 * 0 no match. One-word names only match the first three ways.
 */
export function nameMatchScore(query: string, name: string): number {
  const q = query.trim().toLowerCase(), n = name.trim().toLowerCase();
  if (!q || !n) return 0;
  if (q === n) return 5;
  if (n.includes(q)) return 4;
  const qt = nameTokens(q), nt = nameTokens(n);
  if (!qt.length || !nt.length) return 0;
  const within = (a: string[], b: string[]): boolean => a.every((t) => b.some((u) => sameToken(t, u)));
  if (nt.length >= 2 && q.includes(n)) return 3;
  if (qt.length === nt.length && within(qt, nt)) return 2;
  if (nt.length >= 2 && within(nt, qt)) return 2;
  if (qt.length >= 2 && within(qt, nt)) return 2;
  return 0;
}

/** The best match for `query` among `list` (highest score; ties keep list order); null when none matches. */
export function bestNameMatch<T>(query: string, list: readonly T[], name: (t: T) => string): { item: T; score: number } | null {
  let best: { item: T; score: number } | null = null;
  for (const item of list) {
    const score = nameMatchScore(query, name(item));
    if (score > (best?.score ?? 0)) best = { item, score };
  }
  return best;
}

/** Classify a chat line from its ChatMessageType (packages/shared enums/ChatMessageType.ts). */
export function chatKindOf(type: number | undefined, text: string): AgentChatKind {
  switch (type) {
    case 0x02: return 'say'; // Speech
    case 0x03: case 0x04: case 0x1f: return 'tell'; // Tell, OutgoingTell, AdminTell
    case 0x0a: case 0x0b: case 0x0c: return 'emote'; // Social, SocialSend, Emote
    case 0x06: case 0x15: case 0x16: return 'combat'; // Combat, CombatEnemy, CombatSelf
    case 0x07: case 0x11: case 0x17: return 'magic'; // Magic, Spellcasting, Recall
    case 0x08: case 0x09: case 0x12: case 0x13: case 0x14: return 'channel'; // Channel(Send), Allegiance, Fellowship, WorldBroadcast
    case 0x00: case 0x05: case 0x0d: case 0x0f: case 0x10: case 0x18: case 0x19: return 'system';
    default: return / says, "/.test(text) ? 'say' : / tells you, "/.test(text) ? 'tell' : 'other';
  }
}

const RING = 400;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Kinds worth remembering after they leave view (somewhere to go back to). */
const PLACE_KINDS = new Set<AgentObjectKind>(['npc', 'vendor', 'portal', 'lifestone']);

/**
 * A remembered place. `at` is wall-clock ms (Date.now()): the record outlives the page in browser storage,
 * and the page clock (host.now, performance.now) restarts at 0 on a reload, which made every place loaded
 * after one read "last seen 0s ago" (2026-10-10). Records saved before that carry only `t` (page ms): their
 * age is unknown.
 */
interface PlaceRecord { name: string; kind: AgentObjectKind; cell: number; x: number; y: number; z: number; t?: number; at?: number }

interface Task {
  label: string;
  /** Returns a result when done, null while running. */
  step(now: number): AgentResult | null;
  cancel(): void;
  resolve: (r: AgentResult) => void;
}

/** A loot filter's answer for one item: take it, leave it, or ask again (it is being examined). */
export type LootDecision = 'take' | 'skip' | 'wait';

/** VirindiTank's corpse timings for {@link AgentApi.loot} (CorpseOpenTimeoutSeconds, CorpseItemAppearanceTimeoutSeconds, CorpseLootItemMaxAttempts). */
export interface LootOptions {
  /** How long the open may take before it counts as failed (default 20 s). */
  openTimeoutMs?: number;
  /** An open corpse that lists nothing waits this long for its items to appear before it counts as empty (default 0). */
  appearMs?: number;
  /** How many times an item is picked before it is given up on (default 2). */
  itemTries?: number;
  /** Close the corpse when done (a second Use), as VTank does. */
  close?: boolean;
}

export interface ObserveOptions { radius?: number; max?: number; filter?: string }

type TargetArg = number | string | null | undefined;

/** Distance from p to the segment a→b (all in the same plane). */
export function segmentDistance(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** A doorway on the walk's cell route (global); `drop` / `landing` for a floor opening it falls through. */
type RouteStep = { x: number; y: number; z?: number; drop?: number; landing?: number };

/** Down through a floor opening: on the floor under it (its landing), within 3 m of it. Any other doorway: never by this test. */
function passedRoute(r: RouteStep, here: { x: number; y: number; z: number }): boolean {
  return r.drop !== undefined && r.landing !== undefined && Math.abs(here.z - r.landing) < 1.5 && Math.hypot(r.x - here.x, r.y - here.y) < 3;
}

/**
 * A closed door that may be what blocks the way indoors: in (or by) a doorway still ahead on the
 * route, or near the line from us to where we're heading and in front of us. Not one we stand in or
 * have passed, and not one off to the side: Banderling Ruin, 2026-10-10, opened the door it stood in
 * and then one in a side room 20 m off the way, and neither helped.
 */
export function doorOnTheWay(p: { x: number; y: number }, me: { x: number; y: number }, aim: { x: number; y: number }, route: ReadonlyArray<{ x: number; y: number }>): boolean {
  if (Math.hypot(p.x - me.x, p.y - me.y) < 1.2) return false;
  if (route.some((r) => Math.hypot(r.x - p.x, r.y - p.y) < 2.5)) return true;
  const dx = aim.x - me.x, dy = aim.y - me.y;
  const ahead = (p.x - me.x) * dx + (p.y - me.y) * dy > 0;
  return ahead && segmentDistance(p, me, aim) < 6;
}

/** A move this far in one tick is a teleport (a portal, a recall), not a walk: a run covers about 1.2 m a tick. */
const PORTAL_JUMP_M = 40;

export class AgentApi {
  readonly version = 1;
  private seqN = 0;
  private events: AgentEvent[] = [];
  private chatCursor = 0;
  /** The newest event the player has seen: its last observe, or the newest event a wait returned (wait()). */
  private lookSeq = 0;
  private task: Task | null = null;
  private waiters: Array<{ filter: AgentWaitFilter; since: number; resolve: (e: AgentEvent[]) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private lastHealthFrac = 1;
  private lastDead = false;
  private lastScreen: AgentScreen = 'unknown';
  private watchedTarget = 0;
  private attackTarget = 0;
  private known: Map<number, string> | null = null;
  /** Beyond this, attack runs up to the target itself before sending the attack. */
  static readonly ATTACK_RUN_UP_M = 12;
  private lastDialogCount = 0;
  private dyingSeen = new Set<number>();
  /** Watched targets that vanished without a seen death: guid → name and when (resolved within 3 s). */
  private pendingLoss = new Map<number, { name: string; at: number }>();
  /** Places (NPCs, vendors, portals, lifestones) by guid with their last-known landblock-local position. */
  private places = new Map<number, PlaceRecord>();
  private placesLoadedFor = '';
  private tracePoints: Array<Omit<AgentTracePoint, 'ago'> & { t: number }> = [];
  private lastTraceAt = -Infinity;

  readonly routine: RoutineEngine;

  constructor(private readonly host: AgentHost) {
    this.routine = new RoutineEngine(this, {
      activeSpells: () => host.activeSpells(),
      freePackSlots: () => host.freePackSlots(),
      burdenPercent: () => host.burdenPercent(),
      skill: (id) => host.skill?.(id) ?? null,
      itemCount: (name) => host.inventory().filter((i) => i.name.toLowerCase().includes(name.toLowerCase())).reduce((t, i) => t + (i.stack ?? 1), 0),
    }, () => host.now());
    // VirindiTank meta expressions (conditions / actions of kind 'expression').
    this.routine.expressions = vtankExpressions(vtankExprHost(this, this.routine, (text) => this.routine.echo(text)));
  }

  /** An object's subpalettes with their example colours: each palette's colour at the middle of its range. */
  itemPalettes(guid: number): ItemPalette[] {
    // A world object (corpse contents included) carries them; an item in your own pack has them from its CreateObject.
    const refs = this.host.object(guid)?.palettes ?? this.host.carriedPalettes?.(guid) ?? [];
    return refs.map((p) => ({ id: p.id, example: this.host.paletteColor?.(p.id, p.offset + Math.floor(p.length / 2)) ?? null }));
  }

  /** The selected object's guid, or null. */
  selectedGuid(): number | null { return this.host.targetGuid(); }
  /** Every skill with its training (the macro's planners). */
  skillList(): Array<{ id: number; name: string; training: 'untrained' | 'trained' | 'specialized'; base: number; buffed: number }> { return this.host.skillList?.() ?? []; }
  spellTableData(): ReturnType<NonNullable<AgentHost['spellTableData']>> { return this.host.spellTableData?.() ?? null; }
  /** Whether this era's world can salvage (a Ust and the server's salvage handler). */
  canSalvage(): boolean { return !!this.host.salvage; }

  /**
   * Salvage carried items with the Ust `toolGuid` (bags of one material combine), as the salvage panel's
   * button does, and wait up to `waitMs` for the first of them to leave the pack (the server's answer).
   */
  async salvage(toolGuid: number, itemGuids: number[], waitMs = 6000): Promise<AgentResult> {
    if (!this.host.salvage) return { ok: false, message: 'this era has no salvaging' };
    if (!itemGuids.length) return { ok: false, message: 'nothing to salvage' };
    const carried = new Set(this.host.inventory().map((i) => i.guid));
    const missing = itemGuids.filter((g) => !carried.has(g));
    if (missing.length) return { ok: false, message: `not carried: ${missing.map((g) => this.nameOf(g)).join(', ')}` };
    if (!carried.has(toolGuid)) return { ok: false, message: 'no Ust in your pack' };
    const names = itemGuids.map((g) => this.nameOf(g));
    if (!this.host.salvage(toolGuid, itemGuids)) return { ok: false, message: `could not salvage ${names.join(', ')}` };
    const gone = (): boolean => { const now = new Set(this.host.inventory().map((i) => i.guid)); return itemGuids.some((g) => !now.has(g)); };
    const t0 = this.host.now();
    while (!gone() && this.host.now() - t0 < waitMs) await sleep(100);
    return gone() ? { ok: true, message: `salvaged ${names.join(', ')}` } : { ok: false, message: `no answer to salvaging ${names.join(', ')}` };
  }

  /** The era's recipe table, or null (no table for this era, or not loaded). */
  async craftTable(): Promise<Array<[string, string, string, number, number, number, number]> | null> { return (await this.host.craftTable?.()) ?? null; }
  /** The era's monster table (the macro's Auto element and streak finisher), or null (none for this era). */
  async monsterTable(): Promise<Array<[string, string, number, number?, string?]> | null> { return (await this.host.monsterTable?.()) ?? null; }
  /** The era's drain and martyr table (the macro's Drain Auto plan), or null (none for this era). */
  async drainTable(): Promise<Array<[number, 'd' | 'm' | 'r', number, number, number]> | null> { return (await this.host.drainTable?.()) ?? null; }
  /** One of your int properties (PropertyInt), or undefined when the server hasn't sent it. */
  charInt(id: number): number | undefined { return this.host.charInt?.(id); }
  /** Whether a bolt or arrow from you to `guid` would hit something first (the line-of-fire test); null when the client can't tell. */
  lineOfFireBlocked(guid: number): boolean | null { const lof = this.host.lineOfFire?.(guid); return lof ? lof.blockedAt !== null : null; }
  /** Whether there is room `metres` straight ahead of you (null: can't tell). */
  roomAhead(metres: number): boolean | null { const me = this.self(); return me ? this.host.roomAhead?.(me.heading, metres) ?? null : null; }
  async specialAmmoTable(): Promise<Array<[string, number]> | null> { return (await this.host.specialAmmoTable?.()) ?? null; }
  /** Your enchantments now, with each spell's family and level from the spell table (the buff planner). */
  activeSpellsNow(): Array<{ spellId?: number; name: string; category?: number; power?: number; remaining: number }> {
    const t = this.host.spellTableData?.();
    return this.host.activeSpells().map((e) => {
      const s = e.spellId !== undefined ? t?.spells.get(e.spellId) : undefined;
      return { ...(e.spellId !== undefined ? { spellId: e.spellId } : {}), name: e.name, remaining: e.remaining < 0 ? Infinity : e.remaining, ...(s ? { category: s.category, power: s.power } : {}) };
    });
  }
  /** Seconds left on a shared item cooldown (SharedCooldown id), 0 when none or unknown. */
  cooldownRemaining(cooldownId: number): number { return this.host.cooldownRemaining?.(cooldownId) ?? 0; }
  packs(): ReturnType<NonNullable<AgentHost['packs']>> { return this.host.packs?.() ?? []; }
  spellComponents(spellId: number): string[] { return this.host.spellComponents?.(spellId) ?? []; }
  fellowshipInfo(): FellowshipInfo | null { return this.host.fellowshipInfo?.() ?? null; }
  itemSlots(): ReturnType<NonNullable<AgentHost['itemSlots']>> { return this.host.itemSlots?.() ?? []; }
  /** Split `amount` off a stack into the main pack (VTank splits a stack before a recipe that uses one on itself; UB's AutoVendor before selling part). */
  splitStack(guid: number, amount: number): AgentResult {
    if (!this.host.splitStack) return { ok: false, message: 'splitting stacks is not available' };
    return this.host.splitStack(guid, amount) ? { ok: true, message: `splitting ${amount} off #${guid.toString(16)}` } : { ok: false, message: 'the split was refused' };
  }
  placeItem(guid: number, to: { packSlot: number } | { onto: number }): AgentResult {
    if (!this.host.placeItem) return { ok: false, message: 'moving items is not available' };
    return this.host.placeItem(guid, to) ? { ok: true, message: 'onto' in to ? `merging #${guid.toString(16)} onto #${to.onto.toString(16)}` : `moving #${guid.toString(16)} to pack ${to.packSlot}` } : { ok: false, message: 'the move was refused' };
  }
  /** Every fellow, with where they are when the client can see them (an observation line). */
  private fellowsAt(): NonNullable<AgentObservation['fellows']> {
    const fs = this.host.fellows?.() ?? [];
    if (!fs.length) return [];
    const seen = new Map(this.nearby(1000).map((o) => [o.guid, o])); // in update range only (nearby)
    return fs.map((f) => {
      const o = seen.get(f.guid);
      const healthPct = f.health.max > 0 ? Math.round((100 * f.health.cur) / f.health.max) : 0;
      return o ? { name: f.name, healthPct, dist: o.dist, bearing: o.bearing } : { name: f.name, healthPct };
    });
  }

  /** Fellows in sight with their vitals and distance (the macro's Helper heals those within its range). */
  fellowsNear(radius = 100): Array<{ guid: number; name: string; distance: number; health: { cur: number; max: number }; stamina: { cur: number; max: number }; mana: { cur: number; max: number } }> {
    const near = new Map(this.snapshot({ radius, max: 80 }).nearby.map((o) => [o.guid, o.dist]));
    return (this.host.fellows?.() ?? []).flatMap((f) => (near.has(f.guid) ? [{ ...f, distance: near.get(f.guid)! }] : []));
  }
  /** What an examination of a carried item told (null until it was examined). */
  itemData(guid: number): ReturnType<NonNullable<AgentHost['appraisalData']>> { return this.host.appraisalData?.(guid) ?? null; }

  /** The newest event's seq (where "since now" starts). */
  currentSeq(): number { return this.seqN; }
  /** Where the server last echoed you (global metres; z as the cell's), and when (now() ms); null when it hasn't (or the host can't say). */
  serverPosition(): { x: number; y: number; z: number; at: number } | null {
    const p = this.host.serverSelfPosition?.();
    if (!p || !p.cell) return null;
    const g = toGlobal(p.cell, p.x, p.y);
    return { x: g.x, y: g.y, z: p.z, at: p.at };
  }

  /** The selected target's name, for routines that act "on the target". */
  targetName(): string | null {
    const g = this.host.targetGuid();
    return g ? this.nameOf(g) : null;
  }

  // ── events ──

  push(type: AgentEvent['type'], text: string, guid?: number, chatType?: number): void {
    const e: AgentEvent = { seq: ++this.seqN, t: Math.round(this.host.now()), type, text, ...(guid !== undefined ? { guid } : {}), ...(chatType !== undefined ? { chatType } : {}) };
    this.events.push(e);
    if (this.events.length > RING) this.events.splice(0, this.events.length - RING);
    for (const w of [...this.waiters]) {
      if (e.seq > w.since && this.matches(e, w.filter)) {
        clearTimeout(w.timer);
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(this.events.filter((x) => x.seq > w.since && this.matches(x, w.filter)));
      }
    }
  }

  /** A chat/system line the client displayed. main.ts taps gameUI.addSystemMessage into this. */
  pushChat(text: string, type?: number): void {
    const clean = text.replace(/\s+$/, '');
    if (!clean) return;
    this.push('chat', `(${chatKindOf(type, clean)}) ${clean}`, undefined, type);
    // Something attacked you: every incoming swing or spell is a CombatEnemy (0x15) line ("… hits you",
    // "… misses you", "You evaded …"), a 0-damage hit included, so an agent can wait on being attacked
    // instead of on vitals-low.
    if (type === 0x15) {
      this.push('attacked', clean);
      this.attackLines.push({ at: this.host.now(), text: clean.toLowerCase() });
      if (this.attackLines.length > 60) this.attackLines.splice(0, this.attackLines.length - 60);
    }
  }

  /**
   * The server's answer to a use (UseDone): 0 = done, else the WeenieError it failed with. main.ts taps it, so a
   * refusal retail shows no text for still reaches the player's report ({@link useOutcome}).
   */
  pushUseDone(code: number, name: string, text: string | null): void {
    if (code) this.push('use-failed', text ? `${text} (${name})` : `${name} (no message shown)`);
  }

  /**
   * The server ended an attack sequence (AttackDone; ACE Player.OnAttackDone always says ActionCancelled). Ends
   * that come with no swing between them mean the server would not attack the target at all: ACE ends at once,
   * silently, when it can't find it (dead and gone on its side), or can't reach it.
   */
  pushAttackDone(): void { this.attackDones.push({ at: this.host.now(), seq: this.seqN }); if (this.attackDones.length > 20) this.attackDones.shift(); }
  private attackDones: Array<{ at: number; seq: number }> = [];
  static readonly EMPTY_ATTACKS_TO_STOP = 3;

  static readonly USE_VITAL_MIN_CHANGE = 3;

  /** What a use can change, read before it: vitals, carried items, known spells, the enchantments on you. */
  private useMark(target?: number): { vit: Record<string, number>; inv: Map<number, { name: string; stack: number }>; spells: Set<number>; buffs: Map<string, number>; target?: number; open?: boolean } {
    const me = this.host.self();
    const t = target !== undefined ? this.host.object(target) : null;
    // A door's open state (PhysicsState Ethereal): a player sees it slide open or shut.
    const open = t && t.physicsState !== undefined && classify(t, false) === 'door' ? (t.physicsState & PHYSICS_ETHEREAL) !== 0 : undefined;
    const vit: Record<string, number> = me ? { health: me.health.current, stamina: me.stamina.current, mana: me.mana.current } : {};
    return {
      vit,
      inv: new Map(this.host.inventory().map((i) => [i.guid, { name: i.name, stack: i.stack ?? 1 }])),
      spells: new Set(this.host.spells().map((s) => s.id)),
      buffs: new Map(this.host.activeSpells().map((b) => [b.name, b.remaining])),
      ...(open !== undefined ? { target, open } : {}),
    };
  }

  /**
   * What a use did, as a player sees it on screen: the replies (chat, the centre notices, a dialog), a refusal the
   * server sent with no text, and what changed: vitals, items used up or gained, a spell learned, a buff on you.
   */
  private useOutcome(mark: ReturnType<AgentApi['useMark']>, since: number): string[] {
    const out: string[] = [];
    const chat = this.eventsSince(since)
      .filter((e) => (e.type === 'chat' && !/^\(\w+\) (Approaching|Using the) /.test(e.text)) || e.type === 'dialog' || e.type === 'portal')
      .map((e) => (e.type === 'chat' ? e.text.replace(/^\(\w+\) /, '') : `${e.type}: ${e.text}`));
    out.push(...chat);
    for (const e of this.eventsSince(since)) if (e.type === 'use-failed' && !chat.some((l) => e.text.startsWith(l))) out.push(`the server refused it: ${e.text}`);
    for (const l of chat) { const why = this.scrollShortfall(l); if (why) out.push(why); }
    const after = this.useMark(mark.target);
    if (mark.open !== undefined && after.open !== undefined && after.open !== mark.open) out.push(`${this.nameOf(mark.target!)} is now ${after.open ? 'open' : 'closed'}`);
    for (const k of Object.keys(mark.vit)) {
      const a = mark.vit[k], b = after.vit[k];
      // A point or two is the vital regenerating while the use ran, not its result ("mana 53 → 54" opening a corpse).
      if (b !== undefined && Math.abs(b - a) >= AgentApi.USE_VITAL_MIN_CHANGE) out.push(`${k} ${a} → ${b}`);
    }
    for (const [g, i] of mark.inv) {
      const now = after.inv.get(g);
      if (!now) out.push(`gone from your pack: ${i.name}${i.stack > 1 ? ` x${i.stack}` : ''}`);
      else if (now.stack !== i.stack) out.push(`${i.name}: ${i.stack} → ${now.stack}`);
    }
    for (const [g, i] of after.inv) if (!mark.inv.has(g)) out.push(`new in your pack: ${i.name}${i.stack > 1 ? ` x${i.stack}` : ''} #${g.toString(16)}`);
    const learned = this.host.spells().filter((s) => !mark.spells.has(s.id));
    if (learned.length) out.push(`learned: ${learned.map((s) => s.name).join(', ')}`);
    for (const [n, r] of after.buffs) {
      const was = mark.buffs.get(n);
      if (was === undefined) out.push(`now on you: ${n}`);
      else if (r >= 0 && was >= 0 && r > was + 1) out.push(`refreshed on you: ${n}`);
    }
    return out;
  }

  /**
   * "You are not skilled enough in War Magic to learn this spell.": by how much. ACE Player.CanReadScroll: a scroll
   * of power 50..299 needs the school's current skill ≥ power − 50 (magicSkillCheckMargin); the power is the DAT
   * spell table's. Only when the line names the school and the scroll's spell can be found.
   */
  private lastScroll: string | null = null;
  private scrollShortfall(line: string): string | null {
    const m = /not skilled enough in (.+?) to learn this spell/i.exec(line);
    if (!m || !this.lastScroll) return null;
    const table = this.host.spellTableData?.();
    const spellName = this.lastScroll.replace(/^Scroll of /i, '').toLowerCase();
    const spell = table ? [...table.spells.values()].find((s) => s.name.toLowerCase() === spellName) : undefined;
    const skill = this.host.skillList?.().find((s) => s.name.toLowerCase() === m[1].toLowerCase());
    if (!spell || !skill) return null;
    return `  (${this.lastScroll}: needs ${skill.name} ${spell.power - 50} or more to learn; yours is ${skill.buffed})`;
  }

  /** Incoming-attack lines (CombatEnemy, lower-cased) with when they came, for {@link attackersOfMe}. */
  private attackLines: Array<{ at: number; text: string }> = [];
  static readonly ATTACKER_WINDOW_MS = 10_000;

  /**
   * Who is attacking you: each CombatEnemy line of the last 10 s ("The Drudge Skulker hits you …", "You evaded
   * the Drudge Skulker!") goes to the monster whose name it holds (the longest such name; the nearest of several
   * with that name), counted per guid. Information for the player, not a decision: what to fight is theirs.
   */
  attackersOfMe(): Map<number, number> {
    const out = new Map<number, number>();
    const now = this.host.now();
    const lines = this.attackLines.filter((l) => now - l.at <= AgentApi.ATTACKER_WINDOW_MS);
    if (!lines.length || !this.me()) return out;
    const monsters = this.nearby(80).filter((o) => o.kind === 'monster' && !o.dying);
    for (const l of lines) {
      let best: AgentObject | null = null;
      for (const o of monsters) {
        const n = o.name.toLowerCase();
        if (!n || !l.text.includes(n)) continue;
        if (!best || n.length > best.name.length || (n.length === best.name.length && o.dist < best.dist)) best = o;
      }
      if (best) out.set(best.guid, (out.get(best.guid) ?? 0) + 1);
    }
    return out;
  }

  private objectAdded(o: AgentHostObject): void {
    if (o.cell === null || o.wielderId || o.containerId) return;
    const kind = classify(o, this.host.isAttackable(o.guid));
    if (kind === 'monster' || kind === 'player' || kind === 'corpse') this.push('object-added', `${o.name} [${kind}] #${o.guid.toString(16)}`, o.guid);
  }

  /**
   * A watched target left the client's world. Only a death the client saw
   * start (isDying) is a kill; anything else — it fled out of range, we
   * moved off, the page reloaded — is `target-lost`, never a false kill.
   */
  private objectRemoved(guid: number, name: string): void {
    if (guid !== this.attackTarget && guid !== this.watchedTarget) return;
    if (this.dyingSeen.has(guid) || this.killedRecently(name)) this.push('target-died', `${name} #${guid.toString(16)} died`, guid);
    else if (this.host.screen() === 'world') {
      // Not every server shows the death start (1999's adapter deletes the object outright):
      // a "Corpse of <name>" appearing in the next 3 s settles it as a kill (tick).
      this.pendingLoss.set(guid, { name, at: this.host.now() });
    }
    if (guid === this.watchedTarget) this.watchedTarget = 0;
    if (guid === this.attackTarget) this.attackTarget = 0;
    this.dyingSeen.delete(guid);
  }

  /** A kill line naming `name` in the last 5 s ("You slay…", "Your killing blow…", "… died!"). */
  private killedRecently(name: string, afterSeq = 0): boolean {
    const since = this.host.now() - 5000;
    const n = name.toLowerCase();
    return this.events.some((e) => e.t >= since && e.seq > afterSeq && e.type === 'chat' && e.text.toLowerCase().includes(n)
      && /killing blow|you slay|you kill|\bdied\b|is dead|obliterate|torn to ribbons|death/i.test(e.text));
  }

  /**
   * Whether an event wakes a wait: with `chatMatch`, chat lines matching it
   * (plus any of `types` other than chat); with only `types`, those types;
   * with neither, anything. A chat_match wait used to wake on every other
   * event as well (an object coming into view), so a wait for a partner's
   * line returned early with something else and the line came after
   * (2026-10-10).
   */
  private matches(e: AgentEvent, f: AgentWaitFilter): boolean {
    const types = f.types?.filter((t) => !(f.chatMatch && t === 'chat')) ?? [];
    if (f.chatMatch) {
      if (e.type === 'chat') {
        try { return new RegExp(f.chatMatch, 'i').test(e.text); } catch { return e.text.toLowerCase().includes(f.chatMatch.toLowerCase()); }
      }
      return types.includes(e.type);
    }
    return !types.length || types.includes(e.type);
  }

  eventsSince(sinceSeq = 0): AgentEvent[] {
    return this.events.filter((e) => e.seq > sinceSeq);
  }

  /**
   * The player's wait (ac_wait): like waitFor, but from what the player last
   * saw (its last observe or wait), not from now, so a tell that came in
   * between an observe and the wait wakes it at once (2026-10-10). An
   * explicit sinceSeq still wins, unless it is from before a page reload (the
   * event numbers restarted: newer than any event now), when the player's
   * last look is used instead.
   */
  async wait(filter: AgentWaitFilter = {}, timeoutMs = 20_000): Promise<AgentEvent[]> {
    const asked = filter.sinceSeq;
    const since = asked !== undefined && asked !== null && asked <= this.seqN ? asked : Math.min(this.lookSeq, this.seqN);
    const evs = await this.waitFor({ ...filter, sinceSeq: since }, timeoutMs);
    this.lookSeq = Math.max(this.lookSeq, ...evs.map((e) => e.seq));
    return evs;
  }

  /** Resolve with the matching events as soon as one arrives (or [] after timeoutMs). */
  waitFor(filter: AgentWaitFilter = {}, timeoutMs = 20_000): Promise<AgentEvent[]> {
    const since = filter.sinceSeq ?? this.seqN;
    const already = this.events.filter((e) => e.seq > since && this.matches(e, filter));
    if (already.length) return Promise.resolve(already);
    return new Promise((resolve) => {
      const w = { filter, since, resolve, timer: setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); resolve([]); }, timeoutMs) };
      this.waiters.push(w);
    });
  }

  // ── perception ──

  private me(): { s: AgentHostSelf; g: { x: number; y: number }; heading: number } | null {
    const s = this.host.self();
    if (!s || !s.cell) return null;
    return { s, g: toGlobal(s.cell, s.x, s.y), heading: yawToCompass(s.yaw) };
  }

  private describe(o: AgentHostObject, me: NonNullable<ReturnType<AgentApi['me']>>): AgentObject | null {
    if (o.cell === null || !o.cell) return null;
    const g = toGlobal(o.cell, o.x, o.y);
    const b = bearing(me.g, g);
    const obj: AgentObject = {
      guid: o.guid >>> 0,
      name: o.name,
      kind: classify(o, this.host.isAttackable(o.guid)),
      dist: Math.round(Math.hypot(g.x - me.g.x, g.y - me.g.y) * 10) / 10,
      bearing: Math.round(b),
      relBearing: Math.round(relDeg(b - me.heading)),
      dz: Math.round((o.z - me.s.z) * 10) / 10,
    };
    if (o.level) obj.level = o.level;
    if (o.stack && o.stack > 1) obj.stack = o.stack;
    if (obj.kind === 'door' && o.physicsState !== undefined) obj.open = (o.physicsState & PHYSICS_ETHEREAL) !== 0;
    // A creature whose death has begun (it lingers a few seconds before the corpse): not a target any more.
    if (obj.kind === 'monster' && this.host.isDying(o.guid)) obj.dying = true;
    if (o.guid === this.host.targetGuid()) {
      const h = this.host.targetHealth();
      if (h !== undefined) obj.health = Math.round(h * 100) / 100;
    }
    return obj;
  }

  /** Nearby world objects, nearest first (carried/contained ones excluded). */
  nearby(radius = 60, filter?: string): AgentObject[] {
    const me = this.me();
    if (!me) return [];
    const carried = this.host.carriedGuids();
    const f = filter?.toLowerCase();
    const out: AgentObject[] = [];
    for (const o of this.host.objects()) {
      if (o.guid === me.s.guid || carried.has(o.guid) || o.wielderId || o.containerId) continue;
      const d = this.describe(o, me);
      if (!d || d.dist > radius) continue;
      if (f && !d.name.toLowerCase().includes(f) && d.kind !== f) continue;
      // A creature or player outside the server's update range is only its last-known position: the client keeps it,
      // but nothing moves it any more (a fellow 430 m off read 212 m, 2026-10-10).
      if ((o.itemType & IT.Creature) && o.cell && !inUpdateRange(me.s.cell, o.cell)) continue;
      // Likewise a creature in a dungeon cell out of sight of yours: the server stopped sending it, so its place is stale.
      if ((o.itemType & IT.Creature) && o.cell && this.host.cellSees?.(me.s.cell, o.cell) === false) continue;
      out.push(d);
    }
    return out.sort((a, b) => a.dist - b.dist);
  }

  self(): AgentSelf | null {
    const me = this.me();
    if (!me) return null;
    const { s } = me;
    const indoors = (s.cell & 0xffff) >= 0x100;
    const out: AgentSelf = {
      guid: s.guid, name: s.name, level: s.level,
      health: { cur: s.health.current, max: s.health.max },
      stamina: { cur: s.stamina.current, max: s.stamina.max },
      mana: { cur: s.mana.current, max: s.mana.max },
      // The radar's own text (CPlayerSystem::InqPlayerCoords: the 24 m cell, (c − 1024) × 0.1 + 0.5).
      coords: indoors ? null : mapCoordinateText(mapCoordsOfCell(Math.floor(me.g.x / CELL_LENGTH), Math.floor(me.g.y / CELL_LENGTH))),
      cell: `0x${(s.cell >>> 0).toString(16).toUpperCase().padStart(8, '0')}`,
      indoors,
      pos: { x: Math.round(me.g.x * 10) / 10, y: Math.round(me.g.y * 10) / 10, z: Math.round(s.z * 10) / 10 },
      heading: Math.round(me.heading),
      combatMode: s.combatMode,
      task: this.task?.label ?? null,
      dead: s.dead,
    };
    if (s.serverMode) out.serverMode = s.serverMode;
    if (s.pyreals !== undefined) out.pyreals = s.pyreals;
    if (s.burden) out.burden = s.burden;
    if (s.xpTotal !== undefined) out.xp = { total: s.xpTotal, unassigned: s.xpUnassigned ?? 0 };
    return out;
  }

  /** An observation that leaves the unread chat for the player's own next observe (routines read it this way). */
  snapshot(opts: ObserveOptions = {}): AgentObservation {
    const cursor = this.chatCursor, look = this.lookSeq;
    const obs = this.observe(opts);
    this.chatCursor = cursor;
    this.lookSeq = look;
    return obs;
  }

  observe(opts: ObserveOptions = {}): AgentObservation {
    const radius = opts.radius ?? 60;
    const max = opts.max ?? 25;
    const all = this.nearby(radius, opts.filter);
    const me = this.me();
    const tg = this.host.targetGuid();
    const tobj = tg ? this.host.object(tg) : null;
    const chatEvents = this.events.filter((e) => e.type === 'chat' && e.seq > this.chatCursor).slice(-40);
    this.chatCursor = this.seqN;
    this.lookSeq = this.seqN;
    const chat: AgentChatLine[] = chatEvents.map((e) => {
      const m = /^\((\w+)\) ([\s\S]*)$/.exec(e.text);
      return { seq: e.seq, t: e.t, kind: (m?.[1] ?? 'other') as AgentChatKind, text: m?.[2] ?? e.text };
    });
    const target = tobj && me ? this.describe(tobj, me) : null;
    const attackers = this.attackersOfMe();
    for (const o of target ? [target, ...all] : all) {
      const n = attackers.get(o.guid);
      if (n) o.attackingYou = n;
    }
    if (target && target.kind === 'monster' && !target.dying) {
      const lof = this.host.lineOfFire?.(target.guid);
      if (lof && lof.blockedAt !== null) target.lineOfFireBlockedAt = lof.blockedAt;
    }
    return {
      screen: this.host.screen(),
      me: this.self(),
      target,
      nearby: all.slice(0, max),
      nearbyTotal: all.length,
      dialogs: this.host.dialogs(),
      windows: this.host.openWindows?.() ?? [],
      buffs: this.host.activeSpells(),
      buffsMissing: this.missingBuffs(),
      fellows: this.fellowsAt(),
      fellowshipAlone: (this.host.fellowshipInfo?.()?.count ?? 0) === 1,
      remembered: this.rememberedPlaces({ ...(opts.radius !== undefined ? { radius: opts.radius } : {}), ...(opts.filter ? { filter: opts.filter } : {}) }),
      chat,
      seq: this.seqN,
    };
  }

  events_(sinceSeq = 0): AgentEvent[] { return this.eventsSince(sinceSeq); }

  inventory(): AgentItem[] { return this.host.inventory(); }

  spells(filter = '', max = 40): AgentSpell[] {
    const f = filter.toLowerCase();
    return this.host.spells().filter((s) => !f || s.name.toLowerCase().includes(f) || s.school.toLowerCase().includes(f)).slice(0, max);
  }

  characterSheet(): string { return this.host.characterSheet(); }

  // ── resolution ──

  /**
   * A guid, or the best name match (nameMatchScore) among what you carry, the
   * world objects near you (nearest first on a tie) and remembered places.
   * In your inventory a pack item beats a worn one of the same name: "drop
   * Chainmail Leggings" means the spare pair, not the pair on your legs
   * (2026-10-10). With both, the better match wins; a tie goes to the inventory.
   */
  resolve(t: TargetArg, where: 'world' | 'inventory' | 'any' = 'any'): number | null {
    if (t === null || t === undefined || t === '') return null;
    if (typeof t === 'number') return t >>> 0;
    const name = t.trim();
    if (/^(self|me)$/i.test(name)) return this.host.self()?.guid ?? null;
    let inv: { item: AgentItem; score: number } | null = null;
    if (where !== 'world') {
      const items = this.host.inventory();
      inv = bestNameMatch(name, [...items.filter((i) => i.where !== 'equipped'), ...items.filter((i) => i.where === 'equipped')], (i) => i.name);
    }
    let world: { guid: number; score: number } | null = null;
    if (where !== 'inventory') {
      // As far as the server keeps us updated (3 × 3 landblocks): "walk_to Claude Arcanist" with them 212 m off
      // found nothing at 200 m, 2026-10-10.
      const near = bestNameMatch(name, this.nearby(600), (o) => o.name);
      if (near) world = { guid: near.item.guid, score: near.score };
      const place = bestNameMatch(name, [...this.places.entries()], ([, v]) => v.name);
      if (place && place.score > (world?.score ?? 0)) world = { guid: place.item[0], score: place.score };
    }
    if (inv && inv.score >= (world?.score ?? 0)) return inv.item.guid;
    return world?.guid ?? null;
  }

  private need(t: TargetArg, where: 'world' | 'inventory' | 'any', what: string): number | AgentResult {
    const g = this.resolve(t, where);
    const fellow = g === null && typeof t === 'string' ? (this.host.fellows?.() ?? []).find((f) => f.name.toLowerCase() === t.toLowerCase()) : undefined;
    if (fellow) return { ok: false, message: `${fellow.name} is in your fellowship but not in view (in a dungeon you only see the rooms in sight of yours): ask in /f where they are, or go back to where you last saw them` };
    if (g === null) return { ok: false, message: `no ${what} matching "${t}"${where === 'world' ? ' nearby' : where === 'inventory' ? ' in your inventory' : ' nearby or in your inventory'}` };
    return g;
  }

  private nameOf(guid: number): string {
    if (guid === this.host.self()?.guid) return 'yourself';
    return this.host.object(guid)?.name ?? this.host.inventory().find((i) => i.guid === guid)?.name ?? `#${guid.toString(16)}`;
  }

  // ── simple actions ──

  /**
   * Type a chat line. No cheating (Jake, 2026-10-06): "@" lines are ACE's
   * server/admin command prefix, never something a retail player typed, so
   * the agent may not send them; retail's own "/" commands go through the
   * client's command system as typed.
   */
  private goal: string | null = null;

  /** AGENT.hosted-mcp-connector step 2 — where the tab is: screen, character, the account's characters, the goal. */
  status(): AgentStatus {
    const screen = this.host.screen();
    return { screen, character: screen === 'world' || screen === 'portal-space' ? this.host.self()?.name ?? null : null, characters: this.host.characterList?.() ?? [], goal: this.goal };
  }

  /** Enter the world from character select as a player does: that character's row, then Enter. Claude never creates or deletes characters. */
  async enterWorld(name: string, timeoutMs = 60_000): Promise<AgentResult> {
    const want = String(name ?? '').trim();
    if (!want) return { ok: false, message: 'name the character to enter as' };
    const screen = this.host.screen();
    const inWorld = this.host.self()?.name ?? null;
    if ((screen === 'world' || screen === 'portal-space') && inWorld) {
      return inWorld.toLowerCase() === want.toLowerCase() ? { ok: true, message: `already in the world as ${inWorld}` } : { ok: false, message: `${inWorld} is in the world; log out to character select first` };
    }
    if (screen !== 'character-select') return { ok: false, message: `not at character select (the screen is ${screen})` };
    if (!this.host.enterCharacter) return { ok: false, message: 'this client cannot enter the world for you' };
    const why = this.host.enterCharacter(want);
    if (why) return { ok: false, message: why };
    const end = this.host.now() + timeoutMs;
    while (this.host.now() < end) {
      await sleep(250);
      const sc = this.host.screen();
      const me = this.host.self();
      if (sc === 'world' && me) return { ok: true, message: `in the world as ${me.name}` };
    }
    return { ok: false, message: `still not in the world after ${Math.round(timeoutMs / 1000)} s (screen: ${this.host.screen()})` };
  }

  /** Claude's goal line, shown to the player (an empty text clears it). */
  setGoal(text: string): AgentResult {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    this.goal = t || null;
    this.host.showGoal?.(this.goal);
    return { ok: true, message: this.goal ? `goal: ${this.goal}` : 'goal cleared' };
  }

  say(text: string): AgentResult {
    if (/^\s*@/.test(text)) return { ok: false, message: 'refused: "@" server commands are not available to agents (play as a player; retail "/" commands work)' };
    this.host.chat(text);
    return { ok: true, message: `sent: ${text}` };
  }

  select(t: TargetArg): AgentResult {
    const g = this.need(t, 'any', 'object');
    if (typeof g !== 'number') return g;
    return this.host.select(g) ? { ok: true, message: `selected ${this.nameOf(g)}` } : { ok: false, message: `can't select #${g.toString(16)}` };
  }

  /**
   * Use an object as a double-click does, and report what came of it. When
   * doorways lie between us and it (the server's own approach walks a
   * straight line), walk the cell route first; then send the Use and wait
   * up to 10 s for a reaction — its chat, a dialog, a vendor or container
   * opening, portal space — and return those lines.
   */
  async use(t: TargetArg): Promise<AgentResult> {
    const g = this.need(t, 'any', 'object');
    if (typeof g !== 'number') return g;
    const name = this.nameOf(g);
    const approach = await this.approachWithin(g, 2.5, AgentApi.USE_APPROACH_MS);
    if (approach && !approach.ok) return { ok: false, message: `couldn't reach ${name}: ${approach.message}${this.dialogNote()}` };
    const since = this.seqN;
    const mark = this.useMark(g);
    this.lastScroll = /^Scroll of /i.test(name) ? name : null;
    this.host.select(g);
    if (!this.host.use(g)) return { ok: false, message: `can't use #${g.toString(16)} (not known to the client)` };
    const reacted = (): string | null => {
      if (this.host.book?.()?.guid === g) return null;
      if (this.host.vendor()) return 'vendor window open (ac_vendor lists it)';
      if (this.host.openContainer()?.guid === g) return 'container open (ac_loot takes from it)';
      if (this.host.trade()) return `trade window open with ${this.host.trade()!.partner} (ac_trade)`;
      return null;
    };
    const lines = (): string[] => this.useOutcome(mark, since);
    await this.settle(() => lines().length > 0 || !!reacted() || this.host.book?.()?.guid === g);
    const out = lines();
    const extra = reacted();
    const read = this.host.book?.()?.guid === g ? await this.readBook() : [];
    if (!out.length && !extra && !read.length) return { ok: true, message: `used ${name}; no reply within 10 s (it may need you closer, or simply does nothing)${this.dialogNote()}` };
    return { ok: !out.some((l) => l.startsWith('the server refused it')), message: [`used ${name}:`, ...out.map((l) => `  ${l}`), ...(extra ? [`  ${extra}`] : []), ...read].join('\n') };
  }

  /** Up to 10 s for a first reaction, then 1.2 s more for the rest of it (multi-line replies, a heal after its words). */
  private async settle(reacted: () => boolean): Promise<void> {
    let settle = -1;
    for (let i = 0; i < 50 && settle !== 0; i++) {
      if (settle < 0 && reacted()) settle = 6;
      if (settle > 0) settle--;
      await sleep(200);
    }
  }

  /** ac_use_on: use an item on a target, then report what came of it as {@link use} does. Routines use {@link useOn}. */
  async useOnReported(item: TargetArg, target: TargetArg): Promise<AgentResult> {
    const i = this.need(item, 'inventory', 'item');
    if (typeof i !== 'number') return i;
    const t = this.need(target, 'any', 'target');
    if (typeof t !== 'number') return t;
    const itemName = this.nameOf(i), targetName = this.nameOf(t);
    const since = this.seqN;
    const mark = this.useMark();
    if (!this.host.useWithTarget(i, t)) return { ok: false, message: 'use-with refused' };
    await this.settle(() => this.useOutcome(mark, since).length > 0);
    const out = this.useOutcome(mark, since);
    const head = `used ${itemName} on ${targetName}`;
    if (!out.length) return { ok: true, message: `${head}; no reply within 10 s (it may need you closer, or does nothing on that)` };
    return { ok: !out.some((l) => l.startsWith('the server refused it')), message: [`${head}:`, ...out.map((l) => `  ${l}`)].join('\n') };
  }

  /**
   * The open book's text, every page: the ones the server has not sent yet
   * are asked for in turn, as turning to each page does (gmBookUI asks for a
   * page's data when it is shown; ACE's BookDataResponse carries none).
   */
  private async readBook(): Promise<string[]> {
    const b0 = this.host.book?.();
    if (!b0) return [];
    const missing = (i: number): boolean => this.host.book?.()?.pages[i]?.text === null;
    for (let i = 0; i < b0.pages.length; i++) {
      // The page the book opened on is already asked for: give its answer a moment first.
      for (let w = 0; w < 5 && i === 0 && missing(i); w++) await sleep(200);
      if (!missing(i)) continue;
      this.host.bookPage?.(i);
      for (let w = 0; w < 15 && missing(i); w++) await sleep(200);
    }
    const b = this.host.book?.() ?? b0;
    const pages = b.pages.map((p, i) => ({ ...p, n: i + 1 })).filter((p) => p.text === null || p.text.trim());
    if (!pages.length) return [`  ${b.title}: (it has no writing)`];
    return [
      `  ${b.title} reads (${pages.length} page${pages.length === 1 ? '' : 's'}; ac_close name=Book when done):`,
      ...pages.map((p) => `  [page ${p.n}${p.author ? `, by ${p.author}` : ''}] ${p.text === null ? '(the page did not arrive)' : p.text.replace(/\r?\n/g, ' / ')}`),
    ];
  }

  /**
   * The longest ac_use spends walking up to its object before it gives up and says so: the use's report (up to
   * 11 s of replies) still comes inside the tool's own 60 s. A walk that ran on past the tool's timeout kept
   * walking with nobody waiting for it (Arcanist at a Holtburg tower scrivener, 2026-10-11).
   */
  static readonly USE_APPROACH_MS = 45_000;

  /** {@link approach}, given up after `limitMs`: the walk is stopped (not left running) and the reply says how far it got. */
  private async approachWithin(guid: number, within: number, limitMs: number): Promise<AgentResult | null> {
    const walk = this.approach(guid, within);
    if (!walk) return null;
    let result: AgentResult | null | undefined;
    void walk.then((r) => { result = r; });
    const start = this.host.now();
    while (result === undefined && this.host.now() - start < limitMs) await sleep(200);
    if (result !== undefined) return result;
    const task = this.task?.label ?? 'the walk';
    this.cancelTask('ac_use stopped waiting for it');
    const o = this.host.object(guid);
    const me = this.me();
    const d = o && o.cell && me ? Math.hypot(toGlobal(o.cell, o.x, o.y).x - me.g.x, toGlobal(o.cell, o.x, o.y).y - me.g.y) : null;
    return { ok: false, message: `${task} took longer than ${Math.round(limitMs / 1000)} s${d !== null ? ` and stopped ${d.toFixed(1)} m away` : ''}; ac_walk_to it first (it can take longer), then use it` };
  }

  /** "; a dialog is open: …" naming the open popups (they wait for an answer; ac_dialog gives it), or ''. */
  private dialogNote(): string {
    const ds = this.host.dialogs();
    if (!ds.length) return '';
    return `; ${ds.length === 1 ? 'a dialog is' : `${ds.length} dialogs are`} open: ${ds.map((d) => `"${d.text.replace(/\s+/g, ' ').slice(0, 120)}" [${d.buttons.join(' / ')}]`).join(', ')} (ac_dialog answers it)`;
  }

  /**
   * When doorways separate us from `guid`, walk the cell route to within
   * `within` m and return how that went; null when a straight line is fine
   * (the server's own MoveTo handles the last stretch).
   */
  private approach(guid: number, within: number): Promise<AgentResult> | null {
    const o = this.host.object(guid) ?? this.remembered(guid);
    if (!o || !o.cell) return null;
    if (!this.planRoute(toGlobal(o.cell, o.x, o.y), o).length) return null;
    return this.walkTo(guid, { within, timeoutMs: 90_000 });
  }

  /** A corpse that appeared since the last few ticks (not one lying there from before). */
  private isNearbyNew(o: AgentHostObject): boolean {
    return !!this.known && !this.known.has(o.guid);
  }

  private remembered(guid: number): AgentHostObject | null {
    const p = this.places.get(guid);
    return p ? { guid, name: p.name, itemType: 0, objectDescFlags: 0, cell: p.cell, x: p.x, y: p.y, z: p.z } : null;
  }

  /** Buffs you know (the highest level of each) that aren't on you now: self-only spells first. */
  private missingBuffs(): string[] {
    const up = new Set(this.host.activeSpells().map((b) => b.name));
    const best = new Map<string, AgentSpell>();
    for (const s of this.host.spells()) {
      if (!s.buff) continue;
      const family = s.name.replace(/\s+[IVXL]+$/, '');
      const had = best.get(family);
      if (!had || (s.level ?? 0) > (had.level ?? 0)) best.set(family, s);
    }
    const fams = [...best.entries()].filter(([family]) => ![...up].some((n) => n.replace(/\s+[IVXL]+$/, '') === family));
    return fams.sort((a, b) => Number(!!b[1].self) - Number(!!a[1].self)).map(([, s]) => s.name);
  }

  /** A line in the page console the play daemon keeps in its log ([AC:Agent]): what walk_to decided and why. */
  private trace(msg: string): void {
    console.log(`[AC:Agent] ${msg}`);
  }

  // ── map ──

  /** The client's jump physics for the planner, when the host has them (AGENT.walk-drops-jumps). */
  private jumpKit(): JumpKit | null {
    const h = this.host;
    if (!h.navFloor || !h.navAirStep || !h.jumpLaunch) return null;
    const floor = h.navFloor.bind(h), airStep = h.navAirStep.bind(h), launch = h.jumpLaunch.bind(h);
    return { floor, airStep, launch: (p, w) => launch(p, w), chargeSeconds: launch(1, false).chargeSeconds };
  }

  /** Jumps and drops the planner may take, with the fall damage your health allows now. */
  private jumpSearch(): JumpSearch | null {
    const kit = this.jumpKit();
    const s = this.host.self();
    return kit && s ? { kit, maxDamage: fallBudget(s.health) } : null;
  }

  /**
   * A text floor plan around you from the client's own movement collision:
   * the floor your body can reach from where you stand ('.'), floor more
   * than 1 m up or down (':'), walls, drops and the unreachable ('#'), you
   * ('@') and nearby objects as letters with a legend. North is up, one
   * character per metre.
   */
  map(opts: { radius?: number } = {}): AgentResult {
    const probe = this.host.navProbe?.bind(this.host);
    const me = this.me();
    if (!probe) return { ok: false, message: 'this client has no movement probe for a map' };
    if (!me) return { ok: false, message: 'not in the world' };
    const radius = Math.max(5, Math.min(25, Math.round(opts.radius ?? 15)));
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const objs = this.nearby(radius * 1.42).filter((o) => o.kind !== 'item' || o.dist < radius).slice(0, letters.length);
    const marks = objs.map((o, i) => {
      const b = (o.bearing * Math.PI) / 180;
      // With the same distance and direction observe gives, and the floor it's on when not yours.
      const dz = o.dz ?? 0;
      const floor = Math.abs(dz) > 1.5 ? `, ${Math.abs(dz).toFixed(0)} m ${dz > 0 ? 'up' : 'down'}` : '';
      return { x: me.g.x + o.dist * Math.sin(b), y: me.g.y + o.dist * Math.cos(b), ch: letters[i], label: `${o.name} [${o.kind}] #${o.guid.toString(16)}  ${o.dist.toFixed(1)} m ${compassPoint(o.bearing)}${floor}` };
    });
    const jumps = this.jumpSearch();
    const plan = floorPlan(probe, { x: me.g.x, y: me.g.y, z: me.s.z }, marks, { radius, spacing: 1, maxProbes: 6000, ...(jumps ? { jumps } : {}) });
    return {
      ok: true,
      message: [
        `map ${2 * radius + 1} m square around you, north up, 1 character = 1 m: @ you, . floor you can walk to from here, : reachable floor over 1 m up/down, # wall, drop or out of reach${jumps ? ', v a ledge you can drop off (lower floor, a fall your health takes), ! a drop that would hurt too much, J floor a jump reaches (walk_to jumps and drops on its own)' : ''}`,
        ...plan.lines,
        ...(plan.legend.length ? ['legend:', ...plan.legend.map((l) => `  ${l}`)] : []),
      ].join('\n'),
    };
  }

  // ── windows ──

  /** Close an open window by name ("Social", "Container", "Inventory" …) or every one ("all"). */
  closeWindow(name = 'all'): AgentResult {
    if (!this.host.closeWindow) return { ok: false, message: 'this client cannot close windows for agents' };
    const err = this.host.closeWindow(name);
    if (err) return { ok: false, message: err };
    const left = this.host.openWindows?.() ?? [];
    return { ok: true, message: `closed ${name === 'all' ? 'every window' : name}${left.length ? `; still open: ${left.join(', ')}` : ''}` };
  }

  // ── fellowship ──

  /**
   * Fellowship, through the fellowship pane: show; create name=…; recruit a
   * nearby player (selected first, as the Recruit button takes the
   * selection; they answer a dialog, which they can do with ac_dialog);
   * quit; leader / dismiss a fellow by name; open / close; disband.
   */
  async fellowship(action = 'show', arg?: string): Promise<AgentResult> {
    if (!this.host.fellowship || !this.host.fellowshipAction) return { ok: false, message: 'this client has no fellowship pane for agents' };
    if (action === 'show') {
      // As showing the pane does: ask for a full update (levels and vitals change after recruiting).
      if (this.host.refreshSocial) { this.host.refreshSocial('fellowship'); await sleep(1200); }
      return { ok: true, message: this.host.fellowship() };
    }
    const since = this.seqN;
    const before = this.host.fellowship();
    let who = '';
    if (action === 'recruit') {
      const g = this.need(arg ?? '', 'world', 'player');
      if (typeof g !== 'number') return g;
      if (!this.host.select(g)) return { ok: false, message: `can't select #${g.toString(16)}` };
      who = this.nameOf(g);
    }
    const err = this.host.fellowshipAction(action, arg);
    if (err) return { ok: false, message: err };
    // The server answers in a moment (the pane updates, or a 0x1a line); back within 5 s so that one
    // Claude playing both characters can answer a recruit's 30 s dialog on the other.
    for (let i = 0; i < 25 && this.host.fellowship() === before; i++) await sleep(200);
    const said = this.eventsSince(since).filter((e) => e.type === 'chat').map((e) => e.text.replace(/^\(\w+\) /, ''));
    const after = this.host.fellowship();
    if (action === 'requests' || action === 'auto') return { ok: true, message: this.host.fellowship() };
    const head = action === 'recruit'
      ? `asked ${who} to join. They have 30 s to accept the server's dialog; if you also play ${who}, answer it now: ac_dialog button=Yes on their profile.`
      : after !== before ? `done: ${action}` : `sent: ${action}${arg ? ` ${arg}` : ''} (no change yet)`;
    return { ok: true, message: [head, ...said.map((l) => `  ${l}`), ...(after !== before ? [after] : [])].join('\n') };
  }

  // ── allegiance ──

  allegiance(): string {
    return this.host.allegiance?.() ?? 'allegiance information is not available in this client';
  }

  /**
   * Swear allegiance to a nearby player: select them and press the
   * allegiance pane's Swear (its own gate). The server walks you to them and
   * asks them in a dialog that expires after 30 s (ACE ConfirmationManager
   * confirmationTimeout). This returns within 5 s so that one Claude playing
   * both characters can still answer it on the patron.
   */
  async swearAllegiance(t: TargetArg): Promise<AgentResult> {
    const g = this.need(t, 'world', 'player');
    if (typeof g !== 'number') return g;
    if (!this.host.swearAllegiance) return { ok: false, message: 'this client has no allegiance pane' };
    const name = this.nameOf(g);
    if (!this.host.select(g)) return { ok: false, message: `can't select ${name}` };
    const since = this.seqN;
    const before = this.allegiance();
    const err = this.host.swearAllegiance();
    if (err) return { ok: false, message: err };
    const lines = (): string[] => this.eventsSince(since).filter((e) => e.type === 'chat').map((e) => e.text.replace(/^\(\w+\) /, ''));
    for (let i = 0; i < 25 && this.allegiance() === before && !lines().some((l) => /declined|refuse|cannot|can't|not accepting|ignor/i.test(l)); i++) await sleep(200);
    const after = this.allegiance();
    const said = lines();
    if (after !== before) return { ok: true, message: [`swore allegiance to ${name}.`, ...said.map((l) => `  ${l}`), after].join('\n') };
    if (said.some((l) => /declined|refuse|cannot|can't|not accepting|ignor/i.test(l))) return { ok: false, message: [`${name} did not take your oath:`, ...said.map((l) => `  ${l}`)].join('\n') };
    return {
      ok: true,
      message: [
        `asked to swear to ${name}. They now have 30 s to accept the server's dialog ("… would like to swear allegiance to you"). If you also play ${name}, answer it now: ac_dialog button=Yes on their profile. Then ac_allegiance (show) confirms.`,
        ...said.map((l) => `  ${l}`),
      ].join('\n'),
    };
  }

  /** Break from your patron (no name), or release a vassal by name. */
  breakAllegiance(name?: string): AgentResult {
    if (!this.host.breakAllegiance) return { ok: false, message: 'this client has no allegiance pane' };
    const err = this.host.breakAllegiance(name);
    return err ? { ok: false, message: err } : { ok: true, message: name ? `broke allegiance with ${name}` : 'broke from your patron' };
  }

  useOn(item: TargetArg, target: TargetArg): AgentResult {
    const i = this.need(item, 'inventory', 'item');
    if (typeof i !== 'number') return i;
    const t = this.need(target, 'any', 'target');
    if (typeof t !== 'number') return t;
    return this.host.useWithTarget(i, t)
      ? { ok: true, message: `using ${this.nameOf(i)} on ${this.nameOf(t)}` }
      : { ok: false, message: 'use-with refused' };
  }

  combatMode(mode: string): AgentResult {
    const m = (['peace', 'melee', 'missile', 'magic'] as const).find((x) => x === mode);
    if (!m) return { ok: false, message: `unknown mode ${mode}` };
    this.host.setCombatMode(m);
    return { ok: true, message: `switching to ${m} mode` };
  }

  turn(toward: number | string): AgentResult {
    const me = this.me();
    if (!me) return { ok: false, message: 'not in world' };
    let deg: number;
    if (typeof toward === 'number') deg = toward;
    else {
      const g = this.need(toward, 'world', 'object');
      if (typeof g !== 'number') return g;
      const o = this.host.object(g);
      if (!o || !o.cell) return { ok: false, message: 'object has no position' };
      deg = bearing(me.g, toGlobal(o.cell, o.x, o.y));
    }
    this.host.setYaw(compassToYaw(deg));
    return { ok: true, message: `facing ${Math.round(normDeg(deg))}°` };
  }

  /**
   * Jump: hold the jump key `holdMs` (longer = higher, as retail's power
   * bar), optionally while running forward (W) and/or walking (Shift), as
   * UtilityBelt's /ub jump[s][w] does.
   */
  jump(opts: { holdMs?: number; forward?: boolean; backward?: boolean; strafeLeft?: boolean; strafeRight?: boolean; walk?: boolean } = {}): AgentResult {
    const hold = Math.max(50, Math.min(opts.holdMs ?? 350, 3000));
    // UB's jump[swzxc]: Shift (walk) and the movement keys held through the jump (the same keys move() presses).
    const keys = [opts.walk && 'ShiftLeft', opts.forward && 'KeyW', opts.backward && 'KeyS', opts.strafeLeft && 'KeyZ', opts.strafeRight && 'KeyC'].filter((k): k is string => !!k);
    for (const k of keys) this.host.key(k, true);
    this.host.key('Space', true);
    setTimeout(() => {
      this.host.key('Space', false);
      setTimeout(() => { for (const k of keys) this.host.key(k, false); }, 400);
    }, hold);
    return { ok: true, message: `jumped${opts.forward ? ' forward' : opts.backward ? ' backward' : ''}${opts.holdMs ? ` (held ${hold} ms)` : ''}` };
  }

  /** Hold (or let go of) a movement key until told otherwise (VTank FastCastBuffs walks back while a buff is cast). */
  holdMove(direction: 'forward' | 'backward', down: boolean): void {
    this.host.key(direction === 'forward' ? 'KeyW' : 'KeyS', down);
  }

  /**
   * UtilityBelt's setmotion: hold (or let go of) one of the motions UB names
   * (Forward, Backward, TurnRight, TurnLeft, StrafeRight, StrafeLeft, Walk;
   * UB Movement.cs) through the client's default movement keys. False for a
   * name UB doesn't know.
   */
  holdMotion(motion: string, down: boolean): boolean {
    const code = MOTION_KEYS[motion.trim().toLowerCase()];
    if (!code) return false;
    this.host.key(code, down);
    return true;
  }

  stopMoving(): AgentResult {
    this.cancelTask('stopped');
    for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'KeyZ', 'KeyC']) this.host.key(k, false);
    return { ok: true, message: 'stopped' };
  }

  move(direction: string, seconds = 1): Promise<AgentResult> {
    const code = ({
      forward: 'KeyW', backward: 'KeyS', back: 'KeyS', strafe_left: 'KeyZ', left: 'KeyZ', strafe_right: 'KeyC', right: 'KeyC', turn_left: 'KeyA', turn_right: 'KeyD',
    } as Record<string, string>)[direction.toLowerCase().replace(/[ -]/g, '_')];
    if (!code) return Promise.resolve({ ok: false, message: `unknown direction ${direction} (forward, backward, left, right, turn_left, turn_right)` });
    this.cancelTask('replaced by move');
    this.host.key(code, true);
    return new Promise((res) => setTimeout(() => { this.host.key(code, false); res({ ok: true, message: `${direction} for ${seconds}s` }); }, Math.min(seconds, 10) * 1000));
  }

  /**
   * Cast through the spell bar's own path, then report what the client and
   * server said. With no target: a self-only spell goes on you; anything
   * else takes the selected creature or player (never a selected item —
   * after `use` on a wand the selection is the wand), else asks for one.
   */
  async cast(spell: number | string, target: TargetArg): Promise<AgentResult> {
    const known = this.host.spells();
    const s = typeof spell === 'number'
      ? known.find((k) => k.id === spell)
      : known.find((k) => k.name.toLowerCase() === spell.toLowerCase()) ?? known.find((k) => k.name.toLowerCase().includes(spell.toLowerCase()));
    if (!s) return { ok: false, message: `you don't know a spell matching "${spell}" (ac_spells lists yours)` };
    let tg: number | null = null;
    if (target === 'self' || target === 'me' || ((target === null || target === undefined) && s.self)) tg = null;
    else if (target !== null && target !== undefined) {
      const g = this.need(target, 'any', 'target');
      if (typeof g !== 'number') return g;
      tg = g;
    } else {
      const sel = this.host.targetGuid();
      const o = sel ? this.host.object(sel) : null;
      const kind = o ? classify(o, this.host.isAttackable(sel!)) : null;
      if (sel && o && kind === 'monster' && this.host.isDying(sel)) return { ok: false, message: `${s.name} not cast: your target ${o.name} is dead (pick another target)` };
      if (sel && (kind === 'monster' || kind === 'npc' || kind === 'player')) tg = sel;
      else return { ok: false, message: `${s.name} needs a target: pass target= (a creature or player), or "self"` };
    }
    // A target that is gone (dead, or out of view) is never swapped for yourself: the client would select you
    // and the server answer "You cannot cast this spell upon yourself" (Lightning Streak II, 2026-10-10).
    const me = this.host.self()?.guid;
    const gone = (g: number): string | null => {
      if (g === me) return null;
      const o = this.host.object(g);
      if (!o) return `${s.name} not cast: target gone (${this.nameOf(g)} is dead or out of view)`;
      if (classify(o, this.host.isAttackable(g)) === 'monster' && this.host.isDying(g)) return `${s.name} not cast: target gone (${o.name} is dead)`;
      return null;
    };
    if (tg) { const why = gone(tg); if (why) return { ok: false, message: why }; }
    // A bolt flies in a straight line and stops at the first wall, and the server says nothing when it does
    // ("You cast …" is all): a player who can't see the wall would cast into it again and again (2026-10-11).
    if (tg && tg !== me && s.projectile) {
      const lof = this.host.lineOfFire?.(tg);
      if (lof && lof.blockedAt !== null) {
        return { ok: false, message: `${s.name} not cast: no line of fire to ${this.nameOf(tg)} (${lof.dist.toFixed(1)} m away): a wall, the ground or an object ${lof.blockedAt.toFixed(1)} m along the line would take the bolt. Move to where the line to it is open (round the corner, into its room, or closer), then cast.` };
      }
    }
    if (tg && tg !== me) this.host.select(tg);
    if (tg) this.watchedTarget = tg;
    // A cast still winding down (the last one's motion, a use) is the client's "You're too busy!": wait it out first.
    for (let w = 0; w < 20 && this.host.busy(); w++) await sleep(200);
    // It may have died while we waited.
    if (tg) { const why = gone(tg); if (why) return { ok: false, message: why }; }
    const since = this.seqN;
    if (!this.host.cast(s.id, tg)) return { ok: false, message: `cast of ${s.name} refused (not castable now)` };
    // Wait for the outcome (cast, fizzle, a refusal) and for the client to be free again, so the next
    // call can cast straight away; the words alone ("You say, …") are not the end of it.
    const said = (): string[] => this.eventsSince(since).filter((e) => e.type === 'chat').map((e) => e.text.replace(/^\(\w+\) /, ''));
    // A war bolt's outcome is its damage line ("You scorch Drudge Skulker for 40 points with Flame Bolt I.": ACE
    // SpellProjectile; no "You cast" for a projectile) or the wall it hit; before 2026-10-11 a bolt that landed was
    // waited on for the full 8 s.
    const outcome = /you cast|fizzle|do not have|don't have|can't|cannot|not enough|unable|refuse|too busy|out of range|resists?|you fail to affect|invalid target|you are not|your spell|\bpoints? with\b|hit the environment|you've earned [\d,]+ experience/i;
    // A killing bolt has no damage line, only one of the many death messages ("Your lightning coruscates over
    // Chick's mortal remains!", "Electricity tears Chick apart!"): the target dying (or gone) is its outcome too.
    // Before this, each kill's last bolt was waited on for 8 s and the next cast went at the corpse-to-be.
    const died = () => !!tg && tg !== me && (this.host.isDying(tg) || !this.host.object(tg));
    for (let w = 0; w < 40 && !((said().some((l) => outcome.test(l)) || died()) && !this.host.busy()); w++) {
      if (w >= 15 && !said().length) break; // no reply at all after 3 s: no wand, wrong mode, …
      await sleep(200);
    }
    const lines = said();
    const head = `casting ${s.name}${tg ? ` at ${this.nameOf(tg)}` : ' on yourself'}`;
    // "Out of Range!" (ACE Player_Magic: farther than the spell's range for you): say how far it reaches, as its
    // examine's Range line does, and how far the target is (Arcanist at 11 m with Creature buffs, 2026-10-11).
    if (tg && tg !== me && s.range && lines.some((l) => /out of range/i.test(l))) {
      const o = this.host.object(tg), m = this.me();
      const d = o && o.cell && m ? Math.hypot(toGlobal(o.cell, o.x, o.y).x - m.g.x, toGlobal(o.cell, o.x, o.y).y - m.g.y) : null;
      lines.push(`(${s.name} reaches ${s.range} m for you, longer as your ${s.school} ranks grow${d !== null ? `; ${this.nameOf(tg)} is ${d.toFixed(1)} m away` : ''})`);
    }
    return lines.length
      // A resist ("X resists your spell": ACE TryResistSpell, the same words on GDLE / 1999) or an immune target
      // didn't take, and ACE's "You don't have all the components" is a refusal: none of them is a landed cast.
      ? { ok: !lines.some((l) => CAST_NOT_LANDED.test(l)), message: [head, ...lines.map((l) => `  ${l}`)].join('\n') }
      : { ok: true, message: `${head} (no reply yet: a wand/orb wielded and magic mode are needed; ac_wait for the result)` };
  }

  pickUp(t: TargetArg): AgentResult {
    const g = this.need(t, 'world', 'item');
    if (typeof g !== 'number') return g;
    return this.host.pickUp(g) ? { ok: true, message: `picking up ${this.nameOf(g)}` } : { ok: false, message: 'pick-up refused (busy, or not reachable)' };
  }

  /**
   * One inventory request (drop, equip …), the way a player makes them: the
   * client allows one at a time (IsPlayerReadyToMakeInventoryRequest: "You
   * can only move or use one item at a time"), so this waits for the one in
   * flight to be answered first, which makes calls made together go out in
   * turn. Then it waits up to `settleMs` for `done()` (the server's answer)
   * and reports what the client and server said; a refusal says why.
   */
  /** `label` says what happened when it worked ("dropped X"); `failed` names it when it didn't ("not dropped: X"). */
  private async inventoryRequest(label: string, failed: string, send: () => boolean, done: () => boolean, settleMs = 4000): Promise<AgentResult> {
    for (let w = 0; w < 50 && this.host.busy(); w++) await sleep(200);
    const since = this.seqN;
    const said = (): string[] => this.eventsSince(since).filter((e) => e.type === 'chat').map((e) => e.text.replace(/^\(\w+\) /, ''));
    if (!send()) {
      const why = said();
      return { ok: false, message: `${failed}: refused${why.length ? ` (${why.join('; ')})` : ''}` };
    }
    for (let w = 0; w < settleMs / 200 && !done() && !said().length; w++) await sleep(200);
    const lines = said();
    if (done()) return { ok: true, message: [label, ...lines.map((l) => `  ${l}`)].join('\n') };
    return lines.length
      ? { ok: false, message: `${failed}: ${lines.join('; ')}` }
      : { ok: true, message: `${label} (no answer from the server yet)` };
  }

  drop(t: TargetArg): Promise<AgentResult> {
    const g = this.need(t, 'inventory', 'item');
    if (typeof g !== 'number') return Promise.resolve(g);
    const name = this.nameOf(g);
    const worn = this.host.inventory().find((i) => i.guid === g)?.where === 'equipped';
    return this.inventoryRequest(`dropped ${name}${worn ? ' (it was worn: taken off and dropped)' : ''}`, `not dropped: ${name}`, () => this.host.drop(g),
      () => !this.host.inventory().some((i) => i.guid === g));
  }

  /** Give an item, after any pending inventory request clears (the client allows one at a time); reports the reply. */
  async give(item: TargetArg, target: TargetArg, amount: number | null): Promise<AgentResult> {
    const i = this.need(item, 'inventory', 'item');
    if (typeof i !== 'number') return i;
    const t = this.need(target, 'world', 'recipient');
    if (typeof t !== 'number') return t;
    const approach = await this.approach(t, 2.5);
    if (approach && !approach.ok) return { ok: false, message: `couldn't reach ${this.nameOf(t)}: ${approach.message}` };
    for (let w = 0; w < 30 && this.host.busy(); w++) await sleep(200);
    const inv = this.host.inventory().find((x) => x.guid === i);
    const n = amount ?? inv?.stack ?? 1;
    const itemName = this.nameOf(i); // before the give: the item leaves the inventory
    const since = this.seqN;
    if (!this.host.give(t, i, n)) return { ok: false, message: 'give refused' };
    for (let w = 0; w < 40 && !this.eventsSince(since).some((e) => e.type === 'chat'); w++) await sleep(200);
    await sleep(800);
    const replies = this.eventsSince(since).filter((e) => e.type === 'chat' || e.type === 'dialog').map((e) => `  ${e.text.replace(/^\(\w+\) /, '')}`);
    return { ok: true, message: [`gave ${n} ${itemName} to ${this.nameOf(t)}`, ...replies].join('\n') };
  }

  equip(t: TargetArg): Promise<AgentResult> {
    const g = this.need(t, 'inventory', 'item');
    if (typeof g !== 'number') return Promise.resolve(g);
    const name = this.nameOf(g);
    if (this.host.inventory().find((i) => i.guid === g)?.where === 'equipped') return Promise.resolve({ ok: true, message: `${name} is already equipped` });
    return this.inventoryRequest(`equipped ${name}`, `not equipped: ${name}`, () => this.host.wield(g),
      () => this.host.inventory().find((i) => i.guid === g)?.where === 'equipped');
  }

  async appraise(t: TargetArg, opts: { quiet?: boolean } = {}): Promise<AgentResult> {
    const g = this.need(t, 'any', 'object');
    if (typeof g !== 'number') return g;
    this.host.appraise(g, opts.quiet);
    for (let i = 0; i < 40; i++) {
      const text = this.host.appraisal(g);
      if (text) return { ok: true, message: text, ...(this.host.appraisalData?.(g) ? { data: this.host.appraisalData(g) } : {}) };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: false, message: `no appraisal reply for ${this.nameOf(g)}` };
  }

  /** Raise a stat `times` times; reports "Name from → to, N XP" (and why it stopped early). */
  /** Kept between a walking body and a portal's reach: the body's radius (0.48 m) and a margin. */
  static readonly PORTAL_CLEARANCE_M = 0.8;
  /**
   * The longest one walk_to search may run while the body stands still, and the most standing-searching
   * time a walk is let off its timeout. A search with jumps simulates flights at each blocked point and can
   * take minutes a few ms a frame: Arcanist stood 4 minutes outside the Holtburg archmage's house, 2026-10-10.
   */
  static readonly SEARCH_WALL_MS = 30_000;
  static readonly SEARCH_CREDIT_MS = 90_000;
  /**
   * The share of each frame a standing search may use (the body isn't moving, so a slower frame costs nothing),
   * between 6 and 25 ms. A fixed 6 ms a frame searched only ~55 points a second in a 10 fps headless window,
   * and the 15 s cap then cut off searches that found the way (Bulwark in Holtburg's south houses, 2026-10-10).
   */
  static readonly SEARCH_FRAME_SHARE = 0.4;

  /** One raise toward `upTo`, with what changed: the routine's train action. */
  raiseOnce(stat: string, upTo: number): { ok: true; name: string; from: number; to: number; cost: number } | { ok: false; message: string; reached: boolean } {
    const r = this.host.raise(stat, upTo);
    if (!r.ok) return { ok: false, message: r.message, reached: !!r.reached };
    return { ok: true, name: String(r.name ?? stat), from: Number(r.from ?? 0), to: Number(r.to ?? 0), cost: Number(r.cost ?? 0) };
  }

  raise(stat: string, times = 1): AgentResult {
    let first: AgentResult | null = null;
    let last: AgentResult | null = null;
    let spent = 0;
    let done = 0;
    let stop = '';
    for (let i = 0; i < Math.max(1, Math.min(times, 50)); i++) {
      const r = this.host.raise(stat);
      if (!r.ok) { stop = r.message; break; }
      first ??= r;
      last = r;
      spent += Number(r.cost ?? 0);
      done++;
    }
    if (!first || !last) return { ok: false, message: stop };
    const head = first.from !== undefined && last.to !== undefined ? `${String(first.name)} ${String(first.from)} → ${String(last.to)}` : `${String(first.name)} raised`;
    const summary = `${head} (${done} raise${done > 1 ? 's' : ''}, ${spent.toLocaleString()} XP)`;
    return { ok: true, message: stop ? `${summary}; stopped: ${stop}` : summary };
  }

  /** Train an untrained skill (Creature Enchantment, Life Magic, …) with skill credits. */
  trainSkill(skill: string): AgentResult {
    const r = this.host.trainSkill(skill);
    return { ok: r.ok, message: r.message };
  }

  /** Press a key binding (action name or key code), as the keyboard would. */
  press(input: string): AgentResult { return this.host.press(input); }

  /** Keymap actions (with their keys) whose name contains `filter`. */
  keys(filter = ''): string {
    const list = this.host.keyBindings(filter);
    return list.length ? list.map((k) => `${k.name}: ${k.keys.join(', ') || '(unbound)'}`).join('\n') : `no keymap action matching "${filter}"`;
  }

  /** The open vendor's merchandise. */
  /** Whether a vendor window is open. */
  vendorOpen(): boolean { return !!this.host.vendor(); }
  /** The open vendor window's merchandise (UtilityBelt's AutoVendor plans from it), or null. */
  vendorData(): AgentVendor | null { return this.host.vendor(); }

  vendorView(): AgentResult {
    const v = this.host.vendor();
    if (!v) return { ok: false, message: 'no vendor window is open (ac_use the vendor first)' };
    return { ok: true, message: [`${v.name} sells (${v.currency}):`, ...v.items.map((i) => `  #${i.guid.toString(16)} ${i.name}  ${i.price}${i.stack && i.stack > 1 ? `  (stack ${i.stack})` : ''}`)].join('\n') };
  }

  buy(item: TargetArg, amount = 1): AgentResult {
    const v = this.host.vendor();
    if (!v) return { ok: false, message: 'no vendor window is open (ac_use the vendor first)' };
    const want = typeof item === 'string' ? item.toLowerCase() : null;
    const it = v.items.find((i) => (want ? i.name.toLowerCase() === want : i.guid === item))
      ?? (want ? v.items.find((i) => i.name.toLowerCase().includes(want)) : undefined);
    if (!it) return { ok: false, message: `${v.name} doesn't sell "${item}"` };
    return this.host.vendorBuy(it.guid, Math.max(1, amount)) ? { ok: true, message: `buying ${amount} ${it.name} (${it.price} each)` } : { ok: false, message: 'buy refused' };
  }

  /**
   * Sell an item as the vendor bar does (onto the sell list, then Sell),
   * after any pending action clears (ACE drops a sell from a busy player
   * without a word). Reports "sold" only once the item has left the pack.
   */
  async sell(item: TargetArg, amount: number | null = null): Promise<AgentResult> {
    if (!this.host.vendor()) return { ok: false, message: 'no vendor window is open (ac_use the vendor first)' };
    const g = this.need(item, 'inventory', 'item');
    if (typeof g !== 'number') return g;
    const inv = this.host.inventory().find((i) => i.guid === g);
    const n = amount ?? inv?.stack ?? 1;
    const name = this.nameOf(g);
    for (let w = 0; w < 30 && this.host.busy(); w++) await sleep(200);
    const since = this.seqN;
    const purse = this.host.self()?.pyreals ?? 0;
    const said = (): string[] => this.eventsSince(since).filter((e) => e.type === 'chat').map((e) => e.text.replace(/^\(\w+\) /, ''));
    if (!this.host.vendorSell(g, n)) return { ok: false, message: `the vendor won't take ${name}${said().length ? `: ${said().join(' ')}` : ''}` };
    // Part of a stack: the split-off stack is sold once it arrives and the original stays, smaller.
    const partial = inv !== undefined && n < (inv.stack ?? 1);
    const sold = (): boolean => (partial ? (this.host.self()?.pyreals ?? 0) > purse : !this.host.inventory().some((i) => i.guid === g));
    for (let w = 0; w < 25 && !sold() && !said().length; w++) await sleep(200);
    await sleep(400);
    const gone = sold();
    const gained = (this.host.self()?.pyreals ?? 0) - purse;
    if (gone) return { ok: true, message: [`sold ${partial ? `${n} of ` : ''}${name}${gained > 0 ? ` for ${gained} pyreals` : ''}`, ...said()].join('\n') };
    return { ok: false, message: [`${name} was not sold`, ...(said().length ? said() : ['(no reply from the server: it may still be busy; try again)'])].join('\n') };
  }

  /** Secure trade: view / add an item / accept / decline / reset / close. Open one with ac_use on the player. */
  trade(action = 'view', item: TargetArg = null): AgentResult {
    const t = this.host.trade();
    if (!t) return { ok: false, message: 'no trade window is open (ac_use another player to open one)' };
    if (action === 'view') {
      return { ok: true, message: `trading with ${t.partner}\n  you offer: ${t.yours.join(', ') || 'nothing'}${t.youAccepted ? '  (accepted)' : ''}\n  they offer: ${t.theirs.join(', ') || 'nothing'}${t.theyAccepted ? '  (accepted)' : ''}` };
    }
    if (action === 'add') {
      const g = this.need(item, 'inventory', 'item');
      if (typeof g !== 'number') return g;
      return this.host.tradeAction('add', g) ? { ok: true, message: `offering ${this.nameOf(g)}` } : { ok: false, message: 'add refused' };
    }
    if (action === 'accept' || action === 'decline' || action === 'reset' || action === 'close') {
      return this.host.tradeAction(action) ? { ok: true, message: `trade: ${action}` } : { ok: false, message: `${action} refused` };
    }
    return { ok: false, message: `unknown trade action ${action}` };
  }

  /** Where the player has been: one point every 0.5 s, newest last (for "what just happened"). */
  traceView(seconds = 30): AgentTracePoint[] {
    const now = this.host.now();
    return this.tracePoints.filter((p) => now - p.t <= seconds * 1000).map(({ t, ...p }) => ({ ...p, ago: Math.round((now - t) / 100) / 10 }));
  }

  /** Press a dialog button ("OK", "Yes", "No", …), as a click on it. */
  /** The open dialogs, oldest first (the macro answers its own craft confirmations). */
  openDialogs(): AgentDialog[] { return this.host.dialogs(); }

  dialog(button: string, index?: number | null): AgentResult {
    const open = this.host.dialogs();
    if (!open.length) return { ok: false, message: 'no dialog is open' };
    return this.host.answerDialog(button, index ?? undefined)
      ? { ok: true, message: `pressed ${button}` }
      : { ok: false, message: `no "${button}" button; open: ${open.map((d) => `[${d.buttons.join('/')}] ${d.text.slice(0, 60)}`).join('; ')}` };
  }

  logout(): AgentResult {
    this.cancelTask('logging out');
    this.host.logout();
    return { ok: true, message: 'logging out' };
  }

  // ── motor tasks (one at a time) ──

  private cancelTask(why: string): void {
    const t = this.task;
    if (!t) return;
    this.task = null;
    t.cancel();
    t.resolve({ ok: false, message: `${t.label}: interrupted (${why})` });
  }

  private startTask(label: string, step: Task['step'], cancel: () => void): Promise<AgentResult> {
    this.cancelTask(`replaced by ${label}`);
    return new Promise((resolve) => {
      this.task = {
        label, step, cancel,
        resolve: (r) => { resolve(r); this.push('task-done', `${label}: ${r.message}`); },
      };
    });
  }

  /**
   * Walk/run to an object, a map coordinate or a global point, steering each
   * tick. Into, out of and between interior cells (buildings, dungeons) it
   * follows the doorway route through the cell graph. Each leg (to the next
   * doorway, or the goal within 60 m) is walked straight when the client's
   * own movement collision says a straight walk arrives (host.navProbe), else
   * along a path found around the walls, door frames and furniture in the way
   * (navPlanner.PathSearch, a few ms per frame). No way in the search's box:
   * a wider search; no way on foot: a search that may jump and drop
   * (AGENT.walk-drops-jumps: ledges, gaps and platforms, flown with the
   * client's own jump physics, no fall harder than half your health). A stall
   * (no 0.3 m of progress in 3 s) re-plans, opens a closed door within 4 m,
   * else backs off and sidesteps; the fifth stall gives up.
   */
  walkTo(target: number | string, opts: { within?: number; timeoutMs?: number; stopWhenAttacked?: boolean } = {}): Promise<AgentResult & { attacked?: boolean }> {
    let within = Math.max(opts.within ?? 2, 0.5);
    const timeoutMs = opts.timeoutMs ?? 60_000;
    let goal: () => { x: number; y: number; z?: number } | null;
    let goalLocal: () => AgentHostObject | null = () => null;
    let label: string;
    let targetGuid = 0;
    const coords = typeof target === 'string' ? parseMapCoords(target) : null;
    if (coords && (coords.x < 0 || coords.y < 0 || coords.x >= 256 * LANDBLOCK_SIZE || coords.y >= 256 * LANDBLOCK_SIZE)) {
      // Arcanist set off for "197.4S, 59.9E", 2026-10-10.
      return Promise.resolve({ ok: false, message: `${target} is off the map: Dereth runs from about 101.9S to 102.9N and 101.9W to 102.9E` });
    }
    const offset = typeof target === 'string' && !coords ? parseOffset(target) : null;
    const meNow = offset ? this.me() : null;
    if (offset && !meNow) return Promise.resolve({ ok: false, message: 'not in the world' });
    if (offset && meNow) {
      // "10m north", "5 m ahead": from where you stand now, by compass or by your facing.
      const b = offset.bearing ?? normDeg(meNow.heading + (offset.turn ?? 0));
      const to = { x: meNow.g.x + offset.dist * Math.sin(b / DEG), y: meNow.g.y + offset.dist * Math.cos(b / DEG) };
      goal = () => to;
      // Indoors the point is in your own building or dungeon (not the landscape a coordinate means): no doorway route out.
      if ((meNow.s.cell & 0xffff) >= 0x100) {
        const cell = meNow.s.cell, o = toGlobal(cell, 0, 0), z = meNow.s.z;
        goalLocal = () => ({ guid: 0, name: String(target), itemType: 0, objectDescFlags: 0, cell, x: to.x - o.x, y: to.y - o.y, z });
      }
      label = `walking ${offset.dist} m ${compassPoint(b)}`;
    } else if (coords) {
      goal = () => coords;
      label = `walking to ${target}`;
    } else {
      const g = this.need(target, 'world', 'object');
      if (typeof g !== 'number') return Promise.resolve(g);
      targetGuid = g;
      const name = this.nameOf(g);
      // Measured from its edge, as ACE measures a Use: the middle of a lifestone or a statue is inside its
      // own collision, so no walk reaches it (a 6000-point search, then doors tried all round, 2026-10-09).
      within += this.host.objectReach?.(g) ?? 0;
      // Out of view, a remembered place is walked to at its last-known position.
      goalLocal = () => this.host.object(g) ?? this.remembered(g);
      // With its floor height: a target in the hall under a walkway is not reached from overhead.
      goal = () => { const o = goalLocal(); return o && o.cell ? { ...toGlobal(o.cell, o.x, o.y), z: o.z } : null; };
      label = `walking to ${name}`;
    }
    const start = this.host.now();
    // Where the body was last tick: a portal (or any teleport) moves it tens of metres or more at once;
    // walking over a landblock's edge outdoors, or out through a building's doorway, never does.
    let lastAt = this.me()?.g ?? null;
    // Being attacked, or losing health, ends the walk (unless the caller fights its way on).
    const sinceSeq = this.seqN;
    const startHealth = this.host.self()?.health.current ?? 0;
    // Time spent standing still searching, and a grace per door opened, don't count against the timeout.
    let credit = 0;
    let searchCredit = 0;
    // The search being run and when it started, for SEARCH_WALL_MS.
    let timed: PathSearch | null = null;
    let timedAt = start;
    let lastTick = start;
    let best = Infinity;
    let bestAt = start;
    let stalls = 0;
    let dodgeUntil = 0;
    let dodgeKey = '';
    let replanAfterDoor = false;
    const doorsTried = new Set<number>();
    // Doors the walk used that stayed shut (locked, or needing a key), global: the doorway route goes round them.
    // Seen at the Holtburg drudge statue's Pedestal Weak Spot opening, whose sill is 2 m over the terrain, 2026-10-11.
    const doorsShut: Array<{ x: number; y: number; z: number }> = [];
    // Floor openings the route fell through that no drop or jump from here reaches (global): the route goes
    // round them. The AC1999 tutorial balcony's 2 m fence is too high below Jump 65 (2026-10-11).
    const dropsFailed: Array<{ x: number; y: number; z: number }> = [];
    // Doors a key from the pack was used on (ACE Key.UseWithTarget unlocks a door whose LockCode it fits).
    const keysTried = new Set<number>();
    let doorUsed: number | null = null;
    // When the walk used it, and the event seq then (its "The door is locked!" reply), for the wait on its answer.
    let doorUsedAt = 0;
    let doorUsedSeq = 0;
    // Doors seen open after the walk used them: they let you through, so a later "stuck" doesn't blame them.
    const doorsOpened = new Set<number>();
    // Uses per door: one that ignored a Use (ACE Door.ActOnUse returns at once while the door is busy swinging) gets one more.
    const doorUses = new Map<number, number>();
    const useDoor = (guid: number, now: number): void => {
      doorsTried.add(guid);
      doorUses.set(guid, (doorUses.get(guid) ?? 0) + 1);
      doorUsedSeq = this.seqN;
      this.host.use(guid);
      doorUsed = guid;
      doorUsedAt = now;
      replanAfterDoor = true;
    };
    const release = (): void => { for (const k of ['KeyW', 'KeyS', 'KeyZ', 'KeyC', 'ShiftLeft', 'Space']) this.host.key(k, false); };
    // Doorway waypoints (global) still ahead of us. `drop`: a floor opening the route falls through, onto `landing`.
    let route: RouteStep[] = [];
    // Collision-checked legs toward the next waypoint (or the goal), and the search finding them. A leg
    // with `jump` is reached by jumping (or dropping) from the leg before it.
    let legs: NavStep[] = [];
    let search: PathSearch | null = null;
    // How far the current leg's search has escalated: 0 the usual box, 1 wider, 2 with jumps and drops.
    let tier = 0;
    // The last search found no way (the probe met walls all round), for the give-up message.
    let noWay = false;
    // A closed door blocks the probe like a wall: with no way found, walk to the untried door nearest
    // the destination, open it and plan again, as a player would.
    let doorDetour: { guid: number; x: number; y: number; wide: boolean } | null = null;
    // The last resort ran: a wide search for the goal itself, the doorway route dropped.
    let directWide = false;
    // The end of the current 35 m stretch toward a far goal; the next stretch is planned on reaching it.
    let stretch: { x: number; y: number } | null = null;
    // Where we were last tick: a slow frame rate moves the body a metre or more between ticks, so a
    // waypoint is measured against the stretch walked since then, not just the point we landed on.
    let prev: { x: number; y: number } | null = null;
    // A jump under way: settling at the take-off, then in the air until `until`.
    let jumping: { spec: JumpSpec; phase: 'settle' | 'air'; until: number } | null = null;
    // What the walk did on the way, for its result.
    const feats: { drops: number[]; jumps: number } = { drops: [], jumps: 0 };
    const featText = (): string => {
      const parts: string[] = [];
      if (feats.drops.length) parts.push(`dropped ${feats.drops.length === 1 ? 'off a ledge' : `off ${feats.drops.length} ledges`} (${feats.drops.map((h) => `${h.toFixed(1)} m`).join(', ')})`);
      if (feats.jumps) parts.push(`jumped ${feats.jumps === 1 ? 'once' : `${feats.jumps} times`} (a gap or a platform)`);
      return parts.length ? `; on the way you ${parts.join(' and ')}` : '';
    };
    const doorPos = (o: AgentObject, me: { g: { x: number; y: number } }): { x: number; y: number } => {
      const b = (o.bearing * Math.PI) / 180;
      return { x: me.g.x + o.dist * Math.sin(b), y: me.g.y + o.dist * Math.cos(b) };
    };
    // Every portal but the destination is kept out of, like a wall (agent/portalAvoid.ts): stepping
    // into one teleports the player, and the collision the probe walks treats it as air.
    const rawProbe = this.host.navProbe?.bind(this.host);
    let portalCache: { at: number; disks: AvoidDisk[] } | null = null;
    const portals = (): AvoidDisk[] => {
      const now = this.host.now();
      if (portalCache && now - portalCache.at < 1000) return portalCache.disks;
      const me = this.me();
      const disks: AvoidDisk[] = [];
      if (me) {
        for (const o of this.host.objects()) {
          if (o.guid === targetGuid || !o.cell || o.wielderId || o.containerId) continue;
          if (classify(o, false) !== 'portal') continue;
          const g = toGlobal(o.cell, o.x, o.y);
          if (Math.hypot(g.x - me.g.x, g.y - me.g.y) > 80) continue;
          disks.push({ x: g.x, y: g.y, z: o.z, r: (this.host.objectReach?.(o.guid) || 1) + AgentApi.PORTAL_CLEARANCE_M });
        }
      }
      portalCache = { at: now, disks };
      return disks;
    };
    const probe = rawProbe ? avoidDisks(rawProbe, portals) : undefined;
    const jumpSearch = (): JumpSearch | null => this.jumpSearch();
    const wideOpts = { spacing: 1, margin: 35, maxNodes: 6000 };
    // The point the current leg heads for: the door to open, the next doorway (the floor under a
    // floor opening the route falls through), or the goal.
    const legAim = (): { x: number; y: number; z?: number; drop?: number } | null => {
      if (doorDetour) return { x: doorDetour.x, y: doorDetour.y };
      const r = route[0];
      if (r) return r.drop !== undefined ? { x: r.x, y: r.y, z: r.landing, drop: r.drop } : r;
      return goal();
    };
    const legWithin = (aim: { drop?: number }): number => (doorDetour ? 1.6 : aim.drop !== undefined ? 3 : route.length ? 0.6 : Math.max(0.6, within - 0.2));
    const startSearch = (from: NavStep, aim: { x: number; y: number; z?: number; drop?: number }, t: number): void => {
      tier = t;
      const jumps = t >= 2 ? jumpSearch() : null;
      const box = t >= 1 || directWide || doorDetour?.wide ? wideOpts : { margin: 12, maxNodes: 4000 };
      search = new PathSearch(probe!, from, aim, { within: legWithin(aim), ...box, ...(jumps ? { jumps } : {}) });
    };
    const planLegs = (): void => {
      legs = [];
      search = null;
      tier = 0;
      const me = this.me();
      const aim = legAim();
      if (!probe || !me || !aim) return;
      const from = { x: me.g.x, y: me.g.y, z: me.s.z };
      let far = Math.hypot(aim.x - from.x, aim.y - from.y);
      if (far <= within && aim.drop === undefined) return;
      if (far > 60) {
        // A far goal: plan the next 35 m toward it (legs end there; the next stretch is planned on arrival).
        const k = 35 / far;
        const mid = { x: from.x + (aim.x - from.x) * k, y: from.y + (aim.y - from.y) * k };
        stretch = mid;
        if (straightWalk(probe, from, mid)) { this.trace(`walk stretch straight 35 m toward a goal ${far.toFixed(0)} m away`); return; }
        this.trace(`walk stretch blocked; searching 35 m toward a goal ${far.toFixed(0)} m away`);
        search = new PathSearch(probe, from, mid, { within: 4, spacing: 1, margin: 20, maxNodes: 6000 });
        return;
      }
      stretch = null;
      if (aim.drop === undefined && straightWalk(probe, from, aim)) { this.trace(`walk leg straight ${far.toFixed(1)} m to (${aim.x.toFixed(1)}, ${aim.y.toFixed(1)}), ${route.length} doorway(s) ahead`); return; }
      if (aim.drop !== undefined) {
        // A floor opening the route goes down through: only a drop gets there.
        if (jumpSearch()) {
          this.trace(`walk leg drops ${aim.drop.toFixed(1)} m through a floor opening at (${aim.x.toFixed(1)}, ${aim.y.toFixed(1)}); searching for the edge to drop from`);
          startSearch(from, aim, 2);
          return;
        }
      }
      // The next doorway on the route has a closed door in it: open it first, as a player does. The archmage's
      // tower door cost three searches (12,000 points) before the door detour, 2026-10-10.
      if (route.length && !doorDetour && aim === route[0]) {
        const shut = this.nearby(12)
          .filter((o) => o.kind === 'door' && !o.open && !doorsTried.has(o.guid))
          .map((o) => ({ o, p: doorPos(o, me) }))
          // Or the doorway just reached: its point can sit beside the door's leaf, so it counts as passed while
          // the door still blocks the leg after it (the AC1999 tutorial key room's locked door, 2026-10-11).
          .find((dd) => Math.hypot(dd.p.x - aim.x, dd.p.y - aim.y) < 2.5 || Math.hypot(dd.p.x - from.x, dd.p.y - from.y) < 1.5);
        if (shut) {
          doorDetour = { guid: shut.o.guid, ...shut.p, wide: false };
          this.trace(`walk: the doorway ahead has a closed door; going to open ${shut.o.name} #${shut.o.guid.toString(16)} first`);
          if (straightWalk(probe, from, doorDetour)) return;
          search = new PathSearch(probe, from, doorDetour, { within: 1.6, margin: 12, maxNodes: 4000 });
          return;
        }
      }
      this.trace(`walk leg blocked straight; searching ${far.toFixed(1)} m to (${aim.x.toFixed(1)}, ${aim.y.toFixed(1)}), ${route.length} doorway(s) ahead`);
      startSearch(from, aim, 0);
    };
    const plan = (): void => {
      const gl = goal();
      route = gl && !directWide ? this.planRoute(gl, goalLocal(), doorsShut, dropsFailed) : [];
      planLegs();
    };
    const legText = (p: NavStep): string => `${p.jump ? (isDrop(p.jump) ? `drop ${(p.jump.from.z - p.z).toFixed(1)} m to ` : 'jump to ') : ''}(${p.x.toFixed(1)}, ${p.y.toFixed(1)}${p.jump ? `, z ${p.z.toFixed(1)}` : ''})`;
    // The keys of a standing long jump: the charge starts with nothing held (CMotionInterp standing_longjump),
    // the forward key (and Shift for a walking jump) goes down during it, and the release launches.
    const leap = (j: JumpSpec): void => {
      const hold = Math.max(120, j.holdMs);
      this.host.key('Space', true);
      setTimeout(() => { if (j.walk) this.host.key('ShiftLeft', true); this.host.key('KeyW', true); }, 60);
      setTimeout(() => this.host.key('Space', false), hold);
      setTimeout(() => { this.host.key('KeyW', false); this.host.key('ShiftLeft', false); }, hold + 150);
    };
    plan();
    return this.startTask(label, (now) => {
      const me = this.me();
      const gl = goal();
      if (!me || !gl) { release(); return { ok: false, message: 'target vanished or not in world' }; }
      const d = Math.hypot(gl.x - me.g.x, gl.y - me.g.y);
      const moved = lastAt ? Math.hypot(me.g.x - lastAt.x, me.g.y - lastAt.y) : 0;
      lastAt = me.g;
      if (moved > PORTAL_JUMP_M && d > 50) {
        release();
        return { ok: true, message: `went through a portal on the way: you're now in ${(me.s.cell & 0xffff) >= 0x100 ? 'an interior' : 'the open'} (cell 0x${(me.s.cell >>> 0).toString(16)}); the target is left behind${featText()}` };
      }
      if (opts.stopWhenAttacked !== false) {
        const hit = this.events.find((e) => e.seq > sinceSeq && e.type === 'attacked');
        const hp = me.s.health;
        const hurt = hp.max > 0 && hp.current < hp.max * 0.5 && hp.current < startHealth - hp.max * 0.1;
        if (hit || hurt) {
          release();
          const why = hit ? `you're under attack (${hit.text})` : `you're losing health (${hp.current}/${hp.max})`;
          return { ok: false, message: `stopped ${d.toFixed(1)} m short: ${why}${featText()}. Fight back (ac_attack / ac_cast), heal, or get away, then walk again.`, attacked: true };
        }
      }
      const dz = gl.z === undefined ? 0 : me.s.z - gl.z;
      if (!jumping && d <= within && Math.abs(dz) < 2.5) { release(); return { ok: true, message: `arrived (${d.toFixed(1)} m away)${featText()}` }; }
      const frameMs = now - lastTick;
      if (jumping) credit += now - lastTick;
      else if (search && searchCredit < AgentApi.SEARCH_CREDIT_MS) { const c = Math.min(now - lastTick, AgentApi.SEARCH_CREDIT_MS - searchCredit); searchCredit += c; credit += c; }
      lastTick = now;
      if (now - start - credit > timeoutMs) { release(); return { ok: false, message: `timed out ${d.toFixed(1)} m short${featText()}` }; }
      if (now < dodgeUntil) return null;
      if (dodgeKey) { this.host.key(dodgeKey, false); dodgeKey = ''; bestAt = now; }
      const here = { x: me.g.x, y: me.g.y, z: me.s.z };
      if (jumping) {
        const j = jumping;
        if (j.phase === 'settle') {
          // Standing at the take-off with no key held: aim the jump from exactly here, face it, leap.
          if (now < j.until) return null;
          const kit = this.jumpKit();
          const spec = (kit && reaimJump(kit, here, j.spec, fallBudget(me.s.health))) ?? j.spec;
          this.host.setYaw(compassToYaw(bearing(me.g, { x: me.g.x + spec.dir.x, y: me.g.y + spec.dir.y })));
          leap(spec);
          this.trace(`walk ${isDrop(spec) ? `drop ${(here.z - spec.to.z).toFixed(1)} m` : 'jump'} from (${here.x.toFixed(1)}, ${here.y.toFixed(1)}, z ${here.z.toFixed(1)}) facing ${Math.round(normDeg(bearing(me.g, { x: me.g.x + spec.dir.x, y: me.g.y + spec.dir.y })))}°, ${spec.walk ? 'walking' : 'running'}, jump key held ${Math.max(120, spec.holdMs)} ms (power ${spec.power.toFixed(2)}); landing (${spec.to.x.toFixed(1)}, ${spec.to.y.toFixed(1)}, z ${spec.to.z.toFixed(1)}) in ${spec.flight.toFixed(1)} s${spec.damage > 0 ? `, about ${Math.round(spec.damage)} fall damage` : ''}`);
          jumping = { spec, phase: 'air', until: now + Math.max(120, spec.holdMs) + spec.flight * 1000 + 700 };
          return null;
        }
        if (now < j.until) return null;
        // Landed (or not where it should have): on with the legs, else plan again from here.
        jumping = null;
        prev = null;
        best = Infinity; bestAt = now;
        const to = j.spec.to;
        if (Math.hypot(to.x - here.x, to.y - here.y) < 1.5 && Math.abs(here.z - to.z) < 1) {
          if (isDrop(j.spec)) feats.drops.push(j.spec.from.z - here.z); else feats.jumps++;
          this.trace(`walk landed at (${here.x.toFixed(1)}, ${here.y.toFixed(1)}, z ${here.z.toFixed(1)})`);
          legs.shift();
          if (!legs.length) { while (route.length && passedRoute(route[0], here)) route.shift(); planLegs(); }
          return null;
        }
        this.trace(`walk jump landed off the plan at (${here.x.toFixed(1)}, ${here.y.toFixed(1)}, z ${here.z.toFixed(1)}), not (${to.x.toFixed(1)}, ${to.y.toFixed(1)}, z ${to.z.toFixed(1)}); planning again`);
        if (here.z < j.spec.from.z - 1) feats.drops.push(j.spec.from.z - here.z);
        plan();
        return null;
      }
      if (replanAfterDoor) {
        const used = doorUsed !== null ? this.host.object(doorUsed) : null;
        const isOpen = !!used && used.physicsState !== undefined && (used.physicsState & PHYSICS_ETHEREAL) !== 0;
        const lockedSaid = this.eventsSince(doorUsedSeq).some((e) => e.type === 'chat' && /is locked/i.test(e.text));
        // Wait for the server's answer before judging the door: the Use first walks you to it (ACE MoveTo), then
        // ActOnUse opens it and the Ethereal state follows. A door judged after a fixed 2 s was often still on its
        // way open, and the walk routed round a door a plain use opened at once (Holtburg tower, 2026-10-11).
        if (used && !isOpen && !lockedSaid && now - doorUsedAt < 8000 && (this.host.busy() || now - doorUsedAt < 3500)) return null;
        replanAfterDoor = false;
        if (used && isOpen) doorsOpened.add(used.guid);
        // A door the Use did not open (ACE Door.ActOnUse: a locked one answers "The door is locked!" and needs
        // its key) is a wall: route round it rather than back to it. One that said nothing may have been busy
        // swinging (ACE ignores a Use then): it gets a second try.
        if (used && used.cell && used.physicsState !== undefined && !isOpen) {
          // The 1999 server says nothing for a locked door, only its sound (ac1999 Door.cpp): a door that stayed
          // shut through two uses is tried with the key too (the AC1999 tutorial's key-room door, 2026-10-11).
          const locked = lockedSaid || (doorUses.get(used.guid) ?? 0) >= 2;
          const key = locked && !keysTried.has(used.guid) ? this.host.inventory().find((i) => /\bkey\b/i.test(i.name)) : undefined;
          if (key) {
            // A player unlocks it with the key from the pack: ACE Door "To unlock door, use the key on the door."
            keysTried.add(used.guid);
            this.host.useWithTarget(key.guid, used.guid);
            this.trace(`walk: ${used.name} #${used.guid.toString(16)} is locked; using ${key.name} on it, then opening it`);
            doorUses.delete(used.guid);
            // Then open it, and wait on its answer again (a Use the server ignores while busy gets a second try).
            useDoor(used.guid, now);
            return null;
          }
          if (!lockedSaid && (doorUses.get(used.guid) ?? 0) < 2) {
            doorsTried.delete(used.guid);
            this.trace(`walk: ${used.name} #${used.guid.toString(16)} did not open yet; trying it again`);
          } else {
            doorsShut.push({ ...toGlobal(used.cell, used.x, used.y), z: used.z });
            this.trace(`walk: ${used.name} #${used.guid.toString(16)} did not open${lockedSaid ? ' (locked)' : ''}; routing round it`);
          }
        }
        doorUsed = null;
        route = this.planRoute(gl, goalLocal(), doorsShut, dropsFailed);
        if (!route.length) directWide = true;
        prev = null;
        planLegs();
        best = Infinity; bestAt = now;
        if (search) return null;
      }
      if (search) {
        // Finding a way round: stand still while the search runs (a few ms a frame).
        this.host.key('KeyW', false);
        this.host.key('ShiftLeft', false);
        const sr = search as PathSearch;
        if (sr !== timed) { timed = sr; timedAt = now; }
        let r = sr.step(Math.min(25, Math.max(6, frameMs * AgentApi.SEARCH_FRAME_SHARE)));
        if (!r && now - timedAt > AgentApi.SEARCH_WALL_MS) {
          r = sr.abandon();
          this.trace(`walk search stopped after ${Math.round((now - timedAt) / 1000)} s standing still`);
        }
        if (!r) return null;
        search = null;
        legs = r.status === 'found' ? r.path : [];
        noWay = r.status === 'none';
        this.trace(`walk search ${r.status} after ${r.expanded} points${legs.length ? `: ${legs.map(legText).join(' ')}` : ''}`);
        if (noWay && probe) {
          const aim = legAim();
          // A fall the route takes that no drop or jump reaches (a rail round the opening higher than your jump
          // clears): route round it, by stairs, ramps and doors, as a player without the Jump for it does.
          if (aim && aim.drop !== undefined && !doorDetour && !directWide && tier >= 2 && route[0]) {
            const r0 = route[0];
            dropsFailed.push({ x: r0.x, y: r0.y, z: r0.z ?? (r0.landing ?? here.z) + (r0.drop ?? 0) });
            route = this.planRoute(gl, goalLocal(), doorsShut, dropsFailed);
            this.trace(`walk: no drop or jump gets down through the opening at (${r0.x.toFixed(1)}, ${r0.y.toFixed(1)}); ${route.length ? `routing round it, ${route.length} doorway(s)` : 'no other doorway route'}`);
            if (route.length) { prev = null; planLegs(); best = Infinity; bestAt = now; return null; }
          }
          // Escalate the leg first: past the search's box (a ramp round the corner), then on with jumps and drops.
          if (aim && !doorDetour && !directWide && tier < 2) {
            if (tier === 0 && r.status === 'none' && r.boxed) {
              this.trace(`walk: no way inside the search box; searching wider`);
              startSearch(here, aim, 1);
              return null;
            }
            if (jumpSearch()) {
              this.trace(`walk: no way on foot; searching with jumps and drops (falls up to ${Math.round(fallBudget(me.s.health))} damage)`);
              startSearch(here, aim, 2);
              return null;
            }
          }
          // Escalate: the nearest closed door (close by, then the wider area round the building), then a
          // wide search straight for the goal that ignores the doorway route (a cell portal can be a
          // window, not a door: the Holtburg blacksmith's service counter, 2026-10-09).
          const jumps = jumpSearch();
          const wide = { ...wideOpts, ...(jumps ? { jumps } : {}) };
          if (doorDetour && !doorDetour.wide) {
            doorDetour = { ...doorDetour, wide: true };
            this.trace(`walk: no way to the door close by; searching wider round to it`);
            search = new PathSearch(probe, here, doorDetour, { within: 1.6, ...wide });
            return null;
          }
          if (doorDetour) { doorsTried.add(doorDetour.guid); doorDetour = null; }
          const aimNow = route[0] ?? gl;
          // Outdoors to outdoors, a building's door opens no way past what's blocking. Only a gate on the way
          // can help (within 6 m of the line to the goal). Otherwise the walk went off into the Holtburg
          // tavern from beside the lifestone, 2026-10-09.
          const goalCell = goalLocal()?.cell ?? 0;
          const outdoors = (me.s.cell & 0xffff) < 0x100 && (goalCell & 0xffff) < 0x100;
          const door = this.nearby(35)
            .filter((o) => o.kind === 'door' && !o.open && !doorsTried.has(o.guid))
            .map((o) => ({ o, p: doorPos(o, me) }))
            .filter((dd) => (outdoors ? segmentDistance(dd.p, me.g, gl) < 6 : doorOnTheWay(dd.p, me.g, aimNow, route)))
            .sort((a, b) => Math.hypot(a.p.x - aimNow.x, a.p.y - aimNow.y) - Math.hypot(b.p.x - aimNow.x, b.p.y - aimNow.y))[0];
          // Every untried door on the way gets its turn: the way on can be past a second or third one (Holtburg
          // Redoubt: the stairs from the walkway to the hall are behind more than one door).
          if (door) {
            doorDetour = { guid: door.o.guid, ...door.p, wide: false };
            this.trace(`walk: no way through; going to open ${door.o.name} #${door.o.guid.toString(16)} at (${door.p.x.toFixed(1)}, ${door.p.y.toFixed(1)})`);
            search = new PathSearch(probe, here, door.p, { within: 1.6, margin: 12, maxNodes: 4000 });
            return null;
          }
          if (!directWide) {
            directWide = true;
            route = [];
            this.trace(`walk: no door on the way helps; searching wide straight for the goal${jumps ? ', jumps and drops included' : ''}`);
            search = new PathSearch(probe, here, gl, { within: Math.max(1, within - 0.2), ...wide });
            return null;
          }
        }
        best = Infinity; bestAt = now;
      }
      // A waypoint is done when we're on it, or when we're near it and a straight walk on to the
      // next point arrives: running past a doorway point a metre off must not turn us back to it
      // (the back-and-forth Jake saw at the Holtburg blacksmith, 2026-10-09).
      const from = prev ?? { x: me.g.x, y: me.g.y };
      const passed = (pt: { x: number; y: number }, next: { x: number; y: number; z?: number } | undefined, onIt: number): boolean => {
        const dd = Math.hypot(pt.x - me.g.x, pt.y - me.g.y);
        if (dd < onIt || segmentDistance(pt, from, me.g) < onIt) return true;
        return dd < 2.5 && !!next && !!probe && straightWalk(probe, here, next);
      };
      // A jump's take-off is reached on it (0.5 m), never passed by a straight walk on: the landing is no walk.
      while (legs.length && !legs[0].jump && passed(legs[0], legs[1]?.jump ? undefined : legs[1] ?? route[0] ?? gl, 0.5)) { legs.shift(); best = Infinity; }
      prev = { x: me.g.x, y: me.g.y };
      if (legs.length && legs[0].jump && Math.hypot(legs[0].jump.from.x - me.g.x, legs[0].jump.from.y - me.g.y) < 0.7) {
        // At the take-off: stop, stand a moment (a standing long jump starts from rest), then jump.
        release();
        jumping = { spec: legs[0].jump, phase: 'settle', until: now + 400 };
        return null;
      }
      if (doorDetour && !legs.length && Math.hypot(doorDetour.x - me.g.x, doorDetour.y - me.g.y) < 2.5) {
        // At the door: open it (the server swings it as a player's Use does), give it a moment, plan again.
        this.host.key('KeyW', false);
        // Plan again once it has swung and the server's walk to it is done: from where that left us, by
        // the doorway route, which now passes doors and never windows. The Use can leave the body in the
        // jamb, off the opening's axis (the Holtburg tavern's west door, 2026-10-09).
        useDoor(doorDetour.guid, now);
        doorDetour = null;
        dodgeUntil = now + 2000;
        stalls = 0;
        credit += 30_000;
        return null;
      }
      // Each stretch plans the doorway route again: a building far off isn't loaded when the walk starts, so a
      // target inside it had no route then and the walk ended up searching at its wall (the archmage, 2026-10-10).
      if (stretch && !legs.length && !search && Math.hypot(stretch.x - me.g.x, stretch.y - me.g.y) < 5) { stretch = null; if (route.length || directWide) planLegs(); else plan(); if (search) return null; }
      let advanced = false;
      // A doorway is passed on it (0.3 m) or once the probe says the next point is a straight walk. Within
      // 0.8 m of it, but off its axis, the jamb still stands between (a 0.96 m body in a 1.5–1.9 m door).
      // A floor opening the route drops through is passed once we're down on its landing.
      while (!legs.length && route.length && (route[0].drop !== undefined ? passedRoute(route[0], here) : passed(route[0], route[1] ?? gl, 0.3))) { route.shift(); best = Infinity; advanced = true; }
      if (advanced) { planLegs(); if (search) return null; }
      const takeoff = legs[0]?.jump ? legs[0].jump.from : null;
      const aim = takeoff ?? legs[0] ?? (doorDetour ? { x: doorDetour.x, y: doorDetour.y } : null) ?? route[0] ?? gl;
      const da = Math.hypot(aim.x - me.g.x, aim.y - me.g.y);
      this.host.setYaw(compassToYaw(bearing(me.g, aim)));
      // The last metres to a jump's take-off at a walk, so the body stops on it.
      const slow = (legs[1]?.jump && da < 3) || (takeoff && da < 3);
      this.host.key('ShiftLeft', !!slow);
      this.host.key('KeyW', true);
      if (da < best - 0.3) { best = da; bestAt = now; return null; }
      if (now - bestAt < 3000) return null;
      // Stalled.
      stalls++;
      {
        const p = probe?.({ x: me.g.x, y: me.g.y, z: me.s.z }, aim);
        const close = this.nearby(2.5).filter((o) => o.kind === 'monster' || o.kind === 'npc' || o.kind === 'player' || o.kind === 'vendor').map((o) => `${o.name} ${o.dist.toFixed(1)} m`);
        this.trace(`walk stall ${stalls} at (${me.g.x.toFixed(1)}, ${me.g.y.toFixed(1)}, z ${me.s.z.toFixed(2)}) cell 0x${(me.s.cell >>> 0).toString(16)} aiming (${aim.x.toFixed(1)}, ${aim.y.toFixed(1)}); probe ends ${p ? `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, z ${p.z.toFixed(2)})` : 'no floor'}; ${legs.length} leg(s), ${route.length} doorway(s)${close.length ? `; beside: ${close.join(', ')}` : ''}`);
      }
      if (stalls > 5) {
        release();
        // Only doors that stayed shut are named as not letting you through: one that opened did its part (a "stuck"
        // blaming a door a plain use opened at once sent Arcanist round the Holtburg tower, 2026-10-11).
        const opened = (g: number): boolean => { const o = this.host.object(g); return doorsOpened.has(g) || (!!o && o.physicsState !== undefined && (o.physicsState & PHYSICS_ETHEREAL) !== 0); };
        const shutNames = [...doorsTried].filter((g) => !opened(g)).map((g) => this.nameOf(g));
        const openNames = [...doorsTried].filter(opened).map((g) => this.nameOf(g));
        const why = [
          noWay ? `no walkable way from here: the game's collision finds walls all round between you and it${jumpSearch() ? ', and no jump or drop your health can take gets past them' : ''}` : 'blocked',
          shutNames.length ? `tried the door${shutNames.length > 1 ? 's' : ''} ${shutNames.join(', ')}, which stayed shut: locked, or it needs a key` : '',
          openNames.length ? `opened ${openNames.join(', ')}, but the way on is still blocked` : '',
          dropsFailed.length ? `the way down through the floor opening${dropsFailed.length > 1 ? 's' : ''} is past a rail higher than your jump clears` : '',
        ].filter(Boolean).join('; ');
        // A locked door and a key lying about (the AC1999 tutorial's key room): a player picks it up and uses it.
        const keyNear = shutNames.length && !this.host.inventory().some((i) => /\bkey\b/i.test(i.name))
          ? this.nearby(40).find((o) => /\bkey\b/i.test(o.name) && (o.kind === 'item' || o.kind === 'other')) : undefined;
        if (keyNear) {
          return { ok: false, message: `stuck ${d.toFixed(1)} m short (${why})${featText()}. A ${keyNear.name} lies ${keyNear.dist.toFixed(0)} m away: pick it up (ac_pick_up) and walk again, and the walk uses it on the locked door.` };
        }
        return { ok: false, message: `stuck ${d.toFixed(1)} m short (${why})${featText()}. ac_map shows the room and its exits; try another route or target.` };
      }
      if (stalls <= 2) { plan(); best = Infinity; bestAt = now; if (search || legs.length || (stalls === 1 && route.length)) return null; }
      const glNow = goal();
      const outdoorsNow = (me.s.cell & 0xffff) < 0x100 && ((goalLocal()?.cell ?? 0) & 0xffff) < 0x100;
      const door = this.nearby(4).find((o) => o.kind === 'door' && !o.open && !doorsTried.has(o.guid)
        && (!outdoorsNow || !glNow || segmentDistance(doorPos(o, me), me.g, glNow) < 6));
      this.host.key('KeyW', false);
      this.host.key('ShiftLeft', false);
      if (door) {
        useDoor(door.guid, now);
        dodgeUntil = now + 2500;
        return null;
      }
      dodgeKey = stalls === 1 ? 'KeyS' : stalls % 2 === 0 ? 'KeyZ' : 'KeyC';
      this.host.key(dodgeKey, true);
      dodgeUntil = now + (stalls >= 3 ? 1600 : 900);
      best = Infinity;
      return null;
    }, release);
  }

  /**
   * Doorway waypoints (global, the goal itself excluded) from where we stand
   * to a goal: `gl` in global metres, `o` its object when there is one (its
   * cell). Empty when a straight line is the route (landscape to landscape,
   * same cell, or no cell route known). A floor opening the route falls
   * through carries the fall (`drop`) and the floor it lands on (`landing`);
   * only falls the player's health takes are routed (with no jump physics to
   * plan the drop, none).
   */
  private planRoute(gl: { x: number; y: number }, o: AgentHostObject | null, closed: Array<{ x: number; y: number; z: number }> = [], avoid: Array<{ x: number; y: number; z: number }> = []): RouteStep[] {
    const s = this.host.self();
    if (!s || !s.cell) return [];
    const interior = (c: number): boolean => (c & 0xffff) >= 0x100;
    const lb = (s.cell & 0xffff0000) >>> 0;
    const origin = toGlobal(lb, 0, 0);
    // The goal in our landblock's frame. An outdoor goal (coordinates, or an object on the
    // landscape or in another landblock) is "outside" (cell index 1) at its offset from our origin.
    let toCell: number, to: { x: number; y: number; z: number };
    if (o && o.cell && (o.cell & 0xffff0000) >>> 0 === lb) { toCell = o.cell; to = { x: o.x, y: o.y, z: o.z }; }
    else if (o && o.cell && interior(o.cell)) return []; // inside a building of another landblock: walk at it
    else { toCell = (lb | 0x0001) >>> 0; to = { x: gl.x - origin.x, y: gl.y - origin.y, z: s.z }; }
    if ((!interior(s.cell) && !interior(toCell)) || s.cell === toCell) return [];
    const maxDrop = this.jumpKit() ? safeDropHeight(fallBudget(s.health)) : 0;
    // Doors a Use did not open, in this landblock's frame.
    const shut = closed.map((c) => ({ x: c.x - origin.x, y: c.y - origin.y, z: c.z }));
    const skip = avoid.map((c) => ({ x: c.x - origin.x, y: c.y - origin.y, z: c.z }));
    const pts = this.host.route(s.cell, { x: s.x, y: s.y, z: s.z }, toCell, to, { maxDrop, ...(shut.length ? { closed: shut } : {}), ...(skip.length ? { avoid: skip } : {}) });
    if (!pts) this.trace(`walk route: no doorway route from cell 0x${(s.cell >>> 0).toString(16)} to cell 0x${(toCell >>> 0).toString(16)}${shut.length ? ` (${shut.length} door(s) that would not open left out)` : ''}`);
    // A doorway is reached at its floor (feet height), not at its centroid halfway up the opening.
    return pts ? pts.slice(0, -1).map((p) => ({
      ...toGlobal(s.cell, p.x, p.y), z: p.feet ?? p.z,
      ...(p.drop !== undefined && p.landing !== undefined ? { drop: p.drop, landing: p.landing } : {}),
    })) : [];
  }

  /**
   * Fight a creature: select it and send one attack request, as the attack
   * button does; the server walks us into range and, with Repeat Attacks,
   * keeps swinging. A new request goes out only after the server has ended
   * the chain (nothing pending for 1.5 s) while the target still lives —
   * re-sending mid-chain restarts the server's approach, which never
   * catches a fleeing target. Resolves at once with "attacking …";
   * `target-died` fires when it is gone. Gives up after 30 s with no hits
   * either way (unreachable), 120 s in all, on death, or when another task
   * starts.
   */
  /** How long swings may report nothing about the target before the next height is tried (several swings). */
  static readonly QUIET_SWING_MS = 6000;
  /** The height that last connected, by creature name (this page's session). */
  static readonly reachHeights = new Map<string, AttackHeightName>();

  /** Close enough that a melee swing is a swing, not the server still closing in. */
  private withinMeleeReach(guid: number): boolean {
    const o = this.host.object(guid);
    const me = this.me();
    if (!o || !o.cell || !me) return false;
    const t = toGlobal(o.cell, o.x, o.y);
    return Math.hypot(t.x - me.g.x, t.y - me.g.y) <= 4;
  }

  /** "\n  note: … is attacking you …, and isn't this target" for monsters hitting you other than `guid`, else "". */
  private otherAttackersNote(guid: number): string {
    const others = [...this.attackersOfMe()].filter(([g]) => g !== guid);
    if (!others.length) return '';
    const list = others.map(([g, n]) => `${this.nameOf(g)} #${g.toString(16)} (${n} attack${n === 1 ? '' : 's'} on you in 10 s)`).join(', ');
    return `\n  note: ${list} ${others.length === 1 ? 'is' : 'are'} attacking you, and ${others.length === 1 ? "isn't" : "aren't"} this target`;
  }

  /**
   * VirindiTank's /vt setattackbar [0 to 1]: the combat bar's power / accuracy
   * slider, where the macro's swings take it with AutoAttackPower off.
   */
  setAttackBar(power: number): AgentResult {
    if (!Number.isFinite(power) || power < 0 || power > 1) return { ok: false, message: 'Syntax: /vt setattackbar [0 to 1]' };
    if (!this.host.setAttackPower) return { ok: false, message: 'this client has no combat bar to set' };
    this.host.setAttackPower(power);
    return { ok: true, message: `Attack bar set to ${Math.round(power * 1000) / 1000}.` };
  }

  /**
   * `power`: the power / accuracy bar for the swings (0..1), or 'bar' for the
   * combat bar's own setting (VirindiTank with AutoAttackPower off). Default 0.6.
   */
  attack(target: TargetArg, opts: { height?: AttackHeightName; power?: number | 'bar' } = {}): AgentResult {
    let g: number | null;
    if (target === null || target === undefined) {
      const tg = this.host.targetGuid();
      // The selection only while it's alive: a just-killed target stays selected, and "attack" means the next one.
      g = tg && this.host.isAttackable(tg) && !this.host.isDying(tg) ? tg : this.nearby(60).find((o) => o.kind === 'monster' && !this.host.isDying(o.guid))?.guid ?? null;
      if (!g) return { ok: false, message: 'no target selected and no monster nearby' };
    } else {
      const r = this.need(target, 'world', 'creature');
      if (typeof r !== 'number') return r;
      g = r;
    }
    if (this.host.isDying(g)) return { ok: false, message: `${this.nameOf(g)} is dead (loot its corpse, or pick another target)` };
    if (!this.host.isAttackable(g)) return { ok: false, message: `${this.nameOf(g)} isn't attackable` };
    const guid = g;
    const name = this.nameOf(guid);
    // The height that connected on this kind of creature before, else the asked-for one, else the combat bar's.
    let height: AttackHeightName = AgentApi.reachHeights.get(name.toLowerCase()) ?? opts.height ?? this.host.attackHeight?.() ?? 'medium';
    const power = Math.min(Math.max((opts.power === 'bar' ? this.host.attackPower?.() : opts.power) ?? 0.6, 0), 1);
    this.host.select(guid);
    this.attackTarget = guid;
    const fight = (): void => {
      const start = this.host.now();
      const startSeq = this.seqN;
      let idleSince: number | null = null;
      let sent = false;
      let lastCombatSeq = this.seqN;
      let lastActivity = start;
      // Swings at this height that report nothing about the target (no hit, no evade): in AC1999 a swing
      // that passes over a short creature is no attack at all, and says nothing (the cone height test).
      let quietSince: number | null = null;
      void this.startTask(`attacking ${name}`, (now) => {
        if (this.host.isDying(guid) || (!this.host.object(guid) && this.dyingSeen.has(guid))) {
          if (this.attackTarget === guid) { this.attackTarget = 0; this.dyingSeen.delete(guid); this.push('target-died', `${name} #${guid.toString(16)} died`, guid); }
          return { ok: true, message: `${name} is dead` };
        }
        if (!this.host.object(guid)) {
          // objectRemoved (tick) decides died vs lost: the death start, a kill line or the corpse.
          return this.killedRecently(name) ? { ok: true, message: `${name} is dead` } : { ok: false, message: `${name} is gone (dead or out of view: see the target-died / target-lost event)` };
        }
        if (this.host.self()?.dead) return { ok: false, message: 'you died' };
        // A kill line naming it is its death, even while the client still shows it (its death start missed).
        if (this.killedRecently(name, startSeq)) {
          this.host.cancelAttack();
          if (this.attackTarget === guid) { this.attackTarget = 0; this.push('target-died', `${name} #${guid.toString(16)} died`, guid); }
          return { ok: true, message: `${name} is dead` };
        }
        // The server ending attack after attack with no swing between: it isn't attacking this target at all.
        const ends = this.attackDones.filter((d) => d.at >= start);
        let empty = 0;
        for (let i = ends.length - 1; i >= 0; i--) {
          const after = ends[i].seq, before = i > 0 ? ends[i - 1].seq : startSeq;
          if (this.events.some((e) => e.seq > before && e.seq <= after && e.type === 'chat' && e.text.startsWith('(combat)'))) break;
          empty++;
        }
        if (empty >= AgentApi.EMPTY_ATTACKS_TO_STOP) {
          this.host.cancelAttack();
          if (this.attackTarget === guid) { this.attackTarget = 0; this.push('target-lost', `${name} #${guid.toString(16)}: the server won't attack it`, guid); }
          return { ok: false, message: `the server ended ${empty} attacks on ${name} at once, with no swing: it is probably dead or gone on the server's side (the client still shows it), or out of reach. Pick another target, or walk_to it if it should be there.` };
        }
        if (now - start > 120_000) { this.host.cancelAttack(); return { ok: false, message: `${name} still alive after 120 s` }; }
        // Any swing either way since the last tick counts as progress.
        const fresh = this.events.filter((e) => e.seq > lastCombatSeq && e.type === 'chat' && e.text.startsWith('(combat)'));
        if (fresh.length) lastActivity = now;
        lastCombatSeq = this.seqN;
        if (fresh.some((e) => swingReached(e.text, name))) { quietSince = null; AgentApi.reachHeights.set(name.toLowerCase(), height); }
        else if (this.host.self()?.combatMode === 'melee' && this.withinMeleeReach(guid)) {
          quietSince ??= now;
          if (now - quietSince >= AgentApi.QUIET_SWING_MS) {
            // As a player does: try the next height on the combat bar (medium → low → high).
            height = height === 'medium' ? 'low' : height === 'low' ? 'high' : 'medium';
            this.host.setAttackHeight?.(height);
            this.host.cancelAttack();
            quietSince = null;
            lastActivity = now; // each height gets its own try before the 20 s give-up
            sent = false;
            this.push('chat', `(system) [Agent] swings at ${name} report nothing: attacking ${height} instead`);
            return null;
          }
        } else quietSince = null;
        if (now - lastActivity > 20_000) { this.host.cancelAttack(); return { ok: false, message: `no swings at ${name} for 20 s (blocked, unreachable or fleeing: walk_to it, or pick another target)` }; }
        if (this.host.attackPending()) { idleSince = null; return null; }
        idleSince ??= now;
        if (!sent || now - idleSince >= 1500) { sent = true; idleSince = null; this.host.attack(guid, power, height); }
        return null;
      // Interrupted by another task: stop watching. A vanished target stays watched for objectRemoved
      // to settle (died vs lost) on the same tick's object diff.
      }, () => { if (this.attackTarget === guid && this.host.object(guid)) this.attackTarget = 0; });
    };
    // Doorways between us, or a long way off: run up first, as a player does. The server's
    // approach is a straight line, and over a long uphill run it can give up (GDL ends the chain
    // with AttackDone and no swing at a drudge 46 m up a slope, 2026-10-07).
    const o = this.host.object(guid);
    const me = this.me();
    const far = !!(o && o.cell && me && Math.hypot(toGlobal(o.cell, o.x, o.y).x - me.g.x, toGlobal(o.cell, o.x, o.y).y - me.g.y) > AgentApi.ATTACK_RUN_UP_M);
    if (o && o.cell && (far || this.planRoute(toGlobal(o.cell, o.x, o.y), o).length)) {
      // Attacked on the way: stop walking and fight (the server's own approach closes the rest).
      void this.walkTo(guid, { within: 2.5, timeoutMs: 90_000 }).then((r) => { if (r.ok || r.attacked) fight(); });
      return { ok: true, message: `running up to ${name} (#${guid.toString(16)}), then attacking; ac_wait types=target-died,target-lost,vitals-low,death,task-done${this.otherAttackersNote(guid)}` };
    }
    fight();
    return { ok: true, message: `attacking ${name} (#${guid.toString(16)}); ac_wait types=target-died,target-lost,vitals-low,death${this.otherAttackersNote(guid)}` };
  }

  /**
   * Loot a corpse or chest: leave combat, Use it (walks over and opens it) unless it is already open to you,
   * then move each item into the main pack, optionally only names matching `match`. One request at a time, as
   * the client allows (IsPlayerReadyToMakeInventoryRequest): each pick waits for the server's answer (the item
   * in your pack, or its refusal) before the next. Resolves with what actually arrived, and what the server
   * refused and why. `decide` (the routine's loot rules) says per item whether to take it, skip it, or wait
   * (while it is examined).
   *
   * A Use of a container you already have open closes it (ACE Container.ActOnUse / Chest.CheckUseRequirements:
   * IsOpen and Viewer == you → Close), and the server then answers every later pick "Source item not found!"
   * (Player.HandleActionPutItemInContainer_Verify finds items only in the container you are viewing). That is
   * how ac_use then ac_loot took one item per pass and claimed them all (Arcanist, Nanto, 2026-10-11).
   */
  loot(container: TargetArg, match: string | null, decide?: (item: { guid: number; name: string; itemType: number; objectDescFlags: number; palettes: ItemPalette[]; uiEffects?: number }) => LootDecision, opts: LootOptions = {}): Promise<AgentResult> {
    let g: number | null;
    if (container === null || container === undefined) {
      const open = this.host.openContainer();
      g = open && this.host.object(open.guid) ? open.guid : this.nearby(40).find((o) => o.kind === 'corpse')?.guid ?? null;
      if (!g) return Promise.resolve({ ok: false, message: 'no corpse nearby' });
    } else {
      const r = this.need(container, 'world', 'corpse or chest');
      if (typeof r !== 'number') return Promise.resolve(r);
      g = r;
    }
    const guid = g;
    const name = this.nameOf(guid);
    let re: RegExp | null = null;
    if (match) { try { re = new RegExp(match, 'i'); } catch { re = new RegExp(match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } }
    const leftCombat = this.host.self()?.combatMode !== 'peace';
    if (leftCombat) this.host.setCombatMode('peace'); // a Use while an attack is in flight is refused
    const start = this.host.now();
    let phase: 'settle' | 'open' | 'take' = 'settle';
    let openedAt = 0;
    let reopens = 0;
    // Items still to try, and the one whose answer we're waiting for.
    let queue: Array<{ guid: number; name: string; uiEffects?: number }> = [];
    let pending: { item: { guid: number; name: string }; at: number; seq: number; units: number; tries: number } | null = null;
    let lastAnswer = 0;
    // Names are resolved when reported, not when listed: on some servers (1999) a container lists its
    // items before their creates land, so the listing says "???" (acjs-ea, 2026-10-07).
    const takenItems: Array<{ guid: number; name: string }> = [];
    const named = (it: { guid: number; name: string }): string => {
      const now = this.host.inventory().find((i) => i.guid === it.guid)?.name ?? this.host.object(it.guid)?.name;
      return now && !/^\?+$/.test(now) ? now : it.name;
    };
    const failed = new Map<number, { item: { guid: number; name: string }; why: string; tries: number }>();
    /** Picks sent per item (a retried item keeps its count). */
    const picks = new Map<number, number>();
    const done = new Set<number>();
    const left: string[] = [];
    /** Everything you carry, counted in units (a stack of 40 pyreals is 40): a merge onto a stack adds no item. */
    const units = (): number => this.host.inventory().reduce((t, i) => t + (i.stack ?? 1), 0);
    const arrived = (p: NonNullable<typeof pending>): boolean => this.host.carriedGuids().has(p.item.guid) || units() > p.units;
    /** What the server said since the pick (the chat lines and notices a player reads), for a refusal's reason. */
    const saidSince = (seq: number): string | null => {
      const lines = [...new Set(this.eventsSince(seq).filter((e) => e.type === 'chat').map((e) => e.text.replace(/^\(\w+\) /, '')).filter((l) => !/^(Approaching|Using the) /.test(l)))];
      return lines.length ? lines.join(' / ') : null;
    };
    const report = (timedOut: boolean): AgentResult => {
      const took = takenItems.map(named);
      const notTaken = [...failed.values()].map((f) => `${named(f.item)} (${f.why})`);
      const untried = queue.filter((i) => !done.has(i.guid) && !failed.has(i.guid)).map(named);
      const parts = [
        timedOut ? `looting timed out; took ${took.length ? took.join(', ') : 'nothing'}` : `took ${took.length}${took.length ? `: ${took.join(', ')}` : ''}`,
        notTaken.length ? `could not take ${notTaken.length}: ${notTaken.join(', ')}` : '',
        untried.length ? `not tried: ${untried.join(', ')}` : '',
        left.length ? `left ${left.length}: ${left.join(', ')}` : '',
      ].filter(Boolean);
      return { ok: took.length > 0 || (!notTaken.length && !timedOut), message: `${parts.join('; ')}${leftCombat ? ' (switched to peace mode to loot)' : ''}` };
    };
    const isOpen = (): boolean => this.host.openContainer()?.guid === guid;
    const openTimeout = opts.openTimeoutMs ?? 20_000;
    const itemTries = Math.max(1, opts.itemTries ?? 2);
    // VTank closes a finished corpse by using it again (ACE Container.ActOnUse: a Use of the container you view
    // closes it; the AC1999 server's the same, Container.cpp "actually a close container request").
    const finish = (r: AgentResult): AgentResult => {
      if (opts.close && isOpen()) this.host.use(guid);
      return r;
    };
    return this.startTask(`looting ${name}`, (now) => {
      if (now - start > 90_000) return finish(report(true));
      if (phase === 'settle') {
        // Already open to you (ac_use opened it): a Use now would close it.
        if (isOpen()) { phase = 'open'; openedAt = now; return null; }
        if (now - start < 1500 || this.host.busy()) return null;
        this.host.use(guid);
        phase = 'open';
        openedAt = now;
        return null;
      }
      if (phase === 'open') {
        const oc = this.host.openContainer();
        if (oc && oc.guid === guid) {
          // Its items can follow the open (CorpseItemAppearanceTimeoutSeconds): an empty listing waits for them.
          if (!oc.items.length && !takenItems.length && now - openedAt < (opts.appearMs ?? 0)) return null;
          const fresh = oc.items.filter((i) => !done.has(i.guid) && (!re || re.test(i.name)));
          // After a re-open, the ones it refused because it had closed get one more try.
          queue = fresh.filter((i) => { const f = failed.get(i.guid); return !f || f.tries < itemTries; });
          for (const i of queue) failed.delete(i.guid);
          if (!queue.length && !takenItems.length && !failed.size && !left.length) {
            return finish({ ok: true, message: oc.items.length ? `${name}: nothing matching /${match}/ (${oc.items.length} items)` : `${name} is empty` });
          }
          phase = 'take';
          return null;
        }
        if (now - openedAt > openTimeout) {
          if (takenItems.length || failed.size) return finish(report(false));
          return { ok: false, message: `${name} never opened (too far, someone else's corpse, or locked)${this.saidNote(start)}` };
        }
        return null;
      }
      // phase 'take'
      if (pending) {
        const p = pending;
        if (arrived(p)) {
          takenItems.push(p.item);
          done.add(p.item.guid);
          pending = null;
          lastAnswer = now;
          return null;
        }
        // Still in flight: the client holds one inventory request at a time until the server answers it.
        if (this.host.busy() && now - p.at < 10_000) return null;
        // Answered, or not, with nothing arrived yet: the item can land a moment after the answer.
        if (now - p.at < 2500) return null;
        const why = saidSince(p.seq) ?? (isOpen() ? 'the server did not move it' : `${name} closed`);
        failed.set(p.item.guid, { item: p.item, why, tries: p.tries });
        pending = null;
        lastAnswer = now;
        return null;
      }
      if (!isOpen()) {
        // It closed under us (out of range, reset, someone else): open it again for what's left, at most twice.
        const remaining = queue.filter((i) => !done.has(i.guid)).length + [...failed.values()].filter((f) => f.tries < itemTries).length;
        if (remaining && reopens < 2 && !this.host.busy()) {
          reopens++;
          this.trace(`loot: ${name} closed with ${remaining} item(s) left; opening it again`);
          this.host.use(guid);
          phase = 'open';
          openedAt = now;
          return null;
        }
        if (remaining && reopens < 2) return null;
        return finish(report(false));
      }
      if (now - lastAnswer < 300 || this.host.busy()) return null;
      // CorpseLootItemMaxAttempts: an item the server didn't move is picked again while it is still in the corpse.
      if (!queue.length && opts.itemTries !== undefined) {
        const inside = new Set(this.host.openContainer()?.items.map((i) => i.guid) ?? []);
        for (const f of [...failed.values()]) if (f.tries < itemTries && inside.has(f.item.guid)) { queue.push(f.item); failed.delete(f.item.guid); }
      }
      const next = queue.shift();
      if (next === undefined) return finish(report(false));
      if (done.has(next.guid)) return null;
      if (decide) {
        const o = this.host.object(next.guid);
        const d = decide({ ...next, itemType: o?.itemType ?? 0, objectDescFlags: o?.objectDescFlags ?? 0, palettes: this.itemPalettes(next.guid), ...((o?.uiEffects ?? next.uiEffects) !== undefined ? { uiEffects: o?.uiEffects ?? next.uiEffects } : {}) });
        if (d === 'wait') { queue.unshift(next); return null; }
        if (d === 'skip') { left.push(named(next)); done.add(next.guid); return null; }
      }
      const tries = Math.max(failed.get(next.guid)?.tries ?? 0, picks.get(next.guid) ?? 0) + 1;
      picks.set(next.guid, tries);
      pending = { item: next, at: now, seq: this.seqN, units: units(), tries };
      if (!this.host.pickUp(next.guid)) {
        // The client refused to send it (its own centre-screen notice says why).
        failed.set(next.guid, { item: next, why: saidSince(pending.seq) ?? 'the client would not send the move', tries });
        pending = null;
      }
      return null;
    }, () => {});
  }

  /** "; the server said: …" for the chat lines since `sinceT` (page ms), or ''. */
  private saidNote(sinceT: number): string {
    const lines = [...new Set(this.events.filter((e) => e.type === 'chat' && e.t >= sinceT).map((e) => e.text.replace(/^\(\w+\) /, '')).filter((l) => !/^(Approaching|Using the) /.test(l)))];
    return lines.length ? `; the server said: ${lines.slice(-3).join(' / ')}` : '';
  }

  /** Wall-clock ms for remembered places (they outlive the page): the host's, else Date.now(). */
  private wallNow(): number { return this.host.wallClock?.() ?? Date.now(); }

  private placesKey(s: AgentHostSelf | null): string | null {
    return s ? `acAgent.places.${s.name}` : null;
  }

  /** Load the character's remembered places once (browser storage; empty when it is unavailable). */
  private notePlaces(s: AgentHostSelf | null): { n: number } {
    const key = this.placesKey(s);
    if (key && this.placesLoadedFor !== key) {
      this.placesLoadedFor = key;
      try {
        const raw = globalThis.localStorage?.getItem(key);
        if (raw) for (const [g, v] of JSON.parse(raw) as Array<[number, PlaceRecord]>) if (!this.places.has(g)) this.places.set(g, v);
      } catch { /* storage blocked: memory only */ }
    }
    return { n: 0 };
  }

  private savePlaces(s: AgentHostSelf | null): void {
    const key = this.placesKey(s);
    if (!key) return;
    try { globalThis.localStorage?.setItem(key, JSON.stringify([...this.places.entries()].slice(-300))); } catch { /* storage blocked */ }
  }

  /**
   * How far off a remembered place is still listed when observe names no radius: about this region (five
   * landblocks). Holtburg's vendors 25 km away read as places "here" while Arcanist stood in Nanto (2026-10-11);
   * walk_to still finds any remembered place by name.
   */
  static readonly REMEMBERED_REGION_M = 1000;

  /**
   * Remembered places not currently in view, nearest first, as AgentObjects (seenAgo set): within `radius` when
   * given (observe's own), else within this region; only those the `filter` matches (name or kind, as nearby).
   */
  rememberedPlaces(opts: { radius?: number; filter?: string; max?: number } = {}): AgentObject[] {
    const me = this.me();
    if (!me) return [];
    const max = opts.max ?? 8;
    const radius = opts.radius ?? AgentApi.REMEMBERED_REGION_M;
    const f = opts.filter?.toLowerCase();
    const wall = this.wallNow();
    const out: AgentObject[] = [];
    const myLb = (me.s.cell & 0xffff0000) >>> 0;
    const outside = (c: number): boolean => (c & 0xffff) < 0x100;
    for (const [guid, p] of this.places) {
      if (this.host.object(guid)) continue;
      // Only places in the same space: our landblock, or the landscape when we're on it (a dungeon's
      // cells sit at made-up landblock coordinates, so a distance from the surface means nothing).
      if ((p.cell & 0xffff0000) >>> 0 !== myLb && !(outside(me.s.cell) && outside(p.cell))) continue;
      const g = toGlobal(p.cell, p.x, p.y);
      if (Math.hypot(g.x - me.g.x, g.y - me.g.y) > radius) continue;
      if (f && !p.name.toLowerCase().includes(f) && p.kind !== f) continue;
      const b = bearing(me.g, g);
      out.push({
        guid, name: p.name, kind: p.kind,
        dist: Math.round(Math.hypot(g.x - me.g.x, g.y - me.g.y) * 10) / 10,
        bearing: Math.round(b), relBearing: Math.round(relDeg(b - me.heading)), dz: Math.round((p.z - me.s.z) * 10) / 10,
        ...(p.at !== undefined ? { seenAgo: Math.max(0, Math.round((wall - p.at) / 1000)) } : {}),
      });
    }
    // One entry per place: respawned NPCs come back with new ids at the same spot.
    const seen = new Set<string>();
    const unique = out.sort((a, b) => (a.seenAgo ?? Infinity) - (b.seenAgo ?? Infinity)).filter((o) => {
      const key = `${o.name}@${Math.round(o.bearing / 10)}:${Math.round(o.dist / 3)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return unique.sort((a, b) => a.dist - b.dist).slice(0, max);
  }

  /** Step the running task and the watchers. main.ts calls this ~10×/s. */
  tick(): void {
    this.routine.tick();
    const now = this.host.now();
    const t = this.task;
    // Death ends whatever you were doing: a walk or use must not carry on after the respawn.
    if (t && this.host.self()?.dead) {
      this.task = null;
      t.cancel();
      t.resolve({ ok: false, message: `${t.label}: you died` });
    } else if (t) {
      let r: AgentResult | null;
      try { r = t.step(now); } catch (e) { r = { ok: false, message: `${t.label}: ${String((e as Error)?.message ?? e)}` }; }
      if (r && this.task === t) {
        this.task = null;
        t.cancel();
        t.resolve(r);
      }
    }
    const s = this.host.self();
    if (s && s.cell && now - this.lastTraceAt >= 500) {
      this.lastTraceAt = now;
      const g = toGlobal(s.cell, s.x, s.y);
      this.tracePoints.push({
        t: now, cell: `0x${(s.cell >>> 0).toString(16).toUpperCase()}`,
        x: Math.round(g.x * 100) / 100, y: Math.round(g.y * 100) / 100, z: Math.round(s.z * 100) / 100,
        heading: Math.round(yawToCompass(s.yaw)), mode: s.combatMode, task: this.task?.label ?? null,
        ...(() => { const b = this.host.cameraBoom(); return b ? { camera: [Math.round(b.min * 100) / 100, Math.round(b.max * 100) / 100] as [number, number] } : {}; })(),
      });
      if (this.tracePoints.length > 240) this.tracePoints.shift();
    }
    if (s) {
      const frac = s.health.max ? s.health.current / s.health.max : 1;
      if (frac < 0.35 && this.lastHealthFrac >= 0.35) this.push('vitals-low', `health ${s.health.current}/${s.health.max}`);
      this.lastHealthFrac = frac;
      if (s.dead && !this.lastDead) { this.push('death', 'you died'); this.cancelTask('you died'); }
      this.lastDead = s.dead;
    }
    for (const g of [this.attackTarget, this.watchedTarget]) if (g && this.host.isDying(g)) this.dyingSeen.add(g);
    // Object arrivals/departures, by diffing the client's object list (no hook into its single-slot callbacks).
    const seen = new Map<number, string>();
    const fresh: AgentHostObject[] = [];
    const placesChanged = this.notePlaces(s);
    for (const o of this.host.objects()) {
      seen.set(o.guid, o.name);
      if (this.known && !this.known.has(o.guid)) fresh.push(o);
      if (s && o.cell && !o.wielderId && !o.containerId) {
        const kind = classify(o, this.host.isAttackable(o.guid));
        if (PLACE_KINDS.has(kind)) {
          const prev = this.places.get(o.guid);
          if (!prev || prev.cell !== o.cell || Math.abs(prev.x - o.x) + Math.abs(prev.y - o.y) > 1) {
            placesChanged.n++;
            // The same NPC under an older id (a respawn, or the ids a server hands out on every login): forget it.
            const lb = (o.cell & 0xffff0000) >>> 0;
            for (const [g, p] of this.places) {
              if (g !== o.guid && p.name === o.name && (p.cell & 0xffff0000) >>> 0 === lb && Math.hypot(p.x - o.x, p.y - o.y) < 3) this.places.delete(g);
            }
          }
          this.places.set(o.guid, { name: o.name, kind, cell: o.cell, x: o.x, y: o.y, z: o.z, at: this.wallNow() });
        }
      }
    }
    if (this.known) {
      const carried = fresh.length ? this.host.carriedGuids() : new Set<number>();
      for (const o of fresh) if (!carried.has(o.guid)) this.objectAdded(o);
      for (const [g, name] of this.known) {
        if (seen.has(g)) continue;
        // A place going out of view: its last-seen time is saved now, so a reload tells its age right.
        if (this.places.has(g)) placesChanged.n++;
        this.objectRemoved(g, name);
      }
    }
    if (placesChanged.n) this.savePlaces(s);
    this.known = seen;
    for (const [g, p] of this.pendingLoss) {
      const corpse = fresh.some((o) => o.name === `Corpse of ${p.name}`) || [...this.host.objects()].some((o) => o.name === `Corpse of ${p.name}` && this.isNearbyNew(o));
      if (corpse || this.killedRecently(p.name)) { this.pendingLoss.delete(g); this.push('target-died', `${p.name} #${g.toString(16)} died`, g); }
      else if (now - p.at > 3000) { this.pendingLoss.delete(g); this.push('target-lost', `${p.name} #${g.toString(16)} went out of view (fled, or you moved away)`, g); }
    }
    const dialogs = this.host.dialogs();
    for (const d of dialogs.slice(this.lastDialogCount)) this.push('dialog', `[${d.buttons.join('/')}] ${d.text}`);
    this.lastDialogCount = dialogs.length;
    const screen = this.host.screen();
    if (screen !== this.lastScreen) {
      if (screen === 'portal-space') this.push('portal', 'entered portal space');
      else if (this.lastScreen === 'portal-space') this.push('portal', 'arrived');
      this.push('screen', screen);
      this.lastScreen = screen;
    }
  }

  /** The JSON-safe method table exposed as window.__acAgent. */
  surface(): Record<string, unknown> {
    return {
      version: this.version,
      observe: (o?: ObserveOptions) => this.observe(o),
      // Who and where you are without reading the chat (observe consumes it): a daemon attached to a player's own tab waits on this.
      self: () => this.self(),
      events: (since?: number) => this.eventsSince(since),
      waitFor: (f?: AgentWaitFilter, ms?: number) => this.waitFor(f, ms),
      // ac_wait: from the player's last look (observe / wait), so nothing that came in since is missed.
      wait: (f?: AgentWaitFilter, ms?: number) => this.wait(f, ms),
      inventory: () => this.inventory(),
      spells: (f?: string, max?: number) => this.spells(f, max),
      characterSheet: () => this.characterSheet(),
      allegiance: async () => { if (this.host.refreshSocial) { this.host.refreshSocial('allegiance'); await sleep(1200); } return this.allegiance(); },
      fellowship: (a?: string, n?: string) => this.fellowship(a, n),
      close: (n?: string) => this.closeWindow(n), // ac_close
      map: (o?: { radius?: number }) => this.map(o),
      // Diagnostics: where the movement probe says your body ends walking from you toward a global point.
      probe: (to: { x: number; y: number }) => { const me = this.me(); return me && this.host.navProbe ? this.host.navProbe({ x: me.g.x, y: me.g.y, z: me.s.z }, to) : null; },
      where: () => { const me = this.me(); return me ? { x: me.g.x, y: me.g.y, z: me.s.z, cell: me.s.cell >>> 0, heading: me.heading } : null; },
      swearAllegiance: (t: TargetArg) => this.swearAllegiance(t),
      breakAllegiance: (n?: string) => this.breakAllegiance(n),
      itemPalettes: (guid: number) => this.itemPalettes(guid),
      say: (t: string) => this.say(t),
      select: (t: TargetArg) => this.select(t),
      use: (t: TargetArg) => this.use(t),
      useOn: (i: TargetArg, t: TargetArg) => this.useOnReported(i, t),
      walkTo: (t: number | string, o?: { within?: number; timeoutMs?: number }) => this.walkTo(t, o),
      turn: (t: number | string) => this.turn(t),
      move: (d: string, s?: number) => this.move(d, s),
      jump: (o?: { holdMs?: number; forward?: boolean; walk?: boolean }) => this.jump(o ?? {}),
      stopMoving: () => this.stopMoving(),
      combatMode: (m: string) => this.combatMode(m),
      attack: (t: TargetArg, o?: { height?: AttackHeightName; power?: number | 'bar' }) => this.attack(t, o),
      cast: (s: number | string, t: TargetArg) => this.cast(s, t),
      pickUp: (t: TargetArg) => this.pickUp(t),
      loot: (c: TargetArg, m: string | null) => this.loot(c, m),
      drop: (t: TargetArg) => this.drop(t),
      give: (i: TargetArg, t: TargetArg, n: number | null) => this.give(i, t, n),
      equip: (t: TargetArg) => this.equip(t),
      appraise: (t: TargetArg) => this.appraise(t),
      raise: (s: string, n?: number) => this.raise(s, n),
      trainSkill: (s: string) => this.trainSkill(s),
      dialog: (b: string, i?: number | null) => this.dialog(b, i),
      press: (k: string) => this.press(k),
      keys: (f?: string) => this.keys(f ?? ''),
      vendor: () => this.vendorView(),
      buy: (i: TargetArg, n?: number | null) => this.buy(i, n ?? 1),
      sell: (i: TargetArg, n?: number | null) => this.sell(i, n ?? null),
      trade: (a?: string | null, i?: TargetArg) => this.trade(a ?? 'view', i ?? null),
      trace: (s?: number | null) => this.traceView(s ?? 30),
      routineStart: (p: RoutineProfile) => this.routine.start(p),
      routinesLoad: (): Promise<RoutineSyncResult> => this.host.accountRoutines?.load() ?? Promise.resolve({ ok: false, message: 'this client has no routines store' }),
      routinesSave: (doc: unknown): Promise<RoutineSyncResult> => this.host.accountRoutines?.save(doc) ?? Promise.resolve({ ok: false, message: 'this client has no routines store' }),
      routineStop: () => this.routine.stop(),
      routinePause: () => this.routine.pause(),
      routineResume: () => this.routine.resume(),
      routineStats: () => this.routine.statsNow(),
      routineStatus: () => this.routine.status(),
      routineDryRun: (p?: RoutineProfile | null) => this.routine.dryRun(p ?? undefined),
      logout: () => this.logout(),
      status: () => this.status(),
      enterWorld: (n: string) => this.enterWorld(n),
      goal: (t: string) => this.setGoal(t),
      screenshot: async () => { const s = (await this.host.screenshot?.()) ?? null; if (!s) throw new Error('no 3D view to capture (not in the world, or in portal space)'); return s; },
      journalLoad: () => this.host.journalLoad?.() ?? null,
      journalSave: (j: unknown) => { if (!this.host.journalSave?.(j)) throw new Error('this browser blocks storage, so the journal can\'t be kept'); return true; },
    };
  }
}

/**
 * `?agent` turns the agent API on, on every build including playwebac.com
 * (Jake, 2026-10-07: "okay with agent tools in prod"). It acts only through
 * the UI's own paths and reads only what the client shows (the no-cheating
 * rule), so it gives a script nothing a player's own clicks don't.
 */
export function agentApiEnabled(search: string): boolean {
  return /[?&]agent(=|&|$)/.test(search);
}

/**
 * The player-facing automation surface (the Automation panel, `/automation`,
 * the HUD strip and [Automation] chat reports) stays where the URL overrides
 * are honored (config/urlOverrides.ts: the Vite dev server, or a
 * VITE_ACJS_URL_OVERRIDES=1 build): Jake, 2026-10-07, "not the command or UI
 * yet" on playwebac.com.
 */
export function automationUiEnabled(urlOverridesAllowed: boolean): boolean {
  return urlOverridesAllowed;
}

/** A combat line saying a swing of ours reached `name`: a hit or graze for points, or its evade. */
export function swingReached(line: string, name: string): boolean {
  const t = line.replace(/^\(combat\)\s*/, '');
  if (!t.toLowerCase().includes(name.toLowerCase())) return false;
  // Ours start "You …" after retail's prefixes (CombatDialog: "Critical hit!", "Sneak Attack!", "Recklessness!"); a line where it hits us ("… bites you for 3 points") is not a reach.
  return /^((critical hit|sneak attack|recklessness)!\s*)*you\b.*\bfor \d+ points?\b/i.test(t) || /evaded your attack/i.test(t) || /^you (killed|slay|destroy)/i.test(t);
}
