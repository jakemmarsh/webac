import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { DatBytes } from '../DatDatabase.js';

/**
 * Node-only DatBytes that reads a DAT file on demand through a file
 * descriptor, so `new DatDatabase(new FileDatBytes(path))` holds the
 * directory map and nothing else. Not exported from the package index (the
 * browser bundle has no `fs`); tools and tests import it by path.
 */
export class FileDatBytes implements DatBytes {
  private fd: number;
  readonly byteLength: number;

  constructor(readonly path: string) {
    this.fd = openSync(path, 'r');
    this.byteLength = fstatSync(this.fd).size;
  }

  read(offset: number, dest: Uint8Array, destOffset: number, length: number): void {
    let done = 0;
    while (done < length) {
      const n = readSync(this.fd, dest, destOffset + done, length - done, offset + done);
      if (n <= 0) throw new Error(`FileDatBytes: short read at ${offset + done} in ${this.path}`);
      done += n;
    }
  }

  close(): void {
    closeSync(this.fd);
  }
}
