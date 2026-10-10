/**
 * VISUAL.examine-creature-portrait-blank.a / VISUAL.ui-owned-object-layers.a —
 * elements that own a UIObject (attribute 0xcd non-zero: `UIElement::
 * OnSetAttribute @ 00462d80` case 0xcd → `SetShouldOwnObject`) render as
 * separate RenderUI objects, relinked every frame in the pre-order draw walk
 * (`DrawDirtyRegions @ 0045b820` → `DrawRegionWithObject @ 0045ac70`), so they
 * draw over their window's 2D surface. The examine page 0x10000140's 3D
 * viewport 0x10000148 (z99) owns one; its stat list 0x10000149 and the
 * alpha-175 page scrim 0x10000141 do not — the EoR frame
 * (verification/retail-client/ab/retail-examine-npc.png) shows the model
 * undimmed over them.
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
  OWN_UI_OBJECT_PROPERTY, OWNED_OBJECT_Z_BASE, ownsUIObject, liftedOwnedObjects,
} from '../packages/renderer/src/ui/LayoutPaintOrder.js';
import { LayoutRenderer } from '../packages/renderer/src/ui/LayoutRenderer.js';

function d(zLevel: number, uiReadOrder: number, own?: number): Pick<ElementDesc, 'zLevel' | 'uiReadOrder' | 'properties'> {
  const properties = new Map<number, BaseProperty>();
  if (own !== undefined) properties.set(OWN_UI_OBJECT_PROPERTY, { id: OWN_UI_OBJECT_PROPERTY, propertyType: 9, valueEnum: own } as BaseProperty);
  return { zLevel, uiReadOrder, properties };
}

describe('ownsUIObject — attribute 0xcd', () => {
  it('is true only for a non-zero enum value', () => {
    expect(ownsUIObject(d(0, 0, 3))).toBe(true);
    expect(ownsUIObject(d(0, 0, 0))).toBe(false);
    expect(ownsUIObject(d(0, 0))).toBe(false);
  });
});

const DAT = resolve(__dirname, '..', 'dat');
const HAVE_DATS = existsSync(resolve(DAT, 'client_portal.dat')) && existsSync(resolve(DAT, 'client_local_English.dat'));

describe.skipIf(!HAVE_DATS)('examine window 0x100005f2 (layout 0x2100006b, DAT)', () => {
  let layout: LayoutDescData;
  let renderer: LayoutRenderer;
  beforeAll(() => {
    const portal = openDat(resolve(DAT, 'client_portal.dat'));
    const lang = openDat(resolve(DAT, 'client_local_English.dat'));
    setMasterPropertyTypes(parseMasterProperty(portal.getReader(0x39000001)));
    const cache = new Map<number, LayoutDescData | null>();
    const load = (id: number) => {
      if (!cache.has(id)) { const b = lang.getFileData(id); cache.set(id, b ? parseLayoutDesc(new DatReader(b)) : null); }
      return cache.get(id)!;
    };
    layout = resolveLayoutDesc(load(0x2100006b)!, load);
    renderer = new LayoutRenderer(lang, { getTextureDataURL: () => null, getTextureDataURLWithAlpha: () => null } as never, null);
  });

  it('the viewport (z99), misc list and allegiance line own objects; the stat list and page scrim do not', () => {
    const page = [...layout.elements.values()].find((e) => e.elementId === 0x100005f2)!.children.get(0x10000140)!;
    const own = (id: number) => ownsUIObject(page.children.get(id)!);
    expect(page.children.get(0x10000148)!.zLevel).toBe(99);
    expect(page.zLevel).toBe(0);
    expect(own(0x10000148)).toBe(true);
    expect(own(0x10000335)).toBe(true);
    expect(own(0x1000053a)).toBe(true);
    expect(own(0x10000149)).toBe(false);
    expect(own(0x10000141)).toBe(false);
  });

  it('lifts the model over the page surface, ranked before the allegiance line and misc list (pre-order paint walk)', () => {
    const order = liftedOwnedObjects([...layout.elements.values()]).map((x) => x.desc.elementId);
    const at = (id: number) => order.indexOf(id);
    expect(at(0x10000148)).toBeGreaterThanOrEqual(0);
    expect(at(0x10000148)).toBeLessThan(at(0x1000053a));
    expect(at(0x1000053a)).toBeLessThan(at(0x10000335));
    expect(order).not.toContain(0x10000149);
    expect(order).not.toContain(0x10000141);
  });

  it('the rendered examine panel gives the viewport a z-index above the stat list and scrims', () => {
    const host = document.createElement('div');
    const handle = renderer.render(0x2100006b, host, { subtreeElementId: 0x100005f2 })!;
    expect(handle).toBeTruthy();
    expect(Number(handle.elements.get(0x10000148)!.style.zIndex)).toBeGreaterThanOrEqual(OWNED_OBJECT_Z_BASE);
    expect(handle.elements.get(0x10000149)!.style.zIndex).toBe('');
    expect(handle.elements.get(0x10000141)!.style.zIndex).toBe('');
    expect(handle.root.style.isolation).toBe('isolate');
  });
});
