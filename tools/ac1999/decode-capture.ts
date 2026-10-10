/**
 * decode-capture.ts — reassemble every application message in a 1999 session
 * capture (tools/ac1999/capture-ac1999-session.sh output, relay JSONL, gzipped
 * or not) and print them in order: direction, packet sequence, group, opcode
 * (and inner GameAction opcode), length and the leading bytes. The ground
 * truth for the 1999 ⇄ end-of-retail message adapter (docs/ac1999-support.md).
 *
 *   npx tsx tools/ac1999/decode-capture.ts tests/fixtures/ac1999-session-001.jsonl.gz [--op f745] [--dir s2c] [--hex 64] [--all]
 *
 * Duplicates (the client's resends, the server's retransmits) are printed once
 * unless --all. --op filters by outer or inner opcode (hex); --hex sets how
 * many bytes to show (default 48; 0 = all).
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { F1999, readFragments1999, readHeader1999 } from '../../packages/network/src/era1999/Packet1999.js';

export interface Message1999 { dir: 'c2s' | 's2c'; seq: number; group: number; opcode: number; inner?: number; data: Uint8Array; t: number }

/** Every whole message in a capture, in arrival order, duplicates removed unless `all`. */
export function decodeCapture(raw: Buffer, all = false): Message1999[] {
  const text = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw).toString() : raw.toString();
  const lines = text.trim().split('\n').map((l) => JSON.parse(l) as { t: number; d: 'c2s' | 's2c'; b: string });
  const out: Message1999[] = [];
  const seen = new Set<string>();
  const partial = new Map<string, Map<number, Uint8Array>>();
  for (const l of lines) {
    const b = new Uint8Array(Buffer.from(l.b, 'base64'));
    if (b.length < 20) continue;
    const h = readHeader1999(b);
    if (!(h.flags & F1999.Referral)) continue;
    const body = b.subarray(l.d === 'c2s' ? 24 : 20);
    for (const f of readFragments1999(body)) {
      const key = `${l.d}:${f.sequence}`;
      let data: Uint8Array | null = f.data;
      if (f.count > 1) {
        const parts = partial.get(key) ?? new Map<number, Uint8Array>();
        parts.set(f.index, f.data);
        partial.set(key, parts);
        if (parts.size < f.count) continue;
        data = Uint8Array.from(Array.from({ length: f.count }, (_, i) => Array.from(parts.get(i)!)).flat());
        partial.delete(key);
      }
      if (!all) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const opcode = data.length >= 4 ? v.getUint32(0, true) : -1;
      const inner = opcode === 0xf7b1 && data.length >= 12 ? v.getUint32(8, true)
        : opcode === 0xf7b0 && data.length >= 16 ? v.getUint32(12, true) : undefined;
      out.push({ dir: l.d, seq: h.sequence, group: f.group, opcode, inner, data, t: l.t });
    }
  }
  return out;
}

if (process.argv[1]?.endsWith('decode-capture.ts')) {
  const args = process.argv.slice(2);
  const opt = (n: string) => { const i = args.indexOf(n); return i > -1 ? args[i + 1] : undefined; };
  const file = args[0];
  const op = opt('--op') ? parseInt(opt('--op')!, 16) : undefined;
  const dir = opt('--dir');
  const hexN = Number(opt('--hex') ?? 48);
  for (const m of decodeCapture(readFileSync(file), args.includes('--all'))) {
    if (dir && m.dir !== dir) continue;
    if (op !== undefined && m.opcode !== op && m.inner !== op) continue;
    const shown = hexN === 0 ? m.data : m.data.subarray(0, hexN);
    console.log(`${m.dir} seq ${m.seq} g${m.group} op 0x${m.opcode.toString(16)}${m.inner !== undefined ? ` inner 0x${m.inner.toString(16)}` : ''} len ${m.data.length}`);
    console.log(`    ${Buffer.from(shown).toString('hex').replace(/(.{8})/g, '$1 ')}`);
  }
}
