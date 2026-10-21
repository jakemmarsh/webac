/**
 * VirindiTank's route points that do something (docs/vtank-parity-gaps.md §4;
 * docs/vtank-macro-behavior.md "Routes: what each point waits for"): which
 * points are walked to and which a route may start at, and the steps that
 * wait for their result: a portal or a recall waits for portal space and the
 * arrival, recasting after a fizzle; an NPC waits for its reply; a checkpoint
 * waits until the server's own echo of your position is there; a closed door
 * on the way is opened (a locked one picked with a Consumables lockpick).
 *
 * Facts from MOSS (openac-mosstank, read for facts only, no code copied) and
 * the VTank wiki: each step gives up after 30 s outside portal space and the
 * route goes on; uses are retried; a portal exit within 15 m of where it was
 * used counts as no trip; a checkpoint inches forward after 15 s; a door is
 * opened within DoorOpenRange, its lock state read by identifying it within
 * DoorIDRange, and a locked one is picked only when your Lockpick skill is at
 * least its difficulty plus DoorLockpickDiffExcessThreshold.
 *
 * Every outcome is read from what the client itself sees (the portal-space
 * screen, the door's open state, the chat line, the server's position echo),
 * so it is the same on every era's server.
 */
import { RECALL_SPELLS, type Route, type RoutineAction } from '@ac/shared';
import { MAP_COORD_ORIGIN, parseMapCoords, type AgentApi } from './AgentApi.ts';
import type { AgentItem, AgentObject, AgentResult } from './types.ts';

/** How long a portal, recall or NPC step tries (outside portal space) before the route goes on. */
export const NODE_TIMEOUT_MS = 30_000;
/** Longest a portal-space trip is waited out once it has begun. */
export const PORTAL_TRIP_MAX_MS = 300_000;
/** A portal exit this near where the portal was used is no trip (tried again). */
export const PORTAL_EXIT_NEAR_M = 15;
/** A checkpoint inches forward after waiting this long for the server. */
export const CHECKPOINT_NUDGE_MS = 15_000;
/** How long a used door gets to swing open. */
export const DOOR_OPEN_WAIT_MS = 5000;
/** A door that wouldn't open (or that we can't pick) is left alone this long. */
export const DOOR_SKIP_MS = 60_000;
/** VTank's corridor: a door counts as on the way within this of the line to the point. */
export const DOOR_CORRIDOR_M = 1;
/** AC's Lockpick skill, the lockpick ObjectDescriptionFlag, and ACE's lock properties. */
export const LOCKPICK_SKILL = 23;
export const LOCKPICK_FLAG = 0x20000;
const PROP_BOOL_LOCKED = 3;
const PROP_INT_RESIST_LOCKPICK = 173;
const PROP_FLOAT_LOCKPICK_MOD = 40;
const PROP_INT_LOCKPICK_MOD = 88;

/** What these steps need from the engine. */
export interface NodeCtx {
  api: AgentApi;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** False once the run has stopped or moved on (the step ends at its next check). */
  alive(): boolean;
}

/** A point's stop actions. */
export function stopsAt(route: Route, i: number): RoutineAction[] {
  return (route.stops ?? []).filter((s) => s.at === i).flatMap((s) => s.do);
}

/**
 * Whether the route walks to this point. VTank walks to its plain points and
 * checkpoints; every other point (recall, pause, chat, portal, NPC, vendor,
 * jump) is something to do where you are, and its recorded spot is not walked to.
 */
export function walksTo(route: Route, i: number): boolean {
  return stopsAt(route, i).every((a) => a.kind === 'checkpoint');
}

/** Whether a route may start at this point: VTank's plain points, checkpoints and portal-by-id points. */
export function anchorPoint(route: Route, i: number): boolean {
  return stopsAt(route, i).every((a) => a.kind === 'checkpoint' || a.kind === 'use-portal');
}

/**
 * Where VTank starts a route when the macro starts or the route is loaded: the
 * nearest point you could be at (walksTo / portal points), by straight-line
 * distance with height where the route has it. A once route starts at its head,
 * and a Follow route has no points.
 */
export function nearestStart(route: Route, me: { x: number; y: number; z: number }): number {
  if (route.mode === 'once' || route.mode === 'follow') return 0;
  let best = 0;
  let bestD = Infinity;
  route.points.forEach((pt, i) => {
    if (!anchorPoint(route, i)) return;
    const g = parseMapCoords(pt);
    if (!g) return;
    const h = route.z?.length === route.points.length ? route.z[i] : null;
    const dz = typeof h === 'number' ? h * 240 - me.z : 0;
    const d = Math.hypot(g.x - me.x, g.y - me.y, dz);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

const RECALL_NAMES = new Set(Object.values(RECALL_SPELLS).map((n) => n.toLowerCase()));
/** A route's cast step is a recall (VTank's Recall point) when it names one of VTank's recall spells, by name or id. */
export function isRecall(spell: string): boolean {
  const t = spell.trim();
  return /^\d+$/.test(t) ? Number(t) in RECALL_SPELLS : RECALL_NAMES.has(t.toLowerCase());
}

/** Where a seen object stands, in global metres, from your position and its distance and bearing. */
export function objectAt(me: { x: number; y: number }, o: { dist: number; bearing: number }): { x: number; y: number } {
  const r = (o.bearing * Math.PI) / 180;
  return { x: me.x + o.dist * Math.sin(r), y: me.y + o.dist * Math.cos(r) };
}

const entered = (api: AgentApi, mark: number): boolean => api.status().screen === 'portal-space' || api.eventsSince(mark).some((e) => e.type === 'portal' && /entered/.test(e.text));
const arrived = (api: AgentApi, mark: number): boolean => api.eventsSince(mark).some((e) => e.type === 'portal' && /arrived/.test(e.text));
const myPos = (api: AgentApi): { x: number; y: number; z: number } | null => api.self()?.pos ?? null;

async function until(ctx: NodeCtx, done: () => boolean, ms: number, step = 250): Promise<boolean> {
  const end = ctx.now() + ms;
  while (!done()) {
    if (!ctx.alive() || ctx.now() >= end) return done();
    await ctx.sleep(step);
  }
  return true;
}

/** Waits out a portal-space trip begun since `mark`; how long it took. */
async function waitArrival(ctx: NodeCtx, mark: number): Promise<number> {
  const t0 = ctx.now();
  await until(ctx, () => arrived(ctx.api, mark), PORTAL_TRIP_MAX_MS);
  return ctx.now() - t0;
}

/**
 * VTank's Recall point: stand still in magic mode, cast, and wait for portal
 * space and the arrival. A fizzle (or any refusal) is recast at once; a cast
 * that landed waits for the teleport without recasting. A recall this
 * character doesn't know (or that the era doesn't have) is skipped and said.
 */
export async function runRecall(ctx: NodeCtx, spell: string): Promise<AgentResult> {
  const { api } = ctx;
  const arg = /^\d+$/.test(spell.trim()) ? Number(spell) : spell;
  api.stopMoving();
  if (api.self()?.combatMode !== 'magic') {
    api.combatMode('magic');
    await until(ctx, () => api.self()?.combatMode === 'magic', 3000, 200);
  }
  let casts = 0;
  const started = ctx.now();
  while (ctx.alive()) {
    if (ctx.now() - started >= NODE_TIMEOUT_MS) return { ok: false, message: `${spell}: no portal space in ${NODE_TIMEOUT_MS / 1000} s (${casts} cast${casts === 1 ? '' : 's'}); the route goes on` };
    const mark = api.currentSeq();
    casts++;
    const r = await api.cast(arg, 'self');
    if (/you don't know a spell/i.test(r.message)) return { ok: false, message: `${r.message.split('\n')[0]}: the recall point is skipped` };
    if (!r.ok && !entered(api, mark)) { await ctx.sleep(300); continue; }
    // Landed: the teleport follows its animation.
    if (!(await until(ctx, () => entered(api, mark), Math.max(0, NODE_TIMEOUT_MS - (ctx.now() - started))))) continue;
    const trip = await waitArrival(ctx, mark);
    return { ok: true, message: `recalled (${spell}${casts > 1 ? `, ${casts} casts` : ''}; ${Math.round(trip / 1000)} s in portal space)` };
  }
  return { ok: false, message: 'stopped' };
}

/** The object a use step means: by its recorded id (same name), else the same-named one nearest where it was recorded, else the nearest. */
export function findStepObject(a: Extract<RoutineAction, { kind: 'use-object' | 'use-portal' }>, nearby: AgentObject[], me: { x: number; y: number }, point: string | null): AgentObject | null {
  if (a.kind === 'use-portal') {
    const byId = nearby.find((o) => o.guid === a.id >>> 0);
    if (byId) return byId;
    // The id was another server's: the portal standing nearest the point (within 10 m).
    const pt = point ? parseMapCoords(point) : null;
    if (!pt) return null;
    const near = nearby.filter((o) => o.kind === 'portal').map((o) => ({ o, d: Math.hypot(objectAt(me, o).x - pt.x, objectAt(me, o).y - pt.y) })).filter((x) => x.d <= 10).sort((x, y) => x.d - y.d)[0];
    return near?.o ?? null;
  }
  const name = a.name.trim().toLowerCase();
  const same = nearby.filter((o) => o.name.toLowerCase() === name);
  if (!same.length) return null;
  const id = a.vt?.id;
  if (id) { const o = same.find((x) => x.guid === id >>> 0); if (o) return o; }
  const rec = a.vt?.at;
  if (rec) {
    // VTank records where the object stood (map units): two portals of one name are told apart by it.
    const at = { x: (rec[0] + MAP_COORD_ORIGIN) * 240, y: (rec[1] + MAP_COORD_ORIGIN) * 240 };
    return [...same].sort((u, v) => Math.hypot(objectAt(me, u).x - at.x, objectAt(me, u).y - at.y) - Math.hypot(objectAt(me, v).x - at.x, objectAt(me, v).y - at.y))[0];
  }
  return same[0];
}

/**
 * VTank's Use Portal/NPC and portal points. A portal (or a container that
 * portals you) is approached to UsePortalDistance and used until portal space
 * comes and you arrive somewhere else; an NPC is used until it tells or gives
 * you something (or its vendor window opens). Uses are retried; after
 * NODE_TIMEOUT_MS outside portal space the step gives up and the route goes on.
 * Anything else is used once, as before.
 */
export async function runUseStep(ctx: NodeCtx, a: Extract<RoutineAction, { kind: 'use-object' | 'use-portal' }>, opts: { point: string | null; usePortalDistance: number }): Promise<AgentResult> {
  const { api } = ctx;
  // A plain use by name (UtilityBelt's /ub use in a Chat point, no VTank record): one use, as a rule's (the name may be partial).
  if (a.kind === 'use-object' && !a.vt) return api.use(a.name);
  const label = a.kind === 'use-portal' ? `portal #${(a.id >>> 0).toString(16)}` : a.name;
  let started = ctx.now();
  let spent = 0;
  const elapsed = () => ctx.now() - started + spent;
  // Find it (it may still be streaming in).
  let o: AgentObject | null = null;
  while (ctx.alive()) {
    const me = myPos(api);
    if (me) o = findStepObject(a, api.nearby(120), me, opts.point);
    if (o) break;
    if (elapsed() >= NODE_TIMEOUT_MS) {
      // Nothing of exactly that name in 30 s: the best name match, used once (a route from another server's data).
      if (a.kind === 'use-object') return api.use(a.name);
      return { ok: false, message: `${label}: not found near the point in ${NODE_TIMEOUT_MS / 1000} s; the route goes on` };
    }
    await ctx.sleep(1000);
  }
  if (!o) return { ok: false, message: 'stopped' };
  const guid = o.guid;
  const npc = o.kind === 'npc' || o.kind === 'vendor' || (a.kind === 'use-object' && a.vt?.objectClass === 37);
  const portal = !npc && (o.kind === 'portal' || a.kind === 'use-portal' || (a.kind === 'use-object' && a.vt?.objectClass === 14));
  if (npc) {
    const esc = o.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const reply = new RegExp(`^\\(\\w+\\) ${esc} (tells you|gives you)`);
    const mark = api.currentSeq();
    const answered = () => api.vendorOpen() || api.eventsSince(mark).some((e) => e.type === 'chat' && reply.test(e.text));
    for (let uses = 1; ctx.alive(); uses++) {
      const r = await api.use(guid);
      if (answered()) return { ok: true, message: `${o.name} answered${uses > 1 ? ` (after ${uses} uses)` : ''}` };
      if (elapsed() >= NODE_TIMEOUT_MS) return { ok: false, message: `${o.name} didn't answer in ${NODE_TIMEOUT_MS / 1000} s (${uses} uses; last: ${r.message.split('\n')[0]}); the route goes on` };
      await ctx.sleep(500);
    }
    return { ok: false, message: 'stopped' };
  }
  if (!portal) return api.use(guid);
  // A portal: walk to UsePortalDistance of it (VTank clamps it to 0.5–50 m), then use it until you go through.
  const reach = Math.min(50, Math.max(0.5, opts.usePortalDistance));
  if (o.dist > reach) {
    const w = await api.walkTo(guid, { within: reach, timeoutMs: NODE_TIMEOUT_MS });
    if (!w.ok) return { ok: false, message: `couldn't reach ${o.name}: ${w.message.split('\n')[0]}; the route goes on` };
  }
  let tries = 0;
  while (ctx.alive()) {
    if (elapsed() >= NODE_TIMEOUT_MS) return { ok: false, message: `${o.name}: no portal space in ${NODE_TIMEOUT_MS / 1000} s (${tries} uses); the route goes on` };
    const from = myPos(api);
    const mark = api.currentSeq();
    tries++;
    const r = await api.use(guid);
    if (!r.ok && !entered(api, mark) && /couldn't reach|can't use|refused/i.test(r.message) && tries >= 3) return { ok: false, message: `${o.name}: ${r.message.split('\n')[0]}; the route goes on` };
    if (!(await until(ctx, () => entered(api, mark), Math.max(0, Math.min(2000, NODE_TIMEOUT_MS - elapsed()))))) continue;
    spent = elapsed();
    const trip = await waitArrival(ctx, mark);
    started = ctx.now();
    const to = myPos(api);
    // Out again where it went in: no trip (VTank tries again).
    if (from && to && Math.hypot(to.x - from.x, to.y - from.y) <= PORTAL_EXIT_NEAR_M) continue;
    return { ok: true, message: `went through ${o.name}${tries > 1 ? ` (${tries} uses)` : ''}; ${Math.round(trip / 1000)} s in portal space` };
  }
  return { ok: false, message: 'stopped' };
}

/**
 * VTank's checkpoint, once you are at it: the client runs a little ahead of
 * the server, so wait until the server's own echo of your position is within
 * `within` of the point. After CHECKPOINT_NUDGE_MS it inches forward and says
 * so; the route stays at the point (the next pass waits again). A host that
 * can't say where the server has you is taken at your word (as VTank does
 * before any echo).
 */
export async function runCheckpoint(ctx: NodeCtx, coords: string, within: number): Promise<AgentResult> {
  const { api } = ctx;
  const g = parseMapCoords(coords);
  if (!g) return { ok: true, message: 'checkpoint has no coordinates' };
  const t0 = ctx.now();
  const off = (): number => {
    const s = api.serverPosition() ?? myPos(api);
    return s ? Math.hypot(s.x - g.x, s.y - g.y) : 0;
  };
  if (await until(ctx, () => off() <= within, CHECKPOINT_NUDGE_MS)) return { ok: true, message: `the server has you at the checkpoint${ctx.now() - t0 >= 500 ? ` (after ${Math.round((ctx.now() - t0) / 1000)} s)` : ''}` };
  if (!ctx.alive()) return { ok: false, message: 'stopped' };
  const d = off();
  await api.move('forward', 0.1);
  return { ok: false, message: `the server still has you ${d.toFixed(1)} m off after ${CHECKPOINT_NUDGE_MS / 1000} s; inched forward` };
}

// ── doors ──

/**
 * VTank's door test: a door is on the way when it is within DOOR_CORRIDOR_M
 * of the straight line from you to the point, ahead of you and not past the
 * point, and at the height the line has there (when the point's height is known).
 */
export function doorOnRoute(door: { x: number; y: number; dz: number }, me: { x: number; y: number }, goal: { x: number; y: number; dz?: number }): boolean {
  const dx = goal.x - me.x, dy = goal.y - me.y;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 0) return false;
  const px = door.x - me.x, py = door.y - me.y;
  const f = (px * dx + py * dy) / len2;
  if (f <= 0 || f > 1) return false;
  const ox = px - f * dx, oy = py - f * dy;
  return ox * ox + oy * oy <= DOOR_CORRIDOR_M * DOOR_CORRIDOR_M && Math.abs(door.dz - f * (goal.dz ?? 0)) <= DOOR_CORRIDOR_M;
}

/** What the door's appraisal says about its lock: locked, and the lock's difficulty when known. */
export function doorLock(data: { int?: Record<number, number>; bool?: Record<number, boolean> } | null): { locked: boolean; difficulty?: number } {
  if (!data) return { locked: false };
  const difficulty = data.int?.[PROP_INT_RESIST_LOCKPICK];
  return { locked: data.bool?.[PROP_BOOL_LOCKED] === true || difficulty !== undefined, ...(difficulty !== undefined ? { difficulty } : {}) };
}

/**
 * The lockpick to use on a locked door: one you carry that the Consumables tab
 * lists, the best by its modifiers (ACE: skill × PropertyFloat 40 + PropertyInt
 * 88), and only when your Lockpick skill is at least the lock's difficulty plus
 * DoorLockpickDiffExcessThreshold (VTank's -50 by default). Null, with why, when none.
 */
export function chooseLockpick(items: AgentItem[], consumables: string[], skill: number | null, difficulty: number | undefined, threshold: number, data: (guid: number) => { int?: Record<number, number>; float?: Record<number, number> } | null): { item: AgentItem } | { why: string } {
  const listed = new Set(consumables.map((c) => c.trim().toLowerCase()));
  const picks = items.filter((i) => ((i.objectDescFlags ?? 0) & LOCKPICK_FLAG) !== 0 && listed.has(i.name.toLowerCase()));
  if (!picks.length) return { why: 'no lockpick on the Consumables tab in your pack' };
  if (skill === null) return { why: 'you have no Lockpick skill' };
  if (difficulty !== undefined && skill < difficulty + threshold) return { why: `Lockpick ${skill} is under its difficulty ${difficulty} ${threshold < 0 ? '−' : '+'} ${Math.abs(threshold)}` };
  const score = (i: AgentItem): number => { const d = data(i.guid); return skill * (d?.float?.[PROP_FLOAT_LOCKPICK_MOD] ?? 1) + (d?.int?.[PROP_INT_LOCKPICK_MOD] ?? 0); };
  return { item: [...picks].sort((a, b) => score(b) - score(a))[0] };
}

export interface DoorOptions {
  idRange: number;
  openRange: number;
  threshold: number;
  consumables: string[];
  /** Doors left alone until a time (guid → now() ms). */
  skip: Map<number, number>;
}

/**
 * VTank's OpenDoors, before a leg of the route: the nearest closed door on the
 * way within DoorIDRange is identified (its appraisal carries the lock), walked
 * to within DoorOpenRange and used; a locked one is picked first with a
 * Consumables lockpick, or skipped. Null when there is no door to deal with.
 */
export async function openDoorOnTheWay(ctx: NodeCtx, goal: { x: number; y: number; dz?: number }, o: DoorOptions): Promise<AgentResult | null> {
  const { api } = ctx;
  const me = myPos(api);
  if (!me) return null;
  const t = ctx.now();
  for (const [g, until] of o.skip) if (until <= t) o.skip.delete(g);
  // A door only its lever or switch opens (ItemUseable No) is no door to open by hand: the nav walk goes round or stops.
  const door = api.nearby(o.idRange).filter((d) => d.kind === 'door' && d.open === false && !d.notByHand && !o.skip.has(d.guid))
    .filter((d) => doorOnRoute({ ...objectAt(me, d), dz: d.dz }, me, goal))[0];
  if (!door) return null;
  if (!api.itemData(door.guid)) void api.appraise(door.guid, { quiet: true });
  if (door.dist > o.openRange) {
    const w = await api.walkTo(door.guid, { within: Math.max(0.5, o.openRange - 0.25), timeoutMs: 20_000 });
    if (!w.ok) { o.skip.set(door.guid, ctx.now() + DOOR_SKIP_MS); return { ok: false, message: `couldn't reach ${door.name}: ${w.message.split('\n')[0]}` }; }
  }
  await until(ctx, () => !!api.itemData(door.guid), 1500);
  const lock = doorLock(api.itemData(door.guid));
  const isOpen = () => api.nearby(o.idRange + 5).find((d) => d.guid === door.guid)?.open === true;
  let how = 'opened';
  if (lock.locked) {
    const skill = api.skillList().find((s) => s.id === LOCKPICK_SKILL);
    const pick = chooseLockpick(api.inventory(), o.consumables, skill && skill.training !== 'untrained' ? skill.buffed : null, lock.difficulty, o.threshold, (g) => api.itemData(g));
    if ('why' in pick) { o.skip.set(door.guid, ctx.now() + DOOR_SKIP_MS); return { ok: false, message: `locked door skipped: ${door.name} (${pick.why})` }; }
    const r = api.useOn(pick.item.guid, door.guid);
    if (!r.ok) { o.skip.set(door.guid, ctx.now() + DOOR_SKIP_MS); return { ok: false, message: `${door.name}: ${r.message}` }; }
    await ctx.sleep(1500);
    how = `picked with ${pick.item.name} and opened`;
  }
  await api.use(door.guid);
  if (await until(ctx, isOpen, DOOR_OPEN_WAIT_MS)) return { ok: true, message: `${how} ${door.name}` };
  o.skip.set(door.guid, ctx.now() + DOOR_SKIP_MS);
  return { ok: false, message: `${door.name} didn't open in ${DOOR_OPEN_WAIT_MS / 1000} s${lock.locked ? ' (still locked?)' : ''}; leaving it` };
}
