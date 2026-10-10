/**
 * GAP.indicator-bar-interactive — the HUD indicator strip (layout
 * 0x21000071) is interactive like retail (behavioural: drives the real
 * GameUI renderHUD in happy-dom and clicks the strip elements).
 *
 * Retail ground truth:
 *  - Every indicator is a plain UIElement_Button. HandleButtonClick
 *    @ 00471e50 fires the element's InputAction (attribute 0x12), exactly as
 *    the bound key would. UIElementManager::DoVisibilityToggleAction
 *    @ 0045b660 then toggles the panel registered for it via attribute 0x57.
 *  - A disabled button (state 0xd, the dark art) ignores the press
 *    (UIElement_Button::MouseUp @ 004720e0 / ListenToElementMessage
 *    @ 00472210). Link and burden have no 0xd state and are always live.
 *  - Pressed with the pointer over it = state 3 (UpdateState_ @ 00471cf0).
 *    Its PassToChildren shows the 0x100000f2 child's state-3 highlight frame.
 *  - No indicator carries a tooltip.
 *  - Burden has three states, from gmUIElement_BurdenIndicator::Update
 *    @ 004e6ce0: load < 1 → 0xe, [1, 2) → 0xf, ≥ 2 → 0x10.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const STRIP_IDS = [0x100000f3, 0x100000f4, 0x100000f5, 0x100000f6, 0x100000f7, 0x100000f8, 0x100000fa];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function installStrip(H: GameUIFixture, getResolvedLayout: (id: number) => any) {
  const makeHandle = (layoutId: number, parent: HTMLElement) => {
    const root = H.win.document.createElement('div');
    parent.appendChild(root);
    const elements = new Map<number, HTMLElement>();
    if (layoutId === 0x21000071) {
      for (const id of STRIP_IDS) {
        const el = H.win.document.createElement('div');
        el.setAttribute('title', 'stale');
        root.appendChild(el);
        elements.set(id, el);
      }
    }
    return {
      root, elements, descs: new Map(),
      setText: () => {}, setState: () => {}, setInteractive: () => {}, setVisible: () => {},
      setTexture: () => {}, close: () => { root.remove(); },
    };
  };
  H.ui.layoutRenderer = {
    render: (id: number, p: HTMLElement) => makeHandle(id, p),
    renderPanel: (id: number, p: HTMLElement) => makeHandle(id, p),
    getResolvedLayout,
  };
  for (const tex of [0x060074a2, 0x060074a3, 0x060074a4, 0x0600749b, 0x06004ce8]) {
    H.ui.uiTextures.set(tex, `fake://tex-${tex.toString(16)}`);
  }
  H.ui.renderHUD();
}

/** A minimal 0x21000071-shaped resolved layout: each indicator carries its
 *  attribute 0x12 InputAction and a 0x100000f2 child with a state-3 image. */
function fixtureLayout() {
  const actions: Record<number, number> = {
    0x100000f3: 0x1000000a, 0x100000f4: 0x1000000c, 0x100000f5: 0x10000006,
    0x100000f6: 0x10000007, 0x100000f7: 0x10000005, 0x100000f8: 0x10000009,
  };
  const children = new Map();
  for (const [id, action] of Object.entries(actions)) {
    const hl = { elementId: 0x100000f2, children: new Map(), properties: new Map(), media: [],
      states: new Map([[3, { media: [{ type: 1, file: Number(id) === 0x100000f3 ? 0x06004ce8 : 0x0600749b }] }]]) };
    children.set(Number(id), { elementId: Number(id), properties: new Map([[0x12, { valueEnum: action }]]),
      states: new Map(), media: [], children: new Map([[0x100000f2, hl]]) });
  }
  const root = { elementId: 0x10000610, children, properties: new Map(), states: new Map(), media: [] };
  return { elements: new Map([[0x10000610, root]]) };
}

const click = (H: GameUIFixture, el: HTMLElement) => {
  el.dispatchEvent(new H.win.MouseEvent('mousedown', { bubbles: true, button: 0 }));
  el.dispatchEvent(new H.win.MouseEvent('mouseup', { bubbles: true, button: 0 }));
  el.dispatchEvent(new H.win.MouseEvent('click', { bubbles: true, button: 0 }));
};

describe('GAP.indicator-bar-interactive — strip buttons (fixture layout)', () => {
  let H: GameUIFixture;
  const fired: number[] = [];
  beforeAll(async () => {
    H = await mountGameUI({ size: { innerWidth: 1600, innerHeight: 900 }, callbacks: { onInputAction: (id: number) => { fired.push(id); } } });
    installStrip(H, (id) => (id === 0x21000071 ? fixtureLayout() : null));
  });
  afterAll(() => H.teardown());
  const el = (id: string) => H.win.document.getElementById(`hud-indicator-${id}`) as HTMLElement;

  it('link status and burden are always live: a click fires their InputAction', () => {
    // Hit-testable (LayoutRenderer renders custom-class elements with
    // pointer-events: none, which swallowed every live click).
    for (const id of ['connection', 'effects-beneficial', 'effects-harmful', 'vitae', 'burden', 'minigame']) {
      expect(el(id).style.pointerEvents).toBe('auto');
    }
    fired.length = 0;
    click(H, el('connection'));
    click(H, el('burden'));
    expect(fired).toEqual([0x10000009, 0x10000005]);
  });

  it('a dark (state 0xd) indicator ignores the click; lit, it fires', () => {
    fired.length = 0;
    click(H, el('vitae'));
    click(H, el('effects-harmful'));
    click(H, el('minigame'));
    expect(fired).toEqual([]);
    H.ui.setIndicatorActive('vitae', true);
    H.ui.setIndicatorActive('effects-harmful', true);
    H.ui.setIndicatorActive('minigame', true);
    click(H, el('vitae'));
    click(H, el('effects-harmful'));
    click(H, el('minigame'));
    expect(fired).toEqual([0x1000000c, 0x10000007, 0x1000000a]);
  });

  it('pressing shows the child state-3 highlight until release; never on a dark indicator', () => {
    const hl = (id: string) => el(id).querySelector(`[data-indicator-highlight="${id}"]`) as HTMLElement;
    el('burden').dispatchEvent(new H.win.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(hl('burden').style.display).toBe('block');
    expect(hl('burden').style.backgroundImage).toContain('600749b');
    H.win.document.dispatchEvent(new H.win.MouseEvent('mouseup', { bubbles: true, button: 0 }));
    expect(hl('burden').style.display).toBe('none');
    H.ui.setIndicatorActive('effects-beneficial', false);
    el('effects-beneficial').dispatchEvent(new H.win.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(hl('effects-beneficial').style.display).toBe('none');
    // The mini-game's frame is its own art.
    expect(hl('minigame').style.backgroundImage).toContain('6004ce8');
  });

  it('no indicator (nor the logout X) carries a tooltip', () => {
    for (const id of ['connection', 'effects-beneficial', 'effects-harmful', 'vitae', 'burden', 'minigame', 'logout']) {
      expect(el(id).hasAttribute('title')).toBe(false);
    }
  });

  it('burden shows three states: < 100% 0x060074a2, 100–199% 0x060074a3, ≥ 200% 0x060074a4', () => {
    for (const [cur, tex] of [[5000, '60074a2'], [10000, '60074a3'], [19999, '60074a3'], [20000, '60074a4'], [45000, '60074a4'], [9999, '60074a2']] as const) {
      H.ui.setBurden(cur, 10000);
      expect(el('burden').style.backgroundImage).toContain(tex);
    }
  });

  it('a rebuilt strip repaints the burden state from the current load', () => {
    H.ui.setBurden(25000, 10000);
    H.ui.renderIndicatorsStrip();
    expect(el('burden').style.backgroundImage).toContain('60074a4');
  });
});

const REPO = resolve(__dirname, '..');
const LANG_PATH = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_PATH = resolve(REPO, 'dat/client_portal.dat');

describe.skipIf(!fs.existsSync(LANG_PATH) || !fs.existsSync(PORTAL_PATH))(
  'GAP.indicator-bar-interactive — the real 0x21000071 attribute-0x12 actions route through onInputAction',
  () => {
    let H: GameUIFixture;
    const fired: number[] = [];
    beforeAll(async () => {
      const dat = await import('@ac/dat-parser');
      const open = (p: string) => {
        const b = fs.readFileSync(p);
        return new dat.DatDatabase(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
      };
      const portal = open(PORTAL_PATH);
      dat.setMasterPropertyTypes(dat.parseMasterProperty(new dat.DatReader(portal.getFileData(0x39000001)!)));
      const lang = open(LANG_PATH);
      const lrMod = await import('../packages/renderer/src/ui/LayoutRenderer.js');
      const tex = { getTextureDataURL: () => '', getTextureDataURLWithAlpha: () => '' };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const real = new lrMod.LayoutRenderer(lang as any, tex as any, null);
      H = await mountGameUI({ size: { innerWidth: 1600, innerHeight: 900 }, callbacks: { onInputAction: (id: number) => { fired.push(id); } } });
      installStrip(H, (id) => real.getResolvedLayout(id));
    });
    afterAll(() => H?.teardown());

    it('each indicator fires its DAT InputAction (the keybind Show/Hide panel commands)', () => {
      for (const id of ['vitae', 'effects-beneficial', 'effects-harmful', 'minigame']) H.ui.setIndicatorActive(id, true);
      const order = ['connection', 'effects-beneficial', 'effects-harmful', 'vitae', 'burden', 'minigame'];
      for (const id of order) click(H, H.win.document.getElementById(`hud-indicator-${id}`));
      expect(fired).toEqual([0x10000009, 0x10000006, 0x10000007, 0x1000000c, 0x10000005, 0x1000000a]);
    });

    it('the pressed highlight is the DAT child 0x100000f2 state-3 art', () => {
      const f = (id: string) => H.win.document.querySelector(`[data-indicator-highlight="${id}"]`) as HTMLElement;
      expect(f('vitae').style.backgroundImage).toContain('600749b');
      expect(f('minigame').style.backgroundImage).toContain('6004ce8');
    });
  },
);
