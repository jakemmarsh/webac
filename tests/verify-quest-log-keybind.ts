/**
 * FAITHFUL.239 / VISUAL.127 — the quest/contract log is a keyboard command.
 *
 * `toggleContractPanel()` exists in GameUI and contracts are tracked via
 * `onContractTracker`; VISUAL.127 made "Show/Hide Contracts Page" a
 * rebindable KeybindRegistry command the router dispatches to
 * toggleContractPanel(). Asserted behaviorally against the shipped registry.
 *
 * CORE.17.k.b.b.a.g.f — the retail KeyMap DAT (portal 0x14000000
 * gmDefaultMap, section 0x10000009) gives the Contracts page NO default key
 * (Q is Autorun in section 0x4), so the command ships unbound and is reached
 * through Options → Configure Keyboard, as in retail.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { KeybindRegistry } from '@ac/renderer/input/KeybindRegistry.js';
import { ActionClass } from '@ac/renderer/input/KeybindActionClass.js';
import { ACT, DEFAULT_KEYBINDS } from '@ac/renderer/input/KeybindDefaults.js';

const REPO = resolve(__dirname, '..');
const MAIN_TS = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');

describe('FAITHFUL.239 / VISUAL.127 — the Contracts Page command', () => {
  it('is a UI-class command that ships unbound (retail gives it no key); Q is Autorun', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    expect(r.action(ACT.ShowHideContractsPage)?.cls).toBe(ActionClass.UI);
    expect(r.getMappings(ACT.ShowHideContractsPage)).toEqual([null, null, null]);
    expect(r.resolve('KeyQ')).toBe(ACT.Autorun);
  });

  it('can be bound by the player and then resolves', () => {
    const r = new KeybindRegistry(DEFAULT_KEYBINDS);
    r.setMapping(ACT.ShowHideContractsPage, 0, 'KeyV');
    expect(r.resolve('KeyV')).toBe(ACT.ShowHideContractsPage);
  });

  it('the router dispatches the Contracts command to toggleContractPanel', () => {
    expect(MAIN_TS).toMatch(/case ACT\.ShowHideContractsPage: gameUI\.toggleContractPanel\(\)/);
  });

  it('toggleContractPanel is still defined in GameUI', () => {
    const ui = readFileSync(resolve(REPO, 'packages/renderer/src/ui/GameUI.ts'), 'utf-8');
    expect(ui).toContain('toggleContractPanel(): void {');
  });
});
