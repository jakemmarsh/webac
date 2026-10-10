/**
 * The AC1999 world as a streamed set (docs/dat-streaming.md §6.10).
 *
 * tools/publish-dats-r2.ts --overlay ac1999 packs the 1999 portal.dat +
 * cell.dat read THROUGH dat-parser era1999's overlay, so the set holds
 * end-of-retail formats; the client streams it as a world-only set
 * (StreamingDats scope 'world') beside end of retail's interface set, and
 * Ac1999World's overlays then translate only the server's patches
 * (`translatedBase`). The untranslated CharGen the 1999 chargen text reads
 * travels as a copy (AC1999_UNTRANSLATED_COPIES).
 *
 * The first block runs everywhere (no DATs). The second builds the real set
 * from dat-sets/ac1999-retail into a temp stage (describe.skipIf + beforeAll)
 * and drives the shipped DatStore / StreamingDats / Ac1999World / Chargen1999
 * over its objects.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatDatabase, type DatResidentSource } from '../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import {
  AC1999_OVERLAY_KIND, AC1999_UNTRANSLATED_COPIES, ac1999CellOverlay, ac1999PortalOverlay,
} from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { syntheticTextureId } from '../packages/dat-parser/src/era1999/Textures1999.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { RegionDesc } from '../packages/dat-parser/src/file-types/RegionDesc.js';
import { SurfaceTexture } from '../packages/dat-parser/src/file-types/SurfaceTexture.js';
import { Texture } from '../packages/dat-parser/src/file-types/Texture.js';
import { parsePack } from '../packages/dat-parser/src/streaming/DatSetFormat.js';
import { fileKey } from '../packages/renderer/src/dat/streaming/DatStore.js';
import { MemoryObjectCache } from '../packages/renderer/src/dat/streaming/ObjectCache.js';
import type { StreamingDats } from '../packages/renderer/src/dat/streaming/StreamingDats.js';
import { Ac1999World } from '../packages/renderer/src/era/Ac1999World.js';
import { loadChargen1999 } from '../packages/renderer/src/ui/Chargen1999.js';

const CHARGEN = 0x0e000002;
const u8 = (b: ArrayBuffer | null | undefined) => (b ? new Uint8Array(b) : null);

/** A DatDatabase over an in-memory map (the shape a streamed DAT has: no container). */
function residentDb(files: Map<number, Uint8Array>): DatDatabase {
  const src: DatResidentSource = {
    kind: 'resident',
    header: { blockSize: 1024, dataSet: 1, dataSubset: 0, masterMapId: 0 },
    get: (id) => (files.has(id >>> 0) ? files.get(id >>> 0)!.slice().buffer : null),
    has: (id) => files.has(id >>> 0),
    listIds: (p) => [...files.keys()].filter((id) => p === undefined || (id >>> 24) === p),
    get count() { return files.size; },
    sizeOf: (id) => files.get(id >>> 0)?.length ?? -1,
  };
  return new DatDatabase(src);
}

describe('the 1999 overlay over an already-translated base (translatedBase)', () => {
  const gfx = new Uint8Array([1, 2, 3, 4]); // stands for a translated GfxObj
  const chargenEoL = new Uint8Array([5, 6, 7, 8]);
  const chargen1999 = new Uint8Array([9, 9, 9]);
  const setup = new Uint8Array([10, 11]);
  const files = new Map<number, Uint8Array>([
    [0x01000001, gfx], [CHARGEN, chargenEoL], [AC1999_UNTRANSLATED_COPIES.get(CHARGEN)!, chargen1999], [0x02000001, setup],
  ]);

  it('passes every unpatched file through untouched (a second translation would corrupt it)', () => {
    const db = residentDb(files);
    db.setOverlay(ac1999PortalOverlay({ translatedBase: true }));
    expect(db.overlayKind).toBe(AC1999_OVERLAY_KIND);
    expect(u8(db.getFileData(0x01000001))).toEqual(gfx);
    expect(u8(db.getFileData(CHARGEN))).toEqual(chargenEoL);
    expect(u8(db.getFileData(0x02000001))).toEqual(setup);
  });

  it('the untranslated bytes come from the set\'s copy (CharGen), a patch, or nowhere for other translated types', () => {
    const patches = new Map<number, ArrayBuffer>();
    const db = residentDb(files);
    db.setOverlay(ac1999PortalOverlay({ translatedBase: true, patches }));
    expect(u8(db.getUntranslatedFileData(CHARGEN))).toEqual(chargen1999);
    expect(db.getUntranslatedFileData(0x01000001)).toBeNull(); // only its translation exists in the set
    expect(u8(db.getUntranslatedFileData(0x02000001))).toEqual(setup); // served as is: raw == served
    const patched = new Uint8Array([42]);
    patches.set(0x02000001, patched.slice().buffer);
    expect(u8(db.getFileData(0x02000001))).toEqual(patched); // an untranslated type: the patch as is
    expect(u8(db.getUntranslatedFileData(0x02000001))).toEqual(patched);
  });

  it('a patched file of a translated type is translated (here: garbage that fails to translate is served missing, reported)', () => {
    const errors: number[] = [];
    const patches = new Map<number, ArrayBuffer>([[0x01000001, new Uint8Array([0xff]).buffer]]);
    const db = residentDb(files);
    db.setOverlay(ac1999PortalOverlay({ translatedBase: true, patches, onError: (id) => errors.push(id) }));
    expect(db.getFileData(0x01000001)).toBeNull();
    expect(errors).toEqual([0x01000001]);
  });

  it('the whole-file overlay (no translatedBase) still translates the container and reads raw from it', () => {
    const ov = ac1999PortalOverlay();
    expect(u8(ov.getRaw!(CHARGEN, (id) => files.get(id)!.slice().buffer))).toEqual(chargenEoL);
    expect(ac1999CellOverlay().kind).toBe(AC1999_OVERLAY_KIND);
  });
});

const AC1999 = resolve(__dirname, '..', 'dat-sets', 'ac1999-retail');
const HAS_1999 = existsSync(resolve(AC1999, 'portal.dat')) && existsSync(resolve(AC1999, 'cell.dat'));

describe.skipIf(!HAS_1999)('the real 1999 world set (tools/publish-dats-r2.ts --overlay ac1999)', () => {
  let stage: string;
  let pointer: Record<string, unknown>;
  let pointerName: string;
  let whole: { portal: DatDatabase; cell: DatDatabase };
  let sd: StreamingDats;
  const fetched: string[] = [];

  beforeAll(async () => {
    stage = mkdtempSync(join(tmpdir(), 'acjs-1999-set-'));
    execFileSync('npx', ['tsx', 'tools/publish-dats-r2.ts', '--overlay', 'ac1999', '--dat-dir', AC1999, '--stage-only', '--stage', stage],
      { cwd: resolve(__dirname, '..'), stdio: 'pipe' });
    pointerName = readdirSync(join(stage, 'v1/sets'))[0];
    pointer = JSON.parse(readFileSync(join(stage, 'v1/sets', pointerName), 'utf8'));
    // The reference: the whole 1999 files through the full overlay (their own instances: the overlay changes reads).
    whole = { portal: new DatDatabase(new FileDatBytes(join(AC1999, 'portal.dat'))), cell: new DatDatabase(new FileDatBytes(join(AC1999, 'cell.dat'))) };
    whole.portal.setOverlay(ac1999PortalOverlay());
    whole.cell.setOverlay(ac1999CellOverlay());
    const { openStreamingDats } = await import('../packages/renderer/src/dat/streaming/StreamingDats.js');
    sd = await openStreamingDats({
      pointerUrl: `https://dats.test/v1/sets/${pointerName}`,
      fetchPointer: async () => JSON.parse(JSON.stringify(pointer)),
      fetchObject: async (url: string) => {
        const h = url.slice(url.lastIndexOf('/') + 1);
        fetched.push(h);
        return new Uint8Array(readFileSync(join(stage, 'v1/o', h)));
      },
      cache: new MemoryObjectCache(),
      scope: 'world',
    });
  }, 180_000);

  afterAll(() => { if (stage) rmSync(stage, { recursive: true, force: true }); });

  it('is a world-only set: portal + cell at the 1999 iterations, skeleton + terrain + world packs only', () => {
    expect(pointerName).toBe('ac1999-retail-world-p102-c67.json');
    expect(pointer.iterations).toEqual({ portal: 102, cell: 67, local: 0, highres: 0 });
    expect(Object.keys(pointer.packs as object).sort()).toEqual(['skeleton', 'terrain', 'world']);
    expect(Object.keys(pointer.dats as object).sort()).toEqual(['cell', 'portal']);
    expect(sd.portal.totalIterations).toBe(102);
    expect(sd.cell.totalIterations).toBe(67);
    expect(sd.uiArtRoots()).toEqual([]);
  });

  it('the world pack makes the translated Region\'s whole terrain texture closure resident (terrain materials build once, with no miss)', async () => {
    // Derived independently from the whole 1999 files: TexMerge → SurfaceTexture levels → Texture → palette.
    const tm = new RegionDesc(new DatReader(whole.portal.getFileData(0x13000000)!)).terrainInfo.landSurfaces.texMerge!;
    const roots = [
      ...tm.terrainDesc.flatMap((d) => [d.terrainTex.texGID, d.terrainTex.detailTexGID]),
      ...tm.cornerTerrainMaps.map((m) => m.texGID), ...tm.sideTerrainMaps.map((m) => m.texGID), ...tm.roadMaps.map((m) => m.roadTexGID),
    ].filter((id) => id !== 0).map((id) => id >>> 0);
    expect(roots.some((id) => id >>> 24 === 0x05)).toBe(true);
    const leaves = new Set<number>();
    for (const st of new Set(roots.filter((id) => id >>> 24 === 0x05))) {
      for (const t of SurfaceTexture.read(new DatReader(whole.portal.getFileData(st)!)).textures) {
        leaves.add(t >>> 0);
        const pal = Texture.read(new DatReader(whole.portal.getFileData(t)!)).defaultPaletteId;
        if (pal) leaves.add(pal >>> 0);
      }
    }
    expect([...leaves].some((id) => id >>> 24 === 0x07)).toBe(true); // the overlay's synthetic textures
    // In the pack itself…
    const ref = (pointer.packs as Record<string, { key: string }>).world;
    const pack = parsePack(new Uint8Array(gunzipSync(readFileSync(join(stage, ref.key)))));
    for (const id of leaves) expect(pack.files.has(id), `0x${id.toString(16)} in the world pack`).toBe(true);
    // …and through the shipped client: once worldPacks resolves (what main.ts awaits before the deferred
    // terrain build), every read the terrain materials make is resident, byte for byte.
    await sd.worldPacks;
    const ids = [...new Set([...roots, ...leaves])];
    const { result, scope } = sd.store.scoped(() => ids.map((id) => sd.portal.getFileData(id)));
    expect(scope.missed).toBe(false);
    ids.forEach((id, i) => expect(u8(result[i]), `0x${id.toString(16)}`).toEqual(u8(whole.portal.getFileData(id))));
  });

  it('holds the end-of-retail translation of every file kind, byte for byte (no client-side translation)', async () => {
    const surfaceTexture = whole.portal.listFileIds(0x05)[0];
    const ids = [
      whole.portal.listFileIds(0x01)[0], // GfxObj (translated leaf)
      whole.portal.listFileIds(0x02)[0], // Setup (skeleton, as is)
      0x13000000, // Region (the hardware region, translated)
      CHARGEN, // CharGen (translated)
      surfaceTexture, // SurfaceTexture (translated, names the synthetic texture)
      syntheticTextureId(surfaceTexture), // the synthetic 0x07 texture
      whole.portal.listFileIds(0x06)[0], // Texture (translated)
    ];
    await sd.store.ensure(ids.map((id) => fileKey('portal', id)));
    for (const id of ids) expect(u8(sd.portal.getFileData(id)), `0x${id.toString(16)}`).toEqual(u8(whole.portal.getFileData(id)));
    // Cell: a landblock (terrain pack), and a dungeon's LandblockInfo + translated EnvCell (its bundle).
    await sd.worldPacks;
    const lb = whole.cell.listFileIds().find((id) => (id & 0xffff) === 0xffff)!;
    expect(u8(sd.cell.getFileData(lb))).toEqual(u8(whole.cell.getFileData(lb)));
    const env = whole.cell.listFileIds().find((id) => (id & 0xffff) >= 0x0100 && (id & 0xffff) <= 0xfffd)!;
    await sd.store.ensureBundle(env >>> 16);
    expect(u8(sd.cell.getFileData(env))).toEqual(u8(whole.cell.getFileData(env)));
    expect(sd.store.stats.unresolvedMisses).toBe(0);
  });

  it('Ac1999World over the set: chargen text from the untranslated copy; a server patch is translated and served without a fetch', async () => {
    const world = new Ac1999World(sd.portal, sd.cell, { translatedBase: true });
    const text = loadChargen1999(sd.portal);
    expect(text).not.toBeNull();
    expect(text!.heritageText(1)!.startsWith('ALUVIANS are a fiercely individualistic')).toBe(true);
    // A patch of a SurfaceTexture the set has not streamed yet: the 1999 bytes (as the server sends them).
    const st = whole.portal.listFileIds(0x05).find((id) => !sd.store.isResident('portal', id))!;
    const raw = whole.portal.getUntranslatedFileData(st)!;
    world.apply([{ dat: 'portal', fileId: st, bytes: raw }], { portal: 103, cell: 0 });
    const before = fetched.length;
    const { result, scope } = sd.store.scoped(() => [sd.portal.getFileData(st), sd.portal.getFileData(syntheticTextureId(st))]);
    expect(scope.missed).toBe(false);
    expect(fetched.length).toBe(before);
    expect(u8(result[0])).toEqual(u8(whole.portal.getFileData(st)));
    expect(u8(result[1])).toEqual(u8(whole.portal.getFileData(syntheticTextureId(st))));
    expect(world.iterations).toEqual({ portal: 103, cell: 67 });
  });
});
