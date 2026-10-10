import { DatReader } from '../DatReader.js';

/**
 * FontCharDesc -- describes a single character glyph within the font spritesheet.
 * Each entry is 11 bytes in the DAT file.
 */
export interface FontCharDesc {
  unicode: number;               // uint16 - Unicode codepoint
  offsetX: number;               // uint16 - X offset in spritesheet
  offsetY: number;               // uint16 - Y offset in spritesheet
  width: number;                 // uint8  - glyph width in pixels
  height: number;                // uint8  - glyph height in pixels
  horizontalOffsetBefore: number; // int8   - spacing before glyph
  horizontalOffsetAfter: number;  // int8   - spacing after glyph
  verticalOffsetBefore: number;   // int8   - vertical offset (baseline adjustment)
}
// The three offsets are SIGNED bytes (0xFF = -1): retail
// TextureBasedFont::ComputeTextWidth sign-extends them (`(int)m_Horizontal…`)
// while zero-extending `(uint)m_Width`. ACE FontCharDesc.cs declares them
// `byte`, which is wrong for negative kerning — read with readInt8 below.

/**
 * ACFont -- bitmap font from portal.dat (0x40xxxxxx).
 * Contains character descriptors that reference a spritesheet texture.
 * Reference: ACE.DatLoader/FileTypes/Font.cs
 */
export class ACFont {
  id: number = 0;
  maxCharHeight: number = 0;
  maxCharWidth: number = 0;
  numCharacters: number = 0;
  charDescs: FontCharDesc[] = [];
  numHorizontalBorderPixels: number = 0;
  numVerticalBorderPixels: number = 0;
  baselineOffset: number = 0;
  foregroundSurfaceDataId: number = 0;
  backgroundSurfaceDataId: number = 0;

  static read(reader: DatReader): ACFont {
    const font = new ACFont();

    font.id = reader.readUInt32();
    font.maxCharHeight = reader.readUInt32();
    font.maxCharWidth = reader.readUInt32();
    font.numCharacters = reader.readUInt32();

    for (let i = 0; i < font.numCharacters; i++) {
      const desc: FontCharDesc = {
        unicode: reader.readUInt16(),
        offsetX: reader.readUInt16(),
        offsetY: reader.readUInt16(),
        width: reader.readUInt8(),
        height: reader.readUInt8(),
        // Offsets are stored as bytes in the DAT but the original C/C++ client
        // treated them as signed char. Values like 0xFF mean -1, not 255.
        horizontalOffsetBefore: reader.readInt8(),
        horizontalOffsetAfter: reader.readInt8(),
        verticalOffsetBefore: reader.readInt8(),
      };
      font.charDescs.push(desc);
    }

    font.numHorizontalBorderPixels = reader.readUInt32();
    font.numVerticalBorderPixels = reader.readUInt32();
    font.baselineOffset = reader.readUInt32();
    font.foregroundSurfaceDataId = reader.readUInt32();
    font.backgroundSurfaceDataId = reader.readUInt32();

    return font;
  }
}
