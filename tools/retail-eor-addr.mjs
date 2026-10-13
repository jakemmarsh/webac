#!/usr/bin/env node
// retail-eor-addr.mjs — name a crash/EIP address from the client we actually RUN.
//
// The launchers run reference/client-eol/eor/acclient.exe (FileVersion
// 00.00.11.6096, the end-of-retail exe). The PDB, the decomp and
// acclient-symbols.tsv are from reference/client-eol/acclient.exe (11.4186).
// The two builds lay code out differently, so an EoR address looked up in the
// 4186 symbol table names the wrong function. (2026-10-12: Wine's "stack
// overflow at 005AECF6" was read as PHashTable<ulong,ulong>::StreamPack; in the
// EoR exe that address is the first push of IDList::GetNodeByNum, which is
// 0x005ADC40 in the decomp.)
//
// This maps each EoR address to the 4186 build by matching the code bytes
// around it (call/jump displacements and absolute addresses masked out), then
// names the 4186 function from acclient-symbols.tsv.
//
//   node tools/retail-eor-addr.mjs 0x5aecf6 [more addresses…]
//   node tools/retail-eor-addr.mjs --eor <exe> --ref <exe> --syms <tsv> 0x5aecf6

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Parse a PE32 image: image base and section table. */
export function loadPe(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pe = dv.getUint32(0x3c, true);
  if (dv.getUint32(pe, true) !== 0x4550) throw new Error('not a PE image');
  const nsec = dv.getUint16(pe + 6, true);
  const optSize = dv.getUint16(pe + 20, true);
  const imageBase = dv.getUint32(pe + 24 + 28, true);
  const sections = [];
  for (let i = 0; i < nsec; i++) {
    const o = pe + 24 + optSize + i * 40;
    const name = String.fromCharCode(...bytes.subarray(o, o + 8)).replace(/\0+$/, '');
    sections.push({
      name,
      va: dv.getUint32(o + 12, true),
      vsize: dv.getUint32(o + 8, true),
      rawPtr: dv.getUint32(o + 20, true),
      rawSize: dv.getUint32(o + 16, true),
    });
  }
  return { bytes, imageBase, sections };
}

export function vaToOffset(img, va) {
  for (const s of img.sections) {
    const lo = img.imageBase + s.va;
    if (va >= lo && va < lo + Math.max(s.vsize, s.rawSize)) return va - lo + s.rawPtr;
  }
  return -1;
}

export function offsetToVa(img, off) {
  for (const s of img.sections) {
    if (off >= s.rawPtr && off < s.rawPtr + s.rawSize) return off - s.rawPtr + s.va + img.imageBase;
  }
  return -1;
}

/**
 * Bytes that differ between builds even for identical source: rel32 operands
 * of call/jmp/jcc and dwords that look like absolute image addresses.
 * Returns a mask (true = compare this byte).
 */
export function stableMask(bytes, start, len, imageBase) {
  const mask = new Array(len).fill(true);
  for (let i = 0; i < len; i++) {
    const p = start + i;
    const b = bytes[p];
    const rel32At = (b === 0xe8 || b === 0xe9) ? 1
      : (b === 0x0f && bytes[p + 1] >= 0x80 && bytes[p + 1] <= 0x8f) ? 2 : 0;
    if (rel32At) for (let k = rel32At; k < rel32At + 4 && i + k < len; k++) mask[i + k] = false;
    if (p + 4 <= bytes.length) {
      const dw = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24);
      const u = dw >>> 0;
      if (u >= imageBase && u < imageBase + 0x800000) for (let k = 0; k < 4 && i + k < len; k++) mask[i + k] = false;
    }
  }
  return mask;
}

/**
 * Map one address of image `from` into image `to`: anchors of 12 stable bytes
 * taken around the address are searched in `to`'s first (code) section; the
 * most common displacement wins. Returns { va, votes, anchors } or null.
 */
export function mapAddress(from, to, va, { radius = 96, anchorLen = 12 } = {}) {
  const off = vaToOffset(from, va);
  if (off < 0) return null;
  const text = to.sections[0];
  const hay = to.bytes.subarray(text.rawPtr, text.rawPtr + text.rawSize);
  const start = Math.max(0, off - radius);
  const mask = stableMask(from.bytes, start, radius * 2, from.imageBase);
  const votes = new Map();
  let anchors = 0;
  for (let i = 0; i + anchorLen <= radius * 2; i += 4) {
    if (!mask.slice(i, i + anchorLen).every(Boolean)) continue;
    const needle = from.bytes.subarray(start + i, start + i + anchorLen);
    if (needle.every((b) => b === 0x90 || b === 0xcc || b === 0x00)) continue; // padding
    anchors++;
    let hits = 0;
    let at = -1;
    let pos = hay.indexOf(needle[0]);
    const found = [];
    while (pos !== -1 && hits < 3) {
      if (pos + anchorLen <= hay.length && needle.every((b, k) => hay[pos + k] === b)) { found.push(pos); hits++; }
      pos = hay.indexOf(needle[0], pos + 1);
    }
    if (found.length !== 1) continue; // ambiguous or absent anchors don't vote
    at = found[0];
    const mapped = offsetToVa(to, text.rawPtr + at) + (off - (start + i));
    votes.set(mapped, (votes.get(mapped) ?? 0) + 1);
  }
  let best = null;
  for (const [mva, n] of votes) if (!best || n > best.votes) best = { va: mva, votes: n };
  return best ? { ...best, anchors } : null;
}

/** acclient-symbols.tsv rows → sorted [{ addr, name }]. */
export function loadSymbols(tsv) {
  return tsv.split('\n').filter(Boolean).map((line) => {
    const [a, ...rest] = line.split('\t');
    return { addr: parseInt(a, 16), name: rest.join('\t') };
  }).sort((x, y) => x.addr - y.addr);
}

export function symbolFor(symbols, va) {
  let lo = 0;
  let hi = symbols.length - 1;
  let hit = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (symbols[mid].addr <= va) { hit = symbols[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return hit;
}

function main(argv) {
  const opt = { eor: join(repo, 'reference/client-eol/eor/acclient.exe'),
    ref: join(repo, 'reference/client-eol/acclient.exe'),
    syms: join(repo, 'reference/client-eol/decomp/acclient-symbols.tsv') };
  const addrs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--eor' || a === '--ref' || a === '--syms') opt[a.slice(2)] = argv[++i];
    else addrs.push(parseInt(a, 16));
  }
  if (addrs.length === 0 || addrs.some(Number.isNaN)) {
    console.error('usage: node tools/retail-eor-addr.mjs <hex address from the EoR client>…');
    process.exit(2);
  }
  const eor = loadPe(readFileSync(opt.eor));
  const ref = loadPe(readFileSync(opt.ref));
  const symbols = loadSymbols(readFileSync(opt.syms, 'utf8'));
  for (const va of addrs) {
    const m = mapAddress(eor, ref, va);
    const hex = (n) => '0x' + n.toString(16).padStart(8, '0');
    if (!m) { console.log(`${hex(va)}  no match in the 4186 build`); continue; }
    const s = symbolFor(symbols, m.va);
    console.log(`${hex(va)} (EoR 6096) -> ${hex(m.va)} (4186)  ${s ? `${s.name} +0x${(m.va - s.addr).toString(16)}` : '?'}  [${m.votes}/${m.anchors} anchors agree]`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
