/**
 * tools/retail-eor-addr.mjs — maps an address from the client the launchers
 * run (reference/client-eol/eor/acclient.exe, build 11.6096) to the decomp's
 * build (11.4186) and names the function. 2026-10-12: Wine's "Unhandled
 * stack overflow at 005AECF6" was looked up directly in the 4186 symbol table
 * and read as PHashTable<ulong,ulong>::StreamPack; in the EoR exe the
 * address is the first push of IDList::GetNodeByNum (4186: 0x005ADC40).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { loadPe, stableMask, mapAddress, loadSymbols, symbolFor } from '../tools/retail-eor-addr.mjs';
import type { PeImage, Symbol as PeSymbol } from '../tools/retail-eor-addr.mjs';

const EOR = 'reference/client-eol/eor/acclient.exe';
const REF = 'reference/client-eol/acclient.exe';
const SYMS = 'reference/client-eol/decomp/acclient-symbols.tsv';
const haveExes = existsSync(EOR) && existsSync(REF) && existsSync(SYMS);

describe('stableMask — bytes that move between builds are not compared', () => {
  it('masks call rel32, jcc rel32 and absolute image addresses; keeps plain code', () => {
    const base = 0x400000;
    const code = Uint8Array.from([
      0x56,                               // push esi (stable)
      0xe8, 0x11, 0x22, 0x33, 0x44,       // call rel32 → operand masked
      0x0f, 0x84, 0x01, 0x02, 0x03, 0x04, // je rel32 → operand masked
      0xa1, 0x54, 0x75, 0x81, 0x00,       // mov eax, [0x00817554] → address masked
      0x5e,                               // pop esi (stable)
    ]);
    const m = stableMask(code, 0, code.length, base);
    expect(m[0]).toBe(true);
    expect(m.slice(2, 6)).toEqual([false, false, false, false]);
    expect(m.slice(8, 12)).toEqual([false, false, false, false]);
    expect(m.slice(13, 17)).toEqual([false, false, false, false]);
    expect(m[17]).toBe(true);
  });
});

describe('symbolFor — nearest symbol at or below the address', () => {
  it('binary-searches the sorted symbol rows', () => {
    const syms = loadSymbols('005adc40\tIDList::GetNodeByNum\n005add00\tIDList::IDList\n005adbd0\tIDList::IsInList\n');
    expect(symbolFor(syms, 0x5adc46)?.name).toBe('IDList::GetNodeByNum');
    expect(symbolFor(syms, 0x5adbd0)?.name).toBe('IDList::IsInList');
    expect(symbolFor(syms, 0x5add10)?.name).toBe('IDList::IDList');
    expect(symbolFor(syms, 0x400000)).toBeNull();
  });
});

describe.skipIf(!haveExes)('mapAddress on the real builds (needs reference/client-eol)', () => {
  let eor: PeImage; let ref: PeImage; let syms: PeSymbol[];
  beforeAll(() => {
    eor = loadPe(readFileSync(EOR));
    ref = loadPe(readFileSync(REF));
    syms = loadSymbols(readFileSync(SYMS, 'utf8'));
  });

  it('the 2026-10-12 Wine stack-overflow EIP 0x5AECF6 is IDList::GetNodeByNum, not PHashTable::StreamPack', () => {
    const m = mapAddress(eor, ref, 0x5aecf6);
    expect(m).not.toBeNull();
    expect(m!.va).toBe(0x5adc46);
    expect(symbolFor(syms, m!.va)?.name).toBe('IDList::GetNodeByNum');
    // The naive lookup (EoR address straight into the 4186 table) is the trap.
    expect(symbolFor(syms, 0x5aecf6)?.name).toBe('PHashTable<unsigned_long,unsigned_long>::StreamPack');
  });

  it('a call site inside the EoR IDList::GetByNum maps into the 4186 GetByNum', () => {
    const m = mapAddress(eor, ref, 0x5aeef5);
    expect(symbolFor(syms, m!.va)?.name).toBe('IDList::GetByNum');
  });
});
