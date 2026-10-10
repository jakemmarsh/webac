/**
 * Phase 38 — Authentic AC UI from DAT Assets
 *
 * Tests:
 *  - CharacterGenerator parses from portal.dat with correct heritage groups
 *  - Heritage icon textures resolve to valid texture data
 *  - AC Font parses with correct character descriptors
 *  - ACFontRenderer computes correct text layouts and can render to canvas
 *  - Templates, skills, appearance data are all present
 *  - TextureManager can produce icon data URLs and RGBA from various ID types
 *  - GameUI accepts portalDb/textureManager and uses CharGen data (not hardcoded)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { CharacterGenerator } from '../packages/dat-parser/src/file-types/CharacterGenerator.js';
import type { HeritageGroupCG, SexCG } from '../packages/dat-parser/src/file-types/CharacterGenerator.js';
import { ACFont } from '../packages/dat-parser/src/file-types/ACFont.js';
import { SkillTable } from '../packages/dat-parser/src/file-types/SkillTable.js';
import { ACFontRenderer } from '../packages/renderer/src/ui/ACFontRenderer.js';
import { SkillAdvancementClass } from '@ac/shared';
import { mountGameUI, openChargen, type GameUIFixture } from './_harness/gameui.js';
import { openDat } from './_harness/dat.js';

/* ------------------------------------------------------------------ */
/*  Setup: Load portal.dat if available                                */
/* ------------------------------------------------------------------ */

const DAT_DIR = path.resolve(__dirname, '..', 'dat');
const PORTAL_DAT = path.join(DAT_DIR, 'client_portal.dat');
const hasPortalDat = fs.existsSync(PORTAL_DAT);

let portalDb: DatDatabase | null = null;

beforeAll(() => {
  if (hasPortalDat) {
    portalDb = openDat(PORTAL_DAT);
  }
});

/* ------------------------------------------------------------------ */
/*  CharacterGenerator parsing (from real DAT)                         */
/* ------------------------------------------------------------------ */

describe('Phase 38 — Authentic AC UI from DAT Assets', () => {
  describe('CharacterGenerator parser', () => {
    it.skipIf(!hasPortalDat)('should parse CharacterGenerator from portal.dat', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x0E000002);
      expect(data).toBeDefined();
      expect(data!.byteLength).toBeGreaterThan(1000);

      const charGen = new CharacterGenerator(new DatReader(data!));
      expect(charGen.id).toBe(0x0E000002);
    });

    it.skipIf(!hasPortalDat)('should have at least 4 heritage groups (Aluvian, Gharundim, Sho, Viamontian)', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x0E000002)!;
      const charGen = new CharacterGenerator(new DatReader(data));

      expect(charGen.heritageGroups.size).toBeGreaterThanOrEqual(4);

      // Check for the 4 core heritages (keys 1-4)
      expect(charGen.heritageGroups.has(1)).toBe(true); // Aluvian
      expect(charGen.heritageGroups.has(2)).toBe(true); // Gharundim
      expect(charGen.heritageGroups.has(3)).toBe(true); // Sho
      expect(charGen.heritageGroups.has(4)).toBe(true); // Viamontian
    });

    it.skipIf(!hasPortalDat)('should have heritage names matching known values', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x0E000002)!;
      const charGen = new CharacterGenerator(new DatReader(data));

      const aluvian = charGen.heritageGroups.get(1)!;
      expect(aluvian.name).toBe('Aluvian');

      const gharundim = charGen.heritageGroups.get(2)!;
      expect(gharundim.name).toBe("Gharu'ndim");

      const sho = charGen.heritageGroups.get(3)!;
      expect(sho.name).toBe('Sho');

      const viamontian = charGen.heritageGroups.get(4)!;
      expect(viamontian.name).toBe('Viamontian');
    });

    it.skipIf(!hasPortalDat)('should have valid IconImage texture IDs for each heritage', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x0E000002)!;
      const charGen = new CharacterGenerator(new DatReader(data));

      for (const [key, heritage] of charGen.heritageGroups) {
        // IconImage should be a valid texture ID (0x06xxxxxx range)
        expect(heritage.iconImage).toBeGreaterThan(0);
        // Verify the texture actually exists in the DAT
        const texData = portalDb!.getFileData(heritage.iconImage);
        expect(texData).toBeDefined();
        expect(texData!.byteLength).toBeGreaterThan(0);
      }
    });

    it.skipIf(!hasPortalDat)('should have starter areas', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x0E000002)!;
      const charGen = new CharacterGenerator(new DatReader(data));

      expect(charGen.starterAreas.length).toBeGreaterThan(0);
      for (const area of charGen.starterAreas) {
        expect(area.name.length).toBeGreaterThan(0);
        expect(area.locations.length).toBeGreaterThan(0);
      }
    });

    it.skipIf(!hasPortalDat)('should have attribute and skill credits for each heritage', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x0E000002)!;
      const charGen = new CharacterGenerator(new DatReader(data));

      for (const [key, heritage] of charGen.heritageGroups) {
        expect(heritage.attributeCredits).toBeGreaterThan(0);
        expect(heritage.skillCredits).toBeGreaterThan(0);
      }
    });

    it.skipIf(!hasPortalDat)('should have skills with valid costs for each heritage', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x0E000002)!;
      const charGen = new CharacterGenerator(new DatReader(data));

      for (const [key, heritage] of charGen.heritageGroups) {
        expect(heritage.skills.length).toBeGreaterThan(0);
        for (const skill of heritage.skills) {
          expect(skill.skillNum).toBeGreaterThan(0);
          // Normal and primary costs should be reasonable numbers
          expect(skill.normalCost).toBeGreaterThanOrEqual(0);
        }
      }
    });

    it.skipIf(!hasPortalDat)('should have templates with names and attribute values', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x0E000002)!;
      const charGen = new CharacterGenerator(new DatReader(data));

      for (const [key, heritage] of charGen.heritageGroups) {
        expect(heritage.templates.length).toBeGreaterThan(0);
        for (const template of heritage.templates) {
          expect(template.name.length).toBeGreaterThan(0);
          expect(template.iconImage).toBeGreaterThan(0);
          // Attributes should be reasonable (10-100)
          expect(template.strength).toBeGreaterThanOrEqual(10);
          expect(template.strength).toBeLessThanOrEqual(100);
        }
      }
    });

    it.skipIf(!hasPortalDat)('should have template icon textures that exist in the DAT', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x0E000002)!;
      const charGen = new CharacterGenerator(new DatReader(data));

      const aluvian = charGen.heritageGroups.get(1)!;
      for (const template of aluvian.templates) {
        const texData = portalDb!.getFileData(template.iconImage);
        expect(texData).toBeDefined();
        expect(texData!.byteLength).toBeGreaterThan(0);
      }
    });

    it.skipIf(!hasPortalDat)('should have at least 2 genders per heritage with valid SexCG data', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x0E000002)!;
      const charGen = new CharacterGenerator(new DatReader(data));

      for (const [key, heritage] of charGen.heritageGroups) {
        // Most heritages have male (1) and female (0)
        expect(heritage.genders.size).toBeGreaterThanOrEqual(1);
      }

      // Core 4 heritages should have 2 genders
      for (let h = 1; h <= 4; h++) {
        const heritage = charGen.heritageGroups.get(h)!;
        expect(heritage.genders.size).toBe(2);
      }
    });

    it.skipIf(!hasPortalDat)('should have valid SexCG appearance data (hair, eyes, etc.)', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x0E000002)!;
      const charGen = new CharacterGenerator(new DatReader(data));

      const aluvian = charGen.heritageGroups.get(1)!;
      const maleSex = aluvian.genders.get(1)!;

      expect(maleSex.name.length).toBeGreaterThan(0);
      expect(maleSex.setupId).toBeGreaterThan(0);
      expect(maleSex.iconImage).toBeGreaterThan(0);
      expect(maleSex.basePalette).toBeGreaterThan(0);
      expect(maleSex.skinPalSet).toBeGreaterThan(0);

      // Should have hair options
      expect(maleSex.hairColorList.length).toBeGreaterThan(0);
      expect(maleSex.hairStyleList.length).toBeGreaterThan(0);

      // Should have eye options
      expect(maleSex.eyeColorList.length).toBeGreaterThan(0);
      expect(maleSex.eyeStripList.length).toBeGreaterThan(0);

      // Should have nose and mouth options
      expect(maleSex.noseStripList.length).toBeGreaterThan(0);
      expect(maleSex.mouthStripList.length).toBeGreaterThan(0);
    });

    it.skipIf(!hasPortalDat)('should have hair style icons that resolve in the DAT', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x0E000002)!;
      const charGen = new CharacterGenerator(new DatReader(data));

      const aluvian = charGen.heritageGroups.get(1)!;
      const maleSex = aluvian.genders.get(1)!;

      for (const hair of maleSex.hairStyleList) {
        expect(hair.iconImage).toBeGreaterThan(0);
        const texData = portalDb!.getFileData(hair.iconImage);
        expect(texData).toBeDefined();
      }
    });

    it.skipIf(!hasPortalDat)('should have clothing/gear options', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x0E000002)!;
      const charGen = new CharacterGenerator(new DatReader(data));

      const aluvian = charGen.heritageGroups.get(1)!;
      const maleSex = aluvian.genders.get(1)!;

      expect(maleSex.headgearList.length).toBeGreaterThanOrEqual(0);
      expect(maleSex.shirtList.length).toBeGreaterThan(0);
      expect(maleSex.pantsList.length).toBeGreaterThan(0);
      expect(maleSex.footwearList.length).toBeGreaterThan(0);
      expect(maleSex.clothingColorsList.length).toBeGreaterThan(0);

      // Clothing items should have names
      for (const shirt of maleSex.shirtList) {
        expect(shirt.name.length).toBeGreaterThan(0);
        expect(shirt.clothingTable).toBeGreaterThan(0);
      }
    });
  });

  /* ---------------------------------------------------------------- */
  /*  AC Font parsing                                                  */
  /* ---------------------------------------------------------------- */

  describe('AC Font parser', () => {
    it.skipIf(!hasPortalDat)('should parse font 0x40000000 from portal.dat', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x40000000);
      expect(data).toBeDefined();
      expect(data!.byteLength).toBeGreaterThan(100);

      const font = ACFont.read(new DatReader(data!));
      expect(font.id).toBe(0x40000000);
    });

    it.skipIf(!hasPortalDat)('should have at least 90 character descriptors', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x40000000)!;
      const font = ACFont.read(new DatReader(data));

      expect(font.charDescs.length).toBeGreaterThanOrEqual(90);
    });

    it.skipIf(!hasPortalDat)('should have valid max dimensions', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x40000000)!;
      const font = ACFont.read(new DatReader(data));

      expect(font.maxCharHeight).toBeGreaterThan(0);
      expect(font.maxCharWidth).toBeGreaterThan(0);
      expect(font.maxCharHeight).toBeLessThan(200);
      expect(font.maxCharWidth).toBeLessThan(200);
    });

    it.skipIf(!hasPortalDat)('should have a valid foreground spritesheet texture ID', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x40000000)!;
      const font = ACFont.read(new DatReader(data));

      expect(font.foregroundSurfaceDataId).toBeGreaterThan(0);
      // Verify the spritesheet texture exists
      const texData = portalDb!.getFileData(font.foregroundSurfaceDataId);
      expect(texData).toBeDefined();
      expect(texData!.byteLength).toBeGreaterThan(0);
    });

    it.skipIf(!hasPortalDat)('should have character descriptors with valid offsets and dimensions', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x40000000)!;
      const font = ACFont.read(new DatReader(data));

      // Check ASCII 'A' (codepoint 65) exists
      const charA = font.charDescs.find(c => c.unicode === 65);
      expect(charA).toBeDefined();
      expect(charA!.width).toBeGreaterThan(0);
      expect(charA!.height).toBeGreaterThan(0);
    });

    it.skipIf(!hasPortalDat)('should parse multiple fonts from the DAT', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');

      // Try a few known font IDs
      const fontIds = [0x40000000, 0x40000001, 0x40000002];
      let parsed = 0;
      for (const fontId of fontIds) {
        const data = portalDb!.getFileData(fontId);
        if (!data) continue;
        const font = ACFont.read(new DatReader(data));
        expect(font.charDescs.length).toBeGreaterThan(0);
        parsed++;
      }
      expect(parsed).toBeGreaterThanOrEqual(1);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  ACFontRenderer                                                   */
  /* ---------------------------------------------------------------- */

  describe('ACFontRenderer', () => {
    it.skipIf(!hasPortalDat)('should compute text layout from a parsed font', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x40000000)!;
      const font = ACFont.read(new DatReader(data));
      const renderer = new ACFontRenderer(font);

      const layout = renderer.layoutText('Hello');
      expect(layout.glyphs.length).toBe(5);
      expect(layout.width).toBeGreaterThan(0);
      expect(layout.height).toBeGreaterThan(0);
    });

    it.skipIf(!hasPortalDat)('should measure text width consistently with layout', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x40000000)!;
      const font = ACFont.read(new DatReader(data));
      const renderer = new ACFontRenderer(font);

      const text = 'Asheron';
      const layout = renderer.layoutText(text);
      const width = renderer.measureText(text);
      expect(width).toBe(layout.width);
    });

    it.skipIf(!hasPortalDat)('should expose the font spritesheet texture ID', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x40000000)!;
      const font = ACFont.read(new DatReader(data));
      const renderer = new ACFontRenderer(font);

      expect(renderer.foregroundTextureId).toBe(font.foregroundSurfaceDataId);
      expect(renderer.lineHeight).toBe(font.maxCharHeight);
    });

    it.skipIf(!hasPortalDat)('should report correct character count', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x40000000)!;
      const font = ACFont.read(new DatReader(data));
      const renderer = new ACFontRenderer(font);

      expect(renderer.characterCount).toBe(font.charDescs.length);
    });

    it.skipIf(!hasPortalDat)('should handle empty string gracefully', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x40000000)!;
      const font = ACFont.read(new DatReader(data));
      const renderer = new ACFontRenderer(font);

      const layout = renderer.layoutText('');
      expect(layout.glyphs.length).toBe(0);
      expect(layout.width).toBe(0);
    });

    it.skipIf(!hasPortalDat)('should look up individual characters', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x40000000)!;
      const font = ACFont.read(new DatReader(data));
      const renderer = new ACFontRenderer(font);

      const charA = renderer.getChar(65); // 'A'
      expect(charA).toBeDefined();
      expect(charA!.width).toBeGreaterThan(0);

      const missing = renderer.getChar(9999);
      expect(missing).toBeUndefined();
    });

    it.skipIf(!hasPortalDat)('should produce correct glyph positions (increasing x)', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x40000000)!;
      const font = ACFont.read(new DatReader(data));
      const renderer = new ACFontRenderer(font);

      const layout = renderer.layoutText('ABC');
      expect(layout.glyphs.length).toBe(3);

      // Each glyph should be further right than the previous
      for (let i = 1; i < layout.glyphs.length; i++) {
        expect(layout.glyphs[i].x).toBeGreaterThan(layout.glyphs[i - 1].x);
      }
    });

    it.skipIf(!hasPortalDat)('should report isReady=false before spritesheet initialization', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x40000000)!;
      const font = ACFont.read(new DatReader(data));
      const renderer = new ACFontRenderer(font);

      // Before initSpritesheet, isReady should be false
      expect(renderer.isReady).toBe(false);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  TextureManager icon methods (behavioural)                        */
  /* ---------------------------------------------------------------- */

  describe('TextureManager icon methods', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let TM: any;
    beforeAll(async () => {
      TM = (await import('../packages/renderer/src/models/TextureManager.js')).TextureManager;
    });

    it('exposes getIconRGBA / getIconDataURL / getDirectRGBA and the static rgbaToDataURL', () => {
      for (const m of ['getIconRGBA', 'getIconDataURL', 'getDirectRGBA']) expect(typeof TM.prototype[m], m).toBe('function');
      expect(typeof TM.rgbaToDataURL).toBe('function');
    });

    it('getIconRGBA dispatches on the id high byte: 0x05 SurfaceTexture → getRGBA, 0x06 Texture → getDirectRGBA, other → SurfaceTexture then direct', () => {
      const tm = new TM({ getFileData: () => null });
      const calls: string[] = [];
      const px = { width: 1, height: 1, data: new Uint8Array(4) };
      tm.getRGBA = (id: number) => { calls.push(`surf:${id.toString(16)}`); return id === 0x05000001 ? px : null; };
      tm.getDirectRGBA = (id: number) => { calls.push(`direct:${id.toString(16)}`); return px; };
      expect(tm.getIconRGBA(0x05000001)).toBe(px);
      expect(tm.getIconRGBA(0x06000002)).toBe(px);
      expect(tm.getIconRGBA(0x08000003)).toBe(px);
      expect(calls).toEqual(['surf:5000001', 'direct:6000002', 'surf:8000003', 'direct:8000003']);
    });

    it.skipIf(!hasPortalDat)('decodes real heritage icons from portal.dat (CharGen iconImage ids)', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const tm = new TM(portalDb);
      const charGen = new CharacterGenerator(new DatReader(portalDb.getFileData(0x0E000002)!));
      const icon = charGen.heritageGroups.get(1)!.iconImage;
      const rgba = tm.getIconRGBA(icon);
      expect(rgba).not.toBeNull();
      expect(rgba.width).toBeGreaterThan(0);
      expect(rgba.data.length).toBe(rgba.width * rgba.height * 4);
    });
  });

  /* ---------------------------------------------------------------- */
  /*  GameUI DAT integration (behavioural, real GameUI in happy-dom)   */
  /* ---------------------------------------------------------------- */

  describe('GameUI DAT integration', () => {
    let H: GameUIFixture;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let datUI: any;
    const iconRequests: number[] = [];
    const fakeTM = {
      getIconDataURL: (id: number) => { iconRequests.push(id); return `icon:${id}`; },
      getIconRGBA: () => null,
      getDirectRGBA: () => null,
    };
    beforeAll(async () => {
      H = await mountGameUI();
      if (portalDb) {
        const c = H.win.document.createElement('div');
        H.win.document.body.appendChild(c);
        datUI = new H.mod.GameUI(c, {}, portalDb, fakeTM as never);
      }
    });
    afterAll(() => H.teardown());

    it('the constructor takes portalDb + textureManager and keeps them; without a portalDb nothing DAT-backed loads', () => {
      const db = { getFileData: () => null };
      const c = H.win.document.createElement('div');
      const ui = new H.mod.GameUI(c, {}, db as never, fakeTM as never);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((ui as any).portalDb).toBe(db);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((ui as any).textureManager).toBe(fakeTM);
      expect(H.ui.characterGenerator).toBeNull();
      expect(H.ui.acFont).toBeNull();
    });

    it('no hardcoded heritage descriptions/names: the DAT-free Heritage page carries none of the old English blurbs', () => {
      const html: string = H.ui.renderRaceStep();
      for (const old of ['Hardy folk from the temperate lands', 'Desert scholars and mages', 'Eastern warriors from the islands', 'Noble knights from the kingdom']) {
        expect(html).not.toContain(old);
      }
      const exported = H.mod as unknown as Record<string, unknown>;
      expect(exported.HERITAGE_NAMES).toBeUndefined();
      expect(exported.HERITAGE_DESCRIPTIONS).toBeUndefined();
    });

    it('@ac/dat-parser exports the one CharacterGenerator GameUI parses CharGen with', async () => {
      // Behavioural replacement for a GameUI source-text pin: GameUI imports
      // CharacterGenerator from the package index, which must be the very
      // class the file-type module defines (the old duplicate CharGen parser
      // is gone — DAT.parser-cleanup).
      const idx = await import('@ac/dat-parser');
      expect(idx.CharacterGenerator).toBe(CharacterGenerator);
      expect((idx as Record<string, unknown>).CharGen).toBeUndefined();
    });

    it.skipIf(!hasPortalDat)('loads CharacterGenerator 0x0E000002 and AC Font 0x40000000 from the portalDb (characterGenerator / acFont getters)', () => {
      expect(datUI.characterGenerator).toBeInstanceOf(CharacterGenerator);
      expect(datUI.characterGenerator.heritageGroups.size).toBeGreaterThanOrEqual(4);
      expect(datUI.acFont).toBeInstanceOf(ACFontRenderer);
      expect(datUI.acFont.lineHeight).toBeGreaterThan(0);
    });

    it.skipIf(!hasPortalDat)('heritage icons come from each CharGen heritage iconImage via textureManager.getIconDataURL', () => {
      for (const [key, hg] of datUI.characterGenerator.heritageGroups as Map<number, HeritageGroupCG>) {
        if (!hg.iconImage) continue;
        expect(iconRequests).toContain(hg.iconImage);
        expect(datUI.getHeritageIcon(key)).toBe(`icon:${hg.iconImage}`);
      }
    });

    it.skipIf(!hasPortalDat)('the Appearance page reads the SexCG hair/eye/nose/mouth strip lists + hair colour list', () => {
      openChargen(datUI);
      const sex = datUI.characterGenerator.heritageGroups.get(1).genders.get(datUI.wizard.gender) as SexCG;
      const pageFor = (cat: string): HTMLElement => {
        datUI.appearMode = 'face';
        datUI.appearCategory = cat;
        const host = H.win.document.createElement('div');
        host.innerHTML = datUI.renderAppearanceStep();
        return host;
      };
      const styleKeys: Record<string, string> = { hairStyle: 'hairStyle', eyes: 'eyesStrip', nose: 'noseStyle', mouth: 'mouthStyle' };
      const lists: Array<[string, ReadonlyArray<{ iconImage?: number }>]> = [
        ['hairStyle', sex.hairStyleList], ['eyes', sex.eyeStripList], ['nose', sex.noseStripList], ['mouth', sex.mouthStripList],
      ];
      for (const [cat, list] of lists) {
        const host = pageFor(cat);
        // VISUAL.chargen-appearance-stepper-rows — no invented "< n/m >" stepper;
        // the row arrow steps through the list: back from the first wraps to the last.
        expect(host.querySelectorAll('.appear-inc, .appear-dec'), cat).toHaveLength(0);
        datUI.wizard.appearance[styleKeys[cat]] = 0;
        datUI.stepChargenStyleArrow(cat, -1);
        expect(datUI.wizard.appearance[styleKeys[cat]], cat).toBe(list.length - 1);
        // VISUAL.chargen-swatch-colours.a — retail draws no style-icon grid
        // (gmCGAppearancePage: styles step with the row arrows 0x1000030a/b),
        // so the icons are never requested for the page.
        expect(host.querySelectorAll('.appear-pick, img'), cat).toHaveLength(0);
        expect(host.querySelectorAll(`.appear-style-arrow[data-cat="${cat}"]`), cat).toHaveLength(2);
      }
      // the hair colours are the wheel's spots (DoColorSpots): one per hairColorList entry
      expect(pageFor('hairStyle').querySelectorAll('.appear-spot').length).toBe(Math.min(sex.hairColorList.length, 9));
    });

    it.skipIf(!hasPortalDat)('chargen skill defaults come from the CharGen heritage skill costs (heritage.skills normalCost overrides the SkillTable)', () => {
      const hg = datUI.characterGenerator.heritageGroups.get(1) as HeritageGroupCG;
      const classes: number[] = datUI.defaultChargenSkillClasses(1);
      for (const s of hg.skills) {
        if (s.skillNum < 1 || s.skillNum > 54 || s.normalCost < 0 || s.primaryCost < 0) continue;
        const expected = s.normalCost < 1
          ? (s.primaryCost < 1 ? SkillAdvancementClass.Specialized : SkillAdvancementClass.Trained)
          : SkillAdvancementClass.Untrained;
        expect(classes[s.skillNum], `skill ${s.skillNum}`).toBe(expected);
      }
    });

    it.skipIf(!hasPortalDat)('the profession rows are the CharGen template list: every row\'s template_ names the DAT template pcProfessions names, and a template fits itself (CORE.17.k.b.b.a.f.b — behavioural, was a source pin)', async () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const charGen = new CharacterGenerator(new DatReader(portalDb.getFileData(0x0E000002)!));
      const skillTable = new SkillTable(new DatReader(portalDb.getFileData(0x0E000004)!));
      const { PROFESSION_ROW_TEMPLATE, TEMPLATE_PROFESSION_ROW, fitTemplateToCharacter, chargenSkillCosts, applyTemplateSkills, skillLevelOf } =
        await import('../packages/renderer/src/ui/ChargenTemplates.js');
      const { SUMMARY_PROFESSIONS } = await import('../packages/renderer/src/ui/ChargenSummary.js');
      const aluvian = charGen.heritageGroups.get(1)!;
      expect(aluvian.templates.map((t) => t.name)).toEqual(['Adventurer', 'Bow Hunter', 'Swashbuckler', 'Life Caster', 'War Mage', 'Wayfarer', 'Soldier']);
      for (const [rowHex, index] of Object.entries(PROFESSION_ROW_TEMPLATE)) {
        expect(TEMPLATE_PROFESSION_ROW[index]).toBe(Number(rowHex));
        if (index > 0) expect(aluvian.templates[index].name).toBe(SUMMARY_PROFESSIONS[index]);
      }
      const costs = chargenSkillCosts(skillTable.skills, aluvian.skills);
      for (let i = 1; i < aluvian.templates.length; i++) {
        const t = aluvian.templates[i];
        const state = { totalSkillCredits: aluvian.skillCredits, remainingSkillCredits: aluvian.skillCredits, levels: new Map<number, number>() };
        applyTemplateSkills(state, t, costs);
        expect(fitTemplateToCharacter(aluvian.templates, t, (id) => skillLevelOf(state, id))).toBe(i);
      }
    });

    it('uses the AC colour scheme (AC_COLORS), not web-default button colours', () => {
      const colors = H.mod.AC_COLORS as Record<string, string>;
      for (const k of ['panelBg', 'panelBorder', 'goldLight']) expect(typeof colors[k], k).toBe('string');
      expect(Object.values(colors)).not.toContain('#2a5a8a');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  ACFontRenderer canvas rendering                                  */
  /* ---------------------------------------------------------------- */

  describe('ACFontRenderer canvas rendering', () => {
    it.skipIf(!hasPortalDat)('should have renderToCanvas method', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x40000000)!;
      const font = ACFont.read(new DatReader(data));
      const renderer = new ACFontRenderer(font);

      expect(typeof renderer.renderToCanvas).toBe('function');
    });

    it.skipIf(!hasPortalDat)('should have renderTextToCanvas method', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x40000000)!;
      const font = ACFont.read(new DatReader(data));
      const renderer = new ACFontRenderer(font);

      expect(typeof renderer.renderTextToCanvas).toBe('function');
    });

    it.skipIf(!hasPortalDat)('should have initSpritesheet method', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x40000000)!;
      const font = ACFont.read(new DatReader(data));
      const renderer = new ACFontRenderer(font);

      expect(typeof renderer.initSpritesheet).toBe('function');
    });

    it.skipIf(!hasPortalDat)('should have renderTextToDataURL method', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x40000000)!;
      const font = ACFont.read(new DatReader(data));
      const renderer = new ACFontRenderer(font);

      expect(typeof renderer.renderTextToDataURL).toBe('function');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  SkillTable parsing (full skill list)                             */
  /* ---------------------------------------------------------------- */

  describe('SkillTable parser (0x0E000004)', () => {
    it.skipIf(!hasPortalDat)('should parse SkillTable with 30+ trainable skills', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x0E000004);
      expect(data).toBeDefined();

      const skillTable = new SkillTable(new DatReader(data!));
      expect(skillTable.skills.size).toBeGreaterThanOrEqual(30);
    });

    it.skipIf(!hasPortalDat)('should include known skill IDs: Melee Defense(6), Arcane Lore(14), Life Magic(33), War Magic(34)', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x0E000004)!;
      const skillTable = new SkillTable(new DatReader(data));

      expect(skillTable.skills.has(6)).toBe(true);   // Melee Defense
      expect(skillTable.skills.has(14)).toBe(true);  // Arcane Lore
      expect(skillTable.skills.has(33)).toBe(true);  // Life Magic
      expect(skillTable.skills.has(34)).toBe(true);  // War Magic
    });

    it.skipIf(!hasPortalDat)('should have skills with valid training costs', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x0E000004)!;
      const skillTable = new SkillTable(new DatReader(data));

      let trainableCount = 0;
      for (const [id, skill] of skillTable.skills) {
        expect(skill.trainedCost).toBeGreaterThanOrEqual(0);
        expect(skill.specializedCost).toBeGreaterThanOrEqual(0);
        if (skill.trainedCost > 0) trainableCount++;
      }
      expect(trainableCount).toBeGreaterThanOrEqual(30);
    });

    it.skipIf(!hasPortalDat)('should have skill names matching known values', () => {
      if (!portalDb) throw new Error('portal.dat not loaded');
      const data = portalDb.getFileData(0x0E000004)!;
      const skillTable = new SkillTable(new DatReader(data));

      expect(skillTable.skills.get(6)!.name).toBe('Melee Defense');
      expect(skillTable.skills.get(14)!.name).toBe('Arcane Lore');
    });
  });

  /* ---------------------------------------------------------------- */
  /*  GameUI SkillTable integration (behavioural)                      */
  /* ---------------------------------------------------------------- */

  describe.skipIf(!hasPortalDat)('GameUI SkillTable integration', () => {
    let H: GameUIFixture;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ui: any;
    beforeAll(async () => {
      H = await mountGameUI();
      const c = H.win.document.createElement('div');
      H.win.document.body.appendChild(c);
      ui = new H.mod.GameUI(c, {}, portalDb!);
    });
    afterAll(() => H.teardown());

    it('GameUI loads the SkillTable (0x0E000004): skill names resolve from the DAT', () => {
      expect(ui.skillTable).toBeInstanceOf(SkillTable);
      expect(ui.getSkillName(14)).toBe('Arcane Lore');
    });

    it('the chargen skill list is the SkillTable\'s chargen-usable skills', () => {
      const skills: Array<{ id: number; skill: { chargenUse: number } }> = ui.getChargenSkills();
      expect(skills.length).toBeGreaterThan(20);
      for (const { id, skill } of skills) {
        expect(skill.chargenUse).toBe(1);
        expect(ui.skillTable.skills.get(id)).toBe(skill);
      }
    });

    it('the character-creation screen draws text with the AC font (data-ac-text → renderACText), never a CSS font-family', () => {
      openChargen(ui);
      const root = ui.container as HTMLElement;
      const html = root.innerHTML;
      expect(html).not.toMatch(/font-family/i);
      expect(html).not.toContain('Segoe UI');
      for (const el of root.querySelectorAll('*')) expect((el as HTMLElement).style.fontFamily).toBe('');
      // replaceACTextElements consumed every data-ac-text span into AC-font output
      expect(root.querySelectorAll('[data-ac-text]').length).toBe(0);
    });
  });
});
