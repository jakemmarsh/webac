/**
 * VISUAL.124/.73 + VISUAL.129 — options and map panels hosted in their REAL
 * EoL DAT containers (same migration class as the social 0x21000031 one).
 *
 * DAT ground truth (tools/dump-layout.mjs; specs in
 * verification/panel-specs/options.md / map.md):
 *
 * 0x2100002b (options) — tab group 0x10000208 (0,0) 300x600:
 *   tabs Gameplay Options 0x1000020d (0,0) 106x25 / Character 0x1000020e
 *   (106,0) 64x25 / Chat 0x1000050b (172,0) 50x25 / Config 0x1000020f
 *   (222,0) 56x25; corner minimize 0x10000210 (276,0) 24x25 (state1
 *   0x06001283 / state3 0x06001282); left gold edge 0x10000209; four page
 *   containers (2,25) 298x575 with leather fill 0x06004cc2; plus sibling
 *   row/widget TEMPLATES that are code-instanced, never shown directly.
 *
 * 0x21000027 (world/map) — tab group 0x100001f2 (0,0) 300x600:
 *   Map tab 0x100001f3 (0,0) 138x25 + House tab 0x100001f4 (138,0) 138x25;
 *   close 0x100001f5 (276,0) 24x25 (X art 0x06001393/0x06001394);
 *   TRANSPARENT panes (0,25) 300x575 — the map page (0x21000026) draws its
 *   content in a block at (0,135) 300x330 with edges T3/B3 (centered).
 *
 * The map half of this file's pins was CONVERTED to behavioral coverage
 * per the pin-conversion rule when CORE.5.d re-docked the panel:
 * renderPanel opts (layout id, tabs-as-drag-handles, DAT close button,
 * dock position) are driven in verify-panel-dock-options.ts, and the
 * tab/content/parchment DOM in verify-visual-map-2026-06-09.ts.
  *
 * DEBT.test-harness-hygiene: the options-frame pins are behavioural — the
 * real renderOptionsPanel runs against a recording stub layoutRenderer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, stubLayoutRender, type GameUIFixture } from './_harness/gameui.js';

interface PanelCall { layoutId: number; parent: HTMLElement; opts: Record<string, unknown> }

describe('VISUAL.124/.73 — options frame is DAT container 0x2100002b (behavioural)', () => {
  let H: GameUIFixture;
  const calls: PanelCall[] = [];
  const texts: Array<[number, string]> = [];
  const hidden: number[] = [];
  const clicks = new Map<number, () => void>();
  let lastElements: Map<number, HTMLElement> = new Map();

  beforeAll(async () => {
    H = await mountGameUI();
    const doc = H.win.document;
    H.ui.layoutRenderer = {
      renderPanel: (layoutId: number, parent: HTMLElement, opts: Record<string, unknown> = {}) => {
        calls.push({ layoutId, parent, opts });
        const root = doc.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of [0x10000208, 0x1000020d, 0x1000020e, 0x1000050b, 0x1000020f, 0x10000210,
          0x10000211, 0x10000212, 0x10000213, 0x1000050c]) {
          const el = doc.createElement('div');
          el.dataset.elementId = `0x${id.toString(16)}`;
          root.appendChild(el);
          elements.set(id, el);
        }
        lastElements = elements;
        return {
          root, elements,
          setState: () => {}, setInteractive: () => {}, setTexture: () => {},
          setText: (id: number, t: string) => { texts.push([id, t]); },
          setVisible: (id: number, v: boolean) => { if (!v) hidden.push(id); },
          onClick: (id: number, cb: () => void) => { clicks.set(id, cb); },
          close: () => { root.remove(); },
        };
      },
      render: stubLayoutRender(H.win.document),
    };
    H.ui.optionsTab = 'character';
    H.ui.toggleOptionsPanel();
  }, 60_000);
  afterAll(() => H.teardown());

  const optionsCall = (): PanelCall => calls.filter((c) => c.layoutId === 0x2100002b).at(-1)!;

  it('renders 0x2100002b into the HUD container, NOT the generic 0x2100001a frame', () => {
    expect(optionsCall()).toBeTruthy();
    expect(optionsCall().parent).toBe(H.ui.hudContainer);
    expect(calls.some((c) => c.layoutId === 0x2100001a)).toBe(false);
  });

  it('has NO title bar: no "Options" title text and no generic-frame close/drag elements', () => {
    expect(texts.some(([id]) => id === 0x100000fe)).toBe(false);
    expect(texts.some(([, t]) => t === 'Options')).toBe(false);
    // VISUAL.options-panel-eol-window — the only close is the tab strip's
    // own corner button 0x10000210, never a generic-frame 0x100000fe box.
    expect(optionsCall().opts.closeButtonId).toBe(0x10000210);
    expect(optionsCall().opts.dragHandleId).toBeUndefined();
  });

  it('opens in the EoL panels window: at its placement, no own drag handle or persisted position (VISUAL.options-panel-eol-window)', () => {
    // The panels window's frame drags / resizes it (WindowID 9); the panel
    // itself carries neither the CORE.5 tab drag handles nor 'options-v3'.
    const o = optionsCall().opts;
    expect(o.dragHandleId).toBeUndefined();
    expect(o.persistKey).toBeUndefined();
    expect(o.anchorLeft).toBe(true);
    const W = H.ui.hudLogicalWidth(); const Hh = H.ui.hudLogicalHeight();
    expect(o.x).toBe(Math.max(0, W - 310));
    expect(o.y).toBe(Math.max(0, Hh - 100 - 372));
  });

  it('the code-instanced row/widget templates never render: subtree render of the window element 0x10000208 (CORE.5.c)', () => {
    // Behavioral coverage of the exclusion itself: tests/verify-dock-panel-reflow.ts.
    expect(optionsCall().opts.subtreeElementId).toBe(0x10000208);
  });

  it('content lives in page container 0x10000211; the other three panes are hidden', () => {
    expect(hidden).toEqual(expect.arrayContaining([0x10000212, 0x10000213, 0x1000050c]));
    expect(hidden).not.toContain(0x10000211);
    const page = lastElements.get(0x10000211)!;
    expect(page.querySelectorAll('.option-toggle-row').length).toBeGreaterThan(0);
  });

  it('the corner button 0x10000210 hides the panel (the panels window has nothing to roll up)', () => {
    expect(H.ui.optionsPanelVisible).toBe(true);
    (optionsCall().opts.onClose as () => void)();
    expect(H.ui.optionsPanelVisible).toBe(false);
    expect(H.ui.optionsPanel).toBeNull();
    H.ui.toggleOptionsPanel();
    expect(H.ui.optionsPanelVisible).toBe(true);
  });
});

// VISUAL.129 map-frame pins converted to behavioral coverage (CORE.5.d):
// see verify-panel-dock-options.ts (renderPanel opts: layout 0x21000027,
// dock position, DAT close 0x100001f5, tabs [0x100001f3, 0x100001f4] as
// drag handles) and verify-visual-map-2026-06-09.ts (tab labels, map
// canvas at its DAT slot, parchment pane, centered content block).
