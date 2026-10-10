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
import { exprToString, runExpr, truthy, vtFromVTank, vtToVTank, type ExprCoords, type ExprHost, type ExprValue, type HostObject, type VarScope } from '@ac/shared';
import type { AgentApi } from './AgentApi.ts';
import type { RoutineEngine } from './RoutineEngine.ts';
import type { AgentObjectKind } from './types.ts';

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

export function vtankExprHost(api: AgentApi, engine: RoutineEngine, print: (text: string) => void): ExprHost {
  const runVars = new Map<string, ExprValue>();
  const gvars = store('acjs.vtank.gvar');
  const pvarsFor = () => store(`acjs.vtank.pvar.${api.snapshot({ max: 0 }).me?.name ?? '?'}`);
  const scopeGet = (scope: VarScope, name: string): ExprValue | undefined => {
    if (scope === 'var') return runVars.get(name);
    const s = scope === 'gvar' ? gvars.get() : pvarsFor().get();
    return name in s ? s[name] : undefined;
  };
  const me = () => api.snapshot({ max: 0 }).me;
  const objects = (): HostObject[] => {
    const self = me();
    if (!self) return [];
    return api.snapshot({ radius: 250, max: 200 }).nearby.map((o) => {
      const r = (o.bearing * Math.PI) / 180;
      return {
        id: o.guid, name: o.name, objectClass: OBJECT_CLASS[o.kind] ?? 0,
        coords: coordsOf(self.pos.x + o.dist * Math.sin(r), self.pos.y + o.dist * Math.cos(r), self.pos.z + (o.dz ?? 0)),
      };
    });
  };
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
    now: () => performance.now(),
    echo: (text) => print(text),
    chatbox: (text) => { void api.say(text); },
    // VTank's units out and in: its ranges are map units (yards / 240), ours metres.
    vtGetSetting: (name) => { const v = engine.setting(name); if (v === undefined) return 0; const out = vtToVTank(name, v); return typeof out === 'boolean' ? (out ? 'True' : 'False') : out; },
    vtSetSetting: (name, value) => { engine.setSetting(name, vtFromVTank(name, value)); return true; },
    getMetaState: () => engine.status().state ?? '',
    setMetaState: (state) => { engine.goTo(state); },
    player: () => { const s = me(); return { id: s?.guid ?? 0, name: s?.name ?? '', objectClass: 24, coords: s ? coordsOf(s.pos.x, s.pos.y, s.pos.z) : null, heading: s?.heading }; },
    playerCoords: () => { const s = me(); return s ? coordsOf(s.pos.x, s.pos.y, s.pos.z) : { kind: 'coords', ns: 0, ew: 0, z: 0 }; },
    playerLandcell: () => { const s = me(); return s ? parseInt(s.cell, 16) >>> 0 : 0; },
    vital: (v) => {
      const s = me();
      const x = s ? (v === 1 ? s.health : v === 2 ? s.stamina : v === 3 ? s.mana : null) : null;
      return x ? { base: x.max, current: x.cur, buffedMax: x.max } : null;
    },
    // snapshot, not observe: observe hands the pending chat lines to its caller.
    isPortaling: () => api.snapshot({ max: 0 }).screen === 'portal-space',
    objects,
    inventory: () => api.inventory().map((i) => ({ id: i.guid, name: i.name, objectClass: 8, stack: i.stack ?? 1 })),
    selectionId: () => api.selectedGuid(),
    select: (id) => api.select(id).ok,
    useItem: (id) => { void api.use(id); return true; },
    castSpell: (id, target) => { void api.cast(id, target ?? null); return true; },
    spellName: (id) => api.spells('', 1000).find((s) => s.id === id)?.name ?? '',
    knownSpells: () => api.spells('', 1000).map((s) => s.id),
    spellKnown: (id) => api.spells('', 1000).some((s) => s.id === id),
  };
}

/** The engine's expression evaluator over a host: conditions test truthiness, actions report the value. */
export function vtankExpressions(host: ExprHost): { test(expr: string): boolean; run(expr: string): string } {
  return {
    test: (expr) => truthy(runExpr(expr, host)),
    run: (expr) => exprToString(runExpr(expr, host)),
  };
}
