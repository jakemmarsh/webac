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
import { PathSearch, floorPlan, straightWalk } from './navPlanner.js';
import { CELL_LENGTH, mapCoordinateText, mapCoordsOfCell } from '../ui/MapMarkers.js';
import type { RoutineProfile } from '@ac/shared';
import { RoutineEngine, type ItemPalette } from './RoutineEngine.ts';
import type { RoutineSyncResult } from './RoutineSync.ts';
import { vtankExprHost, vtankExpressions } from './VtankExprHost.ts';
import type {
  AgentChatKind, AgentChatLine, AgentDialog, AgentEvent, AgentTrade, AgentTracePoint, AgentVendor, AgentItem, AgentObject, AgentObjectKind, AgentObservation,
  AgentResult, AgentScreen, AgentSelf, AgentSpell, AgentWaitFilter,
} from './types.ts';

// ── Host: what main.ts provides ─────────────────────────────────────────

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
  objects(): Iterable<AgentHostObject>;
  object(guid: number): AgentHostObject | null;
  isAttackable(guid: number): boolean;
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
  /** The items in the currently open container (corpse/chest), or null when none is open. */
  openContainer(): { guid: number; items: Array<{ guid: number; name: string }> } | null;
  /** Open dialogs, oldest first. */
  dialogs(): AgentDialog[];
  /** Active enchantments by spell name with seconds left (what the effects UI shows). */
  activeSpells(): Array<{ name: string; remaining: number; beneficial?: boolean }>;
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
  appraise(guid: number): void;
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
  route(fromCell: number, from: { x: number; y: number; z: number }, toCell: number, to: { x: number; y: number; z: number }): Array<{ x: number; y: number; z: number; feet?: number }> | null;
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
  logout(): void;
  /** The account's routines on the bridge (RoutineSync; AGENT.routine-store-auth). */
  accountRoutines?: { load(): Promise<RoutineSyncResult>; save(doc: unknown): Promise<RoutineSyncResult> };
  now(): number;
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

/** ObjectDescriptionFlag bits (packages/shared ace-enums.ts). */
const ODF = { Player: 0x8, Attackable: 0x10, Vendor: 0x200, Door: 0x1000, Corpse: 0x2000, LifeStone: 0x4000, Portal: 0x40000 } as const;
/** ItemType bits (packages/shared game-types.ts). */
/** PhysicsState.Ethereal: ACE Door.Open sets it, Door.Close clears it. */
const PHYSICS_ETHEREAL = 0x4;
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
 * How far a fixture reaches from its origin for walk_to (AgentHost.objectReach): its part-array radius
 * (Setup radius × scale, CPartArray::GetRadius @ 005180a0), the edge a Use is measured to. 0 for a
 * creature (it moves; the server walks you to it) and for no radius. Not the creature blocking radius,
 * which is 0 for every fixture: with that, a walk to the Holtburg lifestone never arrived, 2026-10-09.
 */
export function fixtureReach(o: { itemType?: number; collisionRadius?: number }): number {
  if ((o.itemType ?? 0) & IT.Creature) return 0;
  return o.collisionRadius && o.collisionRadius > 0 ? o.collisionRadius : 0;
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

interface PlaceRecord { name: string; kind: AgentObjectKind; cell: number; x: number; y: number; z: number; t: number }

interface Task {
  label: string;
  /** Returns a result when done, null while running. */
  step(now: number): AgentResult | null;
  cancel(): void;
  resolve: (r: AgentResult) => void;
}

/** A loot filter's answer for one item: take it, leave it, or ask again (it is being examined). */
export type LootDecision = 'take' | 'skip' | 'wait';

export interface ObserveOptions { radius?: number; max?: number; filter?: string }

type TargetArg = number | string | null | undefined;

/** Distance from p to the segment a→b (all in the same plane). */
export function segmentDistance(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export class AgentApi {
  readonly version = 1;
  private seqN = 0;
  private events: AgentEvent[] = [];
  private chatCursor = 0;
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

  /** The newest event's seq (where "since now" starts). */
  currentSeq(): number { return this.seqN; }

  /** The selected target's name, for routines that act "on the target". */
  targetName(): string | null {
    const g = this.host.targetGuid();
    return g ? this.nameOf(g) : null;
  }

  // ── events ──

  push(type: AgentEvent['type'], text: string, guid?: number): void {
    const e: AgentEvent = { seq: ++this.seqN, t: Math.round(this.host.now()), type, text, ...(guid !== undefined ? { guid } : {}) };
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
    this.push('chat', `(${chatKindOf(type, clean)}) ${clean}`);
    // Something attacked you: every incoming swing or spell is a CombatEnemy (0x15) line ("… hits you",
    // "… misses you", "You evaded …"), a 0-damage hit included, so an agent can wait on being attacked
    // instead of on vitals-low.
    if (type === 0x15) this.push('attacked', clean);
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
  private killedRecently(name: string): boolean {
    const since = this.host.now() - 5000;
    const n = name.toLowerCase();
    return this.events.some((e) => e.t >= since && e.type === 'chat' && e.text.toLowerCase().includes(n)
      && /killing blow|you slay|you kill|\bdied\b|is dead|obliterate|torn to ribbons|death/i.test(e.text));
  }

  private matches(e: AgentEvent, f: AgentWaitFilter): boolean {
    // 'attacked' mirrors a combat chat line: a wait on chat text alone gets the line itself.
    if (e.type === 'attacked' && f.chatMatch && !f.types?.includes('attacked')) return false;
    if (f.types?.length && !f.types.includes(e.type) && !(e.type === 'chat' && f.chatMatch)) return false;
    if (f.chatMatch && e.type === 'chat') {
      try { return new RegExp(f.chatMatch, 'i').test(e.text); } catch { return e.text.toLowerCase().includes(f.chatMatch.toLowerCase()); }
    }
    if (f.chatMatch && f.types?.length && !f.types.includes(e.type)) return false;
    if (f.types?.length) return f.types.includes(e.type);
    return true;
  }

  eventsSince(sinceSeq = 0): AgentEvent[] {
    return this.events.filter((e) => e.seq > sinceSeq);
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
    if (s.pyreals !== undefined) out.pyreals = s.pyreals;
    if (s.burden) out.burden = s.burden;
    if (s.xpTotal !== undefined) out.xp = { total: s.xpTotal, unassigned: s.xpUnassigned ?? 0 };
    return out;
  }

  /** An observation that leaves the unread chat for the player's own next observe (routines read it this way). */
  snapshot(opts: ObserveOptions = {}): AgentObservation {
    const cursor = this.chatCursor;
    const obs = this.observe(opts);
    this.chatCursor = cursor;
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
    const chat: AgentChatLine[] = chatEvents.map((e) => {
      const m = /^\((\w+)\) ([\s\S]*)$/.exec(e.text);
      return { seq: e.seq, t: e.t, kind: (m?.[1] ?? 'other') as AgentChatKind, text: m?.[2] ?? e.text };
    });
    return {
      screen: this.host.screen(),
      me: this.self(),
      target: tobj && me ? this.describe(tobj, me) : null,
      nearby: all.slice(0, max),
      nearbyTotal: all.length,
      dialogs: this.host.dialogs(),
      windows: this.host.openWindows?.() ?? [],
      buffs: this.host.activeSpells(),
      buffsMissing: this.missingBuffs(),
      remembered: this.rememberedPlaces(),
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

  /** A guid, or the nearest world object whose name matches (exact, then substring), or an inventory item. */
  resolve(t: TargetArg, where: 'world' | 'inventory' | 'any' = 'any'): number | null {
    if (t === null || t === undefined || t === '') return null;
    if (typeof t === 'number') return t >>> 0;
    const name = t.trim().toLowerCase();
    if (name === 'self' || name === 'me') return this.host.self()?.guid ?? null;
    if (where !== 'world') {
      const inv = this.host.inventory();
      const hit = inv.find((i) => i.name.toLowerCase() === name) ?? inv.find((i) => i.name.toLowerCase().includes(name));
      if (hit) return hit.guid;
    }
    if (where !== 'inventory') {
      const near = this.nearby(200);
      const hit = near.find((o) => o.name.toLowerCase() === name) ?? near.find((o) => o.name.toLowerCase().includes(name));
      if (hit) return hit.guid;
      const places = [...this.places.entries()];
      const p = places.find(([, v]) => v.name.toLowerCase() === name) ?? places.find(([, v]) => v.name.toLowerCase().includes(name));
      if (p) return p[0];
    }
    return null;
  }

  private need(t: TargetArg, where: 'world' | 'inventory' | 'any', what: string): number | AgentResult {
    const g = this.resolve(t, where);
    if (g === null) return { ok: false, message: `no ${what} matching "${t}"${where !== 'inventory' ? ' nearby' : ' in inventory'}` };
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
    const approach = await this.approach(g, 2.5);
    if (approach && !approach.ok) return { ok: false, message: `couldn't reach ${name}: ${approach.message}` };
    const since = this.seqN;
    this.host.select(g);
    if (!this.host.use(g)) return { ok: false, message: `can't use #${g.toString(16)} (not known to the client)` };
    const reacted = (): string | null => {
      if (this.host.vendor()) return 'vendor window open (ac_vendor lists it)';
      if (this.host.openContainer()?.guid === g) return 'container open (ac_loot takes from it)';
      if (this.host.trade()) return `trade window open with ${this.host.trade()!.partner} (ac_trade)`;
      return null;
    };
    const lines = (): string[] => this.eventsSince(since)
      .filter((e) => (e.type === 'chat' && !/^\(\w+\) (Approaching|Using the) /.test(e.text)) || e.type === 'dialog' || e.type === 'portal')
      .map((e) => (e.type === 'chat' ? e.text.replace(/^\(\w+\) /, '') : `${e.type}: ${e.text}`));
    // Up to 10 s for a first reaction, then 1.2 s more for the rest of it (multi-line replies).
    let settle = -1;
    for (let i = 0; i < 50 && settle !== 0; i++) {
      if (settle < 0 && (lines().length || reacted())) settle = 6;
      if (settle > 0) settle--;
      await sleep(200);
    }
    const out = lines();
    const extra = reacted();
    if (!out.length && !extra) return { ok: true, message: `used ${name}; no reply within 10 s (it may need you closer, or simply does nothing)` };
    return { ok: true, message: [`used ${name}:`, ...out.map((l) => `  ${l}`), ...(extra ? [`  ${extra}`] : [])].join('\n') };
  }

  /**
   * When doorways separate us from `guid`, walk the cell route to within
   * `within` m and return how that went; null when a straight line is fine
   * (the server's own MoveTo handles the last stretch).
   */
  private async approach(guid: number, within: number): Promise<AgentResult | null> {
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
      return { x: me.g.x + o.dist * Math.sin(b), y: me.g.y + o.dist * Math.cos(b), ch: letters[i], label: `${o.name} [${o.kind}] #${o.guid.toString(16)}` };
    });
    const plan = floorPlan(probe, { x: me.g.x, y: me.g.y, z: me.s.z }, marks, { radius, spacing: 1, maxProbes: 6000 });
    return {
      ok: true,
      message: [
        `map ${2 * radius + 1} m square around you, north up, 1 character = 1 m: @ you, . floor you can walk to from here, : reachable floor over 1 m up/down, # wall, drop or out of reach`,
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
  jump(opts: { holdMs?: number; forward?: boolean; walk?: boolean } = {}): AgentResult {
    const hold = Math.max(50, Math.min(opts.holdMs ?? 350, 3000));
    if (opts.walk) this.host.key('ShiftLeft', true);
    if (opts.forward) this.host.key('KeyW', true);
    this.host.key('Space', true);
    setTimeout(() => {
      this.host.key('Space', false);
      setTimeout(() => { if (opts.forward) this.host.key('KeyW', false); if (opts.walk) this.host.key('ShiftLeft', false); }, 400);
    }, hold);
    return { ok: true, message: `jumped${opts.forward ? ' forward' : ''}${opts.holdMs ? ` (held ${hold} ms)` : ''}` };
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
      if (sel && (kind === 'monster' || kind === 'npc' || kind === 'player')) tg = sel;
      else return { ok: false, message: `${s.name} needs a target: pass target= (a creature or player), or "self"` };
    }
    if (tg && tg !== this.host.self()?.guid) this.host.select(tg);
    if (tg) this.watchedTarget = tg;
    // A cast still winding down (the last one's motion, a use) is the client's "You're too busy!": wait it out first.
    for (let w = 0; w < 20 && this.host.busy(); w++) await sleep(200);
    const since = this.seqN;
    if (!this.host.cast(s.id, tg)) return { ok: false, message: `cast of ${s.name} refused (not castable now)` };
    // Wait for the outcome (cast, fizzle, a refusal) and for the client to be free again, so the next
    // call can cast straight away; the words alone ("You say, …") are not the end of it.
    const said = (): string[] => this.eventsSince(since).filter((e) => e.type === 'chat').map((e) => e.text.replace(/^\(\w+\) /, ''));
    const outcome = /you cast|fizzle|do not have|can't|cannot|not enough|unable|refuse|too busy|out of range|resists?|you are not|your spell/i;
    for (let w = 0; w < 40 && !(said().some((l) => outcome.test(l)) && !this.host.busy()); w++) {
      if (w >= 15 && !said().length) break; // no reply at all after 3 s: no wand, wrong mode, …
      await sleep(200);
    }
    const lines = said();
    const head = `casting ${s.name}${tg ? ` at ${this.nameOf(tg)}` : ' on yourself'}`;
    return lines.length
      ? { ok: !lines.some((l) => /do not have|can't|cannot|not enough|fizzle|unable|refuse|too busy/i.test(l)), message: [head, ...lines.map((l) => `  ${l}`)].join('\n') }
      : { ok: true, message: `${head} (no reply yet: a wand/orb wielded and magic mode are needed; ac_wait for the result)` };
  }

  pickUp(t: TargetArg): AgentResult {
    const g = this.need(t, 'world', 'item');
    if (typeof g !== 'number') return g;
    return this.host.pickUp(g) ? { ok: true, message: `picking up ${this.nameOf(g)}` } : { ok: false, message: 'pick-up refused (busy, or not reachable)' };
  }

  drop(t: TargetArg): AgentResult {
    const g = this.need(t, 'inventory', 'item');
    if (typeof g !== 'number') return g;
    return this.host.drop(g) ? { ok: true, message: `dropping ${this.nameOf(g)}` } : { ok: false, message: 'drop refused' };
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

  equip(t: TargetArg): AgentResult {
    const g = this.need(t, 'inventory', 'item');
    if (typeof g !== 'number') return g;
    return this.host.wield(g) ? { ok: true, message: `equipping ${this.nameOf(g)}` } : { ok: false, message: `can't equip ${this.nameOf(g)}` };
  }

  async appraise(t: TargetArg): Promise<AgentResult> {
    const g = this.need(t, 'any', 'object');
    if (typeof g !== 'number') return g;
    this.host.appraise(g);
    for (let i = 0; i < 40; i++) {
      const text = this.host.appraisal(g);
      if (text) return { ok: true, message: text, ...(this.host.appraisalData?.(g) ? { data: this.host.appraisalData(g) } : {}) };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ok: false, message: `no appraisal reply for ${this.nameOf(g)}` };
  }

  /** Raise a stat `times` times; reports "Name from → to, N XP" (and why it stopped early). */
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
   * (navPlanner.PathSearch, a few ms per frame). A stall (no 0.3 m of progress
   * in 3 s) re-plans, opens a closed door within 4 m, else backs off and
   * sidesteps; the fifth stall gives up.
   */
  walkTo(target: number | string, opts: { within?: number; timeoutMs?: number } = {}): Promise<AgentResult> {
    let within = Math.max(opts.within ?? 2, 0.5);
    const timeoutMs = opts.timeoutMs ?? 60_000;
    let goal: () => { x: number; y: number; z?: number } | null;
    let goalLocal: () => AgentHostObject | null = () => null;
    let label: string;
    const coords = typeof target === 'string' ? parseMapCoords(target) : null;
    if (coords) {
      goal = () => coords;
      label = `walking to ${target}`;
    } else {
      const g = this.need(target, 'world', 'object');
      if (typeof g !== 'number') return Promise.resolve(g);
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
    // The landblock we set out in: walking into a portal moves us to another, and the walk ends there.
    const startBlock = (this.host.self()?.cell ?? 0) >>> 16;
    // Time spent standing still searching, and a grace per door opened, don't count against the timeout.
    let credit = 0;
    let lastTick = start;
    let best = Infinity;
    let bestAt = start;
    let stalls = 0;
    let dodgeUntil = 0;
    let dodgeKey = '';
    let replanAfterDoor = false;
    const doorsTried = new Set<number>();
    const release = (): void => { for (const k of ['KeyW', 'KeyS', 'KeyZ', 'KeyC']) this.host.key(k, false); };
    // Doorway waypoints (global) still ahead of us.
    let route: Array<{ x: number; y: number; z?: number }> = [];
    // Collision-checked legs toward the next waypoint (or the goal), and the search finding them.
    let legs: Array<{ x: number; y: number }> = [];
    let search: PathSearch | null = null;
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
    const doorPos = (o: AgentObject, me: { g: { x: number; y: number } }): { x: number; y: number } => {
      const b = (o.bearing * Math.PI) / 180;
      return { x: me.g.x + o.dist * Math.sin(b), y: me.g.y + o.dist * Math.cos(b) };
    };
    const probe = this.host.navProbe?.bind(this.host);
    const planLegs = (): void => {
      legs = [];
      search = null;
      const me = this.me();
      const aim = doorDetour ? { x: doorDetour.x, y: doorDetour.y } : route[0] ?? goal();
      if (!probe || !me || !aim) return;
      const from = { x: me.g.x, y: me.g.y, z: me.s.z };
      let far = Math.hypot(aim.x - from.x, aim.y - from.y);
      if (far <= within) return;
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
      if (straightWalk(probe, from, aim)) { this.trace(`walk leg straight ${far.toFixed(1)} m to (${aim.x.toFixed(1)}, ${aim.y.toFixed(1)}), ${route.length} doorway(s) ahead`); return; }
      this.trace(`walk leg blocked straight; searching ${far.toFixed(1)} m to (${aim.x.toFixed(1)}, ${aim.y.toFixed(1)}), ${route.length} doorway(s) ahead`);
      search = new PathSearch(probe, from, aim, { within: doorDetour ? 1.6 : route.length ? 0.6 : Math.max(0.6, within - 0.2), ...(directWide || doorDetour?.wide ? { spacing: 1, margin: 35, maxNodes: 6000 } : { margin: 12, maxNodes: 4000 }) });
    };
    const plan = (): void => {
      const gl = goal();
      route = gl && !directWide ? this.planRoute(gl, goalLocal()) : [];
      planLegs();
    };
    plan();
    return this.startTask(label, (now) => {
      const me = this.me();
      const gl = goal();
      if (!me || !gl) { release(); return { ok: false, message: 'target vanished or not in world' }; }
      const d = Math.hypot(gl.x - me.g.x, gl.y - me.g.y);
      if (startBlock && (me.s.cell >>> 16) !== startBlock && d > 300) {
        release();
        return { ok: true, message: `went through a portal on the way: you're now in ${me.s.cell >= 0x100 && (me.s.cell & 0xffff) >= 0x100 ? 'an interior' : 'the open'} (cell 0x${(me.s.cell >>> 0).toString(16)}); the target is left behind` };
      }
      const dz = gl.z === undefined ? 0 : me.s.z - gl.z;
      if (d <= within && Math.abs(dz) < 2.5) { release(); return { ok: true, message: `arrived (${d.toFixed(1)} m away)` }; }
      if (search) credit += now - lastTick;
      lastTick = now;
      if (now - start - credit > timeoutMs) { release(); return { ok: false, message: `timed out ${d.toFixed(1)} m short` }; }
      if (now < dodgeUntil) return null;
      if (dodgeKey) { this.host.key(dodgeKey, false); dodgeKey = ''; bestAt = now; }
      if (replanAfterDoor) {
        replanAfterDoor = false;
        route = this.planRoute(gl, goalLocal());
        if (!route.length) directWide = true;
        prev = null;
        planLegs();
        best = Infinity; bestAt = now;
        if (search) return null;
      }
      if (search) {
        // Finding a way round: stand still while the search runs (a few ms a frame).
        this.host.key('KeyW', false);
        const r = (search as PathSearch).step(6);
        if (!r) return null;
        search = null;
        legs = r.status === 'found' ? r.path.map((p) => ({ x: p.x, y: p.y })) : [];
        noWay = r.status === 'none';
        this.trace(`walk search ${r.status} after ${r.expanded} points${legs.length ? `: ${legs.map((p) => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)})`).join(' ')}` : ''}`);
        if (noWay && probe) {
          // Escalate: the nearest closed door (close by, then the wider area round the building), then a
          // wide search straight for the goal that ignores the doorway route (a cell portal can be a
          // window, not a door: the Holtburg blacksmith's service counter, 2026-10-09).
          const here = { x: me.g.x, y: me.g.y, z: me.s.z };
          const wide = { spacing: 1, margin: 35, maxNodes: 6000 };
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
            .filter((d) => !outdoors || segmentDistance(d.p, me.g, gl) < 6)
            .sort((a, b) => Math.hypot(a.p.x - aimNow.x, a.p.y - aimNow.y) - Math.hypot(b.p.x - aimNow.x, b.p.y - aimNow.y))[0];
          // Every untried door gets its turn: the way on can be past a second or third one (Holtburg
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
            this.trace(`walk: no door helps; searching wide straight for the goal`);
            search = new PathSearch(probe, here, gl, { within: Math.max(1, within - 0.2), ...wide });
            return null;
          }
        }
        best = Infinity; bestAt = now;
      }
      // A waypoint is done when we're on it, or when we're near it and a straight walk on to the
      // next point arrives: running past a doorway point a metre off must not turn us back to it
      // (the back-and-forth Jake saw at the Holtburg blacksmith, 2026-10-09).
      const here = { x: me.g.x, y: me.g.y, z: me.s.z };
      const from = prev ?? { x: me.g.x, y: me.g.y };
      const passed = (pt: { x: number; y: number }, next: { x: number; y: number } | undefined, onIt: number): boolean => {
        const d = Math.hypot(pt.x - me.g.x, pt.y - me.g.y);
        if (d < onIt || segmentDistance(pt, from, me.g) < onIt) return true;
        return d < 2.5 && !!next && !!probe && straightWalk(probe, here, next);
      };
      while (legs.length && passed(legs[0], legs[1] ?? route[0] ?? gl, 0.5)) { legs.shift(); best = Infinity; }
      prev = { x: me.g.x, y: me.g.y };
      if (doorDetour && !legs.length && Math.hypot(doorDetour.x - me.g.x, doorDetour.y - me.g.y) < 2.5) {
        // At the door: open it (the server swings it as a player's Use does), give it a moment, plan again.
        this.host.key('KeyW', false);
        doorsTried.add(doorDetour.guid);
        this.host.use(doorDetour.guid);
        doorDetour = null;
        dodgeUntil = now + 2000;
        stalls = 0;
        credit += 30_000;
        // Plan again once it has swung and the server's walk to it is done: from where that left us, by
        // the doorway route, which now passes doors and never windows. The Use can leave the body in the
        // jamb, off the opening's axis (the Holtburg tavern's west door, 2026-10-09).
        replanAfterDoor = true;
        return null;
      }
      if (stretch && !legs.length && !search && Math.hypot(stretch.x - me.g.x, stretch.y - me.g.y) < 5) { stretch = null; planLegs(); if (search) return null; }
      let advanced = false;
      // A doorway is passed on it (0.3 m) or once the probe says the next point is a straight walk. Within
      // 0.8 m of it, but off its axis, the jamb still stands between (a 0.96 m body in a 1.5–1.9 m door).
      while (!legs.length && route.length && passed(route[0], route[1] ?? gl, 0.3)) { route.shift(); best = Infinity; advanced = true; }
      if (advanced) { planLegs(); if (search) return null; }
      const aim = legs[0] ?? (doorDetour ? { x: doorDetour.x, y: doorDetour.y } : null) ?? route[0] ?? gl;
      const da = Math.hypot(aim.x - me.g.x, aim.y - me.g.y);
      this.host.setYaw(compassToYaw(bearing(me.g, aim)));
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
        const doors = [...doorsTried].map((g) => this.nameOf(g));
        const why = [
          noWay ? 'no walkable way from here: the game\'s collision finds walls all round between you and it' : 'blocked',
          doors.length ? `tried the door${doors.length > 1 ? 's' : ''} ${doors.join(', ')}, which did not let you through (locked, or opened by something else)` : '',
        ].filter(Boolean).join('; ');
        return { ok: false, message: `stuck ${d.toFixed(1)} m short (${why}). ac_map shows the room and its exits; try another route or target.` };
      }
      if (stalls <= 2) { plan(); best = Infinity; bestAt = now; if (search || legs.length || (stalls === 1 && route.length)) return null; }
      const glNow = goal();
      const outdoorsNow = (me.s.cell & 0xffff) < 0x100 && ((goalLocal()?.cell ?? 0) & 0xffff) < 0x100;
      const door = this.nearby(4).find((o) => o.kind === 'door' && !o.open && !doorsTried.has(o.guid)
        && (!outdoorsNow || !glNow || segmentDistance(doorPos(o, me), me.g, glNow) < 6));
      this.host.key('KeyW', false);
      if (door) {
        doorsTried.add(door.guid);
        this.host.use(door.guid);
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
   * same cell, or no cell route known).
   */
  private planRoute(gl: { x: number; y: number }, o: AgentHostObject | null): Array<{ x: number; y: number; z?: number }> {
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
    const pts = this.host.route(s.cell, { x: s.x, y: s.y, z: s.z }, toCell, to);
    // A doorway is reached at its floor (feet height), not at its centroid halfway up the opening.
    return pts ? pts.slice(0, -1).map((p) => ({ ...toGlobal(s.cell, p.x, p.y), z: p.feet ?? p.z })) : [];
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
  attack(target: TargetArg, opts: { height?: AttackHeightName; power?: number } = {}): AgentResult {
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
    const height = opts.height ?? 'medium';
    const power = Math.min(Math.max(opts.power ?? 0.6, 0), 1);
    this.host.select(guid);
    this.attackTarget = guid;
    const fight = (): void => {
      const start = this.host.now();
      let idleSince: number | null = null;
      let sent = false;
      let lastCombatSeq = this.seqN;
      let lastActivity = start;
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
        if (now - start > 120_000) { this.host.cancelAttack(); return { ok: false, message: `${name} still alive after 120 s` }; }
        // Any swing either way since the last tick counts as progress.
        if (this.events.some((e) => e.seq > lastCombatSeq && e.type === 'chat' && e.text.startsWith('(combat)'))) lastActivity = now;
        lastCombatSeq = this.seqN;
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
      void this.walkTo(guid, { within: 2.5, timeoutMs: 90_000 }).then((r) => { if (r.ok) fight(); });
      return { ok: true, message: `running up to ${name} (#${guid.toString(16)}), then attacking; ac_wait types=target-died,target-lost,vitals-low,death,task-done` };
    }
    fight();
    return { ok: true, message: `attacking ${name} (#${guid.toString(16)}); ac_wait types=target-died,target-lost,vitals-low,death` };
  }

  /**
   * Loot a corpse or chest: leave combat, Use it (walks over and opens it),
   * then move each item into the main pack, optionally only names matching
   * `match`. Resolves with what was taken. `decide` (the routine's loot rules)
   * says per item whether to take it, skip it, or wait (while it is examined).
   */
  loot(container: TargetArg, match: string | null, decide?: (item: { guid: number; name: string; itemType: number; objectDescFlags: number; palettes: ItemPalette[] }) => LootDecision): Promise<AgentResult> {
    let g: number | null;
    if (container === null || container === undefined) {
      g = this.nearby(40).find((o) => o.kind === 'corpse')?.guid ?? null;
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
    let queue: Array<{ guid: number; name: string }> = [];
    let lastPick = 0;
    // Names are resolved when reported, not when listed: on some servers (1999) a container lists its
    // items before their creates land, so the listing says "???" (acjs-ea, 2026-10-07).
    const takenItems: Array<{ guid: number; name: string }> = [];
    const named = (it: { guid: number; name: string }): string => {
      const now = this.host.inventory().find((i) => i.guid === it.guid)?.name ?? this.host.object(it.guid)?.name;
      return now && !/^\?+$/.test(now) ? now : it.name;
    };
    const taken = { get length() { return takenItems.length; }, join: (sep: string) => takenItems.map(named).join(sep) };
    const left: string[] = [];
    const leftNote = (): string => (left.length ? `; left ${left.length}: ${left.join(', ')}` : '');
    return this.startTask(`looting ${name}`, (now) => {
      if (now - start > 60_000) return { ok: taken.length > 0, message: `looting timed out; took ${taken.length ? taken.join(', ') : 'nothing'}${leftNote()}` };
      if (phase === 'settle') {
        if (now - start < 1500 || this.host.busy()) return null;
        this.host.use(guid);
        phase = 'open';
        openedAt = now;
        return null;
      }
      if (phase === 'open') {
        const oc = this.host.openContainer();
        if (oc && oc.guid === guid) {
          queue = oc.items.filter((i) => !re || re.test(i.name));
          if (!queue.length) return { ok: true, message: oc.items.length ? `${name}: nothing matching /${match}/ (${oc.items.length} items)` : `${name} is empty` };
          phase = 'take';
          return null;
        }
        if (now - openedAt > 20_000) return { ok: false, message: `${name} never opened (too far, someone else's corpse, or locked)` };
        return null;
      }
      if (now - lastPick < 900 || this.host.busy()) return null;
      const next = queue.shift();
      if (next === undefined) {
        // Give the last pick-up a moment to land so its name (and the others') can be read from the pack.
        if (now - lastPick < 1500) return null;
        return { ok: true, message: `took ${taken.length}${taken.length ? `: ${taken.join(', ')}` : ''}${leftNote()}${leftCombat ? ' (switched to peace mode to loot)' : ''}` };
      }
      if (decide) {
        const o = this.host.object(next.guid);
        const d = decide({ ...next, itemType: o?.itemType ?? 0, objectDescFlags: o?.objectDescFlags ?? 0, palettes: this.itemPalettes(next.guid) });
        if (d === 'wait') { queue.unshift(next); return null; }
        if (d === 'skip') { left.push(named(next)); return null; }
      }
      lastPick = now;
      takenItems.push(next);
      this.host.pickUp(next.guid);
      return null;
    }, () => {});
  }

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

  /** Remembered places not currently in view, nearest first, as AgentObjects (seenAgo set). */
  rememberedPlaces(max = 8): AgentObject[] {
    const me = this.me();
    if (!me) return [];
    const now = this.host.now();
    const out: AgentObject[] = [];
    const myLb = (me.s.cell & 0xffff0000) >>> 0;
    const outside = (c: number): boolean => (c & 0xffff) < 0x100;
    for (const [guid, p] of this.places) {
      if (this.host.object(guid)) continue;
      // Only places in the same space: our landblock, or the landscape when we're on it (a dungeon's
      // cells sit at made-up landblock coordinates, so a distance from the surface means nothing).
      if ((p.cell & 0xffff0000) >>> 0 !== myLb && !(outside(me.s.cell) && outside(p.cell))) continue;
      const g = toGlobal(p.cell, p.x, p.y);
      const b = bearing(me.g, g);
      out.push({
        guid, name: p.name, kind: p.kind,
        dist: Math.round(Math.hypot(g.x - me.g.x, g.y - me.g.y) * 10) / 10,
        bearing: Math.round(b), relBearing: Math.round(relDeg(b - me.heading)), dz: Math.round((p.z - me.s.z) * 10) / 10,
        seenAgo: Math.max(0, Math.round((now - p.t) / 1000)),
      });
    }
    // One entry per place: respawned NPCs come back with new ids at the same spot.
    const seen = new Set<string>();
    const unique = out.sort((a, b) => (a.seenAgo ?? 0) - (b.seenAgo ?? 0)).filter((o) => {
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
          this.places.set(o.guid, { name: o.name, kind, cell: o.cell, x: o.x, y: o.y, z: o.z, t: now });
        }
      }
    }
    if (placesChanged.n) this.savePlaces(s);
    if (this.known) {
      const carried = fresh.length ? this.host.carriedGuids() : new Set<number>();
      for (const o of fresh) if (!carried.has(o.guid)) this.objectAdded(o);
      for (const [g, name] of this.known) if (!seen.has(g)) this.objectRemoved(g, name);
    }
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
      useOn: (i: TargetArg, t: TargetArg) => this.useOn(i, t),
      walkTo: (t: number | string, o?: { within?: number; timeoutMs?: number }) => this.walkTo(t, o),
      turn: (t: number | string) => this.turn(t),
      move: (d: string, s?: number) => this.move(d, s),
      jump: () => this.jump(),
      stopMoving: () => this.stopMoving(),
      combatMode: (m: string) => this.combatMode(m),
      attack: (t: TargetArg, o?: { height?: AttackHeightName; power?: number }) => this.attack(t, o),
      cast: (s: number | string, t: TargetArg) => this.cast(s, t),
      pickUp: (t: TargetArg) => this.pickUp(t),
      loot: (c: TargetArg, m: string | null) => this.loot(c, m),
      drop: (t: TargetArg) => this.drop(t),
      give: (i: TargetArg, t: TargetArg, n: number | null) => this.give(i, t, n),
      equip: (t: TargetArg) => this.equip(t),
      appraise: (t: TargetArg) => this.appraise(t),
      raise: (s: string, n?: number) => this.raise(s, n),
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
