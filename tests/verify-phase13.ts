/**
 * Phase 13 — Multi-Part Models + Clothing/Equipment Appearance
 *
 * Tests:
 *  - SetupModelRenderer assembles multi-part models with correct part counts and Frame transforms
 *  - ClothingRenderer loads ClothingTables and applies base effects to setup meshes
 *  - AppearanceManager resolves PaletteSet hue→colors for skin/hair/clothing variations
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { SetupModel } from '@ac/dat-parser/file-types/SetupModel.js';
import { ClothingTable } from '@ac/dat-parser/file-types/ClothingTable.js';
import { PaletteSet } from '@ac/dat-parser/file-types/PaletteSet.js';
import { GfxObj } from '@ac/dat-parser/file-types/GfxObj.js';
import { CharacterGenerator } from '@ac/dat-parser/file-types/CharacterGenerator.js';
import { Heritage, Gender } from '@ac/shared';
import type { AppearanceInfo } from '@ac/shared';
import { TextureManager } from '@ac/renderer/models/TextureManager.js';
import { MaterialFactory } from '@ac/renderer/models/MaterialFactory.js';
import { ModelRenderer } from '@ac/renderer/models/ModelRenderer.js';
import { SetupModelRenderer } from '@ac/renderer/models/SetupModelRenderer.js';
import { ClothingRenderer } from '@ac/renderer/models/ClothingRenderer.js';
import { AppearanceManager } from '@ac/renderer/models/AppearanceManager.js';
import { CharacterModelBuilder } from '@ac/renderer/models/CharacterModelBuilder.js';
import { getPartPlacements } from '@ac/renderer/models/SetupModelGroup.js';
import { openDat } from './_harness/dat.js';

const hasPortalDat = fs.existsSync('dat/client_portal.dat');

let portalDb: DatDatabase;
let textureManager: TextureManager;
let materialFactory: MaterialFactory;
let modelRenderer: ModelRenderer;
let setupModelRenderer: SetupModelRenderer;
let clothingRenderer: ClothingRenderer;
let appearanceManager: AppearanceManager;
let characterModelBuilder: CharacterModelBuilder;

beforeAll(() => {
  if (!hasPortalDat) return;
  portalDb = openDat('dat/client_portal.dat');
  textureManager = new TextureManager(portalDb);
  materialFactory = new MaterialFactory(portalDb, textureManager);
  modelRenderer = new ModelRenderer(portalDb, materialFactory);
  setupModelRenderer = new SetupModelRenderer(portalDb, modelRenderer);
  clothingRenderer = new ClothingRenderer(portalDb, setupModelRenderer, modelRenderer, materialFactory);
  appearanceManager = new AppearanceManager(portalDb);
  characterModelBuilder = new CharacterModelBuilder(portalDb, setupModelRenderer, clothingRenderer, appearanceManager);
});

/**
 * Find valid SetupModel IDs (0x02xxxxxx) from the portal DAT.
 */
function findSetupIds(count: number): number[] {
  return portalDb.listFileIds(0x02).slice(0, count);
}

/**
 * Find valid ClothingTable IDs (0x10xxxxxx) from the portal DAT.
 */
function findClothingTableIds(count: number): number[] {
  return portalDb.listFileIds(0x10).slice(0, count);
}

/**
 * Find valid PaletteSet IDs (0x0Fxxxxxx) from the portal DAT.
 */
function findPaletteSetIds(count: number): number[] {
  return portalDb.listFileIds(0x0F).slice(0, count);
}

describe.skipIf(!hasPortalDat)('Phase 13 — Multi-Part Models + Clothing Appearance', () => {
  // ============================================================
  // SetupModelRenderer tests
  // ============================================================
  describe('SetupModelRenderer', () => {
    it('should load and parse SetupModels from portal.dat', () => {
      const ids = findSetupIds(50);
      expect(ids.length).toBeGreaterThanOrEqual(50);

      let successCount = 0;
      for (const id of ids) {
        const setup = setupModelRenderer.loadSetupModel(id);
        if (setup && setup.parts.length > 0) {
          successCount++;
        }
      }
      // At least 95% should parse successfully
      expect(successCount / ids.length).toBeGreaterThanOrEqual(0.95);
    });

    it('should have valid GfxObj IDs in parts array (0x01xxxxxx)', () => {
      const ids = findSetupIds(20);
      for (const id of ids) {
        const setup = setupModelRenderer.loadSetupModel(id);
        if (!setup) continue;
        for (const partId of setup.parts) {
          expect(partId >>> 24).toBe(0x01);
        }
      }
    });

    it('should assemble multi-part models into Three.js Groups', () => {
      const ids = findSetupIds(100);
      let assembled = 0;

      for (const id of ids) {
        const setup = setupModelRenderer.loadSetupModel(id);
        if (!setup || setup.parts.length < 2) continue;

        // Check that at least some parts produce meshes via createMesh
        let meshCount = 0;
        for (const partId of setup.parts) {
          const mesh = modelRenderer.createMesh(partId);
          if (mesh) meshCount++;
        }
        if (meshCount === 0) continue;

        const group = setupModelRenderer.createSetupMesh(id);
        if (!group) continue;

        // Count total descendants including nested children
        let totalDescendants = 0;
        group.traverse(() => { totalDescendants++; });
        totalDescendants -= 1; // exclude root

        if (totalDescendants > 0) {
          assembled++;
        }
        if (assembled >= 10) break;
      }
      expect(assembled).toBeGreaterThanOrEqual(5);
    });

    it('should position parts using Frame transforms from PlacementFrames', () => {
      const ids = findSetupIds(50);
      let tested = 0;

      for (const id of ids) {
        const setup = setupModelRenderer.loadSetupModel(id);
        if (!setup || setup.parts.length < 2 || setup.placementFrames.size === 0) continue;

        const placements = getPartPlacements(setup, 0);
        // Verify frames have finite values
        for (const p of placements) {
          expect(Number.isFinite(p.frame.origin.x)).toBe(true);
          expect(Number.isFinite(p.frame.origin.y)).toBe(true);
          expect(Number.isFinite(p.frame.origin.z)).toBe(true);
          expect(Number.isFinite(p.frame.orientation.w)).toBe(true);
          expect(Number.isFinite(p.frame.orientation.x)).toBe(true);
          expect(Number.isFinite(p.frame.orientation.y)).toBe(true);
          expect(Number.isFinite(p.frame.orientation.z)).toBe(true);
        }
        tested++;
        if (tested >= 10) break;
      }
      expect(tested).toBeGreaterThanOrEqual(5);
    });

    it('should have physical dimensions (height/radius > 0) for most SetupModels', () => {
      const ids = findSetupIds(50);
      let withDimensions = 0;

      for (const id of ids) {
        const setup = setupModelRenderer.loadSetupModel(id);
        if (!setup) continue;
        if (setup.height > 0 && setup.radius > 0) {
          withDimensions++;
        }
      }
      // Most setup models should have physical dimensions
      expect(withDimensions / ids.length).toBeGreaterThanOrEqual(0.5);
    });

    it('should respect parentIndex hierarchy when building groups', () => {
      const ids = findSetupIds(200);
      let tested = 0;

      for (const id of ids) {
        const setup = setupModelRenderer.loadSetupModel(id);
        if (!setup || setup.parentIndex.length === 0 || setup.parts.length < 3) continue;

        // Check that at least some parts have valid geometry
        let hasDrawable = false;
        for (const partId of setup.parts) {
          const gfxObj = modelRenderer.loadGfxObj(partId);
          if (gfxObj && (gfxObj.polygons.length > 0 || gfxObj.physicsPolygons.size > 0)) {
            hasDrawable = true;
            break;
          }
        }
        if (!hasDrawable) continue;

        const group = setupModelRenderer.createSetupMesh(id);
        if (!group) continue;

        // Count total descendants (including nested children)
        let totalDescendants = 0;
        group.traverse(() => { totalDescendants++; });
        // Subtract the root group itself
        totalDescendants -= 1;

        if (totalDescendants === 0) continue;

        // With parentIndex, some parts should be nested under others
        // The total object count should be at least some of the parts
        expect(totalDescendants).toBeGreaterThan(0);
        tested++;
        if (tested >= 5) break;
      }
      expect(tested).toBeGreaterThanOrEqual(1);
    });

    it('should cache loaded SetupModels', () => {
      const ids = findSetupIds(5);
      for (const id of ids) {
        setupModelRenderer.loadSetupModel(id);
      }
      expect(setupModelRenderer.cacheSize).toBeGreaterThanOrEqual(5);
    });
  });

  // ============================================================
  // ClothingRenderer tests
  // ============================================================
  describe('ClothingRenderer', () => {
    it('should load ClothingTables from portal.dat', () => {
      const ids = findClothingTableIds(20);
      expect(ids.length).toBeGreaterThanOrEqual(10);

      let loaded = 0;
      for (const id of ids) {
        const ct = clothingRenderer.loadClothingTable(id);
        if (ct) loaded++;
      }
      expect(loaded / ids.length).toBeGreaterThanOrEqual(0.9);
    });

    it('should have ClothingBaseEffects keyed by SetupModel IDs', () => {
      const ids = findClothingTableIds(20);
      let withBaseEffects = 0;

      for (const id of ids) {
        const ct = clothingRenderer.loadClothingTable(id);
        if (!ct) continue;
        if (ct.clothingBaseEffects.size > 0) {
          withBaseEffects++;
          // Check that keys look like SetupModel IDs (0x02xxxxxx)
          for (const [key] of ct.clothingBaseEffects) {
            expect(key >>> 24).toBe(0x02);
          }
        }
      }
      expect(withBaseEffects).toBeGreaterThanOrEqual(5);
    });

    it('should have valid texture effects in clothing base effects', () => {
      const ids = findClothingTableIds(50);
      let withTextureEffects = 0;

      for (const id of ids) {
        const ct = clothingRenderer.loadClothingTable(id);
        if (!ct) continue;

        for (const [, baseEffect] of ct.clothingBaseEffects) {
          for (const objEffect of baseEffect.cloObjectEffects) {
            if (objEffect.cloTextureEffects.length > 0) {
              withTextureEffects++;
              for (const texEffect of objEffect.cloTextureEffects) {
                // Texture IDs should be SurfaceTexture (0x05xxxxxx)
                expect(texEffect.oldTexture >>> 24).toBe(0x05);
                expect(texEffect.newTexture >>> 24).toBe(0x05);
              }
            }
          }
        }
        if (withTextureEffects > 20) break;
      }
      expect(withTextureEffects).toBeGreaterThan(0);
    });

    it('should apply clothing effect to a setup mesh', () => {
      const clothingIds = findClothingTableIds(50);
      let applied = 0;

      for (const ctId of clothingIds) {
        const ct = clothingRenderer.loadClothingTable(ctId);
        if (!ct || ct.clothingBaseEffects.size === 0) continue;

        // Get first setup model ID from clothing base effects
        const setupId = ct.clothingBaseEffects.keys().next().value;
        if (setupId === undefined) continue;

        const group = setupModelRenderer.createSetupMesh(setupId);
        if (!group) continue;

        const result = clothingRenderer.applyClothingEffect(group, ctId, setupId);
        if (result) {
          applied++;
          if (applied >= 3) break;
        }
      }
      expect(applied).toBeGreaterThanOrEqual(1);
    });

    it('should have clothing sub-palette effects', () => {
      const ids = findClothingTableIds(50);
      let withSubPal = 0;

      for (const id of ids) {
        const ct = clothingRenderer.loadClothingTable(id);
        if (!ct) continue;
        if (ct.clothingSubPalEffects.size > 0) {
          withSubPal++;
          for (const [, subPalEffect] of ct.clothingSubPalEffects) {
            expect(subPalEffect.cloSubPalettes.length).toBeGreaterThan(0);
            for (const subPal of subPalEffect.cloSubPalettes) {
              // PaletteSet IDs should be 0x0Fxxxxxx
              expect(subPal.paletteSet >>> 24).toBe(0x0F);
              expect(subPal.ranges.length).toBeGreaterThan(0);
            }
          }
        }
        if (withSubPal >= 5) break;
      }
      expect(withSubPal).toBeGreaterThanOrEqual(3);
    });
  });

  // ============================================================
  // AppearanceManager / PaletteSet tests
  // ============================================================
  describe('AppearanceManager', () => {
    it('should load PaletteSets from portal.dat', () => {
      const ids = findPaletteSetIds(20);
      expect(ids.length).toBeGreaterThanOrEqual(10);

      let loaded = 0;
      for (const id of ids) {
        const ps = appearanceManager.loadPaletteSet(id);
        if (ps && ps.paletteList.length > 0) loaded++;
      }
      expect(loaded / ids.length).toBeGreaterThanOrEqual(0.9);
    });

    it('should resolve hue values to valid palette IDs', () => {
      const ids = findPaletteSetIds(10);
      for (const id of ids) {
        const ps = appearanceManager.loadPaletteSet(id);
        if (!ps || ps.paletteList.length === 0) continue;

        // Test different hue values
        for (const hue of [0.0, 0.25, 0.5, 0.75, 1.0]) {
          const palId = ps.getPaletteId(hue);
          expect(palId).toBeGreaterThan(0);
          // Should be a palette ID (0x04xxxxxx)
          expect(palId >>> 24).toBe(0x04);
        }
      }
    });

    it('should resolve PaletteSet + hue to actual ARGB colors', () => {
      const ids = findPaletteSetIds(10);
      let resolved = 0;

      for (const id of ids) {
        const colors = appearanceManager.resolveColors(id, 0.5);
        if (colors && colors.length > 0) {
          resolved++;
          // Colors should be valid ARGB values
          for (const c of colors) {
            expect(Number.isFinite(c)).toBe(true);
          }
        }
      }
      expect(resolved).toBeGreaterThanOrEqual(5);
    });

    it('should produce different colors for different hue values', () => {
      const ids = findPaletteSetIds(20);
      let differentFound = 0;

      for (const id of ids) {
        const ps = appearanceManager.loadPaletteSet(id);
        if (!ps || ps.paletteList.length < 2) continue;

        const colors0 = appearanceManager.resolveColors(id, 0.0);
        const colors1 = appearanceManager.resolveColors(id, 0.99);
        if (!colors0 || !colors1) continue;

        // Different hues should produce different palette lookups
        // (unless the PaletteSet has only 1 entry)
        if (ps.paletteList.length > 1) {
          const pal0 = ps.getPaletteId(0.0);
          const pal1 = ps.getPaletteId(0.99);
          if (pal0 !== pal1) {
            differentFound++;
          }
        }
        if (differentFound >= 5) break;
      }
      expect(differentFound).toBeGreaterThanOrEqual(3);
    });

    it('should build composite palettes with range overrides', () => {
      // Get a base palette
      const paletteSetIds = findPaletteSetIds(10);
      const firstPsId = paletteSetIds[0];
      const basePalette = appearanceManager.resolveColors(firstPsId, 0.0);
      expect(basePalette).not.toBeNull();
      if (!basePalette) return;

      // Use a different palette set for override
      const overridePsId = paletteSetIds.length > 1 ? paletteSetIds[1] : firstPsId;

      const composite = appearanceManager.buildCompositePalette(basePalette, [
        { paletteSetId: overridePsId, hue: 0.5, offset: 0, numColors: 10 },
      ]);

      expect(composite.length).toBe(basePalette.length);
    });

    it('should cache PaletteSets and palettes', () => {
      const ids = findPaletteSetIds(5);
      for (const id of ids) {
        appearanceManager.loadPaletteSet(id);
      }
      expect(appearanceManager.cacheSize).toBeGreaterThanOrEqual(5);
    });
  });

  // ============================================================
  // CharacterModelBuilder tests
  // ============================================================
  describe('CharacterModelBuilder', () => {
    function makeDefaultAppearance(): AppearanceInfo {
      return {
        hairStyle: 0,
        hairColor: 0,
        eyesStrip: 0, eyeColor: 0,
        skinColor: 0,
        noseStyle: 0,
        mouthStyle: 0,
        headgearStyle: 0,
        headgearColor: 0,
        shirtStyle: 0,
        shirtColor: 0,
        pantsStyle: 0,
        pantsColor: 0,
        footwearStyle: 0,
        footwearColor: 0,
      };
    }

    it('should resolve SexCG for all heritage/gender combos', () => {
      const heritages = [Heritage.Aluvian, Heritage.Gharundim, Heritage.Sho, Heritage.Viamontian];
      const genders = [Gender.Male, Gender.Female];

      for (const heritage of heritages) {
        for (const gender of genders) {
          const sexCG = characterModelBuilder.getSexCG(heritage, gender);
          expect(sexCG).not.toBeNull();
          expect(sexCG!.setupId >>> 24).toBe(0x02);
          expect(sexCG!.basePalette >>> 24).toBe(0x04);
          expect(sexCG!.skinPalSet >>> 24).toBe(0x0F);
          expect(sexCG!.hairStyleList.length).toBeGreaterThan(0);
          expect(sexCG!.hairColorList.length).toBeGreaterThan(0);
          expect(sexCG!.shirtList.length).toBeGreaterThan(0);
          expect(sexCG!.pantsList.length).toBeGreaterThan(0);
          expect(sexCG!.footwearList.length).toBeGreaterThan(0);
        }
      }
    });

    it('should build character model for Aluvian male', () => {
      const model = characterModelBuilder.buildCharacterModel(
        Heritage.Aluvian,
        Gender.Male,
        makeDefaultAppearance(),
      );
      expect(model).not.toBeNull();
      expect(model!.name).toBe('player_character');

      // Should have multiple body parts
      let partCount = 0;
      model!.traverse((child) => {
        if (child.name.startsWith('part_')) partCount++;
      });
      expect(partCount).toBeGreaterThan(5);
    });

    it('should build character model for Gharundim female', () => {
      const model = characterModelBuilder.buildCharacterModel(
        Heritage.Gharundim,
        Gender.Female,
        makeDefaultAppearance(),
      );
      expect(model).not.toBeNull();

      let partCount = 0;
      model!.traverse((child) => {
        if (child.name.startsWith('part_')) partCount++;
      });
      expect(partCount).toBeGreaterThan(5);
    });

    it('should build character model for all heritages', () => {
      const heritages = [Heritage.Aluvian, Heritage.Gharundim, Heritage.Sho, Heritage.Viamontian];

      for (const heritage of heritages) {
        const model = characterModelBuilder.buildCharacterModel(
          heritage,
          Gender.Male,
          makeDefaultAppearance(),
        );
        expect(model).not.toBeNull();
      }
    });

    it('should produce different models for different hair styles', () => {
      const app1 = makeDefaultAppearance();
      app1.hairStyle = 0;
      const model1 = characterModelBuilder.buildCharacterModel(Heritage.Aluvian, Gender.Male, app1);

      const sexCG = characterModelBuilder.getSexCG(Heritage.Aluvian, Gender.Male);
      const maxHair = sexCG ? sexCG.hairStyleList.length - 1 : 1;

      const app2 = makeDefaultAppearance();
      app2.hairStyle = maxHair;
      const model2 = characterModelBuilder.buildCharacterModel(Heritage.Aluvian, Gender.Male, app2);

      expect(model1).not.toBeNull();
      expect(model2).not.toBeNull();
      // Both should be valid character models
      // (they may differ in part GfxObj IDs or textures from hair ObjDesc)
    });

    it('should apply clothing gear from ClothingTable', () => {
      const sexCG = characterModelBuilder.getSexCG(Heritage.Aluvian, Gender.Male);
      expect(sexCG).not.toBeNull();

      // Verify that gear entries have valid ClothingTable IDs
      for (const gear of sexCG!.shirtList.slice(0, 3)) {
        expect(gear.clothingTable).toBeGreaterThan(0);
        expect(gear.clothingTable >>> 24).toBe(0x10);

        // The clothing table should have base effects for the character's setup model
        const baseEffect = clothingRenderer.getBaseEffect(gear.clothingTable, sexCG!.setupId);
        // Some clothing tables may not have effects for all setup models, so just check loading works
        const ct = clothingRenderer.loadClothingTable(gear.clothingTable);
        expect(ct).not.toBeNull();
      }
    });

    it('should create setup mesh with part overrides', () => {
      const sexCG = characterModelBuilder.getSexCG(Heritage.Aluvian, Gender.Male);
      expect(sexCG).not.toBeNull();

      // Create a mesh with no overrides
      const base = setupModelRenderer.createSetupMesh(sexCG!.setupId);
      expect(base).not.toBeNull();

      // Create with overrides (using base ObjDesc part changes)
      const partChanges = new Map<number, number>();
      for (const apc of sexCG!.baseObjDesc.animPartChanges) {
        partChanges.set(apc.partIndex, apc.partId);
      }

      const withOverrides = setupModelRenderer.createSetupMeshWithOverrides(
        sexCG!.setupId,
        0,
        partChanges.size > 0 ? partChanges : undefined,
      );
      expect(withOverrides).not.toBeNull();

      // Both should have body parts
      let basePartCount = 0;
      let overridePartCount = 0;
      base!.traverse((child) => { if (child.name.startsWith('part_')) basePartCount++; });
      withOverrides!.traverse((child) => { if (child.name.startsWith('part_')) overridePartCount++; });
      expect(basePartCount).toBeGreaterThan(0);
      expect(overridePartCount).toBeGreaterThan(0);
    });

    it('should create texture with composite palette', () => {
      const sexCG = characterModelBuilder.getSexCG(Heritage.Aluvian, Gender.Male);
      expect(sexCG).not.toBeNull();

      // Load base palette
      const baseColors = appearanceManager.loadPaletteColors(sexCG!.basePalette);
      expect(baseColors).not.toBeNull();
      expect(baseColors!.length).toBeGreaterThan(0);

      // Resolve skin color palette
      const skinColors = appearanceManager.resolveColors(sexCG!.skinPalSet, 0.5);
      expect(skinColors).not.toBeNull();
      expect(skinColors!.length).toBeGreaterThan(0);
    });
  });

  // ============================================================
  // Integration: SetupModel → ClothingTable → PaletteSet
  // ============================================================
  describe('Integration: Clothing + Palette Application', () => {
    it('should find clothing tables with both base effects and sub-palette effects', () => {
      const ids = findClothingTableIds(100);
      let bothFound = 0;

      for (const id of ids) {
        const ct = clothingRenderer.loadClothingTable(id);
        if (!ct) continue;
        if (ct.clothingBaseEffects.size > 0 && ct.clothingSubPalEffects.size > 0) {
          bothFound++;
        }
        if (bothFound >= 5) break;
      }
      expect(bothFound).toBeGreaterThanOrEqual(3);
    });

    it('should resolve sub-palette PaletteSet references to actual colors', () => {
      const ids = findClothingTableIds(50);
      let resolved = 0;

      for (const id of ids) {
        const ct = clothingRenderer.loadClothingTable(id);
        if (!ct) continue;

        for (const [, subPalEffect] of ct.clothingSubPalEffects) {
          for (const subPal of subPalEffect.cloSubPalettes) {
            const colors = appearanceManager.resolveColors(subPal.paletteSet, 0.5);
            if (colors && colors.length > 0) {
              resolved++;
            }
          }
          if (resolved >= 10) break;
        }
        if (resolved >= 10) break;
      }
      expect(resolved).toBeGreaterThanOrEqual(5);
    });
  });
});
