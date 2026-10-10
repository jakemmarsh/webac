/**
 * Test-side encoders for the published DAT-set formats (tools/publish-dats-r2.ts
 * is the authority; these follow its header comment byte for byte) and an
 * in-memory "bucket" fetcher, so DatStore tests drive the real store over
 * real gzip objects without a network.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export const hash8 = (b: Uint8Array): string => createHash('sha256').update(b).digest().subarray(0, 8).toString('hex');

export function buildPack(files: Array<{ id: number; data: Uint8Array }>): Uint8Array {
  const sorted = [...files].sort((a, b) => a.id - b.id);
  const indexBytes = 8 + sorted.length * 12;
  const out = new Uint8Array(indexBytes + sorted.reduce((s, f) => s + f.data.length, 0));
  const dv = new DataView(out.buffer);
  out.set([0x41, 0x43, 0x50, 0x4b], 0);
  dv.setUint32(4, sorted.length, true);
  let off = 0;
  sorted.forEach((f, i) => {
    dv.setUint32(8 + i * 12, f.id >>> 0, true);
    dv.setUint32(12 + i * 12, off, true);
    dv.setUint32(16 + i * 12, f.data.length, true);
    out.set(f.data, indexBytes + off);
    off += f.data.length;
  });
  return out;
}

export interface Obj { hash: string; size: number; gzSize: number }

/** A fake bucket: content-addressed gzip objects + request counting. */
export class FakeBucket {
  readonly objects = new Map<string, Uint8Array>();
  requests: string[] = [];
  /** Hashes whose fetch fails (network error) — `remaining` times, then succeeds. */
  failing = new Map<string, number>();
  /** Delay (ms) before each response resolves. */
  delayMs = 0;
  /** Hold every response until released (gate tests). */
  private held: Array<() => void> | null = null;

  put(payload: Uint8Array): Obj {
    const hash = hash8(payload);
    const gz = new Uint8Array(gzipSync(payload, { level: 1 }));
    this.objects.set(hash, gz);
    return { hash, size: payload.length, gzSize: gz.length };
  }

  hold(): void { this.held = []; }
  release(): void { const h = this.held; this.held = null; for (const r of h ?? []) r(); }

  readonly fetch = async (url: string): Promise<Uint8Array> => {
    const hash = url.slice(url.lastIndexOf('/') + 1);
    this.requests.push(hash);
    if (this.held) await new Promise<void>((r) => this.held!.push(r));
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const left = this.failing.get(hash) ?? 0;
    if (left > 0) { this.failing.set(hash, left - 1); throw new Error(`simulated network failure for ${hash}`); }
    const gz = this.objects.get(hash);
    if (!gz) throw new Error(`404 ${hash}`);
    return gz;
  };
}

/** Encode an "ACDM" manifest (format 1). */
export function buildManifest(parts: {
  leaves?: { portal?: Array<{ id: number } & Obj>; highres?: Array<{ id: number } & Obj> };
  packs?: Array<{ role: number; files: number } & Obj>;
  bundles?: Array<{ lb: number } & Obj>;
}): Uint8Array {
  const sections: Buffer[] = [];
  const section = (kind: number, dat: number, count: number, body: Buffer) => {
    const h = Buffer.alloc(8); h.writeUInt8(kind, 0); h.writeUInt8(dat, 1); h.writeUInt32LE(count, 4);
    sections.push(h, body);
  };
  for (const [dat, code] of [['portal', 1], ['highres', 4]] as const) {
    const l = parts.leaves?.[dat] ?? [];
    const b = Buffer.alloc(l.length * 20);
    l.forEach((e, i) => { b.writeUInt32LE(e.id >>> 0, i * 20); b.writeUInt32LE(e.size, i * 20 + 4); b.writeUInt32LE(e.gzSize, i * 20 + 8); Buffer.from(e.hash, 'hex').copy(b, i * 20 + 12); });
    section(1, code, l.length, b);
  }
  const packs = parts.packs ?? [];
  const pb = Buffer.alloc(packs.length * 24);
  packs.forEach((p, i) => { pb.writeUInt8(p.role, i * 24); pb.writeUInt32LE(p.size, i * 24 + 4); pb.writeUInt32LE(p.gzSize, i * 24 + 8); pb.writeUInt32LE(p.files, i * 24 + 12); Buffer.from(p.hash, 'hex').copy(pb, i * 24 + 16); });
  section(2, 0, packs.length, pb);
  const bundles = parts.bundles ?? [];
  const bb = Buffer.alloc(bundles.length * 20);
  bundles.forEach((e, i) => { bb.writeUInt16LE(e.lb, i * 20); bb.writeUInt32LE(e.size, i * 20 + 4); bb.writeUInt32LE(e.gzSize, i * 20 + 8); Buffer.from(e.hash, 'hex').copy(bb, i * 20 + 12); });
  section(3, 2, bundles.length, bb);
  const head = Buffer.alloc(12); head.write('ACDM', 0, 'latin1'); head.writeUInt32LE(1, 4); head.writeUInt32LE(sections.length / 2, 8);
  return new Uint8Array(Buffer.concat([head, ...sections]));
}
