/**
 * CORE.17.h.d — the options-tab option rows carry their OWN DAT art and
 * template geometry. Layout 0x2100002b's list-box templates, resolved
 * through their base chains (tools/dump-layout.mjs + resolveElementDesc):
 *
 *  - slider child 0x1000021c → UIOption_Slider 0x1000036e@0x2100003e (class
 *    0x10000037, a UIElement_Scrollbar): element media 0x06001285 = the
 *    120x12 blue→red gradient track, widget child 1 = 0x06001286 (7x12).
 *    UIElement_Scrollbar::UpdateLayout @ 00470ee0 places the widget at
 *    position × (track − widget) (PositionToWidgetX0Y0 @ 004709a0 over
 *    ComputeActiveSize @ 004702a0); PointToPosition @ 00470240 maps a click
 *    at x to (x − widget/2) / (active − 1). There is no fill bar — the
 *    gradient is drawn full-width whatever the position (chat-options.jpg).
 *    VISUAL3.74 had borrowed the combat bar's 0x21000007 widget (fill
 *    0x06001200 + thumb 0x06001923).
 *  - labels 0x1000021b / 0x10000223 → 0x2100003f:0x1000038e with p20 = 3
 *    (right-justified) at (6,2) 130x14 — every retail label ends at one x;
 *    captions 0x1000021e (146,18) p20 = 2 (left) / 0x1000021f (206,18)
 *    p20 = 3; menu value 0x10000355 p20 = 1 (center); header 0x10000216
 *    p20 = 2 with text inset p35/p37 = 2.
 *  - PlayerOptionPage::AddHeader @ 004f28b0 = template 0 (0x10000216
 *    292x22, no rule), AddSeperator @ 004f2730 = template 1 (0x10000217
 *    292x8, media 0x060012c5); every InitOptions (gmChatOptionsUI @
 *    0049fc60, gmConfigUI) calls Seperator THEN Header for each section
 *    after the first.
 *  - menu 0x10000224 → UIOption_Menu 0x10000353@0x21000043: value plate
 *    child 0x10000355 (0,0) 103x18 media 0x060012b3, arrow button child
 *    0x10000356 (103,0) 17x19 (state 1 0x060012b1, state 6 0x060012b2).
 *  - toggle 0x10000219 → UIOption_Checkbox 0x1000032b@0x21000044 at (6,2):
 *    bullet child 0x10000328 (0,1) 13x13, label inset p35 = 18; rows 20px.
 *
 * Drives the real renderOptionsPanel under happy-dom and inspects the DOM
 * it builds — no source-text pins.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pickNextMenuValue } from './_harness/options-menu.js';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

const OPT_IDS = [
  0x10000208, 0x10000210, 0x10000211, 0x10000212, 0x10000213, 0x10000216, 0x10000217,
  0x10000218, 0x1000021a, 0x1000021d, 0x10000220, 0x10000221, 0x10000222, 0x1000050c,
  0x10000520, 0x10000521, 0x1000020d, 0x1000020e, 0x1000050b, 0x1000020f,
];
const FOOTER_BTN_IDS = [0x100001fc, 0x100001fd, 0x100001fe];

const TEX = {
  track: 0x06001285, thumb: 0x06001286, rule: 0x060012c5,
  menuPlate: 0x060012b3, menuArrow: 0x060012b1, menuArrowHover: 0x060012b2,
  oldFill: 0x06001200, oldThumb: 0x06001923, oldArrow: 0x06001274,
};

describe('CORE.17.h.d — options-tab slider / menu / header art and template geometry (real GameUI under happy-dom)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    if (typeof (g as any).requestAnimationFrame !== 'function') {
      (g as any).requestAnimationFrame = () => 0;
      (g as any).cancelAnimationFrame = () => {};
      (domWindow as any).requestAnimationFrame = (g as any).requestAnimationFrame;
    }
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of OPT_IDS) {
          const el = domWindow.document.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
          if (id === 0x10000211) {
            // the page's DAT list box + scroll column (0x21000028)
            for (const lid of [0x100001fa, 0x100001fb]) {
              const part = domWindow.document.createElement('div');
              part.dataset.elementId = `0x${lid.toString(16)}`;
              el.appendChild(part);
            }
            for (const bid of FOOTER_BTN_IDS) {
              const btn = domWindow.document.createElement('div');
              btn.dataset.elementId = `0x${bid.toString(16)}`;
              for (const sid of [0x100002ce, 0x100002cf, 0x100002d0]) {
                const slice = domWindow.document.createElement('div');
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
    // Fake-populate the texture cache so the real texture-selection branches
    // execute (the happy-dom harness loads no DAT).
    for (const [name, id] of Object.entries(TEX)) ui.uiTextures.set(id, `data:fake-${name}`);
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function renderTab(tab: string): void {
    ui.optionsTab = tab;
    if (!ui.optionsPanelVisible) ui.toggleOptionsPanel();
    else ui.renderOptionsPanel();
  }
  function track(label: string): HTMLElement {
    const t = ui.optionsPanel.querySelector(`[data-slider-label="${label}"]`) as HTMLElement | null;
    expect(t, `slider "${label}"`).toBeTruthy();
    return t!;
  }
  function thumbOf(t: HTMLElement): HTMLElement {
    return t.querySelector('.options-slider-thumb') as HTMLElement;
  }
  function cellFor(text: string): HTMLElement {
    const span = [...ui.optionsPanel.querySelectorAll('span')].find((s: HTMLElement) => s.textContent === text) as HTMLElement;
    expect(span, `text "${text}"`).toBeTruthy();
    return span.closest('.options-text-cell') as HTMLElement;
  }
  function headerFor(text: string): HTMLElement {
    const span = [...ui.optionsPanel.querySelectorAll('span')].find((s: HTMLElement) => s.textContent === text) as HTMLElement;
    expect(span, `header "${text}"`).toBeTruthy();
    const h = span.closest('.options-section-header') as HTMLElement;
    expect(h, `header wrapper "${text}"`).toBeTruthy();
    return h;
  }
  function mousedown(t: HTMLElement, clientX: number): void {
    t.getBoundingClientRect = () => ({ left: 0, width: 120, right: 120, top: 0, bottom: 12, height: 12, x: 0, y: 0, toJSON: () => ({}) });
    t.dispatchEvent(new domWindow.MouseEvent('mousedown', { bubbles: true, clientX }));
  }
  function fresh(): void {
    ui.optionsSettings.chatInactiveOpacity = 50;
    ui.optionsSettings.chatActiveOpacity = 100;
    ui.optionsSettings.chatInactiveOpacitySet = false;
    ui.optionsSettings.chatActiveOpacitySet = false;
  }

  it('the slider is the UIOption_Slider: 120x12 track on 0x06001285 at (146,4), one 7x12 widget on 0x06001286, no fill bar, no combat-bar art', () => {
    fresh();
    renderTab('chat');
    for (const label of ['Inactive Opacity', 'Active Opacity']) {
      const t = track(label);
      expect(t.style.width).toBe('120px');
      expect(t.style.height).toBe('12px');
      expect(t.style.left).toBe('146px');
      expect(t.style.top).toBe('4px');
      expect(t.style.backgroundImage).toContain('data:fake-track');
      expect(t.style.backgroundImage).not.toContain('data:fake-oldFill');
      expect(t.children.length).toBe(1);
      const thumb = thumbOf(t);
      expect(thumb).toBe(t.children[0]);
      expect(thumb.style.width).toBe('7px');
      expect(thumb.style.height).toBe('12px');
      expect(thumb.style.backgroundImage).toContain('data:fake-thumb');
      expect(thumb.style.backgroundImage).not.toContain('data:fake-oldThumb');
    }
  });

  it('widget x = floor(position × 113) (PositionToWidgetX0Y0 over ComputeActiveSize); a click maps through PointToPosition and clamps', () => {
    fresh();
    renderTab('chat');
    const inactive = track('Inactive Opacity');
    const active = track('Active Opacity');
    expect(inactive.dataset.sliderPos).toBe('50');
    expect(thumbOf(inactive).style.left).toBe(`${Math.floor(0.5 * 113)}px`);
    expect(active.dataset.sliderPos).toBe('100');
    expect(thumbOf(active).style.left).toBe('113px');
    // (x − widget/2) / (active − 1): widget/2 = 3, active − 1 = 112.
    mousedown(inactive, 3 + 28);
    expect(ui.optionsSettings.chatInactiveOpacity).toBe(25);
    expect(inactive.dataset.sliderPos).toBe('25');
    expect(thumbOf(inactive).style.left).toBe(`${Math.floor(0.25 * 113)}px`);
    mousedown(inactive, 3 + 112);
    expect(ui.optionsSettings.chatInactiveOpacity).toBe(100);
    expect(thumbOf(inactive).style.left).toBe('113px');
    mousedown(inactive, 500); // past the end: clamped to the far stop
    expect(ui.optionsSettings.chatInactiveOpacity).toBe(100);
    mousedown(inactive, 0); // before the widget's half-width: clamped to 0
    expect(ui.optionsSettings.chatInactiveOpacity).toBe(0);
    expect(thumbOf(inactive).style.left).toBe('0px');
    fresh();
  });

  it('slider rows: right-justified label cell at (6,2) 130x14; captions at (146,18) left and (206,18) right; row heights 20 (template 3) / 36 (template 6)', () => {
    fresh();
    renderTab('chat');
    const label = cellFor('Inactive Opacity');
    expect(label.style.left).toBe('6px');
    expect(label.style.top).toBe('2px');
    expect(label.style.width).toBe('130px');
    expect(label.style.height).toBe('14px');
    expect(label.style.justifyContent).toBe('flex-end');
    expect(label.parentElement).toBe(track('Inactive Opacity').parentElement);
    const lo = cellFor('Transparent');
    expect(lo.style.left).toBe('146px');
    expect(lo.style.top).toBe('18px');
    expect(lo.style.width).toBe('60px');
    expect(lo.style.justifyContent).toBe('flex-start');
    const hi = cellFor('Opaque');
    expect(hi.style.left).toBe('206px');
    expect(hi.style.top).toBe('18px');
    expect(hi.style.width).toBe('60px');
    expect(hi.style.justifyContent).toBe('flex-end');
    const inactiveRow = track('Inactive Opacity').parentElement as HTMLElement;
    const activeRow = track('Active Opacity').parentElement as HTMLElement;
    expect(inactiveRow.style.width).toBe('272px');
    expect(inactiveRow.style.height).toBe('20px');
    expect(activeRow.style.height).toBe('36px');
    expect(lo.parentElement).toBe(activeRow);
    expect(hi.parentElement).toBe(activeRow);
  });

  it('checkbox+slider rows (template 0x10000220): bullet at (6,3) 13x13, left-justified label from x = 24, slider at (146,4), 20px row', () => {
    renderTab('config');
    for (const [key, label] of [['effectsVolume', 'Sound Effects'], ['ambientVolume', 'Ambient Sounds'], ['interfaceVolume', 'Interface Sounds']]) {
      const row = ui.optionsPanel.querySelector(`[data-option-key="${key}"]`) as HTMLElement;
      expect(row, key).toBeTruthy();
      expect(row.style.height).toBe('20px');
      const bullet = row.children[0] as HTMLElement;
      expect(bullet.style.left).toBe('6px');
      expect(bullet.style.top).toBe('3px');
      expect(bullet.style.width).toBe('13px');
      const cell = cellFor(label);
      expect(cell.parentElement).toBe(row);
      expect(cell.style.left).toBe('24px');
      expect(cell.style.top).toBe('2px');
      expect(cell.style.width).toBe('112px');
      expect(cell.style.justifyContent).toBe('flex-start');
      const t = track(label);
      expect(t.parentElement).toBe(row);
      expect(t.style.left).toBe('146px');
      expect(t.style.top).toBe('4px');
    }
  });

  it('menu rows (template 0x10000222): right-justified label, field at (146,0) 120x19 with the 103x18 plate 0x060012b3, centered value, 17x19 arrow 0x060012b1 at x = 103', () => {
    renderTab('config');
    const row = ui.optionsPanel.querySelector('[data-option-key="soundFeatures"]') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.style.height).toBe('20px');
    const label = cellFor('Sound Features');
    expect(label.parentElement).toBe(row);
    expect(label.style.left).toBe('6px');
    expect(label.style.width).toBe('130px');
    expect(label.style.justifyContent).toBe('flex-end');
    const field = row.querySelector('.options-menu-field') as HTMLElement;
    expect(field.style.left).toBe('146px');
    expect(field.style.top).toBe('0px');
    expect(field.style.width).toBe('120px');
    const plate = field.querySelector('.options-menu-value') as HTMLElement;
    expect(plate.style.width).toBe('103px');
    expect(plate.style.height).toBe('18px');
    expect(plate.style.backgroundImage).toContain('data:fake-menuPlate');
    const value = plate.querySelector('.options-text-cell') as HTMLElement;
    expect(value.style.justifyContent).toBe('center');
    expect(value.querySelector('span')!.textContent).toBe(ui.optionsSettings.soundFeatures);
    const arrow = field.querySelector('.options-menu-arrow') as HTMLElement;
    expect(arrow.style.left).toBe('103px');
    expect(arrow.style.width).toBe('17px');
    expect(arrow.style.height).toBe('19px');
    expect(arrow.style.backgroundImage).toContain('data:fake-menuArrow');
    expect(arrow.style.backgroundImage).not.toContain('data:fake-oldArrow');
    // Hover swaps the arrow to its state-6 art; a click opens the menu and a pick sets the value.
    field.dispatchEvent(new domWindow.MouseEvent('mouseenter', { bubbles: false }));
    expect(arrow.style.backgroundImage).toContain('data:fake-menuArrowHover');
    const before = ui.optionsSettings.soundFeatures;
    pickNextMenuValue(domWindow.document, field);
    expect(ui.optionsSettings.soundFeatures).not.toBe(before);
    // The click re-rendered the page (persistAndApply): click the LIVE field.
    const liveField = (ui.optionsPanel.querySelector('[data-option-key="soundFeatures"]') as HTMLElement)
      .querySelector('.options-menu-field') as HTMLElement;
    pickNextMenuValue(domWindow.document, liveField);
    expect(ui.optionsSettings.soundFeatures).toBe(before);
  });

  // UIOption_Menu (0x21000043:0x10000353) is a UIElement_Menu: a click opens
  // the popup 0x10000357 (120 wide, p60 = 300) of 100x18 rows 0x1000035a with
  // the listbox's p114 bar 0x10000359 at x = 100; a pick (message 7,
  // UIOption_Menu::ListenToElementMessage @ 00483da0) stores the row's value.
  // It never stepped the value on a click.
  it('a menu click opens the retail popup list; a pick sets the value and closes it', () => {
    renderTab('config');
    const field = (): HTMLElement => (ui.optionsPanel.querySelector('[data-option-key="soundFeatures"]') as HTMLElement)
      .querySelector('.options-menu-field') as HTMLElement;
    const before = ui.optionsSettings.soundFeatures;
    field().dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(ui.optionsSettings.soundFeatures).toBe(before); // opening changes nothing
    const popup = domWindow.document.querySelector('[data-options-menu]') as HTMLElement;
    expect(popup).toBeTruthy();
    expect(popup.style.width).toBe('120px');
    const list = popup.querySelector('[data-options-menu-list]') as HTMLElement;
    const rows = [...list.children] as HTMLElement[];
    expect(rows.length).toBeGreaterThan(1);
    expect(popup.style.height).toBe(`${rows.length * 18}px`);
    expect(list.style.width).toBe('100px');
    expect(list.style.getPropertyValue('scrollbar-width')).toBe('none');
    for (const r of rows) { expect(r.style.width).toBe('100px'); expect(r.style.height).toBe('18px'); }
    expect(rows.filter((r) => r.dataset.current === '1').map((r) => r.dataset.optionsMenuRow)).toEqual([before]);
    const bar = popup.querySelector('[data-options-menu-scrollbar]') as HTMLElement;
    expect(bar.style.left).toBe('100px');
    expect(bar.style.width).toBe('16px');
    const pick = rows.find((r) => r.dataset.optionsMenuRow !== before)!;
    pick.click();
    expect(ui.optionsSettings.soundFeatures).toBe(pick.dataset.optionsMenuRow);
    expect(domWindow.document.querySelector('[data-options-menu]')).toBeNull();
    ui.optionsSettings.soundFeatures = before;
    renderTab('config');
  });

  it('the popup closes on a click elsewhere, on Escape, and when the panel closes, without changing the value', () => {
    renderTab('config');
    const field = (): HTMLElement => (ui.optionsPanel.querySelector('[data-option-key="soundFeatures"]') as HTMLElement)
      .querySelector('.options-menu-field') as HTMLElement;
    const before = ui.optionsSettings.soundFeatures;
    field().dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(domWindow.document.querySelector('[data-options-menu]')).toBeTruthy();
    domWindow.document.body.dispatchEvent(new domWindow.Event('pointerdown', { bubbles: true }));
    expect(domWindow.document.querySelector('[data-options-menu]')).toBeNull();
    field().dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    domWindow.dispatchEvent(new domWindow.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(domWindow.document.querySelector('[data-options-menu]')).toBeNull();
    field().dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    ui.toggleOptionsPanel();
    expect(domWindow.document.querySelector('[data-options-menu]')).toBeNull();
    expect(ui.optionsSettings.soundFeatures).toBe(before);
  });

  it('a pick re-renders the page but keeps the list where the player had scrolled it', () => {
    renderTab('config');
    const list = (): HTMLElement => ui.optionsListEl as HTMLElement;
    expect(list()).toBeTruthy();
    list().scrollTop = 120;
    expect(list().scrollTop).toBe(120);
    const before = ui.optionsSettings.soundFeatures;
    const field = (ui.optionsPanel.querySelector('[data-option-key="soundFeatures"]') as HTMLElement)
      .querySelector('.options-menu-field') as HTMLElement;
    pickNextMenuValue(domWindow.document, field);
    expect(ui.optionsSettings.soundFeatures).not.toBe(before);
    expect(list().scrollTop).toBe(120);
    // Another tab starts at the top.
    renderTab('character');
    expect(list().scrollTop).toBe(0);
    ui.optionsSettings.soundFeatures = before;
  });

  it('a long list caps at p60 = 300 px (16 rows) and scrolls under the bar', () => {
    const anchor = domWindow.document.createElement('div');
    ui.hudContainer.appendChild(anchor);
    const values = Array.from({ length: 24 }, (_, i) => `Choice ${i}`);
    ui.openOptionsMenu(anchor, values, 'Choice 3', () => {});
    const popup = domWindow.document.querySelector('[data-options-menu]') as HTMLElement;
    expect(popup.style.height).toBe(`${16 * 18}px`);
    expect((popup.querySelector('[data-options-menu-list]') as HTMLElement).children.length).toBe(24);
    expect((popup.querySelector('[data-options-menu-scrollbar]') as HTMLElement).querySelector('[data-dat-scroll-btn="down"]')).toBeTruthy();
    ui.closeOptionsMenu();
    anchor.remove();
  });

  it('toggle rows (template 0x10000218): 20px pitch, bullet at x = 6, label 18px in; ON = state 6 art, OFF = state 1 art; the chat channel LIST rows (0x10000520) keep their own off dot', () => {
    ui.uiTextures.set(0x06004d15, 'data:fake-bullet-off');
    ui.uiTextures.set(0x06004d17, 'data:fake-bullet-on');
    ui.uiTextures.set(0x06004d19, 'data:fake-bullet-list-off');
    ui.optionsSettings.showHelm = true;
    ui.optionsSettings.showCloak = false;
    renderTab('character');
    const rows = [...ui.optionsPanel.querySelectorAll('.option-toggle-row')] as HTMLElement[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.style.height).toBe('20px');
      expect(row.style.width).toBe('272px');
      expect(row.style.paddingLeft).toBe('6px');
      expect(row.style.gap).toBe('5px'); // 13px bullet + 5 = the 18px label inset
      const bullet = row.children[0] as HTMLElement;
      expect(bullet.style.width).toBe('13px');
      // UIOption_Checkbox (template 2): state 6 checked / state 1 unchecked —
      // never the state-13 Disabled art 0x06004d19.
      expect(bullet.style.backgroundImage).not.toContain('data:fake-bullet-list-off');
      expect(bullet.style.backgroundImage).toContain(row.dataset.optionOn === '1' ? 'data:fake-bullet-on' : 'data:fake-bullet-off');
    }
    const on = rows.find((r) => r.dataset.optionKey === 'showHelm')!;
    const off = rows.find((r) => r.dataset.optionKey === 'showCloak')!;
    expect((on.children[0] as HTMLElement).style.backgroundImage).toContain('data:fake-bullet-on');
    expect((off.children[0] as HTMLElement).style.backgroundImage).toContain('data:fake-bullet-off');
    // The checkbox+slider rows (UIOption_CheckboxSlider) share the checkbox state art.
    renderTab('config');
    const cs = ui.optionsPanel.querySelector('[data-option-key="effectsVolume"]') as HTMLElement;
    expect((cs.children[0] as HTMLElement).style.backgroundImage).not.toContain('data:fake-bullet-list-off');
    // Chat tab channel rows = the 0x10000520 checkbox list (template 8):
    // its own p268435586 / p268435587 = 0x06004d17 on / 0x06004d19 off.
    ui.optionsSettings.chatMainWindowCombat = true;
    ui.optionsSettings.chatMainWindowMagic = false;
    renderTab('chat');
    const combat = ui.optionsPanel.querySelector('[data-option-key="chatMainWindowCombat"]') as HTMLElement;
    const magic = ui.optionsPanel.querySelector('[data-option-key="chatMainWindowMagic"]') as HTMLElement;
    expect((combat.children[0] as HTMLElement).style.backgroundImage).toContain('data:fake-bullet-on');
    expect((magic.children[0] as HTMLElement).style.backgroundImage).toContain('data:fake-bullet-list-off');
  });

  it('headers: template 0 text at (2,2) with no rule under it; the rule (template 1, 0x060012c5, 8px) precedes every header after the first', () => {
    renderTab('config');
    const first = headerFor('Sound Options');
    expect(first.style.height).toBe('22px');
    const text = first.querySelector('.options-text-cell') as HTMLElement;
    expect(text.style.left).toBe('2px');
    expect(text.style.top).toBe('2px');
    expect(text.style.justifyContent).toBe('flex-start');
    expect(first.previousElementSibling).toBeNull();
    expect(first.querySelector('.options-separator')).toBeNull();
    // CORE.17.h.g — gmConfigUI::InitOptions adds three more sections after
    // Graphics (Rendering Quality / Input / UI), each behind a rule, and
    // ends with one closing AddSeperator: 5 + 1 rules.
    for (const later of ['Camera Options', 'Graphics Options', 'Rendering Quality Options', 'Input Options', 'UI Options']) {
      const h = headerFor(later);
      const rule = h.previousElementSibling as HTMLElement;
      expect(rule.classList.contains('options-separator')).toBe(true);
      expect(rule.style.height).toBe('8px');
      expect(rule.style.backgroundImage).toContain('data:fake-rule');
      expect(h.querySelector('.options-separator')).toBeNull();
      expect((h.nextElementSibling as HTMLElement).classList.contains('options-separator')).toBe(false);
    }
    expect(ui.optionsPanel.querySelectorAll('.options-separator').length).toBe(6);
    renderTab('chat');
    // General Chat Options + Main Chat Window + Chat Window 1..4 → 5 rules.
    expect(ui.optionsPanel.querySelectorAll('.options-separator').length).toBe(5);
    expect(headerFor('General Chat Options').previousElementSibling).toBeNull();
  });

  it('list inset: the list tabs put the rows in the DAT list box 0x100001fa from its top (no inset, retail A/B 2026-10-04); the Gameplay page is the DAT layout, no list', () => {
    const paper = (): HTMLElement | null =>
      (ui.optionsPanel.querySelector('[data-element-id="0x100001fa"]') as HTMLElement | null)?.firstElementChild as HTMLElement | null;
    for (const tab of ['character', 'chat', 'config']) {
      renderTab(tab);
      const el = paper();
      expect(el, tab).toBeTruthy();
      expect(el!.style.paddingLeft || '0px').toBe('0px');
      expect(el!.style.paddingRight || '0px').toBe('0px');
      expect(el!.style.paddingTop || '0px').toBe('0px');
    }
    renderTab('gameplay');
    expect(paper()).toBeNull();
  });
});
