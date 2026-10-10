/**
 * DatWriter — little-endian writer that re-encodes DAT files in the
 * end-of-retail formats our parsers read (the inverse of DatReader). The 1999
 * format translators (era1999/) build their output with it, so every parser
 * and renderer keeps reading end-of-retail bytes.
 */
export class DatWriter {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  private pos = 0;

  get position(): number {
    return this.pos;
  }

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  writeUInt8(v: number): this { this.ensure(1); this.view.setUint8(this.pos, v); this.pos += 1; return this; }
  writeInt8(v: number): this { this.ensure(1); this.view.setInt8(this.pos, v); this.pos += 1; return this; }
  writeUInt16(v: number): this { this.ensure(2); this.view.setUint16(this.pos, v, true); this.pos += 2; return this; }
  writeInt16(v: number): this { this.ensure(2); this.view.setInt16(this.pos, v, true); this.pos += 2; return this; }
  writeUInt32(v: number): this { this.ensure(4); this.view.setUint32(this.pos, v >>> 0, true); this.pos += 4; return this; }
  writeInt32(v: number): this { this.ensure(4); this.view.setInt32(this.pos, v | 0, true); this.pos += 4; return this; }
  writeFloat32(v: number): this { this.ensure(4); this.view.setFloat32(this.pos, v, true); this.pos += 4; return this; }
  writeFloat64(v: number): this { this.ensure(8); this.view.setFloat64(this.pos, v, true); this.pos += 8; return this; }
  writeUInt64(v: bigint | number): this {
    this.ensure(8);
    this.view.setBigUint64(this.pos, BigInt(v), true);
    this.pos += 8;
    return this;
  }

  writeBytes(bytes: Uint8Array | ArrayBuffer): this {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.ensure(b.length);
    this.buf.set(b, this.pos);
    this.pos += b.length;
    return this;
  }

  /** The EoL CompressedUInt32 (DatReader.readCompressedUInt32's inverse). */
  writeCompressedUInt32(v: number): this {
    v >>>= 0;
    if (v < 0x80) return this.writeUInt8(v);
    if (v < 0x4000) return this.writeUInt8(((v >>> 8) & 0x7f) | 0x80).writeUInt8(v & 0xff);
    if (v >= 0x40000000) throw new Error(`CompressedUInt32 out of range: ${v}`);
    return this.writeUInt8(((v >>> 24) & 0x3f) | 0xc0).writeUInt8((v >>> 16) & 0xff).writeUInt16(v & 0xffff);
  }

  /** A PString: u16 (or u8) length then the bytes (Windows-1252 already encoded by the caller). No align. */
  writePString(bytes: Uint8Array, sizeOfLength: 1 | 2 = 2): this {
    if (sizeOfLength === 1) this.writeUInt8(bytes.length); else this.writeUInt16(bytes.length);
    return this.writeBytes(bytes);
  }

  /** Pad with zeros to a multiple of `boundary` (DatReader.align's inverse). */
  align(boundary = 4): this {
    const d = this.pos % boundary;
    if (d) { this.ensure(boundary - d); this.pos += boundary - d; }
    return this;
  }

  /** The written bytes as a fresh ArrayBuffer. */
  toArrayBuffer(): ArrayBuffer {
    return this.buf.slice(0, this.pos).buffer;
  }
}
