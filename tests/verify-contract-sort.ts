/**
 * CORE.15.a — the Contract/Status and #/Title/Timer/Label column headers
 * are retail SORT BUTTONS, not static labels.
 *
 * Ground truth (decompiled EoL client):
 *  - gmContractsUI::ListenToElementMessage @ 0049a3b0: header 0x100005ce
 *    sets eName, 0x100005d6 sets eStatus; clicking the active criteria's
 *    header toggles m_ReverseSort, switching headers resets it to false.
 *    SortContractList @ 0049a260 then re-sorts + rebuilds the listbox.
 *  - Comparators: ContractInfoSortName @ 00495c10 (lowercase wcscmp),
 *    ContractInfoSortStatus @ 004987a0 (both stage-3-with-cooldown →
 *    remaining repeat time; else lowercased status strings, name tiebreak).
 *  - gmPageListUI::ListenToElementMessage @ 004947c0: 0x1000057f ePageNumber
 *    / 0x10000580 eTitle / 0x10000581 eTimer / 0x10000582 eLabel, same
 *    toggle rule; PageInfoSortTimer @ 00494a00 puts running timers first
 *    (by expiry stamp), stopped pages after (by page number).
 *  - Defaults: gmContractsUI ctor @ 00499080 → eName/false; gmPageListUI
 *    ctor @ 00493fe0 → ePageNumber/false.
 *  - Every Reverse* comparator equals the forward comparator with swapped
 *    arguments (all four pairs verified in the decomp).
 *
 * Behavioral: pure predicate/order statics, then the REAL
 * renderContractPanel through a stub layoutRenderer — clicking headers
 * must reorder the actual DOM rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

const CONTRACTS_PANE_CHILDREN = [
  0x100005ce, 0x100005d6, 0x100005cf, 0x100005d0, 0x100005d8, 0x100005d9,
  0x100005da, 0x100005db, 0x100005dc, 0x100005dd, 0x100005de, 0x100005df,
  0x100005e0, 0x100005e1, 0x100005e2, 0x100005e3,
];
const PAGE_LIST_PANE_CHILDREN = [
  0x1000057f, 0x10000580, 0x10000581, 0x10000582, 0x10000583, 0x10000584,
  0x10000585, 0x10000586, 0x10000587, 0x10000588,
];

describe('CORE.15.a — contracts + page-list header sorting (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUI: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUI = mod.GameUI;
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container);
    const CP = GameUI.CONTRACT_PANEL;
    const TOP_IDS = [
      CP.window, CP.closeButton,
      CP.tabs.contracts, CP.tabs.journal, CP.tabs.page_list,
      CP.panes.contracts, CP.panes.journal, CP.panes.page_list,
    ];
    ui.layoutRenderer = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      renderPanel: (_layoutId: number, parent: HTMLElement, _options: any) => {
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
          const children = id === CP.panes.contracts ? CONTRACTS_PANE_CHILDREN
            : id === CP.panes.page_list ? PAGE_LIST_PANE_CHILDREN : null;
          if (children) {
            for (const cid of children) {
              const c = doc.createElement('div');
              c.dataset.elementId = `0x${cid.toString(16)}`;
              el.appendChild(c);
            }
          }
        }
        return {
          root, elements,
          setText: () => {}, setInteractive: () => {}, setTexture: () => {},
          setState: () => {}, destroy: () => {},
          setVisible: (id: number, on: boolean) => {
            const el = elements.get(id);
            if (el) el.style.display = on ? '' : 'none';
          },
          onClick: (id: number, handler: (id: number, el: HTMLElement) => void) => {
            const el = elements.get(id);
            el?.addEventListener('click', () => handler(id, el));
          },
          close: () => { wrapper.remove(); },
          moveTo: () => {}, bringToFront: () => {},
        };
      },
    };
  });
  afterAll(() => {
    if (ui?.contractVisible) ui.toggleContractPanel();
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('nextSortState follows the retail toggle rule', () => {
    // Repeat click on the active header toggles reverse…
    expect(GameUI.nextSortState('name', false, 'name')).toEqual({ criteria: 'name', reverse: true });
    expect(GameUI.nextSortState('name', true, 'name')).toEqual({ criteria: 'name', reverse: false });
    // …switching headers resets to ascending (even from a reversed state).
    expect(GameUI.nextSortState('name', true, 'status')).toEqual({ criteria: 'status', reverse: false });
    expect(GameUI.nextSortState('page', false, 'timer')).toEqual({ criteria: 'timer', reverse: false });
  });

  it('contractSortLess: name is case-insensitive; status orders cooldowns by remaining time with name tiebreak', () => {
    const c = (name: string, status: string, stage?: number, repeatsSec?: number) => ({ name, status, stage, repeatsSec });
    // Case-insensitive name (retail _wcslwr + wcscmp).
    expect(GameUI.contractSortLess(c('alpha', 'x'), c('Beta', 'x'), 'name')).toBe(true);
    expect(GameUI.contractSortLess(c('Beta', 'x'), c('alpha', 'x'), 'name')).toBe(false);
    // Both on repeat cooldown (stage 3 + remaining>0): less remaining first.
    expect(GameUI.contractSortLess(c('a', 'Pending Repeat', 3, 100), c('b', 'Pending Repeat', 3, 500), 'status')).toBe(true);
    expect(GameUI.contractSortLess(c('a', 'Pending Repeat', 3, 500), c('b', 'Pending Repeat', 3, 100), 'status')).toBe(false);
    // Mixed cooldown/non-cooldown falls to the status-string compare.
    expect(GameUI.contractSortLess(c('a', 'In Progress', 2, 0), c('b', 'Pending Repeat', 3, 100), 'status')).toBe(true);
    // Equal status strings tiebreak by name.
    expect(GameUI.contractSortLess(c('Zed', 'Done', 3, 0), c('Ann', 'Done', 3, 0), 'status')).toBe(false);
    expect(GameUI.contractSortLess(c('Ann', 'Done', 3, 0), c('Zed', 'Done', 3, 0), 'status')).toBe(true);
  });

  it('pageSortLess timer: running first by expiry stamp, stopped by page number; reverse order inverts fully', () => {
    const now = 1_000_000;
    const p = (pageNumber: number, timerEndMs: number | null) => ({ title: '', label: '', timerEndMs, pageNumber });
    // Running before stopped.
    expect(GameUI.pageSortLess(p(5, now + 60_000), p(1, null), 'timer', now)).toBe(true);
    expect(GameUI.pageSortLess(p(1, null), p(5, now + 60_000), 'timer', now)).toBe(false);
    // Both running: earlier expiry first.
    expect(GameUI.pageSortLess(p(2, now + 30_000), p(1, now + 60_000), 'timer', now)).toBe(true);
    // An ELAPSED timer still counts as RUNNING — retail m_TimerRunning stays
    // true past expiry (PageInfoSortTimer @ 00494a00 keys on the flag; the
    // countdown shows "Ready" until Reset). CORE.15.b overturned the earlier
    // elapsed-equals-stopped reading here.
    expect(GameUI.pageSortLess(p(1, now - 5_000), p(2, null), 'timer', now)).toBe(true);
    expect(GameUI.pageSortLess(p(2, now - 5_000), p(1, null), 'timer', now)).toBe(true);
    expect(GameUI.pageSortLess(p(1, null), p(2, now - 5_000), 'timer', now)).toBe(false);
    // Reverse = swapped-argument forward: running sinks below stopped.
    const pages = [
      { title: 'a', label: '', timerEndMs: now + 60_000 }, // running (page 1)
      { title: 'b', label: '', timerEndMs: null },          // stopped (page 2)
      { title: 'c', label: '', timerEndMs: now + 30_000 }, // running (page 3)
    ];
    expect(GameUI.sortedPageOrder(pages, [0, 1, 2], 'timer', false, now)).toEqual([2, 0, 1]);
    expect(GameUI.sortedPageOrder(pages, [0, 1, 2], 'timer', true, now)).toEqual([1, 0, 2]);
  });

  it('sortedPageOrder: title/label case-insensitive, page numeric, filtered subset preserved', () => {
    const pages = [
      { title: 'zeta', label: 'M', timerEndMs: null },
      { title: 'Alpha', label: 'z', timerEndMs: null },
      { title: 'beta', label: 'A', timerEndMs: null },
    ];
    expect(GameUI.sortedPageOrder(pages, [0, 1, 2], 'title', false, 0)).toEqual([1, 2, 0]);
    expect(GameUI.sortedPageOrder(pages, [0, 1, 2], 'label', false, 0)).toEqual([2, 0, 1]);
    expect(GameUI.sortedPageOrder(pages, [0, 1, 2], 'page', true, 0)).toEqual([2, 1, 0]);
    // Only the filtered subset is ordered — untouched indexes never appear.
    expect(GameUI.sortedPageOrder(pages, [0, 2], 'title', false, 0)).toEqual([2, 0]);
  });

  const contractRowIds = (): string[] => {
    const panel = ui.contractPanel as HTMLElement;
    const list = panel.querySelector('[data-element-id="0x100005cf"]')!;
    return [...list.querySelectorAll('[data-row-name]')].map(r => (r as HTMLElement).dataset.rowName!);
  };

  it('contracts pane renders name-ascending by default and Status/Contract header clicks re-sort the real rows', () => {
    ui.contractTab = 'contracts';
    ui.contractSortCriteria = 'name';
    ui.contractReverseSort = false;
    ui.setContractData({
      contracts: [
        { id: 1, name: 'Zury Quest', description: '', timer: '', status: 'In Progress', stage: 2, repeatsSec: 0 },
        { id: 2, name: 'apple Run', description: '', timer: '', status: 'Pending Repeat', stage: 3, repeatsSec: 500 },
        { id: 3, name: 'Mule Duty', description: '', timer: '', status: 'Pending Repeat', stage: 3, repeatsSec: 100 },
      ],
      journal: [],
    });
    ui.toggleContractPanel();
    // Default = retail ctor state: eName ascending (case-insensitive).
    expect(contractRowIds()).toEqual(['2', '3', '1']);

    // Click Status: cooldown pair ordered by remaining time (3 before 2),
    // 'In Progress' string sorts before 'Pending Repeat'.
    let panel = ui.contractPanel as HTMLElement;
    (panel.querySelector('[data-element-id="0x100005d6"]') as HTMLElement).click();
    expect(ui.contractSortCriteria).toBe('status');
    expect(ui.contractReverseSort).toBe(false);
    expect(contractRowIds()).toEqual(['1', '3', '2']);

    // Second Status click reverses.
    panel = ui.contractPanel as HTMLElement;
    (panel.querySelector('[data-element-id="0x100005d6"]') as HTMLElement).click();
    expect(ui.contractReverseSort).toBe(true);
    expect(contractRowIds()).toEqual(['2', '3', '1']);

    // Contract header switches back to name and RESETS to ascending.
    panel = ui.contractPanel as HTMLElement;
    (panel.querySelector('[data-element-id="0x100005ce"]') as HTMLElement).click();
    expect(ui.contractSortCriteria).toBe('name');
    expect(ui.contractReverseSort).toBe(false);
    expect(contractRowIds()).toEqual(['2', '3', '1']);
    ui.toggleContractPanel();
  });

  it('page-list header clicks re-sort the real page rows', () => {
    ui.journalLoaded = true;
    ui.journalPages = [
      { title: 'omega', label: 'b', notes: '', location: '', timerEndMs: null },
      { title: 'Acorn', label: 'C', notes: '', location: '', timerEndMs: null },
      { title: 'mid', label: 'a', notes: '', location: '', timerEndMs: null },
    ];
    ui.pageListSearch = '';
    ui.pageListSortCriteria = 'page';
    ui.pageListReverseSort = false;
    ui.contractTab = 'page_list';
    ui.toggleContractPanel();

    const rowIdxs = (): string[] => {
      const panel = ui.contractPanel as HTMLElement;
      const list = panel.querySelector('[data-element-id="0x10000583"]')!;
      return [...list.querySelectorAll('.page-list-row')].map(r => (r as HTMLElement).dataset.pageIdx!);
    };
    // Default ePageNumber ascending.
    expect(rowIdxs()).toEqual(['0', '1', '2']);

    // Title header → case-insensitive title ascending.
    let panel = ui.contractPanel as HTMLElement;
    (panel.querySelector('[data-element-id="0x10000580"]') as HTMLElement).click();
    expect(rowIdxs()).toEqual(['1', '2', '0']);

    // Label header → label ascending (criteria switch resets reverse).
    panel = ui.contractPanel as HTMLElement;
    (panel.querySelector('[data-element-id="0x10000582"]') as HTMLElement).click();
    expect(ui.pageListSortCriteria).toBe('label');
    expect(rowIdxs()).toEqual(['2', '0', '1']);

    // Repeat Label click reverses.
    panel = ui.contractPanel as HTMLElement;
    (panel.querySelector('[data-element-id="0x10000582"]') as HTMLElement).click();
    expect(ui.pageListReverseSort).toBe(true);
    expect(rowIdxs()).toEqual(['1', '0', '2']);
    ui.toggleContractPanel();
  });
});
