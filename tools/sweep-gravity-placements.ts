/**
 * BUG.gravity-item-placed-midair sweep — every landblock_instance in an
 * interior cell whose weenie is a non-Static, non-creature Gravity object,
 * judged the way RemotePhysicsObject.enterWorld judges it on CreateObject:
 * where its spheres come to rest falling through the real cell collision
 * (cell floors + EnvCell statics, DungeonCollisionBuild;
 * outdoorGround.objectLandingZ), and whether retail's placement leaves it
 * (rest), steps it down (snap), drops it (fall), or cannot tell (unknown:
 * the cell is not in the landblock's collision / no spheres / no setup).
 *
 *   npx tsx tools/sweep-gravity-placements.ts [--world dat/world.sqlite]
 *     [--portal dat/client_portal.dat] [--cell dat/client_cell_1.dat]
 *     [--min-fall 0.1] [--limit-lb N] [--json out.json]
 *
 * The world DB's instances are ACE's (end of retail); point --portal /
 * --cell at another era's DATs to judge the same positions against its
 * cells. Prints totals by verdict and item type, then the falls longest
 * first (name, wcid, cell, z, surface, drop).
 */
import Database from 'better-sqlite3';
import { writeFileSync } from 'node:fs';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { LandblockInfo } from '../packages/dat-parser/src/file-types/LandblockInfo.js';
import { TextureManager } from '../packages/renderer/src/models/TextureManager.js';
import { MaterialFactory } from '../packages/renderer/src/models/MaterialFactory.js';
import { ModelRenderer } from '../packages/renderer/src/models/ModelRenderer.js';
import { SetupModelRenderer } from '../packages/renderer/src/models/SetupModelRenderer.js';
import { EnvCellRenderer } from '../packages/renderer/src/world/EnvCellRenderer.js';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.js';
import { populateDungeonCollision } from '../packages/renderer/src/world/DungeonCollisionBuild.js';
import { RemotePhysicsObject, type RemotePhysicsEnv } from '../packages/renderer/src/world/RemotePhysics.js';
import { objectLandingZ } from '../packages/renderer/src/world/outdoorGround.js';
import { storageWcidOf } from '../packages/renderer/src/world/ServerObjectManager.js';

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const worldPath = arg('--world', 'dat/world.sqlite');
const portalPath = arg('--portal', 'dat/client_portal.dat');
const cellPath = arg('--cell', 'dat/client_cell_1.dat');
const minFall = Number(arg('--min-fall', '0.1'));
const limitLb = Number(arg('--limit-lb', '0'));
const jsonOut = arg('--json', '');

interface Row { guid: number; wcid: number; cell: number; x: number; y: number; z: number; qw: number; qx: number; qy: number; qz: number; state: number; itemType: number; setup: number; name: string }
const db = new Database(worldPath, { readonly: true });
const rows = db.prepare(`
  select l.guid, l.weenie_Class_Id wcid, l.obj_Cell_Id cell, l.origin_X x, l.origin_Y y, l.origin_Z z,
         l.angles_W qw, l.angles_X qx, l.angles_Y qy, l.angles_Z qz,
         p.value state, coalesce(t.value, 0) itemType, coalesce(d.value, 0) setup, coalesce(s.value, '') name
  from landblock_instance l
  join weenie_properties_int p on p.object_Id = l.weenie_Class_Id and p.type = 93
  left join weenie_properties_int t on t.object_Id = l.weenie_Class_Id and t.type = 1
  left join weenie_properties_d_i_d d on d.object_Id = l.weenie_Class_Id and d.type = 1
  left join weenie_properties_string s on s.object_Id = l.weenie_Class_Id and s.type = 1
  where (p.value & 0x400) != 0 and (p.value & 1) = 0 and (coalesce(t.value, 0) & 0x10) = 0
    and (l.obj_Cell_Id & 0xffff) >= 0x100`).all() as Row[];

const portalDb = new DatDatabase(new FileDatBytes(portalPath));
const cellDb = new DatDatabase(new FileDatBytes(cellPath));
const mf = new MaterialFactory(portalDb, new TextureManager(portalDb));
const mr = new ModelRenderer(portalDb, mf);
const sr = new SetupModelRenderer(portalDb, mr);
const lbInfo = (lb: number) => {
  const d = cellDb.getFileData(((lb & 0xffff0000) | 0xfffe) >>> 0);
  return d ? new LandblockInfo(new DatReader(d)) : null;
};

// ForceIntoCell objects never fall (ServerObjectManager.forcedIntoCell): the house storage chest.
const storageWcid = storageWcidOf(portalDb);
const byLb = new Map<number, Row[]>();
for (const r of rows) {
  if (r.wcid === storageWcid) continue;
  const lb = ((r.cell >>> 16) << 16 | 0xffff) >>> 0;
  let list = byLb.get(lb);
  if (!list) byLb.set(lb, list = []);
  list.push(r);
}

type Verdict = 'rest' | 'snap' | 'fall' | 'unknown' | 'no-spheres' | 'no-setup';
const totals = new Map<Verdict, number>();
const byType = new Map<string, number>();
const falls: Array<{ name: string; wcid: number; guid: string; cell: string; z: number; landed: number; drop: number; itemType: number }> = [];
let n = 0;
for (const [lb, list] of byLb) {
  if (limitLb && n++ >= limitLb) break;
  const collision = new DungeonCollision();
  const env = new EnvCellRenderer(portalDb, cellDb, mf, sr, mr);
  try {
    populateDungeonCollision(collision, lb, {
      findInteriorCells: (b) => {
        const info = lbInfo(b);
        const out: number[] = [];
        for (let i = 0; info && i < info.numCells; i++) {
          const id = ((b & 0xffff0000) | (0x100 + i)) >>> 0;
          if (cellDb.hasFile(id)) out.push(id);
        }
        return out;
      },
      getCellCollisionData: (id) => env.getCellCollisionData(id),
      loadEnvCell: (id) => env.loadEnvCell(id),
      loadSetupModel: (id) => sr.loadSetupModel(id),
      loadGfxObj: (id) => mr.loadGfxObj(id),
      loadLandblockInfo: lbInfo,
    });
  } catch { /* judged as unknown below */ }
  const outdoor = new DungeonCollision();
  const physEnv: RemotePhysicsEnv = {
    terrainHeight: () => null,
    landingZ: (cell, x, y, z, spheres) => objectLandingZ({ dungeon: collision, outdoor, terrainHeight: () => null }, cell, x, y, z, spheres),
  };
  const ox = ((lb >>> 24) & 0xff) * 192, oy = ((lb >>> 16) & 0xff) * 192;
  for (const r of list) {
    const setup = r.setup ? sr.loadSetupModel(r.setup) : null;
    let verdict: Verdict;
    if (!setup) verdict = 'no-setup';
    else if (setup.spheres.length === 0) verdict = 'no-spheres';
    else {
      const body = new RemotePhysicsObject({
        position: { cell: r.cell >>> 0, pos: { x: ox + r.x, y: oy + r.y, z: r.z }, orient: { w: r.qw, x: r.qx, y: r.qy, z: r.qz } },
        state: r.state,
      });
      body.enterWorld(() => ({ spheres: setup.spheres, stepDownHeight: setup.stepDownHeight }));
      body.update(1 / 30, null, physEnv, 0);
      if (body.placementPending) verdict = 'unknown';
      else if (body.settling) {
        verdict = 'fall';
        for (let t = 0; t < 20 && !body.contact; t += 1 / 30) body.update(1 / 30, null, physEnv, t);
        const drop = r.z - body.pos.z;
        if (drop >= minFall) {
          falls.push({ name: r.name, wcid: r.wcid, guid: (r.guid >>> 0).toString(16), cell: (r.cell >>> 0).toString(16), z: r.z, landed: +body.pos.z.toFixed(3), drop: +drop.toFixed(3), itemType: r.itemType });
        }
      } else verdict = Math.abs(body.pos.z - r.z) > 1e-6 ? 'snap' : 'rest';
    }
    totals.set(verdict, (totals.get(verdict) ?? 0) + 1);
    if (verdict === 'fall') byType.set(String(r.itemType), (byType.get(String(r.itemType)) ?? 0) + 1);
  }
}

console.log(`instances judged: ${rows.length} in ${byLb.size} landblocks (${portalPath}, ${cellPath})`);
console.log('verdicts:', Object.fromEntries(totals));
console.log('falls by ItemType:', Object.fromEntries([...byType].sort((a, b) => b[1] - a[1])));
falls.sort((a, b) => b.drop - a.drop);
console.log(`falls ≥ ${minFall} m: ${falls.length}`);
const names = new Map<string, number>();
for (const f of falls) names.set(f.name, (names.get(f.name) ?? 0) + 1);
console.log('by name:', [...names].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => `${k} ×${v}`).join(', '));
for (const f of falls.slice(0, 40)) console.log(`  ${f.name} (${f.wcid}) ${f.guid} cell ${f.cell} z ${f.z} → ${f.landed} (drop ${f.drop})`);
if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ totals: Object.fromEntries(totals), falls }, null, 1));
