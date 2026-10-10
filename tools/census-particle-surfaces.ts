/**
 * census-particle-surfaces.ts — the Surfaces every 0x32 emitter's HW GfxObj
 * draws with: type bits (Additive 0x10000, Luminous 0x40, Translucent 0x10,
 * Alpha 0x100, ClipMap 0x4) and the luminosity / diffuse floats.
 *
 * Retail draws particles through the ordinary lit part path
 * (CPhysicsPart::Draw @ 0050d7a0 → D3DPolyRender::RenderMeshSubset @ 0059ca10:
 * D3DRS_LIGHTING on, emissive = surface luminosity; SetSurface @ 0059c4d0:
 * fog on unless Additive). This census says how many particle surfaces that
 * lighting and fog actually touch (VISUAL.particle-surfaces-unlit, 2026-09-28).
 *
 *   npx tsx tools/census-particle-surfaces.ts
 */
import * as fs from 'fs';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { GfxObj } from '../packages/dat-parser/src/file-types/GfxObj.js';
import { Surface, SurfaceType } from '../packages/dat-parser/src/file-types/Surface.js';
import { ParticleEmitterInfo } from '../packages/dat-parser/src/file-types/ParticleEmitterInfo.js';

const portal = new DatDatabase(new Uint8Array(fs.readFileSync('dat/client_portal.dat')).buffer);
const hex = (n: number) => '0x' + (n >>> 0).toString(16).padStart(8, '0');

const byClass = new Map<string, { emitters: number; surfaces: Set<number>; lum: Set<number>; examples: string[] }>();
let emitters = 0;
for (const id of portal.listFileIds(0x32)) {
  const d = portal.getFileData(id);
  if (!d) continue;
  const info = new ParticleEmitterInfo(new DatReader(d));
  const g = info.hwGfxObjId ? portal.getFileData(info.hwGfxObjId) : null;
  if (!g) continue;
  emitters++;
  const gfx = new GfxObj(new DatReader(g));
  for (const sid of new Set(gfx.surfaces)) {
    const sd = portal.getFileData(sid);
    if (!sd) continue;
    const s = Surface.read(new DatReader(sd));
    const additive = (s.type & SurfaceType.Additive) !== 0;
    const luminous = (s.type & SurfaceType.Luminous) !== 0;
    const alpha = (s.type & (SurfaceType.Alpha | SurfaceType.InvAlpha)) !== 0;
    const trans = (s.type & SurfaceType.Translucent) !== 0;
    const k = `${additive ? 'Additive' : 'non-additive'} ${luminous ? 'Luminous' : 'not-luminous'}${alpha ? ' Alpha' : ''}${trans ? ' Translucent' : ''} lum>0:${s.luminosity > 0}`;
    const e = byClass.get(k) ?? { emitters: 0, surfaces: new Set(), lum: new Set(), examples: [] };
    e.emitters++;
    e.surfaces.add(sid);
    e.lum.add(Math.round(s.luminosity * 100) / 100);
    if (e.examples.length < 4) e.examples.push(`${hex(id)}→${hex(info.hwGfxObjId)}→${hex(sid)} type=${hex(s.type)} lum=${s.luminosity} diff=${s.diffuse}`);
    byClass.set(k, e);
  }
}
console.log(`${emitters} emitters with a HW GfxObj`);
for (const [k, e] of [...byClass].sort((a, b) => b[1].emitters - a[1].emitters)) {
  console.log(`\n${k}: ${e.emitters} emitter-surfaces, ${e.surfaces.size} distinct surfaces, luminosity ∈ {${[...e.lum].sort().join(', ')}}`);
  for (const x of e.examples) console.log(`   ${x}`);
}
