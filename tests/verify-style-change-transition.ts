/**
 * BUG.stance-change-no-transition — "there's no transition animation between
 * rest / combat / spellcasting". CMotionTable::GetObjectSequence's STYLE
 * branch (ACE MotionTable.cs:76-117) plays the style change's links — the
 * old substate → the old style's default, get_link(oldStyle, default →
 * newStyle) (the weapon draw / hands readied), or via the DefaultStyle when
 * no direct link exists — then the new style's cycle. MotionManager.
 * changeStyle ports it; the old setStanceFromId snapped. Drives the real
 * MotionManager against the EoL human motion table 0x09000001.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { MotionStance } from '../packages/renderer/src/animation/MotionCommands.js';
import { openDat } from './_harness/dat.js';

const PORTAL = resolve(__dirname, '../dat/client_portal.dat');
const READY = 0x0003;

describe.skipIf(!existsSync(PORTAL))('MotionManager.changeStyle — human motion table 0x09000001', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/index.js');
    db = openDat(PORTAL);
  });
  const fresh = () => {
    const mm = new MotionManager(db);
    expect(mm.loadMotionTable(0x09000001)).toBeTruthy();
    expect(mm.setStanceFromId(MotionStance.NonCombat)).toBe(true);
    return mm;
  };
  const settle = (mm: MotionManager) => { for (let i = 0; i < 400 && mm.isPlayingAction; i++) mm.update(1 / 30); };

  for (const [name, style] of [['melee (sword)', MotionStance.SwordCombat], ['magic', MotionStance.Magic]] as const) {
    it(`peace → ${name}: a transition plays, then the new style's Ready cycle holds`, () => {
      const mm = fresh();
      expect(mm.changeStyle(style)).toBe(true);
      expect(mm.isPlayingAction).toBe(true);
      expect(mm.isChangingStyle).toBe(true);
      expect(mm.currentStyleId).toBe(style);
      settle(mm);
      expect(mm.isPlayingAction).toBe(false);
      expect(mm.isChangingStyle).toBe(false);
      expect(mm.stance).toBe(MotionManager.compositeKey(style, READY));
    });
    it(`${name} → peace animates back`, () => {
      const mm = fresh();
      mm.changeStyle(style); settle(mm);
      expect(mm.changeStyle(MotionStance.NonCombat)).toBe(true);
      expect(mm.isPlayingAction).toBe(true);
      settle(mm);
      expect(mm.stance).toBe(MotionManager.compositeKey(MotionStance.NonCombat, READY));
    });
  }

  it('re-asking for the new idle mid-transition keeps it; running off plays AFTER the draw (remove_cyclic_anims keeps the links)', () => {
    const mm = fresh();
    mm.changeStyle(MotionStance.SwordCombat);
    expect(mm.setForwardMotion(MotionManager.compositeKey(MotionStance.SwordCombat, READY))).toBe(true);
    expect(mm.isChangingStyle).toBe(true);
    const drawAnim = mm.animationPlayer.currentAnimation;
    mm.setForwardMotion(MotionManager.compositeKey(MotionStance.SwordCombat, 0x0007), 1);
    expect(mm.isChangingStyle).toBe(true);
    expect(mm.animationPlayer.currentAnimation).toBe(drawAnim);
    settle(mm);
    expect(mm.stance).toBe(MotionManager.compositeKey(MotionStance.SwordCombat, 0x0007));
  });

  it('the same style is a no-op (GetObjectSequence: style == motion → return)', () => {
    const mm = fresh();
    expect(mm.changeStyle(MotionStance.NonCombat)).toBe(true);
    expect(mm.isPlayingAction).toBe(false);
  });
});
