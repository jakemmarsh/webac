/**
 * Sequential binary reader for AC DAT files.
 * Wraps a DataView on an ArrayBuffer with position tracking.
 * All numeric reads are little-endian to match AC's wire format.
 *
 * STRING ENCODING: Per ACE BinaryReaderExtensions.cs, DAT-file strings use
 * Windows-1252 (`Encoding.Default.GetString` for ReadPString;
 * `Encoding.GetEncoding(1252).GetString` for ReadObfuscatedString). Same fix
 * shape as FAITHFUL.170 — Node's TextDecoder('windows-1252') doesn't map
 * the 0x80-0x9F range correctly, so we use our explicit decodeWindows1252
 * helper from `@ac/network` instead.
 */
import { decodeWindows1252 } from '@ac/shared';

export class DatReader {
  private view: DataView;
  private buffer: ArrayBuffer;
  private offset: number;

  constructor(buffer: ArrayBuffer, offset: number = 0) {
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.offset = offset;
  }

  get position(): number {
    return this.offset;
  }

  set position(value: number) {
    this.offset = value;
  }

  get remaining(): number {
    return this.buffer.byteLength - this.offset;
  }

  get length(): number {
    return this.buffer.byteLength;
  }

  // --- Integer reads (all little-endian) ---

  readUInt8(): number {
    const val = this.view.getUint8(this.offset);
    this.offset += 1;
    return val;
  }

  readInt8(): number {
    const val = this.view.getInt8(this.offset);
    this.offset += 1;
    return val;
  }

  readUInt16(): number {
    const val = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return val;
  }

  readInt16(): number {
    const val = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return val;
  }

  readUInt32(): number {
    const val = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return val >>> 0; // Ensure unsigned
  }

  readInt32(): number {
    const val = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return val;
  }

  readFloat32(): number {
    const val = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return val;
  }

  readFloat64(): number {
    const val = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return val;
  }

  // --- Byte array ---

  readBytes(count: number): Uint8Array {
    const bytes = new Uint8Array(this.buffer, this.offset, count);
    this.offset += count;
    return new Uint8Array(bytes); // Copy to avoid view issues
  }

  // --- Compressed integer (AC-specific encoding) ---

  readCompressedUInt32(): number {
    const b0 = this.readUInt8();

    if ((b0 & 0x80) === 0) {
      // 1 byte: 0–127
      return b0;
    }

    const b1 = this.readUInt8();

    if ((b0 & 0x40) === 0) {
      // 2 bytes: 128–16383
      return ((b0 & 0x7f) << 8) | b1;
    }

    // 4 bytes
    const s = this.readUInt16();
    return ((((b0 & 0x3f) << 8) | b1) << 16) | s;
  }

  // --- Packed DataID (AC-specific) ---

  readDataIdOfKnownType(knownType: number): number {
    const value = this.readUInt16();
    if ((value & 0x8000) !== 0) {
      const lower = this.readUInt16();
      const higher = (value & 0x3fff) << 16;
      return (knownType + (higher | lower)) >>> 0;
    }
    return (knownType + value) >>> 0;
  }

  // --- Strings ---

  /**
   * Read a string using .NET BinaryReader.ReadString() format:
   * 7-bit encoded integer length prefix + Windows-1252 bytes, no alignment.
   * (Matches ACE BinaryReaderExtensions.cs:79 `Encoding.Default.GetString`.)
   */
  readString(): string {
    const length = this.read7BitEncodedInt();
    if (length === 0) return '';
    const bytes = this.readBytes(length);
    return decodeWindows1252(bytes);
  }

  /**
   * Read a 7-bit encoded integer (.NET BinaryReader format).
   * Each byte: lower 7 bits are data, high bit means "more bytes follow".
   */
  read7BitEncodedInt(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = this.readUInt8();
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  }

  /**
   * Read a PString: length-prefixed Windows-1252 string.
   * NOTE: Does NOT auto-align. Callers must call align(4) after if needed.
   * Matches ACE C#'s ReadPString (BinaryReaderExtensions.cs:60-80) which
   * uses Encoding.Default.GetString and does not align internally.
   */
  readPString(sizeOfLength: number = 2): string {
    let length: number;
    if (sizeOfLength === 1) {
      length = this.readUInt8();
    } else {
      length = this.readUInt16();
    }

    const bytes = this.readBytes(length);
    return decodeWindows1252(bytes);
  }

  readObfuscatedString(): string {
    const length = this.readUInt16();
    const bytes = this.readBytes(length);

    // Swap upper/lower nibbles to deobfuscate
    for (let i = 0; i < length; i++) {
      bytes[i] = ((bytes[i] >> 4) | (bytes[i] << 4)) & 0xff;
    }

    return decodeWindows1252(bytes);
  }

  readUnicodeString(): string {
    const length = this.readCompressedUInt32();
    let str = '';
    for (let i = 0; i < length; i++) {
      str += String.fromCharCode(this.readUInt16());
    }
    return str;
  }

  // --- Navigation ---

  seek(position: number): void {
    this.offset = position;
  }

  skip(count: number): void {
    this.offset += count;
  }

  align(boundary: number = 4): void {
    const delta = this.offset % boundary;
    if (delta !== 0) {
      this.offset += boundary - delta;
    }
  }

  // --- Sub-buffer ---

  slice(length: number): ArrayBuffer {
    const sliced = this.buffer.slice(this.offset, this.offset + length);
    this.offset += length;
    return sliced;
  }

  // --- Collection helpers ---

  readList<T>(readFn: () => T): T[] {
    const count = this.readUInt32();
    const items: T[] = [];
    for (let i = 0; i < count; i++) {
      items.push(readFn());
    }
    return items;
  }

  readListWithCount<T>(count: number, readFn: () => T): T[] {
    const items: T[] = [];
    for (let i = 0; i < count; i++) {
      items.push(readFn());
    }
    return items;
  }

  // --- Vector/Quaternion helpers ---

  readVector3(): { x: number; y: number; z: number } {
    return {
      x: this.readFloat32(),
      y: this.readFloat32(),
      z: this.readFloat32(),
    };
  }

  readQuaternion(): { w: number; x: number; y: number; z: number } {
    return {
      w: this.readFloat32(),
      x: this.readFloat32(),
      y: this.readFloat32(),
      z: this.readFloat32(),
    };
  }
}
