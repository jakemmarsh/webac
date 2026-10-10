/**
 * CORE.18.c.a — every UIItem icon goes through IconData::RenderIcons @
 * 0058d180 (decomp :382722; operands from acclient.exe @ 0058d1e5-0058d260):
 * the icon over its ITEM_TYPE backdrop (master enum 0x10000004 →
 * UIIconBackgrounds 0x25000008, row LowestSetBit(type)+1, 0 → 0x21), the
 * custom underlay / overlay, and the UiEffects outline tint (master enum
 * 0x10000005 → UIEffectIcons 0x25000009; opaque white → that surface's
 * pixel via SurfaceWindow::ReplaceColor @ 004415b0). IsThePlayer (vtable
 * +0x14 = ACCWeenieObject::IsThePlayer @ 0058c3d0) swaps in UIASSET's
 * PlayerIcon (GetDIDByEnum(0x10000004, 7)) on the Container backdrop.
 *
 * CORE.18.d — the vendor bar opens with the filter's first merchandise
 * object selected: VendorItemsUI::OpenVendor @ 004c16d0 SetSelectedItem's
 * the type menu, whose message 7 → gmVendorUI::ListenToElementMessage @
 * 004c5700 (0x100000bf) → VendorItemsUI::UpdateItemsList(0, true) @ 004c1ea0
 * → ACCWeenieObject::SetSelectedObject(first match).
 *
 * Suites: the compositor on synthetic pixels (always), GameUI through
 * happy-dom with synthetic DidMappers + a fake texture source (always), the
 * vendor selection (always), and the real EoL portal tables + the Leather
 * Basinet icon (DAT only, loaded in beforeAll).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import {
  lowestSetBit, loadIconEnumMaps, resolveRenderIconsDids, renderIcons,
  ITEM_TYPE_CONTAINER, ICON_ENUM_DEFAULT, type IconEnumMaps, type IconRgba,
} from '../packages/renderer/src/ui/ItemIconComposite.js';
import { OpenContainerTracker } from '../packages/renderer/src/world/OpenContainerTracker.js';
import { ItemShortcutRestorer } from '../packages/renderer/src/network/itemShortcutRestore.js';
import { openDat } from './_harness/dat.js';

// ─── synthetic fixtures ───────────────────────────────────────────────

const S = 32;
type Px = [number, number, number, number];

function solid(c: Px): IconRgba {
  const data = new Uint8Array(S * S * 4);
  for (let i = 0; i < S * S; i++) data.set(c, i * 4);
  return { width: S, height: S, data };
}
function blank(): IconRgba {
  return { width: S, height: S, data: new Uint8Array(S * S * 4) };
}
function setPx(img: IconRgba, x: number, y: number, c: Px): void {
  img.data.set(c, (y * img.width + x) * 4);
}
function px(img: IconRgba, x: number, y: number): Px {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

const BG: Px = [10, 20, 30, 255];
const FX: Px = [1, 2, 3, 255];
const WHITE: Px = [255, 255, 255, 255];
const RED: Px = [255, 0, 0, 255];
const HALF_GREEN: Px = [0, 200, 0, 128];

/** The test icon: (0,0) clear, (1,0) opaque white, (2,0) red, (3,0) half-alpha green, (4,0) near-white. */
function testIcon(): IconRgba {
  const icon = blank();
  setPx(icon, 1, 0, WHITE);
  setPx(icon, 2, 0, RED);
  setPx(icon, 3, 0, HALF_GREEN);
  setPx(icon, 4, 0, [254, 255, 255, 255]);
  return icon;
}

const MAPS: IconEnumMaps = {
  backgrounds: new Map([[0, 0], [2, 0x06000b02], [10, 0x06000b0a], [ICON_ENUM_DEFAULT, 0x06000b21]]),
  effects: new Map([[0, 0], [1, 0x06000e01], [ICON_ENUM_DEFAULT, 0x06000e21]]),
  playerIconDid: 0x0600127e,
};

describe('CORE.18.c.a — RenderIcons DID resolution', () => {
  it('LowestSetBit @ 00684460: lowest set bit index, -1 for 0', () => {
    expect(lowestSetBit(0)).toBe(-1);
    expect(lowestSetBit(1)).toBe(0);
    expect(lowestSetBit(0x2)).toBe(1);
    expect(lowestSetBit(0x101)).toBe(0);
    expect(lowestSetBit(0x80000000)).toBe(31);
  });

  it('the backdrop row is LowestSetBit(itemType)+1; type 0 falls to the 0x21 Default row', () => {
    expect(resolveRenderIconsDids({ iconDid: 0x06000100, itemType: 0x2 }, MAPS).backgroundDid).toBe(0x06000b02);
    // Several bits → the lowest one decides (Armor 0x2 over Container 0x200).
    expect(resolveRenderIconsDids({ iconDid: 0x06000100, itemType: 0x202 }, MAPS).backgroundDid).toBe(0x06000b02);
    expect(resolveRenderIconsDids({ iconDid: 0x06000100, itemType: 0 }, MAPS).backgroundDid).toBe(0x06000b21);
    expect(resolveRenderIconsDids({ iconDid: 0x06000100 }, MAPS).backgroundDid).toBe(0x06000b21);
  });

  it('the tint row is LowestSetBit(effects)+1; none / an unmapped row falls back to 0x21', () => {
    expect(resolveRenderIconsDids({ iconDid: 1, effects: 0x1 }, MAPS).effectsDid).toBe(0x06000e01);
    expect(resolveRenderIconsDids({ iconDid: 1, effects: 0 }, MAPS).effectsDid).toBe(0x06000e21);
    expect(resolveRenderIconsDids({ iconDid: 1, effects: 0x1000 }, MAPS).effectsDid).toBe(0x06000e21);
  });

  it('IsThePlayer: UIASSET PlayerIcon on the TYPE_CONTAINER backdrop, whatever the object says', () => {
    const d = resolveRenderIconsDids({ iconDid: 0x06001036, itemType: 0x10, isThePlayer: true }, MAPS);
    expect(d.iconDid).toBe(0x0600127e);
    expect(d.itemType).toBe(ITEM_TYPE_CONTAINER);
    expect(d.backgroundDid).toBe(0x06000b0a);
  });
});

describe('CORE.18.c.a — RenderIcons compositing (synthetic pixels)', () => {
  const out = renderIcons({ icon: testIcon(), overlay: null, underlay: null, background: solid(BG), effects: solid(FX) });

  it('m_pIcon: the backdrop shows through the icon\'s clear pixels, fully opaque', () => {
    expect(px(out.icon, 0, 0)).toEqual(BG);
    expect(px(out.icon, 31, 31)).toEqual(BG);
  });

  it('ReplaceColor: only exactly-opaque white takes the effects surface\'s pixel', () => {
    expect(px(out.dragIcon, 1, 0)).toEqual(FX);
    expect(px(out.icon, 1, 0)).toEqual(FX);
    expect(px(out.icon, 4, 0)).toEqual([254, 255, 255, 255]);
  });

  it('Blit_3Alpha: opaque colour replaces, partial alpha lerps with (a+1)>>8 weights, dst alpha kept', () => {
    expect(px(out.icon, 2, 0)).toEqual(RED);
    // w = 129: c − (c·129 >> 8) + (s·129 >> 8) — (10,20,30) under (0,200,0).
    expect(px(out.icon, 3, 0)).toEqual([10 - 5 + 0, 20 - 10 + 100, 30 - 15 + 0, 255]);
  });

  it('m_pDragIcon has no backdrop: clear stays clear, the icon copies through', () => {
    expect(px(out.dragIcon, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(px(out.dragIcon, 2, 0)).toEqual(RED);
    expect(px(out.dragIcon, 3, 0)).toEqual(HALF_GREEN);
  });

  it('the underlay sits between backdrop and icon (Blit_3Alpha) and is absent from the drag icon', () => {
    const under = blank();
    setPx(under, 0, 0, [0, 0, 250, 255]);
    setPx(under, 2, 0, [0, 0, 250, 255]);
    const r = renderIcons({ icon: testIcon(), overlay: null, underlay: under, background: solid(BG), effects: solid(FX) });
    expect(px(r.icon, 0, 0)).toEqual([0, 0, 250, 255]);
    expect(px(r.icon, 2, 0)).toEqual(RED); // the icon still wins where opaque
    expect(px(r.dragIcon, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('the overlay (Blit_4Alpha) goes over the icon in both surfaces; over clear it is copied', () => {
    const over = blank();
    setPx(over, 2, 0, [0, 0, 255, 128]);
    setPx(over, 5, 0, [0, 0, 255, 255]);
    const r = renderIcons({ icon: testIcon(), overlay: over, underlay: null, background: solid(BG), effects: solid(FX) });
    // dst alpha 255: A' = 256 → c − (c − s)·129/256, alpha 255.
    expect(px(r.dragIcon, 2, 0)).toEqual([127, 0, 128, 255]);
    expect(px(r.dragIcon, 5, 0)).toEqual([0, 0, 255, 255]);
    expect(px(r.icon, 5, 0)).toEqual([0, 0, 255, 255]);
  });

  it('the tint applies after the overlay: an overlay\'s opaque white is recoloured too', () => {
    const over = blank();
    setPx(over, 6, 0, WHITE);
    const r = renderIcons({ icon: testIcon(), overlay: over, underlay: null, background: solid(BG), effects: solid(FX) });
    expect(px(r.icon, 6, 0)).toEqual(FX);
  });
});

describe('CORE.18.c.a — OpenContainerTracker / ItemShortcutRestorer carry the RenderIcons inputs', () => {
  it('a tracked CreateObject keeps its type, UiEffects and overlay / underlay for the cell', () => {
    const t = new OpenContainerTracker();
    t.viewContents(0x70000001, []);
    t.trackCreateObject({
      guid: 0x80000010, containerId: 0x70000001, name: 'Gem', iconDid: 0x06002000, stackSize: 1,
      itemType: 0x800, uiEffects: 0x1, iconOverlayDid: 0x06006c34, iconUnderlayDid: 0x06005b0c,
    });
    const [row] = t.items();
    expect(row).toMatchObject({ itemType: 0x800, uiEffects: 0x1, iconOverlayDid: 0x06006c34, iconUnderlayDid: 0x06005b0c });
  });

  it('a restored shortcut hands the item (type / effects) to the toolbar slot', () => {
    const seen: unknown[] = [];
    const r = new ItemShortcutRestorer((i, did, title, item) => { if (did) seen.push([i, did, title, item?.itemType, item?.uiEffects]); });
    r.restoreFromDescription([{ index: 2, objectId: 0x80000020 }], () => ({ iconDid: 0x06003000, name: 'Wand', itemType: 0x8000, uiEffects: 0x1 }));
    expect(seen).toEqual([[2, 0x06003000, 'Wand', 0x8000, 0x1]]);
  });
});

// ─── GameUI through happy-dom ─────────────────────────────────────────

/** A DidMapper file (ACE DidMapper.cs): id, then the client + server sides. */
function didMapperBytes(id: number, rows: Array<[number, number]>): ArrayBuffer {
  const out: number[] = [];
  const u32 = (v: number) => out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  u32(id);
  out.push(1, rows.length); // IDNumberingType, CompressedUInt32 count (< 128)
  for (const [k, v] of rows) { u32(k); u32(v); }
  out.push(1, 0); // no names
  out.push(0, 0, 0, 0); // server side: empty
  return new Uint8Array(out).buffer;
}

const MASTER = 0x25000000;
const FILES = new Map<number, ArrayBuffer>([
  [MASTER, didMapperBytes(MASTER, [[0x10000004, 0x25000008], [0x10000005, 0x25000009], [7, 0x25000010]])],
  [0x25000008, didMapperBytes(0x25000008, [[2, 0x06000b02], [10, 0x06000b0a], [0x21, 0x06000b21]])],
  [0x25000009, didMapperBytes(0x25000009, [[1, 0x06000e01], [0x21, 0x06000e21]])],
  [0x25000010, didMapperBytes(0x25000010, [[0x10000004, 0x0600127e]])],
]);
const ARMOR_BG: Px = [0, 0, 180, 255];
const CONTAINER_BG: Px = [200, 120, 0, 255];
const PIXELS = new Map<number, () => IconRgba>([
  [0x06000100, testIcon],
  [0x0600127e, () => solid([90, 60, 30, 255])],
  [0x06000b02, () => solid(ARMOR_BG)],
  [0x06000b0a, () => solid(CONTAINER_BG)],
  [0x06000b21, () => solid(BG)],
  [0x06000e01, () => solid([0, 0, 255, 255])],
  [0x06000e21, () => solid(FX)],
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

const VEL = {
  root: 0x100000b7, filterMenu: 0x100000bf, filterText: 0x1000034d,
  itemsName: 0x100000c0, itemsCost: 0x100000c1, itemsList: 0x100000bd, itemsScroll: 0x100000be,
  itemsBuy: 0x100000c2, itemsAdd: 0x100000c3,
  tabItems: 0x100000b9, tabBuying: 0x100000ba, tabSelling: 0x100000bb,
  pageItems: 0x100000bc, pageBuying: 0x100000c4, pageSelling: 0x100000cd,
} as const;

describe('CORE.18.c.a / CORE.18.d — GameUI (happy-dom, synthetic DAT tables)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  /** data URL → the pixels the canvas stub was handed. */
  const rendered = new Map<string, IconRgba>();
  const texts = new Map<number, string>();
  const states = new Map<number, number>();
  const selected: number[] = [];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // happy-dom has no 2D canvas: record the image the compositor puts.
    const proto = domWindow.HTMLCanvasElement.prototype;
    proto.getContext = function (this: { __img?: IconRgba; width: number; height: number }) {
      const canvas = this;
      return {
        createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        putImageData: (img: { width: number; height: number; data: Uint8ClampedArray }) => {
          canvas.__img = { width: img.width, height: img.height, data: new Uint8Array(img.data) };
        },
      };
    };
    proto.toDataURL = function (this: { __img?: IconRgba }) {
      const url = `data:image/png;test,${rendered.size}`;
      if (this.__img) rendered.set(url, this.__img);
      return url;
    };
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.portalDb = { masterMapId: MASTER, getFileData: (id: number) => FILES.get(id) ?? null };
    ui.textureManager = { getIconRGBA: (id: number) => PIXELS.get(id)?.() ?? null };
    ui.layoutRenderer = {
      render: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of Object.values(VEL)) {
          const el = domWindow.document.createElement('div');
          el.setAttribute('data-element-id', `0x${id.toString(16)}`);
          el.style.width = '510px';
          root.appendChild(el);
          elements.set(id, el);
        }
        return {
          root, elements, descs: new Map(),
          setText: (id: number, text: string) => { texts.set(id, text); },
          setState: (id: number, s: number) => { states.set(id, s); },
          setVisible: () => {}, setFill: () => {}, setPalette: () => {},
          setInteractive: (id: number, fn?: (id: number, el: HTMLElement) => void) => {
            const el = elements.get(id);
            if (el && fn) el.addEventListener('click', () => fn(id, el));
          },
        };
      },
    };
    ui.setVendorCallbacks({ onSelectItem: (guid: number) => selected.push(guid) });
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  const urlOf = (el: HTMLElement): string => /url\("?([^")]+)"?\)/.exec(el.style.backgroundImage)?.[1] ?? '';
  const imgOf = (el: HTMLElement): IconRgba => {
    const img = rendered.get(urlOf(el));
    if (!img) throw new Error(`no rendered image for ${el.style.backgroundImage}`);
    return img;
  };

  it('buildItemIconElement draws the composite: Armor backdrop, black-tint outline, one 32-px image', () => {
    const el = ui.buildItemIconElement(0x06000100, 32, undefined, undefined, { itemType: 0x2 });
    expect(el.dataset.acRenderedIcon).toBe('1');
    expect(el.children.length).toBe(0);
    const img = imgOf(el);
    expect(px(img, 0, 0)).toEqual(ARMOR_BG);
    expect(px(img, 1, 0)).toEqual(FX); // white outline → the 0x21 Default tint
    expect(px(img, 2, 0)).toEqual(RED);
  });

  it('UiEffects Magical picks the effect row 1 tint; the drag surface has no backdrop', () => {
    const magic = imgOf(ui.buildItemIconElement(0x06000100, 32, undefined, undefined, { itemType: 0x2, effects: 0x1 }));
    expect(px(magic, 1, 0)).toEqual([0, 0, 255, 255]);
    const drag = imgOf(ui.buildItemIconElement(0x06000100, 32, undefined, undefined, { itemType: 0x2, drag: true }));
    expect(px(drag, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(px(drag, 1, 0)).toEqual(FX);
  });

  it('the main pack (IsThePlayer) draws PlayerIcon on the Container backdrop', () => {
    const img = imgOf(ui.buildItemIconElement(0x06001036, 32, undefined, undefined, { isThePlayer: true }));
    expect(px(img, 0, 0)).toEqual([90, 60, 30, 255]);
  });

  it('a missing icon still returns null (callers keep their letter fallback)', () => {
    expect(ui.buildItemIconElement(0x06000999, 32, undefined, undefined, { itemType: 0x2 })).toBeNull();
  });

  // Armor first in the filter menu (VendorItemsUI::OpenVendor order); the
  // Leather Basinet is the first Armor profile, the sword is a Weapon.
  const MERCH = [
    { guid: 0x83000011, weenieClassId: 300, name: 'Iron Sword', price: 400, burden: 200, itemType: 0x1, stackSize: -1, iconDid: 0x06000100 },
    { guid: 0x83000012, weenieClassId: 551, name: 'Leather Basinet', price: 1620, burden: 150, itemType: 0x2, stackSize: -1, iconDid: 0x06000100 },
    { guid: 0x83000013, weenieClassId: 552, name: 'Leather Boots', price: 900, burden: 150, itemType: 0x2, stackSize: -1, iconDid: 0x06000100 },
  ];
  let vendorGuid = 0x70180001;
  const open = () => ui.showVendorWindow('Shopkeeper', MERCH, [], '1.25', '0.75', undefined, undefined, vendorGuid++);
  const cells = (): HTMLElement[] => {
    const listEl = ui.vendorLayoutHandle.elements.get(VEL.itemsList) as HTMLElement;
    return [...listEl.querySelectorAll('[data-item-cell]')] as HTMLElement[];
  };

  it('CORE.18.d — the bar opens with the filter\'s first object selected: name, cost line, Buy lit, toolbar selection', () => {
    texts.clear(); states.clear(); selected.length = 0;
    open();
    expect(texts.get(VEL.filterText)).toBe('Armor');
    expect(ui.hud.target?.id).toBe(0x83000012);
    expect(texts.get(VEL.itemsName)).toBe('Leather Basinet');
    expect(texts.get(VEL.itemsCost)).toMatch(/^costs 1,620p \(you have \d[\d,]*p\)$/);
    expect(states.get(VEL.itemsBuy)).toBeUndefined(); // not the 0xd disabled art
    expect(selected).toEqual([0x83000012]);
    expect(ui.hud.target?.id).toBe(0x83000012);
  });

  it('CORE.18.c.a — every merchandise cell is the composite over its type backdrop', () => {
    open();
    const cs = cells();
    expect(cs.length).toBe(2); // the Armor filter's two profiles
    for (const cell of cs) {
      const icon = cell.querySelector('[data-ac-rendered-icon]') as HTMLElement;
      expect(icon).not.toBeNull();
      expect(px(imgOf(icon), 0, 0)).toEqual(ARMOR_BG);
    }
  });

  it('CORE.18.d — a filter pick selects that filter\'s first object (message 7 → UpdateItemsList(0, true))', () => {
    open();
    selected.length = 0;
    ui.vendorLayoutHandle.elements.get(VEL.filterMenu).click();
    const wrapper = ui.vendorWrapper as HTMLElement;
    const popup = [...wrapper.children].find((c) => (c as HTMLElement).style.bottom === '91px') as HTMLElement;
    const weaponsRow = [...popup.children].find((r) => r.textContent?.includes('Weapons') || (r as HTMLElement).innerHTML.includes('Weapons')) as HTMLElement
      ?? popup.children[1] as HTMLElement;
    weaponsRow.click();
    expect(ui.hud.target?.id).toBe(0x83000011);
    expect(selected).toEqual([0x83000011]);
    expect(texts.get(VEL.itemsName)).toBe('Iron Sword');
  });

  it('VendorItemsUI::UpdateItemsUI @ 004c38e0 — a selection made elsewhere blanks the name / cost and greys Buy', () => {
    open();
    expect(states.get(VEL.itemsBuy)).toBeUndefined();
    texts.clear(); states.clear();
    // A pack item (not merchandise) becomes the global selection; the next HUD update redraws the bar.
    ui.hud.setTarget({ id: 0x8000beef, name: 'Apple', level: 0, healthFraction: 0, distance: 0, type: 'item' });
    ui.renderVendorPanel();
    expect(texts.get(VEL.itemsName)).toBeUndefined();
    expect(states.get(VEL.itemsBuy)).toBe(0xd);
    expect(states.get(VEL.itemsAdd)).toBe(0xd);
  });
});

// ─── the real EoL portal tables ───────────────────────────────────────

const PORTAL = resolve(__dirname, '../dat/client_portal.dat');

describe.skipIf(!existsSync(PORTAL))('CORE.18.c.a — RenderIcons against the EoL portal.dat', () => {
  let maps: IconEnumMaps;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tex: (id: number) => IconRgba | null;

  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { Texture } = await import('../packages/dat-parser/src/file-types/Texture.js');
    const db = openDat(PORTAL);
    maps = loadIconEnumMaps(db, db.masterMapId)!;
    tex = (id: number) => {
      if (!id) return null;
      const d = db.getFileData(id);
      return d ? Texture.read(new DatReader(d)).toRGBA() : null;
    };
  });

  it('the master map names UIIconBackgrounds / UIEffectIcons / UIASSET; the rows RenderIcons reads', () => {
    expect(maps).not.toBeNull();
    expect(maps.backgrounds.get(2)).toBe(0x060011cf); // Armor
    expect(maps.backgrounds.get(10)).toBe(0x060011ce); // Container
    expect(maps.backgrounds.get(0x21)).toBe(0x060011d4); // Default
    expect(maps.effects.get(1)).toBe(0x060011ca); // MAGICAL
    expect(maps.effects.get(0x21)).toBe(0x060011c5); // Default
    expect(maps.effects.get(0)).toBe(0); // UNDEF → DBObj::Get null → the 0x21 fallback
    expect(maps.playerIconDid).toBe(0x0600127e); // UIASSET PlayerIcon
  });

  it('Leather Basinet (0x06001351, Armor): blue Armor backdrop in the corners, no white left, outline = Default tint', () => {
    const d = resolveRenderIconsDids({ iconDid: 0x06001351, itemType: 0x2 }, maps);
    const icon = tex(d.iconDid)!;
    const bg = tex(d.backgroundDid)!;
    const fx = tex(d.effectsDid)!;
    const out = renderIcons({ icon, overlay: null, underlay: null, background: bg, effects: fx });
    // Corner (clear in the icon) = the Armor backdrop pixel.
    expect(px(out.icon, 0, 0)).toEqual(px(bg, 0, 0));
    let whites = 0;
    let recoloured = 0;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const src = px(icon, x, y);
        if (src.every((c) => c === 255)) {
          whites++;
          expect(px(out.icon, x, y)).toEqual(px(fx, x, y));
          recoloured++;
        }
        const o = px(out.icon, x, y);
        expect(o[3]).toBe(255); // the backdrop's opacity
      }
    }
    expect(whites).toBeGreaterThan(0); // the icon's white outline exists …
    expect(recoloured).toBe(whites); // … and every pixel of it took the tint
  });

  it('the player\'s pack: PlayerIcon over the Container backdrop', () => {
    const d = resolveRenderIconsDids({ iconDid: 0x06001036, isThePlayer: true }, maps);
    expect(d.iconDid).toBe(0x0600127e);
    expect(d.backgroundDid).toBe(0x060011ce);
  });
});
