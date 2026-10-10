import { DatReader } from '../DatReader.js';

/**
 * RenderTexture — 0x15 portal.dat files (the DebugConsole's background
 * textures: 0x15000000 ConsoleOutputBackgroundTexture, 0x15000001
 * ConsoleInputBackgroundTexture, per DidMapper 0x25000002).
 * Reference: ACE.DatLoader/FileTypes/RenderTexture.cs — same shape as
 * SurfaceTexture: Id, DataCategory uint32, TextureType byte, List<uint>
 * (int32 count + uint32 Texture ids).
 */
export class RenderTexture {
  id: number = 0;
  dataCategory: number = 0;
  /** ACE.Entity.Enum.TextureType (byte). */
  textureType: number = 0;
  textures: number[] = [];

  static read(reader: DatReader): RenderTexture {
    const rt = new RenderTexture();
    rt.id = reader.readUInt32();
    rt.dataCategory = reader.readUInt32();
    rt.textureType = reader.readUInt8();
    const count = reader.readInt32();
    for (let i = 0; i < count; i++) rt.textures.push(reader.readUInt32());
    return rt;
  }
}
