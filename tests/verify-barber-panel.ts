/**
 * GAP.barber-ui-retail — the barber is gmBarberUI on LayoutDesc 0x21000068,
 * not the hand-built CSS modal FAITHFUL.271 shipped (a 420px div of
 * Current/Default toggles). Drives the real modules:
 *
 *  - BarberModel (InitializePage @ 004e0040, SetSelection @ 004dedf0,
 *    SetColor @ 004deb40, SetShade @ 004de3d0, the ListenToElementMessage
 *    @ 004df260 arms, GenerateBaseAppearanceData @ 005c28d0) against the
 *    real CharacterGenerator / PalSets from portal.dat: the StartBarber DIDs
 *    map back to the same face, an untouched Apply returns the StartBarber
 *    fields, and every Apply passes a port of ACE's
 *    Player_Character.HandleActionFinishBarber validation;
 *  - the DAT layout ground truth (classic_barber 0x21000068 at the smartbox
 *    slot 0x2100000f:0x10000598);
 *  - GameUI.openBarberPanel → BarberPanel rendering that layout through the
 *    real LayoutRenderer in happy-dom: clicks on the DAT elements drive the
 *    page and Apply / Cancel close it;
 *  - dispatchBarberApply (the main.ts Apply sink) and the FinishBarber wire.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { CharacterGenerator } from '../packages/dat-parser/src/file-types/CharacterGenerator.js';
import type { SexCG } from '../packages/dat-parser/src/file-types/CharacterGenerator.js';
import {
  parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes, parseStringTable, registerStringTable, acStringHash,
  getStringFromTable, type ElementDesc,
} from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { readDidMapper } from '../packages/dat-parser/src/file-types/DidMapper.js';
import { AppearanceManager } from '../packages/renderer/src/models/AppearanceManager.js';
import {
  BarberModel, BarberPart, BARBER_ELEMENTS, BARBER_LAYOUT, BARBER_ROOT, BARBER_SETUPS, BARBER_SCRIPTS, BARBER_STRINGS,
  BALD_TEXTURE, EMPYREAN_MOTION, HERITAGE, chargenSetupId, generateBaseAppearanceData, textureMapChange,
  dispatchBarberApply, finishBarberFields, type BarberData, type BarberFace, type BarberPaletteSource,
} from '../packages/renderer/src/ui/BarberModel.js';
import { scriptedRandomSource } from '../packages/renderer/src/ui/ChargenRandomize.js';
import { shadeThumbTop } from '../packages/renderer/src/ui/ChargenColorWheel.js';
import { buildFinishBarberPayload, parseFinishBarberPayload } from '../packages/network/src/MessageSerializer.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);

/** The face ACE stores at creation (PlayerFactory) — what StartBarber echoes back. */
function startBarberFor(heritage: number, sex: SexCG, face: BarberFace, pal: BarberPaletteSource, setup = chargenSetupId(sex, face.hairStyle), option1 = 0): BarberData {
  const app = generateBaseAppearanceData(heritage, sex, face, pal)!;
  const gearOlthoi = heritage === 6 || heritage === 12 || heritage === 13;
  const hairTmc = gearOlthoi ? null : textureMapChange(sex.hairStyleList[face.hairStyle]?.objDesc, 0);
  return {
    paletteBaseDID: app.basePalette, headObjectDID: app.headObject,
    hairTexture: hairTmc?.newTexture ?? 0, defaultHairTexture: hairTmc?.oldTexture ?? 0,
    eyesTextureDID: app.eyesTexture, defaultEyesTextureDID: app.defaultEyesTexture,
    noseTextureDID: app.noseTexture, defaultNoseTextureDID: app.defaultNoseTexture,
    mouthTextureDID: app.mouthTexture, defaultMouthTextureDID: app.defaultMouthTexture,
    skinPaletteDID: app.skinPalette, hairPaletteDID: app.hairPalette, eyesPaletteDID: app.eyesPalette,
    setupTableId: setup, option1, option2: 0,
  };
}

/** Player_Character.HandleActionFinishBarber's validation (ACE), ported for the test. */
function aceAccepts(heritage: number, gender: number, sex: SexCG, f: BarberData, pal: BarberPaletteSource): string[] {
  const bad: string[] = [];
  const gearOlthoi = heritage === 6 || heritage === 12 || heritage === 13;
  if (sex.basePalette !== f.paletteBaseDID) bad.push('paletteBase');
  let hs: SexCG['hairStyleList'][number] | undefined;
  let headOk = f.headObjectDID === 0 && gearOlthoi;
  if (!headOk) {
    hs = sex.hairStyleList.find((h) => h.objDesc.animPartChanges.some((a) => a.partId === f.headObjectDID));
    headOk = hs !== undefined;
  }
  if (!headOk) bad.push('headObject');
  const bald = hs?.bald ?? false;
  const eyeOk = (tex: number, old: boolean): boolean => sex.eyeStripList.some((e) =>
    (bald ? e.objDescBald : e.objDesc).textureChanges.some((t) => (old ? t.oldTexture : t.newTexture) === tex));
  const faceOk = (strips: SexCG['noseStripList'], tex: number, old: boolean): boolean => strips.some((s) =>
    s.objDesc.textureChanges.some((t) => (old ? t.oldTexture : t.newTexture) === tex));
  const hairOk = (tex: number, old: boolean): boolean => {
    if (tex === 0 && gearOlthoi) return true;
    if (!hs) return false;
    return hs.objDesc.textureChanges.some((t) => (old ? t.oldTexture : t.newTexture) === tex);
  };
  if (!eyeOk(f.eyesTextureDID, false)) bad.push('eyes');
  if (!eyeOk(f.defaultEyesTextureDID, true)) bad.push('defaultEyes');
  if (!faceOk(sex.noseStripList, f.noseTextureDID, false)) bad.push('nose');
  if (!faceOk(sex.noseStripList, f.defaultNoseTextureDID, true)) bad.push('defaultNose');
  if (!faceOk(sex.mouthStripList, f.mouthTextureDID, false)) bad.push('mouth');
  if (!faceOk(sex.mouthStripList, f.defaultMouthTextureDID, true)) bad.push('defaultMouth');
  if (!hairOk(f.hairTexture, false)) bad.push('hairTexture');
  if (!hairOk(f.defaultHairTexture, true)) bad.push('defaultHairTexture');
  if (!pal.loadPaletteSet(sex.skinPalSet)?.paletteList.includes(f.skinPaletteDID)) bad.push('skinPalette');
  if (!sex.eyeColorList.includes(f.eyesPaletteDID)) bad.push('eyesPalette');
  if (!sex.hairColorList.some((id) => pal.loadPaletteSet(id)?.paletteList.includes(f.hairPaletteDID))) bad.push('hairPalette');
  const S = BARBER_SETUPS;
  const extra: Record<number, Record<number, number[]>> = {
    5: { 1: [S.umbraenMaleCrown, S.umbraenMaleNoCrown], 2: [S.umbraenFemaleCrown, S.umbraenFemaleNoCrown] },
    10: { 1: [S.penumbraenMaleCrown, S.penumbraenMaleNoCrown], 2: [S.penumbraenFemaleCrown, S.penumbraenFemaleNoCrown] },
    11: {
      1: [S.undeadMaleSkeleton, S.undeadMaleSkeletonNoFlame, S.undeadMaleZombie, S.undeadMaleZombieNoFlame],
      2: [S.undeadFemaleSkeleton, S.undeadFemaleSkeletonNoFlame, S.undeadFemaleZombie, S.undeadFemaleZombieNoFlame],
    },
  };
  const setupOk = (hs && hs.alternateSetup > 0 && hs.alternateSetup === f.setupTableId)
    || sex.setupId === f.setupTableId
    || (extra[heritage]?.[gender] ?? []).includes(f.setupTableId);
  if (!setupOk) bad.push('setup');
  return bad;
}

describe.skipIf(!hasDats)('GAP.barber-ui-retail — gmBarberUI model on the real CharGen data', () => {
  let charGen: CharacterGenerator;
  let pal: AppearanceManager;
  const sexOf = (h: number, g: number): SexCG => charGen.heritageGroups.get(h)!.genders.get(g)!;
  const open = (h: number, g: number, data: BarberData): BarberModel => {
    const m = new BarberModel(h, g, sexOf(h, g), pal);
    m.dressPreview(scriptedRandomSource([0], [0]));
    m.initializePage(data);
    return m;
  };
  const faceFor = (sex: SexCG, seed: number): BarberFace => ({
    hairStyle: seed % sex.hairStyleList.length,
    hairColor: seed % Math.max(1, sex.hairColorList.length),
    hairShade: 0.5,
    eyesStrip: (seed + 1) % sex.eyeStripList.length,
    eyeColor: (seed + 2) % Math.max(1, sex.eyeColorList.length),
    noseStrip: (seed + 1) % Math.max(1, sex.noseStripList.length),
    mouthStrip: (seed + 2) % Math.max(1, sex.mouthStripList.length),
    skinShade: 0.25,
  });

  beforeAll(() => {
    const portal = openDat(DAT_PATHS.portal);
    charGen = new CharacterGenerator(new DatReader(portal.getFileData(0x0E000002)!));
    pal = new AppearanceManager(portal);
  });

  it('every heritage / gender: the StartBarber DIDs map back to the face and an untouched Apply returns them (InitializePage ∘ GenerateBaseAppearanceData)', () => {
    let checked = 0;
    for (const [h, group] of charGen.heritageGroups) {
      for (const [g, sex] of group.genders) {
        if (sex.hairStyleList.length === 0 || sex.eyeStripList.length === 0) continue;
        for (const seed of [0, 1, 3]) {
          const face = faceFor(sex, seed);
          const data = startBarberFor(h, sex, face, pal);
          const m = open(h, g, data);
          const hairPal = pal.loadPaletteSet(sex.hairColorList[face.hairColor])!;
          // The shade comes back as (index + 1) / num_pals of the palette GetPaletteID picked.
          const hairIdx = hairPal.paletteList.indexOf(data.hairPaletteDID);
          expect(m.face.hairColor, `${h}/${g}`).toBe(face.hairColor);
          expect(m.face.hairShade).toBeCloseTo((hairIdx + 1) / hairPal.paletteList.length, 12);
          expect(m.face.eyeColor).toBe(face.eyeColor);
          const result = m.apply();
          expect(result.fields, `${h}/${g} seed ${seed}`).toEqual(data);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('Apply after edits always passes ACE HandleActionFinishBarber validation', () => {
    for (const [h, group] of charGen.heritageGroups) {
      for (const [g, sex] of group.genders) {
        if (sex.hairStyleList.length === 0 || sex.eyeStripList.length === 0) continue;
        const m = open(h, g, startBarberFor(h, sex, faceFor(sex, 0), pal));
        m.clickArrow(BarberPart.Hair, 1);
        m.clickArrow(BarberPart.Eyes, -1);
        m.clickArrow(BarberPart.Mouth, 1);
        m.clickRow(BarberPart.Hair);
        m.clickSpot(Math.max(0, sex.hairColorList.length - 1));
        m.scrollShade(0.9);
        m.clickRow(BarberPart.Skin);
        m.scrollShade(0.1);
        if (m.options[0].visible) m.clickOption1();
        const { fields } = m.apply();
        expect(fields, `${h}/${g}`).not.toBeNull();
        expect(aceAccepts(h, g, sex, fields!, pal), `${h}/${g}`).toEqual([]);
      }
    }
  });

  it('the row arrows step the style with wrap-around and the colour wheel follows the part (SetSelection)', () => {
    const sex = sexOf(1, 1);
    const m = open(1, 1, startBarberFor(1, sex, faceFor(sex, 0), pal));
    expect(m.curPart).toBe(BarberPart.Hair);
    expect(m.selectedRow).toBe(BARBER_ELEMENTS.hairRow);
    m.clickArrow(BarberPart.Hair, -1);
    expect(m.face.hairStyle).toBe(sex.hairStyleList.length - 1);
    expect(m.apply().fields!.headObjectDID).toBe(sex.hairStyleList[sex.hairStyleList.length - 1].objDesc.animPartChanges[0].partId);
    m.clickArrow(BarberPart.Hair, 1);
    expect(m.face.hairStyle).toBe(0);
    // Hair: one bullet per hair colour, the shade scroll and the tinted ColorRing.
    expect(m.wheel.spotCount).toBe(sex.hairColorList.length);
    expect(m.wheel.shadeVisible).toBe(true);
    expect(m.wheel.gradPlug).toBe(false);
    expect(m.wheel.gradColor).toEqual(m.wheel.spotColors[m.face.hairColor]);
    // Eyes: the eye colours, the GradientPlug, no shade scroll.
    m.clickRow(BarberPart.Eyes);
    expect(m.selectedRow).toBe(BARBER_ELEMENTS.eyesRow);
    expect(m.wheel.spotCount).toBe(sex.eyeColorList.length);
    expect(m.wheel.gradPlug).toBe(true);
    expect(m.wheel.shadeVisible).toBe(false);
    // A spot past iNumColors does nothing; one inside sets the eye colour.
    m.clickSpot(sex.eyeColorList.length);
    m.clickSpot(0);
    expect(m.face.eyeColor).toBe(0);
    expect(m.apply().fields!.eyesPaletteDID).toBe(sex.eyeColorList[0]);
    // Nose / mouth / skin: one spot (the skin PalSet), and the scroll is the SKIN shade.
    m.clickRow(BarberPart.Nose);
    expect(m.wheel.spotCount).toBe(1);
    expect(m.wheel.currentColor).toBe(0);
    m.scrollShade(1);
    expect(m.face.skinShade).toBe(1);
    const skin = pal.loadPaletteSet(sex.skinPalSet)!;
    expect(m.apply().fields!.skinPaletteDID).toBe(skin.paletteList[skin.paletteList.length - 1]);
    m.scrollShade(-3);
    expect(m.face.skinShade).toBe(0);
    // The skin row's arrows are ghosted: no style to step.
    const before = { ...m.face };
    m.clickArrow(BarberPart.Skin, 1);
    expect(m.face).toEqual(before);
  });

  it('a bald hair texture selects the bald eye strips (GetEyeStripIndexFromID bald = hair texture == BALD_TEXTURE)', () => {
    for (const [h, group] of charGen.heritageGroups) {
      for (const [g, sex] of group.genders) {
        const baldStyle = sex.hairStyleList.findIndex((s) => s.bald);
        if (baldStyle < 0) continue;
        const face = { ...faceFor(sex, 0), hairStyle: baldStyle, eyesStrip: sex.eyeStripList.length - 1 };
        const data = startBarberFor(h, sex, face, pal);
        const m = open(h, g, data);
        expect(m.face.hairStyle, `${h}/${g}`).toBe(baldStyle);
        expect(m.face.eyesStrip).toBe(face.eyesStrip);
        expect(data.hairTexture).toBe(BALD_TEXTURE);
        return;
      }
    }
  });

  it('Gearknight: nose / mouth rows hidden, gear labels, eyes arrows ghosted, Skin row at y 88, the gear camera, no options', () => {
    const sex = sexOf(HERITAGE.Gearknight, 1);
    const m = open(HERITAGE.Gearknight, 1, startBarberFor(HERITAGE.Gearknight, sex, faceFor(sex, 0), pal));
    const E = BARBER_ELEMENTS;
    expect([...m.hiddenRows].sort()).toEqual([E.noseRow, E.mouthRow].sort());
    expect(m.rowLabels.get(E.hairRow)).toBe('gearHair');
    expect(m.rowLabels.get(E.eyesRow)).toBe('gearEyes');
    expect(m.rowLabels.get(E.skinRow)).toBe('gearSkin');
    expect(m.ghostedArrowRows.has(E.eyesRow)).toBe(true);
    expect(m.skinRowY).toBe(88);
    expect(m.camera).toEqual([0, -0.8, 1.5]);
    expect(m.options.every((o) => !o.visible)).toBe(true);
    expect(m.applyPos).toEqual({ x: 352, y: 274 });
    expect(m.cancelPos).toEqual({ x: 232, y: 274 });
    const strips = m.face.eyesStrip;
    m.clickArrow(BarberPart.Eyes, 1);
    expect(m.face.eyesStrip).toBe(strips);
    const fields = m.apply().fields!;
    expect(fields.headObjectDID).toBe(0);
    expect([fields.hairTexture, fields.defaultHairTexture]).toEqual([0, 0]);
  });

  it('Empyrean: "Suppress Levitation" mirrors option1; Apply sends it and picks the bound / float motion table', () => {
    const sex = sexOf(HERITAGE.Empyrean, 2);
    const data = startBarberFor(HERITAGE.Empyrean, sex, faceFor(sex, 0), pal, undefined, 1);
    const m = open(HERITAGE.Empyrean, 2, data);
    expect(m.options[0]).toEqual({ visible: true, label: 'empyreanOption', checked: true });
    expect(m.applyPos).toEqual({ x: 352, y: 298 });
    expect(m.cancelPos).toEqual({ x: 232, y: 298 });
    let r = m.apply();
    expect(r.fields!.option1).toBe(1);
    expect(r.effects.motionTableId).toBe(EMPYREAN_MOTION.female);
    m.clickOption1();
    r = m.apply();
    expect(r.fields!.option1).toBe(0);
    expect(r.effects.motionTableId).toBe(EMPYREAN_MOTION.femaleFloat);
  });

  it('Undead: the server setup drives the view and the checkbox; Apply swaps flame / no-flame setups and scripts', () => {
    const sex = sexOf(HERITAGE.Undead, 1);
    const zombieStyle = sex.hairStyleList.findIndex((s) => s.alternateSetup === BARBER_SETUPS.undeadMaleZombie);
    const skelStyle = sex.hairStyleList.findIndex((s) => s.alternateSetup === BARBER_SETUPS.undeadMaleSkeleton);
    expect(zombieStyle).toBeGreaterThanOrEqual(0);
    expect(skelStyle).toBeGreaterThanOrEqual(0);
    const face = { ...faceFor(sex, 0), hairStyle: zombieStyle };
    const m = open(HERITAGE.Undead, 1, startBarberFor(HERITAGE.Undead, sex, face, pal, BARBER_SETUPS.undeadMaleZombieNoFlame));
    expect(m.options[0]).toEqual({ visible: true, label: 'undeadOption', checked: true });
    expect(m.previewSetupId).toBe(BARBER_SETUPS.undeadMaleZombieNoFlame);
    let r = m.apply();
    expect(r.fields!.setupTableId).toBe(BARBER_SETUPS.undeadMaleZombieNoFlame);
    expect(r.effects).toEqual({ destroyParticles: true, playScript: BARBER_SCRIPTS.undeadNoFlame });
    m.clickOption1(); // flames back on: the view returns to GetSetupID
    expect(m.previewSetupId).toBe(BARBER_SETUPS.undeadMaleZombie);
    r = m.apply();
    expect(r.fields!.setupTableId).toBe(BARBER_SETUPS.undeadMaleZombie);
    expect(r.effects.playScript).toBe(BARBER_SCRIPTS.undeadMaleZombie);
    // A skeleton face (second TextureMapChange) round-trips too.
    const skel = open(HERITAGE.Undead, 1, startBarberFor(HERITAGE.Undead, sex, { ...face, hairStyle: skelStyle }, pal, BARBER_SETUPS.undeadMaleSkeleton));
    expect(skel.options[0].checked).toBe(false);
    expect(skel.face.hairStyle).toBe(skelStyle);
    expect(skel.apply().effects.playScript).toBe(BARBER_SCRIPTS.undeadMaleSkeleton);
  });

  it('Shadowbound / Penumbraen: "Suppress Crown" picks the no-crown setups', () => {
    const umb = sexOf(HERITAGE.Shadowbound, 2);
    const m = open(HERITAGE.Shadowbound, 2, startBarberFor(HERITAGE.Shadowbound, umb, faceFor(umb, 0), pal, BARBER_SETUPS.umbraenFemaleCrown));
    expect(m.options[0]).toEqual({ visible: true, label: 'shadowOption', checked: false });
    expect(m.apply().effects.playScript).toBe(BARBER_SCRIPTS.umbraenFemaleCrown);
    m.clickOption1();
    expect(m.previewSetupId).toBe(BARBER_SETUPS.umbraenFemaleNoCrown);
    expect(m.apply().fields!.setupTableId).toBe(BARBER_SETUPS.umbraenFemaleNoCrown);
    const pen = sexOf(HERITAGE.Penumbraen, 1);
    const p = open(HERITAGE.Penumbraen, 1, startBarberFor(HERITAGE.Penumbraen, pen, faceFor(pen, 0), pal, BARBER_SETUPS.penumbraenMaleNoCrown));
    expect(p.options[0].checked).toBe(true);
    const r = p.apply();
    expect(r.fields!.setupTableId).toBe(BARBER_SETUPS.penumbraenMaleNoCrown);
    expect(r.effects).toEqual({ destroyParticles: true, playScript: 0 });
  });

  it('the preview wears a fresh clothing roll without headgear (RandomizeCharacter(true) + SetHeadgearStyle(−1))', () => {
    const sex = sexOf(1, 2);
    const m = open(1, 2, startBarberFor(1, sex, faceFor(sex, 2), pal));
    const a = m.appearanceInfo();
    expect(a.headgearStyle).toBe(-1);
    expect(a.shirtStyle).toBeGreaterThanOrEqual(0);
    expect(a.hairStyle).toBe(m.face.hairStyle);
    expect(a.hairHue).toBe(m.face.hairShade);
    expect(a.skinHue).toBe(m.face.skinShade);
  });
});

describe.skipIf(!hasDats)('GAP.barber-ui-retail — DAT ground truth', () => {
  let resolveEl: (layout: number, id: number) => ElementDesc | undefined;
  beforeAll(() => {
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    setMasterPropertyTypes(parseMasterProperty(portal.getReader(0x39000001)));
    for (const t of [0x23000001, 0x23000002]) registerStringTable(parseStringTable(local.getReader(t)));
    resolveEl = (layout, id) => {
      const find = (m: Map<number, ElementDesc>): ElementDesc | undefined => {
        for (const e of m.values()) {
          if (e.elementId === id) return e;
          const hit = find(e.children);
          if (hit) return hit;
        }
        return undefined;
      };
      return find(parseLayoutDesc(local.getReader(layout)).elements);
    };
  });

  it('UILAYOUT enum 0x10000099 "classic_barber" is 0x21000068; root 0x10000599 is type 0x1000004a (gmBarberUI::Register) 500x440', () => {
    const portal = openDat(DAT_PATHS.portal);
    const m = readDidMapper(new DatReader(portal.getFileData(0x2500000e)!));
    expect(m.client.enumToId.get(0x10000099)).toBe(BARBER_LAYOUT);
    expect(m.client.enumToName.get(0x10000099)).toBe('classic_barber');
    const root = resolveEl(BARBER_LAYOUT, BARBER_ROOT)!;
    expect(root.type >>> 0).toBe(0x1000004a);
    expect([root.width, root.height]).toEqual([500, 440]);
    for (const id of Object.values(BARBER_ELEMENTS)) expect(resolveEl(BARBER_LAYOUT, id), `0x${id.toString(16)}`).toBeDefined();
  });

  it('the smartbox 0x2100000f instances the page as 0x10000598 at (20, 20)', () => {
    const slot = resolveEl(0x2100000f, 0x10000598)!;
    expect([slot.x, slot.y, slot.width, slot.height]).toEqual([20, 20, 500, 440]);
    expect([slot.baseLayout >>> 0, slot.baseElement >>> 0]).toEqual([BARBER_LAYOUT, BARBER_ROOT]);
  });

  it('every label token resolves in its table', () => {
    const expected: Record<string, string> = {
      empyreanOption: 'Suppress Levitation', undeadOption: 'Suppress Flames', shadowOption: 'Suppress Crown',
      gearHair: 'Body Style', gearEyes: 'Trim Color', gearSkin: 'Gear Color',
      olthoiHair: 'Body Style', olthoiEyes: 'Eyes', olthoiSkin: 'Markings',
    };
    for (const [k, v] of Object.entries(BARBER_STRINGS)) {
      expect(getStringFromTable(v.table, acStringHash(v.token)), k).toBe(expected[k]);
    }
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1280, innerHeight: 800 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

describe.skipIf(!hasDats)('GAP.barber-ui-retail — GameUI.openBarberPanel renders 0x21000068 (happy-dom + DATs)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  let sex: SexCG;
  let data: BarberData;
  let face: BarberFace;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions');
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    setMasterPropertyTypes(parseMasterProperty(portal.getReader(0x39000001)));
    for (const t of [0x23000001, 0x23000002]) registerStringTable(parseStringTable(local.getReader(t)));
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { UITextureLoader } = await import('../packages/renderer/src/ui/UITextureLoader.js');
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const layoutRenderer = new LayoutRenderer(local, new UITextureLoader(new TextureManager(portal)));
    layoutRenderer.getTextureDataURLWithAlpha = () => null;
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container, {}, portal, undefined, undefined, undefined, null, layoutRenderer);
    ui.showGame();
    const charGen = new CharacterGenerator(new DatReader(portal.getFileData(0x0E000002)!));
    sex = charGen.heritageGroups.get(1)!.genders.get(1)!;
    face = { hairStyle: 1, hairColor: 1, hairShade: 0.5, eyesStrip: 1, eyeColor: 1, noseStrip: 1, mouthStrip: 1, skinShade: 0.5 };
    data = startBarberFor(1, sex, face, new AppearanceManager(portal));
  });

  afterAll(() => {
    ui?.barberPanelEl && ui.barberPanelEl.remove();
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  const q = (sel: string): HTMLElement | null => ui.barberPanelEl?.querySelector(sel) ?? null;
  const el = (id: number): HTMLElement | null => q(`[data-element-id="0x${id.toString(16)}"]`);
  const click = (n: HTMLElement | null): void => { expect(n).not.toBeNull(); n!.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true })); };

  it('opens the DAT page at the smartbox slot, with the rows lit and labelled from the layout', () => {
    ui.openBarberPanel(data, { heritage: 1, gender: 1 }, () => {});
    const root = ui.barberPanelEl as HTMLElement;
    expect(root.dataset.layoutId).toBe('0x21000068');
    const wrapper = root.parentElement as HTMLElement;
    expect([wrapper.style.left, wrapper.style.top]).toEqual(['20px', '20px']);
    expect(el(BARBER_ROOT)).not.toBeNull();
    expect(el(BARBER_ELEMENTS.hairRow)!.dataset.acState).toBe('6');
    expect(el(BARBER_ELEMENTS.eyesRow)!.dataset.acState).not.toBe('6');
    expect(el(BARBER_ELEMENTS.hairRow)!.textContent + (el(BARBER_ELEMENTS.hairRow)!.querySelector('[data-ac-run-text]') as HTMLElement | null)?.dataset.acRunText).toContain('Hair Style');
    // The 3D view 0x1000059b hosts the gmCG3DView canvas.
    expect(el(BARBER_ELEMENTS.viewport)!.querySelector('canvas')).not.toBeNull();
    // Hair: one bullet per hair colour, the rest ColorEmpty; only the current colour's pointer shows.
    const kinds = Array.from({ length: 9 }, (_, i) => el(0x1000030f + i)!.dataset.barberSpotKind);
    expect(kinds.filter((k) => k === 'bullet').length).toBe(Math.min(9, sex.hairColorList.length));
    for (let i = 0; i < 9; i++) expect(el(0x10000318 + i)!.style.display === 'none', `pointer ${i}`).toBe(i !== face.hairColor);
    // Aluvian: no option row; Apply / Cancel on y 274.
    expect(el(BARBER_ELEMENTS.option1)!.style.display).toBe('none');
    expect([el(BARBER_ELEMENTS.apply)!.style.left, el(BARBER_ELEMENTS.apply)!.style.top]).toEqual(['352px', '274px']);
  });

  it('clicks on the DAT elements drive the page: row → selection, arrow → style, spot → colour', () => {
    const applied: unknown[] = [];
    ui.openBarberPanel(data, { heritage: 1, gender: 1 }, (r: unknown) => applied.push(r));
    click(el(BARBER_ELEMENTS.eyesRow));
    expect(el(BARBER_ELEMENTS.eyesRow)!.dataset.acState).toBe('6');
    expect(el(BARBER_ELEMENTS.hairRow)!.dataset.acState).toBe('1');
    expect(el(0x1000030e)!.dataset.barberDisk).toBe('plug');
    expect(el(0x10000321)!.style.display).toBe('none');
    click(el(0x1000030f)); // eye colour 0
    const hairRow = el(BARBER_ELEMENTS.hairRow)!;
    click(hairRow.querySelector('[data-barber-arrow="next"]') as HTMLElement);
    expect(el(BARBER_ELEMENTS.hairRow)!.dataset.acState).toBe('6');
    click(el(BARBER_ELEMENTS.apply));
    expect(ui.barberPanelEl).toBeNull();
    expect(applied).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fields = (applied[0] as any).fields as BarberData;
    expect(fields.headObjectDID).toBe(sex.hairStyleList[2].objDesc.animPartChanges[0].partId);
    expect(fields.eyesPaletteDID).toBe(sex.eyeColorList[0]);
    expect(fields.noseTextureDID).toBe(data.noseTextureDID);
  });

  it('the shade thumb, the rotate toggles and the Empyrean option row are the DAT widgets', () => {
    ui.openBarberPanel(data, { heritage: 1, gender: 1 }, () => {});
    const scroll = el(0x10000321)!;
    expect(scroll.style.display).toBe('');
    const thumb = scroll.querySelector(':scope > [data-element-id="0x1"]') as HTMLElement;
    expect(thumb).not.toBeNull();
    expect(thumb.style.top).toBe(`${shadeThumbTop(Number(scroll.dataset.barberShade))}px`);
    click(el(BARBER_ELEMENTS.rotateClockwise));
    expect(el(BARBER_ELEMENTS.rotateClockwise)!.dataset.acState).toBe('6');
    click(el(BARBER_ELEMENTS.rotateCounterClockwise));
    expect(el(BARBER_ELEMENTS.rotateClockwise)!.dataset.acState).toBe('1');
    expect(el(BARBER_ELEMENTS.rotateCounterClockwise)!.dataset.acState).toBe('6');
    click(el(BARBER_ELEMENTS.cancel));

    const emp = (ui.characterGenerator as CharacterGenerator).heritageGroups.get(HERITAGE.Empyrean)!.genders.get(1)!;
    const empData = startBarberFor(HERITAGE.Empyrean, emp, { ...face, hairStyle: 0 }, new AppearanceManager(openDat(DAT_PATHS.portal)), undefined, 1);
    const results: Array<{ fields: BarberData | null }> = [];
    ui.openBarberPanel(empData, { heritage: HERITAGE.Empyrean, gender: 1 }, (r: { fields: BarberData | null }) => results.push(r));
    const opt = el(BARBER_ELEMENTS.option1)!;
    expect(opt.style.display).toBe('');
    expect(opt.textContent + ((opt.querySelector('[data-ac-run-text]') as HTMLElement | null)?.dataset.acRunText ?? '')).toContain('Suppress Levitation');
    expect(opt.dataset.barberChecked).toBe('1');
    expect((opt.querySelector(':scope > [data-element-id="0x10000328"]') as HTMLElement).dataset.acState).toBe('6');
    expect([el(BARBER_ELEMENTS.apply)!.style.top, el(BARBER_ELEMENTS.cancel)!.style.top]).toEqual(['298px', '298px']);
    click(opt);
    expect(opt.dataset.barberChecked).toBe('0');
    click(el(BARBER_ELEMENTS.apply));
    expect(results[0].fields!.option1).toBe(0);
  });

  it('Cancel hides the page without applying; a second StartBarber replaces the page', () => {
    let applied = 0;
    ui.openBarberPanel(data, { heritage: 1, gender: 1 }, () => { applied++; });
    const first = ui.barberPanelEl as HTMLElement;
    ui.openBarberPanel(data, { heritage: 1, gender: 1 }, () => { applied++; });
    expect(first.isConnected).toBe(false);
    expect(domWindow.document.querySelectorAll('[data-layout-id="0x21000068"]').length).toBe(1);
    click(el(BARBER_ELEMENTS.cancel));
    expect(ui.barberPanelEl).toBeNull();
    expect(applied).toBe(0);
  });

  it('the hand-built modal is gone', () => {
    ui.openBarberPanel(data, { heritage: 1, gender: 1 }, () => {});
    expect(domWindow.document.getElementById('barber-panel')).toBeNull();
    expect(q('[data-barber-toggle]')).toBeNull();
    click(el(BARBER_ELEMENTS.cancel));
  });
});

describe('GAP.barber-ui-retail — Apply world sink + FinishBarber wire', () => {
  const fields: BarberData = {
    paletteBaseDID: 0x0400007e, headObjectDID: 0x010004c5, hairTexture: 0x05001111, defaultHairTexture: 0x05002222,
    eyesTextureDID: 0x05003333, defaultEyesTextureDID: 0x05004444, noseTextureDID: 0x05005555, defaultNoseTextureDID: 0x05005556,
    mouthTextureDID: 0x05006666, defaultMouthTextureDID: 0x05007777, skinPaletteDID: 0x04000111, hairPaletteDID: 0x04000222,
    eyesPaletteDID: 0x04000333, setupTableId: 0x02001a9d, option1: 1, option2: 0,
  };

  it('dispatchBarberApply runs destroy_particle_manager, play_script, then Event_FinishBarber', () => {
    const calls: string[] = [];
    const sinks = {
      destroyPlayerParticles: () => calls.push('destroy'),
      playPlayerScript: (id: number) => calls.push(`script:${id.toString(16)}`),
      finishBarber: (f: ReturnType<typeof finishBarberFields>) => calls.push(`finish:${f.setupTableId.toString(16)}`),
    };
    dispatchBarberApply({ fields, effects: { destroyParticles: true, playScript: 0x330012d3 } }, sinks);
    expect(calls).toEqual(['destroy', 'script:330012d3', 'finish:2001a9d']);
    calls.length = 0;
    dispatchBarberApply({ fields: null, effects: { destroyParticles: false, playScript: 0 } }, sinks);
    expect(calls).toEqual([]);
  });

  it('the FinishBarber payload carries the 16 fields in StartBarber order', () => {
    const parsed = parseFinishBarberPayload(buildFinishBarberPayload(finishBarberFields(fields)));
    expect(parsed).toEqual({
      paletteBaseId: fields.paletteBaseDID, headObjectDID: fields.headObjectDID,
      hairTexture: fields.hairTexture, defaultHairTexture: fields.defaultHairTexture,
      eyesTextureDID: fields.eyesTextureDID, defaultEyesTextureDID: fields.defaultEyesTextureDID,
      noseTextureDID: fields.noseTextureDID, defaultNoseTextureDID: fields.defaultNoseTextureDID,
      mouthTextureDID: fields.mouthTextureDID, defaultMouthTextureDID: fields.defaultMouthTextureDID,
      skinPaletteDID: fields.skinPaletteDID, hairPaletteDID: fields.hairPaletteDID, eyesPaletteDID: fields.eyesPaletteDID,
      setupTableId: fields.setupTableId, optionBound: 1, optionUnk: 0,
    });
  });
});
