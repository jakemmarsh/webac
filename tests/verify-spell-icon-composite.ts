/**
 * VISUAL.spell-icon-composite — ClientMagicSystem::GetSpellIcon @ 00568bf0
 * builds every spell icon through CompositeSpellIcon @ 00567550 (decomp
 * :349505): the power-level backdrop (master enum 0x10000006 → 0x2500000a,
 * row DeterminePowerLevelOfComponent(_comps[0]) @ 005bd240), the icon
 * (Blit_4Alpha), opaque white → the 0x10000007 (0x2500000b) row
 * 2 - (bitfield & 0x10 ? 1 : 0), then the badge row 4 (bitfield & 0x2000) or
 * 3 (bitfield & 0x8).
 *
 * Suites: the compositor + DID resolution on synthetic data (always), GameUI
 * through happy-dom with synthetic DidMappers + spell table (always), and the
 * real EoL portal tables + spells (DAT only, loaded in beforeAll).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import {
  compositeSpellIcon, determinePowerLevelOfComponent, loadSpellIconEnumMaps, resolveSpellIconDids,
  type SpellIconEnumMaps,
} from '../packages/renderer/src/ui/SpellIconComposite.js';
import type { IconRgba } from '../packages/renderer/src/ui/ItemIconComposite.js';
import { openDat } from './_harness/dat.js';

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

const LEVEL_BG: Px = [40, 0, 80, 255];
const WHITE: Px = [255, 255, 255, 255];
const RED: Px = [255, 0, 0, 255];
const TINT: Px = [200, 150, 0, 255];
const BADGE: Px = [255, 128, 0, 255];

/** A 32x32 icon: clear, a red (1,1), an opaque-white (2,2) outline pixel. */
function testIcon(): IconRgba {
  const img = blank();
  setPx(img, 1, 1, RED);
  setPx(img, 2, 2, WHITE);
  return img;
}
/** A badge: only the top-right corner pixel is set. */
function testBadge(): IconRgba {
  const img = blank();
  setPx(img, 31, 0, BADGE);
  return img;
}

describe('VISUAL.spell-icon-composite — CompositeSpellIcon (synthetic)', () => {
  it('DeterminePowerLevelOfComponent: scarabs 1..6, 0x6e 7, 0x70 8, 0xc0 9, 0xc1 10, else 0', () => {
    expect([1, 2, 3, 4, 5, 6].map(determinePowerLevelOfComponent)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(determinePowerLevelOfComponent(0x6e)).toBe(7);
    expect(determinePowerLevelOfComponent(0x70)).toBe(8);
    expect(determinePowerLevelOfComponent(0xc0)).toBe(9);
    expect(determinePowerLevelOfComponent(0xc1)).toBe(10);
    expect(determinePowerLevelOfComponent(0)).toBe(0);
    expect(determinePowerLevelOfComponent(7)).toBe(0);
  });

  const maps: SpellIconEnumMaps = {
    levelBackgrounds: new Map([[1, 0x06000a01], [8, 0x06000a08]]),
    effects: new Map([[1, 0x06000f01], [2, 0x06000f02], [3, 0x06000f03], [4, 0x06000f04]]),
  };

  it('resolves backdrop by the first component, tint by Reversed, badge Fellowship over Self', () => {
    expect(resolveSpellIconDids({ iconDid: 0x06001234, powerComponent: 1, bitfield: 0 }, maps)).toEqual({
      backgroundDid: 0x06000a01, iconDid: 0x06001234, tintDid: 0x06000f02, badgeDid: 0,
    });
    const rev = resolveSpellIconDids({ iconDid: 1, powerComponent: 0x70, bitfield: 0x10 | 0x8 }, maps);
    expect(rev.backgroundDid).toBe(0x06000a08);
    expect(rev.tintDid).toBe(0x06000f01);
    expect(rev.badgeDid).toBe(0x06000f03);
    const fellow = resolveSpellIconDids({ iconDid: 1, powerComponent: 1, bitfield: 0x2000 | 0x8 }, maps);
    expect(fellow.badgeDid).toBe(0x06000f04);
    // Unknown component → level 0 → no backdrop row.
    expect(resolveSpellIconDids({ iconDid: 1, powerComponent: 99, bitfield: 0 }, maps).backgroundDid).toBe(0);
  });

  it('composites backdrop → icon → white-replace → badge', () => {
    const out = compositeSpellIcon({ background: solid(LEVEL_BG), icon: testIcon(), tint: solid(TINT), badge: testBadge() });
    expect(px(out, 0, 0)).toEqual(LEVEL_BG); // clear icon pixel shows the backdrop
    expect(px(out, 1, 1)).toEqual(RED); // icon colour drawn over it
    expect(px(out, 2, 2)).toEqual(TINT); // opaque white took the tint
    expect(px(out, 31, 0)).toEqual(BADGE); // the badge drawn last, over the tint
    expect(px(out, 30, 0)).toEqual(LEVEL_BG);
  });

  it('the badge is drawn after the white-replace (its own white survives)', () => {
    const badge = blank();
    setPx(badge, 5, 5, WHITE);
    const out = compositeSpellIcon({ background: solid(LEVEL_BG), icon: blank(), tint: solid(TINT), badge });
    expect(px(out, 5, 5)).toEqual(WHITE);
  });

  it('missing layers are skipped', () => {
    const out = compositeSpellIcon({ background: null, icon: testIcon(), tint: null, badge: null });
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(px(out, 1, 1)).toEqual(RED);
    expect(px(out, 2, 2)).toEqual(WHITE);
  });
});

// ─── GameUI through happy-dom ─────────────────────────────────────────

function didMapperBytes(id: number, rows: Array<[number, number]>): ArrayBuffer {
  const out: number[] = [];
  const u32 = (v: number) => out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  u32(id);
  out.push(1, rows.length);
  for (const [k, v] of rows) { u32(k); u32(v); }
  out.push(1, 0);
  out.push(0, 0, 0, 0);
  return new Uint8Array(out).buffer;
}

const MASTER = 0x25000000;
const FILES = new Map<number, ArrayBuffer>([
  [MASTER, didMapperBytes(MASTER, [[0x10000006, 0x2500000a], [0x10000007, 0x2500000b]])],
  [0x2500000a, didMapperBytes(0x2500000a, [[1, 0x06000a01]])],
  [0x2500000b, didMapperBytes(0x2500000b, [[1, 0x06000f01], [2, 0x06000f02], [3, 0x06000f03]])],
]);
const PIXELS = new Map<number, () => IconRgba>([
  [0x06001234, testIcon],
  [0x06000a01, () => solid(LEVEL_BG)],
  [0x06000f01, () => solid([0, 0, 255, 255])],
  [0x06000f02, () => solid(TINT)],
  [0x06000f03, testBadge],
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('VISUAL.spell-icon-composite — GameUI.getSpellIconURL (happy-dom, synthetic DAT)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const rendered = new Map<string, IconRgba>();
  let iconCalls = 0;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const proto = domWindow.HTMLCanvasElement.prototype;
    proto.getContext = function (this: { __img?: IconRgba }) {
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
    ui.textureManager = {
      getIconRGBA: (id: number) => { iconCalls++; return PIXELS.get(id)?.() ?? null; },
      getIconDataURL: (id: number) => `bare:${id.toString(16)}`,
      getJPEGDataURL: () => null,
    };
    ui.spellTable = {
      spells: new Map([
        [2, { icon: 0x06001234, formula: [1, 0, 0, 0, 0, 0, 0, 0], bitfield: 0x8 }],
        [3, { icon: 0x06001234, formula: [1, 0, 0, 0, 0, 0, 0, 0], bitfield: 0x10 }],
      ]),
    };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('a self spell: the level backdrop, the NonReversed tint on white, the TargetSelf badge', () => {
    const url = ui.getSpellIconURL(2, 0x06001234);
    const img = rendered.get(url)!;
    expect(img).toBeDefined();
    expect(px(img, 0, 0)).toEqual(LEVEL_BG);
    expect(px(img, 1, 1)).toEqual(RED);
    expect(px(img, 2, 2)).toEqual(TINT);
    expect(px(img, 31, 0)).toEqual(BADGE);
  });

  it('a Reversed spell takes the Reversed tint and no badge', () => {
    const img = rendered.get(ui.getSpellIconURL(3))!;
    expect(px(img, 2, 2)).toEqual([0, 0, 255, 255]);
    expect(px(img, 31, 0)).toEqual(LEVEL_BG);
  });

  it('GetSpellIcon caches the composite (m_hashSpellIconTable)', () => {
    const before = iconCalls;
    const a = ui.getSpellIconURL(2);
    const b = ui.getSpellIconURL(2);
    expect(a).toBe(b);
    expect(iconCalls).toBe(before);
  });

  it('a spell missing from the table falls back to the bare icon DID', () => {
    expect(ui.getSpellIconURL(999, 0x06005555)).toBe('bare:6005555');
    expect(ui.getSpellIconURL(999, 0)).toBeNull();
  });
});

// ─── the real EoL portal tables ───────────────────────────────────────

const PORTAL = resolve(__dirname, '../dat/client_portal.dat');

describe.skipIf(!existsSync(PORTAL))('VISUAL.spell-icon-composite — the EoL portal.dat', () => {
  let maps: SpellIconEnumMaps;
  let tex: (id: number) => IconRgba | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let byName: (name: string) => any;

  beforeAll(async () => {
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { Texture } = await import('../packages/dat-parser/src/file-types/Texture.js');
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const db = openDat(PORTAL);
    maps = loadSpellIconEnumMaps(db, db.masterMapId)!;
    tex = (id: number) => {
      if (!id) return null;
      const d = db.getFileData(id);
      return d ? Texture.read(new DatReader(d)).toRGBA() : null;
    };
    const table = new SpellTable(new DatReader(db.getFileData(0x0e00000e)!));
    byName = (name: string) => [...table.spells.values()].find((s) => s.name === name);
  });

  it('master enums 0x10000006 / 0x10000007 name the scarab backdrops and the icon effects', () => {
    expect(maps).not.toBeNull();
    expect(maps.levelBackgrounds.get(1)).toBe(0x060013f4); // LeadScarab
    expect(maps.levelBackgrounds.get(6)).toBe(0x060013f9); // PyrealScarab
    expect(maps.levelBackgrounds.get(8)).toBe(0x06001f63); // PlatinumScarab
    expect(maps.levelBackgrounds.get(10)).toBe(0x060067a6); // ManaScarab
    expect(maps.effects.get(1)).toBe(0x06004c3e); // Reversed
    expect(maps.effects.get(2)).toBe(0x06004c3f); // NonReversed
    expect(maps.effects.get(3)).toBe(0x060013f3); // TargetSelf
    expect(maps.effects.get(4)).toBe(0x060030d7); // TargetFellowship
  });

  it('Strength Self I: Lead backdrop, NonReversed tint, TargetSelf badge', () => {
    const s = byName('Strength Self I');
    const d = resolveSpellIconDids({ iconDid: s.icon, powerComponent: s.formula[0], bitfield: s.bitfield }, maps);
    expect(d).toEqual({ backgroundDid: 0x060013f4, iconDid: 0x0600138c, tintDid: 0x06004c3f, badgeDid: 0x060013f3 });
  });

  it("Adja's Blessing (0x70) → Platinum backdrop; Weakness Other I → Reversed tint, no badge", () => {
    const adja = byName("Adja's Blessing");
    expect(resolveSpellIconDids({ iconDid: adja.icon, powerComponent: adja.formula[0], bitfield: adja.bitfield }, maps).backgroundDid)
      .toBe(0x06001f63);
    const weak = byName('Weakness Other I');
    const d = resolveSpellIconDids({ iconDid: weak.icon, powerComponent: weak.formula[0], bitfield: weak.bitfield }, maps);
    expect(d.tintDid).toBe(0x06004c3e);
    expect(d.badgeDid).toBe(0);
  });

  it('the composite of Strength Self I: the orb shows through, white outline recoloured, badge pixels present', () => {
    const s = byName('Strength Self I');
    const d = resolveSpellIconDids({ iconDid: s.icon, powerComponent: s.formula[0], bitfield: s.bitfield }, maps);
    const icon = tex(d.iconDid)!;
    const bg = tex(d.backgroundDid)!;
    const tint = tex(d.tintDid)!;
    const badge = tex(d.badgeDid)!;
    const out = compositeSpellIcon({ background: bg, icon, tint, badge });
    let whites = 0;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        // The scarab orb is opaque except its clear corners.
        if (px(bg, x, y)[3] === 255) expect(px(out, x, y)[3]).toBe(255);
        const b = px(badge, x, y);
        if (px(icon, x, y).every((c) => c === 255) && b[3] === 0) {
          whites++;
          expect(px(out, x, y)).toEqual(px(tint, x, y));
        }
        if (b[3] === 255) expect(px(out, x, y)).toEqual(b);
      }
    }
    expect(whites).toBeGreaterThan(0);
    // A corner clear in the icon and the badge shows the Lead backdrop.
    expect(px(out, 0, S - 1)).toEqual(px(bg, 0, S - 1));
  });
});
