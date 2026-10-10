/**
 * BUG.fellowship-create-button-unwired — the social panel's Create
 * Fellowship button must actually fire the create action.
 *
 * Pre-fix, GameUI invoked this.callbacks.onCreateFellowship?.(name) but
 * nothing ever assigned the callback, so the optional-chain swallowed the
 * click (live proof 2026-08-21: filled the input, clicked, zero fellowship
 * wire traffic). main.ts now wires the callback to send FellowshipCreate
 * (ACE GameActionFellowshipCreate.cs: name String16L + shareXP u32) with
 * shareXP taken from the Share Fellowship Experience option, matching the
 * decompiled retail client (gmFellowshipUI::CreateFellowship reads
 * PlayerModule::FellowshipShareXP, acclient-decompiled.c:145338).
 *
 * Retail also disables the button while the name box is empty
 * (gmFellowshipUI::ListenToElementMessage cases 0x12/0x44,
 * acclient-decompiled.c:146087), so an empty-name click must do nothing.
 *
 * Behavioral (replaces the source-pin in verify-visual-social-2026-06-09.ts):
 * real renderSocialPanel in happy-dom; type into the real input, click the
 * real button, assert the callback payload. Recipe: verify-allegiance-kick.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

// requestAnimationFrame/cancelAnimationFrame included: the member-state
// panel's vitals-bar sync loop (renderSocialPanel) schedules through them.
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

describe('BUG.fellowship-create-button-unwired — Create Fellowship button (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let created: string[] = [];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'animationFrame');
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    // Stub layout handle mirroring the resolved social container 0x21000031
    // with the fellowship pane's DAT-native chrome (CORE.5.c.d.b): the pane
    // 0x10000292 hosts the two state sub-panes 0x10000275 (in-fellowship)
    // and 0x1000026b (empty state) with data-element-id nodes, like the
    // real LayoutRenderer resolves from base 0x21000030:0x1000026a.
    const IDS = [0x1000028b, 0x1000028c, 0x1000028e, 0x10000512, 0x1000053b, 0x10000290, 0x10000513, 0x10000291, 0x10000292, 0x1000054a];
    const BTN_SLICES = [0x100002ce, 0x100002cf, 0x100002d0];
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
        for (const id of IDS) elements.set(id, mk(root, id));
        const pane = elements.get(0x10000292)!;
        const inFrame = mk(pane, 0x10000275);
        mk(inFrame, 0x10000276); mk(inFrame, 0x10000277); mk(inFrame, 0x10000278);
        const list = mk(inFrame, 0x10000279);
        list.style.height = '487px';
        mk(inFrame, 0x1000027a);
        for (const id of [0x1000027b, 0x1000027c, 0x1000027d, 0x1000027e, 0x1000027f, 0x10000280]) {
          const btn = mk(inFrame, id);
          for (const sid of BTN_SLICES) mk(btn, sid);
        }
        const emptyFrame = mk(pane, 0x1000026b);
        mk(emptyFrame, 0x1000026c); mk(emptyFrame, 0x1000026d); mk(emptyFrame, 0x1000026e); mk(emptyFrame, 0x1000026f);
        for (const id of [0x10000270, 0x10000271, 0x10000272, 0x10000273]) mk(mk(emptyFrame, id), 0x10000328);
        const createBtn = mk(emptyFrame, 0x10000274);
        for (const sid of BTN_SLICES) mk(createBtn, sid);
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
      render: (_layoutId: number, parent: HTMLElement) => (ui.layoutRenderer.renderPanel(_layoutId, parent)),
    };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  beforeEach(() => {
    created = [];
    ui.callbacks.onCreateFellowship = (name: string) => { created.push(name); };
    ui.setFellowshipData(null); // you-do-not-belong create state
    ui.socialTab = 'fellowship';
    if (!ui.socialPanelVisible) ui.toggleSocialPanel();
    else ui.renderSocialPanel();
  });

  function panel(): HTMLElement { return ui.socialPanel as HTMLElement; }
  function nameInput(): HTMLInputElement {
    return panel().querySelector('.fellowship-name-input') as HTMLInputElement;
  }
  function createBtn(): HTMLElement {
    // CORE.5.c.d.b — Create is the DAT 3-slice button 0x10000274 itself.
    return panel().querySelector('[data-element-id="0x10000274"]') as HTMLElement;
  }
  function click(el: HTMLElement) {
    el.dispatchEvent(new domWindow.Event('click', { bubbles: true }));
  }
  function type(input: HTMLInputElement, value: string) {
    input.value = value;
    // Retail flips the Create button state on text-changed messages
    // (cases 0x12/0x44) — the binding listens for 'input'.
    input.dispatchEvent(new domWindow.Event('input', { bubbles: true }));
  }

  it('empty state renders the DAT name input (maxLength 34) and the Create button', () => {
    expect(nameInput()).toBeTruthy();
    expect(nameInput().maxLength).toBe(34);
    expect(createBtn()).toBeTruthy();
  });

  // VISUAL.fellowship-create-button-initial-state (premise refuted
  // 2026-09-29): the DAT authors 0x21000030:0x10000274 defSt=13 and
  // gmFellowshipUI::PostInit @ 0048fd40 never changes it, so the empty pane
  // opens on the ghosted art (0x06004c94 fill 42,14,14 — the fill
  // reference/images/hud/fellowship-panel.jpg samples at 42-44,13,13; the
  // state-1 art 0x06004c96 is 92,0,0). Text flips it (cases 0x12/0x44).
  it('opens disabled (state 0xd) with an empty name, enables on text, disables again when cleared', () => {
    expect(createBtn().dataset.acState).toBe('d');
    type(nameInput(), 'Fellows');
    expect(createBtn().dataset.acState).toBe('1');
    type(nameInput(), '');
    expect(createBtn().dataset.acState).toBe('d');
  });

  it('typing a name and clicking Create fires onCreateFellowship with the trimmed name', () => {
    type(nameInput(), '  Playtest Fellows  ');
    click(createBtn());
    expect(created).toEqual(['Playtest Fellows']);
  });

  it('clicking Create with an empty name fires nothing (retail disables the button)', () => {
    type(nameInput(), '   ');
    click(createBtn());
    expect(created).toEqual([]);
  });

  it('member state (fellowshipData set) hides the empty-state pane — no live Create input (retail Update @ 0048f440 shows one state sub-pane)', () => {
    ui.setFellowshipData({
      fellowshipName: 'Existing', leaderGuid: 1, shareXP: true, evenShare: true,
      open: false, isLocked: false,
      fellows: [{ guid: 1, name: 'Leader', level: 10, healthCurrent: 10, healthMax: 10, staminaCurrent: 10, staminaMax: 10, manaCurrent: 10, manaMax: 10, shareLoot: true }],
    });
    const emptyFrame = panel().querySelector('[data-element-id="0x1000026b"]') as HTMLElement;
    expect(emptyFrame.style.display).toBe('none');
    expect(panel().querySelector('.fellowship-name-input')).toBeFalsy();
    const inFrame = panel().querySelector('[data-element-id="0x10000275"]') as HTMLElement;
    expect(inFrame.style.display).not.toBe('none');
  });
});
