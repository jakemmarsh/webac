/**
 * BUG.ui-buttonpress-on-every-button — a UI press plays the pressed
 * element's own LayoutDesc Sound media, on the state the press enters, on
 * mouse-down; everything else is silent.
 *
 * Retail: UIElement_Button::MouseDown @ 00471ff0 → UpdateState_ @ 00471cf0
 * (3 Pressed; 8 when the 0xe selected flag is set; nothing while disabled
 * 0xd) → MediaMachine::Update_Sound @ 004658b0 plays the state's
 * MD_Data_Sound (m_stype from table m_file, or the raw wave m_file when
 * m_stype is 0). Media reach an element through its base chain
 * (LayoutDesc::InqFullDesc @ 0069a520 / ElementDesc::Incorporate @ 0069b5a0
 * concatenate base media), so the three authored UI_ButtonPress items reach
 * 301 element ids. See packages/renderer/src/ui/LayoutPressSound.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Sound } from '@ac/shared';
import {
  DatDatabase, parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes, resolveLayoutDesc, MediaType,
  type LayoutDescData, type ElementDesc, type StateDesc,
} from '@ac/dat-parser';
import {
  pressStateFor, stateSoundMedia, findPressElement, pressSoundsFor, tagLayoutElement, layoutPressAttr, UI_STATE_SELECTED_PRESSED,
} from '../packages/renderer/src/ui/LayoutPressSound.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { openDat } from './_harness/dat.js';

const TABLE = 0x2000004b;

function state(stateId: number, sounds: Array<[number, number]> = []): StateDesc {
  return {
    stateId, passToChildren: 0, incorporationFlags: 0, properties: new Map(),
    media: sounds.map(([file, sType]) => ({ type: MediaType.Sound, file, sType })),
  } as unknown as StateDesc;
}
function el(elementId: number, states: StateDesc[], children: ElementDesc[] = []): ElementDesc {
  return {
    ...state(0), uiReadOrder: 0, elementId, type: 1, baseElement: 0, baseLayout: 0, defaultState: 1,
    x: 0, y: 0, width: 10, height: 10, zLevel: 0, leftEdge: 0, topEdge: 0, rightEdge: 0, bottomEdge: 0,
    states: new Map(states.map((s) => [s.stateId, s])),
    children: new Map(children.map((c) => [c.elementId, c])),
  } as unknown as ElementDesc;
}

// A panel 0x10000001 with: a sounding button (0x10000002, label child
// 0x10000003 with no Pressed state), a silent button (0x10000004 — Pressed
// state, no media), a raw-wave button (0x10000005) and a plain row (0x10000006).
const LAYOUT: LayoutDescData = {
  id: 0x21000999, displayWidth: 800, displayHeight: 600,
  elements: new Map([[0x10000001, el(0x10000001, [state(1)], [
    el(0x10000002, [state(1), state(3, [[TABLE, Sound.UI_ButtonPress]]), state(6), state(8)], [el(0x10000003, [state(1)])]),
    el(0x10000004, [state(1), state(3)]),
    el(0x10000005, [state(3, [[0x0a000123, 0]])]),
    el(0x10000006, [state(1)]),
  ])]]),
};
const getLayout = (id: number): LayoutDescData | null => (id === LAYOUT.id ? LAYOUT : null);

describe('press state (UIElement_Button::UpdateState_ @ 00471cf0)', () => {
  it('normal / hover / unknown press into 3; selected (6-8) into 8; disabled (0xd) does not press', () => {
    expect(pressStateFor(undefined)).toBe(3);
    expect(pressStateFor(1)).toBe(3);
    expect(pressStateFor(2)).toBe(3);
    expect(pressStateFor(6)).toBe(UI_STATE_SELECTED_PRESSED);
    expect(pressStateFor(7)).toBe(8);
    expect(pressStateFor(0xd)).toBeNull();
  });

  it('stateSoundMedia returns only the entered state\'s Sound media', () => {
    const btn = findPressElement(LAYOUT, [0x10000002])!;
    expect(stateSoundMedia(btn, 3)).toEqual([{ table: TABLE, sound: Sound.UI_ButtonPress }]);
    expect(stateSoundMedia(btn, 1)).toEqual([]);
    expect(stateSoundMedia(btn, 8)).toEqual([]);
  });

  it('findPressElement walks the DOM chain from any subtree root, else falls back to the id', () => {
    expect(findPressElement(LAYOUT, [0x10000001, 0x10000002, 0x10000003])?.elementId).toBe(0x10000003);
    expect(findPressElement(LAYOUT, [0x10000002, 0x10000003])?.elementId).toBe(0x10000003);
    expect(findPressElement(LAYOUT, [0x10000099, 0x10000004])?.elementId).toBe(0x10000004);
    expect(findPressElement(LAYOUT, [0x10000099])).toBeNull();
  });
});

describe('pressSoundsFor (DOM → layout element → state media)', () => {
  let F: GameUIFixture;
  beforeAll(async () => { F = await mountGameUI(); });
  afterAll(() => F.teardown());

  function dom(): { root: HTMLElement; node: (id: number) => HTMLElement } {
    const doc = F.win.document;
    const root = doc.createElement('div');
    root.dataset.layoutId = '0x21000999';
    const mk = (parent: HTMLElement, id: number): HTMLElement => {
      const d = doc.createElement('div');
      d.dataset.elementId = `0x${id.toString(16)}`;
      parent.appendChild(d);
      return d;
    };
    const panel = mk(root, 0x10000001);
    const nodes = new Map<number, HTMLElement>();
    nodes.set(0x10000001, panel);
    const b = mk(panel, 0x10000002); nodes.set(0x10000002, b);
    nodes.set(0x10000003, mk(b, 0x10000003));
    for (const id of [0x10000004, 0x10000005, 0x10000006]) nodes.set(id, mk(panel, id));
    F.container.appendChild(root);
    return { root, node: (id) => nodes.get(id)! };
  }

  it('a press on a sounding button (or its label child) plays its state-3 media', () => {
    const { node } = dom();
    expect(pressSoundsFor(node(0x10000002), getLayout)).toEqual([{ table: TABLE, sound: Sound.UI_ButtonPress }]);
    expect(pressSoundsFor(node(0x10000003), getLayout)).toEqual([{ table: TABLE, sound: Sound.UI_ButtonPress }]);
  });

  it('a button with a Pressed state but no media is silent, and so is a row with no Pressed state', () => {
    const { node } = dom();
    expect(pressSoundsFor(node(0x10000004), getLayout)).toEqual([]);
    expect(pressSoundsFor(node(0x10000006), getLayout)).toEqual([]);
  });

  it('a selected toggle presses into 8 (silent); a disabled one does not press', () => {
    const { node } = dom();
    node(0x10000002).dataset.acState = '6';
    expect(pressSoundsFor(node(0x10000002), getLayout)).toEqual([]);
    node(0x10000002).dataset.acState = 'd';
    expect(pressSoundsFor(node(0x10000002), getLayout)).toEqual([]);
    node(0x10000002).dataset.acState = '2';
    expect(pressSoundsFor(node(0x10000002), getLayout)).toHaveLength(1);
  });

  it('1999 (EraWorldRules.pressSoundOnEveryButton): a button with no media of its own plays the client\'s one press sound; a sounding one keeps its own, a disabled or non-button stays silent', () => {
    const { node } = dom();
    const every = { table: TABLE, sound: Sound.UI_ButtonPress };
    expect(pressSoundsFor(node(0x10000004), getLayout, every)).toEqual([every]);
    expect(pressSoundsFor(node(0x10000002), getLayout, every)).toEqual([{ table: TABLE, sound: Sound.UI_ButtonPress }]);
    expect(pressSoundsFor(node(0x10000005), getLayout, every)).toEqual([{ table: 0x0a000123, sound: 0 }]);
    expect(pressSoundsFor(node(0x10000006), getLayout, every)).toEqual([]);
    node(0x10000004).dataset.acState = 'd';
    expect(pressSoundsFor(node(0x10000004), getLayout, every)).toEqual([]);
  });

  it('sType 0 media is the raw wave', () => {
    const { node } = dom();
    expect(pressSoundsFor(node(0x10000005), getLayout)).toEqual([{ table: 0x0a000123, sound: 0 }]);
  });

  it('a hand-built node tagged with tagLayoutElement resolves like a rendered one; an untagged button is silent', () => {
    const b = F.win.document.createElement('button');
    F.container.appendChild(b);
    expect(pressSoundsFor(b, getLayout)).toEqual([]);
    tagLayoutElement(b, 0x21000999, 0x10000002);
    expect(pressSoundsFor(b, getLayout)).toEqual([{ table: TABLE, sound: Sound.UI_ButtonPress }]);
  });

  it('GameUI plays the media on a left mouse-down (not on click, not for other buttons or untagged buttons)', () => {
    const played: Array<[number, number]> = [];
    const waves: number[] = [];
    F.ui.layoutRenderer = { getResolvedLayout: getLayout, setFontResolver: () => {} };
    F.ui.soundPlayer = {
      playGameSound: async (t: number, s: number) => { played.push([t, s]); },
      // MediaMachine::Update_Sound → PlaySoundFromCenter(DID, 1.0)
      playFromCenter: async (w: number) => { waves.push(w); },
    };
    F.ui.playUISound = () => { throw new Error('press sounds must not go through playUISound'); };
    const { node } = dom();
    const fire = (n: HTMLElement, type: string, button = 0) =>
      n.dispatchEvent(new F.win.MouseEvent(type, { bubbles: true, cancelable: true, button }));
    fire(node(0x10000003), 'click');
    expect(played).toEqual([]);
    fire(node(0x10000003), 'mousedown', 2);
    expect(played).toEqual([]);
    fire(node(0x10000003), 'mousedown');
    expect(played).toEqual([[TABLE, Sound.UI_ButtonPress]]);
    fire(node(0x10000004), 'mousedown');
    fire(node(0x10000006), 'mousedown');
    const plain = F.win.document.createElement('button');
    F.container.appendChild(plain);
    fire(plain, 'mousedown');
    expect(played).toEqual([[TABLE, Sound.UI_ButtonPress]]);
    fire(node(0x10000005), 'mousedown');
    expect(waves).toEqual([0x0a000123]);
    // A node outside the UI container (chat window, dialogs, menus) still plays.
    const outside = F.win.document.createElement('div');
    tagLayoutElement(outside, 0x21000999, 0x10000002);
    F.win.document.body.appendChild(outside);
    fire(outside, 'mousedown');
    expect(played).toHaveLength(2);
  });

  it('a data-ac-desc label inside a data-ac-press button passes the press up to the button', () => {
    const doc = F.win.document;
    const btn = doc.createElement('div');
    btn.innerHTML = `<span ${layoutPressAttr(0x21000999, 0x10000001, 0x10000002)}><span data-ac-desc="21000999:10000003">OK</span></span>`;
    F.container.appendChild(btn);
    const label = btn.querySelector('[data-ac-desc]')!;
    expect(pressSoundsFor(label, getLayout)).toEqual([{ table: TABLE, sound: Sound.UI_ButtonPress }]);
    // The selected toggle state on the button silences it.
    (btn.firstElementChild as HTMLElement).dataset.acState = '6';
    expect(pressSoundsFor(label, getLayout)).toEqual([]);
  });
});

describe('GameUI hand-built buttons carry their layout element', () => {
  let F: GameUIFixture;
  beforeAll(async () => { F = await mountGameUI(); });
  afterAll(() => F.teardown());

  it('dialog buttons are the 0x21000040:0x100002cd template (state-3 UI_ButtonPress)', () => {
    F.ui.showConfirmationDialog('Really?', () => {});
    const buttons = [...F.win.document.querySelectorAll('.ac-dialog-button')] as HTMLElement[];
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const b of buttons) expect(b.dataset.acPress).toBe('21000040:100002cd');
  });

  it('the classic toolbar buttons are their 0x21000016 elements, selected (6) while their panel is open', () => {
    F.ui.renderHUD?.();
    const doc = F.win.document;
    const want: Record<string, string> = {
      'tb-social': '21000016:10000197', 'tb-magic': '21000016:10000198', 'tb-char': '21000016:10000199',
      'tb-journal': '21000016:1000055a', 'tb-map': '21000016:1000019a', 'tb-opt': '21000016:1000019b',
      'tb-inv': '21000016:100001b1', 'tb-use': '21000016:1000019d', 'tb-examine': '21000016:100001a5',
      'combat-mode-btn': '21000016:10000192',
    };
    for (const [id, ref] of Object.entries(want)) expect(doc.getElementById(id)?.dataset.acPress, id).toBe(ref);
    const char = doc.getElementById('tb-char') as HTMLElement;
    const before = char.dataset.acState;
    F.ui.toggleCharPanel();
    expect(char.dataset.acState).toBe(before === '6' ? '1' : '6');
    F.ui.toggleCharPanel();
    expect(char.dataset.acState).toBe(before ?? '1');
  });

  // BUG.journal-button-opens-map — 0x1000055a's panel id is 25 =
  // QuestManagement_UIPanelID: the contracts panel, not the map.
  it('the journal button opens the contracts panel (QuestManagement) and lights while it is open', () => {
    F.ui.renderHUD?.();
    const btn = F.win.document.getElementById('tb-journal') as HTMLElement;
    const mapBefore = F.ui.mapPanelVisible;
    btn.dispatchEvent(new F.win.MouseEvent('click', { bubbles: true }));
    expect(F.ui.contractVisible).toBe(true);
    expect(F.ui.mapPanelVisible).toBe(mapBefore);
    expect(btn.dataset.acState).toBe('6');
    btn.dispatchEvent(new F.win.MouseEvent('click', { bubbles: true }));
    expect(F.ui.contractVisible).toBe(false);
    expect(btn.dataset.acState).toBe('1');
  });

  // BUG.combat-button-tooltip-tab — retail's combat toggle is ` (Tab is chat
  // mode); the button no longer carries the hand-typed '(Tab)' title — its
  // tooltip comes from its DAT element (data-ac-tooltip when the desc has one).
  it('the combat-mode button has no hand-typed "(Tab)" tooltip', () => {
    F.ui.renderHUD?.();
    const btn = F.win.document.getElementById('combat-mode-btn') as HTMLElement;
    expect(btn.title ?? '').not.toContain('Tab');
    expect(btn.dataset.acPress).toBe('21000016:10000192');
  });
});

const PORTAL = resolve(__dirname, '../dat/client_portal.dat');
const LOCAL = resolve(__dirname, '../dat/client_local_English.dat');

describe.skipIf(!existsSync(PORTAL) || !existsSync(LOCAL))('the EoL layouts, base chains resolved', () => {
  let load: (id: number) => LayoutDescData | null;
  let resolved: (id: number) => LayoutDescData | null;
  let all: LayoutDescData[];
  beforeAll(() => {
    const portalDb = openDat(PORTAL);
    const langDb = openDat(LOCAL);
    setMasterPropertyTypes(parseMasterProperty(portalDb.getReader(0x39000001)));
    const cache = new Map<number, LayoutDescData | null>();
    load = (id) => {
      if (!cache.has(id)) {
        try { cache.set(id, parseLayoutDesc(langDb.getReader(id))); } catch { cache.set(id, null); }
      }
      return cache.get(id)!;
    };
    const rcache = new Map<number, LayoutDescData | null>();
    resolved = (id) => {
      if (!rcache.has(id)) { const raw = load(id); rcache.set(id, raw ? resolveLayoutDesc(raw, load) : null); }
      return rcache.get(id)!;
    };
    all = langDb.listFileIds(0x21).map((id) => resolved(id)).filter((l): l is LayoutDescData => !!l);
  });

  it('every sound media item is UI_ButtonPress from 0x2000004B on state 3, over 301 element ids', () => {
    const ids = new Set<number>();
    const walk = (e: ElementDesc): void => {
      for (const [sid, st] of e.states) {
        for (const m of st.media) {
          if (m.type !== MediaType.Sound) continue;
          expect([sid, m.file, m.sType]).toEqual([3, TABLE, Sound.UI_ButtonPress]);
          ids.add(e.elementId);
        }
      }
      for (const c of e.children.values()) walk(c);
    };
    for (const l of all) for (const e of l.elements.values()) walk(e);
    expect(ids.size).toBe(301);
  });

  it('trade: the Trade toggle 0x10000086 and Clear All 0x1000008a sound on 3; the toggle is silent when pressed while selected (8)', () => {
    const trade = resolved(0x2100000d)!;
    const toggle = findPressElement(trade, [0x10000086])!;
    expect(stateSoundMedia(toggle, 3)).toEqual([{ table: TABLE, sound: Sound.UI_ButtonPress }]);
    expect(stateSoundMedia(toggle, 8)).toEqual([]);
    expect(stateSoundMedia(findPressElement(trade, [0x1000008a])!, 3)).toEqual([{ table: TABLE, sound: Sound.UI_ButtonPress }]);
  });

  it('silent in retail: the inventory burden gem 0x10000328 and the chargen spin arrows 0x10000364-366 have a Pressed state but no sound', () => {
    const silent = new Set([0x10000328, 0x10000364, 0x10000365, 0x10000366]);
    let seen = 0;
    const walk = (e: ElementDesc): void => {
      if (silent.has(e.elementId) && e.states.has(3)) { seen++; expect(stateSoundMedia(e, 3)).toEqual([]); }
      for (const c of e.children.values()) walk(c);
    };
    for (const l of all) for (const e of l.elements.values()) walk(e);
    expect(seen).toBeGreaterThan(0);
  });
});
