/**
 * AGENT.vtank-engine-support — what VirindiTank meta expressions see of the
 * game (packages/shared/src/routines/vtankExpr.ts's ExprHost), built on the
 * agent API and the routine engine: the three variable scopes (var for the
 * run, gvar for every character in this browser, pvar per character), VTank
 * settings and meta state (the engine's), chat (echo prints locally,
 * chatbox speaks as the player would — '@' refused like any routine say),
 * your position and vitals, the objects the client knows (the radar's), your
 * items, and the actions a player can take (use, select, cast). It reads
 * only what the client shows and acts only through the agent API (the
 * no-cheating rule); what it can't provide stays unset, so those functions
 * answer "unsupported function".
 */
import { XpMeter, exprToString, runExpr, truthy, vtFromVTank, vtToVTank, type ExprCoords, type ExprHost, type ExprValue, type HostObject, type HostQuest, type PropKind, type VarScope } from '@ac/shared';
import type { AgentApi } from './AgentApi.ts';
import { decalObjectClass } from './decalObjectClass.ts';
import { checkSpell } from './metaSpellCheck.ts';
import { MACRO_DEFAULTS, VT_COMMAND, type RoutineEngine } from './RoutineEngine.ts';
import type { AgentObjectKind } from './types.ts';

/** One object as the game holds it (MetaGame.object / carried). */
export interface MetaGameObject {
  id: number;
  name: string;
  itemType: number;
  /** ObjectDescriptionFlags. */
  flags: number;
  wcid?: number;
  containerId?: number;
  /** Where it is worn or wielded now (EquipMask); 0 / absent when it isn't. */
  equipMask?: number;
  stack?: number;
}

/**
 * What the meta expressions read from the game beyond the agent API (main.ts
 * builds it over the client's own state; docs/vtank-parity-gaps.md §5). Each
 * part is optional: a function whose part is missing answers "unsupported
 * function", as before.
 */
export interface MetaGame {
  object?(id: number): MetaGameObject | null;
  /** Everything you carry: worn, in the main pack and in side packs. */
  carried?(): MetaGameObject[];
  charProp?(kind: PropKind, id: number): number | string | undefined;
  attribute?(id: number): { base: number; buffed: number } | null;
  vitae?(): number;
  burden?(): number;
  /** An inventory request is waiting on the server. */
  busy?(): boolean;
  worldName?(): string;
  openContainerId?(): number | null;
  containerCapacity?(id: number): { items: number; containers: number } | null;
  moveItem?(id: number, containerId: number, slot: number, amount: number | null, joinStack: boolean): boolean;
  cooldownRemaining?(cooldownId: number): number;
  corpseOpened?(id: number): boolean;
  /** PortalYearTicks, null until the server's clock has arrived. */
  gameTicks?(): number | null;
  objectVital?(id: number, vital: number): number | null;
  /** Put text in the chat box for the player to finish. */
  pasteChat?(text: string): boolean;
  viewExists?(view: string): boolean;
  viewVisible?(view: string): boolean;
  setViewVisible?(view: string, control: string, visible: boolean): boolean;
  characterNames?(): string[];
  setNextLogin?(name: string | null): boolean;
  /** The server's quest list (questTracker.ts): one flag, null when it isn't listed. */
  quest?(name: string): HostQuest | null;
  /** The quest list is being asked for (isrefreshingquests). */
  refreshingQuests?(): boolean;
  /** Virindi HUDs' Status HUD: VTank's statushud / statushudcolored write an entry under "VTank" (color: RGB number). */
  statusHud?(key: string, value: string, color?: number): void;
  /** Spell ids from an object's appraisal; `activeOnly`: the enchantments on it. */
  objectSpellIds?(id: number, activeOnly: boolean): number[];
}

/** ItemType.Caster: wands, staves and orbs. */
const CASTER = 0x8000;

/** Decal ObjectClass for what the agent API calls each kind. */
const OBJECT_CLASS: Partial<Record<AgentObjectKind, number>> = {
  monster: 5, player: 24, npc: 37, vendor: 25, portal: 14, door: 26, corpse: 27, lifestone: 28, container: 10, item: 8,
};

const coordsOf = (x: number, y: number, z: number): ExprCoords => ({ kind: 'coords', ew: x / 240 - 101.95, ns: y / 240 - 101.95, z: z / 240 });

/** Persistent variable stores (browser storage; memory only when it's unavailable). */
function store(key: string): { get(): Record<string, ExprValue>; set(v: Record<string, ExprValue>): void } {
  let mem: Record<string, ExprValue> = {};
  return {
    get: () => { try { const raw = globalThis.localStorage?.getItem(key); if (raw) mem = JSON.parse(raw) as Record<string, ExprValue>; } catch { /* storage blocked */ } return mem; },
    set: (v) => { mem = v; try { globalThis.localStorage?.setItem(key, JSON.stringify(v)); } catch { /* storage blocked */ } },
  };
}

export function vtankExprHost(api: AgentApi, engine: RoutineEngine, print: (text: string) => void, game: MetaGame = {}): ExprHost {
  const runVars = new Map<string, ExprValue>();
  const gvars = store('acjs.vtank.gvar');
  const pvarsFor = () => store(`acjs.vtank.pvar.${api.snapshot({ max: 0 }).me?.name ?? '?'}`);
  const scopeGet = (scope: VarScope, name: string): ExprValue | undefined => {
    if (scope === 'var') return runVars.get(name);
    const s = scope === 'gvar' ? gvars.get() : pvarsFor().get();
    return name in s ? s[name] : undefined;
  };
  const me = () => api.snapshot({ max: 0 }).me;
  const setting = (n: string) => engine.setting(n) ?? MACRO_DEFAULTS[n];
  /** A game object as the expressions see it (Decal's object class; ItemType; where it is worn). */
  const fromGame = (o: MetaGameObject, coords?: ExprCoords | null): HostObject => ({
    id: o.id, name: o.name, objectClass: decalObjectClass(o.itemType, o.flags), templateType: o.wcid ?? 0, itemType: o.itemType,
    ...(o.containerId ? { containerId: o.containerId } : {}), ...(o.equipMask ? { equipMask: o.equipMask } : {}),
    ...(o.stack !== undefined ? { stack: o.stack } : {}), ...(coords !== undefined ? { coords } : {}),
  });
  const objects = (): HostObject[] => {
    const self = me();
    if (!self) return [];
    return api.snapshot({ radius: 250, max: 200 }).nearby.map((o) => {
      const r = (o.bearing * Math.PI) / 180;
      const coords = coordsOf(self.pos.x + o.dist * Math.sin(r), self.pos.y + o.dist * Math.cos(r), self.pos.z + (o.dz ?? 0));
      const g = game.object?.(o.guid);
      if (g) return { ...fromGame(g, coords), ...(o.kind === 'door' ? { isDoorOpen: o.open === true } : {}), ...(o.stack !== undefined ? { stack: o.stack } : {}) };
      return { id: o.guid, name: o.name, objectClass: OBJECT_CLASS[o.kind] ?? 0, coords, ...(o.kind === 'door' ? { isDoorOpen: o.open === true } : {}) };
    });
  };
  const inventory = (): HostObject[] => {
    const all = game.carried?.();
    if (all) return all.map((o) => fromGame(o));
    return api.inventory().map((i) => ({ id: i.guid, name: i.name, objectClass: 8, stack: i.stack ?? 1, ...(i.wcid ? { templateType: i.wcid } : {}), ...(i.itemType !== undefined ? { itemType: i.itemType } : {}) }));
  };
  const player = (): HostObject => { const s = me(); return { id: s?.guid ?? 0, name: s?.name ?? '', objectClass: 24, coords: s ? coordsOf(s.pos.x, s.pos.y, s.pos.z) : null, heading: s?.heading }; };
  const charProp = game.charProp?.bind(game);
  // UB's XP meter: TotalExperience (quad 1) and AvailableLuminance (quad 6), from the first read in the world.
  const xp = charProp ? new XpMeter(() => {
    const x = charProp('quad', 1);
    return typeof x === 'number' && x > 0 ? { xp: x, lum: Number(charProp('quad', 6) ?? 0) } : null;
  }, () => Date.now()) : null;
  const motions = new Set<string>();
  const vitalOf = (s: ReturnType<typeof me>, v: number) => (s ? (v === 1 ? s.health : v === 2 ? s.stamina : v === 3 ? s.mana : null) : null);
  return {
    getVar: scopeGet,
    setVar: (scope, name, value) => {
      if (scope === 'var') { runVars.set(name, value); return; }
      const st = scope === 'gvar' ? gvars : pvarsFor();
      st.set({ ...st.get(), [name]: value });
    },
    clearVar: (scope, name) => {
      if (scope === 'var') return runVars.delete(name);
      const st = scope === 'gvar' ? gvars : pvarsFor();
      const v = st.get();
      if (!(name in v)) return false;
      delete v[name];
      st.set(v);
      return true;
    },
    clearAllVars: (scope) => { if (scope === 'var') runVars.clear(); else (scope === 'gvar' ? gvars : pvarsFor()).set({}); },
    listVars: (scope) => (scope === 'var' ? [...runVars] : Object.entries(scope === 'gvar' ? gvars.get() : pvarsFor().get())),
    now: () => performance.now(),
    wallClock: () => Date.now(),
    echo: (text) => print(text),
    // VirindiTank's own commands (/vt …) go to its handler, as typed; anything else is chat.
    chatbox: (text) => { if (VT_COMMAND.test(text) && engine.onVtCommand) engine.onVtCommand(text); else void api.say(text); },
    ...(game.pasteChat ? { chatboxPaste: (text: string) => { game.pasteChat!(text); } } : {}),
    // VTank's units out and in: its ranges are map units (yards / 240), ours metres.
    vtGetSetting: (name) => { const v = engine.setting(name); if (v === undefined) return 0; const out = vtToVTank(name, v); return typeof out === 'boolean' ? (out ? 'True' : 'False') : out; },
    vtSetSetting: (name, value) => { engine.setSetting(name, vtFromVTank(name, value)); return true; },
    getMetaState: () => engine.status().state ?? '',
    metaName: () => engine.status().profile ?? '',
    macroEnabled: () => { const s = engine.status(); return s.running && !s.paused; },
    // Meta Views (Create View's windows): uigetcontrol / uisetlabel, and UB's view functions.
    viewControl: (view, control) => engine.views?.hasControl?.(view, control) ?? false,
    setViewLabel: (view, control, text) => engine.views?.setLabel?.(view, control, text) ?? false,
    ...(game.viewExists ? { viewExists: (v: string) => game.viewExists!(v) } : {}),
    ...(game.viewVisible ? { viewVisible: (v: string) => game.viewVisible!(v) } : {}),
    ...(game.setViewVisible ? { setViewVisible: (v: string, c: string, on: boolean) => game.setViewVisible!(v, c, on) } : {}),
    setMetaState: (state) => { engine.goTo(state); },
    player,
    playerCoords: () => { const s = me(); return s ? coordsOf(s.pos.x, s.pos.y, s.pos.z) : { kind: 'coords', ns: 0, ew: 0, z: 0 }; },
    playerLandcell: () => { const s = me(); return s ? parseInt(s.cell, 16) >>> 0 : 0; },
    vital: (v) => {
      const x = vitalOf(me(), v);
      return x ? { base: x.max, current: x.cur, buffedMax: x.max } : null;
    },
    skill: (id) => {
      const s = api.skillList().find((k) => k.id === id);
      return s ? { base: s.base, buffed: s.buffed, training: s.training === 'specialized' ? 3 : s.training === 'trained' ? 2 : 1 } : null;
    },
    combatState: () => { const m = me()?.combatMode ?? 'peace'; return m === 'unknown' ? 'Peace' : m[0]!.toUpperCase() + m.slice(1); },
    setCombatState: (state) => api.combatMode(state.toLowerCase()).ok,
    // snapshot, not observe: observe hands the pending chat lines to its caller.
    isPortaling: () => api.snapshot({ max: 0 }).screen === 'portal-space',
    objects,
    inventory,
    objectById: (id) => {
      if (id === me()?.guid) return player();
      const near = objects().find((o) => o.id === id);
      if (near) return near;
      const g = game.object?.(id);
      return g ? fromGame(g, null) : null;
    },
    selectionId: () => api.selectedGuid(),
    select: (id) => api.select(id).ok,
    useItem: (id) => { void api.use(id); return true; },
    applyItem: (use, target) => api.useOn(use, target).ok,
    giveItem: (item, target) => { void api.give(item, target, null); return true; },
    dropItem: (id) => { void api.drop(id); return true; },
    castSpell: (id, target) => { void api.cast(id, target ?? null); return true; },
    spellName: (id) => api.spellTableData()?.spells.get(id)?.name ?? api.spells('', 100000).find((s) => s.id === id)?.name ?? '',
    knownSpells: () => api.spells('', 100000).map((s) => s.id),
    spellKnown: (id) => api.spells('', 100000).some((s) => s.id === id),
    canCastSpell: (id, kind) => checkSpell(api, setting, id, kind).castable,
    // Your own enchantments: seconds left (a spell with no end counts as a day).
    spellExpiration: (id) => { const e = api.activeSpellsNow().find((x) => x.spellId === id); return e ? Math.min(e.remaining, 86400) : 0; },
    spellExpirationByName: (name) => { const e = api.activeSpellsNow().find((x) => x.name.toLowerCase() === name.toLowerCase()); return e ? Math.min(e.remaining, 86400) : 0; },
    objectProp: (id, kind, key) => {
      if (id === me()?.guid) return charProp?.(kind, key);
      const d = api.itemData(id);
      if (!d) return undefined;
      const v = kind === 'int' ? d.int[key] : kind === 'double' ? d.float[key] : kind === 'bool' ? d.bool[key] : kind === 'string' ? d.string[key] : undefined;
      return typeof v === 'boolean' ? (v ? 1 : 0) : v;
    },
    objectHasData: (id) => api.itemData(id) !== null,
    requestObjectData: (id) => { void api.appraise(id, { quiet: true }); },
    objectHealth: (id) => {
      const s = me();
      if (id === s?.guid) return s.health.max ? s.health.cur / s.health.max : 0;
      return api.snapshot({ radius: 250, max: 200 }).nearby.find((o) => o.guid === id)?.health ?? 0;
    },
    objectVital: (id, v) => {
      const s = me();
      if (id === s?.guid) return vitalOf(s, v)?.cur ?? null;
      return game.objectVital?.(id, v) ?? null;
    },
    fellowship: () => {
      const f = api.fellowshipInfo();
      if (!f) return null;
      const s = me();
      const names = f.members ?? [];
      const ids = new Map(api.fellowsNear(100000).map((x) => [x.name, x.guid]));
      return { members: names.map((n) => ({ id: n === s?.name ? s.guid : ids.get(n) ?? 0, name: n })), ...(f.leader && s ? { leaderId: s.guid } : {}), open: f.open };
    },
    schedule: (ms, fn) => { setTimeout(fn, ms); },
    // UB's motions, held on the client's movement keys until let go (clearmotion lets go of all).
    setMotion: (m, on) => { if (api.holdMotion(m, on)) { if (on) motions.add(m.toLowerCase()); else motions.delete(m.toLowerCase()); } },
    getMotion: (m) => motions.has(m.toLowerCase()),
    clearMotion: () => { for (const m of motions) api.holdMotion(m, false); motions.clear(); },
    // VTank: true when a wand from the profile's Items tab is wielded; otherwise one step towards wielding one.
    equipAnyWand: () => {
      const listed = new Set((engine.current()?.vtank?.items ?? []).map((x) => x.name.toLowerCase()));
      const wands = api.inventory().filter((i) => ((i.itemType ?? 0) & CASTER) !== 0 && listed.has(i.name.toLowerCase()));
      if (wands.some((w) => w.where === 'equipped')) return true;
      if (wands[0]) void api.equip(wands[0].guid);
      return false;
    },
    busyState: () => (game.busy?.() ? 1 : 0),
    ...(charProp ? { charProp } : {}),
    ...(game.statusHud ? { statusHud: (k: string, v: string, c?: number) => game.statusHud!(k, v, c) } : {}),
    ...(xp ? { xpMeter: () => xp.reading(), xpReset: () => xp.reset() } : {}),
    ...(game.attribute ? { attribute: (a: number) => game.attribute!(a) } : {}),
    ...(game.vitae ? { vitae: () => game.vitae!() } : {}),
    ...(game.burden ? { burden: () => game.burden!() } : {}),
    ...(game.worldName ? { worldName: () => game.worldName!() } : {}),
    ...(game.openContainerId ? { openContainerId: () => game.openContainerId!() } : {}),
    ...(game.containerCapacity ? { containerCapacity: (id: number) => game.containerCapacity!(id) } : {}),
    ...(game.moveItem ? { moveItem: (id: number, to: number, slot: number, amount: number | null, join: boolean) => game.moveItem!(id, to, slot, amount, join) } : {}),
    ...(game.cooldownRemaining ? { cooldownRemaining: (id: number) => game.cooldownRemaining!(id) } : {}),
    ...(game.corpseOpened ? { corpseOpenedByMe: (id: number) => game.corpseOpened!(id) } : {}),
    ...(game.gameTicks ? { gameTicks: () => game.gameTicks!() ?? 0 } : {}),
    ...(game.characterNames ? { characterNames: () => game.characterNames!() } : {}),
    ...(game.setNextLogin ? { setNextLogin: (n: string | null) => game.setNextLogin!(n) } : {}),
    ...(game.quest ? { quest: (n: string) => game.quest!(n) } : {}),
    ...(game.refreshingQuests ? { isRefreshingQuests: () => game.refreshingQuests!() } : {}),
    ...(game.objectSpellIds ? { objectSpellIds: (id: number, active: boolean) => game.objectSpellIds!(id, active) } : {}),
  };
}

/** The engine's expression evaluator over a host: conditions test truthiness, actions report the value. */
export function vtankExpressions(host: ExprHost): { test(expr: string): boolean; run(expr: string): string; setVar(name: string, value: string): void } {
  return {
    test: (expr) => truthy(runExpr(expr, host)),
    run: (expr) => exprToString(runExpr(expr, host)),
    // Chat Message Capture's capturegroup_<name> / capturecolor (meta variables).
    setVar: (name, value) => host.setVar('var', name, value),
  };
}
