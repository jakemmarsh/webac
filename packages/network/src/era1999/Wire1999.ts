/**
 * Byte-level reading and writing of 1999 messages (the adapter's primitives;
 * docs/ac1999-support.md). The one primitive that differs from end of retail:
 *
 * AcString: u16 length COUNTING a trailing NUL, the bytes, the NUL, then zero
 * padding to a 4-byte boundary of the position in the MESSAGE (opcode at 0);
 * an empty string is the 2-byte length 0 with no pad (KB primitives/AcString.md,
 * confirmed against the real client's capture). End of retail's String16L
 * counts no NUL and pads relative to the string's own start.
 */
import { decodeWindows1252, encodeWindows1252 } from '@ac/shared';

export class Reader1999 {
  readonly view: DataView;
  pos: number;

  constructor(readonly data: Uint8Array, start = 0) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.pos = start;
  }

  get remaining(): number { return this.data.length - this.pos; }

  private need(n: number): void {
    if (this.pos + n > this.data.length) throw new RangeError(`1999 message: need ${n} bytes at ${this.pos}, have ${this.remaining}`);
  }

  u8(): number { this.need(1); return this.view.getUint8(this.pos++); }
  u16(): number { this.need(2); const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16(): number { this.need(2); const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u32(): number { this.need(4); const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  i32(): number { this.need(4); const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  f32(): number { this.need(4); const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
  f64(): number { this.need(8); const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; }
  bytes(n: number): Uint8Array { this.need(n); const b = this.data.slice(this.pos, this.pos + n); this.pos += n; return b; }
  align4(): void { this.pos = (this.pos + 3) & ~3; }

  /** An AcString (see the file comment). */
  acString(): string {
    const len = this.u16();
    if (len === 0) return '';
    const raw = this.bytes(len);
    this.align4();
    const end = raw.indexOf(0);
    return decodeWindows1252(end >= 0 ? raw.subarray(0, end) : raw);
  }

  /** A fixed-size NUL-padded name blob (FixedBlob28 = u32 0xBEEFBEEF + 24 bytes). */
  fixedName(size: number): string {
    const raw = this.bytes(size);
    const start = size === 28 && raw[0] === 0xef && raw[1] === 0xbe ? 4 : 0;
    const body = raw.subarray(start);
    const end = body.indexOf(0);
    return decodeWindows1252(end >= 0 ? body.subarray(0, end) : body);
  }
}

export class Writer1999 {
  private buf = new Uint8Array(128);
  private view = new DataView(this.buf.buffer);
  pos = 0;

  private grow(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this { this.grow(1); this.view.setUint8(this.pos, v); this.pos += 1; return this; }
  u16(v: number): this { this.grow(2); this.view.setUint16(this.pos, v, true); this.pos += 2; return this; }
  i16(v: number): this { this.grow(2); this.view.setInt16(this.pos, v, true); this.pos += 2; return this; }
  u32(v: number): this { this.grow(4); this.view.setUint32(this.pos, v >>> 0, true); this.pos += 4; return this; }
  i32(v: number): this { this.grow(4); this.view.setInt32(this.pos, v | 0, true); this.pos += 4; return this; }
  f32(v: number): this { this.grow(4); this.view.setFloat32(this.pos, v, true); this.pos += 4; return this; }
  f64(v: number): this { this.grow(8); this.view.setFloat64(this.pos, v, true); this.pos += 8; return this; }
  bytes(b: Uint8Array): this { this.grow(b.length); this.buf.set(b, this.pos); this.pos += b.length; return this; }
  align4(): this { const p = (this.pos + 3) & ~3; this.grow(p - this.pos); this.pos = p; return this; }

  /** An AcString (see the file comment): length counts the NUL; pad relative to the message start. */
  acString(s: string): this {
    if (!s) return this.u16(0);
    const enc = encodeWindows1252(s);
    this.u16(enc.length + 1).bytes(enc).u8(0);
    return this.align4();
  }

  /** FixedBlob28: u32 0xBEEFBEEF then the name NUL-padded to 24 bytes (the real client's account blob). */
  fixedAccount(name: string): this {
    this.u32(0xbeefbeef);
    const enc = encodeWindows1252(name).subarray(0, 23);
    const field = new Uint8Array(24);
    field.set(enc);
    return this.bytes(field);
  }

  toBytes(): Uint8Array { return this.buf.slice(0, this.pos); }
}
