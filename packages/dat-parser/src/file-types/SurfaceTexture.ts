import { DatReader } from '../DatReader.js';

/**
 * SurfaceTexture — 0x05 portal.dat files.
 * Multi-resolution texture container referencing 0x06 Texture entries.
 */
export class SurfaceTexture {
  id: number = 0;
  unknown: number = 0;
  unknownByte: number = 0;
  textures: number[] = [];

  static read(reader: DatReader): SurfaceTexture {
    const st = new SurfaceTexture();
    st.id = reader.readUInt32();
    st.unknown = reader.readInt32();
    st.unknownByte = reader.readUInt8();

    // List<uint>.Unpack reads an Int32 count, then that many UInt32 values
    const count = reader.readInt32();
    for (let i = 0; i < count; i++) {
      st.textures.push(reader.readUInt32());
    }

    return st;
  }
}
