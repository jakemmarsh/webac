/**
 * A fake AgentHost for the agent API / routine engine tests: a player in
 * Holtburg, objects to place, keys that move the body at run speed, and a
 * record of every action sent (tests/verify-agent-*.ts).
 */
import { expect, vi } from 'vitest';
import { compassToYaw, type AgentApi, type FellowshipInfo, type AgentHost, type AgentHostObject, type AgentHostSelf } from '../../packages/renderer/src/agent/AgentApi.ts';
import { getJumpVelocity } from '@ac/shared';
import type { AgentItem, AgentSpell } from '../../packages/renderer/src/agent/types.ts';

export const HOLTBURG = 0xa9b40019; // landblock 0xA9,0xB4 outdoor cell

export class FakeHost implements AgentHost {
  t = 0;
  objs = new Map<number, AgentHostObject>();
  me: AgentHostSelf = {
    guid: 0x50000001, name: 'Claude Test', level: 5,
    health: { current: 50, max: 50 }, stamina: { current: 80, max: 80 }, mana: { current: 30, max: 30 },
    cell: HOLTBURG, x: 80, y: 20, z: 94, yaw: compassToYaw(0), combatMode: 'peace', dead: false,
  };
  keys = new Set<string>();
  sent: string[] = [];
  chats: string[] = [];
  target: number | null = null;
  dying = new Set<number>();
  container: { guid: number; items: Array<{ guid: number; name: string }> } | null = null;
  inv: AgentItem[] = [];
  screenName: ReturnType<AgentHost['screen']> = 'world';

  now = () => this.t;
  screen = () => this.screenName;
  self = () => this.me;
  /** The server's echo of your position (checkpoints); unset = the host can't say. */
  serverSelfPosition: AgentHost['serverSelfPosition'] = undefined;
  objects = () => this.objs.values();
  object = (g: number) => this.objs.get(g) ?? null;
  isAttackable = (g: number) => (this.objs.get(g)?.objectDescFlags ?? 0) & 0x10 ? true : false;
  isDying = (g: number) => this.dying.has(g);
  targetGuid = () => this.target;
  targetHealth = () => (this.target ? 0.5 : undefined);
  carriedGuids = () => new Set(this.inv.map((i) => i.guid));
  inventory = () => this.inv;
  spells: () => AgentSpell[] = () => [{ id: 27, name: 'Flame Bolt I', school: 'War', level: 1 }, { id: 6, name: 'Heal Self I', school: 'Life', level: 1 }];
  characterSheet = () => 'sheet';
  windowList: string[] = [];
  openWindows = () => this.windowList;
  closeWindow = (name: string) => {
    if (name === 'all') { this.windowList = []; return null; }
    const i = this.windowList.findIndex((w) => w.toLowerCase().startsWith(name.toLowerCase()));
    if (i < 0) return `no open window "${name}"`;
    this.windowList.splice(i, 1);
    return null;
  };
  fellowshipText = 'no fellowship';
  fellowship = () => this.fellowshipText;
  /** Your fellowship for Auto Fellow Mgmt (leader, size, fellows' names, the era's Leader hand-off); null: none. */
  fellowInfo: FellowshipInfo | null = null;
  fellowshipInfo = () => this.fellowInfo;
  fellowshipAction = (action: string, arg?: string) => { this.sent.push(`fellowship ${action}${arg ? ` ${arg}` : ''} ${this.target?.toString(16) ?? ''}`.trim()); return null; };
  allegianceText = 'no allegiance (no patron, no vassals)';
  swearRefusal: string | null = null;
  allegiance = () => this.allegianceText;
  swearAllegiance = () => { if (this.swearRefusal) return this.swearRefusal; this.sent.push(`swear ${this.target?.toString(16)}`); return null; };
  breakAllegiance = (name?: string) => { this.sent.push(`break ${name ?? 'patron'}`); return null; };
  openContainer = () => this.container;
  busy = () => false;
  dialogList: Array<{ text: string; buttons: string[] }> = [];
  cameraBoom = () => ({ min: 2.5, max: 2.75 });
  buffs: Array<{ spellId?: number; name: string; remaining: number; beneficial?: boolean }> = [];
  activeSpells = () => this.buffs;
  /** The Vitae enchantment (AgentHost.vitae); unset = no vitae. */
  vitae: AgentHost['vitae'] = undefined;
  /** The fellowship's XP split (AgentHost.fellowshipXp); unset = the host can't say. */
  fellowshipXp: AgentHost['fellowshipXp'] = undefined;
  freeSlots = 50;
  freePackSlots = () => this.freeSlots;
  /** The main pack and side packs with their item slots (AgentHost.packs); unset = the host can't say. */
  packs: AgentHost['packs'] = undefined;
  burdenPercent = () => 30;
  dialogs = () => this.dialogList;
  answerDialog = (label: string, index?: number) => { expect(index).toBeUndefined(); const i = this.dialogList.findIndex((d) => d.buttons.includes(label)); if (i < 0) return false; this.dialogList.splice(i, 1); return true; };
  select = (g: number) => { this.target = g; return true; };
  use = (g: number) => { this.sent.push(`use ${g.toString(16)}`); return true; };
  useWithTarget = (s: number, t: number) => { this.sent.push(`usewith ${s.toString(16)} ${t.toString(16)}`); return true; };
  setCombatMode = (m: string) => { this.sent.push(`mode ${m}`); this.me.combatMode = m as AgentHostSelf['combatMode']; };
  pending = false;
  attack = (g: number, p: number, h: string) => { this.sent.push(`attack ${g.toString(16)} ${p} ${h}`); this.pending = true; };
  attackPending = () => this.pending;
  /** The combat bar's attack height. */
  barHeight: 'high' | 'medium' | 'low' = 'medium';
  attackHeight = () => this.barHeight;
  /** The combat bar's power / accuracy level. */
  barPower = 0.35;
  attackPower = () => this.barPower;
  setAttackPower = (p: number) => { this.sent.push(`power ${p}`); this.barPower = p; };
  setAttackHeight = (h: 'high' | 'medium' | 'low') => { this.sent.push(`height ${h}`); this.barHeight = h; };
  cancelAttack = () => { this.sent.push('cancel'); };
  /** A swing under way (the client's attackInProgress); unset = the host can't say. */
  attacking: AgentHost['attacking'] = undefined;
  cast = (id: number, t: number | null) => { this.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`); return true; };
  chat = (text: string) => { this.chats.push(text); };
  setYaw = (y: number) => { this.me.yaw = y; };
  pickUp = (g: number) => { this.sent.push(`pickup ${g.toString(16)}`); return true; };
  drop = (_g: number) => true;
  /** Wall-clock ms for remembered places; unset = Date.now(). */
  wallClock: (() => number) | undefined = undefined;
  /** The open book (ac_use on a readable) and its page requests; unset = the host has none. */
  book: AgentHost['book'] = undefined;
  bookPage: AgentHost['bookPage'] = undefined;
  give = (t: number, i: number, n: number) => { this.sent.push(`give ${i.toString(16)} to ${t.toString(16)} x${n}`); return true; };
  wield = (g: number) => { this.sent.push(`wield ${g.toString(16)}`); return true; };
  /** Whether the client's optimistic wield of an item still waits for the server; unset = the host can't say. */
  inventoryPending: AgentHost['inventoryPending'] = undefined;
  appraised: number[] = [];
  appraisals = new Map<number, string>();
  /** Every appraise call, with whether it was quiet (the automation's own looks: no Examine window). */
  appraiseCalls: Array<{ guid: number; quiet: boolean }> = [];
  appraise = (g: number, quiet?: boolean) => { this.appraised.push(g); this.appraiseCalls.push({ guid: g, quiet: !!quiet }); };
  appraisal = (g: number) => (this.appraised.includes(g) ? this.appraisals.get(g) ?? null : null);
  /** Identify data by guid (int/float/… properties and spell names), shown once appraised. */
  appraisalDatas = new Map<number, { int: Record<number, number>; float: Record<number, number>; string: Record<number, string>; bool: Record<number, boolean>; did: Record<number, number>; spells: string[]; spellIds?: number[]; activeSpellIds?: number[]; maxVelocity?: number }>();
  appraisalData = (g: number) => (this.appraised.includes(g) ? this.appraisalDatas.get(g) ?? null : null);
  /** Palettes by id (0xRRGGBB entries); a missing one reads as not loaded yet. */
  palettes = new Map<number, number[]>();
  paletteColor = (id: number, index: number) => this.palettes.get(id)?.[index] ?? null;
  /** Subpalettes of items in your own pack, by guid. */
  carried = new Map<number, Array<{ id: number; offset: number; length: number }>>();
  carriedPalettes = (g: number) => this.carried.get(g) ?? null;
  /** Skills by AC skill id. */
  skills = new Map<number, { base: number; buffed: number }>();
  skill = (id: number) => this.skills.get(id) ?? null;
  /** Raisable stats and the unassigned XP; a raise costs 20 below 80 and 90 from there. */
  stats = new Map<string, number>([['Heavy Weapons', 77]]);
  xp = 70;
  raise = (s: string, upTo?: number) => {
    const name = [...this.stats.keys()].find((k) => k.toLowerCase() === s.toLowerCase());
    if (!name) return { ok: false, message: `no attribute, vital or skill called "${s}"` };
    const from = this.stats.get(name)!;
    if (upTo !== undefined && from >= upTo) return { ok: false, message: `${name} is already ${from}`, reached: true };
    const cost = from >= 80 ? 90 : 20;
    if (cost > this.xp) return { ok: false, message: `raising ${name} costs ${cost} XP; you have ${this.xp} unassigned` };
    this.xp -= cost;
    this.stats.set(name, from + 1);
    return { ok: true, message: `raised ${name}`, name, from, to: from + 1, cost };
  };
  trained: string[] = [];
  trainSkill = (s: string) => { this.trained.push(s); return { ok: true, message: `trained ${s}`, name: s, cost: 4 }; };
  pressed: string[] = [];
  press = (k: string) => { this.pressed.push(k); return { ok: true, message: `pressed ${k}` }; };
  keyBindings = (f: string) => [{ name: 'Show/Hide Inventory', keys: ['F12'] }, { name: 'Toggle Autorun', keys: [] }].filter((k) => k.name.toLowerCase().includes(f.toLowerCase()));
  vendorOpen: { name: string; guid: number; currency: string; items: Array<{ guid: number; name: string; price: number }> } | null = null;
  vendor = () => this.vendorOpen;
  vendorBuy = (g: number, n: number) => { this.sent.push(`buy ${g.toString(16)} x${n}`); return true; };
  vendorSell = (g: number, n: number) => { this.sent.push(`sell ${g.toString(16)} x${n}`); return true; };
  tradeOpen: { partner: string; yours: string[]; theirs: string[]; youAccepted: boolean; theyAccepted: boolean } | null = null;
  trade = () => this.tradeOpen;
  tradeAction = (a: string, g?: number) => { this.sent.push(`trade ${a}${g ? ` ${g.toString(16)}` : ''}`); return true; };
  /** The straight line of fire (a bolt) and an arrow's arc to a target; unset = the host can't say. */
  lineOfFire: AgentHost['lineOfFire'] = undefined;
  /** The attributes each vital is drawn from (the DAT's SecondaryAttributeTable); unset = the host can't say. */
  vitalAttributes: AgentHost['vitalAttributes'] = undefined;
  lineOfFireOpenSpot: AgentHost['lineOfFireOpenSpot'] = undefined;
  lineOfFireFrom: AgentHost['lineOfFireFrom'] = undefined;
  /** The ChatPoseTable's state for a pose word, and whether the client handles "/word"; unset = the host can't say. */
  chatPose: AgentHost['chatPose'] = undefined;
  clientCommand: AgentHost['clientCommand'] = undefined;
  missileLineOfFire: AgentHost['missileLineOfFire'] = undefined;
  routeTo: Array<{ x: number; y: number; z: number }> | null = null;
  /** The floorless cells between two rooms no route joins (cellPath routeBarrier); unset = the host can't say. */
  routeBarrier: AgentHost['routeBarrier'] = undefined;
  /** The rooms you can walk cut off from the goal (cellPath routeCutOff); unset = the host can't say. */
  routeCutOff: AgentHost['routeCutOff'] = undefined;
  route = (_fc: number, _f: unknown, _tc: number, to: { x: number; y: number; z: number }) => (this.routeTo ? [...this.routeTo, to] : null);
  logout = () => {};

  add(o: Partial<AgentHostObject> & { guid: number; name: string }): AgentHostObject {
    const full: AgentHostObject = { itemType: 0, objectDescFlags: 0, cell: HOLTBURG, x: 0, y: 0, z: 94, ...o };
    this.objs.set(o.guid, full);
    return full;
  }

  /** The RunAsDefaultMovement option (on: Shift walks; off: Shift runs, and the body walks without it). */
  runDefault = true;
  /** Move the body forward along its facing at run speed while W is held. */
  /** A fixture's collision reach (guid → metres); unset = the host doesn't say. */
  objectReach: ((guid: number) => number) | undefined = undefined;
  /** Your fellows (the fellowship panel's list); unset = no fellowship. */
  fellows: AgentHost['fellows'] = undefined;
  /** The agent's ask for its fellows' vitals (the shown fellowship pane's updates); unset = the host has none. */
  wantFellowVitals: AgentHost['wantFellowVitals'] = undefined;
  /** Whether an interior cell is a dungeon's (not SeenOutside); unset = the host can't say. */
  cellSealed: AgentHost['cellSealed'] = undefined;
  /** The rooms' floors under a landblock-local point (map coordinates in a dungeon); unset = the host can't say. */
  floorsAt: AgentHost['floorsAt'] = undefined;
  /** Where to stand in an interior cell named by its id (walk_to target=0xXXYYCCCC); unset = the host can't say. */
  cellPoint: AgentHost['cellPoint'] = undefined;
  cellRange: AgentHost['cellRange'] = undefined;
  /** The landscape at a global point (open sea, too steep, the wade); unset = the host can't say. */
  navTerrain: AgentHost['navTerrain'] = undefined;
  /** Optional walls (landblock-local x, y → blocked): the body stops at them, and navProbe sees them. */
  wall: ((x: number, y: number) => boolean) | null = null;
  physics(dtMs: number): void {
    if (this.floors) return this.physics3d(dtMs);
    if (!this.keys.has('KeyW')) return;
    // Run speed, or a walk (3.12 m/s) with the hold-run key flipping it (Shift with running the default).
    const speed = this.keys.has('ShiftLeft') === this.runDefault ? 3.12 : 4; // m/s
    const step = (speed * dtMs) / 1000;
    const nx = this.me.x + -Math.sin(this.me.yaw) * step;
    const ny = this.me.y + -Math.cos(this.me.yaw) * step;
    if (this.wall && this.wall(nx, ny)) return;
    this.me.x = nx;
    this.me.y = ny;
  }

  /**
   * AGENT.walk-drops-jumps — an optional world of floors (landblock-local x, y → the floor heights
   * there, any order). The body walks on a floor (a step of at most STEP up or down; a ledge stops
   * it, as the client's edge slide does), and jumps: Space charges (1 s to full), its release
   * launches a standing long jump at the forward speed of the keys held then (4 m/s, 3.12 with
   * Shift) and getJumpVelocity(load 0, Jump 100, power) up, flown at 30 Hz and landing on the
   * first floor its feet reach. The navigation hooks (navProbe / navFloor / navAirStep / jumpLaunch)
   * answer from the same world.
   */
  floors: ((x: number, y: number) => number[]) | null = null;
  static readonly STEP = 0.6;
  jumpSkill = 100;
  /** The server family billing fall damage (AgentHost.fallServer); null leaves the hook out (ACE's). */
  fallFamily: 'ace' | 'gdle' | null = null;
  get fallServer(): AgentHost['fallServer'] {
    return this.fallFamily ? () => this.fallFamily as 'ace' | 'gdle' : undefined;
  }
  airborne: { vx: number; vy: number; vz: number } | null = null;
  private chargeAt: number | null = null;
  /** Every launch: power, forward speed, where from. */
  launches: Array<{ power: number; forward: number; walk: boolean; x: number; y: number; z: number }> = [];
  private get ox(): number { return ((HOLTBURG >>> 24) & 0xff) * 192; }
  private get oy(): number { return ((HOLTBURG >>> 16) & 0xff) * 192; }
  /** The floor at local (x, y) at or below z (+5 cm). */
  floorBelow(x: number, y: number, z: number): number | null {
    const fs = (this.floors?.(x, y) ?? []).filter((f) => f <= z + 0.05);
    return fs.length ? Math.max(...fs) : null;
  }
  /** A body with feet at z can be at local (x, y): no wall, no floor top in its way above its feet (`rise`: the step it may take up). */
  private clear(x: number, y: number, z: number, rise = FakeHost.STEP): boolean {
    if (this.wall && this.wall(x, y)) return false;
    return !(this.floors?.(x, y) ?? []).some((f) => f > z + rise && f < z + 1.8);
  }
  /** A walking step from feet z to local (x, y): the floor there, or null (a wall, a riser, a ledge). */
  private walkStep(x: number, y: number, z: number): number | null {
    if (!this.clear(x, y, z)) return null;
    const f = this.floorBelow(x, y, z + FakeHost.STEP);
    return f !== null && z - f <= FakeHost.STEP ? f : null;
  }
  private airMove(x: number, y: number, z: number, dx: number, dy: number): { x: number; y: number } {
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 0.05));
    let px = x, py = y;
    for (let i = 1; i <= n; i++) {
      const tx = x + (dx * i) / n, ty = y + (dy * i) / n;
      if (!this.clear(tx, ty, z, 0.05)) break;
      px = tx; py = ty;
    }
    return { x: px, y: py };
  }
  private launchOf(power: number, walk: boolean): { forward: number; up: number; chargeSeconds: number } {
    return { forward: walk ? 3.12 : 4, up: getJumpVelocity(0, this.jumpSkill, power), chargeSeconds: 1 };
  }
  private physics3d(dtMs: number): void {
    const dt = 1 / 30;
    for (let t = 0; t < dtMs / 1000 - 1e-9; t += dt) {
      if (this.airborne) {
        const a = this.airborne;
        const m = this.airMove(this.me.x, this.me.y, this.me.z, a.vx * dt, a.vy * dt);
        let nz = this.me.z + a.vz * dt - 4.9 * dt * dt;
        let nv = a.vz - 9.8 * dt;
        if (nv > 0) {
          const over = this.floorBelow(this.me.x, this.me.y, nz + 1.835);
          if (over !== null && over > nz + 1) { nz = Math.min(nz, over - 1.835); nv = 0; }
        }
        const g = this.floorBelow(m.x, m.y, Math.max(this.me.z, nz));
        this.me.x = m.x; this.me.y = m.y;
        if (nv < 0 && g !== null && nz <= g) { this.me.z = g; this.landings.push({ x: m.x, y: m.y, z: g, vz: nv }); this.airborne = null; continue; }
        this.me.z = nz; a.vz = nv;
        continue;
      }
      // Charging a standing long jump: the held forward key doesn't move the body.
      if (this.chargeAt !== null || !this.keys.has('KeyW')) continue;
      const speed = this.keys.has('ShiftLeft') ? 3.12 : 4;
      const nx = this.me.x + -Math.sin(this.me.yaw) * speed * dt;
      const ny = this.me.y + -Math.cos(this.me.yaw) * speed * dt;
      const f = this.walkStep(nx, ny, this.me.z);
      if (f === null) continue;
      this.me.x = nx; this.me.y = ny; this.me.z = f;
    }
  }
  landings: Array<{ x: number; y: number; z: number; vz: number }> = [];
  key = (code: string, down: boolean) => {
    if (code === 'Space' && this.floors) {
      if (down && !this.keys.has('Space') && !this.airborne) this.chargeAt = Date.now();
      if (!down && this.keys.has('Space') && this.chargeAt !== null) {
        const power = Math.min(1, Math.max(0.001, (Date.now() - this.chargeAt) / 1000));
        this.chargeAt = null;
        const walk = this.keys.has('ShiftLeft');
        const l = this.launchOf(power, walk);
        const forward = this.keys.has('KeyW') ? l.forward : 0;
        this.launches.push({ power, forward, walk, x: this.me.x, y: this.me.y, z: this.me.z });
        this.airborne = { vx: -Math.sin(this.me.yaw) * forward, vy: -Math.cos(this.me.yaw) * forward, vz: l.up };
      }
    }
    if (down) this.keys.add(code); else this.keys.delete(code);
  };
  get navFloor(): AgentHost['navFloor'] {
    if (!this.floors) return undefined;
    return (x, y, z) => this.floorBelow(x - this.ox, y - this.oy, z);
  }
  get navAirStep(): AgentHost['navAirStep'] {
    if (!this.floors) return undefined;
    return (from, dx, dy) => { const m = this.airMove(from.x - this.ox, from.y - this.oy, from.z, dx, dy); return { x: m.x + this.ox, y: m.y + this.oy }; };
  }
  /** No ceilings in the fake's floor plans (DungeonHost has the real ones). */
  get navCeiling(): AgentHost['navCeiling'] { return undefined; }
  get jumpLaunch(): AgentHost['jumpLaunch'] {
    if (!this.floors) return undefined;
    return (power, walk) => this.launchOf(power, walk);
  }
  /** The client's probe stand-in: walk the body in 5 cm steps until a wall (agent global metres). */
  get navProbe(): AgentHost['navProbe'] {
    if (this.floors) {
      return (from, to) => {
        const ox = this.ox, oy = this.oy;
        const d = Math.hypot(to.x - from.x, to.y - from.y);
        const n = Math.max(1, Math.ceil(d / 0.05));
        let last = from;
        for (let s = 1; s <= n; s++) {
          const x = from.x + ((to.x - from.x) * s) / n, y = from.y + ((to.y - from.y) * s) / n;
          const f = this.walkStep(x - ox, y - oy, last.z);
          if (f === null) return last;
          last = { x, y, z: f };
        }
        return last;
      };
    }
    if (!this.wall) return undefined;
    const wall = this.wall;
    const ox = ((HOLTBURG >>> 24) & 0xff) * 192, oy = ((HOLTBURG >>> 16) & 0xff) * 192;
    return (from, to) => {
      const d = Math.hypot(to.x - from.x, to.y - from.y);
      const n = Math.max(1, Math.ceil(d / 0.05));
      let last = from;
      for (let s = 1; s <= n; s++) {
        const p = { x: from.x + ((to.x - from.x) * s) / n, y: from.y + ((to.y - from.y) * s) / n, z: from.z };
        if (wall(p.x - ox, p.y - oy)) return last;
        last = p;
      }
      return last;
    };
  }
}

export function run(api: AgentApi, host: FakeHost, ms: number, opts: { physics?: boolean } = {}): void {
  for (let t = 0; t < ms; t += 100) {
    host.t += 100;
    vi.advanceTimersByTime(100);
    if (opts.physics !== false) host.physics(100);
    api.tick();
  }
}

