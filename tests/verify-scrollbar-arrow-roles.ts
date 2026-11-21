/**
 * BUG.scrollbar-arrows-reversed (webac#33): every vertical DAT scrollbar drew
 * its arrows pointing the wrong way — the top button's gold gem sat under a
 * V, the bottom one under a peak.
 *
 * Root cause: HUD_SCROLLBAR_SKIN followed the HUD widget's child rects.
 * 0x2100003e:0x10000367 authors 0x10000071 (0x06004c69, the V) at y 0 and
 * 0x10000072 (0x06004c6c, the peak) at y 32, but UIElement_Scrollbar places
 * its buttons by ROLE: p119 (attr 0x77 → UpdateButtonID_ @ 00470680,
 * m_eIncrementButtonID) goes to (0, 0) and p120 to the far corner
 * (UpdateScrollingArea @ 00470aa0). p119 there is 0x10000072, so the peak is
 * the top button — as retail's character-panel skills bar shows
 * (reference/images/hud/character-panel-skills.jpg). The chargen bar
 * 0x2100004c:0x100002dc is authored the same reversed way and was already
 * drawn by role; the horizontal bars and the spell bar's arrow pair are
 * authored role-correct.
 *
 * Every era draws this art: AC1999 worlds use the end-of-retail interface
 * set, and the Dark Majesty portal's arrow textures are byte-identical to
 * end of retail's (pinned below).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import {
  parseLayoutDesc, parseMasterProperty, resolveLayoutDesc, setMasterPropertyTypes,
  type ElementDesc, type LayoutDescData,
} from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { scrollbarArrowArt, type ScrollbarDescLike } from '../packages/renderer/src/ui/ScrollbarButtons.js';
import { HUD_SCROLLBAR_SKIN, CHARGEN_SCROLLBAR_SKIN } from '../packages/renderer/src/ui/DatFrame.js';
import { openDat, DAT_PATHS, DAT_SETS_DIR } from './_harness/dat.js';

type Child = ScrollbarDescLike['children'] extends ReadonlyMap<number, infer C> ? C : never;

function button(elementId: number, y: number, normal: number, hover?: number, pressed?: number): Child & { y: number } {
  const st = (f?: number) => ({ media: f === undefined ? [] : [{ file: f }] });
  const states = new Map<number, { media: Array<{ file?: number }> }>([[1, st(normal)]]);
  if (hover !== undefined) states.set(2, st(hover));
  if (pressed !== undefined) states.set(3, st(pressed));
  return { elementId, y, properties: new Map(), children: new Map(), states };
}

function bar(p119: number | undefined, p120: number | undefined, kids: Child[]): ScrollbarDescLike {
  const properties = new Map<number, { valueEnum?: number }>();
  if (p119 !== undefined) properties.set(119, { valueEnum: p119 });
  if (p120 !== undefined) properties.set(120, { valueEnum: p120 });
  return { properties, children: new Map(kids.map((k, i) => [i, k])) };
}

describe('scrollbarArrowArt — the arrow art goes by p119 / p120 role, not by the child rects', () => {
  it('p119 is the start (top) button even when its rect sits at the bottom', () => {
    const art = scrollbarArrowArt(bar(0xb, 0xa, [
      button(0xa, 0, 0x06000001, 0x06000002, 0x06000003),
      button(0xb, 32, 0x06000004, 0x06000005, 0x06000006),
    ]));
    expect(art).toEqual({ start: [0x06000004, 0x06000005, 0x06000006], end: [0x06000001, 0x06000002, 0x06000003], startId: 0xb, endId: 0xa });
  });

  it('a button with one state uses its normal art for hover and pressed', () => {
    const art = scrollbarArrowArt(bar(0xa, 0xb, [button(0xa, 0, 0x06000010), button(0xb, 83, 0x06000011)]));
    expect(art!.start).toEqual([0x06000010, 0x06000010, 0x06000010]);
    expect(art!.end).toEqual([0x06000011, 0x06000011, 0x06000011]);
  });

  it('only texture media count (a sound on the state is skipped)', () => {
    const b = button(0xa, 0, 0x06000020);
    (b.states as Map<number, { media: Array<{ file?: number }> }>).set(1, { media: [{ file: 0x0a000001 }, { file: 0x06000020 }] });
    expect(scrollbarArrowArt(bar(0xa, 0xb, [b, button(0xb, 9, 0x06000021)]))!.start[0]).toBe(0x06000020);
  });

  it('null when a role is missing or names no child', () => {
    expect(scrollbarArrowArt(bar(undefined, 0xb, [button(0xb, 0, 0x06000001)]))).toBeNull();
    expect(scrollbarArrowArt(bar(0xa, 0xb, [button(0xb, 0, 0x06000001)]))).toBeNull();
  });
});

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);

describe.skipIf(!hasDats)('webac#33 — the end-of-retail interface DAT: each skin is the DAT scrollbar by role', () => {
  let resolved: (id: number) => LayoutDescData;

  beforeAll(() => {
    const portal = openDat(DAT_PATHS.portal);
    const lang = openDat(DAT_PATHS.local);
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
  });

  const find = (m: Map<number, ElementDesc>, id: number): ElementDesc | undefined => {
    for (const e of m.values()) {
      if (e.elementId === id) return e;
      const hit = find(e.children, id);
      if (hit) return hit;
    }
    return undefined;
  };
  const artOf = (layout: number, el: number) => scrollbarArrowArt(find(resolved(layout).elements, el)!)!;
  const childY = (layout: number, el: number, child: number) => find(find(resolved(layout).elements, el)!.children, child)!.y;

  it('HUD widget 0x2100003e:0x10000367: the top button is p119 0x10000072 (0x06004c6c), though its rect is the bottom one', () => {
    const art = artOf(0x2100003e, 0x10000367);
    expect(art.startId).toBe(0x10000072);
    expect(childY(0x2100003e, 0x10000367, 0x10000072)).toBe(32); // the reversed authoring
    expect(art.start).toEqual([0x06004c6c, 0x06004c6d, 0x06004c6e]);
    expect(art.end).toEqual([0x06004c69, 0x06004c6a, 0x06004c6b]);
    expect(HUD_SCROLLBAR_SKIN.up).toEqual(art.start);
    expect(HUD_SCROLLBAR_SKIN.down).toEqual(art.end);
  });

  it('its twin 0x10000455 and the chat column 0x2100006f:0x10000012 that inherits it resolve the same way', () => {
    expect(artOf(0x2100003e, 0x10000455).start).toEqual(HUD_SCROLLBAR_SKIN.up);
    const chat = artOf(0x2100006f, 0x10000012);
    expect(chat.start).toEqual(HUD_SCROLLBAR_SKIN.up);
    expect(chat.end).toEqual(HUD_SCROLLBAR_SKIN.down);
  });

  it('chargen 0x2100004c:0x100002dc: p119 0x10000071 (0x06004d35, the up arrow) on top, already drawn by role', () => {
    const art = artOf(0x2100004c, 0x100002dc);
    expect(art.startId).toBe(0x10000071);
    expect(childY(0x2100004c, 0x100002dc, 0x10000071)).toBe(83);
    expect(CHARGEN_SCROLLBAR_SKIN.up).toEqual(art.start);
    expect(CHARGEN_SCROLLBAR_SKIN.down).toEqual(art.end);
  });

  it('the horizontal bars and the spell bar arrow pair are authored role-correct (start button at x 0), so their static rects stand', () => {
    for (const [layout, el, startArt] of [
      [0x2100003e, 0x1000036d, 0x06004c8c],
      [0x2100003e, 0x10000368, 0x06004c7c],
      [0x21000008, 0x10000070, 0x06004cde],
    ] as const) {
      const art = artOf(layout, el);
      expect(art.start[0]).toBe(startArt);
      const desc = find(resolved(layout).elements, el)!;
      expect(find(desc.children, art.startId)!.x).toBe(0);
    }
  });
});

const CLASSIC_PORTAL = `${DAT_SETS_DIR}/classic-dereth-1.1/client_portal.dat`;

describe.skipIf(!hasDats || !existsSync(CLASSIC_PORTAL))('webac#33 — Dark Majesty draws the same arrow art', () => {
  it('the classic portal\'s 0x06004c69-6e are byte-identical to end of retail\'s', () => {
    const eol = openDat(DAT_PATHS.portal);
    const classic = openDat(CLASSIC_PORTAL);
    for (const id of [...HUD_SCROLLBAR_SKIN.up, ...HUD_SCROLLBAR_SKIN.down]) {
      const a = new Uint8Array(eol.getFileData(id)!);
      const b = new Uint8Array(classic.getFileData(id)!);
      expect(Buffer.compare(Buffer.from(a), Buffer.from(b)), `0x${id.toString(16)}`).toBe(0);
    }
  });
});
