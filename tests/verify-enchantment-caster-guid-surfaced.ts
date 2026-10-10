/**
 * BUG.enchantment-caster-guid-dropped — Enchantment.CasterGuid is parsed off
 * the wire for every buff/debuff (MessageSerializer.ts's
 * `parseEnchantmentFromReader`, mirroring ACE `Enchantment.cs:23`'s
 * unconditionally-written `CasterGuid` field, set by all 4 constructors) and
 * survives untouched through ServerMessageHandler's `EnchantmentData` type —
 * but GameUI's `addEnchantment()` parameter type and its `activeEnchantments`
 * map value type both omitted `casterGuid`, so it was silently discarded
 * at that boundary even though every call site in main.ts spreads the full
 * parsed `EnchantmentData` object into `addEnchantment()`.
 *
 * Fix: `addEnchantment`'s param type and `activeEnchantments`'s value type
 * both gained `casterGuid: number`, so the field now survives the existing
 * `{ ...data, appliedAt }` spread instead of being typed away.
 *
 * Drives the real shipped `GameUI.addEnchantment` (happy-dom, per the
 * `verify-magic-purge-bad-distinct.ts` idiom) — not a source-text pin.
 *
 * Note on what actually regresses without the fix: main.ts's call sites
 * spread the full `EnchantmentData` object into `addEnchantment()`, and
 * TypeScript's excess-property check is suppressed for spread expressions,
 * so the *runtime* Map value already carried `casterGuid` even before the
 * type fix — the bug was that the declared types made it impossible for any
 * *typed* consumer (e.g. a future tooltip) to read `.casterGuid` off
 * `addEnchantment`'s parameter or `activeEnchantments`'s value without a
 * compile error. `TYPE_CHECK` below pins that contract at the type level —
 * it fails `tsc -b` (part of every commit's required `npm run build`) if
 * `casterGuid` is ever removed from `addEnchantment`'s parameter type,
 * which a runtime-only test cannot detect.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import type { GameUI } from '../packages/renderer/src/ui/GameUI.js';

type AddEnchantmentArg = Parameters<GameUI['addEnchantment']>[0];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const TYPE_CHECK: AddEnchantmentArg = {
  spellId: 1, layer: 1, name: 'x', iconId: 0,
  isBeneficial: true, isVitae: false, isCooldown: false,
  duration: 0, startTime: 0, casterGuid: 0,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('GameUI.addEnchantment retains casterGuid across the type boundary (requires happy-dom devDep)', () => {
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

  it('stores the casterGuid passed to addEnchantment on the activeEnchantments entry', () => {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui: any = new GameUICtor(container);

    ui.addEnchantment({
      spellId: 1, layer: 1, name: 'Strength Other I', iconId: 0x06001000,
      isBeneficial: true, isVitae: false, isCooldown: false, duration: 60, startTime: 0,
      casterGuid: 0x50012345,
    });

    const ench = (ui.activeEnchantments as Map<string, { casterGuid: number }>).get('1:1');
    expect(ench).toBeDefined();
    expect(ench!.casterGuid).toBe(0x50012345);
  });

  it('keeps distinct casterGuid values for multiple simultaneous enchantments (e.g. self-cast vs. other-cast)', () => {
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui: any = new GameUICtor(container);

    ui.addEnchantment({
      spellId: 2, layer: 1, name: 'Blood Loather', iconId: 0x06001003,
      isBeneficial: false, isVitae: false, isCooldown: false, duration: 30, startTime: 0,
      casterGuid: 0x50099999,
    });
    ui.addEnchantment({
      spellId: 3, layer: 1, name: 'Armor Other I', iconId: 0x06001005,
      isBeneficial: true, isVitae: false, isCooldown: false, duration: 60, startTime: 0,
      casterGuid: 0x50011111,
    });

    const map = ui.activeEnchantments as Map<string, { casterGuid: number }>;
    expect(map.get('2:1')!.casterGuid).toBe(0x50099999);
    expect(map.get('3:1')!.casterGuid).toBe(0x50011111);
  });
});
