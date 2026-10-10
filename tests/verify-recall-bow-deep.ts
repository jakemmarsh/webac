/**
 * Recall animation: verify the BowDeep motion-id is correct + used symbolically.
 *
 * Bug history: `main.ts handleRecallCommand` previously called
 *   animController.playEmote(0x80000025)  // BowDeep recall animation
 * but 0x80000025 is NOT a defined MotionCommand value in ACE. The actual
 * BowDeep id is 0x1300007d (per reference/ACE/Source/ACE.Entity/Enum/
 * MotionCommand.cs:132). The recall animation has been silently miswired
 * since Step 72. FAITHFUL.141 imported `MotionCommand` and replaced the
 * bare-hex with `MotionCommand.BowDeep`.
 *
 * Pins:
 *  1. The TS MotionCommand port has BowDeep = 0x1300007d (ACE-anchored).
 *  2. The ACE source still has BowDeep = 0x1300007d.
 *  3. main.ts handleRecallCommand uses the symbolic constant; the
 *     0x80000025 literal is gone.
 */
import { describe, it, expect } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { MotionCommand } from '../packages/renderer/src/animation/MotionCommands.js';

const REPO = resolve(__dirname, '..');
const ACE_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/MotionCommand.cs');

describe('MotionCommand.BowDeep value (FAITHFUL.141)', () => {
  it('TS port = 0x1300007d', () => {
    expect(MotionCommand.BowDeep).toBe(0x1300007d);
  });
});

describe.skipIf(!aceReferenceExists(ACE_PATH))('ACE MotionCommand.BowDeep source anchor', () => {
  it('ACE C# has BowDeep = 0x1300007d', () => {
    const src = readFileSync(ACE_PATH, 'utf8');
    expect(src).toMatch(/BowDeep\s*=\s*0x1300007d/);
  });
});

describe('handleRecallCommand integration (FAITHFUL.502 supersedes .141)', () => {
  const src = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');
  const recallFn = src.match(/function handleRecallCommand[\s\S]+?^    \}/m)?.[0] ?? '';

  it('no longer plays a local BowDeep emote inside handleRecallCommand (FAITHFUL.502)', () => {
    // FAITHFUL.502 — BowDeep was the WRONG motion. ACE Player_Location.cs
    // broadcasts MotionCommand.LifestoneRecall (and parallel motions for
    // House/Mansion/Marketplace) via SendMotionAsCommands AFTER the
    // eligibility checks pass. The broadcast includes self via
    // LocalBroadcastRange, so the correct motion plays without any
    // client-side preemption.
    expect(recallFn).not.toMatch(/playEmote\(MotionCommand\.BowDeep\)/);
  });

  it('no longer emits a local "Recalling to ..." echo (FAITHFUL.502)', () => {
    // ACE Player_Location.cs:169 broadcasts the canonical
    // "{Name} is recalling to the lifestone." line via SystemChat.
    expect(recallFn).not.toMatch(/addSystemMessage\(`Recalling to/);
  });

  it('no longer uses the wrong 0x80000025 literal anywhere (FAITHFUL.141 anchor preserved)', () => {
    expect(src).not.toMatch(/playEmote\(0x80000025\)/);
  });

  it('imports MotionCommand from animation/MotionCommands.js (other call sites still use it)', () => {
    expect(src).toMatch(/import\s*\{[^}]*\bMotionCommand\b[^}]*\}\s*from\s*['"]\.\/animation\/MotionCommands\.js['"]/);
  });
});
