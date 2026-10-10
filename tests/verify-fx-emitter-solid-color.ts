/**
 * FX.emitter-black-solid-becomes-white — an untextured particle surface
 * draws its own colour: D3DPolyRender::SetSurface @ 0059c4d0 with no texture
 * map → SetSolidColorTextureColor(alpha << 24 | color_value & 0xffffff).
 * resolveEmitterSprite's `colorValue & 0xffffff || 0xffffff` turned a solid
 * BLACK surface white. Driven through the real resolveEmitterSprite with the
 * hand-glow emitter 0x32000109's HW GfxObj, its first surface swapped for a
 * solid one.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolveEmitterSprite } from '../packages/renderer/src/effects/EmitterSprite.js';
import { TextureManager } from '../packages/renderer/src/models/TextureManager.js';
import { ParticleEmitterInfo } from '../packages/dat-parser/src/file-types/ParticleEmitterInfo.js';
import { GfxObj } from '../packages/dat-parser/src/file-types/GfxObj.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

/** A solid-colour Surface's bytes: type 0x1 (Base1Solid), colour, translucency, luminosity, diffuse. */
function solidSurface(argb: number): ArrayBuffer {
  const b = new ArrayBuffer(20);
  const v = new DataView(b);
  v.setUint32(0, 0x1, true);
  v.setUint32(4, argb >>> 0, true);
  v.setFloat32(8, 0, true);
  v.setFloat32(12, 1, true);
  v.setFloat32(16, 1, true);
  return b;
}

describe.skipIf(!existsSync(DAT_PATHS.portal))('solid particle surfaces keep their colour (DAT)', () => {
  let portal: DatDatabase;
  let info: ParticleEmitterInfo;
  let surfaceId: number;
  beforeAll(() => {
    portal = openDat(DAT_PATHS.portal);
    info = new ParticleEmitterInfo(new DatReader(portal.getFileData(0x32000109)!));
    surfaceId = new GfxObj(new DatReader(portal.getFileData(info.hwGfxObjId)!)).surfaces[0];
  });

  const spriteWith = (argb: number) => {
    const db = { getFileData: (id: number) => (id === surfaceId ? solidSurface(argb) : portal.getFileData(id)) };
    return resolveEmitterSprite(info, db, new TextureManager(portal))!;
  };

  it('a solid black surface stays black', () => {
    const surf = spriteWith(0xff000000).gfx!.gfxObjs[0][0].surface;
    expect(surf.map).toBeNull();
    expect(surf.color).toBe(0x000000);
  });

  it('a solid red surface stays red', () => {
    expect(spriteWith(0xffff0000).gfx!.gfxObjs[0][0].surface.color).toBe(0xff0000);
  });
});
