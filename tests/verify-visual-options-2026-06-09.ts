/**
 * Options-panel visual-fidelity pins (burndown 2026-06-09).
 *
 * VISUAL.22 — the options panel previously showed an invented 4-tab set
 * (Display / Audio / Game / Char). The real EoL options panel (DAT tab group
 * 0x2100002b) has Gameplay Options / Character / Chat / Config at DAT string
 * ids 184537202 / 180276994 / 128484658 / 80773714. Content was remapped into
 * the four real tabs with every functional toggle/slider preserved.
 * CORE.17.k.b.b.c.a — the "no per-tab media" premise was wrong: the tabs are
 * 0x2100004d:0x1000043a instances whose 0xb closed / 0xc open states carry the
 * DAT 3-slice cap art + the label colour, driven the way UIElement_Panel::
 * Update @ 0046bd00 drives retail's strip; the former source pin on the
 * hand-painted 0x06004cbe / 0x06004cbf overlay is covered behaviorally by
 * tests/verify-core17kbbca-tab-states.ts.
 *
 * DEBT.test-harness-hygiene: behavioural — the real renderOptionsPanel /
 * addToggleRow / addActionButton driven in happy-dom
 * against a recording LayoutRenderer stub (setText / onClick per element id)
 * and a getTexURL spy returning `tex:<id>` URLs (were GameUI.ts source pins).
 * No DATs are loaded, so labels are the DAT-string fallbacks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GameUI } from '../packages/renderer/src/ui/GameUI.js';
import { mountGameUI, stubLayoutRender, type GameUIFixture } from './_harness/gameui.js';

const tex = (id: number): string => `tex:0x${id.toString(16).padStart(8, '0')}`;

// Options panel 0x2100002b element ids renderOptionsPanel touches (mirrors
// verify-privacy-options.ts / verify-options-panel-behavioral.ts).
const OPT_IDS = [
  0x10000208, 0x10000210, 0x10000211, 0x10000212, 0x10000213, 0x10000216, 0x10000217,
  0x10000218, 0x1000021a, 0x1000021d, 0x10000220, 0x10000221, 0x10000222, 0x1000050c,
  0x10000520, 0x10000521, 0x1000020d, 0x1000020e, 0x1000050b, 0x1000020f,
];

describe('options panel visual fidelity 2026-06-09 (behavioural)', () => {
  let H: GameUIFixture;
  const texts = new Map<number, string>();
  const clicks = new Map<number, () => void>();
  let roots: HTMLElement[] = [];

  beforeAll(async () => {
    H = await mountGameUI();
    const doc = H.win.document;
    H.ui.getTexURL = (id: number) => tex(id);
    H.ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const wrapper = doc.createElement('div');
        parent.appendChild(wrapper);
        const root = doc.createElement('div');
        wrapper.appendChild(root);
        roots.push(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of OPT_IDS) {
          const el = doc.createElement('div');
          el.dataset.elementId = `0x${id.toString(16)}`;
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
          setState: () => {}, setInteractive: () => {}, setVisible: () => {}, setTexture: () => {},
          setText: (id: number, t: string) => { texts.set(id, t); },
          onClick: (id: number, fn: () => void) => { clicks.set(id, fn); },
          close: () => { wrapper.remove(); },
        };
      },
      render: stubLayoutRender(H.win.document),
    };
  }, 60_000);
  afterAll(() => H?.teardown());

  function openTab(tab: string): HTMLElement {
    H.ui.optionsTab = tab;
    if (!H.ui.optionsPanelVisible) H.ui.toggleOptionsPanel();
    else H.ui.renderOptionsPanel();
    return H.ui.optionsPanel as HTMLElement;
  }
  const page = (): HTMLElement => (H.ui.optionsPanel as HTMLElement).querySelector('[data-element-id="0x10000211"]') as HTMLElement;
  const toggleRows = (): HTMLElement[] => [...(H.ui.optionsPanel as HTMLElement).querySelectorAll('.option-toggle-row')] as HTMLElement[];

  it('VISUAL.22 — real EoL tab set replaces the invented one', () => {
    // optionsTab defaults to gameplay (fresh instance, no persisted tab)
    expect(H.ui.optionsTab).toBe('gameplay');
    openTab('gameplay');
    expect(texts.get(0x1000020d)).toBe('Gameplay Options');
    expect(texts.get(0x1000020e)).toBe('Character');
    expect(texts.get(0x1000050b)).toBe('Chat');
    expect(texts.get(0x1000020f)).toBe('Config');
    const tabs = [0x1000020d, 0x1000020e, 0x1000050b, 0x1000020f]
      .map((id) => (H.ui.optionsPanel as HTMLElement).querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement);
    expect(tabs.map((t) => t.dataset.optionsTab)).toEqual(['gameplay', 'character', 'chat', 'config']);
    // the invented Display/Audio/Game/Char labels are gone
    for (const bad of ['Display', 'Audio', 'Game', 'Char']) expect([...texts.values()]).not.toContain(bad);
    // clicking a DAT tab switches the page
    clicks.get(0x1000020f)!();
    expect(H.ui.optionsTab).toBe('config');
  });

  it('VISUAL.23 — toggle rows use DAT checkbox bullets (13x13, 0x06004d17 on / 0x06004d15 off), not On/Off text', () => {
    openTab('character');
    const rows = toggleRows();
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) {
      const bullet = row.firstElementChild as HTMLElement;
      expect([bullet.style.width, bullet.style.height]).toEqual(['13px', '13px']);
      expect(bullet.style.backgroundImage).toContain(tex(row.dataset.optionOn === '1' ? 0x06004d17 : 0x06004d15));
      expect(row.textContent).not.toMatch(/\b(On|Off)$/);
    }
  });

  it('VISUAL.24/CORE.5.c.c — Apply/Reset/Defaults are the adopted DAT buttons, footer only on list tabs', () => {
    const bound: Array<[number, string]> = [];
    const orig = H.ui.bindDatSocialButton.bind(H.ui);
    H.ui.bindDatSocialButton = (scope: HTMLElement, id: number, label: string, action: () => void) => {
      bound.push([id, label]);
      return orig(scope, id, label, action);
    };
    try {
      openTab('gameplay');
      const btn = (id: number) => page().querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement;
      for (const id of [0x100001fc, 0x100001fd, 0x100001fe]) expect(btn(id).style.display).toBe('none');
      // The Gameplay page binds only its own 0x2100002a buttons.
      expect(bound.map(([id]) => id)).toEqual([0x10000203, 0x10000617, 0x10000204, 0x100005cc]);
      bound.length = 0;

      openTab('character');
      for (const id of [0x100001fc, 0x100001fd, 0x100001fe]) {
        expect(btn(id).style.display).toBe('');
        expect(btn(id).className).toBe('options-footer-btn');
      }
      expect(bound).toEqual([[0x100001fc, 'Apply'], [0x100001fd, 'Reset'], [0x100001fe, 'Defaults']]);
      expect(page().textContent).not.toMatch(/\bOK\b/);
    } finally {
      H.ui.bindDatSocialButton = orig;
    }
    // Reset reverts to the panel-open snapshot (bulk apply): the snapshot is
    // a copy of the settings taken when the panel opens
    if (H.ui.optionsPanelVisible) H.ui.toggleOptionsPanel();
    H.ui.toggleOptionsPanel();
    expect(H.ui.optionsSnapshot).toEqual(H.ui.optionsSettings);
    expect(H.ui.optionsSnapshot).not.toBe(H.ui.optionsSettings);
    expect(typeof H.ui.applyOptionsBulk).toBe('function');
  });

  it('VISUAL.71 — without the DAT list box (this fake page has none) the content gets the fallback scroll column, unpadded (the DAT path: verify-options-panel-chrome.ts)', () => {
    let scrolled: HTMLElement | null = null;
    const orig = H.ui.addPanelScrollbar.bind(H.ui);
    H.ui.addPanelScrollbar = (el: HTMLElement) => { scrolled = el; return orig(el); };
    try {
      openTab('character');
      expect(scrolled).not.toBeNull();
      expect(scrolled!.style.padding).toBe('0px');
      expect((scrolled!.firstElementChild as HTMLElement).style.padding).toBe('');
      // The Gameplay page is the DAT layout 0x2100002a, not a scrolled list.
      scrolled = null;
      openTab('gameplay');
      expect(scrolled).toBeNull();
    } finally {
      H.ui.addPanelScrollbar = orig;
    }
  });

  it('VISUAL.72 — Config tab gets DAT slider + dropdown widgets; FoV default is 90 (ACE SmartBox.GameFOV)', () => {
    const calls = { slider: 0, dropdown: 0 };
    const s = H.ui.addSliderRow.bind(H.ui); const d = H.ui.addDropdownRow.bind(H.ui);
    H.ui.addSliderRow = (...a: unknown[]) => { calls.slider++; return s(...a); };
    H.ui.addDropdownRow = (...a: unknown[]) => { calls.dropdown++; return d(...a); };
    try {
      openTab('config');
    } finally {
      H.ui.addSliderRow = s; H.ui.addDropdownRow = d;
    }
    expect(calls.slider).toBeGreaterThan(3);
    expect(calls.dropdown).toBeGreaterThan(0);
    expect(GameUI.OPTIONS_DEFAULTS.fieldOfView).toBe(90);
  });

  // The corner button 0x10000210 hiding the panel (the VISUAL.128 roll-up
  // is gone) is covered through renderPanel's onClose in
  // tests/verify-options-map-frame-migration.ts.

  it('VISUAL.125 / VISUAL.options-panel-eol-window — Gameplay tab is 0x2100002a\'s 7 DAT buttons (EoL 0x060074a7-af art), no toggles; combat toggles live on Character', () => {
    openTab('gameplay');
    const gp = page().querySelector('.options-gameplay-page') as HTMLElement;
    expect(gp.firstElementChild!.getAttribute('data-layout-id')).toBe('0x2100002a');
    const btns = [...page().querySelectorAll('.options-action-btn')] as HTMLElement[];
    expect(btns.map((b) => b.dataset.optionsAction)).toEqual([
      'Exit to Character Selection', 'Exit Game', 'Configure Keyboard', 'Use Mouse Turning Settings',
    ]);
    expect(btns.map((b) => b.dataset.elementId)).toEqual(
      ['0x10000203', '0x10000617', '0x10000204', '0x100005cc']);
    // No DAT here: bindDatSocialButton paints each slice from the button's
    // resolved desc; the old hand-built red 0x06004cda face is gone.
    for (const b of btns) expect(b.style.backgroundImage).not.toContain(tex(0x06004cda));
    expect(toggleRows()).toEqual([]);

    openTab('character');
    // BUG.character-tab-not-retail — retail's section is "Character Behavior";
    // Use Mouse Turning is the Config page's Input row, not a Character row.
    expect(page().textContent).toContain('Character Behavior');
    const keys = toggleRows().map((r) => r.dataset.optionKey);
    expect(keys).toContain('autoTarget');
    expect(keys).not.toContain('useMouseTurning');
    openTab('config');
    expect(toggleRows().map((r) => r.dataset.optionKey)).toContain('useMouseTurning');
  });

  it('DECOMP.gameplay-options-exit-buttons — Exit to Character Selection logs out (onLogout); Exit Game exits to server selection (onExitGame); never reload', () => {
    // gmGameplayOptionsUI::ListenToElementMessage @ 0049e110: 0x10000203 →
    // SendNotice_EndCharacterSession(1); 0x10000617 (retail quit) → back to
    // the launcher in a browser (Jake 2026-10-06).
    openTab('gameplay');
    let logouts = 0;
    let exits = 0;
    const prevLogout = H.ui.callbacks.onLogout;
    const prevExit = H.ui.callbacks.onExitGame;
    H.ui.callbacks.onLogout = () => { logouts++; };
    H.ui.callbacks.onExitGame = () => { exits++; };
    const loc = H.win.location;
    const prevReload = loc.reload;
    let reloads = 0;
    loc.reload = () => { reloads++; };
    try {
      const btn = (label: string) => ([...page().querySelectorAll('.options-action-btn')] as HTMLElement[])
        .find((b) => b.dataset.optionsAction === label)!;
      // EndCharacterSession(1): the ID_Client_EndCharacterSessionConfirm
      // Yes / No dialog first; Yes is the logout.
      // (the harness's stub LayoutRenderer cannot draw the DAT dialog
      // template: the confirmation uses its fallback plate here)
      const lr = H.ui.layoutRenderer;
      H.ui.layoutRenderer = null;
      btn('Exit to Character Selection').click();
      H.ui.layoutRenderer = lr;
      expect(logouts).toBe(0);
      expect(H.ui.logoutConfirmationOpen).toBe(true);
      const yes = H.win.document.querySelectorAll('.ac-dialog-button')[0] as HTMLElement;
      yes.dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));
      expect(logouts).toBe(1);
      expect(exits).toBe(0);
      // Exit Game (retail quit, global 0x10000027): no dialog.
      btn('Exit Game').click();
      expect(logouts).toBe(1);
      expect(exits).toBe(1);
      expect(reloads).toBe(0);
    } finally {
      H.ui.callbacks.onLogout = prevLogout;
      H.ui.callbacks.onExitGame = prevExit;
      loc.reload = prevReload;
    }
  });

  it('NO-DEAD-ENDS — the Gameplay page hides retail\'s dead-end Help Files / Urgent Assistance / Report Abuse buttons', () => {
    openTab('gameplay');
    for (const id of [0x10000205, 0x10000206, 0x10000207]) {
      const el = page().querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement | null;
      if (el) expect(el.style.display).toBe('none');
    }
    expect(([...page().querySelectorAll('.options-action-btn')] as HTMLElement[]).map((b) => b.dataset.optionsAction))
      .not.toContain('Report Abuse');
    expect(H.ui.showHelpPanel).toBeUndefined();
    expect(H.ui.toggleReportAbusePanel).toBeUndefined();
    expect(H.ui.toggleUrgentAssistancePanel).toBeUndefined();
  });

  it('VISUAL.22 — each real tab renders its own content; functional rows preserved across the remap', () => {
    openTab('character');
    let keys = toggleRows().map((r) => r.dataset.optionKey);
    expect(keys).toContain('showHelm');
    expect(keys).toContain('autoTarget');
    openTab('chat');
    keys = toggleRows().map((r) => r.dataset.optionKey);
    expect(keys.some((k) => k!.startsWith('chatMainWindow'))).toBe(true);
    expect(keys.some((k) => k!.startsWith('chatWindow1'))).toBe(true);
    openTab('config');
    expect(toggleRows().length).toBeGreaterThan(0);
  });
});
