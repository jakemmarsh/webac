/**
 * CORE.3.b — "[chat] Chat log scrollbar should use retail track/thumb art in
 * the 0x10000012 column" (Jake's live play-test follow-up, 2026-08-23).
 *
 * Root cause: the chat log rendered a browser-native (CSS thin) scrollbar
 * inside the text area 0x10000011 while the dedicated 16x68 scrollbar column
 * 0x10000012 (at 474,6) stayed empty — the last CSS-scrollbar host in the UI.
 *
 * Retail ground truth (resolved from the main chat layout 0x2100006f — same
 * chain in the pre-CORE.17.g 0x21000006 bar — via base-inheritance,
 * dumped with dat-parser resolveLayoutDesc): 0x10000012 is a partial desc
 * (raw type 0) inheriting 0x10000367@0x2100003e, resolving to a type-11
 * UIElement_Scrollbar with:
 *   - track background 0x06004c5f (ornate gold, repeat-y)
 *   - up button   0x06004c69 (normal) / 0x06004c6a (hover) / 0x06004c6b (pressed)
 *   - down button 0x06004c6c / 0x06004c6d / 0x06004c6e
 *   - 3-slice blue thumb: top cap 0x06004c60, middle 0x06004c63, bottom cap 0x06004c66
 * The retail widget repositions the down button to the bottom edge, tracks the
 * thumb by scroll fraction; with p121 (HideDisabled) false it keeps the bar
 * chrome and thumb visible (thumb parked at top) when the content fits.
 *
 * Behavioral: drives the real GameUI.renderHUD() with a layoutRenderer double
 * (elements created on demand) and a getTexURL stub that echoes the texId, then
 * asserts buildChatScrollbar assembled the real DAT art into the column, wired
 * the down button to the bottom edge, dropped the CSS scrollbar on the log
 * viewport, and kept the chrome + parked thumb while the log fits.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = [
  'window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event',
  'MouseEvent', 'MutationObserver',
] as const;

const SCROLL_COLUMN_ID = 0x10000012;
const TEXT_AREA_ID = 0x10000011;

// Resolved DAT texture IDs for the chat scrollbar (see file header).
const TRACK = 0x06004c5f;
const UP_NORMAL = 0x06004c69;
const DOWN_NORMAL = 0x06004c6c;
const THUMB_TOP = 0x06004c60;
const THUMB_MID = 0x06004c63;
const THUMB_BOT = 0x06004c66;

function texUrl(id: number): string { return `tex:0x${id.toString(16)}`; }

describe('CORE.3.b — chat log scrollbar uses retail DAT art in the 0x10000012 column', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let column: HTMLElement;
  let viewport: HTMLElement;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    // Echo the texId so we can assert which DAT texture each piece uses.
    ui.getTexURL = (id: number) => texUrl(id);

    const makeHandle = (layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div');
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      const getOrCreate = (id: number): HTMLElement => {
        let el = elements.get(id);
        if (!el) {
          // Cast: domWindow is `any`, and assigning `any` doesn't narrow
          // `el` past `HTMLElement | undefined` under strictNullChecks.
          el = domWindow.document.createElement('div') as HTMLElement;
          el.setAttribute('data-element-id', `0x${id.toString(16)}`);
          root.appendChild(el);
          elements.set(id, el);
        }
        return el;
      };
      // Pre-create the ids GameUI reaches for on the chat bar.
      if (layoutId === 0x2100006f) {
        for (const id of [TEXT_AREA_ID, SCROLL_COLUMN_ID, 0x10000016, 0x1000048c]) getOrCreate(id);
      }
      return {
        root,
        // Lazily materialize any element GameUI asks for so renderHUD doesn't
        // crash on ids this double didn't pre-list.
        elements: { get: (id: number) => getOrCreate(id), set: () => {} },
        setText: () => {}, setInteractive: () => {},
        setVisible: (id: number, visible: boolean) => { getOrCreate(id).style.display = visible ? '' : 'none'; },
        setTexture: () => {}, setState: () => {}, setFill: () => {}, setPalette: () => {},
        setDraggable: () => {}, setDropTarget: () => {}, onClick: () => {},
        moveTo: () => {}, bringToFront: () => {},
        setScrollable: () => ({ contentEl: root, setPosition() {}, scrollToBottom() {}, appendContent() {} }),
        close: () => { root.remove(); },
      };
    };
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      getTextureDataURLWithAlpha: () => null,
    };
    ui.renderHUD();

    column = ui.chatHandle.elements.get(SCROLL_COLUMN_ID) as HTMLElement;
    viewport = domWindow.document.getElementById('chat-messages') as HTMLElement;
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function children(): HTMLElement[] {
    return Array.from(column.children) as HTMLElement[];
  }
  function bg(el: HTMLElement): string { return el.style.backgroundImage; }

  it('paints the ornate gold track (0x06004c5f) as the column background, repeating', () => {
    expect(column.style.backgroundImage).toContain(texUrl(TRACK));
    expect(column.style.backgroundRepeat).toBe('repeat-y');
  });

  it('renders the up button (0x06004c69) pinned to the top edge', () => {
    const up = children().find((c) => bg(c).includes(texUrl(UP_NORMAL)));
    expect(up, 'up button present').toBeTruthy();
    expect(up!.style.top).toBe('0px');
    expect(up!.style.bottom).toBe('');
  });

  it('renders the down button (0x06004c6c) repositioned to the BOTTOM edge (retail widget behavior)', () => {
    const down = children().find((c) => bg(c).includes(texUrl(DOWN_NORMAL)));
    expect(down, 'down button present').toBeTruthy();
    expect(down!.style.bottom).toBe('0px');
    expect(down!.style.top).toBe('');
  });

  it('builds the 3-slice blue thumb from the resolved cap/middle/cap textures', () => {
    const thumb = children().find((c) => c.dataset.datThumb === '1');
    expect(thumb, 'thumb present').toBeTruthy();
    const sliceBgs = Array.from(thumb!.children).map((s) => (s as HTMLElement).style.backgroundImage);
    expect(sliceBgs.some((b) => b.includes(texUrl(THUMB_TOP)))).toBe(true);
    expect(sliceBgs.some((b) => b.includes(texUrl(THUMB_MID)))).toBe(true);
    expect(sliceBgs.some((b) => b.includes(texUrl(THUMB_BOT)))).toBe(true);
  });

  it('drops the browser-native (CSS) scrollbar on the chat log viewport', () => {
    expect(viewport).toBeTruthy();
    // scrollbarWidth 'none' + no legacy scrollbarColor styling.
    expect(viewport.style.scrollbarWidth).toBe('none');
    expect(viewport.style.scrollbarColor === '' || viewport.style.scrollbarColor == null).toBe(true);
  });

  it('keeps the column chrome visible with the thumb parked at the top while the (empty) log fits', () => {
    // CORE.3.c correction: the chat scrollbar desc carries p121=false →
    // SetHideDisabled(false) (UIElement_Scrollbar::OnSetAttribute @ 004714d0
    // maps attribute 0x79 → SetHideDisabled), and UpdateLayout @ 004710d0
    // hides the WHOLE bar only when disabled AND hideDisabled — merely
    // disabled hides just the page-click regions (children 4-7), never the
    // thumb (child 1). Confirmed by reference/images/hud/chat-panel.jpg:
    // empty floaty chat logs still show the scrollbar column with the thumb
    // parked at the top of the track.
    expect(column.style.display).not.toBe('none');
    const thumb = column.querySelector('[data-dat-thumb="1"]') as HTMLElement;
    expect(thumb).toBeTruthy();
    expect(thumb.style.display).not.toBe('none');
    expect(thumb.style.top).toBe('16px'); // parked right below the 16px up button
  });

  // CORE.3.e — proportional thumb length. The chat scrollbar descs (main
  // 0x10000012@0x21000006 and the floaty template) carry p130 (0x82 →
  // UIElement_Scrollbar::SetProportional @ 004703a0) = true and p137 (0x89,
  // min widget length) = 16. UIElement_Scrollbar::UpdateLayout @ 004710d0
  // sizes the widget to max(minLen, floor(ratio × trackLen)); the ratio
  // (attribute 0x88) is viewportLen/contentLen clamped to 1.0, written by
  // UIElement_Scrollable::UpdateScrollbarSize_ @ 004741a0. trackLen = bar
  // height minus the two 16px buttons (UpdateScrollingArea @ 00470aa0).
  describe('CORE.3.e — proportional thumb length (p130 + p137=16)', () => {
    // In this DOM double the column's clientHeight is 0, so the code falls
    // back to the DAT default 68 → trackLen = 68 - 32 = 36.
    const TRACK = 36;
    const thumbEl = (): HTMLElement => column.querySelector('[data-dat-thumb="1"]') as HTMLElement;
    const setContent = (scrollHeight: number, clientHeight: number, scrollTop = 0) => {
      Object.defineProperty(viewport, 'scrollHeight', { value: scrollHeight, configurable: true });
      Object.defineProperty(viewport, 'clientHeight', { value: clientHeight, configurable: true });
      viewport.scrollTop = scrollTop;
      viewport.dispatchEvent(new domWindow.Event('scroll'));
    };

    it('empty/fitting log → ratio 1.0 → the thumb fills the whole track (retail chat-panel.jpg look)', () => {
      setContent(0, 0);
      expect(thumbEl().style.height).toBe(`${TRACK}px`);
      expect(thumbEl().style.top).toBe('16px');
    });

    it('half-visible content → thumb is half the track, and the middle slice stretches between the 3px caps', () => {
      setContent(150, 75); // ratio 0.5 → floor(0.5 × 36) = 18
      const t = thumbEl();
      expect(t.style.height).toBe('18px');
      const slices = Array.from(t.children) as HTMLElement[];
      expect(slices[0].style.height).toBe('3px'); // top cap 0x06004c60
      expect(slices[1].style.height).toBe('12px'); // middle 0x06004c63 stretched
      expect(slices[2].style.height).toBe('3px'); // bottom cap 0x06004c66
      expect(slices[2].style.top).toBe('15px');
    });

    it('deep overflow clamps at the 16px minimum (p137) — the "blue square"', () => {
      setContent(1000, 50); // ratio 0.05 → floor(1.8) = 1 → min 16
      expect(thumbEl().style.height).toBe('16px');
    });

    it('scrolled to the end, the thumb bottom reaches the down button (travel = track − thumbLen)', () => {
      setContent(150, 75, 75); // scrollTop = max → frac 1; travel = 36 - 18 = 18
      expect(thumbEl().style.top).toBe(`${16 + 18}px`);
    });
  });
});
