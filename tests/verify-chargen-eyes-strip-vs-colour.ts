/**
 * BUG.chargen-eyes-strip-sent-as-eye-colour — the char-gen wizard kept one
 * `eyeColor` field that was really the eyes STRIP and sent it as both the
 * wire's Eyes and EyeColor. Retail CharGenState keeps eyesStrip and eyeColor
 * apart (Reset @ 005c68a0 −1s both; RandomizeAppearance @ 005c4f10 rolls the
 * strip over mEyeStripList and the colour over mEyeColorList); ACE reads
 * Eyes → GetEyeTexture (PlayerFactory.cs:77) and EyeColor →
 * sex.EyeColorList[EyeColor] (PlayerFactory.cs:100).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { buildCharacterCreate } from '@ac/network';
import { Gender, Heritage } from '@ac/shared';
import type { AppearanceInfo } from '@ac/shared';
import { CharacterCreateWizard, characterCreateAppearance } from '../packages/renderer/src/ui/CharacterCreate.js';
import {
  appearanceRollLists, defaultRandomSource, randomizeAppearance, resetAppearance, scriptedRandomSource, RETAIL_RAND_MAX,
} from '../packages/renderer/src/ui/ChargenRandomize.js';
import { CharacterModelBuilder } from '../packages/renderer/src/models/CharacterModelBuilder.js';

const randFor = (draw: number, n: number): number => Math.ceil((draw * (RETAIL_RAND_MAX + 1)) / n);

function appearance(over: Partial<AppearanceInfo> = {}): AppearanceInfo {
  return {
    hairStyle: 0, hairColor: 0, eyesStrip: 0, eyeColor: 0, skinColor: 0, noseStyle: 0, mouthStyle: 0,
    headgearStyle: 0, headgearColor: 0, shirtStyle: 0, shirtColor: 0, pantsStyle: 0, pantsColor: 0,
    footwearStyle: 0, footwearColor: 0, ...over,
  };
}

/** Find the little-endian uint32 run `seq` in `bytes`; −1 when absent. */
function findUInt32Run(bytes: Uint8Array, seq: number[]): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  outer: for (let i = 0; i + seq.length * 4 <= bytes.length; i++) {
    for (let k = 0; k < seq.length; k++) if (dv.getUint32(i + k * 4, true) !== seq[k]) continue outer;
    return i;
  }
  return -1;
}

describe('BUG.chargen-eyes-strip-sent-as-eye-colour — the wire', () => {
  it('the wizard\'s eyesStrip goes out as Eyes and its eyeColor as EyeColor, in ACE Appearance.Unpack order', () => {
    const w = new CharacterCreateWizard();
    w.appearance.eyesStrip = 9;
    w.appearance.eyeColor = 2;
    w.appearance.noseStyle = 0x22; w.appearance.mouthStyle = 0x33; w.appearance.hairColor = 0x44; w.appearance.hairStyle = 0x66;
    const wire = characterCreateAppearance(w.appearance);
    expect(wire.eyes).toBe(9);
    expect(wire.eyeColor).toBe(2);
    const bytes = buildCharacterCreate({
      accountName: 'testacjs', heritage: Heritage.Aluvian, gender: Gender.Male, appearance: wire,
      templateOption: 0, strength: 10, endurance: 10, coordination: 10, quickness: 10, focus: 10, self: 10,
      characterSlot: 0, classId: 1, skills: [], name: 'Eyes', startArea: 0,
    });
    // Eyes, Nose, Mouth, HairColor, EyeColor, HairStyle (ACE.Entity/Appearance.cs:30-35).
    expect(findUInt32Run(bytes, [9, 0x22, 0x33, 0x44, 2, 0x66])).toBeGreaterThan(0);
  });
});

describe('BUG.chargen-eyes-strip-sent-as-eye-colour — the rolls', () => {
  it('Reset −1s both; RandomizeAppearance rolls the strip over the strip list and the colour over the colour list, each in range', () => {
    const w = new CharacterCreateWizard();
    resetAppearance(w.appearance);
    expect(w.appearance.eyesStrip).toBe(-1);
    expect(w.appearance.eyeColor).toBe(-1);
    const lists = appearanceRollLists({
      hairStyleList: [1], hairColorList: [1], eyeStripList: new Array(19).fill(0), eyeColorList: [1, 2, 3],
      noseStripList: [], mouthStripList: [], headgearList: [], shirtList: [], pantsList: [], footwearList: [], clothingColorsList: [],
    });
    expect(lists.eyeStripCount).toBe(19);
    expect(lists.eyeColorCount).toBe(3);
    // Any roll keeps each index inside its own list.
    const src = defaultRandomSource();
    for (let i = 0; i < 200; i++) {
      randomizeAppearance(src, w.appearance, lists);
      expect(w.appearance.eyesStrip).toBeGreaterThanOrEqual(0);
      expect(w.appearance.eyesStrip).toBeLessThan(19);
      expect(w.appearance.eyeColor).toBeGreaterThanOrEqual(0);
      expect(w.appearance.eyeColor).toBeLessThan(3);
    }
    // The top draw of each list: strip 18, colour 2 — two independent draws
    // (strip, skin shade, hair shade, eye colour with the hair lists empty).
    const a = new CharacterCreateWizard().appearance;
    a.eyesStrip = -1; a.eyeColor = -1;
    randomizeAppearance(scriptedRandomSource([randFor(18, 19), 0, 0, randFor(2, 3)]), a, { ...lists, hairColorCount: 0, hairStyleCount: 0 });
    expect(a.eyesStrip).toBe(18);
    expect(a.eyeColor).toBe(2);
  });
});

describe('BUG.chargen-eyes-strip-sent-as-eye-colour — the model builder', () => {
  const EYE_PART = 16;
  const OLD_EYE_TEX = 0x05000001;
  const emptyDesc = () => ({ paletteId: 0, subPalettes: [], textureChanges: [], animPartChanges: [] });
  const strip = (i: number) => ({
    iconImage: 0,
    objDesc: { paletteId: 0, subPalettes: [{ subId: 0, offset: i, numColors: 1 }], textureChanges: [{ partIndex: EYE_PART, oldTexture: OLD_EYE_TEX, newTexture: 0x05000100 + i }], animPartChanges: [] },
    objDescBald: emptyDesc(),
  });
  const EYE_COLOURS = [0x04000a00, 0x04000a01, 0x04000a02];
  const sex = {
    setupId: 0x02000001, basePalette: 0x04000001, skinPalSet: 0, baseObjDesc: emptyDesc(),
    hairStyleList: [{ iconImage: 0, bald: false, alternateSetup: 0, objDesc: emptyDesc() }], hairColorList: [],
    eyeStripList: Array.from({ length: 12 }, (_, i) => strip(i)), eyeColorList: EYE_COLOURS,
    noseStripList: [], mouthStripList: [], headgearList: [], shirtList: [], pantsList: [], footwearList: [],
  };

  it('picks eyeStripList[eyesStrip] for the eye texture and eyeColorList[eyeColor] for its palette', () => {
    const calls: Array<{ tex?: Map<number, Map<number, number>>; pal?: number[] }> = [];
    const builder = new CharacterModelBuilder(
      {} as never,
      { createSetupMeshWithOverrides: (_s: number, _d: number, _p: unknown, tex?: Map<number, Map<number, number>>, pal?: number[]) => { calls.push({ tex, pal }); return new THREE.Group(); } } as never,
      { getBaseEffect: () => null } as never,
      {
        loadPaletteColors: (id: number) => new Array(2048).fill(id),
        loadPaletteSet: () => null,
      } as never,
    );
    (builder as unknown as { charGen: unknown }).charGen = { heritageGroups: new Map([[Heritage.Aluvian, { genders: new Map([[Gender.Male, sex]]) }]]) };
    const group = builder.buildCharacterModel(Heritage.Aluvian, Gender.Male, appearance({ eyesStrip: 9, eyeColor: 2 }));
    expect(group).not.toBeNull();
    expect(calls).toHaveLength(1);
    // Strip 9's texture swap, not strip 2's.
    expect(calls[0].tex?.get(EYE_PART)?.get(OLD_EYE_TEX)).toBe(0x05000109);
    // Colour 2's palette over retail's fixed eye range 0x100..0x13F
    // (ACCharGenData::GenerateBaseAppearanceData @ 005c28d0), whichever
    // strip is worn; the rest keeps the base palette.
    expect(calls[0].pal?.[0x100]).toBe(EYE_COLOURS[2]);
    expect(calls[0].pal?.[0x13f]).toBe(EYE_COLOURS[2]);
    expect(calls[0].pal?.[0x140]).toBe(0x04000001);
    expect(calls[0].pal?.[9]).toBe(0x04000001);
  });
});
