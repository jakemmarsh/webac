/**
 * VISUAL.xarabydun-torch-crystal-glow — the Xarabydun pit torches (Setup
 * 0x02000719, one part GfxObj 0x01001A6E) draw their crystal at retail's
 * brightness. The crystal surface 0x080004A4 is a plain Base1Image (type 0x2)
 * with luminosity 0.80; retail lights it with that luminosity as the D3D
 * Emissive (`D3DPolyRender::RenderMeshSubset` @ 0059ca10), so the crystal
 * reaches its raw cyan texel. The fix landed with VISUAL.lifestone-crystal-glow;
 * this pins the torch's own DAT chain, including the DefaultScript glow
 * (0x330007E0 → emitter 0x3200082B → additive quad 0x01001749).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { MaterialFactory } from '@ac/renderer/models/MaterialFactory.js';
import { SetupModel } from '@ac/dat-parser/file-types/SetupModel.js';
import { GfxObj } from '@ac/dat-parser/file-types/GfxObj.js';
import { Surface, SurfaceType } from '@ac/dat-parser/file-types/Surface.js';
import { PhysicsScript } from '@ac/dat-parser/file-types/PhysicsScript.js';
import { ParticleEmitterInfo } from '@ac/dat-parser/file-types/ParticleEmitterInfo.js';
import { AnimationHookType } from '@ac/dat-parser/file-types/AnimationHook.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { surfaceLuminosityOf } from '../packages/renderer/src/models/RetailLighting.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

const TORCH_SETUP = 0x02000719;
const TORCH_PART = 0x01001a6e;
const CRYSTAL_SURFACE = 0x080004a4;

describe.skipIf(!existsSync(DAT_PATHS.portal))('VISUAL.xarabydun-torch-crystal-glow — the DAT torch (needs portal.dat)', () => {
  let portal: DatDatabase;
  let factory: MaterialFactory;
  beforeAll(async () => {
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    portal = openDat(DAT_PATHS.portal);
    factory = new MaterialFactory(portal, new TextureManager(portal));
  });

  it('the torch part carries the luminous crystal surface; only it draws with an emissive', () => {
    const setup = new SetupModel(new DatReader(portal.getFileData(TORCH_SETUP)!));
    expect(setup.parts).toEqual([TORCH_PART]);
    const part = new GfxObj(new DatReader(portal.getFileData(TORCH_PART)!));
    const surfaces = [...new Set(part.surfaces)];
    expect(surfaces).toContain(CRYSTAL_SURFACE);
    for (const id of surfaces) {
      const s = Surface.read(new DatReader(portal.getFileData(id)!));
      const m = factory.getMaterial(id) as THREE.MeshLambertMaterial;
      expect(m).toBeInstanceOf(THREE.MeshLambertMaterial);
      if (id === CRYSTAL_SURFACE) {
        expect(s.type).toBe(SurfaceType.Base1Image); // no Luminous flag: the float alone lights it
        expect(m.emissive.r).toBeCloseTo(s.luminosity, 6);
        expect(m.emissive.r).toBeGreaterThan(0.8);
        expect(surfaceLuminosityOf(m)).toBeCloseTo(s.luminosity, 6);
        expect(m.transparent).toBe(false);
      } else {
        expect(m.emissive.r).toBe(0);
      }
    }
  });

  it('the DefaultScript makes one additive full-luminosity glow quad at the crystal', () => {
    const setup = new SetupModel(new DatReader(portal.getFileData(TORCH_SETUP)!));
    expect(setup.defaultScript).toBe(0x330007e0);
    const script = PhysicsScript.read(new DatReader(portal.getFileData(setup.defaultScript)!));
    expect(script.steps).toHaveLength(1);
    const hook = script.steps[0].hook as { hookType: number; emitterInfoId: number; offset: { origin: { z: number } } };
    expect(hook.hookType).toBe(AnimationHookType.CreateParticle);
    expect(hook.offset.origin.z).toBeCloseTo(1.2, 5);
    const info = new ParticleEmitterInfo(new DatReader(portal.getFileData(hook.emitterInfoId)!));
    expect(info.maxParticles).toBe(1);
    const quad = new GfxObj(new DatReader(portal.getFileData(info.hwGfxObjId)!));
    const glow = Surface.read(new DatReader(portal.getFileData(quad.surfaces[0])!));
    expect(glow.type & SurfaceType.Additive).toBeTruthy();
    expect(glow.luminosity).toBe(1);
  });
});
