/**
 * BUG.cap-palette-template-0-black — +TestPartner's chargen Cap (wcid 118,
 * ClothingBase 0x10000009) drew as a flat black block.
 *
 * Root cause: our chargen sent each clothing colour's SPOT INDEX in the
 * CharacterCreate appearance block. Retail sends the palette TEMPLATE id
 * (CharGenState::GetCharGenResult @ 005c4030 maps the index through
 * xPaletteTemplateIDs, built by StoreColorInformation @ 005c44d0) and ACE
 * stores the value as the item's PaletteTemplate (PlayerFactory.cs
 * GetClothingObject). Index 0 → PaletteTemplate 0, which is no key of the
 * Cap's ClothingTable, so ACE's CalculateObjDesc (Creature_Networking.cs)
 * falls back to the first template (1 → PaletteSet 0x0F000001) and shade 0
 * picks 0x040005F3, near-black over the cap texture's 2000..2047 range. The
 * render path itself applies that ObjDesc exactly as retail would.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { scriptedRandomSource } from '../packages/renderer/src/ui/ChargenRandomize.js';
import { buildCharacterCreate } from '@ac/network';
import { Gender, Heritage } from '@ac/shared';
import type { AppearanceInfo } from '@ac/shared';
import { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { ClothingTable, type CloSubPalEffect } from '@ac/dat-parser/file-types/ClothingTable.js';
import { PaletteSet } from '@ac/dat-parser/file-types/PaletteSet.js';
import {
  storeColorInformation, paletteTemplateIdFor, clothingSubPaletteRanges, NO_CLOTHING_COLORS,
  type ChargenClothingColors,
} from '../packages/renderer/src/models/ChargenClothingColors.js';
import { characterCreateAppearance } from '../packages/renderer/src/ui/CharacterCreate.js';
import { CharacterModelBuilder } from '../packages/renderer/src/models/CharacterModelBuilder.js';
import { ClothingRenderer } from '../packages/renderer/src/models/ClothingRenderer.js';
import { AppearanceManager } from '../packages/renderer/src/models/AppearanceManager.js';
import { TextureManager } from '../packages/renderer/src/models/TextureManager.js';
import { buildAppearanceOverrides } from '../packages/renderer/src/models/AppearanceOverrides.js';
import { openDat } from './_harness/dat.js';

function effect(palSets: number[]): CloSubPalEffect {
  return { icon: 0, cloSubPalettes: palSets.map((paletteSet) => ({ paletteSet, ranges: [{ offset: 2000, numColors: 48 }] })) };
}

function appearance(over: Partial<AppearanceInfo> = {}): AppearanceInfo {
  return {
    hairStyle: 0, hairColor: 0, eyesStrip: 0, eyeColor: 0, skinColor: 0, noseStyle: 0, mouthStyle: 0,
    headgearStyle: 0, headgearColor: 0, shirtStyle: 0, shirtColor: 0, pantsStyle: 0, pantsColor: 0,
    footwearStyle: 0, footwearColor: 0, ...over,
  };
}

describe('chargen clothing colours are palette template ids (CharGenState::StoreColorInformation / GetCharGenResult)', () => {
  // DAT (hash-walk) order 1, 2, 84, 20, 3 — the Sex_CG list in its own order.
  const table = { clothingSubPalEffects: new Map<number, CloSubPalEffect>([
    [1, effect([0x0f000001])], [2, effect([0x0f000002, 0x0f0000aa])], [84, effect([0x0f00011f])],
    [20, effect([0x0f00001f])], [3, effect([0x0f000003])],
  ]) };

  it('keeps the table keys that are in the sex colour list, in the TABLE order, with each first sub-palette set', () => {
    const c = storeColorInformation(table, [20, 3, 2, 99]);
    expect(c.templateIds).toEqual([2, 20, 3]);
    expect(c.palSetIds).toEqual([0x0f000002, 0x0f00001f, 0x0f000003]);
    expect(storeColorInformation(null, [1, 2])).toEqual(NO_CLOTHING_COLORS);
  });

  it('maps a spot index to its template, 0 outside [0, num)', () => {
    const c = storeColorInformation(table, [20, 3, 2]);
    expect([0, 1, 2].map((i) => paletteTemplateIdFor(c, i))).toEqual([2, 20, 3]);
    expect(paletteTemplateIdFor(c, 3)).toBe(0);
    expect(paletteTemplateIdFor(c, -1)).toBe(0);
    expect(paletteTemplateIdFor(NO_CLOTHING_COLORS, 0)).toBe(0);
  });

  it('the CharacterCreate wire carries the templates, not the indices', () => {
    const cc: ChargenClothingColors = {
      headgear: { templateIds: [2, 3, 4], palSetIds: [0, 0, 0] },
      shirt: { templateIds: [9, 6], palSetIds: [0, 0] },
      pants: { templateIds: [13], palSetIds: [0] },
      footwear: { templateIds: [5, 7], palSetIds: [0, 0] },
    };
    const wire = characterCreateAppearance(
      appearance({ headgearColor: 0, shirtColor: 1, pantsColor: 0, footwearColor: 1 }), cc);
    expect([wire.headgearColor, wire.shirtColor, wire.pantsColor, wire.footwearColor]).toEqual([2, 6, 13, 7]);
    // No headgear (style −1 → retail's numHeadgearColors = 0) and no DAT → 0.
    expect(characterCreateAppearance(appearance({ headgearStyle: -1, headgearColor: -1 }), { ...cc, headgear: NO_CLOTHING_COLORS }).headgearColor).toBe(0);
    expect(characterCreateAppearance(appearance({ shirtColor: 4 })).shirtColor).toBe(0);

    // The bytes: HeadgearColor is the 8th appearance uint32 (ACE Appearance.Unpack order).
    const bytes = buildCharacterCreate({
      accountName: 'a', heritage: Heritage.Aluvian, gender: Gender.Male, appearance: wire,
      templateOption: 0, strength: 10, endurance: 10, coordination: 10, quickness: 10, focus: 10, self: 10,
      characterSlot: 0, classId: 1, skills: [], name: 'n', startArea: 0,
    });
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // opcode(4) + String16L 'a' (2 + 1, padded to 4) + 1 + heritage + gender = 20.
    const appearanceStart = 4 + 4 + 4 + 4 + 4;
    expect(dv.getUint32(appearanceStart + 7 * 4, true)).toBe(2);
    expect(dv.getUint32(appearanceStart + 9 * 4, true)).toBe(6);
  });

  it('ACE picks the table\'s first template when the stored one is not a key (the TestPartner fallback)', () => {
    const resolve = (set: number) => set + 0x100;
    expect(clothingSubPaletteRanges(table, 0, resolve)).toEqual([{ paletteId: 0x0f000101, offset: 2000, length: 48 }]);
    expect(clothingSubPaletteRanges(table, 2, resolve)).toEqual([
      { paletteId: 0x0f000102, offset: 2000, length: 48 }, { paletteId: 0x0f0001aa, offset: 2000, length: 48 },
    ]);
    expect(clothingSubPaletteRanges(null, 2, resolve)).toEqual([]);
  });
});

const PORTAL_DAT = 'dat/client_portal.dat';
const CAP_TABLE = 0x10000009;
const CAP_TEXTURE = 0x05000ec9; // the Cap's CloTextureEffect for 0x05000ca3 on part 16
const PLAYER_PALETTE_BASE = 0x0400007e;

describe.skipIf(!existsSync(PORTAL_DAT))('real DAT: the Cap (ClothingTable 0x10000009) through chargen and the ObjDesc palette path', () => {
  let db: DatDatabase;
  let am: AppearanceManager;
  let builder: CharacterModelBuilder;
  let tm: TextureManager;
  let capTable: ClothingTable;

  beforeAll(() => {
    db = openDat(PORTAL_DAT);
    am = new AppearanceManager(db);
    const clothing = new ClothingRenderer(db, null as never, null as never, null as never);
    builder = new CharacterModelBuilder(db, null as never, clothing, am);
    tm = new TextureManager(db);
    capTable = new ClothingTable(new DatReader(db.getFileData(CAP_TABLE)!));
  });

  const shadePalette = (set: number, shade: number): number =>
    new PaletteSet(new DatReader(db.getFileData(set)!)).getPaletteId(shade);

  /** The cap texture through the live player path: ObjDesc → buildAppearanceOverrides → TextureManager. */
  function renderCap(template: number, shade: number): { rgba: Uint8Array; palette: number[] } {
    const subPalettes = clothingSubPaletteRanges(capTable, template, (set) => shadePalette(set, shade));
    const ov = buildAppearanceOverrides(
      { basePalette: PLAYER_PALETTE_BASE, subPalettes, textureChanges: [], animPartChanges: [] },
      (id) => am.loadPaletteColors(id),
    );
    const out = tm.getRGBAWithPalette(CAP_TEXTURE, ov.paletteColors!);
    return { rgba: out!.data, palette: ov.paletteColors! };
  }

  it('an Aluvian male\'s Cap spots are the table-order templates 2,3,4,5,6,7,8,9,13 (Sex_CG lists 9,6,4,8,7,5,2,3,13)', () => {
    const cc = builder.getChargenClothingColors(Heritage.Aluvian, Gender.Male, appearance());
    expect(cc.headgear.templateIds).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 13]);
    expect(cc.headgear.palSetIds[0]).toBe(0x0f000002);
    // Spot 0 goes out as template 2 — never the 0 that ACE cannot find.
    expect(characterCreateAppearance(appearance(), cc).headgearColor).toBe(2);
    // No headgear: no spots, 0 on the wire.
    const none = builder.getChargenClothingColors(Heritage.Aluvian, Gender.Male, appearance({ headgearStyle: -1 }));
    expect(none.headgear).toEqual(NO_CLOTHING_COLORS);
  });

  it('every heritage/gender/gear offers exactly its Sex_CG colour count, so no stored index can fall outside the list', () => {
    for (const h of [Heritage.Aluvian, Heritage.Gharundim, Heritage.Sho]) {
      for (const g of [Gender.Male, Gender.Female]) {
        const sex = builder.getSexCG(h, g)!;
        for (let s = 0; s < sex.shirtList.length; s++) {
          const cc = builder.getChargenClothingColors(h, g, appearance({ shirtStyle: s }));
          expect(cc.shirt.templateIds.length).toBe(sex.clothingColorsList.length);
          expect(cc.shirt.palSetIds.every((p) => (p >>> 24) === 0x0f)).toBe(true);
        }
      }
    }
  });

  it('the stored PaletteTemplate 0 / Shade 0 ObjDesc (ACE fallback → template 1, palette 0x040005F3) is near-black — the reported cap', () => {
    expect(shadePalette(0x0f000001, 0)).toBe(0x040005f3);
    const { rgba } = renderCap(0, 0);
    let max = 0;
    for (let i = 0; i < rgba.length; i += 4) max = Math.max(max, rgba[i], rgba[i + 1], rgba[i + 2]);
    expect(max).toBeLessThanOrEqual(0x16);
  });

  it('the fixed chargen template renders the cap in its palette\'s colours, not black', () => {
    const template = paletteTemplateIdFor(builder.getChargenClothingColors(Heritage.Aluvian, Gender.Male, appearance()).headgear, 0);
    const { rgba, palette } = renderCap(template, 0.5);
    const chosen = am.loadPaletteColors(shadePalette(0x0f000002, 0.5))!;
    // Every texel is one of the chosen palette's 2000..2047 entries.
    for (let i = 2000; i < 2048; i++) expect(palette[i]).toBe(chosen[i]);
    const allowed = new Set(chosen.slice(2000, 2048).map((c) => (c & 0xffffff) >>> 0));
    let max = 0;
    let sum = 0;
    for (let i = 0; i < rgba.length; i += 4) {
      expect(allowed.has(((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]) >>> 0)).toBe(true);
      max = Math.max(max, rgba[i], rgba[i + 1], rgba[i + 2]);
      sum += rgba[i] + rgba[i + 1] + rgba[i + 2];
    }
    // The Cap texture only indexes the dark end of the 2000..2047 ramp
    // (2000..2018), so even a correct cap is a dark cloth — but coloured,
    // an order of magnitude above the fallback's near-zero texels.
    const fallback = renderCap(0, 0).rgba;
    let fallbackSum = 0;
    for (let i = 0; i < fallback.length; i += 4) fallbackSum += fallback[i] + fallback[i + 1] + fallback[i + 2];
    expect(max).toBeGreaterThan(2 * 0x16);
    expect(sum).toBeGreaterThan(5 * fallbackSum);
  });

  it('the chargen preview colours the cap with the chosen template and shade', () => {
    const sex = builder.getSexCG(Heritage.Aluvian, Gender.Male)!;
    const a = appearance({ headgearColor: 3, headgearHue: 0.5 });
    const composite = (builder as unknown as { buildCompositePalette(s: unknown, a: AppearanceInfo): number[] })
      .buildCompositePalette(sex, a);
    // Spot 3 = template 5 → PaletteSet 0x0F000005.
    const chosen = am.loadPaletteColors(shadePalette(0x0f000005, 0.5))!;
    for (let i = 2000; i < 2048; i++) expect(composite[i]).toBe(chosen[i]);
  });
});

/**
 * The appearance page's colour SPOTS (VISUAL.156; converted from the
 * verify-chargen-preview-wheel.ts source pin): the face parts paint their
 * Sex_CG palette-set lists; the clothing slots paint the chosen item's
 * StoreColorInformation list — one spot per template, coloured from each
 * template's palette SET, the gradient circle tinted by the selected spot's colour.
 */
describe('GameUI appearance page: colour spots come from the retail per-item colour lists (happy-dom)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let H: any;
  beforeAll(async () => {
    const { mountGameUI } = await import('./_harness/gameui.js');
    H = await mountGameUI();
  });
  afterAll(() => H?.teardown());

  const emptyDesc = () => ({ paletteId: 0, subPalettes: [], textureChanges: [], animPartChanges: [] });
  const gear = (name: string) => ({ name, clothingTable: 0x10000009, weenieDefault: 118 });
  const sex = {
    name: 'Male', scale: 100, setupId: 0x02000001, soundTable: 0, iconImage: 0, basePalette: 0x0400007e, skinPalSet: 0,
    physicsTable: 0, motionTable: 0, combatTable: 0, baseObjDesc: emptyDesc(),
    hairColorList: [0x0f0000a1, 0x0f0000a2], hairStyleList: [{ iconImage: 0, bald: false, alternateSetup: 0, objDesc: emptyDesc() }],
    eyeColorList: [], eyeStripList: [], noseStripList: [], mouthStripList: [],
    headgearList: [gear('Cap')], shirtList: [gear('Shirt')], pantsList: [gear('Pants')], footwearList: [gear('Shoes')],
    clothingColorsList: [9, 6, 4],
  };
  // VISUAL.chargen-swatch-colours — a spot is the average, over its PalSet's
  // palettes, of the part's sample entry (gmCGAppearancePage::SetSelection:
  // clothing 0x520, hair 0xd0). Each mock set holds one palette (id = set)
  // whose two sample entries encode the set, so the spot colour IS the set.
  const swatchPalette = (set: number): number[] => {
    const p = new Array(2048).fill(0xff000000);
    p[0x520] = (0xff000000 | (set & 0xffffff)) >>> 0;
    p[0xd0] = (0xff000000 | (set & 0xffffff)) >>> 0;
    return p;
  };
  const cc: ChargenClothingColors = {
    headgear: { templateIds: [2, 3], palSetIds: [0x0f000002, 0x0f000003] },
    shirt: { templateIds: [4, 6, 9], palSetIds: [0x0f000004, 0x0f000006, 0x0f000009] },
    pants: NO_CLOTHING_COLORS, footwear: NO_CLOTHING_COLORS,
  };

  function render(mode: 'face' | 'clothes', category: string, over: Record<string, number> = {}): HTMLElement {
    const ui = H.ui;
    ui.getTexURL = (id: number) => `tex:${id.toString(16)}`;
    ui.charGen = { heritageGroups: new Map([[Heritage.Aluvian, { genders: new Map([[Gender.Male, sex]]), primaryStartAreas: [] }]]), starterAreas: [] };
    ui.paintChargenShadeDisk = () => {};
    ui.setUIHost({
      characterModelBuilder: { getChargenClothingColors: () => cc, buildCharacterModel: () => null },
      appearanceManager: {
        resolveColors: (set: number) => swatchPalette(set), loadPaletteColors: (pal: number) => swatchPalette(pal),
        loadPaletteSet: (set: number) => ({ paletteList: [set] }),
      },
    });
    // The chargen opens on RandomizeCharacter (gmCharGenMainUI ctor); script it to first entries.
    ui.chargenRandomSource = scriptedRandomSource([0], [0]);
    ui.showCharacterCreate();
    ui.wizard.heritage = Heritage.Aluvian;
    ui.wizard.gender = Gender.Male;
    Object.assign(ui.wizard.appearance, { headgearStyle: 0, shirtStyle: 0, pantsStyle: 0, footwearStyle: 0 }, over);
    ui.wizard.currentStep = 3; // Appearance
    ui.appearMode = mode;
    ui.appearCategory = category;
    ui.renderCharacterCreate();
    return H.container as HTMLElement;
  }
  const spots = (root: HTMLElement) => [...root.querySelectorAll('.appear-spot')] as HTMLElement[];
  const hex = (n: number) => `#${(n & 0xffffff).toString(16).padStart(6, '0')}`;
  const rgb = (n: number) => `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  const bgIs = (el: HTMLElement, set: number) => {
    const bg = el.getAttribute('style') ?? '';
    return bg.includes(hex(set)) || bg.includes(rgb(set));
  };

  it('a clothing slot shows one spot per item template, painted from its palette set; the gradient circle takes the selected spot\'s colour', () => {
    const root = render('clothes', 'shirt', { shirtColor: 1 });
    const s = spots(root);
    expect(s.map((e) => e.dataset.key)).toEqual(['shirtColor', 'shirtColor', 'shirtColor']);
    expect(s.map((e) => e.dataset.value)).toEqual(['0', '1', '2']);
    cc.shirt.palSetIds.forEach((set, i) => expect(bgIs(s[i], set), `spot ${i}: ${s[i].getAttribute('style')}`).toBe(true));
    // The circle (DoGradDisk) is ColorRing × the SELECTED spot's colour.
    const circle = root.querySelector('.chargen-grad-circle') as HTMLElement;
    expect(circle.dataset.color).toBe(hex(0x0f000006));
    expect(root.querySelector('.chargen-shade-disk')?.getAttribute('data-huekey')).toBe('shirtHue');
  });

  it('the headgear slot uses its own item\'s list', () => {
    const s = spots(render('clothes', 'headgear'));
    expect(s.length).toBe(2);
    expect(bgIs(s[1], 0x0f000003)).toBe(true);
  });

  it('the hair colour spots still paint Sex_CG.hairColorList and set hairColor', () => {
    const s = spots(render('face', 'hairStyle'));
    expect(s.map((e) => e.dataset.key)).toEqual(['hairColor', 'hairColor']);
    expect(bgIs(s[1], 0x0f0000a2)).toBe(true);
  });
});
