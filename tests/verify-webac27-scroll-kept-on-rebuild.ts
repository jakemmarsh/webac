/**
 * webac#27 item 1 (AC1999, every era: shared GameUI) — moving an item within
 * a scrolled pack jumped the grid back to the top.
 *
 * Mechanism: every inventory change (the server's ContainId for the move,
 * a pickup, a stack size) runs syncInventoryUI → GameUI.setInventoryData →
 * renderInventoryPanel, which closes the panel and builds a fresh grid
 * viewport; nothing carried the old viewport's scrollTop over, so it read 0.
 *
 * Retail keeps it:
 *  - end of retail: UIElement_ItemList::ServerSaysMoveItem @ 004e5000 →
 *    ItemList_SetParentContainer @ 004e49d0 (Flush + AddItem) leaves the list
 *    box's m_iScrollableY; SetScrollableXY @ 004740c0 clamps it. Only opening
 *    another container scrolls home (ListenToElementMessage @ 004e4d50 →
 *    ScrollToHome @ 0048b120).
 *  - 1999: ItemList_SetParentContainer @ 0x0053b330 saves the offset for the
 *    same container and restores it through 0x005d4460 (clamp 0x005d4860).
 *
 * Sweep: the same rebuild shape in the social, spellbook, contracts panels
 * and the character list. Each block below fails on the old code.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { withSpellRowTemplate } from './_harness/spell-row-stub.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import {
  captureScroll, restoreScroll, clampScroll, scrollKeyPath,
} from '../packages/renderer/src/ui/ScrollKeep.js';

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

describe('ScrollKeep — capture / restore / clamp', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  beforeAll(() => installDomGlobals(domWindow, DOM_GLOBALS, saved));
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  function build(key: string): HTMLElement {
    const root = domWindow.document.createElement('div');
    const pane = domWindow.document.createElement('div');
    pane.dataset.elementId = '0x10000001';
    const vp = domWindow.document.createElement('div');
    vp.dataset.scrollKey = key;
    pane.appendChild(vp);
    root.appendChild(pane);
    return root;
  }

  it('a rebuilt viewport with the same key path gets the old offset, and its scroll listeners hear it', () => {
    const a = build('grid:1');
    (a.querySelector('[data-scroll-key]') as HTMLElement).scrollTop = 96;
    const snap = captureScroll(a);
    const b = build('grid:1');
    const vp = b.querySelector('[data-scroll-key]') as HTMLElement;
    let heard = 0;
    vp.addEventListener('scroll', () => { heard++; });
    expect(restoreScroll(b, snap)).toBe(1);
    expect(vp.scrollTop).toBe(96);
    expect(heard).toBe(1);
    expect(scrollKeyPath(vp, b)).toBe('k:grid:1<e:0x10000001');
  });

  it('another key (another pack) starts at the top: ScrollToHome', () => {
    const a = build('grid:1');
    (a.querySelector('[data-scroll-key]') as HTMLElement).scrollTop = 96;
    const b = build('grid:2');
    restoreScroll(b, captureScroll(a));
    expect((b.querySelector('[data-scroll-key]') as HTMLElement).scrollTop).toBe(0);
  });

  it('clamps to what the new content can scroll (SetScrollableXY @ 004740c0 / 1999 0x005d4860)', () => {
    const el = domWindow.document.createElement('div');
    Object.defineProperty(el, 'scrollHeight', { value: 160 });
    Object.defineProperty(el, 'clientHeight', { value: 96 });
    expect(clampScroll(el, 300, 0).top).toBe(64);
    expect(clampScroll(el, -5, 0).top).toBe(0);
    expect(clampScroll(el, 32, 0).top).toBe(32);
    const fits = domWindow.document.createElement('div');
    Object.defineProperty(fits, 'scrollHeight', { value: 50 });
    Object.defineProperty(fits, 'clientHeight', { value: 96 });
    expect(clampScroll(fits, 64, 0).top).toBe(0);
  });
});

describe('webac#27 — the pack grid keeps its scroll across an inventory rebuild', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const PLAYER = 0x50000001;
  const PACK = 0x8000ff01;

  function stubLayoutRenderer() {
    return {
      renderPanel: (_layoutId: number, container: HTMLElement) => {
        const wrapper = domWindow.document.createElement('div');
        container.appendChild(wrapper);
        const root = domWindow.document.createElement('div');
        wrapper.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of [0x100001cc, 0x100001cd, 0x100001ce, 0x100001cf, 0x100001d0]) {
          const el = domWindow.document.createElement('div');
          el.dataset.elementId = `0x${id.toString(16)}`;
          root.appendChild(el);
          elements.set(id, el);
        }
        return { root, elements, setText: () => {}, close: () => { wrapper.remove(); } };
      },
    };
  }

  function item(id: number, containerId: number, extra: Record<string, unknown> = {}) {
    return {
      id, weenieClassId: id & 0xffff, name: `Item ${id & 0xff}`, value: 1, burden: 10, iconDid: 0,
      stackSize: 1, maxStackSize: 1, stackable: false, containerId, itemType: 0, ...extra,
    };
  }

  let items: ReturnType<typeof item>[] = [];
  const grid = (): HTMLElement => ui.inventoryPanel.querySelector('[data-scroll-key^="inv-grid:"]') as HTMLElement;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = stubLayoutRenderer();
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  beforeEach(() => {
    // ~35 items in the main pack (the reporter's case) plus a side pack.
    items = [];
    for (let i = 0; i < 35; i++) items.push(item(0x80001000 + i, PLAYER));
    items.push(item(PACK, PLAYER, { itemType: 0x200, itemsCapacity: 24 }));
    for (let i = 0; i < 20; i++) items.push(item(0x80002000 + i, PACK));
    ui.selectedPackSlot = 0;
    ui.setSidePackGuids([PLAYER, PACK]);
    ui.setInventoryData(items, [], 30, 15000, 102);
    if (!ui.inventoryVisible) ui.toggleInventory();
    else ui.renderInventoryPanel();
  });

  it('a move within the scrolled main pack (the server ContainId → setInventoryData) keeps the grid offset', () => {
    const before = grid();
    before.scrollTop = 160; // scrolled down with the bar's arrow
    // The move: item 0 now sits at slot 30 (the confirm re-lists the pack).
    const moved = [...items.slice(1, 31), items[0], ...items.slice(31)];
    ui.setInventoryData(moved, [], 30, 15000, 102);
    const after = grid();
    expect(after).not.toBe(before); // the panel really was rebuilt
    expect(after.scrollTop).toBe(160);
  });

  it('a pending-item ghost (showPendingInPack / endPendingInPack) keeps it too', () => {
    grid().scrollTop = 96;
    ui.showPendingInPack({ guid: 0x80009999, index: 3, packSlot: 0, name: 'Ghost', iconDid: 0 });
    expect(grid().scrollTop).toBe(96);
    ui.endPendingInPack(0x80009999);
    expect(grid().scrollTop).toBe(96);
  });

  it('opening another pack starts its grid at the top, and coming back starts the main pack at the top (retail ScrollToHome)', () => {
    grid().scrollTop = 160;
    ui.selectedPackSlot = 1;
    ui.renderInventoryPanel();
    expect(grid().dataset.scrollKey).toBe(`inv-grid:${PACK}`);
    expect(grid().scrollTop).toBe(0);
    grid().scrollTop = 32;
    ui.setInventoryData(items, [], 30, 15000, 102);
    expect(grid().scrollTop).toBe(32); // a rebuild of the side pack keeps its own offset
    ui.selectedPackSlot = 0;
    ui.renderInventoryPanel();
    expect(grid().scrollTop).toBe(0);
  });

  it('the kept offset is clamped when the rebuilt grid is shorter', () => {
    const proto = domWindow.HTMLElement.prototype;
    const sh = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
    const ch = Object.getOwnPropertyDescriptor(proto, 'clientHeight');
    try {
      grid().scrollTop = 400;
      Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() { return (this as HTMLElement).dataset?.scrollKey ? 192 : 0; } });
      Object.defineProperty(proto, 'clientHeight', { configurable: true, get() { return (this as HTMLElement).dataset?.scrollKey ? 96 : 0; } });
      ui.setInventoryData(items, [], 30, 15000, 102);
      expect(grid().scrollTop).toBe(96);
    } finally {
      if (sh) Object.defineProperty(proto, 'scrollHeight', sh); else delete proto.scrollHeight;
      if (ch) Object.defineProperty(proto, 'clientHeight', ch); else delete proto.clientHeight;
    }
  });
});

describe('webac#27 sweep — the social panel keeps a list scroll on the same tab', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const ALLEG_PANE = 0x10000291;
  const PANE_IDS = [0x10000513, ALLEG_PANE, 0x10000292, 0x1000054a];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    const TOP_IDS = [0x1000028b, 0x1000028c, 0x1000028e, 0x10000512, 0x1000053b, 0x10000290, ...PANE_IDS];
    const mk = (parent: HTMLElement, id: number): HTMLElement => {
      const el = domWindow.document.createElement('div');
      el.dataset.elementId = `0x${id.toString(16)}`;
      parent.appendChild(el);
      return el;
    };
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of TOP_IDS) elements.set(id, mk(root, id));
        const pane = elements.get(ALLEG_PANE)!;
        const header = mk(pane, 0x10000250);
        for (const id of [0x10000251, 0x10000252, 0x10000253, 0x10000254]) mk(header, id);
        for (const sec of [0x10000255, 0x1000025a]) {
          const f = mk(pane, sec);
          for (const id of [0x10000256, 0x10000257, 0x10000258, 0x10000259, 0x1000025b, 0x1000025c, 0x1000025d]) mk(f, id);
          const xp = mk(f, 0x10000490); mk(xp, 0x10000491); mk(xp, 0x10000492);
        }
        mk(pane, 0x1000025e); mk(pane, 0x1000025f);
        const list = mk(pane, 0x10000260);
        list.style.height = '350px';
        mk(pane, 0x10000261); mk(pane, 0x10000262);
        for (const id of [0x10000263, 0x10000264, 0x10000265]) {
          const btn = mk(pane, id);
          for (const sid of [0x100002ce, 0x100002cf, 0x100002d0]) mk(btn, sid);
        }
        return {
          root, elements,
          setState: () => {}, setText: () => {}, setInteractive: () => {},
          setVisible: (id: number, on: boolean) => { const el = elements.get(id); if (el) el.style.display = on ? '' : 'none'; },
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (layoutId: number, parent: HTMLElement) => (ui.layoutRenderer as any).renderPanel(layoutId, parent),
    };
    const members = [
      { guid: 100, parentGuid: 0, name: 'Self Test', level: 120, rank: 3, isOnline: true, xpProduced: 1 },
    ];
    for (let i = 0; i < 20; i++) members.push({ guid: 200 + i, parentGuid: 100, name: `Vassal ${i}`, level: 50, rank: 1, isOnline: true, xpProduced: i });
    ui.setAllegianceData({ allegianceName: 'A', playerRank: 3, totalMembers: 21, totalVassals: 20, isLocked: false, selfGuid: 100, members });
    if (ui.uiManager.currentScreen !== 'game') ui.uiManager.setScreen('game');
    ui.socialTab = 'allegiance';
    if (!ui.socialPanelVisible) ui.toggleSocialPanel();
    else ui.renderSocialPanel();
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  const vassalScroll = (): HTMLElement => ui.socialPanel.querySelector('[data-element-id="0x10000260"] [data-scroll-key="panel-scroll"]') as HTMLElement;

  it('clicking a vassal (which rebuilds the panel) keeps the vassal list where it was scrolled', () => {
    const before = vassalScroll();
    expect(before).toBeTruthy();
    before.scrollTop = 200;
    const row = [...ui.socialPanel.querySelectorAll('.vassal-row')][12] as HTMLElement;
    row.dispatchEvent(new domWindow.Event('click', { bubbles: true }));
    const after = vassalScroll();
    expect(after).not.toBe(before);
    expect(after.scrollTop).toBe(200);
  });

  it('a tab switch and back starts at the top', () => {
    vassalScroll().scrollTop = 200;
    ui.socialTab = 'fellowship';
    ui.renderSocialPanel();
    ui.socialTab = 'allegiance';
    ui.renderSocialPanel();
    expect(vassalScroll().scrollTop).toBe(0);
  });
});

describe('webac#27 sweep — the spellbook list keeps its scroll across a rebuild', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let MagicSchool: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    MagicSchool = (await import('../packages/shared/src/magic/SpellEngine.js')).MagicSchool;
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    const IDS = [0x100002a8, 0x100002a9, 0x100002aa, 0x100002ab, 0x100002ac];
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of IDS) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        return {
          root, elements,
          setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
        };
      },
      render: withSpellRowTemplate((_layoutId: number, parent: HTMLElement) => (ui.layoutRenderer.renderPanel(_layoutId, parent))),
    };
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  const spell = (id: number) => ({
    id, name: `Spell ${id}`, school: MagicSchool.WarMagic ?? MagicSchool.War, level: 1, power: 1, manaCost: 5,
    difficulty: 50, duration: 0, components: [], targetType: 2,
  });
  const list = (): HTMLElement => ui.magicPanel.querySelector('[data-scroll-key="spellbook-list"]') as HTMLElement;

  it('learning a spell (setSpellData → renderMagicPanel) keeps the list offset', () => {
    const spells = Array.from({ length: 30 }, (_, i) => spell(i + 1));
    ui.setSpellData(spells);
    if (!ui.magicVisible) ui.toggleMagicPanel();
    const before = list();
    before.scrollTop = 256;
    ui.setSpellData([...spells, spell(99)]);
    expect(list()).not.toBe(before);
    expect(list().scrollTop).toBe(256);
  });
});

describe('webac#27 sweep — the contracts list keeps its scroll on the same tab', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const GameUI = mod.GameUI;
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const CP = (GameUI as any).CONTRACT_PANEL;
    const TOP_IDS = [CP.window, CP.closeButton, CP.tabs.contracts, CP.tabs.journal, CP.tabs.page_list, CP.panes.contracts, CP.panes.journal, CP.panes.page_list];
    const CONTRACTS_PANE_CHILDREN = [
      0x100005ce, 0x100005d6, 0x100005cf, 0x100005d0, 0x100005d8, 0x100005d9, 0x100005da, 0x100005db,
      0x100005dc, 0x100005dd, 0x100005de, 0x100005df, 0x100005e0, 0x100005e1, 0x100005e2, 0x100005e3,
    ];
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const doc = domWindow.document;
        const wrapper = doc.createElement('div');
        parent.appendChild(wrapper);
        const root = doc.createElement('div');
        wrapper.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of TOP_IDS) {
          const el = doc.createElement('div');
          el.dataset.elementId = `0x${id.toString(16)}`;
          root.appendChild(el);
          elements.set(id, el);
          if (id === CP.panes.contracts) {
            for (const cid of CONTRACTS_PANE_CHILDREN) {
              const c = doc.createElement('div');
              c.dataset.elementId = `0x${cid.toString(16)}`;
              el.appendChild(c);
            }
          }
        }
        return {
          root, elements, setText: () => {}, setInteractive: () => {}, setTexture: () => {}, setState: () => {}, destroy: () => {},
          setVisible: (id: number, on: boolean) => { const el = elements.get(id); if (el) el.style.display = on ? '' : 'none'; },
          onClick: (id: number, handler: (id: number, el: HTMLElement) => void) => { const el = elements.get(id); el?.addEventListener('click', () => handler(id, el)); },
          close: () => { wrapper.remove(); }, moveTo: () => {}, bringToFront: () => {},
        };
      },
    };
  });
  afterAll(() => {
    if (ui?.contractVisible) ui.toggleContractPanel();
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  const list = (): HTMLElement => ui.contractPanel.querySelector('[data-element-id="0x100005cf"]') as HTMLElement;

  it('a contract update (renderContractPanel) keeps the list offset; another tab and back starts at the top', () => {
    const contracts = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, name: `Quest ${i}`, description: '', stage: 1 }));
    ui.contractTab = 'contracts';
    ui.setContractData({ ...ui.contractData, contracts });
    if (!ui.contractVisible) ui.toggleContractPanel();
    const before = list();
    before.scrollTop = 120;
    ui.setContractData({ ...ui.contractData, contracts: [...contracts, { id: 99, name: 'New Quest', description: '', stage: 1 }] });
    expect(list()).not.toBe(before);
    expect(list().scrollTop).toBe(120);
    ui.contractTab = 'journal';
    ui.renderContractPanel();
    ui.contractTab = 'contracts';
    ui.renderContractPanel();
    expect(list().scrollTop).toBe(0);
  });
});

describe('webac#27 sweep — the character list keeps its scroll across a redraw', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); }, 60_000);
  afterAll(() => H?.teardown());

  it('a row click / re-sent list (renderCharacterSelect) keeps the list offset', () => {
    const slots = Array.from({ length: 30 }, (_, i) => ({ id: String(i + 1), name: `Char${i}`, level: 1, heritage: 1, gender: 1, location: '', lastPlayed: 0 }));
    H.ui.showCharacterSelect(slots, 30);
    const before = H.container.querySelector('[data-scroll-key="charsel-list"]') as HTMLElement;
    expect(before).toBeTruthy();
    before.scrollTop = 140;
    H.ui.showCharacterSelect(slots, 30);
    const after = H.container.querySelector('[data-scroll-key="charsel-list"]') as HTMLElement;
    expect(after).not.toBe(before);
    expect(after.scrollTop).toBe(140);
  });
});
