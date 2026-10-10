/**
 * CORE.17.k.b.b.a — the p33/p34 OUTLINE (and the p26 font / p27 colour that
 * come with it) on the pre-world labels GameUI draws itself: the char-select
 * buttons (0x21000004) and the chargen pages (0x21000038 bar, 0x21000046–4a).
 *
 * Ground truth (docs/retail-client-symbols.md, CORE.17.k.b.a / .k.b.b):
 *  - UIElement_Text::OnSetAttribute @ 0046a640: 0x1a font list, 0x1b colour
 *    table, 0x14/0x15 justification, 0x21 SetOutline, 0x22 m_curOutlineColor.
 *  - UIElement_Button::OnSetAttribute @ 00471f40 chains to the text class
 *    first — the char-select / chargen buttons outline like text elements.
 *  - The retail Wine char-select frame (docs/images/retail-client-wine-
 *    charselect.png) samples the plate labels at #ffbb11 (DAT 0xffffb219),
 *    ENTER at #fff67b (0xfffff27f) and the world name at #ddbb55 (0xffd8af5b).
 *
 * Covers: the style resolution (pure), the DAT carriers (fonts, colours,
 * states, strings, geometry), and GameUI's rendering of the char-select and
 * chargen screens through a real LayoutRenderer in happy-dom (span fallback:
 * the eight-neighbour ring + data-ac-outline / data-ac-font / data-ac-desc).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import fs from 'node:fs';
import { resolve } from 'node:path';
import {
  textStyleFromProps, textStyleFromDesc, findElementByPath, descRef, parseDescRef, parseStateRef, cssFromArgb,
  DEFAULT_TEXT_FONT_DID, DEFAULT_TEXT_COLOR_ARGB, DEFAULT_TEXT_JUSTIFY,
  UI_STATE_DISABLED, UI_STATE_HOVER, UI_STATE_NORMAL, CHARGEN_ROW_STATE_SELECTED, CHARGEN_ROW_STATE_UNSELECTED,
} from '../packages/renderer/src/ui/DatTextStyle.js';
import { OUTLINE_NEIGHBOUR_OFFSETS } from '../packages/renderer/src/ui/ACFontRenderer.js';

const REPO = resolve(__dirname, '..');
const LANG_PATH = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_PATH = resolve(REPO, 'dat/client_portal.dat');
const hasDats = fs.existsSync(LANG_PATH) && fs.existsSync(PORTAL_PATH);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

const CHARSEL = 0x21000004;
const CHARGEN_MENU = 0x2100003a;
const CHARGEN_HERITAGE = 0x21000046;
const CHARGEN_PROFESSION = 0x21000047;
const CHARGEN_SKILLS = 0x21000048;
const CHARGEN_APPEARANCE = 0x21000049;
const CHARGEN_TOWN = 0x2100004a;

type Prop = { id: number; propertyType: number; valueBool?: boolean; valueColor?: number; valueInt?: number; valueDataFile?: number; valueArray?: Prop[] };
const props = (entries: Array<[number, Partial<Prop>]>): Map<number, Prop> =>
  new Map(entries.map(([id, p]) => [id, { id, propertyType: 0, ...p }]));
const fontList = (did: number): Partial<Prop> => ({ valueArray: [{ id: 0, propertyType: 0, valueDataFile: did }] });
const colorTable = (...argb: number[]): Partial<Prop> => ({ valueArray: argb.map((c) => ({ id: 0, propertyType: 0, valueColor: c })) });
const ringOf = (color: string): string => OUTLINE_NEIGHBOUR_OFFSETS.map(([ox, oy]) => `${ox}px ${oy}px 0 ${color}`).join(', ');

describe('CORE.17.k.b.b.a — DatTextStyle: p26 / p27 / p20 / p21 / p33 / p34 / p35–38 → drawing style', () => {
  it('nothing set → the UI font, white, near-edge justification, no outline, no margins', () => {
    expect(textStyleFromProps()).toEqual({
      // CORE.17.k.b.b.c.c — the colour table is the one-entry default (entry 0 = colorArgb).
      font: DEFAULT_TEXT_FONT_DID, colorArgb: DEFAULT_TEXT_COLOR_ARGB, colorTable: [DEFAULT_TEXT_COLOR_ARGB],
      hJustify: DEFAULT_TEXT_JUSTIFY, vJustify: DEFAULT_TEXT_JUSTIFY,
      outline: false, outlineColorArgb: 0xff000000, marginLeft: 0, marginRight: 0, marginTop: 0, marginBottom: 0,
    });
    expect(DEFAULT_TEXT_FONT_DID).toBe(0x40000000);
  });

  it('p26 and p27 are ARRAYS in the DAT — entry 0 is the font / the plain-text colour', () => {
    const s = textStyleFromProps(props([[26, fontList(0x4000000f)], [27, colorTable(0xffb1a177, 0xff00ff00)], [33, { valueBool: true }], [35, { valueInt: 64 }], [20, { valueInt: 2 }], [21, { valueInt: 1 }]]));
    expect(s.font).toBe(0x4000000f);
    expect(s.colorArgb).toBe(0xffb1a177);
    expect(s.outline).toBe(true);
    expect(s.outlineColorArgb).toBe(0xff000000);
    expect([s.hJustify, s.vJustify, s.marginLeft]).toEqual([2, 1, 64]);
    // A scalar colour / data-file is accepted too.
    expect(textStyleFromProps(props([[27, { valueColor: 0xff123456 }], [26, { valueDataFile: 0x40000001 }]]))).toMatchObject({ colorArgb: 0xff123456, font: 0x40000001 });
  });

  it('later sets override earlier ones per property (element desc, then the default state, then the state entered)', () => {
    const desc = {
      properties: props([[26, fontList(0x4000000b)], [27, colorTable(0xffffb219)], [33, { valueBool: true }]]),
      defaultState: 0,
      states: new Map([
        [UI_STATE_HOVER, { properties: props([[27, colorTable(0xffffd24c)]]) }],
        [UI_STATE_DISABLED, { properties: props([[27, colorTable(0xffa8966d)]]) }],
        [0x3, { properties: props([[26, fontList(0x4000000a)], [27, colorTable(0xfffff27f)]]) }],
      ]),
    };
    expect(textStyleFromDesc(desc)).toMatchObject({ font: 0x4000000b, colorArgb: 0xffffb219, outline: true });
    expect(textStyleFromDesc(desc, UI_STATE_NORMAL)).toMatchObject({ colorArgb: 0xffffb219 });
    expect(textStyleFromDesc(desc, UI_STATE_HOVER)).toMatchObject({ colorArgb: 0xffffd24c, outline: true });
    expect(textStyleFromDesc(desc, UI_STATE_DISABLED)).toMatchObject({ colorArgb: 0xffa8966d, font: 0x4000000b });
    expect(textStyleFromDesc(desc, 0x3)).toMatchObject({ font: 0x4000000a, colorArgb: 0xfffff27f });
    // The chargen radio-row shape: the colour lives only on the states.
    const row = {
      properties: props([[26, fontList(0x40000010)], [33, { valueBool: true }], [35, { valueInt: 60 }], [37, { valueInt: 7 }]]),
      defaultState: CHARGEN_ROW_STATE_UNSELECTED,
      states: new Map([
        [CHARGEN_ROW_STATE_UNSELECTED, { properties: props([[27, colorTable(0xffb1a177)]]) }],
        [CHARGEN_ROW_STATE_SELECTED, { properties: props([[27, colorTable(0xffffce6c)]]) }],
      ]),
    };
    expect(textStyleFromDesc(row)).toMatchObject({ colorArgb: 0xffb1a177, marginLeft: 60, marginTop: 7 });
    expect(textStyleFromDesc(row, CHARGEN_ROW_STATE_SELECTED)).toMatchObject({ colorArgb: 0xffffce6c, outline: true });
    // A state the desc does not define contributes nothing.
    expect(textStyleFromDesc(row, 0x99)).toMatchObject({ colorArgb: 0xffb1a177 });
  });

  it('descRef / parseDescRef / parseStateRef round-trip (hex, optional 0x, child paths)', () => {
    expect(descRef(0x21000004, 0x100003a2)).toBe('21000004:100003a2');
    expect(descRef(0x21000047, 0x100003e6, 0x100002ed)).toBe('21000047:100003e6/100002ed');
    expect(parseDescRef('21000004:100003a2')).toEqual({ layoutId: 0x21000004, path: [0x100003a2] });
    expect(parseDescRef('0x21000047:0x100003e6/0x100002ed')).toEqual({ layoutId: 0x21000047, path: [0x100003e6, 0x100002ed] });
    expect(parseDescRef('nonsense')).toBeNull();
    expect(parseDescRef('')).toBeNull();
    expect(parseStateRef('d')).toBe(0xd);
    expect(parseStateRef('0x10000017')).toBe(0x10000017);
    expect(parseStateRef(undefined)).toBeUndefined();
    expect(cssFromArgb(0xffffb219)).toBe('#ffb219');
  });

  it('findElementByPath: first match anywhere for the head, then direct children', () => {
    interface FakeEl { elementId: number; children: Map<number, FakeEl>; properties: Map<number, Prop>; states: Map<number, { properties: Map<number, Prop> }> }
    const mk = (elementId: number, children: FakeEl[] = []): FakeEl => ({ elementId, children: new Map(children.map((c) => [c.elementId, c])), properties: new Map(), states: new Map() });
    const shared = () => mk(0x100002ed);
    const rowA = mk(0x100003e6, [shared()]);
    const rowB = mk(0x100003e7, [shared()]);
    const layout = { id: 1, displayWidth: 800, displayHeight: 600, elements: new Map([[0x1, mk(0x1, [mk(0x2, [rowA, rowB])])]]) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const L = layout as any;
    expect(findElementByPath(L, [0x100003e7])).toBe(rowB);
    expect(findElementByPath(L, [0x100003e7, 0x100002ed])).toBe(rowB.children.get(0x100002ed));
    expect(findElementByPath(L, [0x100002ed])).toBe(rowA.children.get(0x100002ed));
    expect(findElementByPath(L, [0x100003e7, 0x1234])).toBeNull();
    expect(findElementByPath(L, [])).toBeNull();
    expect(findElementByPath(null, [0x1])).toBeNull();
  });
});

describe.skipIf(!hasDats)('CORE.17.k.b.b.a — DAT ground truth: the pre-world carriers', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dat: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let lang: any;
  const rawCache = new Map<number, unknown>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (id: number): any => {
    if (!rawCache.has(id)) {
      const data = lang.getFileData(id);
      rawCache.set(id, data ? dat.parseLayoutDesc(new dat.DatReader(data)) : null);
    }
    return rawCache.get(id);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolved = (id: number): any => dat.resolveLayoutDesc(raw(id), raw);
  const styleOf = (layoutId: number, path: number[], state?: number) => textStyleFromDesc(findElementByPath(resolved(layoutId), path)!, state);

  beforeAll(async () => {
    dat = await import('@ac/dat-parser');
    const portalBuf = fs.readFileSync(PORTAL_PATH);
    const portalDb = new dat.DatDatabase(portalBuf.buffer.slice(portalBuf.byteOffset, portalBuf.byteOffset + portalBuf.byteLength));
    dat.setMasterPropertyTypes(dat.parseMasterProperty(new dat.DatReader(portalDb.getFileData(0x39000001))));
    const langBuf = fs.readFileSync(LANG_PATH);
    lang = new dat.DatDatabase(langBuf.buffer.slice(langBuf.byteOffset, langBuf.byteOffset + langBuf.byteLength));
    dat.registerStringTable(dat.parseStringTable(new dat.DatReader(lang.getFileData(0x23000002))));
  });

  it('char select 0x21000004: the six buttons are outlined, in their own fonts and colours (the Wine frame: #ffbb11 plates, #fff67b ENTER)', () => {
    for (const [id, str] of [[0x1000039e, 'RESTORE'], [0x1000039f, 'DELETE'], [0x100003a3, 'CREDITS'], [0x100003a4, 'EXIT']] as Array<[number, string]>) {
      const el = findElementByPath(resolved(CHARSEL), [id])!;
      expect([el.baseLayout, el.baseElement], str).toEqual([0x21000040, 0x100002d1]);
      expect(dat.getString(el.properties.get(23)!.valueString!.stringId)).toBe(str);
      expect(styleOf(CHARSEL, [id])).toMatchObject({ font: 0x4000000b, colorArgb: 0xffffb219, outline: true, outlineColorArgb: 0xff000000, hJustify: 1, vJustify: 1 });
      expect(styleOf(CHARSEL, [id], UI_STATE_DISABLED)).toMatchObject({ font: 0x4000000b, colorArgb: 0xffa8966d, outline: true });
      expect(styleOf(CHARSEL, [id], UI_STATE_HOVER)).toMatchObject({ colorArgb: 0xffffd24c });
      expect(styleOf(CHARSEL, [id], 0x3)).toMatchObject({ font: 0x4000000a, colorArgb: 0xfffff27f });
    }
    expect(styleOf(CHARSEL, [0x100003a0])).toMatchObject({ font: 0x4000000c, colorArgb: 0xffffb219, outline: true });
    expect(styleOf(CHARSEL, [0x100003a0], UI_STATE_DISABLED)).toMatchObject({ colorArgb: 0xffa8966d });
    expect(styleOf(CHARSEL, [0x100003a2])).toMatchObject({ font: 0x40000012, colorArgb: 0xfffff27f, outline: true });
    expect(styleOf(CHARSEL, [0x100003a2], UI_STATE_DISABLED)).toMatchObject({ colorArgb: 0xff4c472d });
    expect(dat.getString(findElementByPath(resolved(CHARSEL), [0x100003a2])!.properties.get(23)!.valueString!.stringId)).toBe('ENTER');
    // The world box is not a p33 carrier but has its own font / colour.
    expect(styleOf(CHARSEL, [0x1000039b])).toMatchObject({ font: 0x4000000b, colorArgb: 0xffd8af5b, outline: false });
  });

  it('chargen menu bar 0x2100003a: Help / Exit / Random text buttons, FINISH in green, Back / Next are media', () => {
    for (const [id, str] of [[0x100003c9, 'Help'], [0x100003ca, 'Exit'], [0x100003cb, 'Random']] as Array<[number, string]>) {
      const el = findElementByPath(resolved(CHARGEN_MENU), [id])!;
      expect(dat.getString(el.properties.get(23)!.valueString!.stringId), str).toBe(str);
      expect(styleOf(CHARGEN_MENU, [id])).toMatchObject({ font: 0x4000000b, colorArgb: 0xfffff287, outline: true, hJustify: 1, vJustify: 1 });
      expect(styleOf(CHARGEN_MENU, [id], UI_STATE_HOVER)).toMatchObject({ colorArgb: 0xffff0000 });
      expect(styleOf(CHARGEN_MENU, [id], UI_STATE_DISABLED)).toMatchObject({ colorArgb: 0xffffffff });
    }
    const finish = findElementByPath(resolved(CHARGEN_MENU), [0x100003c8])!;
    expect(dat.getString(finish.properties.get(23)!.valueString!.stringId)).toBe('FINISH');
    expect(styleOf(CHARGEN_MENU, [0x100003c8])).toMatchObject({ font: 0x40000024, colorArgb: 0xff66ff00, outline: true });
    expect(styleOf(CHARGEN_MENU, [0x100003c8], UI_STATE_HOVER)).toMatchObject({ colorArgb: 0xffff0000 });
    const mediaOf = (id: number, state: number): number => findElementByPath(resolved(CHARGEN_MENU), [id])!.states.get(state)!.media[0].file!;
    expect([mediaOf(0x100003c6, 1), mediaOf(0x100003c6, 2), mediaOf(0x100003c6, 0xd)]).toEqual([0x06004c8f, 0x06004c90, 0x06004c91]);
    expect([mediaOf(0x100003c7, 1), mediaOf(0x100003c7, 2), mediaOf(0x100003c7, 0xd)]).toEqual([0x06004c92, 0x06004c93, 0x06005f13]);
    expect(findElementByPath(resolved(CHARGEN_MENU), [0x100003c6])!.properties.has(23)).toBe(false);
  });

  it('chargen heritage 0x21000046: 13 radio rows (template 0x2100004c:0x100002db) — font 0x4000000f, label 64 px in, tan / gold states, outlined', () => {
    const rows: Array<[number, string]> = [[0x100003bf, 'Aluvian'], [0x100003c1, "Gharu'ndim"], [0x100003c2, 'Sho'], [0x100003c3, 'Viamontian'], [0x10000590, 'Umbraen'], [0x10000591, 'Penumbraen'], [0x100005a9, 'Gear Knight'], [0x100005bf, 'Undead'], [0x100005c4, 'Empyrean'], [0x100005e8, 'Aun Tumerok'], [0x100005f1, 'Lugian'], [0x100005c7, 'Olthoi Soldier'], [0x100005c8, 'Olthoi Spitter']];
    for (const [id, str] of rows) {
      const el = findElementByPath(resolved(CHARGEN_HERITAGE), [id])!;
      expect([el.baseLayout, el.baseElement], str).toEqual([0x2100004c, 0x100002db]);
      expect([el.width, el.height]).toEqual([305, 32]);
      expect(dat.getString(el.properties.get(23)!.valueString!.stringId)).toBe(str);
      expect(styleOf(CHARGEN_HERITAGE, [id])).toMatchObject({ font: 0x4000000f, colorArgb: 0xffb1a177, outline: true, marginLeft: 64, hJustify: 2, vJustify: 1 });
      expect(styleOf(CHARGEN_HERITAGE, [id], CHARGEN_ROW_STATE_SELECTED)).toMatchObject({ colorArgb: 0xffffce6c, outline: true });
    }
    // The lore panel: font 0x40000008, colour table [white, green], outlined, margins 9/26/15/15.
    const lore = findElementByPath(resolved(CHARGEN_HERITAGE), [0x100003c4])!;
    expect(lore.properties.get(27)!.valueArray!.map((p: Prop) => p.valueColor)).toEqual([0xffffffff, 0xff00ff00]);
    expect(styleOf(CHARGEN_HERITAGE, [0x100003c4])).toMatchObject({ font: 0x40000008, colorArgb: 0xffffffff, outline: true, marginLeft: 9, marginRight: 26, marginTop: 15, marginBottom: 15 });
  });

  it('chargen profession 0x21000047: rows (0x100002e8), attribute rows (name 0x100002ed / slider 0x100002ee / value 0x100002ef), credits + vitals label/value pairs', () => {
    for (const [id, str, w] of [[0x100003d9, 'Custom', 155], [0x100003da, 'Bow Hunter', 220], [0x100003df, 'Swashbuckler', 220]] as Array<[number, string, number]>) {
      const el = findElementByPath(resolved(CHARGEN_PROFESSION), [id])!;
      expect([el.baseLayout, el.baseElement, el.width, el.height], str).toEqual([0x2100004c, 0x100002e8, w, 54]);
      expect(styleOf(CHARGEN_PROFESSION, [id])).toMatchObject({ font: 0x40000010, colorArgb: 0xffb1a177, outline: true, marginLeft: 60, marginTop: 7 });
      expect(styleOf(CHARGEN_PROFESSION, [id], CHARGEN_ROW_STATE_SELECTED)).toMatchObject({ colorArgb: 0xffffce6c });
    }
    const row = findElementByPath(resolved(CHARGEN_PROFESSION), [0x100003e6])!;
    const name = row.children.get(0x100002ed)!; const slider = row.children.get(0x100002ee)!; const value = row.children.get(0x100002ef)!;
    expect([name.x, name.y, name.width, name.height]).toEqual([33, 8, 115, 24]);
    expect([slider.x, slider.y, slider.width, slider.height]).toEqual([148, 0, 284, 39]);
    expect([value.x, value.y, value.width, value.height]).toEqual([440, 0, 40, 39]);
    expect(styleOf(CHARGEN_PROFESSION, [0x100003e6, 0x100002ed])).toMatchObject({ font: 0x4000000d, colorArgb: 0xffb1a177, outline: true, hJustify: 2 });
    expect(styleOf(CHARGEN_PROFESSION, [0x100003e6, 0x100002ef])).toMatchObject({ font: 0x4000000d, colorArgb: 0xffffffff, outline: false, hJustify: 3 });
    expect(slider.properties.has(123)).toBe(true); // the slider props live on 0x100002ee, not on the name
    const credits = findElementByPath(resolved(CHARGEN_PROFESSION), [0x100003e2])!;
    expect(dat.getString(credits.properties.get(23)!.valueString!.stringId)).toBe('Attribute\n Credits');
    expect(styleOf(CHARGEN_PROFESSION, [0x100003e2])).toMatchObject({ font: 0x4000000d, colorArgb: 0xffffce6c, outline: true });
    expect(styleOf(CHARGEN_PROFESSION, [0x100003e2, 0x100002f1])).toMatchObject({ font: 0x4000001b, colorArgb: 0xffffffff, outline: false, hJustify: 3 });
    for (const [id, str] of [[0x100003e3, 'Health'], [0x100003e4, 'Stamina'], [0x100003e5, 'Mana']] as Array<[number, string]>) {
      const el = findElementByPath(resolved(CHARGEN_PROFESSION), [id])!;
      expect(dat.getString(el.properties.get(23)!.valueString!.stringId), str).toBe(str);
      expect(styleOf(CHARGEN_PROFESSION, [id])).toMatchObject({ font: 0x4000000d, colorArgb: 0xffffce6c, outline: true, marginLeft: 2 });
      const val = el.children.get(0x100002f3)!;
      expect([val.x, val.width, val.height]).toEqual([116, 34, 28]);
      expect(styleOf(CHARGEN_PROFESSION, [id, 0x100002f3])).toMatchObject({ colorArgb: 0xffffffff, outline: false, hJustify: 3 });
    }
  });

  it('chargen skills 0x21000048 / appearance 0x21000049 / town 0x2100004a carriers', () => {
    expect(styleOf(CHARGEN_SKILLS, [0x100003f9])).toMatchObject({ font: 0x4000000d, colorArgb: 0xffffce6c, outline: true });
    expect(styleOf(CHARGEN_SKILLS, [0x100003f9, 0x100002f3])).toMatchObject({ colorArgb: 0xffffffff, outline: false, hJustify: 3 });
    expect(findElementByPath(resolved(CHARGEN_SKILLS), [0x100003f9, 0x100002f3])!.x).toBe(197);
    expect(styleOf(CHARGEN_SKILLS, [0x100003f5, 0x100003fc])).toMatchObject({ font: 0x40000009, colorArgb: 0xffffffff, outline: true, marginLeft: 4, marginTop: 5 });
    expect(styleOf(CHARGEN_SKILLS, [0x100003fd])).toMatchObject({ font: 0x40000009, colorArgb: 0xffffffff, outline: true, marginLeft: 9, marginRight: 26, marginTop: 15, marginBottom: 15 });
    expect(styleOf(CHARGEN_APPEARANCE, [0x100003a9])).toMatchObject({ font: 0x40000010, colorArgb: 0xffb1a177, outline: true, marginLeft: 60, marginTop: 7 });
    expect(styleOf(CHARGEN_APPEARANCE, [0x100003aa], CHARGEN_ROW_STATE_SELECTED)).toMatchObject({ colorArgb: 0xffffce6c });
    expect(styleOf(CHARGEN_APPEARANCE, [0x100003ab])).toMatchObject({ font: 0x40000009, colorArgb: 0xffffffff, outline: true });
    // Category rows: outlined only in state 0x6 (CORE.17.k.b.b.b) — the resting state 0x1 is tan, no outline.
    expect(styleOf(CHARGEN_APPEARANCE, [0x100003ad, 0x100003b4, 0x100003b5], UI_STATE_NORMAL)).toMatchObject({ font: 0x4000000c, colorArgb: 0xffdaa755, outline: false });
    expect(styleOf(CHARGEN_APPEARANCE, [0x100003ad, 0x100003b4, 0x100003b5], 0x6)).toMatchObject({ colorArgb: 0xffffdd83, outline: true });
    expect(styleOf(CHARGEN_APPEARANCE, [0x100003ad, 0x100003ae, 0x100003af], UI_STATE_NORMAL)).toMatchObject({ font: 0x4000000c, colorArgb: 0xffdaa755, outline: false });
    // Town: heading 0x10000408 (font 0x40000014, per-state town names), description 0x10000409 (no outline), pins + names.
    const heading = findElementByPath(resolved(CHARGEN_TOWN), [0x10000407, 0x10000408])!;
    expect([heading.x, heading.y, heading.width, heading.height]).toEqual([13, 75, 180, 60]);
    expect(styleOf(CHARGEN_TOWN, [0x10000407, 0x10000408])).toMatchObject({ font: 0x40000014, colorArgb: 0xffdaa755, outline: true, marginLeft: 7 });
    const headingNames = new Map([...heading.states.entries()].map(([sid, s]: [number, { properties: Map<number, Prop & { valueString?: { stringId: number } }> }]) => [sid, dat.getString(s.properties.get(23)!.valueString!.stringId)]));
    expect(Object.fromEntries(headingNames)).toEqual({ [0x10000034]: 'Holtburg', [0x10000035]: 'Sanamar', [0x10000036]: 'Yaraq', [0x10000037]: 'Shoushi' });
    expect(findElementByPath(resolved(CHARGEN_TOWN), [0x10000407])!.defaultState).toBe(0x10000034);
    expect(styleOf(CHARGEN_TOWN, [0x10000407, 0x10000409])).toMatchObject({ font: 0x40000009, colorArgb: 0xffffffff, outline: false, marginLeft: 9, marginRight: 26 });
    const map = findElementByPath(resolved(CHARGEN_TOWN), [0x1000040a])!;
    expect([map.x, map.y, map.width, map.height]).toEqual([288, 65, 481, 481]);
    const towns: Array<[number, string, number[], number[], number[]]> = [
      [0x1000040b, 'Sanamar', [41, 58, 93, 52], [30, 0], [0, 22, 91, 28]],
      [0x1000040d, 'Holtburg', [262, 89, 106, 80], [36, 36], [0, 4, 100, 37]],
      [0x1000040e, 'Yaraq', [200, 243, 90, 67], [37, 28], [5, 6, 75, 32]],
      [0x1000040f, 'Shoushi', [378, 306, 85, 68], [12, 4], [0, 30, 78, 28]],
    ];
    for (const [id, str, box, pin, label] of towns) {
      const c = map.children.get(id)!;
      expect([c.x, c.y, c.width, c.height], str).toEqual(box);
      const p = c.children.get(0x1000040c)!; const l = c.children.get(0x10000409)!;
      expect([p.x, p.y, p.width, p.height]).toEqual([...pin, 38, 38]);
      expect([l.x, l.y, l.width, l.height]).toEqual(label);
      expect(dat.getString(l.properties.get(23)!.valueString!.stringId)).toBe(str);
      expect(styleOf(CHARGEN_TOWN, [0x1000040a, id, 0x10000409])).toMatchObject({ font: 0x4000000f, outline: true, hJustify: 1, vJustify: 1 });
    }
  });
});

describe.skipIf(!hasDats)('CORE.17.k.b.b.a — GameUI draws the pre-world labels from their descs (happy-dom + real LayoutRenderer, span fallback)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let layoutRenderer: any;

  beforeAll(async () => {
    const g = globalThis as Record<string, unknown>;
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (g as any).requestAnimationFrame !== 'function') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (g as any).requestAnimationFrame = () => 0; (g as any).cancelAnimationFrame = () => {};
      domWindow.requestAnimationFrame = (g as { requestAnimationFrame: unknown }).requestAnimationFrame;
    }
    const dat = await import('@ac/dat-parser');
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    GameUICtor = mod.GameUI;
    const portalBuf = fs.readFileSync(PORTAL_PATH);
    const portalDb = new dat.DatDatabase(portalBuf.buffer.slice(portalBuf.byteOffset, portalBuf.byteOffset + portalBuf.byteLength));
    dat.setMasterPropertyTypes(dat.parseMasterProperty(new dat.DatReader(portalDb.getFileData(0x39000001)!)));
    const langBuf = fs.readFileSync(LANG_PATH);
    const langDb = new dat.DatDatabase(langBuf.buffer.slice(langBuf.byteOffset, langBuf.byteOffset + langBuf.byteLength));
    dat.registerStringTable(dat.parseStringTable(new dat.DatReader(langDb.getFileData(0x23000001)!)));
    dat.registerStringTable(dat.parseStringTable(new dat.DatReader(langDb.getFileData(0x23000002)!)));
    const uiTextureLoader = {
      getTextureDataURL: (id: number) => `data:tex-${id.toString(16)}`,
      getTextureDataURLWithAlpha: (id: number) => `data:tex-${id.toString(16)}`,
    } as unknown as import('../packages/renderer/src/ui/UITextureLoader.js').UITextureLoader;
    layoutRenderer = new LayoutRenderer(langDb, uiTextureLoader, null);
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function makeUI() {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container);
    ui.getTexURL = () => null;
    ui.layoutRenderer = layoutRenderer;
    return { ui, container };
  }
  const byDesc = (root: HTMLElement, ref: string): HTMLElement[] => Array.from(root.querySelectorAll(`[data-ac-desc="${ref}"]`)) as HTMLElement[];

  it('char select: DELETE / CREDITS / EXIT / Create Character / ENTER carry the outline, their DAT font and colour; disabled ones the 0xd colour', () => {
    const { ui, container } = makeUI();
    ui.showCharacterSelect([{ id: 1, name: 'Perf Tester' }]);
    // BUG.charsel-no-default-selection — RebuildCharacterList selects the
    // first playable character; clear it to exercise the disabled states.
    expect(ui.selectScreen.selectedCharacter?.name).toBe('Perf Tester');
    ui.selectScreen.clearSelection();
    ui.renderCharacterSelect();
    // No selection: ENTER + DELETE disabled, Create enabled.
    const del = byDesc(container, descRef(CHARSEL, 0x1000039f));
    expect(del.length).toBe(1);
    expect(del[0].textContent).toBe('DELETE');
    expect(del[0].dataset.acOutline).toBe('#000000');
    expect(del[0].style.textShadow).toBe(ringOf('#000000'));
    expect(del[0].dataset.acFont).toBe('4000000b');
    expect(del[0].dataset.acState).toBe('d');
    expect(del[0].style.color).toMatch(/^(#a8966d|rgb\(168,\s*150,\s*109\))$/);
    const enter = byDesc(container, descRef(CHARSEL, 0x100003a2))[0];
    expect(enter.textContent).toBe('ENTER');
    expect(enter.dataset.acFont).toBe('40000012');
    expect(enter.dataset.acOutline).toBe('#000000');
    expect(enter.style.color).toMatch(/^(#4c472d|rgb\(76,\s*71,\s*45\))$/);
    const create = byDesc(container, descRef(CHARSEL, 0x100003a0))[0];
    expect(create.textContent).toBe('Create Character');
    expect(create.dataset.acFont).toBe('4000000c');
    expect(create.dataset.acState).toBeUndefined();
    expect(create.style.color).toMatch(/^(#ffb219|rgb\(255,\s*178,\s*25\))$/);
    for (const [id, str] of [[0x100003a3, 'CREDITS'], [0x100003a4, 'EXIT']] as Array<[number, string]>) {
      const el = byDesc(container, descRef(CHARSEL, id))[0];
      expect(el.textContent, str).toBe(str);
      expect(el.dataset.acOutline).toBe('#000000');
      expect(el.style.color).toMatch(/^(#ffb219|rgb\(255,\s*178,\s*25\))$/);
    }
    // Selecting a character enables ENTER + DELETE (their normal colours).
    ui.selectScreen.selectCharacter(0);
    ui.renderCharacterSelect();
    const enter2 = byDesc(container, descRef(CHARSEL, 0x100003a2))[0];
    expect(enter2.dataset.acState).toBeUndefined();
    expect(enter2.style.color).toMatch(/^(#fff27f|rgb\(255,\s*242,\s*127\))$/);
    expect(byDesc(container, descRef(CHARSEL, 0x1000039f))[0].style.color).toMatch(/^(#ffb219|rgb\(255,\s*178,\s*25\))$/);
    // The world box label draws with 0x1000039b's font and colour (no outline).
    ui.setWorldName('acjs-dev');
    const world = byDesc(container, descRef(CHARSEL, 0x1000039b))[0];
    expect(world.textContent).toBe('acjs-dev');
    expect(world.dataset.acFont).toBe('4000000b');
    expect(world.dataset.acOutline).toBeUndefined();
    expect(world.style.color).toMatch(/^(#d8af5b|rgb\(216,\s*175,\s*91\))$/);
  });

  it('chargen heritage page: 13 outlined rows in font 0x4000000f, the selected one gold, labels 64 px in; the bar draws Help / Exit / Random outlined and the chevrons as media', () => {
    const { ui, container } = makeUI();
    ui.showCharacterCreate();
    const rows = Array.from(container.querySelectorAll('.heritage-btn')) as HTMLElement[];
    expect(rows.length).toBe(13);
    let gold = 0;
    for (const row of rows) {
      const label = row.querySelector('[data-ac-desc]') as HTMLElement;
      expect(label.dataset.acDesc!.startsWith('21000046:')).toBe(true);
      expect(label.dataset.acFont).toBe('4000000f');
      expect(label.dataset.acOutline).toBe('#000000');
      expect((label.parentElement as HTMLElement).style.left).toBe('64px');
      if (/^(#ffce6c|rgb\(255,\s*206,\s*108\))$/.test(label.style.color)) { gold++; expect(label.dataset.acState).toBe('10000017'); }
      else expect(label.style.color).toMatch(/^(#b1a177|rgb\(177,\s*161,\s*119\))$/);
    }
    expect(gold).toBe(1);
    const lore = byDesc(container, descRef(CHARGEN_HERITAGE, 0x100003c4));
    // VISUAL.chargen-heritage-lore-spacing — ONE text (gmCGHeritagePage::Update's
    // Set + AppendStringInfoWithFont), its runs in p27 entry 1 (green header) / 0 (white).
    expect(lore.length).toBe(1);
    expect(lore[0].dataset.acFont).toBe('40000008');
    expect(lore[0].dataset.acOutline).toBe('#000000');
    const runs = Array.from(lore[0].children) as HTMLElement[];
    expect(runs.length).toBeGreaterThanOrEqual(4);
    expect(runs[0].style.color).toMatch(/^(#00ff00|rgb\(0,\s*255,\s*0\))$/);
    expect(runs[1].style.color).toMatch(/^(#ffffff|rgb\(255,\s*255,\s*255\))$/);
    for (const [id, str] of [['btn-help', 'Help'], ['btn-cancel', 'Exit'], ['btn-random', 'Random']]) {
      const btn = container.querySelector(`#${id}`) as HTMLElement;
      const label = btn.firstElementChild as HTMLElement;
      expect(label.textContent, str).toBe(str);
      expect(label.dataset.acDesc!.startsWith('2100003a:')).toBe(true);
      expect(label.dataset.acFont).toBe('4000000b');
      expect(label.dataset.acOutline).toBe('#000000');
      expect(label.style.color).toMatch(/^(#fff287|rgb\(255,\s*242,\s*135\))$/);
      btn.dispatchEvent(new domWindow.MouseEvent('mouseenter'));
      expect((btn.firstElementChild as HTMLElement).style.color).toMatch(/^(#ff0000|rgb\(255,\s*0,\s*0\))$/);
      btn.dispatchEvent(new domWindow.MouseEvent('mouseleave'));
      expect((btn.firstElementChild as HTMLElement).style.color).toMatch(/^(#fff287|rgb\(255,\s*242,\s*135\))$/);
    }
    const back = container.querySelector('#btn-back') as HTMLElement;
    const next = container.querySelector('#btn-next') as HTMLElement;
    expect(back.textContent).toBe('');
    // CORE.17.k.b.b.c.c.b.a — the first page's Back is DoExit (the Exit
    // button's path), drawn with the normal chevron: nothing SetState(0xd)s
    // it in gmCharGenMainUI.
    expect(back.dataset.acMedia).toBe('6004c8f');
    expect(next.dataset.acMedia).toBe('6004c92');
    expect(container.querySelector('#btn-confirm')).toBeNull();
    // VISUAL.chargen-heritage-lore-spacing — the bar children sit at their DAT y
    // in the 0x100003cf placeholder (no +10: char-create-ref1's chevron top is
    // ≈553 = 540 + 13), and the layout's own copies of the chevron elements are
    // hidden so each chevron paints once.
    expect([back.style.top, next.style.top]).toEqual(['13px', '13px']);
    expect((container.querySelector('#btn-help') as HTMLElement).style.top).toBe('21px');
    for (const id of [0x100003c6, 0x100003c7]) expect(ui.chargenHandle.elements.get(id)?.style.visibility).toBe('hidden');
  });

  it('chargen profession page: rows + attribute names outlined tan, values white un-outlined at the DAT slots; credits and vitals split label / value', () => {
    const { ui, container } = makeUI();
    ui.showCharacterCreate();
    ui.wizard.setHeritage(1);
    ui.wizard.nextStep();
    ui.renderCharacterCreate();
    const custom = byDesc(container, descRef(CHARGEN_PROFESSION, 0x100003d9))[0];
    expect(custom.textContent).toBe('Custom');
    expect(custom.dataset.acFont).toBe('40000010');
    expect(custom.dataset.acOutline).toBe('#000000');
    expect((custom.parentElement as HTMLElement).style.height).toBe('54px');
    expect((custom.parentElement as HTMLElement).style.paddingLeft).toBe('60px');
    const names = byDesc(container, descRef(CHARGEN_PROFESSION, 0x100003e6, 0x100002ed));
    expect(names.length).toBe(1);
    expect(names[0].textContent).toBe('Strength');
    expect(names[0].dataset.acFont).toBe('4000000d');
    expect(names[0].dataset.acOutline).toBe('#000000');
    expect((names[0].parentElement as HTMLElement).style.left).toBe('33px');
    const value = byDesc(container, descRef(CHARGEN_PROFESSION, 0x100003e6, 0x100002ef))[0];
    expect(value.dataset.acOutline).toBeUndefined();
    expect(value.style.color).toMatch(/^(#ffffff|rgb\(255,\s*255,\s*255\))$/);
    expect((value.parentElement as HTMLElement).style.left).toBe('440px');
    const slider = container.querySelector('.attr-slider') as HTMLElement;
    expect([slider.style.left, slider.style.width]).toEqual(['148px', '284px']);
    const credits = byDesc(container, descRef(CHARGEN_PROFESSION, 0x100003e2));
    expect(credits.map((c) => c.textContent)).toEqual(['Attribute', 'Credits']);
    for (const c of credits) { expect(c.dataset.acOutline).toBe('#000000'); expect(c.style.color).toMatch(/^(#ffce6c|rgb\(255,\s*206,\s*108\))$/); }
    const creditsValue = byDesc(container, descRef(CHARGEN_PROFESSION, 0x100003e2, 0x100002f1))[0];
    expect(creditsValue.dataset.acOutline).toBeUndefined();
    expect(creditsValue.dataset.acFont).toBe('4000001b');
    for (const [id, str] of [[0x100003e3, 'Health'], [0x100003e4, 'Stamina'], [0x100003e5, 'Mana']] as Array<[number, string]>) {
      const label = byDesc(container, descRef(CHARGEN_PROFESSION, id))[0];
      expect(label.textContent, str).toBe(str);
      expect(label.dataset.acOutline).toBe('#000000');
      const val = byDesc(container, descRef(CHARGEN_PROFESSION, id, 0x100002f3))[0];
      expect(val.dataset.acOutline).toBeUndefined();
      expect(Number.isFinite(parseInt(val.textContent!))).toBe(true);
      expect((val.parentElement as HTMLElement).style.left).toBe('116px');
    }
  });

  it('chargen town page: the heading is the selected town in font 0x40000014, each pin carries its outlined DAT name at the DAT slot, Holtburg default', () => {
    const { ui, container } = makeUI();
    ui.showCharacterCreate();
    ui.wizard.currentStep = 4;
    ui.renderCharacterCreate();
    const heading = byDesc(container, descRef(CHARGEN_TOWN, 0x10000407, 0x10000408))[0];
    expect(heading.textContent).toBe('Holtburg');
    expect(heading.dataset.acFont).toBe('40000014');
    expect(heading.dataset.acOutline).toBe('#000000');
    expect(heading.dataset.acState).toBe('10000034');
    const pins = Array.from(container.querySelectorAll('.map-pin')) as HTMLElement[];
    // CORE.17.k.b.b.a.b — `area` is the CharGen.StarterAreas index (0 Holtburg,
    // 1 Shoushi, 2 Yaraq, 3 Sanamar); the pins keep their DAT slots.
    expect(pins.map((p) => [p.dataset.area, p.style.left, p.style.top])).toEqual([
      ['0', '262px', '89px'], ['1', '378px', '306px'], ['2', '200px', '243px'], ['3', '41px', '58px'],
    ]);
    for (const [container_, str] of [[0x1000040d, 'Holtburg'], [0x1000040e, 'Yaraq'], [0x1000040f, 'Shoushi'], [0x1000040b, 'Sanamar']] as Array<[number, string]>) {
      const label = byDesc(container, descRef(CHARGEN_TOWN, 0x1000040a, container_, 0x10000409))[0];
      expect(label.textContent, str).toBe(str);
      expect(label.dataset.acFont).toBe('4000000f');
      expect(label.dataset.acOutline).toBe('#000000');
    }
    expect(container.querySelector('#btn-confirm')).toBeNull();
    expect(container.textContent).not.toContain('Starting Location');
    // Summary page: the confirm button is the template's FINISH, green, outlined, font 0x40000024.
    ui.wizard.currentStep = 5;
    ui.renderCharacterCreate();
    const finish = (container.querySelector('#btn-confirm') as HTMLElement).firstElementChild as HTMLElement;
    expect(finish.textContent).toBe('FINISH');
    expect(finish.dataset.acFont).toBe('40000024');
    expect(finish.dataset.acOutline).toBe('#000000');
    expect(finish.style.color).toMatch(/^(#66ff00|rgb\(102,\s*255,\s*0\))$/);
  });

  it('a data-ac-desc that does not resolve falls back to the UI font in the caller colour, without an outline', () => {
    const { ui, container } = makeUI();
    const host = domWindow.document.createElement('div') as HTMLElement;
    host.innerHTML = '<span data-ac-text="x" data-ac-desc="21000004:deadbeef" data-ac-color="#123456"></span><span data-ac-text="y" data-ac-desc="garbage"></span>';
    container.appendChild(host);
    ui['replaceACTextElements'](host);
    const [x, y] = Array.from(host.children) as HTMLElement[];
    expect(x.dataset.acOutline).toBeUndefined();
    expect(x.dataset.acFont).toBeUndefined();
    expect(x.style.color).toMatch(/^(#123456|rgb\(18,\s*52,\s*86\))$/);
    expect(y.dataset.acOutline).toBeUndefined();
  });
});
