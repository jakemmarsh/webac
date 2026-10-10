/**
 * SWEEP1006 default-style fallback — CMotionTable::GetObjectSequence
 * @ 00522860 (SubState branch, :282244-282249) looks a substate's cycle up
 * in the current style and then in the table's default style. The human
 * table 0x09000001 has Crouch only in NonCombat; in a combat stance retail
 * still crouches. Ours found nothing and played nothing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { MotionCommand, MotionStance } from '../packages/renderer/src/animation/MotionCommands.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { openDat } from './_harness/dat.js';

const hasDat = fs.existsSync(resolve(__dirname, '..', 'dat/client_portal.dat'));
const HUMAN_MTABLE = 0x09000001;

describe.skipIf(!hasDat)('a substate missing from the combat style plays the default style\'s cycle', () => {
  let db: DatDatabase;
  beforeAll(() => { db = openDat('dat/client_portal.dat'); });

  it('Crouch in HandCombat: no HandCombat cycle in the DAT, yet it plays NonCombat\'s', () => {
    const mm = new MotionManager(db);
    expect(mm.loadMotionTable(HUMAN_MTABLE)).not.toBeNull();
    const hand = MotionStance.HandCombat;
    const key = MotionManager.compositeKey(hand, MotionCommand.Crouch);
    const table = (mm as unknown as { motionTable: { cycles: Map<number, unknown>; defaultStyle: number } }).motionTable;
    expect(table.cycles.has(key)).toBe(false);
    expect(table.cycles.has(MotionManager.compositeKey(table.defaultStyle, MotionCommand.Crouch))).toBe(true);
    expect(mm.requestMotion(key)).toBe(true);
    expect(mm.animationPlayer.currentAnimation).not.toBeNull();
  });
});
