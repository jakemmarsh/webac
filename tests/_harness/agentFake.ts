/**
 * A fake AgentHost for the agent API / routine engine tests: a player in
 * Holtburg, objects to place, keys that move the body at run speed, and a
 * record of every action sent (tests/verify-agent-*.ts).
 */
import { expect, vi } from 'vitest';
import { compassToYaw, type AgentApi, type AgentHost, type AgentHostObject, type AgentHostSelf } from '../../packages/renderer/src/agent/AgentApi.ts';

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
  inv: Array<{ guid: number; name: string; where: string; stack?: number }> = [];
  screenName: ReturnType<AgentHost['screen']> = 'world';

  now = () => this.t;
  screen = () => this.screenName;
  self = () => this.me;
  objects = () => this.objs.values();
  object = (g: number) => this.objs.get(g) ?? null;
  isAttackable = (g: number) => (this.objs.get(g)?.objectDescFlags ?? 0) & 0x10 ? true : false;
  isDying = (g: number) => this.dying.has(g);
  targetGuid = () => this.target;
  targetHealth = () => (this.target ? 0.5 : undefined);
  carriedGuids = () => new Set(this.inv.map((i) => i.guid));
  inventory = () => this.inv;
  spells = () => [{ id: 27, name: 'Flame Bolt I', school: 'War', level: 1 }, { id: 6, name: 'Heal Self I', school: 'Life', level: 1 }];
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
  buffs: Array<{ name: string; remaining: number; beneficial?: boolean }> = [];
  activeSpells = () => this.buffs;
  freeSlots = 50;
  freePackSlots = () => this.freeSlots;
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
  cancelAttack = () => { this.sent.push('cancel'); };
  cast = (id: number, t: number | null) => { this.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`); return true; };
  chat = (text: string) => { this.chats.push(text); };
  key = (code: string, down: boolean) => { if (down) this.keys.add(code); else this.keys.delete(code); };
  setYaw = (y: number) => { this.me.yaw = y; };
  pickUp = (g: number) => { this.sent.push(`pickup ${g.toString(16)}`); return true; };
  drop = () => true;
  give = (t: number, i: number, n: number) => { this.sent.push(`give ${i.toString(16)} to ${t.toString(16)} x${n}`); return true; };
  wield = () => true;
  appraised: number[] = [];
  appraisals = new Map<number, string>();
  appraise = (g: number) => { this.appraised.push(g); };
  appraisal = (g: number) => (this.appraised.includes(g) ? this.appraisals.get(g) ?? null : null);
  /** Identify data by guid (int/float/… properties and spell names), shown once appraised. */
  appraisalDatas = new Map<number, { int: Record<number, number>; float: Record<number, number>; string: Record<number, string>; bool: Record<number, boolean>; did: Record<number, number>; spells: string[] }>();
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
  routeTo: Array<{ x: number; y: number; z: number }> | null = null;
  route = (_fc: number, _f: unknown, _tc: number, to: { x: number; y: number; z: number }) => (this.routeTo ? [...this.routeTo, to] : null);
  logout = () => {};

  add(o: Partial<AgentHostObject> & { guid: number; name: string }): AgentHostObject {
    const full: AgentHostObject = { itemType: 0, objectDescFlags: 0, cell: HOLTBURG, x: 0, y: 0, z: 94, ...o };
    this.objs.set(o.guid, full);
    return full;
  }

  /** Move the body forward along its facing at run speed while W is held. */
  /** A fixture's collision reach (guid → metres); unset = the host doesn't say. */
  objectReach: ((guid: number) => number) | undefined = undefined;
  /** Optional walls (landblock-local x, y → blocked): the body stops at them, and navProbe sees them. */
  wall: ((x: number, y: number) => boolean) | null = null;
  physics(dtMs: number): void {
    if (!this.keys.has('KeyW')) return;
    const speed = 4; // m/s
    const step = (speed * dtMs) / 1000;
    const nx = this.me.x + -Math.sin(this.me.yaw) * step;
    const ny = this.me.y + -Math.cos(this.me.yaw) * step;
    if (this.wall && this.wall(nx, ny)) return;
    this.me.x = nx;
    this.me.y = ny;
  }
  /** The client's probe stand-in: walk the body in 5 cm steps until a wall (agent global metres). */
  get navProbe(): AgentHost['navProbe'] {
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

