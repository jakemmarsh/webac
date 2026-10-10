/**
 * Every playable heritage's peace ↔ combat style change animates, with no
 * snap — a regression guard over the whole "enter combat mode" surface, not
 * just the human melee / magic pair verify-style-change-transition.ts pins.
 *
 * For each motion table a CharacterGenerator heritage / gender uses
 * (0x0E000002; human, Umbraen, Gear Knight, Tumerok, Lugian, Empyrean,
 * Olthoi …) and each weapon style the table has, MotionManager.changeStyle
 * NonCombat → style and back must play transition links (CMotionTable::
 * GetObjectSequence's style branch) and never jump a part more than a
 * frame-step's worth between 1/120 s samples. Normal motion steps 10–25°;
 * a snap to the next cycle is 90–180°.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { MotionStance } from '../packages/renderer/src/animation/MotionCommands.js';
import { CharacterGenerator } from '../packages/dat-parser/src/file-types/CharacterGenerator.js';
import { openDat } from './_harness/dat.js';

const PORTAL = resolve(__dirname, '../dat/client_portal.dat');
const STYLES = [
  MotionStance.BowCombat, MotionStance.CrossbowCombat, MotionStance.AtlatlCombat, MotionStance.ThrownWeaponCombat,
  MotionStance.ThrownShieldCombat, MotionStance.SwordCombat, MotionStance.SwordShieldCombat,
  MotionStance.TwoHandedSwordCombat, MotionStance.DualWieldCombat, MotionStance.HandCombat, MotionStance.Magic,
];
// The largest intrinsic step in any heritage table (OlthoiAcid 0x09000205's
// shared stance anim 0x03000c47 jumps 49° between its own first frames).
const MAX_STEP_DEG = 60;

const quatAngle = (a: { w: number; x: number; y: number; z: number }, b: typeof a): number =>
  2 * Math.acos(Math.min(1, Math.abs(a.w * b.w + a.x * b.x + a.y * b.y + a.z * b.z))) * 180 / Math.PI;

describe.skipIf(!existsSync(PORTAL))('peace ↔ combat style transitions, every heritage motion table', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  let tables: number[] = [];
  beforeAll(() => {
    db = openDat(PORTAL);
    const cg = new CharacterGenerator(db.getReader(0x0E000002));
    const set = new Set<number>();
    for (const [, h] of cg.heritageGroups) for (const [, sex] of h.genders) set.add(sex.motionTable >>> 0);
    tables = [...set].sort();
  });

  function transition(table: number, from: number, to: number): { played: boolean; maxStep: number } {
    const mm = new MotionManager(db);
    mm.loadMotionTable(table);
    mm.setStanceFromId(from);
    for (let i = 0; i < 20; i++) mm.update(1 / 120);
    let prev = mm.getPartTransforms();
    mm.changeStyle(to);
    const played = mm.isPlayingAction;
    let maxStep = 0;
    for (let i = 0; i < 600 && (i < 4 || mm.isPlayingAction); i++) {
      mm.update(1 / 120);
      const cur = mm.getPartTransforms();
      for (let p = 0; p < Math.min(prev.length, cur.length); p++) maxStep = Math.max(maxStep, quatAngle(prev[p].orientation, cur[p].orientation));
      prev = cur;
    }
    return { played, maxStep };
  }

  it('the heritages resolve to the expected tables (human 0x09000001 among them)', () => {
    expect(tables).toContain(0x09000001);
    expect(tables.length).toBeGreaterThanOrEqual(10);
  });

  it('every weapon style each table has animates in and out without a snap', () => {
    const failures: string[] = [];
    let checked = 0;
    for (const table of tables) {
      const mm = new MotionManager(db);
      mm.loadMotionTable(table);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const defaults: Map<number, number> = (mm as any).motionTable.styleDefaults;
      if (!defaults.has(MotionStance.NonCombat)) continue;
      for (const style of STYLES) {
        if (!defaults.has(style)) continue;
        for (const [label, from, to] of [['enter', MotionStance.NonCombat, style], ['leave', style, MotionStance.NonCombat]] as const) {
          const r = transition(table, from, to);
          checked++;
          if (!r.played || r.maxStep > MAX_STEP_DEG) {
            failures.push(`0x${table.toString(16)} ${label} 0x${(style >>> 0).toString(16)}: played=${r.played} maxStep=${r.maxStep.toFixed(0)}°`);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(failures).toEqual([]);
  });
});
