// A/B of our line of fire against ACE: ServerObjectManager.lineOfFire over a dungeon's real collision (as main.ts builds
// it), with and without CylSphere/Sphere-only statics (8725a9c9), against the harness's ALL=1 grid output (ACE's placed
// caster/target feet per shot). Run from the repo root:
//   ALL=1 STEP=1 tools/ace-physics-harness/run.sh grid 01D2 02000001 1.25 54 76 -120 -100 7 > /tmp/grid.txt
//   npx tsx tools/ace-physics-harness/lof-ab.ts /tmp/grid.txt 01D2 02000001 1.25      # SHOW=20 lists disagreements, ONLYDIFF=1 old/new splits
// Prints {n, agreeNew, agreeOld, falseRefNew, falseClrNew, …, spawnRefNew, spawnFalseNew}. Added 2026-10-17 (Mountain Keep).
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { ItemType } from '@ac/shared';
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';
import { SetupModel } from '../../packages/dat-parser/src/file-types/SetupModel.js';
import { LandblockInfo } from '../../packages/dat-parser/src/file-types/LandblockInfo.js';
import { EnvCellRenderer } from '../../packages/renderer/src/world/EnvCellRenderer.js';
import { SetupModelRenderer } from '../../packages/renderer/src/models/SetupModelRenderer.js';
import { ModelRenderer } from '../../packages/renderer/src/models/ModelRenderer.js';
import { MaterialFactory } from '../../packages/renderer/src/models/MaterialFactory.js';
import { TextureManager } from '../../packages/renderer/src/models/TextureManager.js';
import { DungeonCollision } from '../../packages/renderer/src/world/DungeonCollision.js';
import { populateDungeonCollision } from '../../packages/renderer/src/world/DungeonCollisionBuild.js';
import { ServerObjectManager } from '../../packages/renderer/src/world/ServerObjectManager.js';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../../packages/dat-parser/src/node/FileDatBytes.js';
const openDat = (p: string) => new DatDatabase(new FileDatBytes(p));
const [file, lbHex, setupHex, scaleS] = process.argv.slice(2);
const LB = parseInt(lbHex, 16) << 16 | 0xffff;
const BX = ((LB >>> 24) & 0xff) * 192, BY = ((LB >>> 16) & 0xff) * 192;
const portal = openDat('dat/client_portal.dat'), cell = openDat('dat/client_cell_1.dat'); // from the repo root
const mf = new MaterialFactory(portal, new TextureManager(portal));
const mr = new ModelRenderer(portal, mf);
const sr = new SetupModelRenderer(portal, mr);
const env = new EnvCellRenderer(portal, cell, mf, sr, mr);
const lbInfo = (lb: number) => { const d = cell.getFileData(((lb & 0xffff0000) | 0xfffe) >>> 0); return d ? new LandblockInfo(new DatReader(d)) : null; };
const build = (withShapes: boolean) => {
  const dc = new DungeonCollision();
  populateDungeonCollision(dc, LB >>> 0, {
    findInteriorCells: (lb) => { const info = lbInfo(lb)!; const out: number[] = []; for (let i = 0; i < info.numCells; i++) { const id = ((lb & 0xffff0000) | (0x100 + i)) >>> 0; if (cell.hasFile(id)) out.push(id); } return out; },
    getCellCollisionData: (id) => env.getCellCollisionData(id),
    loadEnvCell: (id) => env.loadEnvCell(id),
    loadSetupModel: (id) => { const s = sr.loadSetupModel(id); return s && !withShapes ? { ...s, cylSpheres: [], spheres: [] } : s; },
    loadGfxObj: (id) => mr.loadGfxObj(id),
    loadLandblockInfo: lbInfo,
  });
  return dc;
};
const setup = (id: number) => new SetupModel(new DatReader(portal.getFileData(id)!));
const tsetup = setup(parseInt(setupHex, 16)), human = setup(0x02000001);
const scale = +scaleS;
const mk = (dc: DungeonCollision) => {
  const som = new ServerObjectManager({ loadSetupModel: (id: number) => (id === parseInt(setupHex, 16) ? tsetup : null) } as never, {} as never, new THREE.Scene());
  som.missileEnvironmentSweep = (from, to, r) => {
    const h = dc.sweepSphere({ x: from.x, y: from.z, z: from.y }, { x: to.x, y: to.z, z: to.y }, r);
    return h ? { t: h.t, normal: { x: h.normal.x, y: h.normal.z, z: h.normal.y } } : null;
  };
  som.missileObjectSweep = () => null;
  return som;
};
const A = mk(build(true)), B = mk(build(false));
let me = { x: 0, y: 0, z: 0 };
for (const s of [A, B]) s.missileLocalPlayer = () => ({ x: BX + me.x, y: BY + me.y, z: me.z, radius: human.radius, height: human.height, physicsRadius: human.spheres[0].radius });
const mesh = new THREE.Group(); mesh.scale.setScalar(scale);
const T = 0x80000001;
const stats = { n: 0, agreeNew: 0, agreeOld: 0, falseRefNew: 0, falseClrNew: 0, falseRefOld: 0, falseClrOld: 0, spawnRefNew: 0, spawnFalseNew: 0 };
const out: string[] = [];
for (const line of readFileSync(file, 'utf8').split('\n')) {
  const m = /^(HIT|MISS) .*cp=\(([-\d.]+),([-\d.]+),([-\d.]+),\w+\) tp=\(([-\d.]+),([-\d.]+),([-\d.]+),\w+\)/.exec(line);
  if (!m) continue;
  const ace = m[1]; const [cx, cy, cz, tx, ty, tz] = m.slice(2).map(Number);
  me = { x: cx, y: cy, z: cz };
  const r: any[] = [];
  for (const s of [A, B]) {
    (s as any).objects.set(T, { guid: T, name: 'Dread', itemType: ItemType.Creature, physicsState: 0, mesh, setupId: parseInt(setupHex, 16), worldX: BX + tx, worldZ: BY + ty, worldY: tz, collisionRadius: tsetup.radius * scale, collisionHeight: tsetup.height * scale });
    r.push(s.lineOfFire(T));
  }
  stats.n++;
  const hitNew = r[0].blockedAt === null, hitOld = r[1].blockedAt === null, aceHit = ace === 'HIT';
  if (hitNew === aceHit) stats.agreeNew++; else if (aceHit) stats.falseRefNew++; else stats.falseClrNew++;
  if (hitOld === aceHit) stats.agreeOld++; else if (aceHit) stats.falseRefOld++; else stats.falseClrOld++;
  if (!hitNew && r[0].beforeSpawn) { stats.spawnRefNew++; if (aceHit) stats.spawnFalseNew++; }
  if (process.env.ONLYDIFF ? hitNew !== hitOld : (hitNew !== hitOld || hitNew !== aceHit)) out.push(`${ace} new=${hitNew ? 'clear' : 'blk@' + r[0].blockedAt + (r[0].beforeSpawn ? 'S' : '')} old=${hitOld ? 'clear' : 'blk@' + r[1].blockedAt} c=(${cx},${cy},${cz}) t=(${tx},${ty},${tz})`);
}
console.log(JSON.stringify(stats));
if (process.env.SHOW) for (const l of out.slice(0, +process.env.SHOW)) console.log(l);
