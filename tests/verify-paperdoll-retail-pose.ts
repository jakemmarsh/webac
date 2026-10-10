/**
 * BUG.paperdoll-copies-combat-stance — the paperdoll cloned the live
 * player model, pose included, so after a re-render (e.g. refocusing the
 * window) the doll stood in combat stance. Retail gmPaperDollUI::
 * RedressCreature @ 004a3bc0 makes a fresh object and holds frame 1 of
 * m_didAnimation (0x10000005 PaperDollAnimation; Olthoi 0x10000011 /
 * Olthoi Acid 0x10000013 via UpdateForRace @ 004a3ed0).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import {
  ChargenAnimationEnum, PaperdollPoser, paperdollAnimationEnum, paperdollFrameIndex,
  HERITAGE_OLTHOI, HERITAGE_OLTHOI_ACID, CHARGEN_ANIMATION_DIDS,
} from '../packages/renderer/src/ui/ChargenViewAnimation.js';
import { openDat as openTestDat } from './_harness/dat.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { Animation } from '../packages/dat-parser/src/file-types/Animation.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';

const PORTAL = resolve(__dirname, '..', 'dat/client_portal.dat');
const hasDat = fs.existsSync(PORTAL);

function figure(parts: number): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < parts; i++) {
    const p = new THREE.Object3D();
    p.name = `part_${i}`;
    // a "combat stance": every part twisted and displaced
    p.position.set(9, 9, 9);
    p.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.2);
    g.add(p);
  }
  return g;
}

describe('paperdoll animation choice (no DAT)', () => {
  it('humans and the other heritages use PaperDollAnimation; Olthoi use their own', () => {
    expect(paperdollAnimationEnum(1)).toBe(ChargenAnimationEnum.PaperDollAnimation);
    expect(paperdollAnimationEnum(9)).toBe(ChargenAnimationEnum.PaperDollAnimation);
    expect(paperdollAnimationEnum(HERITAGE_OLTHOI)).toBe(ChargenAnimationEnum.CharGenOlthoiAnimation);
    expect(paperdollAnimationEnum(HERITAGE_OLTHOI_ACID)).toBe(ChargenAnimationEnum.CharGenOlthoiAcidAnimation);
  });
  it('holds low frame 1, clamped for a one-frame animation', () => {
    expect(paperdollFrameIndex(30)).toBe(1);
    expect(paperdollFrameIndex(1)).toBe(0);
  });
  it('without a portal DAT the poser leaves the figure alone', () => {
    const g = figure(2);
    expect(new PaperdollPoser(null).pose(g, 1)).toBe(false);
    expect(g.children[0].position.x).toBe(9);
  });
});

describe.skipIf(!hasDat)('paperdoll pose from the DAT', () => {
  let db: DatDatabase;
  beforeAll(() => { db = openTestDat('dat/client_portal.dat'); });

  it('resolves PaperDollAnimation through DidMapper 0x25000010', () => {
    expect(new PaperdollPoser(db).animationDid(1)).toBe(CHARGEN_ANIMATION_DIDS[ChargenAnimationEnum.PaperDollAnimation]);
  });

  it('overwrites a live combat pose with PaperDollAnimation frame 1', () => {
    const did = new PaperdollPoser(db).animationDid(1);
    const anim = new Animation(new DatReader(db.getFileData(did)!));
    const g = figure(anim.numParts);
    expect(new PaperdollPoser(db).pose(g, 1)).toBe(true);
    const f = anim.partFrames[paperdollFrameIndex(anim.numFrames)].frames[0];
    const p0 = g.children[0];
    // AC Z-up → three Y-up (AnimatedEntity.applyPartTransforms)
    expect(p0.position.x).toBeCloseTo(f.origin.x, 5);
    expect(p0.position.y).toBeCloseTo(f.origin.z, 5);
    expect(p0.position.z).toBeCloseTo(f.origin.y, 5);
    expect(p0.quaternion.w).toBeCloseTo(f.orientation.w, 5);
    for (const c of g.children) expect(c.position.x).not.toBe(9);
  });
});
