/**
 * FAITHFUL.494 — DisplaySpellDurations CharacterOption (0x15) gates
 *  the enchantment-row duration text.
 *
 *  Per ACE `CharacterOption.cs:78-79` DisplaySpellDurations = 0x15
 *  (CharacterOptions1.SpellDuration). Retail's toggle controlled
 *  whether spell duration text was rendered in the active-spells
 *  panel. Pre-fix the duration was ALWAYS rendered, ignoring the
 *  retail option.
 *
 *  Implementation:
 *  - the effects window rows check `optionsSettings.displaySpellDurations
 *    !== false` before appending the duration text element. Real
 *    client-side gating.
 *  - DEFAULTS entry `displaySpellDurations: true` (retail default).
 *  - OPTIONS_TO_CHARACTER_OPTION map `displaySpellDurations: 0x15`.
 *  - "Show Spell Durations" toggle row in Display tab.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

/** Minimal LayoutRenderer stub: every element id the panel code asks for
 *  resolves to a real div, so the real GameUI render paths run to completion. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubLayoutRenderer(H: GameUIFixture): any {
  const doc = H.win.document;
  const makeHandle = (parent: HTMLElement) => {
    const root = doc.createElement('div');
    parent.appendChild(root);
    const elements = new Map<number, HTMLElement>();
    const get = elements.get.bind(elements);
    elements.get = (id: number) => {
      let el = get(id);
      if (!el) { el = doc.createElement('div'); root.appendChild(el!); elements.set(id, el!); }
      return el;
    };
    const noop = () => {};
    return {
      root, layout: { elements: [] }, elements, descs: new Map(),
      setText: noop, setFill: noop, setVisible: noop, setState: noop, setPalette: noop, setInteractive: noop,
      setScrollable: () => ({ contentEl: doc.createElement('div'), setPosition: noop, scrollToBottom: noop, appendContent: noop }),
      setDraggable: noop, setDropTarget: noop, setTexture: noop, onClick: noop,
      destroy: () => root.remove(), moveTo: noop, close: () => root.remove(), bringToFront: noop,
    };
  };
  const lr = {
    render: (_id: number, parent: HTMLElement) => makeHandle(parent),
    renderPanel: (_id: number, parent: HTMLElement) => makeHandle(parent),
    getTextureDataURLWithAlpha: () => null,
  };
  H.ui.layoutRenderer = lr;
  return lr;
}


// Options panel 0x2100002b element ids renderOptionsPanel touches (mirrors
// verify-options-panel-behavioral.ts's stub layoutRenderer).
const OPT_IDS = [
  0x10000208, 0x10000210, 0x10000211, 0x10000212, 0x10000213, 0x10000216, 0x10000217,
  0x10000218, 0x1000021a, 0x1000021d, 0x10000220, 0x10000221, 0x10000222, 0x1000050c,
  0x10000520, 0x10000521, 0x1000020d, 0x1000020e, 0x1000050b, 0x1000020f,
];

/** Stub LayoutRenderer so the real renderOptionsPanel builds its tab content in happy-dom. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubOptionsLayout(ui: any, win: any): void {
  const doc = win.document;
  if (typeof win.requestAnimationFrame !== 'function') win.requestAnimationFrame = () => 0;
  ui.layoutRenderer = {
    renderPanel: (_layoutId: number, parent: HTMLElement) => {
      const root = doc.createElement('div');
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      for (const id of OPT_IDS) {
        const el = doc.createElement('div');
        root.appendChild(el);
        elements.set(id, el);
        if (id === 0x10000211) {
          for (const bid of [0x100001fc, 0x100001fd, 0x100001fe]) {
            const btn = doc.createElement('div');
            btn.dataset.elementId = `0x${bid.toString(16)}`;
            for (const sid of [0x100002ce, 0x100002cf, 0x100002d0]) {
              const slice = doc.createElement('div');
              slice.dataset.elementId = `0x${sid.toString(16)}`;
              btn.appendChild(slice);
            }
            el.appendChild(btn);
          }
        }
      }
      return {
        root, elements,
        setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
        setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render: (id: number, parent: HTMLElement) => (ui.layoutRenderer as any).renderPanel(id, parent),
  };
}

/** Render one Options tab and return its toggle rows keyed by option key. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderOptionsTab(ui: any, tab: string): Map<string, HTMLElement> {
  ui.optionsTab = tab;
  if (!ui.optionsPanelVisible) ui.toggleOptionsPanel();
  else ui.renderOptionsPanel();
  const rows = new Map<string, HTMLElement>();
  for (const row of ui.optionsPanel.querySelectorAll('.option-toggle-row') as NodeListOf<HTMLElement>) {
    rows.set(row.dataset.optionKey!, row);
  }
  return rows;
}


// DEBT.test-harness-hygiene: behavioural — real GameUI statics, the real
// Options panel, and the real effects window rows (were GameUI.ts pins).
describe('FAITHFUL.494 — DEFAULTS + OPTIONS_TO_CHARACTER_OPTION', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); }, 60_000);
  afterAll(() => H?.teardown());

  it('displaySpellDurations defaults to true', () => {
    expect(H.mod.GameUI.OPTIONS_DEFAULTS.displaySpellDurations).toBe(true);
  });

  it('displaySpellDurations maps to 0x15', () => {
    expect(H.mod.GameUI.OPTIONS_TO_CHARACTER_OPTION.displaySpellDurations).toBe(0x15);
  });
});

describe('FAITHFUL.494 — Options-panel row', () => {
  let H: GameUIFixture;
  const toggles: Array<{ code: number; on: boolean }> = [];
  beforeAll(async () => {
    H = await mountGameUI({ callbacks: { onCharacterOptionToggle: (code: number, on: boolean) => { toggles.push({ code, on }); } } });
    stubOptionsLayout(H.ui, H.win);
  }, 60_000);
  afterAll(() => H?.teardown());

  it('a "Display Spell Durations" toggle row round-trips CharacterOption 0x15', () => {
    const row = renderOptionsTab(H.ui, 'character').get('displaySpellDurations');
    expect(row).toBeTruthy();
    expect(row!.textContent).toContain('Display Spell Durations');
    expect(row!.dataset.optionOn).toBe('1');
    row!.dispatchEvent(new H.win.Event('click', { bubbles: true }));
    expect(toggles).toEqual([{ code: 0x15, on: false }]);
  });
});

// GAP.indicator-bar-interactive — the rows now live in the retail
// Positive Effects window (gmEffectsUI); EffectInfoRegion::Update @ 004f1c00
// writes the value text 0x1000012b only while PlayerModule::SpellDuration.
describe('FAITHFUL.494 — the effects window rows gate their duration text', () => {
  let H: GameUIFixture;
  beforeAll(async () => {
    H = await mountGameUI();
    stubLayoutRenderer(H);
    H.ui.renderHUD();
  }, 60_000);
  afterAll(() => {
    if (H?.ui.isEffectsPanelVisible('positive')) H.ui.togglePositiveEffectsPanel();
    H?.teardown();
  });

  /** Open the positive window with one timed buff; return its row's [label, duration] texts. */
  function buffRow(show: boolean | undefined): [string, string] {
    H.ui.optionsSettings.displaySpellDurations = show;
    H.ui.clearEnchantments();
    H.ui.addEnchantment({ spellId: 2, layer: 1, name: 'Zz Test Buff', iconId: 0, isBeneficial: true,
      isVitae: false, isCooldown: false, duration: 3600, startTime: 0, casterGuid: 0 });
    if (!H.ui.isEffectsPanelVisible('positive')) H.ui.togglePositiveEffectsPanel();
    const row = H.container.querySelector('[data-effects-panel="positive"] [data-effects-row="2"]') as HTMLElement;
    expect(row).toBeTruthy();
    const label = row.querySelector('[data-effects-label]') as HTMLElement;
    const value = row.querySelector('[data-effects-duration]') as HTMLElement;
    return [label.textContent ?? '', value.textContent ?? ''];
  }

  it('duration text renders by default (undefined) and when true', () => {
    expect(buffRow(undefined)[0]).toBe('Zz Test Buff');
    const [, dur] = buffRow(true);
    expect(dur).toMatch(/^(1:00:00|59:5\d)$/);
  });

  it('displaySpellDurations === false leaves the duration text empty', () => {
    expect(buffRow(false)).toEqual(['Zz Test Buff', '']);
  });
});
