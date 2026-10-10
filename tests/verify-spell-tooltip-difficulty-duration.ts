/**
 * The spell-bar shortcut tooltip is the spell's NAME alone.
 *
 * FAITHFUL.324 (2026-05) added "Difficulty: N" and "Duration: NmSs" lines
 * to the spell-bar tooltip on the claim "retail tooltips showed both". The
 * decompiled EoL client refutes it (CORE.17.k.b.b.a.g, 2026-09-16):
 * SpellCastSubMenu::UpdateFromPlayerModule @ 004c6570 and AddFavorite @
 * 004c7060 set each shortcut's tooltip to CSpellBase::InqName through
 * UIElement::SetTooltip — no school, mana, level, difficulty, duration or
 * component lines. This test (converted from a source-text pin on the
 * removed lines) drives GameUI.renderSpellBarSlot through happy-dom and
 * asserts the tooltip text carries the name and nothing else.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { spellShortcutTooltip } from '../packages/renderer/src/ui/HudTooltips.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

const SPELL = { id: 2071, name: 'Strength Other IV', school: 2, level: 4, power: 100, manaCost: 40, difficulty: 100, duration: 1800, components: [1, 2, 3], iconId: 0, desc: 'Increases the target\'s Strength by 25 points.' };

describe('the spell-bar tooltip is the spell name alone (SpellCastSubMenu::UpdateFromPlayerModule @ 004c6570)', () => {
  it('spellShortcutTooltip is the identity on the name', () => {
    expect(spellShortcutTooltip(SPELL.name)).toBe('Strength Other IV');
  });
});

describe('GameUI.renderSpellBarSlot — no difficulty / duration / school / mana / level lines', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (g as any).requestAnimationFrame !== 'function') { (g as any).requestAnimationFrame = () => 0; (g as any).cancelAnimationFrame = () => {}; }
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('an occupied shortcut carries exactly the spell name as its tooltip text; the slot has no native title', () => {
    const slot = domWindow.document.createElement('div') as HTMLElement;
    ui.spellBarSlots[ui.activeSpellBarTab][0] = SPELL;
    ui.renderSpellBarSlot(slot, 0);
    expect(slot.dataset.acTooltipText).toBe('Strength Other IV');
    expect(slot.dataset.acTooltipText).not.toMatch(/Difficulty|Duration|School|Mana|Level|Components|\d+m \d+s/);
    expect(slot.getAttribute('title')).toBeNull();
    // The visible slot content is the icon / tint + the shortcut numeral only
    // (CORE.17.k.b.b.a.g.c: the template's 0x1000034a media, no drawn text).
    expect(slot.textContent?.trim()).toBe('');
    expect(slot.querySelector('[data-shortcut-num="1"]')).not.toBeNull();
  });

  it('an empty shortcut has no tooltip and no title', () => {
    const slot = domWindow.document.createElement('div') as HTMLElement;
    ui.spellBarSlots[ui.activeSpellBarTab][1] = null;
    ui.renderSpellBarSlot(slot, 1);
    expect(slot.dataset.acTooltipText).toBeUndefined();
    expect(slot.getAttribute('title')).toBeNull();
  });
});
