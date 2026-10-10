import { DatReader } from '../DatReader.js';
import { decodeWindows1252 } from '@ac/shared';

/**
 * LanguageString — portal.dat files starting with 0x31.
 *
 * Single-string DAT entry. AC's localizable text strings (UI labels,
 * system messages, etc.) live in these files, one entry per file. The
 * StringTable parser (0x23) wraps a hash table of these references.
 *
 * Wire format: id (uint32) + compressed-uint32 length + Windows-1252 bytes.
 *
 * Reference: reference/ACE/Source/ACE.DatLoader/FileTypes/LanguageString.cs
 */
export class LanguageString {
  id: number = 0;
  charBuffer: string = '';

  static read(reader: DatReader): LanguageString {
    const s = new LanguageString();
    s.id = reader.readUInt32();
    const strLen = reader.readCompressedUInt32();
    if (strLen > 0) {
      const bytes = reader.readBytes(strLen);
      s.charBuffer = decodeWindows1252(bytes);
    }
    return s;
  }
}
