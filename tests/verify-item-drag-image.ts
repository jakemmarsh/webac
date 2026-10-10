/**
 * BUG.drag-ghost-missing — every item drag sets the item's drag icon (a
 * canvas painted synchronously from RenderIcons' m_pDragIcon) at the
 * (16, 16) hotspot (UIElementManager::StartDragandDrop), instead of the
 * browser snapshot, which was empty for the paperdoll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

describe('setItemDragImage (BUG.drag-ghost-missing)', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); }, 60_000);
  afterAll(() => H?.teardown());

  it('hands the drag icon canvas to setDragImage at (16, 16), mounted in the document while the browser snapshots it', () => {
    const canvas = H.win.document.createElement('canvas');
    canvas.width = 32; canvas.height = 32;
    const calls: Array<[unknown, number, number, boolean]> = [];
    H.ui.itemDragIconCanvas = () => canvas;
    const dt = { setDragImage: (el: Element, x: number, y: number) => { calls.push([el, x, y, el.isConnected]); } } as unknown as DataTransfer;
    H.ui.setItemDragImage(dt, { iconDid: 0x06001234 });
    expect(calls).toEqual([[canvas, 16, 16, true]]);
  });

  it('no icon → leaves the browser default alone; a missing DataTransfer is a no-op', () => {
    H.ui.itemDragIconCanvas = () => null;
    let called = false;
    H.ui.setItemDragImage({ setDragImage: () => { called = true; } } as unknown as DataTransfer, { iconDid: 1 });
    expect(called).toBe(false);
    expect(() => H.ui.setItemDragImage(null, { iconDid: 1 })).not.toThrow();
  });
});
