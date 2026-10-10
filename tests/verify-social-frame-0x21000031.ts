/**
 * VISUAL.118/.119 (+ .60/.65/.70 title-bar removals) — the social panel is
 * hosted in the REAL EoL social container 0x21000031, not the generic
 * 0x2100001a frame.
 *
 * DAT ground truth (tools/dump-layout.mjs 0x21000031, spec in
 * verification/panel-specs/social-friends.md):
 *   - root 0x1000028b type-8 tab group, (0,0) 300x600 — NO title bar
 *   - tabs: Allegiance 0x1000028c (0,0) 72x25, Fellowship 0x1000028e
 *     (72,0) 72x25, Friends 0x10000512 (144,0) 62x25, Squelch 0x1000053b
 *     (206,0) 70x25 — the tab strip IS the panel's top edge
 *   - pin/close button 0x10000290 (276,0) 24x25, state1 tex 0x0600141d /
 *     state3 tex 0x0600141e (handled by the renderer's auto state swap)
 *   - four stacked content panes (0,25) 300x575:
 *     0x10000513 / 0x10000291 / 0x10000292 / 0x1000054a
 *
 * VISUAL.char-panel-body-too-bright.a.a — the container is the panels
 * window's slot 0x1000018f: it opens at panelsWindowPlacement inside the
 * window's 5 px frame (the window moves by its own Dragbar), so the tabs
 * are no longer drag handles, and the pane's own 0x06004cc2 is cleared
 * (retail's nested scrims do not compound; the window root paints the one
 * layer). The LayoutRenderer threshold-drag suite below still covers the
 * multi-handle mechanism other panels use.
 *
 * DEBT.test-harness-hygiene: converted from GameUI.ts / LayoutRenderer.ts
 * source pins. GameUI.renderSocialPanel runs against a recording layout
 * double; LayoutRenderer.renderPanel's drag wiring runs for real (only its
 * DAT `render` step is replaced by a fake element tree) and is driven with
 * mouse events.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { panelsWindowPlacement, PANELS_WINDOW } from '../packages/renderer/src/ui/PanelsWindow.js';

const TAB_IDS = [0x1000028c, 0x1000028e, 0x10000512, 0x1000053b];
const PANE_BY_TAB = { friends: 0x10000513, allegiance: 0x10000291, fellowship: 0x10000292, squelch: 0x1000054a } as const;
// The pane's scrim children (the lists + name-entry fields): they keep their
// own 0x06004cc2 and draw retail's darker well (VISUAL.char-panel-body-too-bright.c.a).
const NESTED_SCRIMS = {
  friends: [0x10000517, 0x1000051b], squelch: [0x1000053e, 0x10000540], fellowship: [0x1000026f], allegiance: [],
} as const;
const SCRIM = 'data:tex-6004cc2';
const ALL_IDS = [0x1000028b, ...TAB_IDS, 0x10000290, ...Object.values(PANE_BY_TAB)];

describe('VISUAL.118 — social frame is DAT container 0x21000031 (behavioural)', () => {
  let H: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let calls: Array<{ layoutId: number; parent: HTMLElement; opts: any }> = [];
  let texts: Array<[number, string]> = [];
  let visible = new Map<number, boolean>();
  let elements = new Map<number, HTMLElement>();
  let hostedIn: HTMLElement | null = null;
  let frameRenders: Array<{ id: number; opts: any }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any

  beforeAll(async () => {
    H = await mountGameUI();
    const doc = H.win.document;
    H.ui.getTexURL = (id: number) => `data:tex-${id.toString(16)}`;
    H.ui.layoutRenderer = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      renderPanel: (layoutId: number, parent: HTMLElement, opts: any) => {
        calls.push({ layoutId, parent, opts });
        const root = doc.createElement('div');
        parent.appendChild(root);
        elements = new Map();
        for (const id of ALL_IDS) {
          const el = doc.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        // Each pane arrives the way LayoutRenderer paints it: its own DAT
        // media is the scrim 0x06004cc2, and so are its nested list/field
        // elements (tools/dump-layout.mjs 0x2100005d/0x21000060/0x21000030).
        for (const [tab, pane] of Object.entries(PANE_BY_TAB)) {
          const paneEl = elements.get(pane)!;
          paneEl.style.backgroundImage = `url(${SCRIM})`;
          for (const id of NESTED_SCRIMS[tab as keyof typeof PANE_BY_TAB]) {
            const child = doc.createElement('div');
            child.dataset.elementId = `0x${id.toString(16)}`;
            child.style.backgroundImage = `url(${SCRIM})`;
            paneEl.appendChild(child);
          }
        }
        return {
          root, elements,
          setState: () => {}, setText: (id: number, t: string) => { texts.push([id, t]); }, setInteractive: () => {},
          setVisible: (id: number, on: boolean) => { visible.set(id, on); },
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (id: number, parent: HTMLElement, opts: any) => {
        frameRenders.push({ id, opts });
        const root = doc.createElement('div');
        parent.appendChild(root);
        return { root, elements: new Map(), setState: () => {}, setVisible: () => {}, onClick: () => {}, destroy: () => root.remove() };
      },
    };
    // The per-tab pane contents are covered by their own suites
    // (verify-fellowship-pane-native.ts, verify-friends-pane-native.ts, …);
    // here only record which element hosts them.
    for (const fn of ['renderFriendsPaneNative', 'renderSquelchPaneNative', 'renderAllegiancePaneNative', 'renderFellowshipPaneNative']) {
      H.ui[fn] = (body: HTMLElement) => { hostedIn = body; };
    }
  });
  afterAll(() => H.teardown());

  function open(tab: keyof typeof PANE_BY_TAB): void {
    calls = []; texts = []; visible = new Map(); hostedIn = null; frameRenders = [];
    H.ui.socialTab = tab;
    if (!H.ui.socialPanelVisible) H.ui.toggleSocialPanel();
    else H.ui.renderSocialPanel();
  }

  it('renders 0x21000031 into the HUD, NOT the generic 0x2100001a frame', () => {
    open('fellowship');
    expect(calls.map(c => c.layoutId)).toEqual([0x21000031]);
    expect(calls[0].parent).toBe(H.ui.hudContainer);
  });

  it('has NO title bar: no setText on 0x100000fe and no invented "Social" caption', () => {
    open('fellowship');
    expect(texts.some(([id]) => id === 0x100000fe)).toBe(false);
    expect(texts.some(([, t]) => t === 'Social')).toBe(false);
    // the four DAT tab captions are what gets painted
    expect(texts.filter(([id]) => TAB_IDS.includes(id)).map(([, t]) => t))
      .toEqual(['Allegiance', 'Fellowship', 'Friends', 'Squelch']);
  });

  it('close button is the DAT pin element 0x10000290; the window renders as the 0x1000028b subtree', () => {
    open('fellowship');
    expect(calls[0].opts.closeButtonId).toBe(0x10000290);
    expect(calls[0].opts.subtreeElementId).toBe(0x1000028b);
  });

  it('opens in the panels window: at its rect, inside the 0x2100006e frame, the root at the body (5,5)', () => {
    open('fellowship');
    const at = panelsWindowPlacement({}, H.ui.hudLogicalWidth(), H.ui.hudLogicalHeight());
    expect([calls[0].opts.x, calls[0].opts.y]).toEqual([at.x, at.y]);
    expect(frameRenders.map(f => f.id)).toEqual([PANELS_WINDOW.windowLayout]);
    expect(frameRenders[0].opts.omitChildIds).toEqual([PANELS_WINDOW.body]);
    const root = elements.get(0x1000028b)!.parentElement as HTMLElement;
    expect([root.style.left, root.style.top]).toEqual(['5px', '5px']);
    const wrapper = root.parentElement as HTMLElement;
    expect([wrapper.style.width, wrapper.style.height]).toEqual([`${at.w}px`, `${at.h}px`]);
    // The wrapper paints nothing: the frame's root carries the one scrim.
    expect(wrapper.style.backgroundImage).toBe('none');
  });

  it('the tabs are not drag handles: the panels window moves by its own Dragbar', () => {
    open('fellowship');
    expect(calls[0].opts.dragHandleId).toBeUndefined();
    expect(calls[0].opts.persistKey).toBeUndefined();
  });

  it.each(Object.keys(PANE_BY_TAB) as Array<keyof typeof PANE_BY_TAB>)(
    'CORE.5.c.b/.c.d — tab %s: only its OWN pane is visible and hosts the content',
    (tab) => {
      open(tab);
      const active = PANE_BY_TAB[tab];
      for (const pane of Object.values(PANE_BY_TAB)) expect(visible.get(pane), `pane 0x${pane.toString(16)}`).toBe(pane === active);
      expect(hostedIn).toBe(elements.get(active));
      // the old container-level fill is gone
      expect(elements.get(0x1000028b)!.style.backgroundImage).toBe('');
    },
  );

  it.each(Object.keys(PANE_BY_TAB) as Array<keyof typeof PANE_BY_TAB>)(
    'VISUAL.char-panel-body-too-bright.c/.a.a/.c.a — tab %s: the pane draws no scrim of its own over the window\'s, no leather; its list/field wells keep theirs',
    (tab) => {
      open(tab);
      const pane = elements.get(PANE_BY_TAB[tab])!;
      // the pane's copy of the window scrim is cleared; no invented 0x0600114d leather
      expect(pane.style.backgroundImage).toBe('none');
      // nothing opaque under it: the scrim composites over the live world
      expect(['', 'transparent']).toContain(pane.style.backgroundColor);
      // VISUAL.char-panel-body-too-bright.c.a — the list + name-field children
      // keep their DAT scrim: the EoL Wine frames read them at two layers
      // (9.8/9.3/4.0 over 84/80/33 grass) where the body reads one.
      for (const id of NESTED_SCRIMS[tab]) {
        const child = pane.querySelector(`[data-element-id="0x${id.toString(16)}"]`) as HTMLElement;
        expect(child.style.backgroundImage, `0x${id.toString(16)}`).toContain(SCRIM);
        expect(child.style.backgroundColor, `0x${id.toString(16)}`).not.toBe('transparent');
      }
    },
  );
});

describe('LayoutRenderer threshold drag (multi-handle support, behavioural)', () => {
  let H: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let LR: any;
  beforeAll(async () => {
    H = await mountGameUI();
    LR = (await import('../packages/renderer/src/ui/LayoutRenderer.js')).LayoutRenderer;
  });
  afterAll(() => { LR.setUILocked(false); H.teardown(); });

  const A = 0x1000028c;
  const B = 0x1000028e;

  function renderPanel(opts: Record<string, unknown>) {
    const doc = H.win.document;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lr: any = new LR({}, {});
    lr.render = (_id: number, parent: HTMLElement) => {
      const root = doc.createElement('div');
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      for (const id of [A, B]) { const el = doc.createElement('div'); root.appendChild(el); elements.set(id, el); }
      return { root, elements, onClick: () => {}, destroy: () => root.remove() };
    };
    const parent = doc.createElement('div');
    doc.body.appendChild(parent);
    const handle = lr.renderPanel(0x21000031, parent, { x: 10, y: 20, ...opts });
    const panelEl = handle.root.parentElement as HTMLElement;
    return { handle, panelEl, a: handle.elements.get(A) as HTMLElement, b: handle.elements.get(B) as HTMLElement };
  }
  const mouse = (target: EventTarget, type: string, x: number, y: number): void => {
    target.dispatchEvent(new H.win.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true }));
  };

  it('PanelOptions accepts an id array: every listed handle drags the panel', () => {
    const { panelEl, a, b } = renderPanel({ dragHandleId: [A, B] });
    mouse(a, 'mousedown', 100, 100);
    mouse(H.win.document, 'mousemove', 130, 110);
    mouse(H.win.document, 'mouseup', 130, 110);
    expect([panelEl.style.left, panelEl.style.top]).toEqual(['40px', '30px']);
    mouse(b, 'mousedown', 0, 0);
    mouse(H.win.document, 'mousemove', 5, 0);
    mouse(H.win.document, 'mouseup', 5, 0);
    expect(panelEl.style.left).toBe('45px');
  });

  it('with dragThreshold, the drag engages only once the pointer moves past it', () => {
    const { panelEl, a } = renderPanel({ dragHandleId: [A, B], dragThreshold: 4 });
    mouse(a, 'mousedown', 100, 100);
    mouse(H.win.document, 'mousemove', 102, 101); // |2|+|1| = 3 < 4
    expect([panelEl.style.left, panelEl.style.top]).toEqual(['10px', '20px']);
    mouse(H.win.document, 'mousemove', 110, 100);
    expect(panelEl.style.left).toBe('20px');
    mouse(H.win.document, 'mouseup', 110, 100);
  });

  it('suppresses the click that follows an engaged drag (capture phase) but not a plain click', () => {
    const { a } = renderPanel({ dragHandleId: [A], dragThreshold: 4 });
    const clicks: number[] = [];
    a.addEventListener('click', () => clicks.push(1));
    mouse(a, 'mousedown', 0, 0);
    mouse(H.win.document, 'mousemove', 20, 0);
    mouse(H.win.document, 'mouseup', 20, 0);
    mouse(a, 'click', 20, 0);
    expect(clicks).toEqual([]);
    // a press without movement stays a click (tab switch)
    mouse(a, 'mousedown', 0, 0);
    mouse(H.win.document, 'mouseup', 0, 0);
    mouse(a, 'click', 0, 0);
    expect(clicks).toEqual([1]);
  });

  it('keeps the pointer cursor on threshold handles (only immediate handles show move)', () => {
    expect(renderPanel({ dragHandleId: [A], dragThreshold: 4 }).a.style.cursor).not.toBe('move');
    expect(renderPanel({ dragHandleId: [A] }).a.style.cursor).toBe('move');
  });

  it('still honors the UI lock (FAITHFUL.484)', () => {
    const { panelEl, a } = renderPanel({ dragHandleId: [A], dragThreshold: 4 });
    LR.setUILocked(true);
    try {
      mouse(a, 'mousedown', 0, 0);
      mouse(H.win.document, 'mousemove', 50, 50);
      mouse(H.win.document, 'mouseup', 50, 50);
      expect([panelEl.style.left, panelEl.style.top]).toEqual(['10px', '20px']);
    } finally {
      LR.setUILocked(false);
    }
  });

  it('persists the dropped position under persistKey (FAITHFUL.477) and restores it on the next render', () => {
    const first = renderPanel({ dragHandleId: [A], dragThreshold: 4, persistKey: 'verify-social-threshold' });
    mouse(first.a, 'mousedown', 0, 0);
    mouse(H.win.document, 'mousemove', 30, 40);
    mouse(H.win.document, 'mouseup', 30, 40);
    const again = renderPanel({ dragHandleId: [A], dragThreshold: 4, persistKey: 'verify-social-threshold' });
    expect([again.panelEl.style.left, again.panelEl.style.top]).toEqual(['40px', '60px']);
  });
});
