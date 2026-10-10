/**
 * VISUAL.toolbar-tooltips-invented + VISUAL.toolbar-hover-shows-selected-state
 * + BUG.chat-container-covers-window-buttons.
 *
 * Ground truth (decompiled EoL client + client_local_English.dat):
 *  - The EoL toolbar is gmFloatyToolbarUI 0x21000070 whose content child
 *    0x1000001b inherits the classic toolbar 0x21000016; gmToolbarUI::PostInit
 *    @ 004bea80 binds exactly 0x21000016's ids (0x1000019d use, 0x100001a5
 *    examine, 0x1000019e/f selection, the six panel buttons 0x10000197/198/
 *    199/55a/19a/19b and the inventory button 0x100001b1, each with its
 *    0x10000029 panel id). So the layout is right; the root 0x2100006e is the
 *    docked-panel frame (0x10000180 panel slots), not a toolbar.
 *  - No element of 0x21000016 or 0x21000070 carries a p73 tooltip, and none of
 *    the 25 UIElement::SetTooltip callers is a gmToolbarUI / gmFloatyToolbarUI
 *    method — a retail toolbar button shows no tooltip. Our hand-typed titles
 *    (Social / Spells / Char / Map / Opt / Inventory / Use Selected Object /
 *    Examine Selected Object) were inventions.
 *  - The panel buttons author states 1 and 6 only. UIElement_Button::
 *    UpdateState_ @ 00471cf0 (run from MouseOverTop @ 004721f0) asks for
 *    state 2 on rollover / 3 on press (7 / 8 while selected) and applies it
 *    only when AccessStateDesc finds it, so hovering changes nothing; the
 *    state-6 art shows only while the panel is open.
 *  - The main chat entry 0x2100006f:0x10000016 is an editable text (p22):
 *    a press on it focuses it. LayoutRenderer builds elements click-through
 *    (pointer-events: none, inherited), so the injected input must take the
 *    mouse itself or the press lands on #hud-chat.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DatDatabase, parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes, resolveLayoutDesc, MediaType,
  type LayoutDescData, type ElementDesc,
} from '@ac/dat-parser';
import { registerStringTable } from '@ac/dat-parser/file-types/LayoutDesc.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { openDat } from './_harness/dat.js';

const TOOLBAR = 0x21000016;
const PANEL_BUTTONS = [0x10000197, 0x10000198, 0x10000199, 0x1000055a, 0x1000019a, 0x1000019b, 0x100001b1];
const TOOLBAR_DOM: Record<string, number> = {
  'tb-social': 0x10000197, 'tb-magic': 0x10000198, 'tb-char': 0x10000199, 'tb-journal': 0x1000055a,
  'tb-map': 0x1000019a, 'tb-opt': 0x1000019b, 'tb-inv': 0x100001b1, 'tb-use': 0x1000019d,
  'tb-examine': 0x100001a5, 'combat-mode-btn': 0x10000192,
};
const TEX: Record<string, [number, number]> = {
  'tb-social': [0x0600111f, 0x06001121], 'tb-char': [0x06001122, 0x06001124], 'tb-inv': [0x06004cf7, 0x06004cf8],
};

const PORTAL = resolve(__dirname, '../dat/client_portal.dat');
const LOCAL = resolve(__dirname, '../dat/client_local_English.dat');

/** A LayoutRenderer stand-in: click-through element divs (as LayoutRenderer builds them) + getResolvedLayout. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubLayoutRenderer(H: GameUIFixture, getResolvedLayout: (id: number) => LayoutDescData | null): any {
  const doc = H.win.document;
  const makeHandle = (parent: HTMLElement) => {
    const root = doc.createElement('div');
    root.style.pointerEvents = 'none';
    parent.appendChild(root);
    const elements = new Map<number, HTMLElement>();
    const get = elements.get.bind(elements);
    elements.get = (id: number) => {
      let el = get(id);
      if (!el) {
        el = doc.createElement('div');
        el!.style.pointerEvents = 'none';
        el!.dataset.elementId = `0x${id.toString(16)}`;
        root.appendChild(el!);
        elements.set(id, el!);
      }
      return el;
    };
    const noop = () => {};
    return {
      root, layout: { elements: [] }, elements, descs: new Map(),
      setText: noop, setFill: noop, setVisible: noop, setState: noop, setPalette: noop, setInteractive: noop,
      setScrollable: () => ({ contentEl: doc.createElement('div'), setPosition: noop, scrollToBottom: noop, appendContent: noop }),
      setDraggable: noop, setDropTarget: noop, setTexture: noop, onClick: noop,
      destroy: () => root.remove(), moveTo: noop, close: () => root.remove(), bringToFront: noop,
    };
  };
  const lr = {
    render: (_id: number, parent: HTMLElement) => makeHandle(parent),
    renderPanel: (_id: number, parent: HTMLElement) => makeHandle(parent),
    getTextureDataURLWithAlpha: () => null,
    getResolvedLayout,
    setFontResolver: () => {},
  };
  H.ui.layoutRenderer = lr;
  return lr;
}

function mountHud(H: GameUIFixture, getResolvedLayout: (id: number) => LayoutDescData | null): void {
  stubLayoutRenderer(H, getResolvedLayout);
  for (const [n, s] of Object.values(TEX)) {
    H.ui.uiTextures.set(n, `fake://tex-${n.toString(16)}`);
    H.ui.uiTextures.set(s, `fake://tex-${s.toString(16)}`);
  }
  H.ui.uiManager.setScreen('game');
  H.ui.renderHUD();
}

/** The resolved toolbar layout as the DAT has it: no p73 anywhere (built from the real one when present). */
function syntheticToolbar(withTooltipOn?: { elementId: number; stringId: number }): LayoutDescData {
  const el = (elementId: number, props = new Map()): ElementDesc => ({
    elementId, properties: props, states: new Map(), children: new Map(), media: [],
  }) as unknown as ElementDesc;
  const root = el(0x10000191);
  for (const id of Object.values(TOOLBAR_DOM)) {
    const props = new Map();
    if (withTooltipOn?.elementId === id) {
      props.set(75, { valueBool: true });
      props.set(73, { valueString: { stringId: withTooltipOn.stringId, tableId: 0x23000001 } });
      props.set(71, { valueEnum: 0x10000395 });
    }
    (root.children as Map<number, ElementDesc>).set(id, el(id, props));
  }
  return { id: TOOLBAR, displayWidth: 800, displayHeight: 600, elements: new Map([[0x10000191, root]]) } as LayoutDescData;
}

describe('toolbar buttons: no invented tooltip, no hover art (behavioral, real GameUI)', () => {
  let H: GameUIFixture;
  beforeAll(async () => {
    H = await mountGameUI();
    const layout = syntheticToolbar();
    mountHud(H, (id) => (id === TOOLBAR ? layout : null));
  }, 60_000);
  afterAll(() => H?.teardown());

  const el = (id: string) => H.win.document.getElementById(id) as HTMLElement;

  it('no toolbar button carries a title or a HUD tooltip (the DAT gives none)', () => {
    for (const [id, elementId] of Object.entries(TOOLBAR_DOM)) {
      const b = el(id);
      expect(b, id).toBeTruthy();
      expect(b.getAttribute('title'), id).toBeNull();
      expect(b.dataset.acTooltipText, id).toBeUndefined();
      expect(b.dataset.acPress, id).toBe(`21000016:${elementId.toString(16)}`);
      // No hand-typed label text drawn into the button either.
      expect(b.textContent, id).toBe('');
    }
  });

  it('hovering a panel button keeps its state-1 art (the DAT has no rollover state)', () => {
    for (const id of ['tb-social', 'tb-char', 'tb-inv']) {
      const b = el(id);
      const before = b.style.backgroundImage;
      expect(before).toContain(`tex-${TEX[id][0].toString(16)}`);
      for (const type of ['mouseenter', 'mouseover', 'mousemove']) b.dispatchEvent(new H.win.MouseEvent(type, { bubbles: type !== 'mouseenter' }));
      expect(b.style.backgroundImage, id).toBe(before);
      expect(b.dataset.acState, id).toBe('1');
      b.dispatchEvent(new H.win.MouseEvent('mouseleave'));
      expect(b.style.backgroundImage, id).toBe(before);
    }
  });

  it('state 6 (selected art) shows while the panel is open, and hover/leave does not undo it', () => {
    const b = el('tb-char');
    H.ui.toggleCharPanel();
    expect(b.style.backgroundImage).toContain('tex-6001124');
    b.dispatchEvent(new H.win.MouseEvent('mouseenter'));
    b.dispatchEvent(new H.win.MouseEvent('mouseleave'));
    expect(b.style.backgroundImage).toContain('tex-6001124');
    H.ui.toggleCharPanel();
    expect(b.style.backgroundImage).toContain('tex-6001122');
    const inv = el('tb-inv');
    H.ui.toggleInventory();
    expect(inv.style.backgroundImage).toContain('tex-6004cf8');
    H.ui.toggleInventory();
    expect(inv.style.backgroundImage).toContain('tex-6004cf7');
  });
});

describe('toolbar tooltips come from the element\'s own DAT desc (applyHudDatTooltip)', () => {
  let H: GameUIFixture;
  const STRING_ID = 0x0badf00d;
  beforeAll(async () => {
    H = await mountGameUI();
    registerStringTable({ id: 0x23000001, language: 1, unknown: 0, entries: [{ id: STRING_ID, varNames: [], vars: [], strings: ['From the DAT'], comments: [] } as never] });
    const layout = syntheticToolbar({ elementId: 0x10000198, stringId: STRING_ID });
    mountHud(H, (id) => (id === TOOLBAR ? layout : null));
  }, 60_000);
  afterAll(() => H?.teardown());

  it('an element whose desc has p75/p73/p71 shows that string on the HUD tooltip machine; the rest show none', () => {
    const magic = H.win.document.getElementById('tb-magic') as HTMLElement;
    expect(magic.dataset.acTooltipText).toBe('From the DAT');
    expect(magic.dataset.acTooltipRoot).toBe('10000395');
    expect(magic.getAttribute('title')).toBeNull();
    expect((H.win.document.getElementById('tb-social') as HTMLElement).dataset.acTooltipText).toBeUndefined();
  });
});

describe('main chat entry takes the mouse (BUG.chat-container-covers-window-buttons)', () => {
  let H: GameUIFixture;
  beforeAll(async () => {
    H = await mountGameUI();
    mountHud(H, () => null);
  }, 60_000);
  afterAll(() => H?.teardown());

  it('#chat-input and its entry element 0x10000016 are pointer targets inside the click-through layout', () => {
    const input = H.win.document.getElementById('chat-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.style.pointerEvents).toBe('auto');
    const entry = input.parentElement as HTMLElement;
    expect(entry.dataset.elementId).toBe('0x10000016');
    expect(entry.style.pointerEvents).toBe('auto');
  });

  it('the chat-window buttons 0x10000522-525 stay pointer targets and toggle their floaty window', () => {
    const chat = H.win.document.getElementById('hud-chat') as HTMLElement;
    for (const [i, id] of ['0x10000522', '0x10000523', '0x10000524', '0x10000525'].entries()) {
      const btn = chat.querySelector(`[data-element-id="${id}"]`) as HTMLElement;
      expect(btn, id).toBeTruthy();
      expect(btn.style.pointerEvents, id).toBe('auto');
      const was = H.ui.isFloatyChatWindowOpen(i + 1);
      btn.dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));
      expect(H.ui.isFloatyChatWindowOpen(i + 1), id).toBe(!was);
      btn.dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));
    }
  });
});

describe.skipIf(!existsSync(PORTAL) || !existsSync(LOCAL))('DAT ground truth: the toolbar layouts', () => {
  let resolved: (id: number) => LayoutDescData | null;
  beforeAll(() => {
    const portalDb = openDat(PORTAL);
    const langDb = openDat(LOCAL);
    setMasterPropertyTypes(parseMasterProperty(portalDb.getReader(0x39000001)));
    const cache = new Map<number, LayoutDescData | null>();
    const load = (id: number): LayoutDescData | null => {
      if (!cache.has(id)) {
        try { cache.set(id, parseLayoutDesc(langDb.getReader(id))); } catch { cache.set(id, null); }
      }
      return cache.get(id)!;
    };
    resolved = (id) => { const raw = load(id); return raw ? resolveLayoutDesc(raw, load) : null; };
  });

  const walk = (e: ElementDesc, f: (e: ElementDesc) => void): void => { f(e); for (const c of e.children.values()) walk(c, f); };

  it('no element of 0x21000016 or of the floaty toolbar window 0x21000070 carries a p73 tooltip (resolved)', () => {
    for (const id of [TOOLBAR, 0x21000070]) {
      const layout = resolved(id)!;
      expect(layout, `layout 0x${id.toString(16)}`).toBeTruthy();
      let n = 0;
      for (const root of layout.elements.values()) walk(root, (e) => {
        n++;
        expect(e.properties.has(73), `0x${id.toString(16)}:0x${e.elementId.toString(16)} p73`).toBe(false);
        for (const st of e.states.values()) expect(st.properties.has(73), `0x${e.elementId.toString(16)} state p73`).toBe(false);
      });
      expect(n).toBeGreaterThan(10);
    }
  });

  it('the panel buttons draw art in states 1 and 6 only — no rollover state (2 / 7) exists, so hover shows nothing new', () => {
    const layout = resolved(TOOLBAR)!;
    const found = new Map<number, ElementDesc>();
    for (const root of layout.elements.values()) walk(root, (e) => { if (PANEL_BUTTONS.includes(e.elementId)) found.set(e.elementId, e); });
    expect(found.size).toBe(PANEL_BUTTONS.length);
    for (const [id, e] of found) {
      const label = `0x${id.toString(16)}`;
      expect(e.states.has(2), `${label} rollover`).toBe(false);
      expect(e.states.has(7), `${label} selected rollover`).toBe(false);
      const imageStates = [...e.states].filter(([, st]) => st.media.some((m) => m.type === MediaType.Image)).map(([sid]) => sid).sort((a, b) => a - b);
      // Only the journal button inherits a press state (3), and that carries
      // the UI_ButtonPress sound only — no art.
      expect(imageStates, label).toEqual([1, 6]);
    }
  });

  it('the real resolved layout gives the live GameUI toolbar no tooltip at all', async () => {
    const H = await mountGameUI();
    try {
      mountHud(H, resolved);
      for (const id of Object.keys(TOOLBAR_DOM)) {
        const b = H.win.document.getElementById(id) as HTMLElement;
        expect(b.getAttribute('title'), id).toBeNull();
        expect(b.dataset.acTooltipText, id).toBeUndefined();
      }
    } finally { H.teardown(); }
  }, 60_000);
});
