/**
 * BUG.ac1999-turbine-box-markers (webac#30) — a 1999 GfxObj's degrade (LOD)
 * chain is implied by its id.
 *
 * A 1999 GfxObj has no DIDDegrade field. The 1999 client's
 * CPhysicsPart::LoadGfxObjArray @ 0x004462c0 (client.exe, ac1999-retail) looks
 * up `(gfxobj & 0xFFFFFF) | 0x11000000` and, when that GfxObjDegradeInfo
 * exists, draws the part through its per-level GfxObj array (a level whose
 * GfxObj is 0 draws nothing). End of retail reads the id from the GfxObj's own
 * DIDDegrade (CPhysicsPart::LoadGfxObjArray @ 0050dcf0), which is the slot the
 * 1999 overlay now fills.
 *
 * Without it every 1999 part drew level 0 at every distance, so the 1999
 * cell.dat's 213 world-builder marker boxes (static GfxObj 0x01000FDE, a cube
 * textured with the Turbine logo, whose 0x11000FDE chain is "level 0 up to
 * 0 m, then nothing") stood in the world — one of them beside the stone sign
 * at 60.2S 79.5E outside Mayoi (landblock 0xE234), where the 1999 client draws
 * nothing.
 *
 * End of retail and Dark Majesty keep reading DIDDegrade only: their 0x11 ids
 * are not keyed by the GfxObj's low bits (pinned below).
 *
 * The level pick: the 1999 get_degrade @ 0x0044b6d0 is end of retail's
 * GfxObjDegradeInfo::get_degrade @ 0051e4b0 (same overrides, bias formulas,
 * last-level fallback; the caller 0x00446f90 divides by gfxobj_scale.z and
 * keeps the player's parts at level 0; the 50 m land-cell distance at
 * 0x0057eb60) EXCEPT that it compares |dist| without subtracting a Degrade
 * Distance: EraWorldRules.degradeDistanceShift, false for 1999.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { GfxObj } from '../packages/dat-parser/src/file-types/GfxObj.js';
import { LandblockInfo } from '../packages/dat-parser/src/file-types/LandblockInfo.js';
import {
  impliedDegradeId1999, transcodeGfxObj1999, withDegradeId,
} from '../packages/dat-parser/src/era1999/Geometry1999.js';
import { ac1999CellOverlay, ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { DatWriter } from '../packages/dat-parser/src/era1999/DatWriter.js';
import { DegradeLod, INVALID_DID, type DegradeChain } from '../packages/renderer/src/models/DegradeLod.js';
import { AC1999_WORLD_RULES, CLASSIC_WORLD_RULES, EOR_WORLD_RULES } from '../packages/renderer/src/era/EraWorldRules.js';
import { SceneryInstancer, type InstanceEntry } from '../packages/renderer/src/terrain/SceneryInstancer.js';
import { SceneryInstancePool } from '../packages/renderer/src/terrain/SceneryInstancePool.js';
import { openDat, dataPath, DAT_PATHS } from './_harness/dat.js';

const PORTAL_1999 = dataPath('dat-sets/ac1999-retail/portal.dat');
const CELL_1999 = dataPath('dat-sets/ac1999-retail/cell.dat');
const PORTAL_DM = dataPath('dat/sets/classic-dereth/client_portal.dat');

const TURBINE_BOX = 0x01000fde;
const TURBINE_BOX_DEGRADE = 0x11000fde;
/** A 1999 grass tuft static (1,832 placements): full → billboard → nothing. */
const GRASS = 0x01001126;

/** A minimal 1999-format GfxObj: no surfaces, no vertices, drawing flag off. */
function tiny1999GfxObj(id: number, flags = 0): ArrayBuffer {
  const w = new DatWriter();
  w.writeUInt32(id).writeUInt32(flags).writeUInt32(0); // id, flags, num_surfaces
  w.writeUInt32(1).writeUInt32(0); // CVertexArray: vertex_type 1, count 0
  w.writeUInt32(0).writeUInt32(0).writeUInt32(0); // sort center
  return w.toArrayBuffer();
}

describe('impliedDegradeId1999 / withDegradeId — the EoL DIDDegrade slot', () => {
  it('derives 0x11 + the low 24 bits, as LoadGfxObjArray @ 0x004462c0 does', () => {
    expect(impliedDegradeId1999(TURBINE_BOX)).toBe(TURBINE_BOX_DEGRADE);
    expect(impliedDegradeId1999(0x01ffffff)).toBe(0x11ffffff);
  });

  it('a translated GfxObj carries the id it is given, and none when given 0', () => {
    const raw = tiny1999GfxObj(0x01000123);
    const plain = new GfxObj(new DatReader(transcodeGfxObj1999(raw)));
    expect(plain.flags & 0x8).toBe(0);
    expect(plain.didDegrade).toBe(0);
    const withLod = new GfxObj(new DatReader(transcodeGfxObj1999(raw, 0x11000123)));
    expect(withLod.flags & 0x8).toBe(0x8);
    expect(withLod.didDegrade).toBe(0x11000123);
    expect(withLod.id).toBe(0x01000123);
  });

  it('withDegradeId leaves a record that already has one, or a 0 id, unchanged', () => {
    const once = withDegradeId(transcodeGfxObj1999(tiny1999GfxObj(0x01000123)), 0x11000123);
    expect(withDegradeId(once, 0x11000999)).toBe(once);
    const bare = transcodeGfxObj1999(tiny1999GfxObj(0x01000123));
    expect(withDegradeId(bare, 0)).toBe(bare);
  });
});

describe('the level pick per era: 1999 get_degrade @ 0x0044b6d0 has no Degrade Distance shift', () => {
  /** A chain like the 1999 grass tuft 0x11001126: full to ideal 8, billboard to ideal 25, then nothing. */
  const chain: DegradeChain = {
    infoId: 0x11001126,
    degrades: [
      { gfxObjId: 0x01001126, degradeMode: 1, minDist: 4, idealDist: 8, maxDist: 15 },
      { gfxObjId: 0x01001140, degradeMode: 5, minDist: 20, idealDist: 25, maxDist: 30 },
      { gfxObjId: 0, degradeMode: 1, minDist: 3.4028234663852886e+38, idealDist: 3.4028234663852886e+38, maxDist: 3.4028234663852886e+38 },
    ],
    levelIds: [0x01001126, 0x01001140, 0],
    sortCenter: new THREE.Vector3(),
  };

  it('the era rules: end of retail and the classic eras shift, 1999 does not', () => {
    expect(EOR_WORLD_RULES.degradeDistanceShift).toBe(true);
    expect(CLASSIC_WORLD_RULES.degradeDistanceShift).toBe(true);
    expect(AC1999_WORLD_RULES.degradeDistanceShift).toBe(false);
  });

  it('end of retail: |dist| − Degrade Distance (default 50) against ideal (bias 0)', () => {
    const lod = new DegradeLod(null);
    lod.degradeDistanceShift = EOR_WORLD_RULES.degradeDistanceShift;
    lod.setPrefs({ adaptiveDegrade: false, adaptiveDegradeBias: 0 });
    expect(lod.effectiveDegradeDistance).toBe(50);
    expect(lod.levelFor(chain, 10)).toBe(0);
    expect(lod.levelFor(chain, 57)).toBe(0); // 7 < 8
    expect(lod.levelFor(chain, 60)).toBe(1);
    expect(lod.levelFor(chain, 80)).toBe(2);
  });

  it('1999: |dist| itself, whatever the preference holds', () => {
    const lod = new DegradeLod(null);
    lod.degradeDistanceShift = AC1999_WORLD_RULES.degradeDistanceShift;
    lod.setPrefs({ degradeDistance: 100, adaptiveDegrade: false, adaptiveDegradeBias: 0 });
    expect(lod.effectiveDegradeDistance).toBe(0);
    expect(lod.levelFor(chain, 7)).toBe(0);
    expect(lod.levelFor(chain, 10)).toBe(1);
    expect(lod.levelFor(chain, 26)).toBe(2);
    // The bias formulas are the same in both exes (≥ 0: ideal − (ideal − max)·bias).
    lod.setPrefs({ adaptiveDegrade: false, adaptiveDegradeBias: 1 });
    expect(lod.levelFor(chain, 14)).toBe(0); // < max 15
    expect(lod.levelFor(chain, 16)).toBe(1);
  });
});

const have1999 = existsSync(PORTAL_1999) && existsSync(CELL_1999);

describe.skipIf(!have1999)('AC1999 portal — GfxObjs served with their implied degrade chain', () => {
  let portal: DatDatabase;
  let cell: DatDatabase;
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { FileDatBytes } = await import('../packages/dat-parser/src/node/FileDatBytes.js');
    portal = new DatDatabase(new FileDatBytes(PORTAL_1999));
    portal.setOverlay(ac1999PortalOverlay());
    cell = new DatDatabase(new FileDatBytes(CELL_1999));
    cell.setOverlay(ac1999CellOverlay());
  });

  it('the Turbine marker box gets 0x11000FDE: level 0 up to 0 m, then INVALID', () => {
    const gfx = new GfxObj(new DatReader(portal.getFileData(TURBINE_BOX)!));
    expect(gfx.didDegrade).toBe(TURBINE_BOX_DEGRADE);
    const chain = new DegradeLod(portal).chainFor(TURBINE_BOX)!;
    expect(chain.levelIds).toEqual([TURBINE_BOX, INVALID_DID]);
    expect(chain.degrades[0].maxDist).toBe(0);
  });

  it('a GfxObj with no 0x11 file keeps no chain (drawn at every distance, as in 1999)', () => {
    const ids = portal.listFileIds(0x01).filter((id) => !portal.hasFile(impliedDegradeId1999(id)));
    expect(ids.length).toBeGreaterThan(2000);
    for (const id of ids.slice(0, 50)) {
      const gfx = new GfxObj(new DatReader(portal.getFileData(id)!));
      expect(gfx.didDegrade, `0x${id.toString(16)}`).toBe(0);
      expect(new DegradeLod(portal).chainFor(id)).toBeNull();
    }
  });

  it('every 1999 GfxObj with a 0x11 file gets it (1,359 of 3,816)', () => {
    let gfxObjs = 0;
    let chained = 0;
    for (const id of portal.listFileIds(0x01)) {
      const data = portal.getFileData(id);
      if (!data) continue;
      gfxObjs++;
      const gfx = new GfxObj(new DatReader(data));
      const implied = impliedDegradeId1999(id);
      expect(gfx.didDegrade, `0x${id.toString(16)}`).toBe(portal.hasFile(implied) ? implied : 0);
      if (gfx.didDegrade) chained++;
    }
    expect(gfxObjs).toBe(3816);
    expect(chained).toBe(1359);
  });

  it('a streamed set translated before the slot existed gets it too (translatedBase)', () => {
    const overlay = ac1999PortalOverlay({ translatedBase: true });
    // What a set published earlier holds: the 1999 GfxObj translated without the slot.
    const oldTranslation = (id: number): ArrayBuffer | null => {
      const raw = portal.getUntranslatedFileData(id);
      return raw && (id >>> 24) === 0x01 ? transcodeGfxObj1999(raw) : raw;
    };
    const baseHas = (id: number) => portal.hasFile(id);
    const served = overlay.get(TURBINE_BOX, oldTranslation, baseHas)!;
    expect(new GfxObj(new DatReader(served)).didDegrade).toBe(TURBINE_BOX_DEGRADE);
    // A file the set lacks (or has not streamed in yet) stays a miss, not an empty record.
    expect(overlay.get(TURBINE_BOX, () => null, baseHas)).toBeNull();
    // Every other type still passes through as the set's own.
    expect(overlay.get(TURBINE_BOX_DEGRADE, oldTranslation, baseHas)).toBeUndefined();
  });

  it('Mayoi 0xE234: the marker box beside the stone sign draws nothing; the sign and grass draw', () => {
    const info = new LandblockInfo(new DatReader(cell.getFileData(0xe234fffe)!));
    const box = info.objects.find((o) => o.id === TURBINE_BOX)!;
    expect(box.frame.origin.x).toBeCloseTo(164.039, 2);
    expect(box.frame.origin.y).toBeCloseTo(41.449, 2);
    // The shipped static path: SceneryInstancePool with the world's DegradeLod.
    const lod = new DegradeLod(portal);
    const source = { createMesh: () => {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial()));
      return g;
    } };
    const inScene = new Set<THREE.InstancedMesh>();
    const pool = new SceneryInstancePool(new SceneryInstancer(source, { loadSetupModel: () => null }), 'staticinst',
      (m) => inScene.add(m as THREE.InstancedMesh), (m) => inScene.delete(m as THREE.InstancedMesh), { lod });
    const at = (objId: number, x: number, y: number, z: number): InstanceEntry =>
      ({ objId, matrix: new THREE.Matrix4().makeTranslation(x, z, -y) });
    const o = box.frame.origin;
    pool.addBlock(0xe234, [
      at(TURBINE_BOX, o.x, o.y, o.z),
      at(GRASS, o.x + 1, o.y, o.z),
    ]);
    // Where the reporter stood: ~2 m off the box, beside the sign (0x0200031D at 166.69, 44.24).
    pool.updateLod(new THREE.Vector3(166.2, 166.2 + 1.7, -42.8));
    expect(pool.levelCensusFor(TURBINE_BOX)).toEqual({ 1: 1 });
    expect(pool.levelCensusFor(GRASS)).toEqual({ 0: 1 });
    const drawn = [...inScene].filter((m) => m.visible && m.count > 0).map((m) => m.name);
    expect(drawn.some((n) => n.includes('01000fde'))).toBe(false);
    expect(drawn.some((n) => n.includes('01001126'))).toBe(true);
    // And from anywhere else: never drawn.
    for (const d of [0.5, 5, 30, 200]) {
      pool.updateLod(new THREE.Vector3(o.x + d, o.z + 1.7, -o.y));
      expect(pool.levelCensusFor(TURBINE_BOX), `${d} m`).toEqual({ 1: 1 });
    }
  });

  it('body and clothing parts draw their chain\'s level 0 (the detailed mesh) up close, as 1999 and end of retail do', () => {
    // CPhysicsPart::SetGfxObjArray @ 0x00446240 keeps gfxobj[] = the chain's level GfxObjs
    // (LoadGfxObjArray @ 0x004462c0) and the ctor @ 0x00445ed0 starts deg_level at 0, so a part
    // (the player's, whose level is pinned at 0 by 0x00446f90, a chargen / paperdoll view's, or a
    // body seen up close) draws degrades[0].gfxobj, not the part's own id. For the human body and
    // clothing parts that is a detailed variant: 0x0100004E (12 vertices) → 0x01001787 (24).
    const lod = new DegradeLod(portal);
    const chain = lod.chainFor(0x0100004e)!;
    expect(chain.levelIds[0]).toBe(0x01001787);
    expect(chain.levelIds[1]).toBe(0x0100004e);
    // The Gharu'ndim trouser leg 0x010004C4 → 0x010017A0 (the screen-regression diff of 2026-11-11).
    expect(lod.chainFor(0x010004c4)!.levelIds[0]).toBe(0x010017a0);
    // Every level lists the part's own surfaces (retail draws all levels through gfxobj[0]'s).
    for (const id of chain.levelIds.filter((l) => l !== INVALID_DID)) {
      expect(new GfxObj(new DatReader(portal.getFileData(id)!)).surfaces, `0x${id.toString(16)}`)
        .toEqual(new GfxObj(new DatReader(portal.getFileData(0x0100004e)!)).surfaces);
    }
    // The shipped part path: attaching swaps the base meshes for level 0's at once.
    const built: number[] = [];
    const part = new THREE.Group();
    part.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshLambertMaterial()));
    expect(lod.attachPart(part, 0x0100004e, (id) => { built.push(id); return new THREE.Group(); })).toBe(true);
    expect(built).toEqual([0x01001787]);
    expect(part.children[0].visible).toBe(false);
  });

  it('sweep: the 1999 world statics whose every part draws nothing (Turbine boxes + 6 cm marker tris)', () => {
    const lod = new DegradeLod(portal);
    const neverDrawn = (gfxId: number) => {
      const c = lod.chainFor(gfxId);
      return !!c && c.degrades[0].maxDist <= 0 && c.levelIds.slice(1).every((l) => l === INVALID_DID);
    };
    const hidden = portal.listFileIds(0x01).filter(neverDrawn).sort((a, b) => a - b);
    expect(hidden).toEqual([0x010001ec, 0x010008a8, TURBINE_BOX]);
    let boxes = 0;
    const blocks = new Set<number>();
    for (let x = 0; x < 256; x++) for (let y = 0; y < 256; y++) {
      const id = ((x << 24) | (y << 16) | 0xfffe) >>> 0;
      const d = cell.getFileData(id);
      if (!d) continue;
      for (const o of new LandblockInfo(new DatReader(d)).objects) {
        if (o.id === TURBINE_BOX) { boxes++; blocks.add(id >>> 16); }
      }
    }
    expect(boxes).toBe(213);
    expect(blocks.has(0xe234)).toBe(true);
  });
});

const EOL_DM: Array<{ era: string; path: string }> = [
  { era: 'end of retail', path: DAT_PATHS.portal },
  { era: 'Dark Majesty', path: PORTAL_DM },
];
for (const { era, path } of EOL_DM) {
  describe.skipIf(!existsSync(path))(`${era} — DIDDegrade only, never the 1999 id rule`, () => {
    let portal: DatDatabase;
    beforeAll(() => { portal = openDat(path); });

    it('a GfxObj without DIDDegrade keeps no chain even where 0x11 + its low bits exists', () => {
      // 0x010000D1 has no DIDDegrade; 0x110000D1 belongs to another GfxObj.
      const gfx = new GfxObj(new DatReader(portal.getFileData(0x010000d1)!));
      expect(gfx.didDegrade).toBe(0);
      expect(portal.hasFile(0x110000d1)).toBe(true);
      expect(new DegradeLod(portal).chainFor(0x010000d1)).toBeNull();
    });

    it('the body part 0x0100004E starts its chain at the detailed 0x01001787 here too', () => {
      expect(new DegradeLod(portal).chainFor(0x0100004e)!.levelIds[0]).toBe(0x01001787);
    });

    it('a GfxObj with DIDDegrade keeps exactly that chain', () => {
      const id = portal.listFileIds(0x01).find((g) => {
        const gfx = new GfxObj(new DatReader(portal.getFileData(g)!));
        return gfx.didDegrade !== 0 && gfx.didDegrade !== impliedDegradeId1999(g);
      })!;
      const gfx = new GfxObj(new DatReader(portal.getFileData(id)!));
      expect(new DegradeLod(portal).chainFor(id)!.infoId).toBe(gfx.didDegrade);
    });
  });
}
