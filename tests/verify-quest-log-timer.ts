/**
 * GAP.38 — the contract cooldown/timer line stays surfaced in the panel.
 *
 * Originally this pinned the timer line to the invented "Quest Log" tab.
 * CORE.15 established the retail truth (LayoutDesc 0x21000063 + decompiled
 * gmContractsUI): the tabs are Contracts / Journal / Page List, and the
 * countdown surfaces in the contracts pane's "Timed:" row (m_pTimedText
 * 0x100005e3) for the selected contract. Behavioral: drive the REAL
 * renderContractPanel through a stub layoutRenderer and assert the timer
 * text renders when the selected contract has one, and not when it
 * doesn't.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

// Contracts-pane child ids from the base layout 0x21000069 (see
// verify-contract-panel-dock.ts for the full DAT anchoring).
const CONTRACTS_PANE_CHILDREN = [
  0x100005ce, 0x100005d6, 0x100005cf, 0x100005d0, 0x100005d8, 0x100005d9,
  0x100005da, 0x100005db, 0x100005dc, 0x100005dd, 0x100005de, 0x100005df,
  0x100005e0, 0x100005e1, 0x100005e2, 0x100005e3,
];

describe('GAP.38 — contract timer surfaces in the retail contracts pane (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

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
          if (id === CP.panes.contracts) {
            for (const cid of CONTRACTS_PANE_CHILDREN) {
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
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('selected contract with a timer renders the Timed countdown; one without stays bare', () => {
    ui.contractTab = 'contracts';
    ui.setContractData({
      contracts: [
        { id: 2, name: 'Test Quest Stamping', description: 'd', timer: 'Repeats in 30s', status: 'Pending Repeat' },
        { id: 3, name: 'One Shot', description: 'd', timer: '', status: 'Done' },
      ],
      journal: [],
    });
    ui.selectedContractIdx = 0;
    ui.toggleContractPanel();
    let panel = ui.contractPanel as HTMLElement;
    expect(panel).toBeTruthy();
    const timed = panel.querySelector('.contract-timed');
    expect(timed).toBeTruthy();
    expect(timed!.textContent).toContain('Repeats in 30s');

    // Select the timer-less contract: the Timed value renders empty.
    ui.selectedContractIdx = 1;
    ui.setContractData(ui.contractData);
    panel = ui.contractPanel as HTMLElement;
    expect(panel.querySelector('.contract-timed')).toBeNull();

    ui.toggleContractPanel();
  });
});
