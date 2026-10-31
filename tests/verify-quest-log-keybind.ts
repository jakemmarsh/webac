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
import { KeybindRegistry } from '@ac/renderer/input/KeybindRegistry.js';
import { ActionClass } from '@ac/renderer/input/KeybindActionClass.js';
import { ACT, DEFAULT_KEYBINDS } from '@ac/renderer/input/KeybindDefaults.js';
import { dispatchGameAction, type ActionHost } from '@ac/renderer/input/ActionDispatch.js';
import { GameUI } from '@ac/renderer/ui/GameUI.js';

/** The shipped dispatcher over a host whose GameUI records what the command calls. */
function dispatched(id: number): string[] {
  const calls: string[] = [];
  const ui = new Proxy({}, { get: (_t, k) => () => { calls.push(String(k)); } });
  const host = new Proxy({} as ActionHost, {
    get: (_t, k) => (k === 'ui' ? ui : k === 'camera' ? {} : k === 'emoteMotion' ? () => undefined : () => { calls.push(`host.${String(k)}`); }),
  });
  dispatchGameAction(id, host);
  return calls;
}

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

  // BUG.keybind-use-closest-corpse — the command is the Contracts PAGE's (0x21000069:0x100005cd's
  // p87): DoVisibilityToggleAction opens the quest panel on that page (toggleContractPage).
  it('the router dispatches the Contracts command to the quest panel\'s Contracts page', () => {
    expect(dispatched(ACT.ShowHideContractsPage)).toEqual(['toggleContractPage']);
    expect(dispatched(ACT.ShowHideQuestDetailPanel)).toEqual(['toggleContractPanel']);
  });

  it('GameUI has both toggles', () => {
    expect(typeof GameUI.prototype.toggleContractPanel).toBe('function');
    expect(typeof GameUI.prototype.toggleContractPage).toBe('function');
  });
});
