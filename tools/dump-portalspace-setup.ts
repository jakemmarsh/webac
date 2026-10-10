/**
 * Inspect the REAL retail portal-space object:
 *   mapper 0x25000010: portalspace_background=0x02000306, portalspace_animation=0x030005ac
 * Dump the Setup's parts, their GfxObj surfaces/textures (avg color), and the
 * Animation's frame count, so the rebuild spec is anchored to real DAT assets.
 */
import * as fs from 'fs';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { SetupModel } from '../packages/dat-parser/src/file-types/SetupModel.js';
import { GfxObj } from '../packages/dat-parser/src/file-types/GfxObj.js';
import { Surface, SurfaceType } from '../packages/dat-parser/src/file-types/Surface.js';

const portalDb = new DatDatabase(new Uint8Array(fs.readFileSync('dat/client_portal.dat')).buffer);

const SETUP = 0x02000306;
const ANIM = 0x030005ac;

function avgColor(texId: number): string {
  try {
    const t = portalDb.getFileData(texId);
    if (!t) return 'no-tex';
    // crude: just report it exists; full decode handled elsewhere
    return `tex 0x${texId.toString(16)} (${t.byteLength}B)`;
  } catch { return 'err'; }
}

console.log('=== Setup 0x02000306 (portalspace_background) ===');
const sd = portalDb.getFileData(SETUP);
if (!sd) { console.log('SETUP NOT FOUND'); }
else {
  const setup = new SetupModel(new DatReader(sd));
  console.log('parts:', setup.parts.map((p) => '0x' + p.toString(16)).join(' '));
  console.log('flags: 0x' + (setup.flags ?? 0).toString(16),
    'defaultAnim=0x' + (setup.defaultAnimation ?? 0).toString(16),
    'defaultScript=0x' + (setup.defaultScript ?? 0).toString(16),
    'defaultMotionTable=0x' + (setup.defaultMotionTable ?? 0).toString(16));
  for (const partId of setup.parts) {
    const gd = portalDb.getFileData(partId);
    if (!gd) { console.log(`  part 0x${partId.toString(16)}: NOT FOUND`); continue; }
    const gfx = new GfxObj(new DatReader(gd));
    const surfLines: string[] = [];
    for (const surfId of gfx.surfaces) {
      const surfData = portalDb.getFileData(surfId);
      if (!surfData) { surfLines.push(`0x${surfId.toString(16)}:?`); continue; }
      const surf = Surface.read(new DatReader(surfData));
      const flags: string[] = [];
      if ((surf.type & SurfaceType.Additive) !== 0) flags.push('ADD');
      surfLines.push(
        `surf 0x${surfId.toString(16)} type=0x${surf.type.toString(16)}` +
        ` lum=${(surf as any).luminosity ?? '?'} trans=${(surf as any).translucency ?? '?'}` +
        ` tex=0x${(surf.origTextureId ?? 0).toString(16)}${flags.length ? ' [' + flags.join(',') + ']' : ''}`,
      );
    }
    const vcount = gfx.vertexArray ? gfx.vertexArray.vertices.size : 0;
    console.log(`  part 0x${partId.toString(16)}: verts=${vcount} surfaces=[${surfLines.join(' | ')}]`);
  }
}

console.log('\n=== Animation 0x030005ac (portalspace_animation) ===');
const ad = portalDb.getFileData(ANIM);
if (!ad) { console.log('ANIM NOT FOUND'); }
else {
  const r = new DatReader(ad);
  const id = r.readUInt32();
  const flags = r.readUInt32();
  console.log('anim id=0x' + id.toString(16), 'flags=0x' + flags.toString(16),
    'rawBytes=' + ad.byteLength);
  // numParts + numFrames sit just after flags in CAnim
  const numParts = r.readUInt32();
  const numFrames = r.readUInt32();
  console.log('numParts=' + numParts, 'numFrames=' + numFrames,
    '(retail caps at frame 0x78=120 per UseTime get_curr_frame_number check)');
}
