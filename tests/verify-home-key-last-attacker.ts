/**
 * FAITHFUL.382 — Home key selects most-recent attacker, fed by
 *  PrivateUpdateInstanceID(CurrentAttacker = 11) from the server.
 *
 * ACE Player_Combat.cs:200-208 emits PrivateUpdatePropertyInstanceID
 * with PropertyInstanceId.CurrentAttacker the first time a new
 * creature attacks the player. Per ACE's inline comment (line 198):
 * "the 'last attacker' functionality in the client, which is bound to
 * the 'home' key by default."
 *
 * Pre-fix the broadcast was console-only and the Home keybind was
 * absent — the feature was completely unwired.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { KeybindRegistry } from '@ac/renderer/input/KeybindRegistry.js';
import { ACT, DEFAULT_KEYBINDS } from '@ac/renderer/input/KeybindDefaults.js';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('lastAttackerGuid is tracked from PrivateUpdateInstanceID(11) (FAITHFUL.382)', () => {
  it('declares lastAttackerGuid: number | null = null', () => {
    expect(MAIN).toMatch(/let lastAttackerGuid: number \| null = null;/);
  });

  it('handler updates lastAttackerGuid when key === 11', () => {
    const block = MAIN.match(/onPrivateUpdatePropertyInstanceID:[\s\S]+?\n      \},/)?.[0] ?? '';
    const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).toMatch(/data\.key === 11/);
    expect(code).toMatch(/lastAttackerGuid = val > 0 \? val : null/);
  });

  it('NaN guard present', () => {
    const block = MAIN.match(/onPrivateUpdatePropertyInstanceID:[\s\S]+?\n      \},/)?.[0] ?? '';
    expect(block).toMatch(/Number\.isFinite\(val\)/);
  });

  it('cites FAITHFUL.382 in the docblock', () => {
    expect(MAIN).toMatch(/FAITHFUL\.382/);
  });
});

// VISUAL.127 routed the keydown handler through the rebindable KeybindRegistry.
// The "Select Last Attacker" command (ACE: bound to Home by default) is now a
// real registry binding the router dispatches to selectTarget(lastAttacker).
describe('Home is bound to "Select Last Attacker" (FAITHFUL.382 / VISUAL.127)', () => {
  it('the default binding resolves Home → SelectLastAttacker command', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    expect(r.resolve('Home')).toBe(ACT.SelectLastAttacker);
  });

  it('SelectLastAttacker is the UI-class command that drives selectTarget', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    expect(r.action(ACT.SelectLastAttacker)?.name).toBe('Select Last Attacker');
    // The router still reads lastAttackerGuid + selects the visible object.
    expect(MAIN).toMatch(/case ACT\.SelectLastAttacker:/);
    expect(MAIN).toMatch(/serverObjectManager\.getObject\(lastAttackerGuid\)/);
    expect(MAIN).toMatch(/selectTarget\(obj\)/);
  });
});
