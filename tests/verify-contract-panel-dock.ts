/**
 * CORE.15 — the contracts panel (Q) is a DOCK-BODY PAGE, not a top-left
 * parchment scroll.
 *
 * Retail ground truth (tools/dump-layout.mjs + decompiled client):
 *  - Dock slot 0x10000559 ((0,0) 300x362, edges L1T1R1B1) bases
 *    0x21000063:0x1000055f in BOTH HUD families — classic dock 0x21000017
 *    AND the EoL floaty panels window 0x2100006e — exactly like the world
 *    panel slot 0x1000018c (CORE.5.d).
 *  - Layout 0x21000063 tabs resolve to Contracts / Journal / Page List
 *    (strings 246684546 / 54441842 / 115694386); the previous middle tab
 *    "Quest Log" was invented.
 *  - The close button 0x10000562 carries DAT X art (state1 0x06001393 /
 *    state3 0x06001394).
 *  - The three stacked panes base 0x21000069 (class 0x1000004B
 *    gmContractsUI), 0x21000066 (0x10000048 gmJournalUI) and 0x21000067
 *    (0x10000049 gmPageListUI).
 *
 * Covers:
 *  - the DAT determinations above (DAT-gated)
 *  - GameUI.CONTRACT_PANEL static bindings vs the DAT
 *  - pure journal helpers (filterJournalPages / journalTimerText)
 *  - renderContractPanel driven behaviorally via a stub layoutRenderer
 *    (happy-dom; executes the shipped code, no source-text pins)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { panelsWindowPlacement } from '../packages/renderer/src/ui/PanelsWindow.js';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const LOCAL_DAT = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');

// The expected bindings, asserted against BOTH the DAT and the shipped
// GameUI.CONTRACT_PANEL static (imported lazily to avoid DOM needs here).
const EXPECTED = {
  layout: 0x21000063,
  window: 0x1000055f,
  dockSlot: 0x10000559,
  closeButton: 0x10000562,
  tabs: { contracts: 0x100005d3, journal: 0x10000560, page_list: 0x10000561 },
  tabStrings: { contracts: 246684546, journal: 54441842, page_list: 115694386 },
  panes: { contracts: 0x100005d4, journal: 0x10000563, page_list: 0x10000564 },
};

/* eslint-disable @typescript-eslint/no-explicit-any */

function findElement(layout: any, id: number): any | null {
  const walk = (el: any): any | null => {
    if ((el.elementId >>> 0) === (id >>> 0)) return el;
    for (const [, c] of el.children) {
      const r = walk(c);
      if (r) return r;
    }
    return null;
  };
  for (const [, e] of layout.elements) {
    const r = walk(e);
    if (r) return r;
  }
  return null;
}

describe.skipIf(!existsSync(LOCAL_DAT) || !existsSync(PORTAL_DAT))('CORE.15 — contracts panel DAT determinations', () => {
  let parse: (id: number) => any;
  let strings: Map<number, string>;

  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes, parseStringTable } =
      await import('../packages/dat-parser/src/file-types/LayoutDesc.js');
    const portal = openDat(PORTAL_DAT);
    setMasterPropertyTypes(parseMasterProperty(new DatReader(portal.getFileData(0x39000001)!)));
    const db = openDat(LOCAL_DAT);
    parse = (id: number) => {
      const data = db.getFileData(id);
      expect(data, `layout 0x${id.toString(16)} present`).toBeTruthy();
      return parseLayoutDesc(new DatReader(data!));
    };
    const st = parseStringTable(new DatReader(db.getFileData(0x23000001)!));
    strings = new Map(st.entries.map((e: any) => [e.id, e.strings[0] ?? '']));
  });

  it('slot 0x10000559 bases 0x21000063:0x1000055f in BOTH HUD families, 300x362 L1T1R1B1', () => {
    for (const hostId of [0x21000017, 0x2100006e]) {
      const layout = parse(hostId);
      const slot = findElement(layout, EXPECTED.dockSlot);
      expect(slot, `slot in 0x${hostId.toString(16)}`).toBeTruthy();
      expect(slot.baseLayout >>> 0).toBe(EXPECTED.layout);
      expect(slot.baseElement >>> 0).toBe(EXPECTED.window);
      expect([slot.width, slot.height]).toEqual([300, 362]);
      expect([slot.leftEdge, slot.topEdge, slot.rightEdge, slot.bottomEdge]).toEqual([1, 1, 1, 1]);
    }
  });

  it('0x21000063 tabs resolve to Contracts / Journal / Page List at (0,0)/(92,0)/(184,0)', () => {
    const layout = parse(EXPECTED.layout);
    const tabGeom: Array<[number, number, number, string]> = [
      [EXPECTED.tabs.contracts, 0, EXPECTED.tabStrings.contracts, 'Contracts'],
      [EXPECTED.tabs.journal, 92, EXPECTED.tabStrings.journal, 'Journal'],
      [EXPECTED.tabs.page_list, 184, EXPECTED.tabStrings.page_list, 'Page List'],
    ];
    for (const [id, x, strId, label] of tabGeom) {
      const tab = findElement(layout, id);
      expect(tab, `tab 0x${id.toString(16)}`).toBeTruthy();
      expect([tab.x, tab.y, tab.width, tab.height]).toEqual([x, 0, 92, 25]);
      const p23 = tab.properties.get(23);
      expect(p23?.valueString?.stringId, `tab 0x${id.toString(16)} p23`).toBe(strId);
      expect(strings.get(strId)).toBe(label);
    }
  });

  it('close button 0x10000562 at (276,0) carries the DAT X art (state1/state3)', () => {
    const layout = parse(EXPECTED.layout);
    const close = findElement(layout, EXPECTED.closeButton);
    expect(close).toBeTruthy();
    expect([close.x, close.y, close.width, close.height]).toEqual([276, 0, 24, 25]);
    const mediaFiles = (stateId: number): number[] =>
      [...(close.states.get(stateId)?.media ?? [])].map((m: any) => m.file >>> 0);
    expect(mediaFiles(1)).toContain(0x06001393);
    expect(mediaFiles(3)).toContain(0x06001394);
  });

  it('panes base the retail class layouts (contracts/journal/page-list)', () => {
    const layout = parse(EXPECTED.layout);
    const paneBases: Array<[number, number, number]> = [
      [EXPECTED.panes.contracts, 0x21000069, 0x100005cd],
      [EXPECTED.panes.journal, 0x21000066, 0x1000055b],
      [EXPECTED.panes.page_list, 0x21000067, 0x1000055c],
    ];
    for (const [paneId, baseLayout, baseElement] of paneBases) {
      const pane = findElement(layout, paneId);
      expect(pane, `pane 0x${paneId.toString(16)}`).toBeTruthy();
      expect(pane.baseLayout >>> 0).toBe(baseLayout);
      expect(pane.baseElement >>> 0).toBe(baseElement);
    }
  });

  it('the retail contracts pane class is registered as 0x1000004B (gmContractsUI)', () => {
    // 0x21000069's window element type IS the element-class id retail
    // registers in gmContractsUI::Register @ 00499c80.
    const layout = parse(0x21000069);
    const win = findElement(layout, 0x100005cd);
    expect(win).toBeTruthy();
    expect(win.type >>> 0).toBe(0x1000004b);
  });
});

// ── shipped static bindings + pure helpers (no DAT/DOM needed) ─────────

describe('CORE.15 — GameUI.CONTRACT_PANEL static + journal helpers', () => {
  let GameUICtor: any;
  beforeAll(async () => {
    ({ GameUI: GameUICtor } = await import('../packages/renderer/src/ui/GameUI.js'));
  });

  it('CONTRACT_PANEL matches the DAT determinations', () => {
    expect(GameUICtor.CONTRACT_PANEL).toEqual(EXPECTED);
  });

  it('filterJournalPages is a case-insensitive substring match over title/label/notes', () => {
    const pages = [
      { title: 'Aerlinthe Run', label: 'quest', notes: 'bring lockpicks' },
      { title: 'Shopping', label: 'chores', notes: 'buy Motes' },
      { title: '', label: '', notes: '' },
    ];
    expect(GameUICtor.filterJournalPages(pages, '')).toEqual([0, 1, 2]);
    expect(GameUICtor.filterJournalPages(pages, 'aerlinthe')).toEqual([0]);
    expect(GameUICtor.filterJournalPages(pages, 'QUEST')).toEqual([0]);
    expect(GameUICtor.filterJournalPages(pages, 'motes')).toEqual([1]);
    expect(GameUICtor.filterJournalPages(pages, 'nothing-here')).toEqual([]);
  });

  it('journalTimerText matches retail GetTimerText @ 004956a0: None / countdown / Ready', () => {
    const now = 1_000_000_000;
    // No timer running → "None" (the page-list Timer column shows this).
    expect(GameUICtor.journalTimerText(null, now)).toBe('None');
    // Running but elapsed → "Ready" — the timer does NOT revert to editable.
    expect(GameUICtor.journalTimerText(now - 1, now)).toBe('Ready');
    expect(GameUICtor.journalTimerText(now, now)).toBe('Ready');
    // Running → ClientUISystem::DeltaTimeToString format (seconds always).
    expect(GameUICtor.journalTimerText(now + 90_000, now)).toBe('1m 30s');
    expect(GameUICtor.journalTimerText(now + 3 * 86_400_000, now)).toBe('3d 0s');
  });

  it('deltaTimeToString matches retail ClientUISystem::DeltaTimeToString @ 00565e10', async () => {
    const { deltaTimeToString } = await import('../packages/shared/src/index.js');
    // Zero units omitted EXCEPT seconds, which always print.
    expect(deltaTimeToString(0)).toBe('0s');
    expect(deltaTimeToString(45)).toBe('45s');
    expect(deltaTimeToString(300)).toBe('5m 0s');
    expect(deltaTimeToString(3600)).toBe('1h 0s');
    expect(deltaTimeToString(86_400 + 3_600 + 60 + 5)).toBe('1d 1h 1m 5s');
    // Months are 30-day blocks (0x278d00 = 2,592,000s).
    expect(deltaTimeToString(2_592_000 + 86_400 * 2 + 30)).toBe('1mo 2d 30s');
    // Fractional seconds truncate (retail _ftol2).
    expect(deltaTimeToString(59.9)).toBe('59s');
  });

  it('pageSortLess timer criteria keys on the running flag, elapsed included (PageInfoSortTimer @ 00494a00)', () => {
    const now = 1_000_000_000;
    const expired = { title: '', label: '', timerEndMs: now - 5_000, pageNumber: 3 };
    const future = { title: '', label: '', timerEndMs: now + 5_000, pageNumber: 2 };
    const idle = { title: '', label: '', timerEndMs: null, pageNumber: 1 };
    // Running (even expired) sorts before idle regardless of page number.
    expect(GameUICtor.pageSortLess(expired, idle, 'timer', now)).toBe(true);
    expect(GameUICtor.pageSortLess(idle, expired, 'timer', now)).toBe(false);
    // Running vs running: earlier stamp first.
    expect(GameUICtor.pageSortLess(expired, future, 'timer', now)).toBe(true);
    // Idle vs idle: page number.
    expect(GameUICtor.pageSortLess(idle, { ...idle, pageNumber: 0 }, 'timer', now)).toBe(false);
  });
});

// ── behavioral: renderContractPanel via a stub layoutRenderer ──────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

// Child element ids each pane exposes (from the base layouts 0x21000069 /
// 0x21000066 / 0x21000067) — the stub renders them with data-element-id so
// the shipped datChild() lookups resolve.
const PANE_CHILDREN: Record<number, number[]> = {
  0x100005d4: [
    0x100005ce, 0x100005d6, 0x100005cf, 0x100005d0, 0x100005d8, 0x100005d9,
    0x100005da, 0x100005db, 0x100005dc, 0x100005dd, 0x100005de, 0x100005df,
    0x100005e0, 0x100005e1, 0x100005e2, 0x100005e3,
  ],
  0x10000563: [
    0x10000565, 0x10000566, 0x10000567, 0x10000568, 0x10000569, 0x1000056a,
    0x1000056b, 0x1000056c, 0x1000056d, 0x1000056e, 0x1000056f, 0x10000570,
    0x10000571, 0x10000572, 0x10000573, 0x10000574, 0x10000575, 0x10000576,
    0x10000577, 0x10000578, 0x10000579, 0x1000057a, 0x1000057b, 0x1000057c,
    0x1000057d,
  ],
  0x10000564: [
    0x1000057f, 0x10000580, 0x10000581, 0x10000582, 0x10000583, 0x10000584,
    0x10000585, 0x10000586, 0x10000587, 0x10000588,
  ],
};

describe('CORE.15 — renderContractPanel (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  let ui: any;
  const renderCalls: Array<{ layoutId: number; options: any }> = [];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    const CP = mod.GameUI.CONTRACT_PANEL;
    const TOP_IDS = [
      CP.window, CP.closeButton,
      CP.tabs.contracts, CP.tabs.journal, CP.tabs.page_list,
      CP.panes.contracts, CP.panes.journal, CP.panes.page_list,
    ];
    ui.layoutRenderer = {
      renderPanel: (layoutId: number, parent: HTMLElement, options: any) => {
        renderCalls.push({ layoutId, options });
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
          for (const cid of PANE_CHILDREN[id] ?? []) {
            const c = doc.createElement('div');
            c.dataset.elementId = `0x${cid.toString(16)}`;
            el.appendChild(c);
          }
        }
        return {
          root, elements,
          setText: () => {}, setInteractive: () => {}, setTexture: () => {},
          setState: () => {}, setPalette: () => {}, setDraggable: () => {},
          setDropTarget: () => {}, setScrollable: () => ({}), destroy: () => {},
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
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('opens as the 0x21000063 panel in the panels window with the retail tab trio (no quest_log)', () => {
    const tm = (stage: number, o: Record<string, unknown> = {}) => ({ stage, timeWhenDone: 0, timeWhenRepeats: 0, updatedAtSec: performance.now() / 1000, hasTimerFlag: false, hasRepeatFlag: false, descriptionProgress: '', ...o });
    ui.setContractData({
      contracts: [
        { id: 2, name: 'Test Quest', description: 'line1\nline2', stage: 2, timing: tm(2, { hasTimerFlag: true, timeWhenDone: 30 }), contact: 'Royal Guard', contactLoc: '42.1N, 33.5E', questLoc: '10.0S, 5.0W' },
        { id: 3, name: 'One Shot', description: 'd', stage: 3, timing: tm(3) },
      ],
      journal: [],
    });
    ui.selectedContractIdx = 0;
    ui.toggleContractPanel();

    expect(renderCalls.length).toBeGreaterThan(0);
    const call = renderCalls[renderCalls.length - 1];
    expect(call.layoutId).toBe(0x21000063);
    // VISUAL.char-panel-body-too-bright.a.a — slot 0x10000559 of the panels
    // window: at the window's rect, no dock / tab drag / persistKey.
    const at = panelsWindowPlacement({}, ui.hudLogicalWidth(), ui.hudLogicalHeight());
    expect([call.options.x, call.options.y]).toEqual([at.x, at.y]);
    expect(call.options.persistKey).toBeUndefined();
    expect(call.options.dragHandleId).toBeUndefined();
    expect(call.options.closeButtonId).toBe(0x10000562);

    const panel = ui.contractPanel as HTMLElement;
    expect(panel).toBeTruthy();
    // The contracts pane draws no scrim / leather of its own over the window's.
    const pane = panel.querySelector('[data-element-id="0x100005d4"]') as HTMLElement;
    expect(pane.style.backgroundImage).toBe('none');
    expect(pane.style.backgroundColor).toBe('transparent');
    const tabs = [...panel.querySelectorAll('[data-contract-tab]')].map((el: any) => el.dataset.contractTab);
    expect(tabs.sort()).toEqual(['contracts', 'journal', 'page_list']);
  });

  it('contracts pane renders rows, the Timed countdown row and detail values', () => {
    const panel = ui.contractPanel as HTMLElement;
    expect(panel.querySelectorAll('.contract-row').length).toBe(2);
    expect(panel.querySelectorAll('.contract-row.selected').length).toBe(1);
    // GAP.38 lives on here: the countdown line surfaces in the Timed row.
    const timed = panel.querySelector('.contract-timed');
    expect(timed).toBeTruthy();
    // UpdateButtons: the timer flag's time left through DeltaTimeToString.
    expect(timed!.textContent).toMatch(/^(30|29)s$/);
    // FAITHFUL.512 — multi-line description renders one node per line.
    const notes = panel.querySelector('.contract-notes');
    expect(notes).toBeTruthy();
    expect(notes!.childNodes.length).toBe(2); // 'line1\nline2'
  });

  // BUG.contract-status-strings-not-retail — RefreshContractListbox @ 00499830
  // (every 0.5 s while open) rewrites the texts; the rows stay the same nodes,
  // so the list keeps its scroll.
  it('the Timed and Status texts tick in place (RefreshContractListbox), the rows are not rebuilt', () => {
    const panel = ui.contractPanel as HTMLElement;
    const pane = panel.querySelector('[data-element-id="0x100005d4"]') as HTMLElement;
    const rowsBefore = [...panel.querySelectorAll('.contract-row')];
    ui.refreshContractTexts(pane, performance.now() / 1000 + 31);
    expect(panel.querySelector('.contract-timed')!.textContent).toBe('Finished');
    expect([...panel.querySelectorAll('.contract-row')]).toEqual(rowsBefore);
    // Name order: 'One Shot' (Done), 'Test Quest' (In Progress).
    expect(rowsBefore.map((r) => r.children[1].textContent)).toEqual(['Done', 'In Progress']);
    // Each text sits in its template element's box and clips there.
    const boxes = [...(rowsBefore[0] as HTMLElement).children] as HTMLElement[];
    expect(boxes.map((b) => [b.style.left, b.style.width, b.style.overflow])).toEqual([['0px', '152px', 'hidden'], ['152px', '118px', 'hidden']]);
  });

  it('contract rows take the 20px row template 0x100005d7 and bind the DAT scrollbar 0x100005d0', () => {
    const panel = ui.contractPanel as HTMLElement;
    const row = panel.querySelector('.contract-row') as HTMLElement;
    expect(row.style.height).toBe('20px');
    const list = panel.querySelector('[data-element-id="0x100005cf"]') as HTMLElement;
    expect(list.style.overflowY).toBe('auto');
    const bar = panel.querySelector('[data-element-id="0x100005d0"]') as HTMLElement;
    expect(bar.querySelector('[data-dat-thumb]')).toBeTruthy();
  });

  it('Abandon fires onAbandonContract with the selected contract id', () => {
    const abandoned: number[] = [];
    ui.callbacks.onAbandonContract = (id: number) => abandoned.push(id);
    const panel = ui.contractPanel as HTMLElement;
    const abandonBtn = panel.querySelector('[data-element-id="0x100005dc"]') as HTMLElement;
    expect(abandonBtn).toBeTruthy();
    abandonBtn.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(abandoned).toEqual([2]);
  });

  it('an empty contract list is a bare well with the scrollbar still drawn (VISUAL.contracts-empty-list-invented-text)', () => {
    const data = { contracts: ui.contractData.contracts, journal: ui.contractData.journal };
    ui.setContractData({ contracts: [], journal: [] });
    ui.renderContractPanel();
    const panel = ui.contractPanel as HTMLElement;
    const list = panel.querySelector('[data-element-id="0x100005cf"]') as HTMLElement;
    // RebuildContractListbox @ 00499ca0 adds rows only — no empty-list string.
    expect(list.children.length).toBe(0);
    expect(list.textContent).toBe('');
    expect(panel.textContent).not.toContain('No active contracts');
    // p121 hideDisabled = false: the column stays drawn with its thumb.
    const bar = panel.querySelector('[data-element-id="0x100005d0"]') as HTMLElement;
    expect(bar.style.display).not.toBe('none');
    expect(bar.querySelector('[data-dat-thumb]')).toBeTruthy();
    ui.setContractData(data);
    ui.renderContractPanel();
  });

  it('journal tab persists a page through localStorage and page list filters it', () => {
    // Switch to the journal tab via its rendered tab element.
    const panel = ui.contractPanel as HTMLElement;
    const journalTab = panel.querySelector('[data-contract-tab="journal"]') as HTMLElement;
    journalTab.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));

    const journalPanel = ui.contractPanel as HTMLElement;
    const titleInput = journalPanel.querySelector('.journal-title-input') as HTMLInputElement;
    expect(titleInput).toBeTruthy();
    titleInput.value = 'Aerlinthe Run';
    titleInput.dispatchEvent(new domWindow.Event('input', { bubbles: true }));

    // The shipped save path wrote it to localStorage under the journal key
    // (scope is empty pre-enter-world, so the key is the bare prefix).
    const raw = domWindow.localStorage.getItem('ac_journal_v1:');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).some((p: any) => p.title === 'Aerlinthe Run')).toBe(true);

    // Page list shows the page and search filters it.
    const plTab = journalPanel.querySelector('[data-contract-tab="page_list"]') as HTMLElement;
    plTab.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    const plPanel = ui.contractPanel as HTMLElement;
    expect(plPanel.querySelectorAll('.page-list-row').length).toBeGreaterThan(0);

    ui.toggleContractPanel();
  });

  it('expired timer stays running showing "Ready" + Reset; Reset stops it; Start with zeros re-enters Ready (CORE.15.b)', () => {
    ui.toggleContractPanel(); // reopen
    let panel = ui.contractPanel as HTMLElement;
    const journalTab = panel.querySelector('[data-contract-tab="journal"]') as HTMLElement;
    journalTab.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));

    // Force an elapsed-but-set timer on the current page and re-render:
    // retail keeps m_TimerRunning true past expiry (GetTimerText → "Ready").
    ui.journalPages[ui.journalPageIdx].timerEndMs = Date.now() - 5_000;
    ui.renderContractPanel();

    panel = ui.contractPanel as HTMLElement;
    const runningText = panel.querySelector('[data-element-id="0x1000057c"]') as HTMLElement;
    expect(runningText).toBeTruthy();
    expect(runningText.style.display).not.toBe('none');
    expect(runningText.textContent).toContain('Ready');
    const btn = panel.querySelector('[data-element-id="0x1000057d"]') as HTMLElement;
    expect(btn.textContent).toContain('Reset');
    // d/h/m edit row hidden while running.
    const dayInput = panel.querySelector('[data-element-id="0x10000576"]') as HTMLElement;
    expect(dayInput.style.display).toBe('none');

    // Reset (element 0x1000057d @ 004968d0): stamp=0, running=false →
    // editable row with the Start button.
    btn.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    panel = ui.contractPanel as HTMLElement;
    expect(ui.journalPages[ui.journalPageIdx].timerEndMs).toBeNull();
    const startBtn = panel.querySelector('[data-element-id="0x1000057d"]') as HTMLElement;
    expect(startBtn.textContent).toContain('Start');
    expect((panel.querySelector('[data-element-id="0x1000057c"]') as HTMLElement).style.display).toBe('none');

    // Start with all-zero fields still starts (ResetTimer @ 00495150 sets
    // stamp = cur_time + 0) → running state showing "Ready" immediately.
    startBtn.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    panel = ui.contractPanel as HTMLElement;
    expect(ui.journalPages[ui.journalPageIdx].timerEndMs).not.toBeNull();
    expect((panel.querySelector('[data-element-id="0x1000057c"]') as HTMLElement).textContent).toContain('Ready');
    expect((panel.querySelector('[data-element-id="0x1000057d"]') as HTMLElement).textContent).toContain('Reset');

    ui.toggleContractPanel();
  });
});
