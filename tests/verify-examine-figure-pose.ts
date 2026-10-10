/**
 * BUG.examine-copies-live-pose — the examine viewport cloned the live
 * world mesh, pose included, so a player examined mid-run (or mid-attack)
 * showed that frame. Retail BasicCreatureExamineUI::Init @ 004ab9c0 shows
 * CPhysicsObj::makeObject(obj): a fresh object in its motion table's
 * default state (defaultStyle / styleDefaults), none of the live motion.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { ExamineFigurePoser, defaultCycleAnim, startFrameIndex } from '../packages/renderer/src/ui/ExamineFigurePose.js';
import { openDat as openTestDat } from './_harness/dat.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { Animation } from '../packages/dat-parser/src/file-types/Animation.js';
import { MotionTable } from '../packages/dat-parser/src/file-types/MotionTable.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';

const PORTAL = resolve(__dirname, '..', 'dat/client_portal.dat');
const hasDat = fs.existsSync(PORTAL);

/** The human motion table (players). */
const HUMAN_MTABLE = 0x09000001;
/** AC MotionStance.NonCombat / MotionCommand.Ready. */
const NON_COMBAT = 0x8000003d;
const READY = 0x41000003;

function figure(parts: number): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < parts; i++) {
    const p = new THREE.Object3D();
    p.name = `part_${i}`;
    // a "mid-run" pose: every part twisted and displaced
    p.position.set(9, 9, 9);
    p.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.2);
    g.add(p);
  }
  return g;
}

describe('examine figure rest frame (no DAT)', () => {
  it('starts on the low frame, or the resolved high frame when playing backwards', () => {
    expect(startFrameIndex({ animId: 1, lowFrame: 0, highFrame: -1, framerate: 30 }, 40)).toBe(0);
    expect(startFrameIndex({ animId: 1, lowFrame: 5, highFrame: -1, framerate: 30 }, 40)).toBe(5);
    expect(startFrameIndex({ animId: 1, lowFrame: 0, highFrame: -1, framerate: -30 }, 40)).toBe(39);
    expect(startFrameIndex({ animId: 1, lowFrame: 50, highFrame: 60, framerate: 30 }, 40)).toBe(39);
  });
  it('without a portal DAT the poser leaves the figure alone', () => {
    const g = figure(2);
    expect(new ExamineFigurePoser(null).pose(g, HUMAN_MTABLE)).toBe(false);
    expect(g.children[0].position.x).toBe(9);
  });
});

describe.skipIf(!hasDat)('examine figure pose from the DAT', () => {
  let db: DatDatabase;
  beforeAll(() => { db = openTestDat('dat/client_portal.dat'); });

  it('the human table defaults to NonCombat / Ready', () => {
    const table = new MotionTable(new DatReader(db.getFileData(HUMAN_MTABLE)!));
    expect(table.defaultStyle >>> 0).toBe(NON_COMBAT);
    expect(table.styleDefaults.get(table.defaultStyle)! >>> 0).toBe(READY);
    expect(defaultCycleAnim(table)).not.toBeNull();
  });

  it('overwrites a live mid-run pose with the default cycle\'s first frame', () => {
    const table = new MotionTable(new DatReader(db.getFileData(HUMAN_MTABLE)!));
    const animData = defaultCycleAnim(table)!;
    const anim = new Animation(new DatReader(db.getFileData(animData.animId)!));
    const g = figure(anim.numParts);
    expect(new ExamineFigurePoser(db).pose(g, HUMAN_MTABLE)).toBe(true);
    const f = anim.partFrames[startFrameIndex(animData, anim.numFrames)].frames[0];
    const p0 = g.children[0];
    // AC Z-up → three Y-up (AnimatedEntity.applyPartTransforms)
    expect(p0.position.x).toBeCloseTo(f.origin.x, 5);
    expect(p0.position.y).toBeCloseTo(f.origin.z, 5);
    expect(p0.position.z).toBeCloseTo(f.origin.y, 5);
    expect(p0.quaternion.w).toBeCloseTo(f.orientation.w, 5);
    for (const c of g.children) expect(c.position.x).not.toBe(9);
  });

  it('two examines of the same figure land on the same pose whatever the live frame', () => {
    const poser = new ExamineFigurePoser(db);
    const table = new MotionTable(new DatReader(db.getFileData(HUMAN_MTABLE)!));
    const parts = new Animation(new DatReader(db.getFileData(defaultCycleAnim(table)!.animId)!)).numParts;
    const a = figure(parts), b = figure(parts);
    b.children.forEach((c, i) => c.position.set(-i, i, 2 * i));
    poser.pose(a, HUMAN_MTABLE);
    poser.pose(b, HUMAN_MTABLE);
    a.children.forEach((c, i) => expect(c.position.distanceTo(b.children[i].position)).toBeLessThan(1e-6));
  });
});
