/**
 * SWEEP1006B.player-input.world-hover-find-throttled-10 — the mouse-over
 * find runs once per rendered frame at the newest pointer position
 * (UIElement_SmartBoxWrapper::Global_Loop @ 004e5620 / MouseMove
 * @ 004e56c0 arm it, SmartBox::DrawNoBlit @ 00454c20 resolves it), with no
 * 100 ms gate. Drives the real WorldHoverFind.
 */
import { describe, it, expect } from 'vitest';
import { WorldHoverFind } from '../packages/renderer/src/controllers/WorldHoverFind.js';

describe('WorldHoverFind', () => {
  it('finds every frame, even with the mouse still (the world moves under it)', () => {
    const h = new WorldHoverFind();
    h.move(10, 20);
    for (let i = 0; i < 5; i++) expect(h.frame(false)).toEqual({ x: 10, y: 20, dragging: false });
  });
  it('several moves inside one frame collapse to one find at the newest point', () => {
    const h = new WorldHoverFind();
    h.move(1, 1); h.move(2, 2); h.move(3, 4);
    expect(h.frame(false)).toEqual({ x: 3, y: 4, dragging: false });
  });
  it('two frames 16 ms apart both find (no 10 Hz throttle)', () => {
    const h = new WorldHoverFind();
    h.move(5, 5);
    const a = h.frame(false);
    h.move(6, 6);
    const b = h.frame(false);
    expect(a).not.toBeNull();
    expect(b).toEqual({ x: 6, y: 6, dragging: false });
  });
  it('during a HUD drag only a dragover point is used, flagged as dragging', () => {
    const h = new WorldHoverFind();
    h.move(1, 1);
    expect(h.frame(true)).toBeNull(); // stale mousemove point: no mousemove fires during a native drag
    h.dragOver(7, 8);
    expect(h.frame(true)).toEqual({ x: 7, y: 8, dragging: true });
    expect(h.frame(false)).toEqual({ x: 7, y: 8, dragging: false });
  });
  it('leaving the 3D view stops the finds', () => {
    const h = new WorldHoverFind();
    h.move(1, 1);
    h.leave();
    expect(h.hasPointer).toBe(false);
    expect(h.frame(false)).toBeNull();
  });
});
