/**
 * VISUAL.ui-owned-object-layers(.a) — elements with attribute 0xcd own a
 * UIObject (`UIElement::SetShouldOwnObject`). `RenderUI::LinkObject @
 * 004491e0` first orders it by m_nDepth (zLevel), but every frame
 * `DrawDirtyRegions @ 0045b820` → `DrawRegionWithObject @ 0045ac70` relinks
 * each object after the previous one in the pre-order paint walk, and
 * `RenderObjects @ 00448700` draws head → tail: every owner draws over the 2D
 * surface it sits in, whatever its zLevel. LayoutRenderer gives it a CSS
 * z-index above the surface's content.
 */
// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDat } from './_harness/dat.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import {
  parseLayoutDesc, parseMasterProperty, resolveLayoutDesc, setMasterPropertyTypes,
  type BaseProperty, type ElementDesc, type LayoutDescData,
} from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import {
  OWN_UI_OBJECT_PROPERTY, OWNED_OBJECT_Z_BASE, liftedOwnedObjects, applyOwnedObjectLayers,
} from '../packages/renderer/src/ui/LayoutPaintOrder.js';
import { LayoutRenderer } from '../packages/renderer/src/ui/LayoutRenderer.js';

interface Node {
  elementId: number; zLevel: number; uiReadOrder: number; type: number; baseElement: number;
  properties: Map<number, BaseProperty>; children: Map<number, Node>;
}

function n(elementId: number, zLevel: number, uiReadOrder: number, opts: { own?: boolean; kids?: Node[]; type?: number; base?: number } = {}): Node {
  const properties = new Map<number, BaseProperty>();
  if (opts.own) properties.set(OWN_UI_OBJECT_PROPERTY, { id: OWN_UI_OBJECT_PROPERTY, propertyType: 9, valueEnum: 3 } as BaseProperty);
  return {
    elementId, zLevel, uiReadOrder, type: opts.type ?? 3, baseElement: opts.base ?? 0, properties,
    children: new Map((opts.kids ?? []).map((k) => [k.elementId, k])),
  };
}

const ids = (l: Array<{ desc: Node }>) => l.map((x) => x.desc.elementId);

describe('liftedOwnedObjects', () => {
  it('returns nothing when no element owns an object', () => {
    expect(liftedOwnedObjects([n(1, 0, 0, { kids: [n(2, 0, 1), n(3, 5, 2)] })])).toEqual([]);
  });

  it('lifts a same-depth owner nested anywhere under the root surface', () => {
    const root = n(1, 0, 0, { kids: [n(2, 0, 1, { kids: [n(3, 0, 2, { own: true })] }), n(4, 0, 3)] });
    expect(ids(liftedOwnedObjects([root]))).toEqual([3]);
  });

  it('lifts an owner of HIGHER zLevel than its surface too (DrawRegionWithObject relinks it after the surface)', () => {
    // paint order: z99 first (back), then z0 — both draw over the root surface, in that order.
    const root = n(1, 0, 0, { kids: [n(3, 0, 2, { own: true }), n(2, 99, 1, { own: true })] });
    expect(ids(liftedOwnedObjects([root]))).toEqual([2, 3]);
  });

  it('ranks owners in the pre-order paint walk: an owner before its owning children, siblings back → front', () => {
    // root z5: a (z5, owns) holding a1 (z0, owns); b (z2, owns); c (z5, owns) later in read order.
    // Paint order of root's children: a, c (z5, by read order), then b (z2).
    const a1 = n(0xa1, 0, 1, { own: true });
    const root = n(1, 5, 0, {
      kids: [n(0xa, 5, 1, { own: true, kids: [a1] }), n(0xb, 2, 2, { own: true }), n(0xc, 5, 3, { own: true })],
    });
    expect(ids(liftedOwnedObjects([root]))).toEqual([0xa, 0xa1, 0xc, 0xb]);
  });

  it('lifts a nested owner and its higher-zLevel owning parent (chat band z600 over root z1)', () => {
    const root = n(1, 1, 0, { kids: [n(0x600, 600, 1, { own: true, kids: [n(0x11, 0, 1, { own: true })] })] });
    expect(ids(liftedOwnedObjects([root]))).toEqual([0x600, 0x11]);
  });

  it('skips inherited scrollbar subtrees (rendered hidden)', () => {
    const root = n(1, 0, 0, { kids: [n(2, 0, 1, { type: 11, base: 0x10000012, kids: [n(3, 0, 1, { own: true })] })] });
    expect(liftedOwnedObjects([root])).toEqual([]);
  });

  it('applyOwnedObjectLayers sets z-index base+rank and isolates the container', () => {
    const own1 = n(2, 0, 1, { own: true });
    const own2 = n(3, 0, 2, { own: true });
    const root = n(1, 0, 0, { kids: [own1, n(4, 0, 3), own2] });
    const container = document.createElement('div');
    const dom = new Map<Node, HTMLElement>([root, own1, own2].map((d) => [d, document.createElement('div')]));
    expect(applyOwnedObjectLayers(container, [root], dom)).toBe(2);
    expect(dom.get(own1)!.style.zIndex).toBe(String(OWNED_OBJECT_Z_BASE));
    expect(dom.get(own2)!.style.zIndex).toBe(String(OWNED_OBJECT_Z_BASE + 1));
    expect(dom.get(root)!.style.zIndex).toBe('');
    expect(container.style.isolation).toBe('isolate');
  });

  it('applyOwnedObjectLayers leaves a tree with no lifted owner untouched', () => {
    const root = n(1, 0, 0, { kids: [n(2, 0, 1)] });
    const container = document.createElement('div');
    expect(applyOwnedObjectLayers(container, [root], new Map())).toBe(0);
    expect(container.style.isolation).toBe('');
  });
});

const DAT = resolve(__dirname, '..', 'dat');
const HAVE_DATS = existsSync(resolve(DAT, 'client_portal.dat')) && existsSync(resolve(DAT, 'client_local_English.dat'));

describe.skipIf(!HAVE_DATS)('owned-object layers in real layouts (DAT)', () => {
  let renderer: LayoutRenderer;
  let resolved: (id: number) => LayoutDescData;
  beforeAll(() => {
    const portal = openDat(resolve(DAT, 'client_portal.dat'));
    const lang = openDat(resolve(DAT, 'client_local_English.dat'));
    setMasterPropertyTypes(parseMasterProperty(portal.getReader(0x39000001)));
    const cache = new Map<number, LayoutDescData | null>();
    const load = (id: number): LayoutDescData | null => {
      if (!cache.has(id)) {
        const d = lang.getFileData(id);
        cache.set(id, d ? parseLayoutDesc(new DatReader(d)) : null);
      }
      return cache.get(id)!;
    };
    resolved = (id) => resolveLayoutDesc(load(id)!, load);
    renderer = new LayoutRenderer(lang, { getTextureDataURL: () => null, getTextureDataURLWithAlpha: () => null } as never, null);
  });

  it('paperdoll viewport 0x100001d5 (layout 0x21000024) draws over the doll page surface', () => {
    const host = document.createElement('div');
    const handle = renderer.render(0x21000024, host)!;
    expect(handle).toBeTruthy();
    const vp = handle.elements.get(0x100001d5)!;
    expect(Number(vp.style.zIndex)).toBeGreaterThanOrEqual(OWNED_OBJECT_Z_BASE);
    expect(handle.root.style.isolation).toBe('isolate');
    // A non-owning slot sibling stays in the surface's z-auto paint order.
    expect(handle.elements.get(0x10000328)!.style.zIndex).toBe('');
  });

  it('examine page (0x2100006b): the z99 model lifts with the misc list and allegiance line', () => {
    const lifted = ids(liftedOwnedObjects([...resolved(0x2100006b).elements.values()] as unknown as Node[]));
    expect(lifted).toEqual(expect.arrayContaining([0x10000148, 0x1000053a, 0x10000335]));
  });

  it('a layout with no owners renders without isolation (0x21000040 dialog)', () => {
    const host = document.createElement('div');
    const handle = renderer.render(0x21000040, host);
    if (!handle) return;
    expect(liftedOwnedObjects([...resolved(0x21000040).elements.values()] as unknown as ElementDesc[] as never)).toEqual([]);
    expect(handle.root.style.isolation).toBe('');
  });
});
