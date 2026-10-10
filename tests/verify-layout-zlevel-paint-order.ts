/**
 * BUG.layout-zlevel-semantics-inverted — LayoutRenderer used to apply each
 * element's DAT zLevel verbatim as a CSS z-index (higher = in front) and
 * left equal-z siblings in the DAT hash-table order. Retail is the inverse
 * and has a tie-break:
 *
 *  - `UIRegion::AddChild @ 006a0760` walks m_children from the tail and
 *    inserts the new child after the first node whose comparator (vtable
 *    +0x38, called on the existing node) returns >= 0, else at the head;
 *    `UIRegion::DrawChildren @ 0069fca0` paints head → tail.
 *  - For UIElements the comparator is `UIElement::CompareZLevel @ 0045fc60`
 *    (UIElement vftable 0x79bf20 +0x38, read from acclient.exe): the signed
 *    zLevel compare of `UIRegion::CompareZLevel @ 0069f000`, then
 *    m_desc.m_uiReadOrder (unsigned) on a tie.
 *
 * So siblings paint zLevel DESCENDING (0xffffffff = -1 is frontmost), then
 * read order ASCENDING; a full tie keeps creation order (the later-added in
 * front). LayoutRenderer now carries that order as DOM order and sets no
 * z-index from the DAT. `ElementDesc::Incorporate @ 0069b5a0` also offsets
 * the read order of children a derived desc ADDS by the number of base
 * children it does not override (decomp :626881).
 */
// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import {
  parseLayoutDesc, parseMasterProperty, resolveLayoutDesc, setMasterPropertyTypes,
  IncorporationFlags,
  type ElementDesc, type LayoutDescData,
} from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { retailPaintOrder, applyRetailPaintOrder } from '../packages/renderer/src/ui/LayoutPaintOrder.js';
import { LayoutRenderer } from '../packages/renderer/src/ui/LayoutRenderer.js';
import { scanLayoutPaintOrderFlips } from '../tools/layout-paint-order-lib.js';
import { openDat } from './_harness/dat.js';

function el(id: number, zLevel: number, uiReadOrder: number, extra: Partial<ElementDesc> = {}): ElementDesc {
  return {
    stateId: 0, passToChildren: false,
    incorporationFlags: IncorporationFlags.X | IncorporationFlags.Y | IncorporationFlags.Width
      | IncorporationFlags.Height | IncorporationFlags.ZLevel,
    properties: new Map(), media: [],
    uiReadOrder, elementId: id, type: 3, baseElement: 0, baseLayout: 0, defaultState: 0,
    x: 0, y: 0, width: 10, height: 10, zLevel,
    leftEdge: 0, topEdge: 0, rightEdge: 0, bottomEdge: 0,
    states: new Map(), children: new Map(),
    ...extra,
  };
}

function layoutOf(id: number, roots: ElementDesc[]): LayoutDescData {
  return {
    id, displayWidth: 100, displayHeight: 100,
    elements: new Map(roots.map((r) => [r.elementId, r])),
  } as unknown as LayoutDescData;
}

describe('retailPaintOrder — UIElement::CompareZLevel order (back → front)', () => {
  it('paints the HIGHEST zLevel first and -1 last', () => {
    const ids = [0xa, 0xb, 0xc, 0xd];
    const descs = [el(0xa, 0, 1), el(0xb, 10, 2), el(0xc, -1, 3), el(0xd, 9999, 4)];
    expect(retailPaintOrder(descs).map((i) => ids[i])).toEqual([0xd, 0xb, 0xa, 0xc]);
  });

  it('reads an unsigned 0xffffffff zLevel as -1 (the comparator is signed)', () => {
    const descs = [el(1, 0xffffffff, 1), el(2, 0, 2)];
    expect(retailPaintOrder(descs)).toEqual([1, 0]);
  });

  it('breaks zLevel ties by ASCENDING read order, whatever the creation order', () => {
    const descs = [el(1, 0, 3), el(2, 0, 1), el(3, 0, 2)];
    expect(retailPaintOrder(descs)).toEqual([1, 2, 0]);
  });

  it('a full tie keeps creation order (AddChild inserts after the existing equals)', () => {
    const descs = [el(1, 5, 7), el(2, 5, 7), el(3, 5, 7)];
    expect(retailPaintOrder(descs)).toEqual([0, 1, 2]);
  });

  it('mixes all three keys', () => {
    const ids = [1, 2, 3, 4, 5, 6];
    const descs = [el(1, 0, 2), el(2, 100, 9), el(3, 0, 1), el(4, -1, 0), el(5, 10, 3), el(6, 10, 3)];
    expect(retailPaintOrder(descs).map((i) => ids[i])).toEqual([2, 5, 6, 3, 1, 4]);
  });
});

describe('applyRetailPaintOrder — DOM order is the paint order, no z-index', () => {
  it('re-appends siblings back → front after the parent\'s own text node', () => {
    const parent = document.createElement('div');
    const text = document.createElement('div');
    text.className = 'layout-text';
    parent.appendChild(text);
    const descs = [el(1, 0, 1), el(2, 1000, 2), el(3, -1, 3)];
    const kids = descs.map((d) => {
      const e = document.createElement('div');
      e.dataset.elementId = String(d.elementId);
      parent.appendChild(e);
      return { el: e, desc: d };
    });
    applyRetailPaintOrder(parent, kids);
    expect([...parent.children].map((c) => (c as HTMLElement).dataset.elementId ?? 'text')).toEqual(['text', '2', '1', '3']);
    for (const k of kids) expect(k.el.style.zIndex).toBe('');
    expect(parent.style.isolation).toBe('');
  });
});

describe('LayoutRenderer.render — synthetic layout', () => {
  function render(layout: LayoutDescData): HTMLElement {
    const r = new LayoutRenderer({ getFileData: () => null } as unknown as DatDatabase, {} as never);
    // Seed the parse caches so render() never touches a DAT.
    (r as unknown as { layoutCache: Map<number, LayoutDescData> }).layoutCache.set(layout.id, layout);
    (r as unknown as { resolvedLayoutCache: Map<number, LayoutDescData> }).resolvedLayoutCache.set(layout.id, layout);
    const host = document.createElement('div');
    const handle = r.render(layout.id, host)!;
    expect(handle).toBeTruthy();
    return handle.root;
  }
  const idsUnder = (node: Element) => [...node.children].map((c) => (c as HTMLElement).dataset.elementId);

  it('orders each parent\'s children retail-wise and emits no DAT zLevel as z-index', () => {
    // A panel: background plate z100, a z10 close box, z0 content (read
    // orders out of creation order), a -1 badge; the content has its own
    // children with a z-tie broken by read order.
    const content = el(0x30, 0, 3, {
      children: new Map([
        [0x41, el(0x41, 0, 2)],
        [0x40, el(0x40, 0, 1)],
      ]),
    });
    const root = el(0x10, 900, 0, {
      width: 100, height: 100,
      children: new Map<number, ElementDesc>([
        [0x30, content],
        [0x31, el(0x31, 0, 1)],
        [0x20, el(0x20, 10, 5)],
        [0x50, el(0x50, 0xffffffff, 6)],
        [0x11, el(0x11, 100, 4)],
      ]),
    });
    const container = render(layoutOf(0x21990001, [root]));
    const rootEl = container.firstElementChild as HTMLElement;
    expect(rootEl.dataset.elementId).toBe('0x10');
    expect(idsUnder(rootEl)).toEqual(['0x11', '0x20', '0x31', '0x30', '0x50']);
    const contentEl = [...rootEl.children].find((c) => (c as HTMLElement).dataset.elementId === '0x30')!;
    expect(idsUnder(contentEl)).toEqual(['0x40', '0x41']);
    // The root's 900 no longer leaks out as a z-index; nothing does.
    for (const node of [rootEl, ...rootEl.querySelectorAll('[data-element-id]')] as HTMLElement[]) {
      expect(node.style.zIndex).toBe('');
    }
  });

  it('orders a layout\'s top-level elements the same way', () => {
    const container = render(layoutOf(0x21990002, [el(0x1, 0, 2), el(0x2, 1000, 3), el(0x3, 0, 1)]));
    expect(idsUnder(container)).toEqual(['0x2', '0x3', '0x1']);
  });

  it('resizeSubtree reflows each desc node\'s OWN DOM node when ids repeat and the paint order reorders the DOM', () => {
    // Two sibling groups (the social panes' shape): the same child ids in
    // both, and the paint order puts group 0x62 (read order 1) BEFORE 0x61
    // (read order 2) in the DOM. A divider 0x54 pinned to the bottom edge
    // (T2 B1) and a right-anchored button 0x55 (L2 R1) must each move with
    // their own group — pairing by the nth DOM hit of an id (the pre-fix
    // reflow) handed group 0x61's rects to group 0x62's nodes.
    const group = (id: number, readOrder: number, dividerY: number) => el(id, 0, readOrder, {
      width: 100, height: 100,
      children: new Map<number, ElementDesc>([
        [0x54, el(0x54, 0, 1, { y: dividerY, width: 100, height: 9, topEdge: 2, bottomEdge: 1 })],
        [0x55, el(0x55, 0, 2, { x: 60, width: 30, height: 20, leftEdge: 2, rightEdge: 1 })],
      ]),
    });
    const root = el(0x10, 0, 0, {
      width: 100, height: 100,
      children: new Map<number, ElementDesc>([
        [0x61, group(0x61, 2, 20)],
        [0x62, group(0x62, 1, 80)],
      ]),
    });
    const layout = layoutOf(0x21990003, [root]);
    for (const g of root.children.values()) {
      Object.assign(g, { leftEdge: 1, topEdge: 1, rightEdge: 1, bottomEdge: 1 });
    }
    const r = new LayoutRenderer({ getFileData: () => null } as unknown as DatDatabase, {} as never);
    (r as unknown as { layoutCache: Map<number, LayoutDescData> }).layoutCache.set(layout.id, layout);
    (r as unknown as { resolvedLayoutCache: Map<number, LayoutDescData> }).resolvedLayoutCache.set(layout.id, layout);
    const handle = r.render(layout.id, document.createElement('div'), { subtreeElementId: 0x10 })!;
    const rootEl = handle.elements.get(0x10)!;
    expect(idsUnder(rootEl)).toEqual(['0x62', '0x61']);
    handle.resizeSubtree!(150, 140);
    const g61 = rootEl.querySelector(':scope > [data-element-id="0x61"]')!;
    const g62 = rootEl.querySelector(':scope > [data-element-id="0x62"]')!;
    const part = (g: Element, id: number) => g.querySelector(`:scope > [data-element-id="0x${id.toString(16)}"]`) as HTMLElement;
    // Groups grew by (50, 40); each divider keeps its own authored y + 40.
    expect(part(g61, 0x54).style.top).toBe('60px');
    expect(part(g62, 0x54).style.top).toBe('120px');
    for (const g of [g61, g62]) {
      expect(part(g, 0x55).style.left).toBe('110px');
      expect(part(g, 0x55).style.width).toBe('30px');
    }
  });
});

describe('ElementDesc::Incorporate — added children sort after the base\'s own', () => {
  it('offsets an added child\'s read order by the base children the derived desc does not override', () => {
    const base = el(0x100, 0, 0, {
      children: new Map([
        [0x1, el(0x1, 0, 1)],
        [0x2, el(0x2, 0, 2)],
        [0x3, el(0x3, 0, 3)],
      ]),
    });
    const derived = el(0x200, 0, 0, {
      type: 0, baseLayout: 0x21990010, baseElement: 0x100,
      children: new Map([
        [0x2, el(0x2, 0, 7)], // overrides base child 2 → its read order is copied (7)
        [0x9, el(0x9, 0, 1)], // new → 1 + 2 (base children 1 and 3 not overridden)
      ]),
    });
    const baseLayout = layoutOf(0x21990010, [base]);
    const resolved = resolveLayoutDesc(layoutOf(0x21990011, [derived]), (id) => (id === 0x21990010 ? baseLayout : null));
    const kids = resolved.elements.get(0x200)!.children;
    expect(kids.get(0x1)!.uiReadOrder).toBe(1);
    expect(kids.get(0x2)!.uiReadOrder).toBe(7);
    expect(kids.get(0x3)!.uiReadOrder).toBe(3);
    expect(kids.get(0x9)!.uiReadOrder).toBe(3);
  });
});

// ── Real DAT ground truth ────────────────────────────────────────────────
const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');
const LANG_DAT = resolve(ROOT, 'dat/client_local_English.dat');
const hasDats = existsSync(PORTAL_DAT) && existsSync(LANG_DAT);

describe.skipIf(!hasDats)('BUG.layout-zlevel-semantics-inverted — EoL DAT layouts', () => {
  let load: (id: number) => LayoutDescData | null;
  let resolved: (id: number) => LayoutDescData;

  beforeAll(() => {
    const portal = openDat(PORTAL_DAT);
    const lang = openDat(LANG_DAT);
    setMasterPropertyTypes(parseMasterProperty(portal.getReader(0x39000001)));
    const cache = new Map<number, LayoutDescData | null>();
    load = (id) => {
      if (!cache.has(id)) {
        const d = lang.getFileData(id);
        cache.set(id, d ? parseLayoutDesc(new DatReader(d)) : null);
      }
      return cache.get(id)!;
    };
    resolved = (id) => resolveLayoutDesc(load(id)!, load);
  });

  const find = (m: Map<number, ElementDesc>, id: number): ElementDesc | undefined => {
    for (const e of m.values()) {
      if (e.elementId === id) return e;
      const hit = find(e.children, id);
      if (hit) return hit;
    }
    return undefined;
  };
  const paintIds = (parent: ElementDesc) => {
    const kids = [...parent.children.values()];
    return retailPaintOrder(kids).map((i) => kids[i].elementId);
  };

  it('the 0xffffffff zLevels of 0x21000041 parse as -1', () => {
    const l = load(0x21000041)!;
    for (const id of [0x10000487, 0x10000395, 0x10000397, 0x10000398]) {
      expect(find(l.elements, id)!.zLevel).toBe(-1);
    }
  });

  it('gameplay 0x21000005: the 3D view 0x1000049a (inherited 9999) paints first, the main chat window (600) second', () => {
    const order = paintIds(find(resolved(0x21000005).elements, 0x10000495)!);
    expect(order[0]).toBe(0x1000049a);
    expect(order[1]).toBe(0x10000601);
  });

  it('inventory 0x21000023: background z100, filler z50, then the z10 close/title, then the z0 panes', () => {
    const order = paintIds(find(resolved(0x21000023).elements, 0x100001cc)!);
    expect(order.slice(0, 2)).toEqual([0x100001d0, 0x100001d1]);
    expect(order.slice(2, 4).sort()).toEqual([0x100001d2, 0x100001d3]);
  });

  it('vitals meter 0x100000e6: depleted layer, bright child image 0x2, value text (read orders 1, 2, 3)', () => {
    expect(paintIds(find(resolved(0x2100006c).elements, 0x100000e6)!)).toEqual([0x100000e7, 0x2, 0x100000eb]);
  });

  it('the scan finds the flipped overlapping pairs the orchestrator verifies', () => {
    const flips = scanLayoutPaintOrderFlips(0x21000023, resolved(0x21000023));
    // The z100 background painted OVER everything before; now behind the panes.
    expect(flips.some((f) => f.back.id === 0x100001d0 && f.front.id === 0x100001cf)).toBe(true);
  });
});

describe.skipIf(!hasDats)('BUG.layout-zlevel-semantics-inverted — GameUI vitals meter (behavioral)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  beforeAll(async () => {
    const portalDb = openDat(PORTAL_DAT);
    const langDb = openDat(LANG_DAT);
    setMasterPropertyTypes(parseMasterProperty(portalDb.getReader(0x39000001)));
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { UITextureLoader } = await import('../packages/renderer/src/ui/UITextureLoader.js');
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const layoutRenderer = new LayoutRenderer(langDb, new UITextureLoader(new TextureManager(portalDb)));
    layoutRenderer.getTextureDataURLWithAlpha = () => null;
    document.body.innerHTML = '';
    const container = document.createElement('div');
    document.body.appendChild(container);
    ui = new GameUI(container, {}, portalDb, undefined, undefined, undefined, null, layoutRenderer);
    ui.showGame();
  });

  it('the bar DOM is depleted layer → bright image → label, and the bright image is the clipped one', () => {
    const bar = ui.vitalsHandle.elements.get(0x100000e6) as HTMLElement;
    expect([...bar.children].map((c) => (c as HTMLElement).dataset.elementId))
      .toEqual(['0x100000e7', '0x2', '0x100000eb']);
    expect(ui.healthFillEl).toBe(bar.children[1]);
    ui.updateVitalBarDAT(ui.healthFillEl, null, { current: 25, max: 100, fraction: 0.25 }, '');
    // UIElement_Meter::DrawChildren @ 0046fbd0: the child image spans x0 .. x0 + 25%.
    expect(ui.healthFillEl.style.clipPath).toBe('inset(0 75.0% 0 0)');
    expect((bar.children[0] as HTMLElement).style.clipPath).toBe('');
  });
});
