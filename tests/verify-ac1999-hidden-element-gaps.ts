/**
 * VISUAL.ac1999-hidden-element-gaps (Jake, AC1999 on prod: "the things we hide in AC1999 just
 * leave blank spaces. can't we size/space the other things so it looks natural?").
 *
 * A control a 1999 world hides (NO-DEAD-ENDS) left its DAT rect empty. The remaining controls now
 * take the 1999 client.exe's own layout, in the end-of-retail art:
 *   - the toolbar tab row: PanelUI @ 0x004eb120's five abutting tabs (no journal, no filler);
 *   - tab strips (Character, Social, World): the kept tabs share the 276 px strip, as every 1999
 *     tab strip does (StatsPanel / GroupPanel 2 x 0x8a, MagicPanBase 3 x 0x5c, MapSubPanel's one
 *     0x114 title);
 *   - the fellowship buttons: FellowPanel @ 0x00533f90's one row (Recruit, Dismiss, leave), the
 *     list grown over the emptied row;
 *   - the spellbook page without filters: SpellbookPanel @ 0x00516240's 256 / 81 split, Delete at
 *     the footer's top.
 * End of retail and Dark Majesty (classic-dereth) hide nothing and keep every DAT rect.
 *
 * Behavioral: the pure layout functions, and the real GameUI in happy-dom with a LayoutRenderer
 * stand-in that places each element at its DAT rect.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { unsupportedFeatures, eraClientRules, type EraFeature } from '../packages/renderer/src/era/EraFeatures.js';
import { AC1999_TOOLBAR_TABS, eraToolbarRow, collapseToolbarTabs } from '../packages/renderer/src/ui/ToolbarTabs.js';
import { shareTabStrip } from '../packages/renderer/src/ui/TabStripShare.js';
import { fellowshipOneRow } from '../packages/renderer/src/ui/FellowshipButtonRow.js';
import { spellbookPageSplit } from '../packages/renderer/src/ui/spellbookFilter.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const ERAS = [['ac1999-retail', true], ['eor', false], ['classic-dereth', false]] as const;

/** LayoutDesc 0x21000016's tab row (the toolbar's), as GameUI's tabDefs carry it. */
const EOR_TOOLBAR = [
  { id: 'tb-social', x: 55, w: 35 }, { id: 'tb-magic', x: 85, w: 34 }, { id: 'tb-char', x: 115, w: 34 },
  { id: 'tb-journal', x: 145, w: 34 }, { id: 'tb-map', x: 175, w: 34 }, { id: 'tb-opt', x: 204, w: 34 },
];

describe('toolbar tab row (ui/ToolbarTabs.ts)', () => {
  it('the 1999 row is PanelUI\'s: five abutting tabs from 0x3d to the right separator at 0xed', () => {
    expect(AC1999_TOOLBAR_TABS.map((t) => [t.id, t.x, t.w])).toEqual([
      ['tb-social', 61, 35], ['tb-magic', 96, 34], ['tb-char', 130, 34], ['tb-map', 164, 34], ['tb-opt', 198, 39],
    ]);
    for (let i = 1; i < AC1999_TOOLBAR_TABS.length; i++) {
      expect(AC1999_TOOLBAR_TABS[i].x).toBe(AC1999_TOOLBAR_TABS[i - 1].x + AC1999_TOOLBAR_TABS[i - 1].w);
    }
    const last = AC1999_TOOLBAR_TABS[AC1999_TOOLBAR_TABS.length - 1];
    expect(last.x + last.w).toBe(0xed);
  });

  it('an era with its own row gets it, without the hidden journal and without filler', () => {
    const r = eraToolbarRow(EOR_TOOLBAR, new Set(['tb-journal']), AC1999_TOOLBAR_TABS);
    expect(r.tabs).toEqual([...AC1999_TOOLBAR_TABS]);
    expect(r.filler).toBeNull();
  });

  it('an era with no row of its own keeps the layout (nothing hidden) or closes it up', () => {
    expect(eraToolbarRow(EOR_TOOLBAR, new Set(), null)).toEqual(collapseToolbarTabs(EOR_TOOLBAR, new Set()));
    expect(eraToolbarRow(EOR_TOOLBAR, new Set(), null).tabs).toEqual(EOR_TOOLBAR);
    expect(eraToolbarRow(EOR_TOOLBAR, new Set(['tb-journal']), null)).toEqual(collapseToolbarTabs(EOR_TOOLBAR, new Set(['tb-journal'])));
  });

  it('the era profiles: 1999 has its row; end of retail and Dark Majesty use the layout', () => {
    expect(eraClientRules(eraProfile('ac1999-retail')).toolbarTabSlots).toBe(AC1999_TOOLBAR_TABS);
    expect(eraClientRules(eraProfile('eor')).toolbarTabSlots).toBeNull();
    expect(eraClientRules(eraProfile('classic-dereth')).toolbarTabSlots).toBeNull();
    expect(eraClientRules(null).toolbarTabSlots).toBeNull();
  });
});

describe('shareTabStrip (ui/TabStripShare.ts)', () => {
  const CHAR = [{ id: 1, x: 0, w: 92 }, { id: 2, x: 92, w: 92 }, { id: 3, x: 184, w: 92 }];
  const SOCIAL = [{ id: 1, x: 0, w: 72 }, { id: 2, x: 72, w: 72 }, { id: 3, x: 144, w: 62 }, { id: 4, x: 206, w: 70 }];

  it('nothing hidden: null (the DAT rects stay)', () => {
    expect(shareTabStrip(CHAR, new Set())).toBeNull();
    expect(shareTabStrip(SOCIAL, new Set([99]))).toBeNull();
  });

  it('character panel without Titles: 2 x 138, the 1999 StatsPanel\'s 0x8a tabs', () => {
    expect(shareTabStrip(CHAR, new Set([3]))).toEqual([{ id: 1, x: 0, w: 0x8a }, { id: 2, x: 0x8a, w: 0x8a }]);
  });

  it('social panel without Friends and Squelch: 2 x 138, the 1999 GroupPanel\'s tabs', () => {
    expect(shareTabStrip(SOCIAL, new Set([3, 4]))).toEqual([{ id: 1, x: 0, w: 138 }, { id: 2, x: 138, w: 138 }]);
  });

  it('a lone tab takes the strip; three share it as MagicPanBase\'s 0x5c tabs; an odd pixel goes last', () => {
    expect(shareTabStrip([{ id: 1, x: 0, w: 138 }, { id: 2, x: 138, w: 138 }], new Set([2]))).toEqual([{ id: 1, x: 0, w: 276 }]);
    const four = [...CHAR, { id: 4, x: 276, w: 92 }];
    expect(shareTabStrip(four, new Set([4]))).toEqual([{ id: 1, x: 0, w: 122 }, { id: 2, x: 122, w: 122 }, { id: 3, x: 244, w: 124 }]);
    expect(shareTabStrip([{ id: 1, x: 0, w: 92 }, { id: 2, x: 92, w: 92 }, { id: 3, x: 184, w: 92 }, { id: 4, x: 276, w: 1 }], new Set([4])))
      .toEqual([{ id: 1, x: 0, w: 92 }, { id: 2, x: 92, w: 92 }, { id: 3, x: 184, w: 93 }]);
  });

  it('strip order, not argument order; every tab hidden: none', () => {
    expect(shareTabStrip([CHAR[2], CHAR[0], CHAR[1]], new Set([2]))).toEqual([{ id: 1, x: 0, w: 138 }, { id: 3, x: 138, w: 138 }]);
    expect(shareTabStrip(CHAR, new Set([1, 2, 3]))).toEqual([]);
  });
});

/** Layout 0x21000030 pane 0x10000275: the roster list, its scrollbar and the six buttons. */
const IN_FELLOWSHIP_RECTS: ReadonlyMap<number, readonly [number, number, number, number]> = new Map([
  [0x10000279, [8, 38, 271, 487]], [0x1000027a, [279, 38, 16, 487]],
  [0x1000027b, [18, 534, 79, 30]], [0x1000027c, [108, 534, 79, 30]], [0x1000027d, [198, 534, 79, 30]],
  [0x1000027e, [18, 567, 79, 30]], [0x1000027f, [108, 567, 79, 30]], [0x10000280, [198, 567, 79, 30]],
] as const);

describe('fellowshipOneRow (ui/FellowshipButtonRow.ts)', () => {
  it('Recruit, Dismiss and Quit take the bottom row in the 1999 order; the list and scrollbar grow by the row step', () => {
    const rects = new Map([...IN_FELLOWSHIP_RECTS].map(([id, [x, y, w, h]]) => [id, { x, y, w, h }]));
    const out = fellowshipOneRow(rects)!;
    expect(out.get(0x1000027e)).toEqual({ x: 18, y: 567, w: 79, h: 30 });
    expect(out.get(0x1000027f)).toEqual({ x: 108, y: 567, w: 79, h: 30 });
    expect(out.get(0x1000027c)).toEqual({ x: 198, y: 567, w: 79, h: 30 });
    expect(out.get(0x10000279)).toEqual({ x: 8, y: 38, w: 271, h: 520 });
    expect(out.get(0x1000027a)).toEqual({ x: 279, y: 38, w: 16, h: 520 });
    for (const id of [0x1000027b, 0x1000027d, 0x10000280]) expect(out.has(id)).toBe(false);
  });

  it('a missing slot: nothing moves', () => {
    const rects = new Map([...IN_FELLOWSHIP_RECTS].filter(([id]) => id !== 0x10000280).map(([id, [x, y, w, h]]) => [id, { x, y, w, h }]));
    expect(fellowshipOneRow(rects)).toBeUndefined();
  });
});

describe('spellbookPageSplit (ui/spellbookFilter.ts)', () => {
  it('with filters: the DAT split (list 224 over the 113 px footer), Delete where the DAT has it', () => {
    expect(spellbookPageSplit(337, true)).toEqual({ listH: 224, footerY: 224, footerH: 113, deleteY: null });
    expect(spellbookPageSplit(437, true)).toEqual({ listH: 324, footerY: 324, footerH: 113, deleteY: null });
  });

  it('without (1999): SpellbookPanel\'s split, list 0x100 over the 0x51 box, Delete at its y 8', () => {
    expect(spellbookPageSplit(337, false)).toEqual({ listH: 256, footerY: 256, footerH: 81, deleteY: 8 });
    expect(spellbookPageSplit(437, false)).toEqual({ listH: 356, footerY: 356, footerH: 81, deleteY: 8 });
  });
});

// ── The real GameUI ──────────────────────────────────────────────────────────

/** DAT rects (x, y, w, h) per layout the panels under test render. */
const LAYOUT_RECTS: Record<number, ReadonlyArray<readonly [number, number, number, number, number]>> = {
  // Character panel 0x2100002e: Attributes / Skills / Titles, the minimize box.
  0x2100002e: [[0x10000228, 0, 0, 92, 25], [0x10000229, 92, 0, 92, 25], [0x10000538, 184, 0, 92, 25], [0x1000022a, 276, 0, 24, 25]],
  // Social panel 0x21000031: Allegiance / Fellowship / Friends / Squelch.
  0x21000031: [[0x1000028c, 0, 0, 72, 25], [0x1000028e, 72, 0, 72, 25], [0x10000512, 144, 0, 62, 25], [0x1000053b, 206, 0, 70, 25], [0x10000290, 276, 0, 24, 25]],
  // World panel 0x21000027: Map / House.
  0x21000027: [[0x100001f3, 0, 0, 138, 25], [0x100001f4, 138, 0, 138, 25], [0x100001f5, 276, 0, 24, 25]],
  // Magic panel 0x21000034 with the inherited spellbook page (0x21000032): footer and Delete.
  0x21000034: [[0x10000297, 0, 224, 300, 113], [0x100002a5, 187, 61, 100, 32]],
};

interface StubCalls { resized: Array<[number, number, number]> }

/** A LayoutRenderer stand-in: any element on demand, the LAYOUT_RECTS ones at their DAT rects with descs. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rectStub(H: GameUIFixture, calls: StubCalls): any {
  const doc = H.win.document;
  const makeHandle = (layoutId: number, parent: HTMLElement) => {
    const root = doc.createElement('div');
    parent.appendChild(root);
    const elements = new Map<number, HTMLElement>();
    const get = elements.get.bind(elements);
    elements.get = (id: number) => {
      let el = get(id);
      if (!el) {
        el = doc.createElement('div') as HTMLElement;
        el.dataset.elementId = `0x${id.toString(16)}`;
        root.appendChild(el);
        elements.set(id, el);
      }
      return el;
    };
    const descs = new Map<number, { x: number; y: number; width: number; height: number }>();
    for (const [id, x, y, w, h] of LAYOUT_RECTS[layoutId] ?? []) {
      descs.set(id, { x, y, width: w, height: h });
      Object.assign(elements.get(id)!.style, { position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    }
    const noop = () => {};
    return {
      root, layout: { elements: [] }, elements, descs,
      setText: noop, setFill: noop, setState: noop, setPalette: noop, setInteractive: noop,
      setVisible: (id: number, on: boolean) => { elements.get(id)!.style.display = on ? '' : 'none'; },
      setScrollable: () => ({ contentEl: doc.createElement('div'), setPosition: noop, scrollToBottom: noop, appendContent: noop }),
      setDraggable: noop, setDropTarget: noop, setTexture: noop, onClick: noop, resizeSubtree: noop,
      resizeElement: (id: number, w: number, h: number) => { calls.resized.push([id, w, h]); },
      destroy: () => root.remove(), moveTo: noop, close: () => root.remove(), bringToFront: noop,
    };
  };
  return {
    render: (id: number, parent: HTMLElement) => makeHandle(id, parent),
    renderPanel: (id: number, parent: HTMLElement) => makeHandle(id, parent),
    getTextureDataURLWithAlpha: () => null,
    getResolvedLayout: () => null,
    setFontResolver: () => {},
  };
}

const rectOf = (el: HTMLElement | null): number[] => {
  expect(el).toBeTruthy();
  return [el!.style.left, el!.style.top, el!.style.width, el!.style.height].map((v) => parseFloat(v));
};

for (const [era, is1999] of ERAS) {
  describe(`hidden-element layout, era ${era} (behavioral)`, () => {
    let H: GameUIFixture;
    const calls: StubCalls = { resized: [] };
    const features: ReadonlySet<EraFeature> = unsupportedFeatures(eraProfile(era));
    beforeAll(async () => {
      H = await mountGameUI();
      H.ui.layoutRenderer = rectStub(H, calls);
      H.ui.setUnsupportedFeatures(features);
      H.ui.setClientRules(eraClientRules(eraProfile(era)));
    }, 60_000);
    afterAll(() => H?.teardown());
    const el = (scope: HTMLElement, id: number): HTMLElement | null => scope.querySelector(`[data-element-id="0x${id.toString(16)}"]`);

    it(is1999 ? 'toolbar: the 1999 row, five abutting tabs, no journal, no filler' : 'toolbar: six tabs on the layout x, no filler', () => {
      H.ui.uiManager.setScreen('game');
      H.ui.renderHUD();
      const doc = H.win.document;
      const at = (id: string): number[] => {
        const b = doc.getElementById(id) as HTMLElement;
        return [parseFloat(b.style.left), parseFloat(b.style.width)];
      };
      expect(!!doc.getElementById('tb-journal')).toBe(!is1999);
      expect(doc.querySelector('.tb-tab-filler')).toBeNull();
      const ids = is1999 ? ['tb-social', 'tb-magic', 'tb-char', 'tb-map', 'tb-opt'] : EOR_TOOLBAR.map((t) => t.id);
      expect(ids.map(at)).toEqual(is1999 ? AC1999_TOOLBAR_TABS.map((t) => [t.x, t.w]) : EOR_TOOLBAR.map((t) => [t.x, t.w]));
      // The inventory button and the right separator keep the layout's places in every era.
      expect(at('tb-inv')).toEqual([238, 63]);
    });

    it(is1999 ? 'Character panel: Attributes and Skills share the strip, 138 px each' : 'Character panel: three 92 px tabs on their DAT rects', () => {
      calls.resized.length = 0;
      H.ui.toggleCharPanel();
      try {
        const p = H.ui.charPanel as HTMLElement;
        expect(rectOf(el(p, 0x10000228))).toEqual([0, 0, is1999 ? 138 : 92, 25]);
        expect(rectOf(el(p, 0x10000229))).toEqual([is1999 ? 138 : 92, 0, is1999 ? 138 : 92, 25]);
        expect(el(p, 0x10000538)!.style.display === 'none').toBe(is1999);
        expect(rectOf(el(p, 0x1000022a))).toEqual([276, 0, 24, 25]);
        // The 3-slice art reflows through UIElement::SetSize (resizeElement) only where a tab moved.
        expect(calls.resized).toEqual(is1999 ? [[0x10000228, 138, 25], [0x10000229, 138, 25]] : []);
      } finally { H.ui.toggleCharPanel(); }
    });

    it(is1999 ? 'Social panel: Allegiance and Fellowship share the strip' : 'Social panel: four tabs on their DAT rects', () => {
      calls.resized.length = 0;
      H.ui.socialTab = 'fellowship';
      H.ui.toggleSocialPanel();
      try {
        const p = H.ui.socialPanel as HTMLElement;
        expect(rectOf(el(p, 0x1000028c))).toEqual(is1999 ? [0, 0, 138, 25] : [0, 0, 72, 25]);
        expect(rectOf(el(p, 0x1000028e))).toEqual(is1999 ? [138, 0, 138, 25] : [72, 0, 72, 25]);
        for (const id of [0x10000512, 0x1000053b]) expect(el(p, id)!.style.display === 'none', id.toString(16)).toBe(is1999);
        if (!is1999) {
          expect(rectOf(el(p, 0x10000512))).toEqual([144, 0, 62, 25]);
          expect(rectOf(el(p, 0x1000053b))).toEqual([206, 0, 70, 25]);
        }
        expect(calls.resized).toEqual(is1999 ? [[0x1000028c, 138, 25], [0x1000028e, 138, 25]] : []);
      } finally { H.ui.toggleSocialPanel(); }
    });

    it(is1999 ? 'World panel: the Map tab spans the strip' : 'World panel: Map and House on their DAT rects', () => {
      calls.resized.length = 0;
      H.ui.toggleMapPanel();
      try {
        const p = H.ui.mapPanel as HTMLElement;
        expect(rectOf(el(p, 0x100001f3))).toEqual(is1999 ? [0, 0, 276, 25] : [0, 0, 138, 25]);
        expect(el(p, 0x100001f4)!.style.display === 'none').toBe(is1999);
        expect(calls.resized).toEqual(is1999 ? [[0x100001f3, 276, 25]] : []);
      } finally { H.ui.toggleMapPanel(); }
    });

    it(is1999 ? 'spellbook page: the 1999 split, Delete at the footer\'s top' : 'spellbook page: the DAT split', () => {
      H.ui.magicPanelTab = 'spells';
      H.ui.toggleMagicPanel();
      try {
        const p = H.ui.magicPanel as HTMLElement;
        expect(rectOf(el(p, 0x10000297))).toEqual(is1999 ? [0, 256, 300, 81] : [0, 224, 300, 113]);
        expect(rectOf(el(p, 0x100002a5))).toEqual(is1999 ? [187, 8, 100, 32] : [187, 61, 100, 32]);
        // The list area above it (the page's content wrapper) is as tall as the list.
        const page = el(p, 0x100002ac) as HTMLElement;
        expect(parseFloat((page.lastElementChild as HTMLElement).style.height)).toBe(is1999 ? 256 : 224);
        // A second render lands on the same rects (no compounding).
        H.ui.renderMagicPanel();
        const p2 = H.ui.magicPanel as HTMLElement;
        expect(rectOf(el(p2, 0x10000297))).toEqual(is1999 ? [0, 256, 300, 81] : [0, 224, 300, 113]);
      } finally { H.ui.toggleMagicPanel(); }
    });
  });

  describe(`fellowship buttons, era ${era} (behavioral)`, () => {
    let H: GameUIFixture;
    const OWN = 0x50000001;
    beforeAll(async () => {
      H = await mountGameUI();
      const doc = H.win.document;
      const mk = (parent: HTMLElement, id: number): HTMLElement => {
        const e = doc.createElement('div');
        e.dataset.elementId = `0x${id.toString(16)}`;
        parent.appendChild(e);
        return e;
      };
      H.ui.layoutRenderer = {
        renderPanel: (_layoutId: number, parent: HTMLElement) => {
          const root = doc.createElement('div');
          parent.appendChild(root);
          const elements = new Map<number, HTMLElement>();
          for (const id of [0x1000028b, 0x1000028c, 0x1000028e, 0x10000512, 0x1000053b, 0x10000290, 0x10000292]) elements.set(id, mk(root, id));
          const inFrame = mk(elements.get(0x10000292)!, 0x10000275);
          for (const id of [0x10000276, 0x10000277, 0x10000278]) mk(inFrame, id);
          for (const [id, [x, y, w, h]] of IN_FELLOWSHIP_RECTS) {
            Object.assign(mk(inFrame, id).style, { position: 'absolute', left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
          }
          mk(elements.get(0x10000292)!, 0x1000026b);
          return {
            root, elements,
            setState: () => {}, setText: () => {}, setInteractive: () => {},
            setVisible: (id: number, on: boolean) => { const e = elements.get(id); if (e) e.style.display = on ? '' : 'none'; },
            setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
          };
        },
        render: (id: number, parent: HTMLElement) => H.ui.layoutRenderer.renderPanel(id, parent),
      };
      H.ui.setUnsupportedFeatures(unsupportedFeatures(eraProfile(era)));
      H.ui.setClientRules(eraClientRules(eraProfile(era)));
      H.ui.setFellowshipData({
        fellowshipName: 'Fellows', leaderGuid: OWN, shareXP: true, evenShare: true, open: true, isLocked: false, selfGuid: OWN,
        fellows: [{ guid: OWN, name: 'Me', level: 20, shareLoot: true }, { guid: OWN + 1, name: 'Them', level: 7, shareLoot: true }],
      });
      H.ui.socialTab = 'fellowship';
      H.ui.toggleSocialPanel();
    }, 60_000);
    afterAll(() => H?.teardown());

    const rect = (id: number): number[] => rectOf((H.ui.socialPanel as HTMLElement).querySelector(`[data-element-id="0x${id.toString(16)}"]`));
    const shown = (id: number): boolean => ((H.ui.socialPanel as HTMLElement).querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement).style.display !== 'none';

    it(is1999 ? 'one row: Recruit, Dismiss, Quit on the bottom slots; the list grows over the emptied row'
      : 'the six-button grid and the list on their DAT rects', () => {
      const check = (): void => {
        for (const [id, r] of IN_FELLOWSHIP_RECTS) {
          if (is1999 && [0x1000027b, 0x1000027d, 0x10000280].includes(id)) { expect(shown(id), id.toString(16)).toBe(false); continue; }
          let want = [...r];
          if (is1999 && id === 0x1000027c) want = [198, 567, 79, 30];
          if (is1999 && (id === 0x10000279 || id === 0x1000027a)) want = [r[0], r[1], r[2], r[3] + 33];
          expect(rect(id), id.toString(16)).toEqual(want);
        }
      };
      check();
      // The pane is redrawn on every fellowship change: nothing moves twice.
      H.ui.renderSocialPanel();
      check();
    });
  });
}
