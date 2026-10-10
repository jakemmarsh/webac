/**
 * RELEASE.streaming-regression-gate — the DAT-streaming regressions Jake saw
 * on playwebac.com (2026-10-04) stay fixed:
 *  - item icons drew as letter placeholders and never repainted: an icon
 *    built while its streamed file was missing is a holder that refills
 *    itself when the file lands (DatMiss arrival signal), and the store
 *    reports misses still in flight (stats.unresolvedMisses, the A/B gate's check);
 *  - armor drew flat / untextured: a texture decoded while its streamed
 *    palette was missing was cached for good (TextureManager);
 *  - the login gate prefetches every queued object's icon with its model;
 *  - held items built across a miss are found again for the re-attach.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DatDatabase, type DatResidentSource } from '../packages/dat-parser/src/DatDatabase.js';
import { DAT_ARRIVAL_COALESCE_MS, noteDatMiss, noteDatMissResolved, onDatMissResolved } from '../packages/dat-parser/src/streaming/DatMiss.js';
import { TextureManager } from '../packages/renderer/src/models/TextureManager.js';
import { iconRoots, queuedObjectRoots } from '../packages/renderer/src/dat/streaming/ArrivalEvents.js';
import { DatStore, fileKey } from '../packages/renderer/src/dat/streaming/DatStore.js';
import { MemoryObjectCache } from '../packages/renderer/src/dat/streaming/ObjectCache.js';
import { WIELDED_BUILT_WITH_MISS_KEY, buildWieldedItemMesh, wieldedMeshesBuiltWithMiss } from '../packages/renderer/src/models/WieldedItemVisual.js';
import { FakeBucket, buildManifest, buildPack } from './_harness/datSet.js';
import { installDomGlobals, loadDomWindow, restoreDomGlobals } from './_harness/dom.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A resident-source DAT whose files can be withheld (a streamed DAT before arrival). */
function streamedPortal(files: Map<number, Uint8Array>, withheld: Set<number>): DatDatabase {
  const src: DatResidentSource = {
    kind: 'resident',
    header: { blockSize: 1024, dataSet: 1, dataSubset: 0, masterMapId: 0 },
    get: (id) => {
      if (withheld.has(id)) { noteDatMiss(); return null; }
      const f = files.get(id);
      return f ? f.slice().buffer : null;
    },
    has: (id) => files.has(id),
    listIds: () => [...files.keys()],
    get count() { return files.size; },
    sizeOf: (id) => files.get(id)?.byteLength ?? -1,
  };
  return new DatDatabase(src);
}

/** Texture 0x06000010: 2×1 P8 (indices 1, 2) with default palette 0x04000010. */
function p8TextureBytes(): Uint8Array {
  const b = new Uint8Array(24 + 2 + 4);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x06000010, true); dv.setInt32(4, 0, true); dv.setInt32(8, 2, true); dv.setInt32(12, 1, true);
  dv.setUint32(16, 41, true); // PFID_P8
  dv.setInt32(20, 2, true);
  b[24] = 1; b[25] = 2;
  dv.setUint32(26, 0x04000010, true);
  return b;
}
/** SurfaceTexture 0x05000010 → Texture 0x06000010. */
function surfaceTextureBytes(): Uint8Array {
  const b = new Uint8Array(4 + 4 + 1 + 4 + 4);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x05000010, true); dv.setUint32(4, 0, true); b[8] = 0; dv.setUint32(9, 1, true); dv.setUint32(13, 0x06000010, true);
  return b;
}
/** Palette 0x04000010: 3 ARGB colours (index 1 = pure red, 2 = pure green). */
function paletteBytes(): Uint8Array {
  const b = new Uint8Array(8 + 3 * 4);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x04000010, true); dv.setInt32(4, 3, true);
  dv.setUint32(8, 0xff000000, true); dv.setUint32(12, 0xffff0000, true); dv.setUint32(16, 0xff00ff00, true);
  return b;
}

describe('TextureManager across a streamed palette miss', () => {
  it('a paletted texture decoded without its palette is not cached; after arrival it decodes with the palette', () => {
    const files = new Map<number, Uint8Array>([[0x05000010, surfaceTextureBytes()], [0x06000010, p8TextureBytes()], [0x04000010, paletteBytes()]]);
    const withheld = new Set([0x04000010]);
    const tm = new TextureManager(streamedPortal(files, withheld), 64, 64, null);
    const before = tm.getDirectRGBA(0x06000010)!;
    const firstTex = tm.getTexture(0x05000010);
    expect(before.data[0]).not.toBe(0xff); // the palette-less fallback (index as grey)
    withheld.clear(); // the palette lands
    const after = tm.getDirectRGBA(0x06000010)!;
    expect([after.data[0], after.data[1], after.data[2]]).toEqual([0xff, 0, 0]);
    expect([after.data[4], after.data[5], after.data[6]]).toEqual([0, 0xff, 0]);
    const secondTex = tm.getTexture(0x05000010) as THREE.DataTexture;
    expect(secondTex).not.toBe(firstTex);
    expect((secondTex.image.data as Uint8Array)[0]).toBe(0xff);
    expect(tm.getTexture(0x05000010)).toBe(secondTex); // the real one is cached
  });
});

describe('DatStore: unresolved misses + the arrival signal', () => {
  it('counts a miss until its file lands, then fires onDatMissResolved once per batch', async () => {
    const bucket = new FakeBucket();
    const enc = (s: string) => new TextEncoder().encode(s);
    const boot = bucket.put(buildPack([{ id: 0x06000100, data: enc('boot') }]));
    const leaf = { id: 0x06000002, ...bucket.put(enc('icon-2')) };
    const leaf3 = { id: 0x06000003, ...bucket.put(enc('icon-3')) };
    const manifest = bucket.put(buildManifest({ leaves: { portal: [leaf, leaf3], highres: [] }, packs: [{ role: 1, ...boot, files: 1 }], bundles: [] }));
    const store = await DatStore.open({
      pointerUrl: 'https://dats.test/v1/sets/t.json',
      fetchPointer: async () => ({
        format: 1, set: 't', iterations: { portal: 1, cell: 1, local: 1, highres: 1 },
        manifest: { key: `v1/o/${manifest.hash}`, hash: manifest.hash, size: manifest.size, gzSize: manifest.gzSize },
        packs: { boot: { key: `v1/o/${boot.hash}`, size: boot.size, gzSize: boot.gzSize, files: 1 } },
      }),
      fetchObject: bucket.fetch,
      cache: new MemoryObjectCache(),
      packs: ['boot'],
    });
    let fired = 0;
    const off = onDatMissResolved(() => { fired++; });
    try {
      expect(store.db('portal').getFileData(0x06000002)).toBeNull(); // miss → critical fetch
      expect(store.db('portal').getFileData(0x06000003)).toBeNull();
      expect(store.stats.unresolvedMisses).toBe(2);
      await store.request('portal', 0x06000002);
      await store.request('portal', 0x06000003);
      expect(store.stats.unresolvedMisses).toBe(0);
      await wait(DAT_ARRIVAL_COALESCE_MS + 30);
      expect(fired).toBe(1); // two arrivals, one batch
      expect(new TextDecoder().decode(store.db('portal').getFileData(0x06000002)!)).toBe('icon-2');
      // A file absent from the set is never "unresolved".
      expect(store.db('portal').getFileData(0x06999999)).toBeNull();
      expect(store.stats.unresolvedMisses).toBe(0);
    } finally {
      off();
    }
  });
});

describe('the login gate prefetches icons with models', () => {
  it('queuedObjectRoots includes each queued object icon, underlay and overlay', () => {
    const roots = queuedObjectRoots([
      { type: 'objectCreate', data: { setupId: 0x02000001, iconId: 0x06001234, iconOverlayId: 0x06005678, iconUnderlayId: 0x06009abc } },
      { type: 'objectCreate', data: { setupId: 0, iconId: 0x06000fef } }, // an inventory item with no world model still brings its icon
      { type: 'message', data: {} },
    ]);
    for (const id of [0x02000001, 0x06001234, 0x06005678, 0x06009abc, 0x06000fef]) expect(roots).toContain(fileKey('portal', id));
    expect(iconRoots({ iconId: 0x06000001 }, [0x06000002, 0])).toEqual([fileKey('portal', 0x06000001), fileKey('portal', 0x06000002)]);
  });
});

describe('held items built across a streamed miss', () => {
  it('are marked with their placement and found under the wielder for the re-attach', () => {
    const builder = {
      createSetupMeshWithOverrides: () => { noteDatMiss(); return new THREE.Group(); },
    };
    const mesh = buildWieldedItemMesh(builder, { setupId: 0x02000155, objScale: 1, basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [] }, 3, () => null)!;
    expect(mesh.userData[WIELDED_BUILT_WITH_MISS_KEY]).toBe(true);
    mesh.name = 'wielded_3';
    mesh.userData.wieldedGuid = 0x8000bb5c;
    const part = new THREE.Group();
    part.add(mesh);
    const wielder = new THREE.Group();
    wielder.add(part);
    expect(wieldedMeshesBuiltWithMiss(wielder)).toEqual([{ wieldedGuid: 0x8000bb5c, wielderGuid: undefined, parentLocation: 3, placement: 3 }]);
    const clean = buildWieldedItemMesh({ createSetupMeshWithOverrides: () => new THREE.Group() },
      { setupId: 0x02000155, objScale: 1, basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [] }, 0, () => null)!;
    expect(clean.userData[WIELDED_BUILT_WITH_MISS_KEY]).toBeUndefined();
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('GameUI item icons across a streamed miss (no letter placeholder left behind)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const files = new Map<number, Uint8Array>([[0x06000fef, new Uint8Array([1, 2, 3, 4])]]);
  const withheld = new Set([0x06000fef]);
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const portal = streamedPortal(files, withheld);
    // The texture side GameUI reads icons through (canvas-free: data URL names the file).
    const tm = {
      getIconRGBA: (id: number) => (portal.getFileData(id) ? { width: 1, height: 1, data: new Uint8Array(4) } : null),
      getIconDataURL: (id: number) => (portal.getFileData(id) ? `data:image/png;base64,ICON${id.toString(16)}` : null),
      getJPEGDataURL: () => null,
    };
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container, {}, portal, tm as never);
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  it('returns a blank holder (not null) while the icon streams, and refills it in place on arrival', async () => {
    const holder = ui.buildItemIconElement(0x06000fef, 32);
    expect(holder).not.toBeNull(); // null is what made every caller draw the item's first letter
    expect(holder.dataset.acIconPending).toBe('1');
    expect(holder.children.length).toBe(0);
    domWindow.document.body.appendChild(holder);
    expect(ui.pendingIconCount).toBe(1);
    withheld.clear(); // the file lands
    noteDatMissResolved();
    await wait(DAT_ARRIVAL_COALESCE_MS + 30);
    expect(holder.dataset.acIconPending).toBeUndefined();
    expect(holder.innerHTML).toContain('ICON6000fef');
    expect(ui.pendingIconCount).toBe(0);
  });

  it('whole DATs (no miss) build the icon element directly, as before', () => {
    const el = ui.buildItemIconElement(0x06000fef, 32);
    expect(el.dataset.acIconPending).toBeUndefined();
    expect(el.style.backgroundImage).toContain('ICON6000fef');
  });
});
