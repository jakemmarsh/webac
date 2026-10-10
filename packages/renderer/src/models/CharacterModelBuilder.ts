import * as THREE from 'three';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { CharacterGenerator } from '@ac/dat-parser';
import type {
  SexCG,
  ObjDesc,
  HairStyleCG,
  GearCG,
} from '@ac/dat-parser/file-types/CharacterGenerator.js';
import type { AppearanceInfo } from '@ac/shared';
import { Heritage, Gender } from '@ac/shared';
import type { SetupModelRenderer } from './SetupModelRenderer.js';
import type { ClothingRenderer } from './ClothingRenderer.js';
import type { AppearanceManager } from './AppearanceManager.js';
import {
  storeColorInformation, paletteTemplateIdFor, clothingSubPaletteRanges, NO_CLOTHING_COLORS,
  type ChargenClothingColors, type ClothingColorChoices,
} from './ChargenClothingColors.js';
import { FACE_SUBPALETTE_RANGES, modifyPalette, subPaletteScale } from './AppearanceOverrides.js';
import { PLACEMENT_RESTING } from './SetupModelGroup.js';

/**
 * CharacterModelBuilder — creates fully-dressed character models from
 * heritage, gender, and appearance data using the ClothingRenderer and
 * AppearanceManager systems.
 *
 * Merges all ObjDesc modifications (base, hair, face, clothing) and
 * creates a setup mesh with the correct part replacements, texture
 * substitutions, and palette overrides.
 */
export class CharacterModelBuilder {
  private portalDb: DatDatabase;
  private setupModelRenderer: SetupModelRenderer;
  private clothingRenderer: ClothingRenderer;
  private appearanceManager: AppearanceManager;
  private charGen: CharacterGenerator | null = null;

  constructor(
    portalDb: DatDatabase,
    setupModelRenderer: SetupModelRenderer,
    clothingRenderer: ClothingRenderer,
    appearanceManager: AppearanceManager,
  ) {
    this.portalDb = portalDb;
    this.setupModelRenderer = setupModelRenderer;
    this.clothingRenderer = clothingRenderer;
    this.appearanceManager = appearanceManager;
  }

  /**
   * Load the CharacterGenerator from portal.dat.
   */
  private loadCharGen(): CharacterGenerator | null {
    if (this.charGen) return this.charGen;
    const data = this.portalDb.getFileData(0x0E000002);
    if (!data) return null;
    this.charGen = new CharacterGenerator(new DatReader(data));
    return this.charGen;
  }

  /**
   * Get the SexCG for a heritage + gender combination.
   * Maps our Gender enum (Male=1, Female=0) to DAT keys (Male=1, Female=2).
   */
  getSexCG(heritage: Heritage, gender: Gender): SexCG | null {
    const charGen = this.loadCharGen();
    if (!charGen) return null;
    const group = charGen.heritageGroups.get(heritage);
    if (!group) return null;

    // DAT genders are keyed by ACE Gender enum values (Male=1, Female=2);
    // our Gender enum now matches exactly, so no translation needed.
    return group.genders.get(gender) ?? null;
  }

  /**
   * Get the SetupModel ID for a heritage + gender combination.
   */
  getSetupId(heritage: Heritage, gender: Gender): number | null {
    const sexCG = this.getSexCG(heritage, gender);
    return sexCG?.setupId ?? null;
  }

  /**
   * BUG.cap-palette-template-0-black — one clothing slot's colour choices
   * (CharGenState::StoreColorInformation @ 005c44d0): the chosen style's
   * ClothingTable templates that are in Sex_CG.clothingColorsList. No style
   * (headgear −1) or no table → no colours.
   */
  clothingColorChoices(sexCG: SexCG | null, gearList: readonly GearCG[] | undefined, style: number): ClothingColorChoices {
    const gear = style >= 0 ? gearList?.[style] : undefined;
    if (!sexCG || !gear?.clothingTable) return NO_CLOTHING_COLORS;
    return storeColorInformation(this.clothingRenderer.loadClothingTable(gear.clothingTable), sexCG.clothingColorsList);
  }

  /** The four clothing slots' colour choices for a chargen appearance. */
  getChargenClothingColors(heritage: Heritage, gender: Gender, appearance: AppearanceInfo): ChargenClothingColors {
    const sexCG = this.getSexCG(heritage, gender);
    return {
      headgear: this.clothingColorChoices(sexCG, sexCG?.headgearList, appearance.headgearStyle),
      shirt: this.clothingColorChoices(sexCG, sexCG?.shirtList, appearance.shirtStyle),
      pants: this.clothingColorChoices(sexCG, sexCG?.pantsList, appearance.pantsStyle),
      footwear: this.clothingColorChoices(sexCG, sexCG?.footwearList, appearance.footwearStyle),
    };
  }

  /**
   * Get the MotionTable ID for a heritage + gender combination.
   * This comes from the SexCG in CharGen, not from the SetupModel.
   */
  getMotionTableId(heritage: Heritage, gender: Gender): number | null {
    const sexCG = this.getSexCG(heritage, gender);
    return sexCG?.motionTable ?? null;
  }

  /**
   * Build a fully-dressed character model.
   * Returns a Three.js Group positioned at the origin.
   */
  buildCharacterModel(
    heritage: Heritage,
    gender: Gender,
    appearance: AppearanceInfo,
    /** gmCG3DView::m_alternateSetupID / CharGenState::GetSetupID — a setup other than the sex's (0 = the sex's). */
    setupIdOverride = 0,
  ): THREE.Group | null {
    const sexCG = this.getSexCG(heritage, gender);
    if (!sexCG) {
      console.warn(`[CharacterModelBuilder] No SexCG for heritage=${heritage} gender=${gender}`);
      return null;
    }

    // Collect all ObjDesc modifications
    const partChanges = new Map<number, number>();
    // Per-part texture overrides: partIndex → (oldTexture → newTexture)
    const perPartTextureOverrides = new Map<number, Map<number, number>>();

    // 1. Apply base ObjDesc modifications
    this.mergeObjDesc(sexCG.baseObjDesc, partChanges, perPartTextureOverrides);

    // 2. Apply hair style
    const hairStyle = this.getHairStyle(sexCG, appearance.hairStyle);
    if (hairStyle) {
      this.mergeObjDesc(hairStyle.objDesc, partChanges, perPartTextureOverrides);
    }

    // 3. Apply eye strip
    // BUG.chargen-eyes-strip-sent-as-eye-colour — the strip is eyesStrip
    // (ACE PlayerFactory.cs:77 GetEyeTexture(Eyes)); eyeColor is the palette.
    const eyeStrip = sexCG.eyeStripList[appearance.eyesStrip];
    if (eyeStrip) {
      const isBald = hairStyle?.bald ?? false;
      const desc = isBald ? eyeStrip.objDescBald : eyeStrip.objDesc;
      this.mergeObjDesc(desc, partChanges, perPartTextureOverrides);
    }

    // 4. Apply nose strip
    const noseStrip = sexCG.noseStripList[appearance.noseStyle];
    if (noseStrip) {
      this.mergeObjDesc(noseStrip.objDesc, partChanges, perPartTextureOverrides);
    }

    // 5. Apply mouth strip
    const mouthStrip = sexCG.mouthStripList[appearance.mouthStyle];
    if (mouthStrip) {
      this.mergeObjDesc(mouthStrip.objDesc, partChanges, perPartTextureOverrides);
    }

    // 6. Apply clothing — headgear, shirt, pants, footwear
    this.applyClothingGear(sexCG, sexCG.headgearList, appearance.headgearStyle, partChanges, perPartTextureOverrides);
    this.applyClothingGear(sexCG, sexCG.shirtList, appearance.shirtStyle, partChanges, perPartTextureOverrides);
    this.applyClothingGear(sexCG, sexCG.pantsList, appearance.pantsStyle, partChanges, perPartTextureOverrides);
    this.applyClothingGear(sexCG, sexCG.footwearList, appearance.footwearStyle, partChanges, perPartTextureOverrides);

    // 7. Build composite palette
    const paletteColors = this.buildCompositePalette(sexCG, appearance);

    // 8. Create the setup mesh with all overrides
    const group = this.setupModelRenderer.createSetupMeshWithOverrides(
      setupIdOverride || sexCG.setupId,
      PLACEMENT_RESTING,
      partChanges.size > 0 ? partChanges : undefined,
      perPartTextureOverrides.size > 0 ? perPartTextureOverrides : undefined,
      paletteColors ?? undefined,
    );

    if (group) {
      group.name = 'player_character';
    }

    return group;
  }

  /**
   * Merge an ObjDesc's modifications into the accumulated changes.
   */
  private mergeObjDesc(
    objDesc: ObjDesc,
    partChanges: Map<number, number>,
    perPartTextureOverrides: Map<number, Map<number, number>>,
  ): void {
    // Animation part changes — swap GfxObj on body parts
    for (const apc of objDesc.animPartChanges) {
      partChanges.set(apc.partIndex, apc.partId);
    }

    // Texture map changes — per-part SurfaceTexture ID swaps
    for (const tmc of objDesc.textureChanges) {
      let partMap = perPartTextureOverrides.get(tmc.partIndex);
      if (!partMap) {
        partMap = new Map<number, number>();
        perPartTextureOverrides.set(tmc.partIndex, partMap);
      }
      partMap.set(tmc.oldTexture, tmc.newTexture);
    }
  }

  /**
   * Apply clothing from a gear list using the ClothingTable.
   */
  private applyClothingGear(
    sexCG: SexCG,
    gearList: readonly GearCG[],
    styleIndex: number,
    partChanges: Map<number, number>,
    perPartTextureOverrides: Map<number, Map<number, number>>,
  ): void {
    const gear = gearList[styleIndex];
    if (!gear || !gear.clothingTable) return;

    const baseEffect = this.clothingRenderer.getBaseEffect(gear.clothingTable, sexCG.setupId);
    if (!baseEffect) return;

    for (const objEffect of baseEffect.cloObjectEffects) {
      // Apply model replacement if specified
      if (objEffect.modelId) {
        partChanges.set(objEffect.index, objEffect.modelId);
      }

      // Apply texture overrides — per-part (objEffect.index is the part index)
      if (objEffect.cloTextureEffects.length > 0) {
        let partMap = perPartTextureOverrides.get(objEffect.index);
        if (!partMap) {
          partMap = new Map<number, number>();
          perPartTextureOverrides.set(objEffect.index, partMap);
        }
        for (const texEffect of objEffect.cloTextureEffects) {
          partMap.set(texEffect.oldTexture, texEffect.newTexture);
        }
      }
    }
  }

  /**
   * Get the hair style for the given index.
   */
  private getHairStyle(sexCG: SexCG, hairStyleIndex: number): HairStyleCG | null {
    if (hairStyleIndex >= 0 && hairStyleIndex < sexCG.hairStyleList.length) {
      return sexCG.hairStyleList[hairStyleIndex];
    }
    return null;
  }

  /**
   * Build the composite palette the chargen / barber preview draws with:
   * the Sex_CG base palette, then the face sub-palettes and the worn
   * clothing's, each overlaid index for index (Palette::Modify @ 0053e160).
   *
   * BUG.barber-hair-preview-colour — the face colours go over retail's FIXED
   * ranges (FACE_SUBPALETTE_RANGES: ACCharGenData::GenerateBaseAppearanceData
   * @ 005c28d0, gmCG3DView::Update @ 004ee9d0), the same ones ACE sends for
   * the live player. This used to look for ranges in the hair-style /
   * eye-strip / base ObjDescs, which carry none in the EoL CharGen, so skin,
   * hair and eye colour were never applied and the preview showed the base
   * palette's 0xC0..0xFF (auburn) whatever colour was picked.
   */
  private buildCompositePalette(sexCG: SexCG, appearance: AppearanceInfo): number[] | null {
    // Load base palette
    const basePaletteId = sexCG.basePalette;
    if (!basePaletteId) return null;

    const baseColors = this.appearanceManager.loadPaletteColors(basePaletteId);
    if (!baseColors) return null;

    // Start with a copy of the base palette
    const composite = [...baseColors];

    // Skin: PalSet(skinPalSet).GetPaletteID(skinShade) over 0..0xBF. Skin
    // has NO discrete colour index; the float64 skinHue (0..1) is the shade.
    if (sexCG.skinPalSet) {
      this.overlayFace(composite, this.appearanceManager.loadPaletteSet(sexCG.skinPalSet)
        ?.getPaletteId(appearance.skinHue ?? 0) ?? 0, FACE_SUBPALETTE_RANGES.skin);
    }

    // Hair: PalSet(mHairColorList[hairColor]).GetPaletteID(hairShade) over
    // 0xC0..0xFF — the palette the barber's Apply / CharacterCreate sends.
    const hairColorPalSetId = appearance.hairColor >= 0 ? sexCG.hairColorList[appearance.hairColor] : undefined;
    if (hairColorPalSetId) {
      this.overlayFace(composite, this.appearanceManager.loadPaletteSet(hairColorPalSetId)
        ?.getPaletteId(appearance.hairHue ?? 0) ?? 0, FACE_SUBPALETTE_RANGES.hair);
    }

    // Eyes: mEyeColorList[eyeColor] is a Palette (ACE PlayerFactory.cs:100
    // EyesPalette = sex.EyeColorList[EyeColor]) over 0x100..0x13F.
    const eyePaletteId = appearance.eyeColor >= 0 ? sexCG.eyeColorList[appearance.eyeColor] : undefined;
    if (eyePaletteId) this.overlayFace(composite, eyePaletteId, FACE_SUBPALETTE_RANGES.eyes);

    // BUG.cap-palette-template-0-black — the worn clothing's colours, the
    // overlay ACE will build from the CharacterCreate templates
    // (Creature_Networking.cs CalculateObjDesc: the Clothing items first,
    // then the Armor|Extremity ones — headgear and footwear). The preview
    // never coloured the clothes, so a wrong template was invisible here.
    const slots: Array<[readonly GearCG[], number, number, number]> = [
      [sexCG.shirtList, appearance.shirtStyle, appearance.shirtColor, appearance.shirtHue ?? 0],
      [sexCG.pantsList, appearance.pantsStyle, appearance.pantsColor, appearance.pantsHue ?? 0],
      [sexCG.headgearList, appearance.headgearStyle, appearance.headgearColor, appearance.headgearHue ?? 0],
      [sexCG.footwearList, appearance.footwearStyle, appearance.footwearColor, appearance.footwearHue ?? 0],
    ];
    for (const [list, style, colorIndex, shade] of slots) {
      const gear = style >= 0 ? list[style] : undefined;
      if (!gear?.clothingTable) continue;
      const table = this.clothingRenderer.loadClothingTable(gear.clothingTable);
      const template = paletteTemplateIdFor(this.clothingColorChoices(sexCG, list, style), colorIndex);
      const ranges = clothingSubPaletteRanges(table, template,
        (setId) => this.appearanceManager.loadPaletteSet(setId)?.getPaletteId(shade) ?? 0);
      for (const r of ranges) {
        const colors = this.appearanceManager.loadPaletteColors(r.paletteId);
        if (colors) modifyPalette(composite, colors, r.offset, r.length);
      }
    }

    return composite;
  }

  /** Overlay one face palette over its fixed range (Palette::Modify @ 0053e160). */
  private overlayFace(composite: number[], paletteId: number, range: { offset: number; numColors: number }): void {
    if (!paletteId) return;
    const colors = this.appearanceManager.loadPaletteColors(paletteId);
    // FACE_SUBPALETTE_RANGES are in retail's 2048-colour scale; a 1999
    // 256-entry palette takes them / 8 (skin [0,24), hair [24,32), eyes [32,40)).
    const k = subPaletteScale(composite.length);
    if (colors) modifyPalette(composite, colors, range.offset * k, range.numColors * k);
  }
}
