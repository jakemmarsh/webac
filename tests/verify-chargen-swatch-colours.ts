/**
 * VISUAL.chargen-swatch-colours — the chargen Appearance page's colour wheel
 * as gmCGAppearancePage draws it (decompiled EoL client; see
 * packages/renderer/src/ui/ChargenColorWheel.ts for every cite):
 *
 *  - a spot's colour = the AVERAGE over every palette of its PalSet of ONE
 *    palette entry (SetSelection @ 0047e260: hair 0xd0, nose/mouth/skin 0xb0,
 *    clothing 0x520; the eyes are single palettes read at 0x103). The shade
 *    never enters it. (The old swatch sampled entry 1024 of the shade's one
 *    palette — outside the clothing's colour range, near-black for the Cap.)
 *  - a spot is the UIASSET ColorBullet with its opaque black replaced by that
 *    colour (DoColorSpots @ 0047d850, ReplaceColor @ 00441530); spots past
 *    iNumColors are ColorEmpty.
 *  - the circle is ColorRing × the current spot's colour (DoGradDisk(false) @
 *    0047da90, BlitOp_Multiply<Fill, ARGB> @ 00668c00) — not a sweep through
 *    the PalSet's palettes; the eyes get the GradientPlug and no shade scroll.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { scriptedRandomSource } from '../packages/renderer/src/ui/ChargenRandomize.js';
import { Gender, Heritage } from '@ac/shared';
import {
  CHARGEN_SPOT_SAMPLE, COLOR_WHEEL_SPOTS, COLOR_WHEEL_FRAME, COLOR_WHEEL_GRAD_CIRCLE, COLOR_WHEEL_SHADE_SCROLL,
  COLOR_WHEEL_TEMPLATE_ROOT, paletteColor32, palSetSpotColor, paletteSpotColor, rgbCss, replaceColorRGBA,
  colorBulletRGBA, multiplyChannel, gradDiskRGBA, loadColorWheelAssets, shadeThumbTop, shadeFromTrackY,
  type Rgb, type RgbaImage,
} from '../packages/renderer/src/ui/ChargenColorWheel.js';
import { STYLE_ARROW_PREV, STYLE_ARROW_NEXT, stepChargenStyle, clampChargenColor } from '../packages/renderer/src/ui/ChargenStyleArrows.js';

const hexOf = (argb: number) => `#${(argb & 0xffffff).toString(16).padStart(6, '0')}`;

describe('the colour-wheel arithmetic (SetSelection / ReplaceColor / BlitOp_Multiply)', () => {
  it('Palette::InitLoad widens a 256-entry palette ×8, so ARGB[i] reads raw[i >> 3]; 2048-entry palettes index directly', () => {
    const small = Array.from({ length: 256 }, (_, i) => i);
    expect(paletteColor32(small, 0x520)).toBe(0x520 >> 3);
    const big = Array.from({ length: 2048 }, (_, i) => i);
    expect(paletteColor32(big, 0x520)).toBe(0x520);
    expect(paletteColor32(big, 4096)).toBe(0);
  });

  it('a PalSet spot averages the sample entry over EVERY palette (unsigned truncating divide; an unloadable palette counts as 0)', () => {
    const pals: Record<number, number[]> = {
      1: Object.assign(new Array(2048).fill(0), { 0x520: 0xff0a1403 }),
      2: Object.assign(new Array(2048).fill(0), { 0x520: 0xff0b1504 }),
    };
    expect(palSetSpotColor([1, 2], 0x520, (id) => pals[id])).toEqual({ r: 10, g: 20, b: 3 });
    expect(palSetSpotColor([1, 2, 3], 0x520, (id) => pals[id])).toEqual({ r: 7, g: 13, b: 2 });
    expect(palSetSpotColor([], 0x520, () => null)).toBeNull();
    expect(paletteSpotColor(pals[1], 0x520)).toEqual({ r: 10, g: 20, b: 3 });
  });

  it('ReplaceColor swaps only exact opaque black; Multiply is ((c + (c != 0)) · d) >> 8 with alpha kept', () => {
    const img: RgbaImage = { width: 3, height: 1, data: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 254, 1, 0, 0, 255]) };
    const out = replaceColorRGBA(img, [0, 0, 0, 255], { r: 9, g: 8, b: 7 });
    expect([...out.data]).toEqual([9, 8, 7, 255, 0, 0, 0, 254, 1, 0, 0, 255]);
    expect(multiplyChannel(0, 200)).toBe(0);
    expect(multiplyChannel(255, 200)).toBe(200);
    expect(multiplyChannel(100, 200)).toBe((101 * 200) >> 8);
    const disk = gradDiskRGBA({ width: 1, height: 1, data: new Uint8Array([72, 160, 240, 128]) }, { r: 255, g: 100, b: 0 });
    expect([...disk.data]).toEqual([72, (101 * 160) >> 8, 0, 128]);
  });

  it('the shade scroll: thumb 33x21 in the 85-px track, shade 0 at the top', () => {
    expect(shadeThumbTop(0)).toBe(0);
    expect(shadeThumbTop(1)).toBe(COLOR_WHEEL_SHADE_SCROLL.height - COLOR_WHEEL_SHADE_SCROLL.thumb.height);
    expect(shadeFromTrackY(COLOR_WHEEL_SHADE_SCROLL.thumb.height / 2)).toBe(0);
    expect(shadeFromTrackY(COLOR_WHEEL_SHADE_SCROLL.height)).toBe(1);
    expect(shadeFromTrackY(42.5)).toBeCloseTo(0.5, 9);
  });
});

/** Mocked-data page: skin / nose / eyes wheel shapes and the scroll thumb. */
describe('GameUI appearance page: the wheel per part (happy-dom)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let H: any;
  beforeAll(async () => {
    const { mountGameUI } = await import('./_harness/gameui.js');
    H = await mountGameUI();
  });
  afterAll(() => H?.teardown());

  const emptyDesc = () => ({ paletteId: 0, subPalettes: [], textureChanges: [], animPartChanges: [] });
  const sex = {
    name: 'Male', scale: 100, setupId: 0x02000001, soundTable: 0, iconImage: 0, basePalette: 0x0400007e, skinPalSet: 0x0f000013,
    physicsTable: 0, motionTable: 0, combatTable: 0, baseObjDesc: emptyDesc(),
    hairColorList: [0x0f0000a1], hairStyleList: [{ iconImage: 0, bald: false, alternateSetup: 0, objDesc: emptyDesc() }],
    eyeColorList: [0x04000e01, 0x04000e02], eyeStripList: [{ iconImage: 0, objDesc: emptyDesc() }],
    noseStripList: [{ iconImage: 0, objDesc: emptyDesc() }], mouthStripList: [{ iconImage: 0, objDesc: emptyDesc() }],
    headgearList: [], shirtList: [], pantsList: [], footwearList: [], clothingColorsList: [],
  };
  // Every palette's sample entries encode the palette id.
  const palette = (id: number): number[] => {
    const p = new Array(2048).fill(0xff000000);
    for (const i of Object.values(CHARGEN_SPOT_SAMPLE)) p[i] = (0xff000000 | (id & 0xffffff)) >>> 0;
    return p;
  };
  function render(category: string, over: Record<string, number> = {}): HTMLElement {
    const ui = H.ui;
    ui.getTexURL = (id: number) => `tex:${id.toString(16)}`;
    ui.charGen = { heritageGroups: new Map([[Heritage.Aluvian, { genders: new Map([[Gender.Male, sex]]), primaryStartAreas: [] }]]), starterAreas: [] };
    ui.renderChargenModelInto = () => {};
    ui.setUIHost({
      characterModelBuilder: { getChargenClothingColors: () => null, buildCharacterModel: () => null },
      appearanceManager: { loadPaletteColors: palette, loadPaletteSet: (set: number) => ({ paletteList: [set] }) },
    });
    // The chargen opens on RandomizeCharacter (gmCharGenMainUI ctor); script it to first entries.
    ui.chargenRandomSource = scriptedRandomSource([0], [0]);
    ui.showCharacterCreate();
    ui.wizard.heritage = Heritage.Aluvian;
    ui.wizard.gender = Gender.Male;
    Object.assign(ui.wizard.appearance, over);
    ui.wizard.currentStep = 3;
    ui.appearMode = 'face';
    ui.appearCategory = category;
    ui.renderCharacterCreate();
    return H.container as HTMLElement;
  }

  it('skin: ONE spot (the skin PalSet at 0xb0, no wire colour), eight ColorEmpty slots, the shade scroll on skinHue', () => {
    const root = render('skin', { skinHue: 1 });
    const spots = [...root.querySelectorAll('.appear-spot')] as HTMLElement[];
    expect(spots.map((s) => s.dataset.color)).toEqual([hexOf(0x0f000013)]);
    expect(spots[0].dataset.key).toBeUndefined();
    expect(root.querySelectorAll('.appear-spot-empty')).toHaveLength(8);
    const scroll = root.querySelector('.chargen-shade-disk') as HTMLElement;
    expect(scroll.dataset.huekey).toBe('skinHue');
    expect((root.querySelector('.chargen-shade-thumb') as HTMLElement).style.top).toBe(`${shadeThumbTop(1)}px`);
    // paintChargenShadeDisk follows the wizard's shade.
    H.ui.wizard.appearance.skinHue = 0;
    H.ui.paintChargenShadeDisk();
    expect((root.querySelector('.chargen-shade-thumb') as HTMLElement).style.top).toBe('0px');
    expect((root.querySelector('.chargen-grad-circle') as HTMLElement).dataset.color).toBe(hexOf(0x0f000013));
  });

  it('nose and mouth show the same skin spot and drive the skin shade (SetShade\'s NOSE/MOUTH/SKIN case)', () => {
    for (const cat of ['nose', 'mouth']) {
      const root = render(cat);
      expect([...root.querySelectorAll('.appear-spot')].map((s) => (s as HTMLElement).dataset.color)).toEqual([hexOf(0x0f000013)]);
      expect((root.querySelector('.chargen-shade-disk') as HTMLElement).dataset.huekey).toBe('skinHue');
    }
  });

  it('eyes: spots are the palettes\' 0x103 entries; the circle is the GradientPlug and there is no shade scroll', () => {
    const root = render('eyes', { eyeColor: 1 });
    const spots = [...root.querySelectorAll('.appear-spot')] as HTMLElement[];
    expect(spots.map((s) => s.dataset.color)).toEqual([hexOf(0x04000e01), hexOf(0x04000e02)]);
    expect(spots.map((s) => s.dataset.key)).toEqual(['eyeColor', 'eyeColor']);
    expect((root.querySelector('.chargen-grad-circle') as HTMLElement).dataset.mode).toBe('plug');
    expect(root.querySelector('.chargen-shade-disk')).toBeNull();
    // SetColor shows only the current colour's pointer.
    const pointers = [...root.querySelectorAll('.chargen-color-pointer')] as HTMLElement[];
    expect(pointers.map((p) => p.dataset.value)).toEqual(['1']);
    expect(pointers[0].getAttribute('style')).toContain(`tex:${COLOR_WHEEL_SPOTS[1].pointer.media.toString(16)}`);
  });

  it('the spots sit at the template slots (0x1000030f.. clockwise from the top), 37x44', () => {
    const root = render('hairStyle');
    const all = [...root.querySelectorAll('.appear-spot, .appear-spot-empty')] as HTMLElement[];
    expect(all.map((e) => [e.style.left, e.style.top])).toEqual(COLOR_WHEEL_SPOTS.map((s) => [`${s.x}px`, `${s.y}px`]));
  });
});

/**
 * VISUAL.chargen-swatch-colours.a — retail has no style list: the 0x100003b9
 * area is only the wheel, and a style changes with the row arrows
 * 0x1000030a / 0x1000030b (gmCGAppearancePage::ListenToElementMessage @
 * 0047ef30; ui/ChargenStyleArrows.ts).
 */
describe('the row style arrows (ListenToElementMessage 0x1000030a / 0x1000030b)', () => {
  it('wrap over [0, n); headgear over [−1, n) with −1 = no headgear; clothing colours clamp into the new item\'s list', () => {
    expect([0, 1, 2].map((c) => stepChargenStyle(c, 3, 1))).toEqual([1, 2, 0]);
    expect([0, 1, 2].map((c) => stepChargenStyle(c, 3, -1))).toEqual([2, 0, 1]);
    expect([-1, 0, 1].map((c) => stepChargenStyle(c, 2, 1, true))).toEqual([0, 1, -1]);
    expect([-1, 0, 1].map((c) => stepChargenStyle(c, 2, -1, true))).toEqual([1, -1, 0]);
    expect(clampChargenColor(7, 3)).toBe(2);
    expect(clampChargenColor(-1, 3)).toBe(0);
    expect(clampChargenColor(1, 3)).toBe(1);
    expect([STYLE_ARROW_PREV.x, STYLE_ARROW_NEXT.x, STYLE_ARROW_PREV.width, STYLE_ARROW_PREV.height]).toEqual([80, 127, 47, 44]);
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let H: any;
  beforeAll(async () => {
    const { mountGameUI } = await import('./_harness/gameui.js');
    H = await mountGameUI();
  });
  afterAll(() => H?.teardown());

  const emptyDesc = () => ({ paletteId: 0, subPalettes: [], textureChanges: [], animPartChanges: [] });
  const strip = (n: number) => Array.from({ length: n }, (_, i) => ({ iconImage: 0x06001000 + i, bald: false, alternateSetup: 0, objDesc: emptyDesc() }));
  const gear = (name: string) => ({ name, clothingTable: 0x10000009, weenieDefault: 118 });
  const sex = {
    name: 'Male', scale: 100, setupId: 0x02000001, soundTable: 0, iconImage: 0, basePalette: 0x0400007e, skinPalSet: 0x0f000013,
    physicsTable: 0, motionTable: 0, combatTable: 0, baseObjDesc: emptyDesc(),
    hairColorList: [0x0f0000a1], hairStyleList: strip(3), eyeColorList: [], eyeStripList: strip(2),
    noseStripList: strip(2), mouthStripList: strip(2),
    headgearList: [gear('Cloth Cap'), gear('Cloth Cowl')], shirtList: [gear('Shirt A'), gear('Shirt B')],
    pantsList: [gear('Pants')], footwearList: [gear('Shoes')], clothingColorsList: [],
  };
  const palette = (id: number): number[] => new Array(2048).fill((0xff000000 | (id & 0xffffff)) >>> 0);
  // Shirt B offers two colours, everything else three.
  const colours = (a: { shirtStyle: number }) => {
    const list = (n: number) => ({ templateIds: Array.from({ length: n }, (_, i) => i + 2), palSetIds: Array.from({ length: n }, (_, i) => 0x0f000002 + i) });
    return { headgear: list(3), shirt: list(a.shirtStyle === 1 ? 2 : 3), pants: list(3), footwear: list(3) };
  };
  let previews: Array<Record<string, number>> = [];
  function render(mode: 'face' | 'clothes', category: string, over: Record<string, number> = {}): HTMLElement {
    const ui = H.ui;
    ui.getTexURL = (id: number) => `tex:${id.toString(16)}`;
    ui.charGen = { heritageGroups: new Map([[Heritage.Aluvian, { genders: new Map([[Gender.Male, sex]]), primaryStartAreas: [] }]]), starterAreas: [] };
    previews = [];
    ui.renderChargenModelInto = (_c: unknown, rebuild: boolean) => { if (rebuild) previews.push({ ...ui.wizard.appearance }); };
    ui.setUIHost({
      characterModelBuilder: { getChargenClothingColors: (_h: number, _g: number, a: { shirtStyle: number }) => colours(a), buildCharacterModel: () => null },
      appearanceManager: { loadPaletteColors: palette, loadPaletteSet: (set: number) => ({ paletteList: [set] }) },
    });
    // The chargen opens on RandomizeCharacter (gmCharGenMainUI ctor); script it to first entries.
    ui.chargenRandomSource = scriptedRandomSource([0], [0]);
    ui.showCharacterCreate();
    ui.wizard.heritage = Heritage.Aluvian;
    ui.wizard.gender = Gender.Male;
    Object.assign(ui.wizard.appearance, { hairStyle: 0, headgearStyle: 0, shirtStyle: 0, pantsStyle: 0, footwearStyle: 0 }, over);
    ui.wizard.currentStep = 3;
    ui.appearMode = mode;
    ui.appearCategory = category;
    ui.renderCharacterCreate();
    previews = [];
    return H.container as HTMLElement;
  }
  const arrow = (root: HTMLElement, cat: string, dir: 1 | -1) =>
    root.querySelector(`.appear-style-arrow[data-cat="${cat}"][data-dir="${dir}"]`) as HTMLElement;
  const click = (el: HTMLElement) => el.dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));

  it('the category rows sit at the DAT pitch (45 px, 200×44), not the old i × 44', () => {
    const rows = [...render('clothes', 'headgear').querySelectorAll('.appear-cat-btn')] as HTMLElement[];
    expect(rows.map((r) => r.style.top)).toEqual(['0px', '45px', '90px', '135px']);
    expect(rows[0].style.width).toBe('200px');
    expect(rows[0].style.height).toBe('44px');
  });

  it('the active row is the DAT selected state 0x6 (SetSelection @ 0047e260), with no tint or separator of our own', () => {
    const rows = [...render('clothes', 'shirt').querySelectorAll('.appear-cat-btn')] as HTMLElement[];
    for (const r of rows) {
      const active = r.getAttribute('data-cat') === 'shirt';
      expect(r.style.background === '' || r.style.background === 'transparent').toBe(true);
      expect(r.style.borderBottom === '' || r.style.borderBottom.startsWith('none') || r.style.borderBottomStyle === 'none' || r.style.borderBottom === 'medium none').toBe(true);
      const text = r.querySelector('[data-ac-desc]') as HTMLElement;
      expect(text.getAttribute('data-ac-state')).toBe(active ? '6' : '1');
      expect(text.hasAttribute('data-ac-color')).toBe(false);
    }
  });

  it('no style strip: no name rows, no icon grid in 0x100003b9 — only the wheel', () => {
    for (const [mode, cat] of [['face', 'hairStyle'], ['face', 'eyes'], ['clothes', 'headgear'], ['clothes', 'shirt']] as const) {
      const root = render(mode, cat);
      expect(root.querySelectorAll('.appear-pick'), cat).toHaveLength(0);
      expect(root.querySelector('[data-ac-text="Cloth Cowl"], [data-ac-text="Shirt B"]'), cat).toBeNull();
      expect(root.querySelectorAll('#chargen-root img, .chargen-color-wheel ~ *'), cat).toHaveLength(0);
      expect(root.querySelector('.chargen-color-wheel'), cat).not.toBeNull();
    }
  });

  it('every row but Skin carries its two arrows at the template offsets', () => {
    const root = render('face', 'hairStyle');
    for (const cat of ['hairStyle', 'eyes', 'nose', 'mouth']) {
      const l = arrow(root, cat, -1), r = arrow(root, cat, 1);
      expect([l.style.left, r.style.left, l.style.width, l.style.height], cat).toEqual(['80px', '127px', '47px', '44px']);
      expect(l.closest('.appear-cat-btn')?.getAttribute('data-cat')).toBe(cat);
    }
    expect(root.querySelectorAll('.appear-style-arrow[data-cat="skin"]')).toHaveLength(0);
  });

  it('a Face arrow steps the style with the wrap, selects that row and rebuilds the preview', () => {
    let root = render('face', 'hairStyle', { hairStyle: 2 });
    click(arrow(root, 'hairStyle', 1));
    expect(H.ui.wizard.appearance.hairStyle).toBe(0);
    expect(previews.at(-1)?.hairStyle).toBe(0);
    root = H.container;
    click(arrow(root, 'nose', -1));
    expect(H.ui.wizard.appearance.noseStyle).toBe(1);
    expect(H.ui.appearCategory).toBe('nose');
    expect(previews.at(-1)?.noseStyle).toBe(1);
  });

  it('the Headgear arrows cycle Cloth Cap → Cloth Cowl → none → Cloth Cap; the Shirt arrow clamps the colour into the new shirt\'s list', () => {
    const root = render('clothes', 'headgear', { headgearStyle: 0 });
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) { click(arrow(H.container, 'headgear', 1)); seen.push(H.ui.wizard.appearance.headgearStyle); }
    expect(seen).toEqual([1, -1, 0]);
    expect(previews.map((p) => p.headgearStyle)).toEqual([1, -1, 0]);
    void root;
    render('clothes', 'shirt', { shirtStyle: 0, shirtColor: 2 });
    click(arrow(H.container, 'shirt', 1));
    expect([H.ui.wizard.appearance.shirtStyle, H.ui.wizard.appearance.shirtColor]).toEqual([1, 1]);
    expect(H.container.querySelectorAll('.appear-spot')).toHaveLength(2);
  });
});

const PORTAL_DAT = 'dat/client_portal.dat';
const LANG_DAT = 'dat/client_local_English.dat';

describe.skipIf(!existsSync(PORTAL_DAT) || !existsSync(LANG_DAT))('real DAT: the Aluvian male Cloth Cap and hair wheels on the real GameUI page', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let H: any; let db: any; let tm: any; let dat: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sexCG: any; let capSets: readonly number[];

  beforeAll(async () => {
    dat = await import('@ac/dat-parser');
    const { CharacterGenerator } = await import('../packages/dat-parser/src/file-types/CharacterGenerator.js');
    const { AppearanceManager } = await import('../packages/renderer/src/models/AppearanceManager.js');
    const { CharacterModelBuilder } = await import('../packages/renderer/src/models/CharacterModelBuilder.js');
    const { ClothingRenderer } = await import('../packages/renderer/src/models/ClothingRenderer.js');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { mountGameUI } = await import('./_harness/gameui.js');
    db = new dat.DatDatabase(new Uint8Array(readFileSync(PORTAL_DAT)).buffer);
    tm = new TextureManager(db);
    const am = new AppearanceManager(db);
    const builder = new CharacterModelBuilder(db, null as never, new ClothingRenderer(db, null as never, null as never, null as never), am);
    sexCG = builder.getSexCG(Heritage.Aluvian, Gender.Male);
    H = await mountGameUI();
    const ui = H.ui;
    ui.portalDb = db;
    // The page's own style strip asks for icon data URLs, which need a 2D
    // canvas happy-dom lacks; the wheel reads raw pixels (getIconRGBA).
    ui.textureManager = Object.assign(Object.create(tm), { getIconDataURL: () => null });
    ui.charGen = new CharacterGenerator(new dat.DatReader(db.getFileData(0x0e000002)));
    ui.renderChargenModelInto = () => {};
    // happy-dom has no 2D canvas: page art resolves to tokens (the wheel's own
    // rendered surfaces fall back to their colour — iconRgbaToDataURL is null).
    ui.getTexURL = (id: number) => `tex:${id.toString(16)}`;
    ui.setUIHost({ characterModelBuilder: builder, appearanceManager: am });
    capSets = builder.getChargenClothingColors(Heritage.Aluvian, Gender.Male,
      { headgearStyle: 0, shirtStyle: 0, pantsStyle: 0, footwearStyle: 0 } as never).headgear.palSetIds;
  });
  afterAll(() => H?.teardown());

  function render(mode: 'face' | 'clothes', category: string, over: Record<string, number> = {}): HTMLElement {
    const ui = H.ui;
    // The chargen opens on RandomizeCharacter (gmCharGenMainUI ctor); script it to first entries.
    ui.chargenRandomSource = scriptedRandomSource([0], [0]);
    ui.showCharacterCreate();
    ui.wizard.heritage = Heritage.Aluvian;
    ui.wizard.gender = Gender.Male;
    Object.assign(ui.wizard.appearance, { headgearStyle: 0, shirtStyle: 0, pantsStyle: 0, footwearStyle: 0 }, over);
    ui.wizard.currentStep = 3;
    ui.appearMode = mode;
    ui.appearCategory = category;
    ui.renderCharacterCreate();
    return H.container as HTMLElement;
  }

  /** Independent of the module: the PalSet's palettes (0x0F file = uint32 id, uint32 count, ids). */
  function expectedSpot(setId: number, sample: number): Rgb {
    const ps = new dat.PaletteSet(new dat.DatReader(db.getFileData(setId)));
    let r = 0, g = 0, b = 0;
    for (const pid of ps.paletteList as number[]) {
      const colors = dat.Palette.read(new dat.DatReader(db.getFileData(pid))).colors as number[];
      expect(colors.length).toBe(2048);
      const c = colors[sample] >>> 0;
      r += (c >>> 16) & 0xff; g += (c >>> 8) & 0xff; b += c & 0xff;
    }
    const n = ps.paletteList.length;
    return { r: Math.floor(r / n), g: Math.floor(g / n), b: Math.floor(b / n) };
  }
  const chroma = (c: Rgb) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  const parse = (css: string): Rgb => { const v = parseInt(css.slice(1), 16); return { r: v >> 16, g: (v >> 8) & 255, b: v & 255 }; };

  it('the wheel\'s UIASSET art: ColorBullet 0x06004D46, ColorRing 0x06004D45, ColorEmpty 0x06005DA5, GradientPlug 0x06005DA6', () => {
    expect(loadColorWheelAssets(db, db.masterMapId)).toEqual({ bullet: 0x06004d46, ring: 0x06004d45, empty: 0x06005da5, plug: 0x06005da6 });
  });

  it('Cloth Cap: the 9 spots are each template PalSet\'s 0x520 average — distinct, lit, all chromatic but the DAT\'s grey set 0x0F000009', () => {
    expect(sexCG.headgearList[0].name).toBe('Cloth Cap');
    const root = render('clothes', 'headgear', { headgearColor: 0 });
    const spots = [...root.querySelectorAll('.appear-spot')] as HTMLElement[];
    expect(spots).toHaveLength(9);
    expect(spots.every((s) => s.dataset.key === 'headgearColor')).toBe(true);
    const got = spots.map((s) => s.dataset.color);
    expect(got).toEqual(capSets.map((set) => rgbCss(expectedSpot(set, CHARGEN_SPOT_SAMPLE.clothing))));
    // What the orchestrator should see live, clockwise from the top.
    expect(got).toEqual(['#0b2d45', '#290a43', '#3f2a13', '#0b1d47', '#421c0c', '#14430c', '#285d0c', '#3b3b3b', '#38173e']);
    expect(new Set(got).size).toBe(9);
    const rgb = got.map((c) => parse(c!));
    expect(rgb.every((c) => Math.max(c.r, c.g, c.b) >= 0x30)).toBe(true);
    expect(capSets.filter((_, i) => chroma(rgb[i]) < 8)).toEqual([0x0f000009]);
    expect(root.querySelectorAll('.appear-spot-empty')).toHaveLength(0);
  });

  it('hair: the 4 spots are each hairColorList PalSet\'s 0xd0 average (blond, brown, the DAT\'s grey, auburn); 5 ColorEmpty slots', () => {
    const root = render('face', 'hairStyle', { hairColor: 0 });
    const spots = [...root.querySelectorAll('.appear-spot')] as HTMLElement[];
    expect(spots.map((s) => s.dataset.key)).toEqual(['hairColor', 'hairColor', 'hairColor', 'hairColor']);
    const got = spots.map((s) => s.dataset.color);
    expect(got).toEqual((sexCG.hairColorList as number[]).map((set) => rgbCss(expectedSpot(set, CHARGEN_SPOT_SAMPLE.hair))));
    expect(got).toEqual(['#655e04', '#31270d', '#353535', '#531505']);
    expect(new Set(got).size).toBe(4);
    expect(got.map((c) => parse(c!)).every((c) => Math.max(c.r, c.g, c.b) >= 0x30)).toBe(true);
    expect(root.querySelectorAll('.appear-spot-empty')).toHaveLength(5);
  });

  it('a spot draws ColorBullet with its opaque-black centre in the spot colour; the gold rim is untouched', () => {
    const bullet = tm.getIconRGBA(0x06004d46);
    const c = parse('#0b2d45');
    const out = colorBulletRGBA(bullet, c);
    const px = (img: RgbaImage, x: number, y: number) => [...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
    expect(px(bullet, 18, 22)).toEqual([0, 0, 0, 255]);
    expect(px(out, 18, 22)).toEqual([c.r, c.g, c.b, 255]);
    for (let i = 0; i < bullet.data.length; i += 4) {
      const black = bullet.data[i] === 0 && bullet.data[i + 1] === 0 && bullet.data[i + 2] === 0 && bullet.data[i + 3] === 255;
      if (!black) expect([...out.data.slice(i, i + 4)]).toEqual([...bullet.data.slice(i, i + 4)]);
    }
  });

  it('the circle is ColorRing × the SELECTED spot: darkest at the top, lightest at the bottom, both the spot\'s own hue', () => {
    for (const [part, key, cat, mode, idx] of [
      ['cap', 'headgearColor', 'headgear', 'clothes', 5], ['hair', 'hairColor', 'hairStyle', 'face', 3],
    ] as const) {
      const root = render(mode, cat, { [key]: idx });
      const circle = root.querySelector('.chargen-grad-circle') as HTMLElement;
      const spots = [...root.querySelectorAll('.appear-spot')] as HTMLElement[];
      expect(circle.dataset.color, part).toBe(spots[idx].dataset.color);
      expect(circle.dataset.mode).toBe('ring');
      expect([...root.querySelectorAll('.chargen-color-pointer')].map((p) => (p as HTMLElement).dataset.value), part).toEqual([String(idx)]);
      const color = parse(circle.dataset.color!);
      const ring = tm.getIconRGBA(0x06004d45) as RgbaImage;
      const disk = gradDiskRGBA(ring, color);
      // The centre column's opaque run: its first (top) and last (bottom) texels.
      const x = ring.width >> 1;
      const opaque: number[] = [];
      for (let y = 0; y < ring.height; y++) if (ring.data[(y * ring.width + x) * 4 + 3] === 255) opaque.push(y);
      const at = (img: RgbaImage, y: number) => [...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
      const top = opaque[0], bottom = opaque[opaque.length - 1];
      const ringTop = at(ring, top)[0], ringBottom = at(ring, bottom)[0];
      expect(ringTop, part).toBeLessThan(ringBottom);
      expect(at(disk, top), part).toEqual([color.r, color.g, color.b].map((c) => multiplyChannel(c, ringTop)));
      expect(at(disk, bottom), part).toEqual([color.r, color.g, color.b].map((c) => multiplyChannel(c, ringBottom)));
      const sum = (v: number[]) => v[0] + v[1] + v[2];
      expect(sum(at(disk, top))).toBeLessThan(sum(at(disk, bottom)));
    }
  });

  it('real Aluvian male: the Headgear arrow steps Cloth Cap → Cloth Cowl → none; the wheel follows (9 spots → 0 with no headgear); no style strip', () => {
    const root = render('clothes', 'headgear', { headgearStyle: 0, headgearColor: 0 });
    expect(root.querySelectorAll('.appear-pick')).toHaveLength(0);
    expect(root.querySelector('[data-ac-text="Cloth Cowl"]')).toBeNull();
    const next = () => (H.container.querySelector('.appear-style-arrow[data-cat="headgear"][data-dir="1"]') as HTMLElement)
      .dispatchEvent(new H.win.MouseEvent('click', { bubbles: true }));
    expect(sexCG.headgearList.map((g: { name: string }) => g.name)).toEqual(['Cloth Cap', 'Cloth Cowl']);
    next();
    expect(H.ui.wizard.appearance.headgearStyle).toBe(1);
    expect(H.container.querySelectorAll('.appear-spot').length).toBeGreaterThan(0);
    next();
    expect(H.ui.wizard.appearance.headgearStyle).toBe(-1);
    expect(H.container.querySelectorAll('.appear-spot')).toHaveLength(0);
    expect(H.container.querySelectorAll('.appear-spot-empty')).toHaveLength(9);
    next();
    expect(H.ui.wizard.appearance.headgearStyle).toBe(0);
    expect(H.container.querySelectorAll('.appear-spot')).toHaveLength(9);
  });

  it('the wheel\'s constants are template 0x2100004c:0x1000030c\'s elements', () => {
    const buf = readFileSync(LANG_DAT);
    const lang = new dat.DatDatabase(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    dat.setMasterPropertyTypes(dat.parseMasterProperty(new dat.DatReader(db.getFileData(0x39000001))));
    const layout = dat.parseLayoutDesc(new dat.DatReader(lang.getFileData(0x2100004c)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const find = (els: any, id: number): any => {
      for (const e of els.values ? els.values() : els) {
        if (e.elementId === id) return e;
        const hit = e.children ? find(e.children, id) : null;
        if (hit) return hit;
      }
      return null;
    };
    const root = find(layout.elements, COLOR_WHEEL_TEMPLATE_ROOT);
    expect([root.width, root.height]).toEqual([220, 220]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const media = (e: any): number | undefined => {
      for (const m of e.media ?? []) if (m.file != null) return m.file;
      for (const st of e.states?.values?.() ?? []) for (const m of st.media ?? []) if (m.file != null) return m.file;
      return undefined;
    };
    for (const s of COLOR_WHEEL_SPOTS) {
      const e = find(root.children, s.elementId);
      expect([e.x, e.y, e.width, e.height, media(e)]).toEqual([s.x, s.y, s.width, s.height, 0x06004d46]);
      const p = find(root.children, s.pointer.elementId);
      expect([p.x, p.y, p.width, p.height, media(p)]).toEqual([s.pointer.x, s.pointer.y, s.pointer.width, s.pointer.height, s.pointer.media]);
    }
    const frame = find(root.children, COLOR_WHEEL_FRAME.elementId);
    expect([frame.x, frame.y, frame.width, frame.height, media(frame)]).toEqual([COLOR_WHEEL_FRAME.x, COLOR_WHEEL_FRAME.y, COLOR_WHEEL_FRAME.width, COLOR_WHEEL_FRAME.height, COLOR_WHEEL_FRAME.media]);
    const circle = find(root.children, COLOR_WHEEL_GRAD_CIRCLE.elementId);
    expect([circle.x, circle.y, circle.width, circle.height, media(circle)]).toEqual([COLOR_WHEEL_GRAD_CIRCLE.x, COLOR_WHEEL_GRAD_CIRCLE.y, COLOR_WHEEL_GRAD_CIRCLE.width, COLOR_WHEEL_GRAD_CIRCLE.height, 0x06004d45]);
    const scroll = find(root.children, COLOR_WHEEL_SHADE_SCROLL.elementId);
    expect([scroll.x, scroll.y, scroll.width, scroll.height]).toEqual([COLOR_WHEEL_SHADE_SCROLL.x, COLOR_WHEEL_SHADE_SCROLL.y, COLOR_WHEEL_SHADE_SCROLL.width, COLOR_WHEEL_SHADE_SCROLL.height]);
    const thumb = find(scroll.children, 0x1);
    expect([thumb.width, thumb.height, media(thumb)]).toEqual([COLOR_WHEEL_SHADE_SCROLL.thumb.width, COLOR_WHEEL_SHADE_SCROLL.thumb.height, COLOR_WHEEL_SHADE_SCROLL.thumb.media]);
  });
});

describe.skipIf(!existsSync(LANG_DAT) || !existsSync(PORTAL_DAT))('real DAT: chargenCategoryRowRect reads 0x21000049', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let layout: any;
  beforeAll(async () => {
    const d = await import('@ac/dat-parser');
    const open = (p: string) => new d.DatDatabase(new Uint8Array(readFileSync(p)).buffer);
    d.setMasterPropertyTypes(d.parseMasterProperty(new d.DatReader(open(PORTAL_DAT).getFileData(0x39000001)!)));
    const lrMod = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const tex = { getTextureDataURL: () => '', getTextureDataURLWithAlpha: () => '' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    layout = new lrMod.LayoutRenderer(open(LANG_DAT) as any, tex as any, null).getResolvedLayout(0x21000049);
  });
  it('face rows 0x100003af..b3 and clothes rows 0x100003b5..b8 are 200×44 at y = 0, 45, 90, 135 (, 180)', async () => {
    const { chargenCategoryRowRect } = await import('../packages/renderer/src/ui/ChargenStyleArrows.js');
    expect([0x100003af, 0x100003b0, 0x100003b1, 0x100003b2, 0x100003b3].map((id, i) => chargenCategoryRowRect(layout, 0x100003ae, id, i)))
      .toEqual([0, 45, 90, 135, 180].map((y) => ({ y, width: 200, height: 44 })));
    expect([0x100003b5, 0x100003b6, 0x100003b7, 0x100003b8].map((id, i) => chargenCategoryRowRect(layout, 0x100003b4, id, i).y))
      .toEqual([0, 45, 90, 135]);
  });
});
