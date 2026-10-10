/**
 * ISAAC — cryptographic PRNG used for AC packet checksum encryption.
 *
 * ISAAC (Indirection, Shift, Accumulate, Add, and Count) is a CSPRNG
 * designed by Bob Jenkins. AC uses it to generate XOR keys for encrypting
 * packet checksums after the initial handshake.
 *
 * Ported from ACE.Common.Cryptography.ISAAC.
 */

const GOLDEN_RATIO = 0x9E3779B9;

export class ISAAC {
  private mm: Uint32Array;      // 256-entry internal state
  private randRsl: Uint32Array; // 256-entry result buffer
  private aa: number = 0;      // accumulator
  private bb: number = 0;      // previous result
  private cc: number = 0;      // counter (incremented once per 256 results)
  private offset: number;       // current position in result buffer

  constructor(seed: Uint8Array) {
    this.mm = new Uint32Array(256);
    this.randRsl = new Uint32Array(256);
    // ACE C# sets offset = 255 after init's IsaacScramble().
    // First Next() reads rsl[255], then decrements to 254.
    this.offset = 255;
    this.initialize(seed);
  }

  /**
   * Get the next random uint32 from the ISAAC generator.
   * Matches ACE C# exactly: read value FIRST, THEN decrement offset.
   * When offset reaches 0, reseed and reset to 255 AFTER returning the value.
   */
  next(): number {
    const result = this.randRsl[this.offset] >>> 0;
    if (this.offset > 0) {
      this.offset--;
    } else {
      this.isaacScramble();
      this.offset = 255;
    }
    return result;
  }

  private initialize(seed: Uint8Array): void {
    // Clear both arrays to zero (matches ACE: mm[i] = randRsl[i] = 0)
    this.mm.fill(0);
    this.randRsl.fill(0);

    // Mix with golden ratio
    const x = new Uint32Array(8);
    x.fill(GOLDEN_RATIO);

    // Shuffle x 4 times
    for (let i = 0; i < 4; i++) {
      this.shuffle(x);
    }

    // Two passes: first with randRsl (all zeros), second with mm
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < 256; i += 8) {
        for (let j = 0; j < 8; j++) {
          x[j] = (x[j] + (pass === 0 ? this.randRsl[i + j] : this.mm[i + j])) >>> 0;
        }
        this.shuffle(x);
        for (let j = 0; j < 8; j++) {
          this.mm[i + j] = x[j];
        }
      }
    }

    // Seed goes into accumulators a, b, c — NOT into randRsl!
    // ACE: a = BitConverter.ToUInt32(keyBytes, 0); c = b = a;
    if (seed.length >= 4) {
      const seedView = new DataView(seed.buffer, seed.byteOffset, seed.length);
      this.aa = seedView.getUint32(0, true) >>> 0;
    }
    this.cc = this.bb = this.aa;

    // Generate initial set using seeded accumulators
    this.isaacScramble();
  }

  private shuffle(x: Uint32Array): void {
    x[0] = (x[0] ^ (x[1] << 11)) >>> 0; x[3] = (x[3] + x[0]) >>> 0; x[1] = (x[1] + x[2]) >>> 0;
    x[1] = (x[1] ^ (x[2] >>> 2)) >>> 0;  x[4] = (x[4] + x[1]) >>> 0; x[2] = (x[2] + x[3]) >>> 0;
    x[2] = (x[2] ^ (x[3] << 8)) >>> 0;  x[5] = (x[5] + x[2]) >>> 0; x[3] = (x[3] + x[4]) >>> 0;
    x[3] = (x[3] ^ (x[4] >>> 16)) >>> 0; x[6] = (x[6] + x[3]) >>> 0; x[4] = (x[4] + x[5]) >>> 0;
    x[4] = (x[4] ^ (x[5] << 10)) >>> 0; x[7] = (x[7] + x[4]) >>> 0; x[5] = (x[5] + x[6]) >>> 0;
    x[5] = (x[5] ^ (x[6] >>> 4)) >>> 0;  x[0] = (x[0] + x[5]) >>> 0; x[6] = (x[6] + x[7]) >>> 0;
    x[6] = (x[6] ^ (x[7] << 8)) >>> 0;  x[1] = (x[1] + x[6]) >>> 0; x[7] = (x[7] + x[0]) >>> 0;
    x[7] = (x[7] ^ (x[0] >>> 9)) >>> 0;  x[2] = (x[2] + x[7]) >>> 0; x[0] = (x[0] + x[1]) >>> 0;
  }

  private isaacScramble(): void {
    this.cc = (this.cc + 1) >>> 0;
    this.bb = (this.bb + this.cc) >>> 0;

    for (let i = 0; i < 256; i++) {
      const x = this.mm[i];

      // Vary mixing based on i & 3
      switch (i & 3) {
        case 0: this.aa = (this.aa ^ (this.aa << 13)) >>> 0; break;
        case 1: this.aa = (this.aa ^ (this.aa >>> 6)) >>> 0; break;
        case 2: this.aa = (this.aa ^ (this.aa << 2)) >>> 0; break;
        case 3: this.aa = (this.aa ^ (this.aa >>> 16)) >>> 0; break;
      }

      this.aa = (this.mm[(i + 128) & 0xFF] + this.aa) >>> 0;
      const y = (this.mm[(x >>> 2) & 0xFF] + this.aa + this.bb) >>> 0;
      this.mm[i] = y;
      this.bb = (this.mm[(y >>> 10) & 0xFF] + x) >>> 0;
      this.randRsl[i] = this.bb;
    }
  }
}

/**
 * CryptoSystem — ISAAC wrapper that supports searching for XOR keys.
 *
 * When packets arrive out of order, the system can search ahead through
 * generated ISAAC keys to find a match.
 *
 * Ported from ACE.Common.Cryptography.CryptoSystem.
 */
export class CryptoSystem {
  private isaac: ISAAC;
  private currentKey: number;
  private cache: Set<number>;

  constructor(seed: Uint8Array) {
    this.isaac = new ISAAC(seed);
    this.currentKey = this.isaac.next();
    this.cache = new Set<number>();
  }

  /**
   * Get the current XOR key and advance to the next one.
   */
  next(): number {
    const key = this.currentKey;
    this.currentKey = this.isaac.next();
    return key;
  }

  /**
   * Peek at the current XOR key without advancing.
   */
  peek(): number {
    return this.currentKey;
  }

  /**
   * Search for a specific XOR key value in the cache and upcoming keys.
   * Used for handling out-of-order packets.
   *
   * @param target The XOR key to search for
   * @param maxLookahead Maximum number of keys to generate looking for a match
   * @returns true if the target was found
   */
  search(target: number, maxLookahead: number = 256): boolean {
    // Check current key
    if (this.currentKey === target) {
      this.currentKey = this.isaac.next();
      return true;
    }

    // Check cache
    if (this.cache.has(target)) {
      this.cache.delete(target);
      return true;
    }

    // Look ahead
    for (let i = 0; i < maxLookahead; i++) {
      this.cache.add(this.currentKey);
      this.currentKey = this.isaac.next();
      if (this.currentKey === target) {
        this.currentKey = this.isaac.next();
        return true;
      }
    }

    return false;
  }
}
