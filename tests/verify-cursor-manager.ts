/**
 * GAP.84 — DAT-sourced world cursor bitmaps (CursorManager.ts).
 *
 * Retail AC's ClientUISystem::UpdateCursorState (decompiled acclient-eol,
 * ~0x00564630) resolves combat/target state to a cursor DID via the
 * client_portal.dat UICURSOR DidMapper, then blits that Texture (0x06)
 * bitmap as the cursor. Pre-fix, the client only used generic browser CSS
 * cursors (pointer/default) with zero DAT-sourced art.
 *
 * The UICURSOR DidMapper's DID (0x2500000f) and its 41-entry name table
 * were confirmed live against the real client_portal.dat (not guessed):
 * the master DidMapper-of-DidMappers (0x25000000) lists entry #6 as
 * "UICURSOR" -> 0x2500000f, and dumping that mapper's client-side table
 * yields the exact names asserted below.
 *
 * This drives the real, shipped CursorManager class:
 *   - unit tests exercise name resolution / hotspot baking / caching /
 *     null-fallback against a synthetic DidMapper payload + a stub
 *     TextureManager (this repo's happy-dom test environment has no real
 *     <canvas> 2D context — see verify-acfont-renderer.ts — so the
 *     pixel-decode-to-dataURL step can't be driven end-to-end here; the
 *     stub isolates CursorManager's own resolution/caching logic instead).
 *   - a DAT-gated suite loads the real client_portal.dat and confirms the
 *     UICURSOR mapper resolves the exact retail names to the exact DIDs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CursorManager, UICURSOR_MAPPER_ID, resolveWorldCursorName } from '../packages/renderer/src/ui/CursorManager.js';
import { CombatMode } from '@ac/shared';
import type { TextureManager } from '../packages/renderer/src/models/TextureManager.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatDatabase as RealDatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { readDidMapper } from '../packages/dat-parser/src/file-types/DidMapper.js';
import { NumberingType } from '../packages/dat-parser/src/file-types/EnumMapper.js';

// ── synthesis helpers (mirrors tests/verify-mapper-dat-parsers.ts) ─────

function packCompressedUInt32(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  if (n < 0x4000) return new Uint8Array([(n >> 8) | 0x80, n & 0xFF]);
  return new Uint8Array([(n >> 24) | 0xC0, (n >> 16) & 0xFF, (n >> 8) & 0xFF, n & 0xFF]);
}
function packUInt32LE(n: number): Uint8Array {
  return new Uint8Array([n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >>> 24) & 0xFF]);
}
function packPString1(s: string): Uint8Array {
  const b = new TextEncoder().encode(s);
  const out = new Uint8Array(1 + b.length);
  out[0] = b.length;
  out.set(b, 1);
  return out;
}
function cat(...chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Synthesize a minimal UICURSOR-shaped DidMapper payload: name -> DID. */
function synthesizeCursorMapper(entries: Array<[string, number]>): Uint8Array {
  const idParts: Uint8Array[] = [];
  const nameParts: Uint8Array[] = [];
  entries.forEach(([name, did], i) => {
    idParts.push(packUInt32LE(i + 1), packUInt32LE(did));
    nameParts.push(packUInt32LE(i + 1), packPString1(name));
  });
  return cat(
    packUInt32LE(UICURSOR_MAPPER_ID),
    // client side
    new Uint8Array([NumberingType.Normal]),
    packCompressedUInt32(entries.length),
    ...idParts,
    new Uint8Array([NumberingType.Normal]),
    packCompressedUInt32(entries.length),
    ...nameParts,
    // server side (empty — UICURSOR is client-only)
    new Uint8Array([NumberingType.Normal]),
    packCompressedUInt32(0),
    new Uint8Array([NumberingType.Normal]),
    packCompressedUInt32(0),
  );
}

/** Fake DatDatabase serving one hardcoded file's bytes. */
function makeFakeDb(fileId: number, bytes: Uint8Array): DatDatabase {
  return {
    getFileData: (id: number) => (id === fileId ? toArrayBuffer(bytes) : null),
  } as unknown as DatDatabase;
}

/** Stub TextureManager: records calls, returns a fixed data URL per DID (or null). */
function makeStubTextureManager(urls: Map<number, string>): { tm: TextureManager; calls: number[] } {
  const calls: number[] = [];
  const tm = {
    getIconDataURL: (did: number) => {
      calls.push(did);
      return urls.get(did) ?? null;
    },
  } as unknown as TextureManager;
  return { tm, calls };
}

describe('GAP.84: CursorManager name resolution + hotspot + caching', () => {
  it('resolves a named cursor state to a CSS cursor value with baked hotspot', () => {
    const db = makeFakeDb(UICURSOR_MAPPER_ID, synthesizeCursorMapper([
      ['Default', 0x06004d68],
      ['Use', 0x06004d72],
    ]));
    const { tm } = makeStubTextureManager(new Map([
      [0x06004d68, 'data:image/png;base64,AAA'],
      [0x06004d72, 'data:image/png;base64,BBB'],
    ]));
    const mgr = new CursorManager(db, tm);

    // Default has hotspot (0,0) per the decompiled UpdateCursorState constants.
    expect(mgr.getCursorCSS('Default')).toBe('url(data:image/png;base64,AAA) 0 0, auto');
    // Use has hotspot (14,14) — texture-center for the hand/gauntlet art.
    expect(mgr.getCursorCSS('Use')).toBe('url(data:image/png;base64,BBB) 14 14, auto');
  });

  it('returns null for a name absent from the mapper', () => {
    const db = makeFakeDb(UICURSOR_MAPPER_ID, synthesizeCursorMapper([['Default', 0x06004d68]]));
    const { tm } = makeStubTextureManager(new Map([[0x06004d68, 'data:image/png;base64,AAA']]));
    const mgr = new CursorManager(db, tm);
    expect(mgr.getCursorCSS('Combat')).toBeNull();
  });

  it('returns null when the DAT texture fails to resolve (caller falls back)', () => {
    const db = makeFakeDb(UICURSOR_MAPPER_ID, synthesizeCursorMapper([['Default', 0x06004d68]]));
    const { tm } = makeStubTextureManager(new Map()); // no URLs registered -> null
    const mgr = new CursorManager(db, tm);
    expect(mgr.getCursorCSS('Default')).toBeNull();
  });

  it('caches resolved CSS: only decodes the texture once per name', () => {
    const db = makeFakeDb(UICURSOR_MAPPER_ID, synthesizeCursorMapper([['Combat', 0x06004d6a]]));
    const { tm, calls } = makeStubTextureManager(new Map([[0x06004d6a, 'data:image/png;base64,CCC']]));
    const mgr = new CursorManager(db, tm);
    mgr.getCursorCSS('Combat');
    mgr.getCursorCSS('Combat');
    mgr.getCursorCSS('Combat');
    expect(calls.length).toBe(1);
  });

  it('returns null (not throw) when the mapper file is missing entirely', () => {
    const db = { getFileData: () => null } as unknown as DatDatabase;
    const { tm } = makeStubTextureManager(new Map());
    const mgr = new CursorManager(db, tm);
    expect(mgr.getCursorCSS('Default')).toBeNull();
  });
});

describe('GAP.84: resolveWorldCursorName — armed Examine/Use target mode', () => {
  it('defaults to the combat/spellcast/default resolution when no target mode is armed', () => {
    expect(resolveWorldCursorName(CombatMode.NonCombat, false)).toBe('Default');
    expect(resolveWorldCursorName(CombatMode.NonCombat, true)).toBe('Default_OverObject');
    expect(resolveWorldCursorName(CombatMode.Melee, false)).toBe('Combat');
    expect(resolveWorldCursorName(CombatMode.Magic, true)).toBe('Spellcast_OverObject');
  });

  it('an armed examine target mode resolves to Examine[_OverObject] regardless of combat mode', () => {
    for (const mode of [CombatMode.NonCombat, CombatMode.Melee, CombatMode.Missile, CombatMode.Magic]) {
      expect(resolveWorldCursorName(mode, false, 'examine')).toBe('Examine');
      expect(resolveWorldCursorName(mode, true, 'examine')).toBe('Examine_OverObject');
    }
  });

  it('an armed use target mode resolves to Use[_OverObject] regardless of combat mode', () => {
    for (const mode of [CombatMode.NonCombat, CombatMode.Melee, CombatMode.Missile, CombatMode.Magic]) {
      expect(resolveWorldCursorName(mode, false, 'use')).toBe('Use');
      expect(resolveWorldCursorName(mode, true, 'use')).toBe('Use_OverObject');
    }
  });

  it('target mode "none" (the default) falls through to the combat-mode resolution', () => {
    expect(resolveWorldCursorName(CombatMode.Melee, true, 'none')).toBe('Combat_OverObject');
  });

  it('an armed targeted-use mode (GAP.21 use-with-target arm) resolves to TargetedUse[_OverObject]', () => {
    for (const mode of [CombatMode.NonCombat, CombatMode.Melee, CombatMode.Missile, CombatMode.Magic]) {
      expect(resolveWorldCursorName(mode, false, 'targeted-use')).toBe('TargetedUse');
      expect(resolveWorldCursorName(mode, true, 'targeted-use')).toBe('TargetedUse_OverObject');
    }
  });
});

// ── DAT-gated: confirm against the real client_portal.dat ─────────────

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');
const hasPortalDat = existsSync(PORTAL_DAT);

describe.skipIf(!hasPortalDat)('GAP.84: UICURSOR DidMapper in real client_portal.dat', () => {
  let portalDb: RealDatDatabase;

  beforeAll(() => {
    const buf = readFileSync(PORTAL_DAT).buffer;
    portalDb = new RealDatDatabase(buf as ArrayBuffer);
  });

  it('the master DidMapper-of-DidMappers (0x25000000) labels 0x2500000f as UICURSOR', () => {
    const masterData = portalDb.getFileData(0x25000000);
    expect(masterData).not.toBeNull();
    const master = readDidMapper(new DatReader(masterData!));
    const uicursorKey = [...master.client.enumToName.entries()].find(([, name]) => name === 'UICURSOR')?.[0];
    expect(uicursorKey).toBeDefined();
    expect(master.client.enumToId.get(uicursorKey!)).toBe(UICURSOR_MAPPER_ID);
  });

  it('resolves the retail combat/spellcast/examine/use cursor names to their real DIDs', () => {
    const data = portalDb.getFileData(UICURSOR_MAPPER_ID);
    expect(data).not.toBeNull();
    const mapper = readDidMapper(new DatReader(data!));
    const byName = new Map<string, number>();
    for (const [enumKey, did] of mapper.client.enumToId) {
      const name = mapper.client.enumToName.get(enumKey);
      if (name) byName.set(name, did);
    }
    expect(byName.get('Default')).toBe(0x06004d68);
    expect(byName.get('Default_OverObject')).toBe(0x06004d69);
    expect(byName.get('Combat')).toBe(0x06004d6a);
    expect(byName.get('Combat_OverObject')).toBe(0x06004d6b);
    expect(byName.get('Spellcast')).toBe(0x06004d6c);
    expect(byName.get('Spellcast_OverObject')).toBe(0x06004d6d);
    expect(byName.get('Examine')).toBe(0x06004d71);
    expect(byName.get('Use')).toBe(0x06004d72);
    expect(byName.get('TargetedUse')).toBe(0x06004d73);
    expect(byName.get('Wait')).toBe(0x06004d74);
  });

  it('every resolved DID is a Texture (0x06) class file that decodes to non-empty pixel data', () => {
    const data = portalDb.getFileData(UICURSOR_MAPPER_ID);
    const mapper = readDidMapper(new DatReader(data!));
    const namesToCheck = ['Default', 'Combat', 'Spellcast', 'Examine', 'Use'];
    for (const [enumKey, did] of mapper.client.enumToId) {
      const name = mapper.client.enumToName.get(enumKey);
      if (!name || !namesToCheck.includes(name)) continue;
      expect(did >>> 24, name).toBe(0x06);
      const texData = portalDb.getFileData(did);
      expect(texData, name).not.toBeNull();
    }
  });
});
