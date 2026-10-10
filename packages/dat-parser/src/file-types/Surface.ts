import { DatReader } from '../DatReader.js';

/**
 * SurfaceType flags — from ACE SurfaceType.cs
 */
export enum SurfaceType {
  Base1Solid = 0x1,
  Base1Image = 0x2,
  Base1ClipMap = 0x4,
  Translucent = 0x10,
  Diffuse = 0x20,
  Luminous = 0x40,
  Alpha = 0x100,
  InvAlpha = 0x200,
  Additive = 0x10000,
  Detail = 0x20000,
  Gouraud = 0x10000000,
  Stippled = 0x40000000,
  Perspective = 0x80000000,
}

/**
 * Surface — 0x08 portal.dat files.
 * Material definition: either a texture+palette reference or a solid color, plus lighting params.
 */
export class Surface {
  type: number = 0;
  origTextureId: number = 0;
  origPaletteId: number = 0;
  colorValue: number = 0;
  translucency: number = 0;
  luminosity: number = 0;
  diffuse: number = 0;

  static read(reader: DatReader): Surface {
    const surf = new Surface();
    surf.type = reader.readUInt32();

    if ((surf.type & SurfaceType.Base1Image) !== 0 || (surf.type & SurfaceType.Base1ClipMap) !== 0) {
      // Image or clipmap — has texture + palette refs
      surf.origTextureId = reader.readUInt32();
      surf.origPaletteId = reader.readUInt32();
    } else {
      // Solid color
      surf.colorValue = reader.readUInt32();
    }

    surf.translucency = reader.readFloat32();
    surf.luminosity = reader.readFloat32();
    surf.diffuse = reader.readFloat32();

    return surf;
  }
}
