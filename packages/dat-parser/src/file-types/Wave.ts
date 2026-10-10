import { DatReader } from '../DatReader.js';

/**
 * Wave — sound data from portal.dat (0x0Axxxxxx)
 * Reference: ACE.DatLoader/FileTypes/Wave.cs
 *
 * Stored as WAV-like format with a custom header.
 * Header is typically 18 bytes (format info starting at Format Type).
 * Data is raw PCM (or MP3 if header[0] == 0x55).
 */
export class Wave {
  id: number = 0;
  header: Uint8Array = new Uint8Array(0);
  data: Uint8Array = new Uint8Array(0);

  constructor(reader: DatReader) {
    this.id = reader.readInt32() >>> 0;
    const headerSize = reader.readInt32();
    const dataSize = reader.readInt32();

    this.header = reader.readBytes(headerSize);
    this.data = reader.readBytes(dataSize);
  }

  /**
   * Check if this is MP3 format (header byte 0 == 0x55)
   */
  get isMP3(): boolean {
    return this.header.length > 0 && this.header[0] === 0x55;
  }

  /**
   * Build a complete WAV file buffer that can be played back.
   * Only valid for PCM wave files, not MP3.
   */
  toWavBuffer(): ArrayBuffer {
    // WAV header needs 16 bytes from the AC header (format type through end)
    const headerBytes = this.header.slice(0, Math.min(16, this.header.length));
    const fileSize = this.data.length + 36;

    // RIFF header (44 bytes total) + data
    const buffer = new ArrayBuffer(44 + this.data.length);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // "RIFF" chunk
    bytes[0] = 0x52; bytes[1] = 0x49; bytes[2] = 0x46; bytes[3] = 0x46; // "RIFF"
    view.setUint32(4, fileSize, true);
    bytes[8] = 0x57; bytes[9] = 0x41; bytes[10] = 0x56; bytes[11] = 0x45; // "WAVE"

    // "fmt " sub-chunk
    bytes[12] = 0x66; bytes[13] = 0x6D; bytes[14] = 0x74; bytes[15] = 0x20; // "fmt "
    view.setUint32(16, 16, true); // sub-chunk size = 16

    // Copy AC header (format type + channels + sample rate etc) as fmt data
    bytes.set(headerBytes, 20);

    // "data" sub-chunk
    bytes[36] = 0x64; bytes[37] = 0x61; bytes[38] = 0x74; bytes[39] = 0x61; // "data"
    view.setUint32(40, this.data.length, true);
    bytes.set(this.data, 44);

    return buffer;
  }
}
