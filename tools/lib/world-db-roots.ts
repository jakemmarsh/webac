/**
 * The portal data ids of the server objects a landblock starts with, from the
 * ACE world DB (dat/world.sqlite): each static instance's weenie and its
 * generators' children (two levels, as tools/dat-access-sim.ts models them),
 * by PropertyDataId Setup (1), MotionTable (2) and PhysicsEffectTable (22) —
 * what ArrivalEvents.appearanceRoots reads from a CreateObject.
 * RELEASE.streaming-area-packs.
 */
import Database from 'better-sqlite3';

const SETUP = 1, MOTION_TABLE = 2, PHYSICS_EFFECT_TABLE = 22;

export function worldDbRoots(path: string, maxDepth = 1): { roots: (landblock: number) => number[]; close: () => void } {
  const db = new Database(path, { readonly: true });
  const inst = db.prepare('select distinct weenie_Class_Id as w from landblock_instance where landblock = ?');
  const gen = db.prepare('select weenie_Class_Id as w from weenie_properties_generator where object_Id = ?');
  const did = db.prepare(`select value from weenie_properties_d_i_d where object_Id = ? and type in (${SETUP}, ${MOTION_TABLE}, ${PHYSICS_EFFECT_TABLE})`);
  const weenieRoots = new Map<number, number[]>();
  const rootsOf = (wcid: number, depth: number, out: Set<number>, seen: Set<number>): void => {
    if (seen.has(wcid) || depth > maxDepth) return;
    seen.add(wcid);
    let own = weenieRoots.get(wcid);
    if (!own) { own = (did.all(wcid) as Array<{ value: number }>).map((r) => r.value >>> 0).filter(Boolean); weenieRoots.set(wcid, own); }
    for (const id of own) out.add(id);
    for (const g of gen.all(wcid) as Array<{ w: number }>) rootsOf(g.w, depth + 1, out, seen);
  };
  return {
    roots: (landblock) => {
      const out = new Set<number>();
      const seen = new Set<number>();
      for (const r of inst.all(landblock & 0xffff) as Array<{ w: number }>) rootsOf(r.w, 0, out, seen);
      return [...out];
    },
    close: () => db.close(),
  };
}
