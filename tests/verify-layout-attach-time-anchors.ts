// @vitest-environment happy-dom
/**
 * LAYOUT.attach-time-center-anchors — retail applies each element's edge
 * anchors as it is attached, not only when its parent resizes.
 *
 * Ground truth (decompiled EoL client):
 *  - UIElement::SetParent @ 00462a50 calls UpdateForParentSizeChange(this)
 *    for every element joining a parent.
 *  - UIElement::UpdateForParentSizeChange @ 00462640: leftEdge 3 →
 *    x0 = parentW/2 - w/2, rightEdge 3 → x1 = parentW/2 - 1 + w/2 (integer
 *    halves, so an odd span loses a pixel); modes 1 / 2 / 4 are identities
 *    while the parent keeps its authored size. A parentless element uses
 *    the layout's display size.
 *
 * LayoutRenderer used to honour the anchors only in resizeSubtree, so a
 * centred element authored at a placeholder x/y drew there: the type-5
 * dialog's edit frame 0x2100003C:0x1000047e flush left at x=0, the
 * keyboard rows' Mapping buttons at y 0 instead of 4, the chat windows'
 * new-text arrow 0x1000048c in the left corner.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { applyAttachTimeAnchors, type ElementDesc, type LayoutDescData } from '@ac/dat-parser';
import { openDat, DAT_PATHS } from './_harness/dat.js';

const el = (
  id: number, x: number, y: number, w: number, h: number,
  edges: [number, number, number, number], children: ElementDesc[] = [],
): ElementDesc => ({
  elementId: id, x, y, width: w, height: h,
  leftEdge: edges[0], topEdge: edges[1], rightEdge: edges[2], bottomEdge: edges[3],
  children: new Map(children.map((c) => [c.elementId, c])),
} as unknown as ElementDesc);

const layoutOf = (w: number, h: number, roots: ElementDesc[]): LayoutDescData =>
  ({ id: 0x21000000, displayWidth: w, displayHeight: h, elements: new Map(roots.map((r) => [r.elementId, r])) } as LayoutDescData);

describe('applyAttachTimeAnchors — UpdateForParentSizeChange at attach time', () => {
  it('centres an L3/R3 child authored at x=0 in its parent (the type-5 edit frame: 160 in 400 → 120)', () => {
    const frame = el(2, 0, 43, 160, 24, [3, 2, 3, 1]);
    applyAttachTimeAnchors(layoutOf(800, 600, [el(1, 0, 0, 400, 125, [0, 0, 0, 0], [frame])]));
    expect([frame.x, frame.y, frame.width, frame.height]).toEqual([120, 43, 160, 24]);
  });

  it('centres a T3/B3 child vertically (a 32-tall button in a 40-tall row → y 4)', () => {
    const btn = el(2, 270, 0, 100, 32, [1, 3, 2, 3]);
    applyAttachTimeAnchors(layoutOf(800, 600, [el(1, 0, 0, 570, 40, [0, 0, 0, 0], [btn])]));
    expect([btn.x, btn.y, btn.width, btn.height]).toEqual([270, 4, 100, 32]);
  });

  it('an odd centred span loses its odd pixel, as retail\'s integer halves do (85 in 150 → x 33, 84 wide)', () => {
    const orn = el(2, 32, 0, 85, 16, [3, 1, 3, 1]);
    applyAttachTimeAnchors(layoutOf(800, 600, [el(1, 0, 0, 150, 16, [0, 0, 0, 0], [orn])]));
    expect([orn.x, orn.width]).toEqual([33, 84]);
  });

  it('leaves modes 0 / 1 / 2 / 4 where the DAT authors them while nothing resizes', () => {
    const kids = [
      el(2, 5, 6, 10, 10, [0, 0, 0, 0]), el(3, 7, 8, 10, 10, [1, 1, 1, 1]),
      el(4, 9, 10, 10, 10, [2, 2, 1, 1]), el(5, 11, 12, 10, 10, [4, 4, 4, 4]),
    ];
    applyAttachTimeAnchors(layoutOf(800, 600, [el(1, 0, 0, 200, 100, [0, 0, 0, 0], kids)]));
    expect(kids.map((k) => [k.x, k.y, k.width, k.height])).toEqual([[5, 6, 10, 10], [7, 8, 10, 10], [9, 10, 10, 10], [11, 12, 10, 10]]);
  });

  it('centres a top-level element in the layout display size, and its children follow its new size', () => {
    const child = el(2, 0, 0, 10, 10, [1, 1, 1, 1]);
    const top = el(1, 0, 0, 101, 50, [3, 3, 3, 3], [child]);
    applyAttachTimeAnchors(layoutOf(800, 600, [top]));
    expect([top.x, top.y, top.width, top.height]).toEqual([350, 275, 100, 50]);
    // R1 follows the far edge: the parent's lost pixel shrinks the 10-wide child to 9.
    expect([child.x, child.width]).toEqual([0, 9]);
  });

  it('is idempotent: a second pass moves nothing', () => {
    const frame = el(2, 0, 43, 161, 24, [3, 2, 3, 1]);
    const layout = layoutOf(800, 600, [el(1, 0, 0, 400, 125, [0, 0, 0, 0], [frame])]);
    applyAttachTimeAnchors(layout);
    const once = [frame.x, frame.y, frame.width, frame.height];
    applyAttachTimeAnchors(layout);
    expect([frame.x, frame.y, frame.width, frame.height]).toEqual(once);
  });
});

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);

describe.skipIf(!hasDats)('LayoutRenderer over the real DATs — every centred element is centred once rendered', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lr: any;
  let layoutIds: number[] = [];
  beforeAll(async () => {
    const dat = await import('@ac/dat-parser');
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(portal.getReader(0x39000001)));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const tex = { getTextureDataURL: () => null, getTextureDataURLWithAlpha: () => null };
    lr = new LayoutRenderer(local, tex as never, null);
    layoutIds = local.listFileIds(0x21);
  });

  it('no resolved layout keeps an L3 / T3 element off its parent\'s centre (31 did before the attach pass)', () => {
    const off: string[] = [];
    for (const id of layoutIds) {
      const layout = lr.getResolvedLayout(id) as LayoutDescData | null;
      if (!layout) continue;
      const walk = (m: Map<number, ElementDesc>, pw: number, ph: number): void => {
        for (const e of m.values()) {
          if (e.leftEdge === 3 && e.x !== Math.floor(pw / 2) - Math.floor(e.width / 2)) off.push(`${id.toString(16)}:${e.elementId.toString(16)} x`);
          if (e.topEdge === 3 && e.y !== Math.floor(ph / 2) - Math.floor(e.height / 2)) off.push(`${id.toString(16)}:${e.elementId.toString(16)} y`);
          walk(e.children, e.width, e.height);
        }
      };
      walk(layout.elements, layout.displayWidth, layout.displayHeight);
    }
    expect(off).toEqual([]);
  });

  it('the type-5 dialog\'s edit frame and the main chat\'s new-text arrow render centred', () => {
    const dlgHost = document.createElement('div');
    const dlg = lr.render(0x2100003c, dlgHost, { subtreePath: [0x2c, 0x3d] });
    const frame = dlg.elements.get(0x1000047e) as HTMLElement;
    expect([frame.style.left, frame.style.top, frame.style.width]).toEqual(['120px', '43px', '160px']);
    // EoL main chat 0x2100006f: the 16x16 arrow in the 368-wide log backing.
    const chat = lr.render(0x2100006f, document.createElement('div'));
    const arrow = chat.elements.get(0x1000048c) as HTMLElement;
    expect(arrow.style.left).toBe('176px');
  });
});
