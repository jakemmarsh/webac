/**
 * Effect leaves (STREAM.spell-projectile-first-use, webac#16 item 4): the
 * portal leaves of what the server creates or plays in front of the player
 * with no warning, so a streamed set can carry them in its common pack
 * (loaded in the background at boot, resident for the session) instead of
 * fetching them at the object's CreateObject or the PlayScript that names
 * them. A first-ever spell projectile otherwise flew for ~430 ms as a
 * 3-triangle partial mesh (the 1999 Banderling Captain's Whirling Blade),
 * and a first-ever particle effect arrived a round trip late.
 *
 * Roots (all from the set's own data):
 *   - every ProjectileSpell / Missile / Ammunition weenie's Setup, MotionTable,
 *     PhysicsEffectTable, SoundTable (every Wave) and icons (the world DB the era's server runs: ACE's
 *     dat/world.sqlite, or the AC1999 SQL tree). A client cannot know a
 *     creature's spells or ammunition ahead of its first cast or shot.
 *   - every PhysicsScriptTable 0x34 in the portal DAT, with EVERY script of
 *     every PlayScript (caster / target spell effects, level up, hit and
 *     blood splats, portal storm, fizzle) and their Sound hooks' Waves, not
 *     only the Hidden / UnHide pair DatClosure walks for an arrival.
 *   - every Animation 0x03's CreateParticle emitters and CallPES scripts
 *     (cast gestures, breath attacks; DatClosure does not parse animations).
 *
 * The walk is the client's own (DatClosure.edges over a local-DAT
 * ClosureStore), so the leaves are exactly what the sync builders read.
 * Measured 2026-11-03 (end of retail): ~770 leaves, 7.5 MB raw / ~4.6 MB gz; without
 * the Waves (`waves: false`) 3.8 MB raw / ~1.4 MB gz.
 */
import Database from 'better-sqlite3';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';
import { Animation } from '../../packages/dat-parser/src/file-types/Animation.js';
import { AnimationHookType } from '../../packages/dat-parser/src/file-types/AnimationHook.js';
import { PhysicsScript, PhysicsScriptTable } from '../../packages/dat-parser/src/file-types/PhysicsScript.js';
import { SoundTable } from '../../packages/dat-parser/src/file-types/SoundTable.js';
import { DatClosure, type ClosureStore } from '../../packages/renderer/src/dat/streaming/DatClosure.js';
import { type FileKey, fileKey, splitFileKey } from '../../packages/renderer/src/dat/streaming/DatStore.js';
import { LocalClosureStore, isPortalLeaf } from './area-packs.js';

/** ACE WeenieType (ACE.Entity/Enum/WeenieType.cs): what the server creates mid-fight. */
export const EFFECT_WEENIE_TYPES: ReadonlySet<number> = new Set([
  4, // Missile (thrown weapons)
  5, // Ammunition (arrows, bolts, darts in flight)
  33, // ProjectileSpell
]);
/**
 * PropertyDataId roots: Setup (1), MotionTable (2) and PhysicsEffectTable (22), what
 * ArrivalEvents.appearanceRoots reads; SoundTable (3), whose launch / impact Waves play at
 * once; and the icon DIDs GameUI.itemIconFileIds prefetches at every CreateObject (Icon 8,
 * IconOverlay 50, IconOverlaySecondary 51, IconUnderlay 52).
 */
const ROOT_DIDS: ReadonlySet<number> = new Set([1, 2, 3, 8, 22, 50, 51, 52]);

/** The effect weenies' portal roots from an ACE-schema world DB (dat/world.sqlite). */
export function effectWeenieRootsFromWorldDb(path: string): number[] {
  const db = new Database(path, { readonly: true });
  try {
    const types = [...EFFECT_WEENIE_TYPES].join(',');
    const dids = [...ROOT_DIDS].join(',');
    const rows = db.prepare(`select distinct d.value as v from weenie w join weenie_properties_d_i_d d on d.object_Id = w.class_Id
      where w.type in (${types}) and d.type in (${dids})`).all() as Array<{ v: number }>;
    return rows.map((r) => r.v >>> 0).filter(Boolean).sort((a, b) => a - b);
  } finally {
    db.close();
  }
}

/**
 * The effect weenies' portal roots from SQL weenie files in ACE's export
 * shape (the AC1999 server's world: reference/ac1999/Server/Database/
 * AC1999-World/3-Core/9 WeenieDefaults/SQL, one file per weenie). The type
 * is read from each file's `weenie` row, not from its folder.
 */
export function effectWeenieRootsFromSql(text: string): number[] {
  const weenie = /INSERT INTO `weenie` \([^)]*\)\s*VALUES\s*\(\s*\d+\s*,\s*'[^']*'\s*,\s*(\d+)/i.exec(text);
  if (!weenie || !EFFECT_WEENIE_TYPES.has(Number(weenie[1]))) return [];
  const block = /INSERT INTO `weenie_properties_d_i_d`[^;]*;/i.exec(text);
  if (!block) return [];
  const out: number[] = [];
  for (const m of block[0].matchAll(/\(\s*\d+\s*,\s*(\d+)\s*,\s*(0x[0-9a-f]+|\d+)\s*\)/gi)) {
    if (!ROOT_DIDS.has(Number(m[1]))) continue;
    const v = Number(m[2]) >>> 0;
    if (v) out.push(v);
  }
  return out;
}

/** effectWeenieRootsFromSql over every .sql file under `dir`. */
export function effectWeenieRootsFromSqlDir(dir: string): number[] {
  const out = new Set<number>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.sql')) for (const id of effectWeenieRootsFromSql(readFileSync(p, 'utf8'))) out.add(id);
    }
  };
  walk(dir);
  return [...out].sort((a, b) => a - b);
}

export interface EffectPlanOptions {
  portal: DatDatabase;
  /** The effect weenies' Setup / MotionTable / PhysicsEffectTable ids (absent files are skipped). */
  weenieRoots: readonly number[];
  /** After every DAT read (the 1999 overlay drops its translation cache now and then). */
  onRead?: () => void;
  /** Also the Waves (sound tables + script Sound hooks): default true. They don't gzip (~90 % of raw). */
  waves?: boolean;
}

export interface EffectPlan {
  /** Portal leaf ids (sorted). */
  leaves: number[];
  /** Of `leaves`, the Waves 0x0A (audio). */
  waves: number[];
  /** Root counts, for the report. */
  roots: { weenies: number; tables: number; hookEmitters: number };
}

/** Plan the effect leaves of one portal DAT (see the file comment for the roots). */
export function planEffectLeaves(opts: EffectPlanOptions): EffectPlan {
  const { portal } = opts;
  const store = new LocalClosureStore({ portal }, opts.onRead);
  const closure = new DatClosure(store as unknown as ClosureStore, {});
  const read = (id: number): DatReader | null => {
    let d: ArrayBuffer | null = null;
    try { d = portal.getFileData(id) ?? null; } catch { d = null; }
    opts.onRead?.();
    return d ? new DatReader(d) : null;
  };
  const ids = portal.listFileIds();
  const tables = ids.filter((id) => id >>> 24 === 0x34);
  const hookRoots = new Set<number>();
  for (const id of ids) {
    if (id >>> 24 !== 0x03) continue;
    const r = read(id);
    if (!r) continue;
    let anim: Animation;
    try { anim = new Animation(r); } catch { continue; } // an animation that does not parse has no hooks to warm
    for (const frame of anim.partFrames) {
      for (const h of frame.hooks as Array<{ hookType: number; emitterInfoId?: number; pes?: number }>) {
        if (h.hookType === AnimationHookType.CreateParticle && h.emitterInfoId) hookRoots.add(h.emitterInfoId >>> 0);
        else if (h.hookType === AnimationHookType.CallPES && h.pes) hookRoots.add(h.pes >>> 0);
      }
    }
  }
  const weenieRoots = opts.weenieRoots.map((id) => id >>> 0).filter((id) => portal.hasFile(id));
  const out = new Set<number>();
  const seen = new Set<FileKey>();
  const stack: FileKey[] = [...weenieRoots, ...tables, ...hookRoots].map((id) => fileKey('portal', id));
  while (stack.length) {
    const k = stack.pop()!;
    if (seen.has(k)) continue;
    seen.add(k);
    const { dat, id } = splitFileKey(k);
    if (dat !== 'portal' || !portal.hasFile(id)) continue;
    if (opts.waves === false && (id >>> 24 === 0x20 || id >>> 24 === 0x0a)) continue;
    if (isPortalLeaf(id)) out.add(id);
    for (const c of closure.edges(k)) stack.push(c);
    if (id >>> 24 === 0x20) {
      // An effect weenie's SoundTable: every Wave it can play (launch, impact; Waves are leaves).
      const r = read(id);
      if (!r) continue;
      try {
        const t = SoundTable.read(r);
        for (const d of [...t.soundHash, ...[...t.data.values()].flatMap((sd) => sd.data)]) if (d.soundId) stack.push(fileKey('portal', d.soundId >>> 0));
      } catch { /* an unparseable table has no waves to warm */ }
    } else if (id >>> 24 === 0x33) {
      // A script's own Sound / SoundTweaked hooks name Waves directly (DatClosure walks only its emitters).
      const r = read(id);
      if (!r) continue;
      try {
        for (const step of PhysicsScript.read(r).steps) {
          const h = step.hook as { hookType: number; soundId?: number } | null;
          if (h && (h.hookType === AnimationHookType.Sound || h.hookType === AnimationHookType.SoundTweaked) && h.soundId) stack.push(fileKey('portal', h.soundId >>> 0));
        }
      } catch { /* no hooks to warm */ }
    } else if (id >>> 24 === 0x34) {
      // Every PlayScript's scripts: the arrival walk takes only Hidden / UnHide.
      const r = read(id);
      if (!r) continue;
      try {
        for (const list of PhysicsScriptTable.read(r).scripts.values()) for (const e of list) if (e.scriptId) stack.push(fileKey('portal', e.scriptId >>> 0));
      } catch { /* an unparseable table has no scripts to warm */ }
    }
  }
  return {
    leaves: [...out].sort((a, b) => a - b),
    waves: [...out].filter((id) => id >>> 24 === 0x0a).sort((a, b) => a - b),
    roots: { weenies: weenieRoots.length, tables: tables.length, hookEmitters: hookRoots.size },
  };
}

/**
 * The effect leaves a LIVE set's common pack still lacks: published as leaves
 * of the set (the manifest), not in its boot / world / ui packs (resident
 * already) and not in its common pack yet. Sorted.
 */
export function effectLeavesToAdd(effectLeaves: readonly number[], set: {
  manifestLeaves: ReadonlySet<number> | ReadonlyMap<number, unknown>;
  inPacks: ReadonlySet<number>;
  commonIds: ReadonlySet<number>;
}): number[] {
  const out = new Set<number>();
  for (const raw of effectLeaves) {
    const id = raw >>> 0;
    if (set.manifestLeaves.has(id) && !set.inPacks.has(id) && !set.commonIds.has(id)) out.add(id);
  }
  return [...out].sort((a, b) => a - b);
}
