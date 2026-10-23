/**
 * SWEEP1999.magic — the 1999 magic HUD as era data (docs/ac1999-support.md, "Magic HUD").
 *
 *  MAG-3  the spell bar's Charge caption + meter (SpellCastSubPanel ctor @ 0x512390,
 *         UpdateChargeMeter @ 0x513390: ftol(charge × 100 + 0.5), "%u%%").
 *  MAG-4  one magic indicator and one "Spells in Effect" window (PanelUI 0x4fa740,
 *         SpellsInEffectPanel ctor @ 0x59ac70).
 *  MAG-5  the spell examine's Duration band (ExamineSpell @ 0x511110: ×0.75 .. ×1.25).
 *  MAG-6  the Cast button's face is its state (UpdateCastButton @ 0x513e00), hover AC_ToolTipHandler 0x55.
 *  MAG-7  learning a spell opens the spellbook on it (SpellbookPanel_AddSpell @ 0x5169d0, param_2).
 *  MAG-8  no spellbook filters; the list in name order (SpellbookPanel ctor / AddSpell).
 *  MAG-10 the component pre-check walks formula slots 1-5 (UI_CastSpell @ 0x4d1bd0).
 *
 * Every rule pins end of retail and Dark Majesty (the end-of-retail exe) unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spellComponentsSatisfied } from '@ac/shared';
import { eraClientRules, unsupportedFeatures, clientRuleHiddenActions, SHOW_HIDE_NEGATIVE_MAGIC_PANEL } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { spellDurationText, spellDurationText1999, buildSpellExamineModel } from '../packages/renderer/src/ui/examine/SpellExamine.js';
import { spellbookNameOrder, spellbookOrder } from '../packages/renderer/src/ui/spellbookFilter.js';
import { buildEffectsRows, combinedEffectsWindow, POSITIVE_EFFECTS, type EffectsEnchantment } from '../packages/renderer/src/ui/EffectsPanelModel.js';
import { castButtonFace, castButtonTooltip, SPELLBAR_CAST_BUTTON, SPELLBAR_SPELL_NAME_TEXT } from '../packages/renderer/src/ui/HudTooltips.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { openDat } from './_harness/dat.js';

const AC1999 = eraClientRules(eraProfile('ac1999-retail'));
const OTHERS = ['eor', 'classic-dereth', 'classicace-customdm'] as const;

describe('the era tables', () => {
  it('1999 carries the 1999 magic HUD; end of retail and Dark Majesty keep end of retail\'s', () => {
    expect(AC1999.spellBarChargeMeter).toBe(true);
    expect(AC1999.combinedEffectsTitle).toBe('Spells in Effect');
    expect(AC1999.spellDurationText).toBe('ac1999');
    expect(AC1999.castButtonText?.noSpells).toBe('You have no spells\nready to cast');
    expect(AC1999.learnOpensSpellbook).toBe(true);
    expect(AC1999.spellbookOrder).toBe('name');
    expect(AC1999.componentPrecheckSlots).toEqual([1, 6]);
    expect(unsupportedFeatures(eraProfile('ac1999-retail')).has('spellbookFilters')).toBe(true);
    for (const id of OTHERS) {
      const r = eraClientRules(eraProfile(id));
      expect([r.spellBarChargeMeter, r.combinedEffectsTitle, r.spellDurationText, r.castButtonText, r.learnOpensSpellbook, r.spellbookOrder], id)
        .toEqual([false, null, 'eor', null, false, 'displayOrder']);
      expect(r.componentPrecheckSlots, id).toEqual([0, 8]);
      expect(unsupportedFeatures(eraProfile(id)).has('spellbookFilters'), id).toBe(false);
    }
  });

  it('Keyboard Config: 1999 has no Show/Hide Negative Magic Panel; the others keep it', () => {
    expect(clientRuleHiddenActions(AC1999).has(SHOW_HIDE_NEGATIVE_MAGIC_PANEL)).toBe(true);
    for (const id of OTHERS) expect(clientRuleHiddenActions(eraClientRules(eraProfile(id))).has(SHOW_HIDE_NEGATIVE_MAGIC_PANEL), id).toBe(false);
  });
});

describe('MAG-5: the spell examine Duration line', () => {
  it('1999: the rolled band, minutes to one decimal past 90 s, seconds truncated below', () => {
    expect(spellDurationText1999({ duration: 1800, metaSpellType: 1 })).toBe('Duration: 22.5-37.5 min.');
    expect(spellDurationText1999({ duration: 60, metaSpellType: 1 })).toBe('Duration: 45-75 sec.');
    // 72 s × 1.25 = 90: not past 90, so seconds.
    expect(spellDurationText1999({ duration: 72, metaSpellType: 1 })).toBe('Duration: 54-90 sec.');
    expect(spellDurationText1999({ duration: 73, metaSpellType: 1 })).toBe('Duration: 0.9-1.5 min.');
    expect(spellDurationText1999({ duration: 10, metaSpellType: 12 })).toBe('Duration: 7-12 sec.');
    // A portal summon prints its portal's lifetime as one value.
    expect(spellDurationText1999({ metaSpellType: 7, portalLifetime: 120 })).toBe('Duration: 2 min.');
    expect(spellDurationText1999({ metaSpellType: 7, portalLifetime: 45 })).toBe('Duration: 45 sec.');
    // No duration, or -1 (an item spell): no line.
    expect(spellDurationText1999({ metaSpellType: 2 })).toBe('');
    expect(spellDurationText1999({ duration: -1, metaSpellType: 1 })).toBe('');
  });

  it('the examine model takes the era\'s line; end of retail\'s is unchanged', () => {
    const inputs = {
      spellId: 1, spell: { name: 'Strength Self I', desc: '', school: 4, icon: 0, baseMana: 10, manaMod: 0, baseRangeConstant: 0, baseRangeMod: 0, duration: 1800, metaSpellType: 1 },
      formula: { baseFormula: [], customizedFormula: () => [], fociWcidBySchool: new Map(), ownsWcid: () => false, intProperty: () => undefined },
      skillLevel: () => 0, component: () => null, carriedObject: () => 0,
    };
    expect(buildSpellExamineModel({ ...inputs, durationText: AC1999.spellDurationText }).duration).toBe('Duration: 22.5-37.5 min.');
    for (const id of OTHERS) {
      expect(buildSpellExamineModel({ ...inputs, durationText: eraClientRules(eraProfile(id)).spellDurationText }).duration, id).toBe('Duration: 30 min.');
    }
    expect(buildSpellExamineModel(inputs).duration).toBe(spellDurationText(1800));
  });
});

describe('MAG-10: the component pre-check slots', () => {
  // scarab (1), herb (2), gem (3), alchemical (4), talisman (5), tapers (6, 7, 8): only the scarab is missing.
  const wcids = new Map([[1, 101], [2, 102], [3, 103], [4, 104], [5, 105], [6, 106], [7, 107], [8, 108]]);
  const ownsAllBut = (missing: number) => (w: number) => w !== missing;
  it('1999 never checks the scarab (slot 0) or slots 6-7; end of retail checks every slot', () => {
    const formula = [1, 6, 2, 7, 3, 4, 8, 5];
    for (const [missing, slot] of [[101, 0], [108, 6], [105, 7]] as const) {
      expect(spellComponentsSatisfied(true, formula, wcids, ownsAllBut(missing), AC1999.componentPrecheckSlots), `slot ${slot}`).toBe(true);
      for (const id of OTHERS) expect(spellComponentsSatisfied(true, formula, wcids, ownsAllBut(missing), eraClientRules(eraProfile(id)).componentPrecheckSlots), id).toBe(false);
      expect(spellComponentsSatisfied(true, formula, wcids, ownsAllBut(missing))).toBe(false);
    }
    // A missing herb (slot 2) is refused in every era.
    expect(spellComponentsSatisfied(true, formula, wcids, ownsAllBut(102), AC1999.componentPrecheckSlots)).toBe(false);
    expect(spellComponentsSatisfied(false, formula, wcids, () => false, AC1999.componentPrecheckSlots)).toBe(true);
  });
});

describe('MAG-8: the spellbook order', () => {
  it('1999 files by name (byte-wise, a same name before the one already there); end of retail by DisplayOrder', () => {
    const spells = [{ id: 1, name: 'Strength Self I' }, { id: 2, name: 'Flame Bolt I' }, { id: 3, name: 'Armor Self I' }, { id: 4, name: 'armor lower' }];
    expect(spellbookNameOrder(spells).map((s) => s.id)).toEqual([3, 2, 1, 4]);
    const order = new Map([[1, 5], [2, 1], [3, 9], [4, 2]]);
    expect(spellbookOrder(spells, (id) => order.get(id)!).map((s) => s.id)).toEqual([2, 4, 1, 3]);
  });
});

describe('MAG-4: the combined effects rows', () => {
  const ench = (spellId: number, name: string, isBeneficial: boolean): EffectsEnchantment => ({
    spellId, layer: 1, name, iconId: 0, isBeneficial, isVitae: false, isCooldown: false, duration: 600, startTime: 0, appliedAt: 0, spellCategory: spellId,
  });
  const all = [ench(1, 'Zeal', true), ench(2, 'Weakness Other', false), ench(3, 'Armor Self I', true)];
  it('one window lists every spell in name order; end of retail splits them', () => {
    const def = combinedEffectsWindow('Spells in Effect');
    expect([def.element, def.inputAction, def.titleFallback, def.uiType]).toEqual([POSITIVE_EFFECTS.element, POSITIVE_EFFECTS.inputAction, 'Spells in Effect', 0]);
    expect(buildEffectsRows(all, def.uiType, 0, () => null).map((r) => r.name)).toEqual(['Armor Self I', 'Weakness Other', 'Zeal']);
    expect(buildEffectsRows(all, 1, 0, () => null).map((r) => r.name)).toEqual(['Armor Self I', 'Zeal']);
    expect(buildEffectsRows(all, 2, 0, () => null).map((r) => r.name)).toEqual(['Weakness Other']);
  });
});

describe('MAG-6: the 1999 Cast button face', () => {
  const T = AC1999.castButtonText!;
  it('every branch of UpdateCastButton @ 0x513e00, and the 0x55 hover texts', () => {
    expect(castButtonFace({ selectedSpellName: null, anySpellReady: false }, T)).toEqual({ label: 'You have no spells\nready to cast', castable: false, hover: 'Drag a spell to the menu above,\nthen click here to cast it.' });
    expect(castButtonFace({ selectedSpellName: null, anySpellReady: true }, T)).toEqual({ label: 'Select a spell to cast', castable: false, hover: 'Select a spell from the menu above,\nthen click here to cast it.' });
    expect(castButtonFace({ selectedSpellName: 'Flame Bolt I', anySpellReady: true, untargeted: true }, T)).toEqual({ label: 'CAST Flame Bolt I', castable: true, hover: 'Click to cast Flame Bolt I' });
    expect(castButtonFace({ selectedSpellName: 'Flame Bolt I', anySpellReady: true, targetName: null }, T).label).toBe('You must select a target\nfor Flame Bolt I');
    expect(castButtonFace({ selectedSpellName: 'Flame Bolt I', anySpellReady: true, targetName: 'Drudge', targetCompatible: true }, T)).toEqual({ label: 'CAST Flame Bolt I\non Drudge', castable: true, hover: 'Click to cast Flame Bolt I' });
    expect(castButtonFace({ selectedSpellName: 'Flame Bolt I', anySpellReady: true, targetName: 'Rock', targetCompatible: false }, T).label).toBe('You must select an appropriate\ntarget for Flame Bolt I');
    const endow = { itemName: 'Wand', spellName: 'Flame Bolt I', selfTarget: false, targetCompatible: true };
    expect(castButtonFace({ selectedSpellName: null, anySpellReady: false, endowment: endow, targetName: 'Drudge' }, T)).toEqual({ label: 'USE the Wand\non Drudge', castable: true, hover: 'Click to use your Wand' });
    expect(castButtonFace({ selectedSpellName: null, anySpellReady: false, endowment: endow, targetName: null }, T).label).toBe('You must select a target for\nthe Wand');
    expect(castButtonFace({ selectedSpellName: null, anySpellReady: false, endowment: { ...endow, selfTarget: true } }, T).label).toBe('USE the Wand');
  });
  it('end of retail\'s tooltip texts are unchanged', () => {
    expect(castButtonTooltip({ selectedSpellName: 'Flame Bolt I', anySpellReady: true, targetName: null }).text).toBe('You must select a target for Flame Bolt I');
  });
});

/* ── GameUI (happy-dom, a recording LayoutRenderer stub) ─────────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubRenderer(doc: Document, titles: Map<number, string>): any {
  const makeHandle = (parent: HTMLElement, record = false) => {
    const wrapper = doc.createElement('div');
    parent.appendChild(wrapper);
    const root = doc.createElement('div');
    wrapper.appendChild(root);
    const elements = new Map<number, HTMLElement>();
    const get = elements.get.bind(elements);
    elements.get = (id: number) => {
      let el = get(id);
      if (!el) { el = doc.createElement('div'); root.appendChild(el!); elements.set(id, el!); }
      return el;
    };
    const noop = () => {};
    return {
      root, elements, descs: new Map(), layout: { elements: new Map() },
      setText: (id: number, t: string) => { if (record) titles.set(id, t); },
      setFill: noop, setVisible: noop, setState: noop, setPalette: noop, setInteractive: noop,
      setDraggable: noop, setDropTarget: noop, onClick: noop, resizeSubtree: noop,
      destroy: () => wrapper.remove(), moveTo: noop, bringToFront: noop, close: () => wrapper.remove(),
    };
  };
  return {
    render: (_id: number, parent: HTMLElement) => makeHandle(parent),
    renderPanel: (_id: number, parent: HTMLElement) => makeHandle(parent, true),
  };
}

for (const era of ['ac1999-retail', 'eor', 'classic-dereth'] as const) {
  const is1999 = era === 'ac1999-retail';
  describe(`GameUI on ${era}: effects windows, a learned spell, the spellbook filters`, () => {
    let H: GameUIFixture;
    const titles = new Map<number, string>();
    beforeAll(async () => {
      H = await mountGameUI({ size: { innerWidth: 1600, innerHeight: 900 } });
      H.ui.layoutRenderer = stubRenderer(H.win.document, titles);
      H.ui.setUnsupportedFeatures(unsupportedFeatures(eraProfile(era)));
      H.ui.setClientRules(eraClientRules(eraProfile(era)));
      H.ui.showGame();
      H.ui.renderHUD();
    }, 60_000);
    afterAll(() => H?.teardown());

    it(is1999 ? 'MAG-4: one indicator, lit by a debuff alone, opening "Spells in Effect" with every spell' : 'MAG-4: two indicators and the two windows', () => {
      H.ui.clearEnchantments();
      H.ui.addEnchantment({ spellId: 201, layer: 1, name: 'Weakness Other', iconId: 0, isBeneficial: false, isVitae: false, isCooldown: false, duration: 120, startTime: 0, casterGuid: 0 });
      const harmful = H.container.querySelector('#hud-indicator-effects-harmful') as HTMLElement;
      expect(harmful.style.display === 'none').toBe(is1999);
      expect(H.ui.indicatorActive.get('effects-beneficial')).toBe(is1999);
      expect(H.ui.indicatorActive.get('effects-harmful') ?? false).toBe(!is1999);
      H.ui.addEnchantment({ spellId: 101, layer: 1, name: 'Zeal', iconId: 0, isBeneficial: true, isVitae: false, isCooldown: false, duration: 616, startTime: 0, casterGuid: 0 });
      H.ui.togglePositiveEffectsPanel();
      const win = H.container.querySelector('[data-effects-panel="positive"]') as HTMLElement;
      const labels = [...win.querySelectorAll('[data-effects-label]')].map((e) => (e as HTMLElement).dataset.effectsLabel);
      expect(titles.get(0x10000120)).toBe(is1999 ? 'Spells in Effect' : 'Beneficial Spells in Effect');
      expect(labels).toEqual(is1999 ? ['Weakness Other', 'Zeal'] : ['Zeal']);
      H.ui.togglePositiveEffectsPanel();
      // The negative toggle does nothing in 1999 (no such window); it opens the Harmful window elsewhere.
      H.ui.toggleNegativeEffectsPanel();
      expect(H.ui.isEffectsPanelVisible('negative')).toBe(!is1999);
      if (!is1999) H.ui.toggleNegativeEffectsPanel();
    });

    it(is1999 ? 'MAG-7: a learned spell opens the Magic panel on the spellbook, selected' : 'MAG-7: a learned spell is selected; the closed panel stays closed', () => {
      if (H.ui.magicVisible) H.ui.toggleMagicPanel();
      H.ui.magicPanelTab = 'components';
      const learned = { id: 27, name: 'Flame Bolt I', school: 1, level: 1, power: 1, manaCost: 10, difficulty: 1, duration: 0, components: [1], targetType: 0, iconId: 0, desc: '' };
      H.ui.setSpellData([learned]);
      H.ui.spellbookSpellAdded(27);
      expect(H.ui.spellbookSelection).toBe(27);
      expect(H.ui.magicVisible).toBe(is1999);
      expect(H.ui.magicPanelTab).toBe(is1999 ? 'spells' : 'components');
      if (H.ui.magicVisible) H.ui.toggleMagicPanel();
    });

    it(is1999 ? 'MAG-8: every spell lists whatever the stored filter bits say' : 'MAG-8: the filter bits still hide a spell', () => {
      H.ui.setSpellbookFilters(0x3fff & ~0x8); // War off
      const war = { id: 28, name: 'Force Bolt I', school: 1, level: 1, power: 1, manaCost: 10, difficulty: 1, duration: 0, components: [1], targetType: 0, iconId: 0, desc: '' };
      H.ui.setSpellData([war]);
      H.ui.spellbookSpellAdded(28);
      expect(H.ui.spellbookSelection === 28).toBe(is1999);
      if (H.ui.magicVisible) H.ui.toggleMagicPanel();
      H.ui.setSpellbookFilters(0x3fff);
    });
  });
}

/* ── the real LayoutRenderer spell bar and spellbook ────────────────────── */

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');
const LANG_DAT = resolve(ROOT, 'dat/client_local_English.dat');
const hasDats = existsSync(PORTAL_DAT) && existsSync(LANG_DAT);
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
const spell = (id: number, name: string) => ({ id, name, school: 1, level: 1, power: 10, manaCost: 10, difficulty: 10, duration: 1800, components: [1], targetType: 0, iconId: 0x06001000 + id, desc: '' });

describe.skipIf(!hasDats)('the real LayoutRenderer spell bar and spellbook per era', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let domWindow: any; let make: (era: string) => any;
  beforeAll(async () => {
    domWindow = await loadDomWindow();
    installDomGlobals(domWindow, DOM_GLOBALS as never, saved);
    const { parseMasterProperty, setMasterPropertyTypes, parseStringTable, registerStringTable } = await import('../packages/dat-parser/src/file-types/LayoutDesc.js');
    const portalDb = openDat(PORTAL_DAT);
    const langDb = openDat(LANG_DAT);
    setMasterPropertyTypes(parseMasterProperty(portalDb.getReader(0x39000001)));
    for (const id of [0x23000001, 0x23000002, 0x23000003, 0x23000005, 0x2300000d]) registerStringTable(parseStringTable(langDb.getReader(id)));
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { UITextureLoader } = await import('../packages/renderer/src/ui/UITextureLoader.js');
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const { CombatMode } = await import('../packages/shared/src/index.js');
    make = (era) => {
      domWindow.localStorage.clear();
      const layoutRenderer = new LayoutRenderer(langDb, new UITextureLoader(new TextureManager(portalDb)));
      layoutRenderer.getTextureDataURLWithAlpha = () => null;
      domWindow.document.body.innerHTML = '';
      const container = domWindow.document.createElement('div');
      domWindow.document.body.appendChild(container);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ui: any = new GameUI(container, {}, portalDb, undefined, undefined, undefined, null, layoutRenderer);
      ui.setUnsupportedFeatures(unsupportedFeatures(eraProfile(era)));
      ui.setClientRules(eraClientRules(eraProfile(era)));
      ui.showGame();
      ui.hudState.combatMode = CombatMode.Magic;
      const list = [spell(100, 'Flame Bolt I'), spell(101, 'Armor Self I')];
      ui.setSpellData(list, [[...list, null, null, null, null, null, null, null], ...Array.from({ length: 7 }, () => new Array(9).fill(null))]);
      ui.renderSpellBarPanel();
      return ui;
    };
  });
  afterAll(() => { restoreDomGlobals(DOM_GLOBALS as never, saved); });

  // BUG.ac1999-cast-face-overdraw — a font renderer that is ready, so labels
  // take the canvas path the live client draws with (6 px a character).
  const readyFont = () => ({
    isReady: true, outlinePadding: { x: 1, y: 1 }, lineHeight: 16,
    measureText: (t: string) => t.replace(/\n/g, '').length * 6,
    renderTextToCanvas(t: string) {
      const c = domWindow.document.createElement('canvas');
      c.width = t.length * 6; c.height = 16; c.dataset.text = t; return c;
    },
    renderWrappedTextToCanvas(t: string) {
      const c = domWindow.document.createElement('canvas');
      c.width = Math.max(...t.split('\n').map((l) => l.length * 6)); c.height = 16 * t.split('\n').length; c.dataset.text = t; return c;
    },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const withReadyFont = (ui: any): void => {
    const font = readyFont();
    ui.layoutRenderer.setFontRenderer(font);
    ui.layoutRenderer.setFontResolver(() => font);
    ui.fontRenderer = font;
    ui.loadFontRenderer = () => font;
    ui.renderSpellBarPanel();
  };
  const sliceRects = (btn: HTMLElement) => [...btn.querySelectorAll(':scope > [data-element-id]')]
    .map((c) => [(c as HTMLElement).dataset.elementId, (c as HTMLElement).style.left, (c as HTMLElement).style.width]);
  const faceTexts = (btn: HTMLElement) => [...btn.querySelectorAll('.layout-text')]
    .map((w) => (w.querySelector('canvas') as HTMLCanvasElement | null)?.dataset.text ?? w.textContent);

  it('BUG.ac1999-cast-face-overdraw: the 1999 button\'s art spans its 200 px and each face replaces the last', () => {
    const ui = make('ac1999-retail');
    withReadyFont(ui);
    const btn = ui.spellBarHandle.elements.get(SPELLBAR_CAST_BUTTON) as HTMLElement;
    expect(btn.style.width).toBe('200px');
    // SetSize on the button: the 32 px caps stay, the middle stretches, the right cap follows the far edge.
    expect(sliceRects(btn)).toEqual([['0x100002ce', '0px', '32px'], ['0x100002cf', '32px', '136px'], ['0x100002d0', '168px', '32px']]);
    // The button still ends at the bar's right edge.
    expect(parseInt(btn.style.left, 10) + 200).toBe(parseInt(ui.spellBarHandle.elements.get(0x1000009f).style.width, 10));
    expect(faceTexts(btn)).toEqual(['Select a spell to cast']);
    ui.selectSpellShortcut(100);
    expect(faceTexts(btn)).toEqual(['You must select a target\nfor Flame Bolt I']);
    ui.hud.target = { id: 5, name: 'Practice Yag', itemType: 0x10 };
    ui.updateCastButtonTooltip();
    expect(faceTexts(btn)).toEqual(['CAST Flame Bolt I\non Practice Yag']);
    // Rollover / press / leave repaint the same one label.
    for (const t of ['mouseenter', 'mousedown', 'mouseup', 'mouseleave']) btn.dispatchEvent(new domWindow.MouseEvent(t));
    expect(faceTexts(btn)).toEqual(['CAST Flame Bolt I\non Practice Yag']);
    // Every line is cut to the button less its margins, so the text box sits inside the art.
    ui.hud.target = { id: 6, name: 'A Very Long Practice Target Name Indeed', itemType: 0x10 };
    ui.updateCastButtonTooltip();
    const canvas = btn.querySelector('.layout-text canvas') as HTMLCanvasElement;
    expect(canvas.dataset.text!.split('\n')[1].endsWith('...')).toBe(true);
    expect(canvas.width).toBeLessThanOrEqual(200);
    expect(domWindow.document.querySelectorAll('[data-element-id="0x100000b2"]').length).toBe(1);
  });

  it('BUG.ac1999-cast-face-overdraw: a label replaces a stray wrapper too, and a nested re-render leaves one bar', () => {
    const ui = make('ac1999-retail');
    withReadyFont(ui);
    const btn = ui.spellBarHandle.elements.get(SPELLBAR_CAST_BUTTON) as HTMLElement;
    const stray = domWindow.document.createElement('div');
    stray.className = 'layout-text';
    btn.appendChild(stray);
    ui.selectSpellShortcut(100);
    expect(faceTexts(btn)).toEqual(['You must select a target\nfor Flame Bolt I']);
    // A re-render run inside a render keeps one live bar, not a frozen copy under it.
    const orig = ui.updateCastButtonTooltip.bind(ui);
    let nested = false;
    ui.updateCastButtonTooltip = () => { if (!nested) { nested = true; ui.renderSpellBarPanel(); } orig(); };
    ui.renderSpellBarPanel();
    ui.updateCastButtonTooltip = orig;
    expect(domWindow.document.querySelectorAll('[data-element-id="0x100000b2"]').length).toBe(1);
  });

  it('1999: the Cast button is 200 px and carries its state; the Charge meter shows only with a selection (MAG-3, MAG-6)', () => {
    const ui = make('ac1999-retail');
    const btn = ui.spellBarHandle.elements.get(SPELLBAR_CAST_BUTTON) as HTMLElement;
    expect(btn.style.width).toBe('200px');
    // The bar's backdrop still spans the window body.
    expect(ui.spellBarHandle.elements.get(0x100000a0).style.width).toBe(ui.spellBarHandle.elements.get(0x1000009f).style.width);
    expect(btn.dataset.castFace).toBe('Select a spell to cast');
    const meter = ui.spellBarPanelEl.querySelector('[data-spell-charge-meter]') as HTMLElement;
    expect(meter).toBeTruthy();
    expect(meter.style.display).toBe('none');
    expect(meter.querySelector('[data-spell-charge-caption]')).toBeTruthy();
    // Right of the Charge caption, short of the Cast button.
    expect(parseInt(meter.style.left, 10) + parseInt(meter.style.width, 10)).toBeLessThan(parseInt(btn.style.left, 10));
    let charge = 0.874;
    ui.spellChargeFor = () => charge;
    ui.selectSpellShortcut(100);
    expect(btn.dataset.castFace).toBe('You must select a target\nfor Flame Bolt I');
    expect(meter.style.display).toBe('');
    expect(meter.dataset.chargePct).toBe('87');
    charge = 0.92;
    ui.updateHUD();
    expect(meter.dataset.chargePct).toBe('92');
    // No spell-name line under the bar.
    expect(ui.spellBarHandle.elements.get(SPELLBAR_SPELL_NAME_TEXT).textContent).toBe('');
  });

  for (const era of OTHERS) {
    it(`${era}: the 75 px "Cast" button, the spell name beside it, no Charge meter`, () => {
      const ui = make(era);
      const btn = ui.spellBarHandle.elements.get(SPELLBAR_CAST_BUTTON) as HTMLElement;
      expect(btn.style.width).toBe('75px');
      expect(sliceRects(btn)).toEqual([['0x100002ce', '0px', '32px'], ['0x100002cf', '32px', '11px'], ['0x100002d0', '43px', '32px']]);
      expect(btn.dataset.castFace).toBeUndefined();
      expect(ui.spellBarPanelEl.querySelector('[data-spell-charge-meter]')).toBeNull();
      ui.selectSpellShortcut(100);
      expect(btn.dataset.acTooltipText).toBe('You must select a target for Flame Bolt I');
    });
  }

  it('MAG-8: a 1999 spellbook draws no filter captions or rows and lists by name; end of retail keeps them', () => {
    for (const era of ['ac1999-retail', 'eor'] as const) {
      const ui = make(era);
      ui.toggleMagicPanel();
      const caption = ui.magicPanelHandle?.elements.get(0x100002a3) as HTMLElement | undefined;
      const warRow = ui.magicPanelHandle?.elements.get(0x1000029b) as HTMLElement | undefined;
      expect(caption, era).toBeTruthy();
      expect(caption!.style.display === 'none', era).toBe(era === 'ac1999-retail');
      expect(warRow!.style.display === 'none', era).toBe(era === 'ac1999-retail');
      const rows = [...ui.magicPanel.querySelectorAll('[data-spell-id]')].map((r) => Number((r as HTMLElement).dataset.spellId));
      if (era === 'ac1999-retail') expect(rows).toEqual([101, 100]);
      ui.toggleMagicPanel();
    }
  });
});
