/**
 * VISUAL.43 + VISUAL.93 + VISUAL.44 + VISUAL3.HUD2 — HUD vitals ornaments +
 * radar frame, converted from source-grep pins to BEHAVIORAL (GAP.36):
 * drive the REAL renderHUD in happy-dom with a stub layout handle and
 * seeded texture URLs, then assert the DOM the player actually gets.
 *
 *  - Vital-bar ornaments (heart/sword/swirl) live in DAT element
 *    0x100004a9 (states 0x10000006 blank / 0x10000007 lit); LayoutRenderer
 *    applies only UIState.Normal, so GameUI promotes each ornament to its
 *    lit texture after rendering the CORE.5.b floaty cluster (stacked
 *    0x2100006c / side-by-side 0x21000075): bright-subtree 0x06007491/93/95,
 *    depleted-subtree (inside 0x100000e7) 0x06007490/92/94.
 *  - Radar: EoL floaty family (CORE.5.b.b) — layout 0x21000074, disc art
 *    0x06004cc1 (120x120), window 120x140 pinned top 0 / right 0 (root
 *    HUD 0x21000005 child 0x100006d2 at (680,0), edges L2/T1), disc
 *    canvas on the dial center (60,60) → filling the 120x120 art region.
 *
 * DAT ground-truth block (texture-index.json) retained from the old test —
 * it is data-driven, not a source pin.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

// Bar element ids per renderHUD: health 0x100000e6, stamina 0x100000ec, mana 0x100000ee.
const BAR_IDS = { health: 0x100000e6, stamina: 0x100000ec, mana: 0x100000ee };
const FILL_ID = 0x100000e7;
const ORNAMENT_ID = 0x100004a9;
// Numeric label ids (health/stamina/mana) + the stacked-cluster root
// (CORE.5.b: 0x100005f9 for 0x2100006c; the side-by-side root is 0x100006d4).
const TEXT_IDS = [0x100000eb, 0x100000ed, 0x100000ef];
const VITALS_ROOT_ID = 0x100005f9;

describe('GAP.36 — HUD vitals ornaments + radar frame (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stubMakeHandle: any = null;
  let stubVitalsDefaultState: number | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any = null;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);

    // Seed the texture cache so texBgStyle resolves real URLs (CORE.5.b —
    // the floaty cluster's own ornament state-media, 0x2100006c/0x21000075).
    for (const tex of [0x06007490, 0x06007491, 0x06007492, 0x06007493, 0x06007494, 0x06007495, 0x06004cc1]) {
      ui.uiTextures.set(tex, `fake://tex-${tex.toString(16)}`);
    }

    // Stub layout renderer: the vitals cluster layouts (CORE.5.b stacked
    // 0x2100006c / side-by-side 0x21000075) get bar elements,
    // each with a frame-subtree ornament + a fill subtree (0x100000e7)
    // containing its own ornament — mirroring the DAT structure the
    // promotion code walks.
    const makeHandle = (layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div');
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      const descs = new Map<number, { defaultState: number }>();
      if (layoutId === 0x2100006c || layoutId === 0x21000075) {
        for (const id of Object.values(BAR_IDS)) {
          const bar = domWindow.document.createElement('div');
          const frameOrn = domWindow.document.createElement('div');
          frameOrn.setAttribute('data-element-id', '0x100004a9');
          bar.appendChild(frameOrn);
          const fill = domWindow.document.createElement('div');
          fill.setAttribute('data-element-id', '0x100000e7');
          const fillOrn = domWindow.document.createElement('div');
          fillOrn.setAttribute('data-element-id', '0x100004a9');
          fill.appendChild(fillOrn);
          bar.appendChild(fill);
          root.appendChild(bar);
          elements.set(id, bar);
        }
        // Numeric label elements (CORE.4 toggle targets)
        for (const id of TEXT_IDS) {
          const label = domWindow.document.createElement('div');
          label.setAttribute('data-element-id', `0x${id.toString(16)}`);
          root.appendChild(label);
          elements.set(id, label);
        }
        // Vitals root desc — defaultState injected per-test via
        // stubVitalsDefaultState (CORE.4 initial-presentation source).
        if (stubVitalsDefaultState !== null) {
          descs.set(VITALS_ROOT_ID, { defaultState: stubVitalsDefaultState });
        }
      }
      // Permissive handle: renderHUD touches setInteractive/setText/etc.
      // on chat/status handles — no-op everything except root/elements.
      return {
        root, elements, descs,
        setText: () => {}, setState: () => {}, setInteractive: () => {}, setVisible: () => {},
        setTexture: () => {}, close: () => { root.remove(); },
      };
    };
    stubMakeHandle = makeHandle;
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
    };
    ui.renderHUD();
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function ornaments(barId: number) {
    const bar = ui.vitalsHandle.elements.get(barId) as HTMLElement;
    const all = [...bar.querySelectorAll('[data-element-id="0x100004a9"]')] as HTMLElement[];
    const fill = all.find(o => o.closest('[data-element-id="0x100000e7"]'))!;
    const frame = all.find(o => !o.closest('[data-element-id="0x100000e7"]'))!;
    return { fill, frame };
  }

  it('health ornament promoted: bright heart 0x06007491, depleted 0x06007490', () => {
    const { fill, frame } = ornaments(BAR_IDS.health);
    expect(frame.style.backgroundImage).toContain('6007491');
    expect(fill.style.backgroundImage).toContain('6007490');
  });

  it('stamina ornament promoted: bright sword 0x06007493, depleted 0x06007492', () => {
    const { fill, frame } = ornaments(BAR_IDS.stamina);
    expect(frame.style.backgroundImage).toContain('6007493');
    expect(fill.style.backgroundImage).toContain('6007492');
  });

  it('mana ornament promoted: bright swirl 0x06007495, depleted 0x06007494', () => {
    const { fill, frame } = ornaments(BAR_IDS.mana);
    expect(frame.style.backgroundImage).toContain('6007495');
    expect(fill.style.backgroundImage).toContain('6007494');
  });

  it('radar window: EoL floaty disc art 0x06004cc1, 120x140 pinned top 0px / right 0px', () => {
    const canvas = ui.hudContainer.querySelector('#radar-canvas') as HTMLCanvasElement;
    expect(canvas).toBeTruthy();
    const frame = canvas.parentElement as HTMLElement;
    expect(frame.style.backgroundImage).toContain('6004cc1');
    expect(frame.style.width).toBe('120px');
    expect(frame.style.height).toBe('140px');
    expect(frame.style.top).toBe('0px');
    expect(frame.style.right).toBe('0px');
    expect(frame.style.left).toBe('');
  });

  it('radar disc canvas is centered on the dial center (60,60) — flush with the art region', () => {
    const canvas = ui.hudContainer.querySelector('#radar-canvas') as HTMLCanvasElement;
    expect(canvas.style.left).toBe(`${60 - canvas.width / 2}px`);
    expect(canvas.style.top).toBe(`${60 - canvas.height / 2}px`);
  });

  // ── CORE.4 — icon/numeric presentation is EXCLUSIVE, click toggles ──
  // Retail: gmVitalsUI::ListenToElementMessage @ 004bfc00 — left/right click
  // (msg 0x1c, dwParam1 7/10) does SetState((cur == 0x10000006) + 0x10000006);
  // state 0x10000007 = lit ornaments (rawg_01/rawg_07.jpg, no numbers),
  // 0x10000006/base = numeric labels (chat-panel.jpg "4,200/4,200", no icons).

  function presentation() {
    const ornVisible = (ui.vitalOrnamentEls as HTMLElement[]).map(o => o.style.display !== 'none');
    const textVisible = TEXT_IDS.map(id => (ui.vitalsHandle.elements.get(id) as HTMLElement).style.display !== 'none');
    return { ornVisible, textVisible };
  }

  it('base state (no DAT defaultState): numeric labels visible, ornaments hidden', () => {
    const { ornVisible, textVisible } = presentation();
    expect(ui.vitalOrnamentEls.length).toBe(6); // 2 per bar
    expect(ornVisible.every(v => !v)).toBe(true);
    expect(textVisible.every(v => v)).toBe(true);
  });

  it('first click from base state applies the retail formula: (cur==6)+6 → state 6, still numeric', () => {
    ui.vitalsContainer.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(ui.vitalsDisplayState).toBe(0x10000006);
    const { ornVisible, textVisible } = presentation();
    expect(ornVisible.every(v => !v)).toBe(true);
    expect(textVisible.every(v => v)).toBe(true);
  });

  it('next click toggles to icon mode: ornaments visible, labels hidden', () => {
    ui.vitalsContainer.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(ui.vitalsDisplayState).toBe(0x10000007);
    const { ornVisible, textVisible } = presentation();
    expect(ornVisible.every(v => v)).toBe(true);
    expect(textVisible.every(v => !v)).toBe(true);
  });

  it('right click (contextmenu) also toggles, per retail dwParam1 7|10', () => {
    ui.vitalsContainer.dispatchEvent(new domWindow.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(ui.vitalsDisplayState).toBe(0x10000006);
    const { ornVisible, textVisible } = presentation();
    expect(ornVisible.every(v => !v)).toBe(true);
    expect(textVisible.every(v => v)).toBe(true);
  });

  it('never shows ornaments and labels together across repeated toggles', () => {
    for (let i = 0; i < 5; i++) {
      ui.vitalsContainer.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
      const { ornVisible, textVisible } = presentation();
      const anyOrn = ornVisible.some(v => v);
      const anyText = textVisible.some(v => v);
      expect(anyOrn && anyText).toBe(false);
      expect(anyOrn || anyText).toBe(true);
    }
  });

  it('DAT defaultState 0x10000007 starts in icon mode (icons, no numbers)', () => {
    stubVitalsDefaultState = 0x10000007;
    const container2 = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container2);
    const ui2 = new GameUICtor(container2);
    for (const [tex, url] of ui.uiTextures) ui2.uiTextures.set(tex, url);
    ui2.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => stubMakeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => stubMakeHandle(layoutId, parent),
    };
    ui2.renderHUD();
    expect(ui2.vitalsDisplayState).toBe(0x10000007);
    const ornVisible = (ui2.vitalOrnamentEls as HTMLElement[]).map(o => o.style.display !== 'none');
    const textVisible = TEXT_IDS.map(id => (ui2.vitalsHandle.elements.get(id) as HTMLElement).style.display !== 'none');
    expect(ornVisible.every(v => v)).toBe(true);
    expect(textVisible.every(v => !v)).toBe(true);
    // toggle from DAT-default icons → numeric, exactly the retail formula
    ui2.vitalsContainer.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(ui2.vitalsDisplayState).toBe(0x10000006);
    stubVitalsDefaultState = null;
    container2.remove();
  });

  it('DAT defaultState 0x10000006 starts in numeric mode', () => {
    stubVitalsDefaultState = 0x10000006;
    const container3 = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container3);
    const ui3 = new GameUICtor(container3);
    ui3.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => stubMakeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => stubMakeHandle(layoutId, parent),
    };
    ui3.renderHUD();
    expect(ui3.vitalsDisplayState).toBe(0x10000006);
    const ornVisible = (ui3.vitalOrnamentEls as HTMLElement[]).map(o => o.style.display !== 'none');
    expect(ornVisible.every(v => !v)).toBe(true);
    stubVitalsDefaultState = null;
    container3.remove();
  });
});

describe('DAT ground truth — hud-overview textures', () => {
  const REPO = resolve(__dirname, '..');
  const idxPath = resolve(REPO, 'verification/texture-index.json');
  const idx: Array<{ id: string; w: number; h: number }> | null =
    existsSync(idxPath) ? JSON.parse(readFileSync(idxPath, 'utf8')) : null;

  it.skipIf(!idx)('0x06004cc1 is the 120x120 EoL floaty radar disc art', () => {
    const t = idx!.find((x) => x.id === '0x06004cc1');
    expect(t).toBeTruthy();
    expect(t!.w).toBe(120);
    expect(t!.h).toBe(120);
  });

  it.skipIf(!idx)('lock/drag button art is 27x27 (0x060074b7 padlock, 0x060074c9 drag rose)', () => {
    for (const id of ['0x060074b7', '0x060074c9']) {
      const t = idx!.find((x) => x.id === id);
      expect(t, id).toBeTruthy();
      expect(t!.w).toBe(27);
      expect(t!.h).toBe(27);
    }
  });

  it.skipIf(!idx)('0x06005f3d is the ~30x28 heart ornament', () => {
    const t = idx!.find((x) => x.id === '0x06005f3d');
    expect(t).toBeTruthy();
    expect(t!.h).toBe(28);
  });
});
