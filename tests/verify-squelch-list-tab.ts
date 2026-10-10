/**
 * GAP.40 + CORE.5.c.d — the social panel's Squelch tab renders the REAL
 * squelch list in the DAT-NATIVE pane (0x21000031 pane 0x1000054a ~ base
 * 0x21000060:0x1000053c).
 *
 * Pre-GAP.40 the tab was a self-described placeholder ('No squelched
 * players' static text, never reading squelchedNames). CORE.5.c.d moved
 * the tab onto its own DAT pane: rows go into the DAT list region
 * 0x1000053e using the 0x10000541 row-template grammar (bg 0x06004cca,
 * state-6 selected 0x06001aaf) with the Type column (Character/Account
 * per SquelchInfo.Account — row states 0x10000056/57), and the actions
 * mirror gmSquelchUI::ListenToElementMessage @ 0048c860: Remove sends the
 * account or character unsquelch per the selected row's type; Squelch
 * Character / Squelch Account send the typed name and clear the field.
 *
 * The mock LayoutRenderer mirrors the resolved pane's inherited chrome
 * (data-element-id nodes, 3-slice button children) the way the options
 * behavioral mock mirrors the CORE.5.c.c footer buttons.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

// Squelch-pane chrome per the resolved DAT (tools/dump-layout.mjs 21000060):
// headers, list, scrollbar, name label+field, Remove, divider, the two
// squelch buttons. Buttons carry the shared 3-slice children.
const SQUELCH_PANE = 0x1000054a;
const SQUELCH_CHROME = [0x1000053d, 0x1000051e, 0x1000053e, 0x10000543, 0x1000053f, 0x10000540, 0x10000547, 0x10000548, 0x1000054b, 0x1000054c];
const BTN_IDS = new Set([0x10000547, 0x1000054b, 0x1000054c]);
const BTN_SLICES = [0x100002ce, 0x100002cf, 0x100002d0];
const PANE_IDS = [0x10000513, 0x10000291, 0x10000292, SQUELCH_PANE];

describe('CORE.5.c.d — squelch tab, DAT-native pane (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let unsquelched: string[] = [];
  let charSquelched: string[] = [];
  let accountCalls: Array<{ squelch: boolean; name: string }> = [];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    const TOP_IDS = [0x1000028b, 0x1000028c, 0x1000028e, 0x10000512, 0x1000053b, 0x10000290, ...PANE_IDS];
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of TOP_IDS) {
          const el = domWindow.document.createElement('div');
          el.dataset.elementId = `0x${id.toString(16)}`;
          root.appendChild(el);
          elements.set(id, el);
        }
        // Mirror the squelch pane's resolved inherited chrome.
        const pane = elements.get(SQUELCH_PANE)!;
        for (const id of SQUELCH_CHROME) {
          const el = domWindow.document.createElement('div');
          el.dataset.elementId = `0x${id.toString(16)}`;
          pane.appendChild(el);
          if (BTN_IDS.has(id)) {
            for (const sid of BTN_SLICES) {
              const slice = domWindow.document.createElement('div');
              slice.dataset.elementId = `0x${sid.toString(16)}`;
              el.appendChild(slice);
            }
          }
        }
        return {
          root, elements,
          setState: () => {}, setText: () => {}, setInteractive: () => {},
          setVisible: (id: number, on: boolean) => {
            const el = elements.get(id);
            if (el) el.style.display = on ? '' : 'none';
          },
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (layoutId: number, parent: HTMLElement) => (ui.layoutRenderer as any).renderPanel(layoutId, parent),
    };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  beforeEach(() => {
    unsquelched = [];
    charSquelched = [];
    accountCalls = [];
    ui.callbacks.onUnsquelch = (name: string) => { unsquelched.push(name); };
    ui.callbacks.onSquelchCharacter = (name: string) => { charSquelched.push(name); };
    ui.callbacks.onModifyAccountSquelch = (squelch: boolean, name: string) => { accountCalls.push({ squelch, name }); };
    ui.selectedSquelchName = null;
    ui.socialTab = 'squelch';
    ui.setSquelchList([{ name: 'Zeb', account: false }, { name: 'Alda', account: true }]);
    if (!ui.socialPanelVisible) ui.toggleSocialPanel();
    else ui.renderSocialPanel();
  });

  function pane(): HTMLElement { return ui.socialPanel.querySelector(`[data-element-id="0x${SQUELCH_PANE.toString(16)}"]`) as HTMLElement; }
  function rows(): HTMLElement[] { return [...pane().querySelectorAll('.squelch-row')] as HTMLElement[]; }
  function node(id: number): HTMLElement { return pane().querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement; }
  function click(el: HTMLElement): void { el.dispatchEvent(new domWindow.Event('click', { bubbles: true })); }

  it('shows the squelch pane (not the friends pane) and renders sorted rows into the DAT list region 0x1000053e', () => {
    expect(pane().style.display).not.toBe('none');
    const friendsPane = ui.socialPanel.querySelector('[data-element-id="0x10000513"]') as HTMLElement;
    expect(friendsPane.style.display).toBe('none');
    const r = rows();
    expect(r.length).toBe(2);
    // setSquelchList sorts alphabetically: Alda precedes Zeb; every row
    // lives inside the DAT list element.
    expect(r[0].dataset.rowName).toBe('Alda');
    expect(r[1].dataset.rowName).toBe('Zeb');
    for (const row of r) expect(row.closest('[data-element-id="0x1000053e"]')).toBe(node(0x1000053e));
  });

  it('Type column distinguishes Account vs Character entries (SquelchInfo.Account)', () => {
    const r = rows();
    expect(r[0].textContent).toContain('Account');   // Alda — account squelch
    expect(r[1].textContent).toContain('Character'); // Zeb — character squelch
  });

  it('Remove with no selection is disabled (gmSquelchUI::UpdateButtons state-13), sends nothing', () => {
    click(node(0x10000547));
    expect(unsquelched).toEqual([]);
    expect(accountCalls).toEqual([]);
  });

  it('select a CHARACTER row → Remove fires onUnsquelch with the name', () => {
    click(rows()[1]); // Zeb (character)
    expect(rows().some(r => r.className.includes('selected'))).toBe(true);
    click(node(0x10000547));
    expect(unsquelched).toEqual(['Zeb']);
    expect(accountCalls).toEqual([]);
  });

  it('select an ACCOUNT row → Remove fires onModifyAccountSquelch(false) (retail @ 0048c860 state-0x10000057 branch)', () => {
    click(rows()[0]); // Alda (account)
    click(node(0x10000547));
    expect(accountCalls).toEqual([{ squelch: false, name: 'Alda' }]);
    expect(unsquelched).toEqual([]);
  });

  it('typed name + Squelch Character → onSquelchCharacter, field cleared; empty field leaves the button disabled', () => {
    const input = node(0x10000540).querySelector('input') as HTMLInputElement;
    expect(input).toBeTruthy();
    // Empty field: disabled per retail edit-box gating — click sends nothing.
    click(node(0x1000054b));
    expect(charSquelched).toEqual([]);
    input.value = 'Mallory';
    input.dispatchEvent(new domWindow.Event('input', { bubbles: true }));
    click(node(0x1000054b));
    expect(charSquelched).toEqual(['Mallory']);
    expect(input.value).toBe('');
  });

  it('typed name + Squelch Account → onModifyAccountSquelch(true), field cleared', () => {
    const input = node(0x10000540).querySelector('input') as HTMLInputElement;
    input.value = 'Mallory';
    input.dispatchEvent(new domWindow.Event('input', { bubbles: true }));
    click(node(0x1000054c));
    expect(accountCalls).toEqual([{ squelch: true, name: 'Mallory' }]);
    expect(input.value).toBe('');
  });

  it('setSquelchList removing the selected name clears the selection', () => {
    click(rows()[0]);
    expect(ui.selectedSquelchName).toBe('Alda');
    ui.setSquelchList([{ name: 'Zeb', account: false }]);
    expect(ui.selectedSquelchName).toBeNull();
  });

  it('empty list renders chrome but no rows', () => {
    ui.setSquelchList([]);
    expect(rows().length).toBe(0);
    // The DAT chrome (Remove button, name field) is still present — retail
    // shows the full pane over an empty well, not a placeholder message.
    expect(node(0x10000547)).toBeTruthy();
    expect(node(0x10000540).querySelector('input')).toBeTruthy();
  });
});
