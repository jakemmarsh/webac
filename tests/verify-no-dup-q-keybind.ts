/**
 * FAITHFUL.262 / VISUAL.127 — Q maps to exactly one command, no duplicate.
 *
 * Pre-FAITHFUL.262 the hardcoded keydown switch had two `case 'q'` arms (the
 * second unreachable). VISUAL.127 replaced the switch with the rebindable
 * KeybindRegistry, where a physical key resolves to at most ONE command among
 * the co-active input maps by construction — so "no duplicate Q binding" is a
 * structural guarantee of the registry, asserted behaviorally rather than by
 * counting source `case`s. The dead `selectNearestTarget` helper remains removed.
 *
 * CORE.17.k.b.b.a.g.f — Q's retail default is Autorun (gmDefaultMap section
 * 0x4: DIK_Q 0x10 → action 0x30), not our invented Contracts page.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { KeybindRegistry } from '@ac/renderer/input/KeybindRegistry.js';
import { ACT, DEFAULT_KEYBINDS } from '@ac/renderer/input/KeybindDefaults.js';

const REPO = resolve(__dirname, '..');
const MAIN_TS = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');

describe('FAITHFUL.262 / VISUAL.127 — Q resolves to a single command', () => {
  it('KeyQ resolves to exactly the retail Autorun command', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    expect(r.resolve('KeyQ')).toBe(ACT.Autorun);
    expect(r.ownersOf('KeyQ')).toEqual([ACT.Autorun]);
  });

  it('the registry maps each key to at most one co-active command (no duplicates possible)', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    // Binding a key elsewhere in a co-active map removes it from its
    // previous owner (the UI map 0x10000009 is co-active with movement 0x4).
    r.setMapping(ACT.ShowHideInventoryPanel, 1, 'KeyQ');
    expect(r.resolve('KeyQ')).toBe(ACT.ShowHideInventoryPanel);
    expect(r.getMappings(ACT.Autorun).includes('KeyQ')).toBe(false);
  });

  it('selectNearestTarget dead code stays removed', () => {
    expect(MAIN_TS).not.toContain('function selectNearestTarget');
    expect(MAIN_TS).not.toMatch(/selectNearestTarget\(\)/);
  });
});
