/**
 * FAITHFUL.257 — Refactor active-enchantments HUD indicator to use
 * setIndicatorActive (the shared helper introduced in FAITHFUL.255).
 *
 * Pre-fix `updateEnchantmentIndicator` had its own DOM-mutation path with
 * hard-coded tex IDs (0x06002629 / 0x06004ceb) duplicated from the
 * `indicatorDefs` array. Refactor routes through `setIndicatorActive` so all
 * live indicators share one code path and the tex IDs live in exactly one
 * place. CORE.5.b: the EoL strip has TWO gmUIElement_EffectsIndicator
 * elements — beneficial 0x100000f5 / harmful 0x100000f6.
 *
 * The "active" criterion is unchanged: any beneficial enchantment lights the
 * beneficial indicator; any non-beneficial non-vitae non-cooldown
 * enchantment lights the harmful one; vitae has its own indicator
 * (FAITHFUL.255) and cooldowns aren't gameplay-visible spell effects.
 *
 * Behavioural: the real GameUI with its indicator strip rendered through a
 * stub LayoutRenderer; enchantments go in through the public add/remove/clear.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const ench = (spellId: number, over: Partial<{ isBeneficial: boolean; isVitae: boolean; isCooldown: boolean }>) => ({
  spellId, layer: 1, name: `Spell ${spellId}`, iconId: 0, isBeneficial: false, isVitae: false, isCooldown: false,
  duration: 60, startTime: 0, casterGuid: 0, ...over,
});

describe('FAITHFUL.257 — enchantment indicators route through setIndicatorActive (behavioural)', () => {
  let H: GameUIFixture;
  let calls: Array<[string, boolean]>;

  beforeAll(async () => {
    H = await mountGameUI();
    const win = H.win;
    const render = (_layoutId: number, parent: HTMLElement) => {
      const root = win.document.createElement('div');
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      const get = elements.get.bind(elements);
      elements.get = (id: number) => {
        let el = get(id);
        if (!el) { el = win.document.createElement('div') as HTMLElement; root.appendChild(el); elements.set(id, el); }
        return el;
      };
      return {
        root, elements, descs: new Map(),
        setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {}, setTexture: () => {},
        onClick: () => {}, close: () => root.remove(), destroy: () => root.remove(),
      };
    };
    H.ui.layoutRenderer = { render, renderPanel: render, setFontResolver: () => {} };
    // Distinct fake data URLs per texture id so the swapped background is observable.
    for (const id of [0x0600749c, 0x0600749d, 0x0600749e, 0x0600749f]) H.ui.uiTextures.set(id, `data:tex-${id.toString(16)}`);
    H.ui.renderIndicatorsStrip();
    const real = H.ui.setIndicatorActive.bind(H.ui);
    H.ui.setIndicatorActive = (id: string, on: boolean) => { calls.push([id, on]); real(id, on); };
  });
  afterAll(() => H.teardown());
  beforeEach(() => { calls = []; H.ui.clearEnchantments(); calls = []; });

  const last = (id: string) => [...calls].reverse().find(([k]) => k === id)?.[1];

  it('a beneficial enchantment lights effects-beneficial only', () => {
    H.ui.addEnchantment(ench(1, { isBeneficial: true }));
    expect(last('effects-beneficial')).toBe(true);
    expect(last('effects-harmful')).toBe(false);
  });

  it('a harmful enchantment lights effects-harmful only', () => {
    H.ui.addEnchantment(ench(2, {}));
    expect(last('effects-harmful')).toBe(true);
    expect(last('effects-beneficial')).toBe(false);
  });

  it('vitae and cooldown enchantments do NOT light the harmful indicator', () => {
    H.ui.addEnchantment(ench(3, { isVitae: true }));
    H.ui.addEnchantment(ench(4, { isCooldown: true }));
    expect(last('effects-harmful')).toBe(false);
  });

  it('removeEnchantment and clearEnchantments re-evaluate the indicators', () => {
    H.ui.addEnchantment(ench(5, {}));
    expect(last('effects-harmful')).toBe(true);
    H.ui.removeEnchantment(5, 1);
    expect(last('effects-harmful')).toBe(false);
    H.ui.addEnchantment(ench(6, { isBeneficial: true }));
    calls = [];
    H.ui.clearEnchantments();
    expect(last('effects-beneficial')).toBe(false);
  });

  it('the swap uses the indicatorDefs textures (harmful lit 0x0600749e / dark 0x0600749f)', () => {
    expect(H.ui.indicatorTexById.get('effects-harmful')).toMatchObject({ texActive: 0x0600749e, texInactive: 0x0600749f });
    expect(H.ui.indicatorTexById.get('effects-beneficial')).toMatchObject({ texActive: 0x0600749c, texInactive: 0x0600749d });
    const icon = H.win.document.getElementById('hud-indicator-effects-harmful') as HTMLElement;
    expect(icon).not.toBeNull();
    expect(icon.style.backgroundImage).toContain('tex-600749f');
    H.ui.addEnchantment(ench(7, {}));
    expect(icon.style.backgroundImage).toContain('tex-600749e');
    // The pre-refactor hard-coded pair never appears.
    expect(icon.style.backgroundImage).not.toMatch(/6002629|6004ceb/);
  });
});
