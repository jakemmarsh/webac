/**
 * BUG.vitae-buffs-stale-char-switch — vitae penalty and buff/debuff icons
 * must not survive a character switch on the same account.
 *
 * ACE anchoring: EnchantmentManager.cs:37 (HasEnchantments) / :42 (HasVitae)
 * and GameEventPlayerDescription.cs:223-224,337-338 — vitae and enchantment
 * state are shipped ONLY via that character's own PlayerDescription
 * Enchantment vector, gated on `Session.Player.EnchantmentManager.
 * HasEnchantments`. For a fresh character with neither, the flag is false
 * and the vector is omitted entirely — nothing else pushes zeroed/absent
 * state to overwrite a stale client-side map.
 *
 * Pre-fix, main.ts's module-scoped playerState/gameUI singletons were only
 * ever populated additively from live onMagicUpdateEnchantment(s) events and
 * never reset on logoff/character-switch/disconnect, so a new character
 * inherited the previous character's vitae percentage (and lit vitae HUD
 * indicator) plus buff/debuff icons until a full page reload.
 *
 * Drives the real VitaeSystem.reset() and GameUI.clearEnchantments()/
 * setIndicatorActive() that main.ts's teardownWorldState() now calls at
 * every logoff/character-switch/disconnect boundary.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { VitaeSystem } from '../packages/shared/src/systems/DeathSystem.js';

describe('VitaeSystem — character switch', () => {
  it('vitaePenalty is 0 before any death', () => {
    const v = new VitaeSystem();
    expect(v.vitaePenalty).toBe(0);
  });

  it('reset() clears an existing penalty', () => {
    const v = new VitaeSystem();
    v.setVitaePenalty(0.05); // ACE's Vitae enchantment after one death
    expect(v.vitaePenalty).toBeGreaterThan(0);

    v.reset();

    expect(v.vitaePenalty).toBe(0);
  });

  it('character switch simulation: a re-entered character with no vitae of its own starts clean', () => {
    const v = new VitaeSystem();
    // Character A dies, accrues vitae.
    v.setVitaePenalty(0.05); // ACE's Vitae enchantment after one death
    expect(v.vitaePenalty).toBeGreaterThan(0);

    // Logoff -> character select -> enter Character B (no page reload).
    // teardownWorldState() runs; ACE never sends a vitae update for B
    // since B's EnchantmentManager.HasVitae is false.
    v.reset();

    expect(v.vitaePenalty).toBe(0);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('GameUI.clearEnchantments — character switch (requires happy-dom devDep)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('character switch simulation: a re-entered character with no buffs of its own starts clean', () => {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui: any = new GameUICtor(container);

    // Character A's active enchantments — one beneficial buff, one harmful debuff.
    ui.addEnchantment({
      spellId: 1, layer: 1, name: 'Strength Other I', iconId: 0x06001000,
      isBeneficial: true, isVitae: false, isCooldown: false, duration: 60, startTime: 0,
    });
    ui.addEnchantment({
      spellId: 2, layer: 1, name: 'Blood Loather', iconId: 0x06001003,
      isBeneficial: false, isVitae: false, isCooldown: false, duration: 30, startTime: 0,
    });
    expect(ui.activeEnchantments.size).toBe(2);

    // Logoff -> character select -> enter Character B (no page reload).
    // teardownWorldState() runs; ACE never sends an enchantment update for
    // B since B's EnchantmentManager.HasEnchantments is false.
    ui.clearEnchantments();

    // B has no buffs/debuffs of its own; the Map must not carry A's forward.
    expect(ui.activeEnchantments.size).toBe(0);
  });

  it('is a no-op when no enchantments were active (fresh character, nothing to clear)', () => {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui: any = new GameUICtor(container);

    ui.clearEnchantments();

    expect(ui.activeEnchantments.size).toBe(0);
  });
});
