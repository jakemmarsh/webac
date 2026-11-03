/**
 * STREAM.spell-projectile-first-use (webac#16 item 4) — a creature's first
 * spell projectile flew for ~430 ms as a 3-triangle partial mesh on the
 * streamed sets: its Setup's GfxObjs / textures were fetched only at the
 * projectile's CreateObject. The fix is in the sets: the effect leaves
 * (tools/lib/effect-leaves.ts: every ProjectileSpell / Missile / Ammunition
 * weenie's closure, every PhysicsScriptTable's scripts, every animation
 * hook's emitters) ride the common pack, which the client loads in the
 * background at boot and keeps for the session.
 *
 * The DAT cases run the shipped client: a real DatStore whose ONLY portal
 * leaves are the common pack (every other leaf fetch fails the test), loaded
 * through the area index exactly as StreamingDats does (ensureCommonPack),
 * then the real SetupModelRenderer / EmitterSprite builds, which must not miss.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { PhysicsScript, PhysicsScriptTable } from '../packages/dat-parser/src/file-types/PhysicsScript.js';
import { ParticleEmitterInfo } from '../packages/dat-parser/src/file-types/ParticleEmitterInfo.js';
import { SKELETON_TYPES, buildAreaIndex, type DatSetManifest, type DatSetPointer, type ObjectRef } from '../packages/dat-parser/src/streaming/DatSetFormat.js';
import { DatStore } from '../packages/renderer/src/dat/streaming/DatStore.js';
import {
  EFFECT_WEENIE_TYPES, effectLeavesToAdd, effectWeenieRootsFromSql, effectWeenieRootsFromSqlDir,
  effectWeenieRootsFromWorldDb, planEffectLeaves,
} from '../tools/lib/effect-leaves.js';
import { buildPack } from './_harness/datSet.js';
import { DAT_PATHS, DAT_SETS_DIR, openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const WORLD_DB = resolve(REPO, 'dat/world.sqlite');
const PORTAL_1999 = join(DAT_SETS_DIR, 'ac1999-retail', 'portal.dat');
const SQL_1999 = resolve(REPO, 'reference/ac1999/Server/Database/AC1999-World/3-Core/9 WeenieDefaults/SQL');
const ITERATION = 0xffff0001;

/** The AC1999 server's Whirling Blade (wcid 1636), as its SQL tree has it (the Banderling Captain's spell). */
const WHIRLING_BLADE_SQL = `DELETE FROM \`weenie\` WHERE \`class_Id\` = 1636;

INSERT INTO \`weenie\` (\`class_Id\`, \`class_Name\`, \`type\`, \`last_Modified\`)
VALUES (1636, 'whirlingblade', 33, '2005-02-09 10:00:00') /* ProjectileSpell */;

INSERT INTO \`weenie_properties_int\` (\`object_Id\`, \`type\`, \`value\`)
VALUES (1636,   9,          0) /* ValidLocations - None */
     , (1636,  93,     133140) /* PhysicsState - Ethereal, IgnoreCollisions, LightingOn, Inelastic */;

INSERT INTO \`weenie_properties_d_i_d\` (\`object_Id\`, \`type\`, \`value\`)
VALUES (1636,   1, 0x020003FC) /* Setup */
     , (1636,   3, 0x2000003C) /* SoundTable */
     , (1636,   8, 0x06001066) /* Icon */
     , (1636,  22, 0x34000008) /* PhysicsEffectTable */
     , (1636,  28,         92) /* Spell - Whirling Blade I */
     , (1636,  30,         90) /* PhysicsScript - ProjectileCollision */;
`;

describe('effect weenie roots and the live-set merge (pure)', () => {
  it('reads a ProjectileSpell weenie\'s Setup, SoundTable, Icon and PhysicsEffectTable from its SQL (not the spell id or the script enum)', () => {
    expect(effectWeenieRootsFromSql(WHIRLING_BLADE_SQL)).toEqual([0x020003fc, 0x2000003c, 0x06001066, 0x34000008]);
  });

  it('a weenie of another type (a creature, a door) contributes nothing', () => {
    expect(EFFECT_WEENIE_TYPES.has(10)).toBe(false);
    expect(effectWeenieRootsFromSql(WHIRLING_BLADE_SQL.replace("'whirlingblade', 33", "'whirlingblade', 10"))).toEqual([]);
    expect(effectWeenieRootsFromSql('-- nothing here')).toEqual([]);
  });

  it('Missile and Ammunition weenies count (thrown weapons and arrows are created mid-fight too)', () => {
    expect(EFFECT_WEENIE_TYPES.has(4) && EFFECT_WEENIE_TYPES.has(5) && EFFECT_WEENIE_TYPES.has(33)).toBe(true);
    expect(effectWeenieRootsFromSql(WHIRLING_BLADE_SQL.replace("'whirlingblade', 33", "'whirlingblade', 5"))).toEqual([0x020003fc, 0x2000003c, 0x06001066, 0x34000008]);
  });

  it('adds only leaves the set publishes, that no resident pack and not the common pack already carry', () => {
    const add = effectLeavesToAdd([0x01000003, 0x01000001, 0x06000002, 0x06000009, 0x01000003, 0x0600000a], {
      manifestLeaves: new Set([0x01000001, 0x01000003, 0x06000002, 0x0600000a]),
      inPacks: new Set([0x06000002]),
      commonIds: new Set([0x0600000a]),
    });
    expect(add).toEqual([0x01000001, 0x01000003]); // 0x06000009 is not a leaf of the set
  });
});

/**
 * A DatStore over `portal` whose only reachable portal leaves are `leaves`,
 * delivered as the area index's common pack. Any other leaf fetch is recorded.
 */
async function storeWithCommonPack(portal: DatDatabase, leaves: readonly number[]) {
  const objects = new Map<string, Uint8Array>();
  const { gzipSync } = await import('node:zlib');
  const put = (payload: Uint8Array, tag: string): ObjectRef => {
    const hash = tag.padStart(16, '0');
    objects.set(hash, new Uint8Array(gzipSync(payload, { level: 1 })));
    return { hash, size: payload.length, gzSize: objects.get(hash)!.length };
  };
  const read = (id: number) => new Uint8Array(portal.getFileData(id)!);
  const skeleton: Array<{ id: number; data: Uint8Array }> = [];
  const manifestLeaves = new Map<number, ObjectRef>();
  for (const id of portal.listFileIds()) {
    if (id === ITERATION) continue;
    if (SKELETON_TYPES.has(id >>> 24)) { const d = portal.getFileData(id); if (d) skeleton.push({ id, data: new Uint8Array(d) }); }
    else manifestLeaves.set(id, { hash: `1${(id >>> 0).toString(16).padStart(8, '0')}`.padStart(16, '0'), size: 1, gzSize: 1 });
  }
  const common = put(buildPack(leaves.map((id) => ({ id, data: read(id) }))), 'c0'); // buildPack sorts
  const index = put(buildAreaIndex(4, { ...common, files: leaves.length }, []), 'a0');
  const manifest: DatSetManifest = { leaves: { portal: manifestLeaves, highres: new Map() }, packs: new Map(), bundles: new Map() };
  const pointer: DatSetPointer = {
    format: 1, set: 'test-effects', iterations: { portal: 1, cell: 1, local: 0, highres: 0 },
    manifest: { hash: '0000000000000000', size: 0, gzSize: 0 }, packs: {}, areas: index,
  };
  const leafFetches: string[] = [];
  const store = DatStore.fromParts('https://dats.test', pointer, manifest, {
    verifyHash: false,
    fetchObject: async (url) => {
      const h = url.slice(url.lastIndexOf('/') + 1);
      const o = objects.get(h);
      if (!o) { leafFetches.push(h); throw new Error(`not in the test set: ${h}`); }
      return o;
    },
  });
  store.addPackBytes('skeleton', buildPack(skeleton));
  await store.ensureCommonPack();
  return { store, leafFetches };
}

async function renderStack(store: DatStore) {
  const portalDb = store.db('portal');
  const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
  const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
  const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
  const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
  const { DegradeLod } = await import('../packages/renderer/src/models/DegradeLod.js');
  const { resolveEmitterSprite } = await import('../packages/renderer/src/effects/EmitterSprite.js');
  const textureManager = new TextureManager(portalDb, 2048, 4096, null);
  const modelRenderer = new ModelRenderer(portalDb, new MaterialFactory(portalDb, textureManager));
  const setupModelRenderer = new SetupModelRenderer(portalDb, modelRenderer);
  setupModelRenderer.setDegradeLod(new DegradeLod(portalDb));
  /** Every emitter a table's scripts create (CallPES followed). */
  const tableEmitters = (tableId: number): number[] => {
    const out = new Set<number>();
    const seen = new Set<number>();
    const script = (id: number): void => {
      if (seen.has(id) || !portalDb.hasFile(id)) return;
      seen.add(id);
      for (const step of PhysicsScript.read(new DatReader(portalDb.getFileData(id)!)).steps) {
        const h = step.hook as { hookType: number; emitterInfoId?: number; pes?: number } | null;
        if (h?.hookType === 13 && h.emitterInfoId) out.add(h.emitterInfoId >>> 0);
        else if (h?.hookType === 19 && h.pes) script(h.pes >>> 0);
      }
    };
    for (const list of PhysicsScriptTable.read(new DatReader(portalDb.getFileData(tableId)!)).scripts.values()) for (const e of list) script(e.scriptId >>> 0);
    return [...out].filter((id) => portalDb.hasFile(id));
  };
  const sprite = (emitterId: number) => resolveEmitterSprite(new ParticleEmitterInfo(new DatReader(portalDb.getFileData(emitterId)!)), portalDb, textureManager);
  return { portalDb, setupModelRenderer, tableEmitters, sprite };
}

/** Build every root Setup and every root table's emitters in one miss scope: what missed (hex ids). */
async function missesBuilding(store: DatStore, roots: readonly number[]): Promise<{ missed: string[]; setups: number; emitters: number; tris: number; blankSprites: number }> {
  const r = await renderStack(store);
  const setups = roots.filter((id) => id >>> 24 === 0x02 && r.portalDb.hasFile(id));
  const emitters = [...new Set(roots.filter((id) => id >>> 24 === 0x34 && r.portalDb.hasFile(id)).flatMap((t) => r.tableEmitters(t)))];
  const { result, scope } = store.scoped(() => {
    let tris = 0;
    let blank = 0;
    for (const id of setups) {
      r.setupModelRenderer.createSetupMesh(id)?.traverse((c) => {
        const g = (c as { geometry?: { index?: { count: number } | null; attributes?: { position?: { count: number } } } }).geometry;
        if (g) tris += (g.index ? g.index.count : g.attributes?.position?.count ?? 0) / 3;
      });
    }
    for (const e of emitters) { const sp = r.sprite(e); if (!sp?.map) blank++; }
    return { tris, blank };
  });
  return { missed: [...scope.keys].map((k) => k.toString(16)), setups: setups.length, emitters: emitters.length, tris: result.tris, blankSprites: result.blank };
}

const HAVE_EOL = existsSync(DAT_PATHS.portal) && existsSync(WORLD_DB);
describe.skipIf(!HAVE_EOL)('end of retail: effect leaves in the common pack (real DATs + ACE world DB)', () => {
  let portal: DatDatabase;
  let roots: number[];
  let leaves: number[];
  beforeAll(() => {
    portal = openDat(DAT_PATHS.portal);
    roots = effectWeenieRootsFromWorldDb(WORLD_DB);
    leaves = planEffectLeaves({ portal, weenieRoots: roots }).leaves;
  }, 120_000);

  it('plans every effect weenie\'s closure, every table\'s scripts and the animation-hook emitters, at a size worth sending everyone', () => {
    expect(roots.filter((id) => id >>> 24 === 0x02).length).toBeGreaterThan(50);
    expect(leaves.length).toBeGreaterThan(300);
    const raw = leaves.reduce((s, id) => s + portal.getFileEntry(id)!.fileSize, 0);
    expect(raw).toBeLessThan(12 * 1048576); // measured 7.5 MB raw with Waves, 3.8 MB without (2026-11-03)
    expect(leaves.every((id) => !SKELETON_TYPES.has(id >>> 24))).toBe(true);
  });

  it('with only the common pack, every projectile / missile / arrow builds whole and every table\'s effect draws textured: no fetch at CreateObject or PlayScript', async () => {
    const { store, leafFetches } = await storeWithCommonPack(portal, leaves);
    const tables = portal.listFileIds().filter((id) => id >>> 24 === 0x34);
    const res = await missesBuilding(store, [...roots, ...tables]);
    expect(res.missed).toEqual([]);
    expect(leafFetches).toEqual([]);
    expect(res.setups).toBeGreaterThan(50);
    expect(res.emitters).toBeGreaterThan(50);
    expect(res.tris).toBeGreaterThan(res.setups * 3);
    expect(res.blankSprites).toBe(0);
  }, 180_000);

  it('the negative: without the effect leaves, the same projectile build misses (what players saw for ~430 ms)', async () => {
    const { store } = await storeWithCommonPack(portal, []);
    const res = await missesBuilding(store, roots.filter((id) => id >>> 24 === 0x02).slice(0, 5));
    expect(res.missed.length).toBeGreaterThan(0);
  }, 120_000);

  it('the publish planner puts the effect leaves in the common pack, never in a tile (planAreas commonExtra)', async () => {
    const { planAreas } = await import('../tools/lib/area-packs.js');
    const { RegionDesc } = await import('../packages/dat-parser/src/file-types/RegionDesc.js');
    const regionDesc = new RegionDesc(new DatReader(portal.getFileData(0x13000000)!));
    const cell = openDat(DAT_PATHS.cell);
    const lb = 0xA9B4; // Holtburg
    const base = planAreas({ portal, cell, regionDesc, commonThreshold: Infinity, tileSize: 4, landblocks: [lb] });
    const tileLeaves = [...base.tiles.values()][0];
    const moved = [tileLeaves[0], tileLeaves[1]];
    const kept = tileLeaves[2];
    const withFx = planAreas({ portal, cell, regionDesc, commonThreshold: Infinity, tileSize: 4, landblocks: [lb], commonExtra: [...moved, kept, 0x7fffffff], inPacks: new Set([kept]) });
    expect(withFx.common).toEqual([...moved].sort((a, b) => a - b)); // the absent id and the in-pack leaf stay out
    const tile = [...withFx.tiles.values()][0];
    expect(tile.includes(moved[0]) || tile.includes(moved[1])).toBe(false);
    expect(tile.includes(kept)).toBe(false); // inPacks: in no area pack at all
    expect(tile.length).toBe(tileLeaves.length - 3);
  }, 120_000);
});

const HAVE_1999 = existsSync(PORTAL_1999) && existsSync(SQL_1999);
describe.skipIf(!HAVE_1999)('AC1999: effect leaves of the 1999 world set (1999 portal through the overlay + the AC1999 server\'s weenies)', () => {
  let portal: DatDatabase;
  let roots: number[];
  let leaves: number[];
  beforeAll(() => {
    // Its own instance: openDat's is shared per worker, and the overlay changes what it reads.
    portal = new DatDatabase(new FileDatBytes(PORTAL_1999));
    portal.setOverlay(ac1999PortalOverlay());
    roots = effectWeenieRootsFromSqlDir(SQL_1999);
    leaves = planEffectLeaves({ portal, weenieRoots: roots }).leaves;
  }, 180_000);

  it('the AC1999 server\'s ProjectileSpell weenies are roots: the Banderling Captain\'s Whirling Blade among them', () => {
    expect(roots).toContain(0x020003fc);
    expect(roots).toContain(0x34000008);
    expect(leaves.length).toBeGreaterThan(100);
  });

  it('the leaves the live check still fetched at the Captain\'s Shockwave / Whirling Blade CreateObject are in it: their launch / impact Waves and the projectile icon (2026-11-03)', () => {
    for (const id of [0x0a000251, 0x0a000252, 0x0a00026d, 0x0a00026e, 0x06001066]) expect(leaves).toContain(id);
    const quiet = planEffectLeaves({ portal, weenieRoots: roots, waves: false });
    expect(quiet.leaves.some((id) => id >>> 24 === 0x0a)).toBe(false);
    expect(quiet.waves).toEqual([]);
    expect(quiet.leaves).toContain(0x06001066); // the icon stays without the Waves
    expect(leaves.filter((id) => !quiet.leaves.includes(id)).every((id) => id >>> 24 === 0x0a)).toBe(true);
  }, 120_000);

  it('with only the common pack, Whirling Blade builds whole (not the 3-triangle partial mesh) and its table\'s effects draw', async () => {
    const { store, leafFetches } = await storeWithCommonPack(portal, leaves);
    const blade = await missesBuilding(store, [0x020003fc, 0x34000008]);
    expect(blade.missed).toEqual([]);
    expect(blade.tris).toBeGreaterThan(3);
    const all = await missesBuilding(store, [...roots, ...portal.listFileIds().filter((id) => id >>> 24 === 0x34)]);
    expect(all.missed).toEqual([]);
    expect(all.blankSprites).toBe(0);
    expect(leafFetches).toEqual([]);
    // The negative, as players saw it: without them the blade's build misses.
    const cold = await storeWithCommonPack(portal, []);
    expect((await missesBuilding(cold.store, [0x020003fc])).missed.length).toBeGreaterThan(0);
  }, 180_000);
});
