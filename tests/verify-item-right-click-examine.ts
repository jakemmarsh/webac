/**
 * VISUAL.item-right-click-examine — retail has no item or world context menu.
 * A right-click is select + examine everywhere:
 *  - pack items: UIElement_ItemList::ListenToElementMessage @ 004e4d50,
 *    input action 8 → SetSelectedObject + ClientUISystem::ExamineObject;
 *  - worn items: gmPaperDollUI::ListenToElementMessage @ 004a5c30;
 *  - the 3D world: UIElement_SmartBoxWrapper::MouseUp @ 004e5820 → sr_Examine.
 * Drives the real GameUI (happy-dom) and the real WorldRightClick.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { WorldRightClick } from '../packages/renderer/src/ui/WorldRightClick.js';

const HAPPY_DOM_PKG = ['happy', 'dom'].join('-');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let domWindow: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any = await import(/* @vite-ignore */ HAPPY_DOM_PKG);
  domWindow = new mod.Window({ innerWidth: 1024, innerHeight: 768 });
} catch { /* skip */ }

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
const INVENTORY_ELEMENT_IDS = [0x100001d0, 0x100001cd, 0x100001ce, 0x100001cf];
class NoopObserver { observe(): void {} unobserve(): void {} disconnect(): void {} takeRecords(): unknown[] { return []; } }

describe.skipIf(!domWindow)('pack item right-click (real GameUI)', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const examined: number[] = [];
  const apple = { id: 0x800009e4, weenieClassId: 258, name: 'Apple', value: 7, burden: 50, stackSize: 1, maxStackSize: 1, stackable: false, containerId: 0 };

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    for (const key of DOM_GLOBALS) { saved[key] = g[key]; g[key] = key === 'window' ? domWindow : domWindow[key]; }
    saved.MutationObserver = g.MutationObserver; saved.ResizeObserver = g.ResizeObserver;
    g.MutationObserver = NoopObserver; g.ResizeObserver = NoopObserver;
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      renderPanel: (_id: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of INVENTORY_ELEMENT_IDS) { const el = domWindow.document.createElement('div'); root.appendChild(el); elements.set(id, el); }
        return { root, elements, setText: () => {}, close: () => { root.remove(); } };
      },
    };
    ui.setDragCallbacks({ onRightClickItem: (idx: number) => examined.push(idx) });
    ui.toggleInventory();
    ui.setInventoryData([apple], [], 50, 15000);
  });
  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 0));
    const g = globalThis as Record<string, unknown>;
    for (const key of [...DOM_GLOBALS, 'MutationObserver', 'ResizeObserver']) { if (saved[key] === undefined) delete g[key]; else g[key] = saved[key]; }
  });

  it('selects the item and examines it — no popup menu', () => {
    const cell = domWindow.document.querySelector('[data-inv-slot="0"]');
    expect(cell).toBeTruthy();
    const before = domWindow.document.body.querySelectorAll('div').length;
    cell.dispatchEvent(new domWindow.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    expect(ui.hudState.target?.id).toBe(apple.id);
    expect(ui.hudState.target?.name).toBe('Apple');
    expect(examined).toEqual([0]);
    expect(ui.contextMenu ?? null).toBeNull();
    // Nothing named Use / Drop / Examine was added to the page.
    const labels = [...domWindow.document.querySelectorAll('div')].map((d: HTMLElement) => d.textContent);
    expect(labels).not.toContain('Drop');
    expect(domWindow.document.body.querySelectorAll('div').length).toBeGreaterThanOrEqual(before - 5);
    expect(ui.showItemContextMenu).toBeUndefined();
  });
});

describe('WorldRightClick (sr_Examine)', () => {
  const ev = (type: string, button: number, x: number, y: number) => ({ type, button, clientX: x, clientY: y }) as unknown as MouseEvent;
  function make(hit: { guid: number } | null, ready = true) {
    const onExamine = vi.fn();
    const rc = new WorldRightClick({ isReady: () => ready, pick: () => hit, onExamine });
    return { rc, onExamine };
  }
  it('a right release over an object examines it', () => {
    const { rc, onExamine } = make({ guid: 0x80000100 });
    rc.onCanvasMouseUp(ev('mouseup', 2, 102, 101));
    expect(onExamine).toHaveBeenCalledWith({ guid: 0x80000100 });
  });
  it('SWEEP1006B — a release far from the press still examines, picked at the release point (MouseUp @ 004e5820 has no drag threshold)', () => {
    const picked: Array<[number, number]> = [];
    const onExamine = vi.fn();
    const rc = new WorldRightClick({
      isReady: () => true,
      pick: (e) => { picked.push([e.clientX, e.clientY]); return { guid: 9 }; },
      onExamine,
    });
    // The press happened at (100, 100); retail never records it for the right button.
    rc.onCanvasMouseUp(ev('mouseup', 2, 240, 180));
    expect(picked).toEqual([[240, 180]]);
    expect(onExamine).toHaveBeenCalledWith({ guid: 9 });
  });
  it('a left release does not examine; nothing under the mouse does nothing', () => {
    const a = make({ guid: 1 });
    a.rc.onCanvasMouseUp(ev('mouseup', 0, 100, 100));
    expect(a.onExamine).not.toHaveBeenCalled();
    const b = make(null);
    b.rc.onCanvasMouseUp(ev('mouseup', 2, 5, 5));
    expect(b.onExamine).not.toHaveBeenCalled();
  });
  it('before the world is up, nothing happens', () => {
    const { rc, onExamine } = make({ guid: 1 }, false);
    rc.onCanvasMouseUp(ev('mouseup', 2, 0, 0));
    expect(onExamine).not.toHaveBeenCalled();
  });
});
