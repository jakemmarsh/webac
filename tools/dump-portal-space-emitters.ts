// Dump the particle-emitter chain for portal-space static objects (VISUAL.1):
// stab Setup -> defaultScript (0x33 PhysicsScript) -> CreateParticle hooks ->
// ParticleEmitterInfo -> hw sprite GfxObj -> surface flags + texture.
import * as fs from 'fs';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { EnvCell } from '../packages/dat-parser/src/file-types/EnvCell.js';
import { SetupModel } from '../packages/dat-parser/src/file-types/SetupModel.js';
import { PhysicsScript } from '../packages/dat-parser/src/file-types/PhysicsScript.js';
import { ParticleEmitterInfo } from '../packages/dat-parser/src/file-types/ParticleEmitterInfo.js';
import { GfxObj } from '../packages/dat-parser/src/file-types/GfxObj.js';
import { Surface } from '../packages/dat-parser/src/file-types/Surface.js';
import { AnimationHookType, type CreateParticleHookData } from '../packages/dat-parser/src/file-types/AnimationHook.js';

const portalDb = new DatDatabase(new Uint8Array(fs.readFileSync('dat/client_portal.dat')).buffer);
const cellDb = new DatDatabase(new Uint8Array(fs.readFileSync('dat/client_cell_1.dat')).buffer);

// Collect unique stab setups across the 0x526A cells
const setups = new Map<number, number>();
for (let i = 0; i < 300; i++) {
  const id = (0x526a0000 | (0x0100 + i)) >>> 0;
  const data = cellDb.getFileData(id);
  if (!data) break;
  const c = new EnvCell(new DatReader(data));
  for (const s of c.staticObjects) setups.set(s.id, (setups.get(s.id) ?? 0) + 1);
}
console.log('unique stab setups:', [...setups.entries()].map(([k,v]) => `0x${k.toString(16)}x${v}`).join(' '));

for (const [setupId] of [...setups.entries()].sort((a,b) => b[1]-a[1])) {
  const sm = new SetupModel(new DatReader(portalDb.getFileData(setupId)!));
  const scriptId = sm.defaultScript;
  let line = `setup 0x${setupId.toString(16)} script=0x${scriptId.toString(16)}`;
  if (scriptId) {
    const ps = PhysicsScript.read(new DatReader(portalDb.getFileData(scriptId)!));
    for (const step of ps.steps) {
      const hook = step.hook;
      if (hook && hook.hookType === AnimationHookType.CreateParticle) {
        const eid = (hook as CreateParticleHookData).emitterInfoId;
        line += ` emitter=0x${(eid ?? 0).toString(16)}`;
        if (eid) {
          const ei = new ParticleEmitterInfo(new DatReader(portalDb.getFileData(eid)!));
          const hw = ei.hwGfxObjId || ei.gfxObjId;
          line += ` type=${ei.particleType} max=${ei.maxParticles} life=${ei.lifespan} hwGfx=0x${hw.toString(16)}`;
          const g = new GfxObj(new DatReader(portalDb.getFileData(hw)!));
          for (const sid of g.surfaces) {
            const surf = Surface.read(new DatReader(portalDb.getFileData(sid)!));
            line += ` surf=0x${sid.toString(16)}(type=0x${surf.type.toString(16)},lum=${surf.luminosity},tex=0x${surf.origTextureId.toString(16)})`;
          }
        }
      }
    }
  }
  console.log(line);
}
