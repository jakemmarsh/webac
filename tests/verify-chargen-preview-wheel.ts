/**
 * VISUAL.155 + VISUAL.156 — chargen Appearance page: live 3D preview +
 * color wheel (spots + gradient shade disk).
 *
 * Ground truth:
 *  - DAT layout 0x21000049: element 0x100003bb (534,84) 245x371 is a
 *    type-13/p205 LIVE MODEL VIEWPORT (content coords (534,29) after the
 *    55px tab offset); element 0x100003b9 (294,317) 220x220 carries no
 *    media — the retail client draws the color wheel procedurally.
 *  - Decompiled client (docs/retail-client-symbols.md): gmCGAppearancePage
 *    SetColor(int) = discrete color SPOTS, SetShade(double) = GRADIENT
 *    DISK sweeping the part's PaletteSet; gmCG3DView gives the preview
 *    DoRotation/ZoomIn/ZoomOut.
 *  - ACE CharacterCreate wire: six float64 hue fields (skin/hair/headgear/
 *    shirt/pants/footwear); skin has NO discrete color int — shade only.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppearanceViewController, headingToModelYaw, acToThree } from '../packages/renderer/src/ui/ChargenAppearanceView.js';
import { CharacterCreateWizard, characterCreateAppearance } from '../packages/renderer/src/ui/CharacterCreate.js';
import { CharacterModelBuilder } from '../packages/renderer/src/models/CharacterModelBuilder.js';

const REPO = resolve(__dirname, '..');
const WIZARD = readFileSync(resolve(REPO, 'packages/renderer/src/ui/CharacterCreate.ts'), 'utf8');
const SHARED = readFileSync(resolve(REPO, 'packages/shared/src/character/CharacterCreation.ts'), 'utf8');

/**
 * VISUAL.155 — the live 3D view. CORE.17.k.b.b.a.e replaced the invented
 * drag-to-rotate / wheel-to-zoom with the retail machine (gmCGAppearancePage:
 * the face camera at heading 180, the 0x10000322 rotate / zoom buttons); the
 * source pins that froze the old handlers became behavioural checks of that
 * machine here, and the DOM (the canvas at the DAT slot, the buttons, the
 * camera the view asks the renderer to draw) is covered in
 * tests/verify-core17kbbae-chargen-appearance-view.ts through happy-dom.
 */
describe('VISUAL.155 — live 3D view in the DAT viewport 0x100003bb (the retail view machine)', () => {
  it('opens on the face camera at heading 180, facing the camera — not the full-body back view', () => {
    const view = new AppearanceViewController();
    view.initializePage(1);
    expect(view.heading).toBe(180);
    // CORE.18.f — the world's (x, z, y) mapping: heading 180 is rotation π
    // (the model faces three +z at 0), the camera sits at three z = AC y.
    expect(headingToModelYaw(view.heading)).toBeCloseTo(Math.PI, 9);
    expect(view.currentPosition).toEqual([0, -0.55, 1.65]);
    expect(acToThree(view.currentPosition)).toEqual([0, 1.65, -0.55]);
    expect(view.zoomedIn).toBe(false);
  });

  it('the buttons — not a drag or the wheel — turn and zoom it: 120°/s while a rotate button is lit, a 0.6 s lerp to the full body on zoom out', () => {
    const view = new AppearanceViewController();
    view.initializePage(1);
    view.clickRotateClockwise();
    view.tick(0); view.tick(0.5);
    expect(view.heading).toBeCloseTo(240, 6);
    view.clickRotateClockwise();
    expect(view.rotating).toBe(false);
    view.clickZoomIn(1); view.tick(1); view.tick(2);
    view.clickZoomOut(1); view.tick(3); view.tick(3.6);
    expect(view.currentPosition).toEqual([0, -2.5, 0.95]);
    expect(view.active).toBe(false);
  });
});

describe('VISUAL.156 — color wheel (spots + gradient shade disk)', () => {
  // The discrete colour SPOTS pin (which froze the clothing spots onto
  // Sex_CG.clothingColorsList — template ids, not palette sets) became the
  // happy-dom behavioural test in tests/verify-bug-cap-palette-template.ts
  // (BUG.cap-palette-template-0-black): spot count, data-key/value, swatch
  // colour and shade-disk set for the hair and clothing parts.

  // VISUAL.chargen-swatch-colours — the two disk pins here (a disk that
  // swept the PaletteSet's shades; the skin disk backed by skinPalSet) froze
  // a wrong model: retail's circle is ColorRing multiplied by the current
  // spot's colour and the shade lives on the 0x10000321 scroll. Both became
  // happy-dom behavioural tests in tests/verify-chargen-swatch-colours.ts
  // (the shade scroll writes the part's hue double; skin shows one spot and
  // the shade scroll, no discrete colour).

  it('AppearanceState + AppearanceInfo carry the six hue doubles', () => {
    for (const f of ['skinHue', 'hairHue', 'headgearHue', 'shirtHue', 'pantsHue', 'footwearHue']) {
      expect(WIZARD).toMatch(new RegExp(`${f}: number;`));
      expect(SHARED).toMatch(new RegExp(`${f}\\?: number;`));
    }
  });

  it('the CharacterCreate wire sends the REAL shade doubles (not index/255 derivations)', () => {
    // Behavioural (was a main.ts source pin): the wire block main.ts sends
    // is characterCreateAppearance(info.appearance).
    const w = new CharacterCreateWizard();
    Object.assign(w.appearance, { skinColor: 200, skinHue: 0.25, hairHue: 0.75, headgearHue: 0.1, shirtHue: 0.2, pantsHue: 0.3, footwearHue: 0.4 });
    const wire = characterCreateAppearance(w.appearance);
    expect([wire.skinHue, wire.hairHue, wire.headgearHue, wire.shirtHue, wire.pantsHue, wire.footwearHue]).toEqual([0.25, 0.75, 0.1, 0.2, 0.3, 0.4]);
    expect(wire.skinHue).not.toBe(200 / 255);
  });

  it('CharacterModelBuilder consumes the hues: skinHue selects the skin palette, hairHue the hair shade', () => {
    // Behavioural (was a source pin): the preview's composite palette takes
    // PalSet::GetPaletteID(shade) @ 005ac570 of each set, over retail's fixed
    // face ranges (skin 0..0xBF, hair 0xC0..0xFF — GenerateBaseAppearanceData @ 005c28d0).
    const set = (base: number) => {
      const paletteList = [base, base + 1, base + 2, base + 3];
      return { paletteList, getPaletteId: (h: number) => paletteList[Math.floor((paletteList.length - 0.000001) * h)] };
    };
    const sets = new Map([[0x0f000013, set(0x04000100)], [0x0f000b50, set(0x04000200)]]);
    const am = { loadPaletteSet: (id: number) => sets.get(id) ?? null, loadPaletteColors: (id: number) => new Array(2048).fill(id) };
    const builder = new CharacterModelBuilder({} as never, {} as never, {} as never, am as never);
    const empty = { paletteId: 0, subPalettes: [], textureChanges: [], animPartChanges: [] };
    const sex = {
      basePalette: 0x0400007e, skinPalSet: 0x0f000013, baseObjDesc: empty, hairColorList: [0x0f000b50],
      hairStyleList: [{ iconImage: 0, bald: false, alternateSetup: 0, objDesc: empty }], eyeColorList: [], eyeStripList: [],
      shirtList: [], pantsList: [], headgearList: [], footwearList: [],
    };
    const composite = (builder as unknown as { buildCompositePalette(s: unknown, a: unknown): number[] }).buildCompositePalette(sex, {
      hairStyle: 0, hairColor: 0, eyesStrip: -1, eyeColor: -1, skinColor: 0, noseStyle: 0, mouthStyle: 0,
      headgearStyle: -1, headgearColor: 0, shirtStyle: -1, shirtColor: 0, pantsStyle: -1, pantsColor: 0,
      footwearStyle: -1, footwearColor: 0, skinHue: 0.6, hairHue: 0.3,
    });
    expect(composite[0]).toBe(0x04000102);
    expect(composite[0xbf]).toBe(0x04000102);
    expect(composite[0xc0]).toBe(0x04000201);
    expect(composite[0xff]).toBe(0x04000201);
    expect(composite[0x100]).toBe(0x0400007e);
  });
});
