/**
 * FAITHFUL.478 — trade + vendor panels are draggable (with persistence).
 *
 *  Pre-fix both panels rendered with `closeButtonId` but no
 *  `dragHandleId`, so they were anchored to their hardcoded
 *  positions. FAITHFUL.478 wired them to the generic 0x2100001a frame's
 *  drag handle with persisted positions.
 *
 *  CORE.10.g / CORE.17.k.b.b.c.c.a.a.c.a overturned that premise: the EoL
 *  client hosts BOTH in their slot of the HUD's bottom transaction dock
 *  (HUD 0x21000005 slot 0x100005fd → 0x2100006d:0x100005fb) — a fixed host,
 *  no drag handle, no persisted position. The full renderPanel-options
 *  coverage lives in tests/verify-panel-dock-options.ts; this file keeps a
 *  behavioural check of the current (non-draggable, docked) contract.
 *
 *  DEBT.test-harness-hygiene: replaced the "GameUI cites FAITHFUL.478"
 *  comment pin (which pinned the overturned premise's citation, not any
 *  behaviour) with the real GameUI driven in happy-dom.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

describe('FAITHFUL.478 (overturned by CORE.10.g) — trade/vendor live in the fixed transaction dock', () => {
  let H: GameUIFixture;
  beforeAll(async () => {
    H = await mountGameUI();
    // Minimal LayoutRenderer stub: every element id the panel code asks for
    // resolves to a real div, so the real render paths run to completion.
    const doc = H.win.document;
    const makeHandle = (parent: HTMLElement) => {
      const root = doc.createElement('div');
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>();
      const get = elements.get.bind(elements);
      elements.get = (id: number) => { let el = get(id); if (!el) { el = doc.createElement('div'); root.appendChild(el!); elements.set(id, el!); } return el; };
      const noop = () => {};
      return {
        root, layout: { elements: [] }, elements, descs: new Map(),
        setText: noop, setFill: noop, setVisible: noop, setState: noop, setPalette: noop, setInteractive: noop,
        setScrollable: () => ({ contentEl: doc.createElement('div'), setPosition: noop, scrollToBottom: noop, appendContent: noop }),
        setDraggable: noop, setDropTarget: noop, setTexture: noop, onClick: noop,
        destroy: () => root.remove(), moveTo: noop, close: () => root.remove(), bringToFront: noop,
      };
    };
    H.ui.layoutRenderer = {
      render: (_id: number, parent: HTMLElement) => makeHandle(parent),
      renderPanel: (_id: number, parent: HTMLElement) => makeHandle(parent),
    };
  }, 60_000);
  afterAll(() => H?.teardown());

  it('the trade window opens in the dock trade slot (fixed host, not a draggable frame)', () => {
    H.ui.showTradeWindow('Partner');
    const el = H.ui.tradePanel as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.dataset.dockPanel).toBe('trade');
    expect(el.dataset.dock).toBe('0x2100006d');
    H.ui.hideTradeWindow();
  });

  it('the vendor bar opens in the same dock host', () => {
    H.ui.vendorVisible = true;
    H.ui.renderVendorPanel();
    const el = H.ui.vendorWrapper as HTMLElement;
    expect(el).not.toBeNull();
    expect(el.dataset.dock).toBe('0x2100006d');
  });
});
