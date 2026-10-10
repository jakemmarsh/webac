import * as fs from 'fs';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';

const portalBuf = fs.readFileSync('dat/client_portal.dat').buffer;
const db = new DatDatabase(portalBuf as ArrayBuffer);

// Dump hex of PhysicsScript 0x3300067A
const psData = db.getFileData(0x3300067a);
if (!psData) { console.log('NOT FOUND'); process.exit(1); }
console.log('PhysicsScript 0x3300067A (' + psData.byteLength + ' bytes):');
const r = new DatReader(psData);
const id = r.readUInt32();
console.log('  ID: 0x' + id.toString(16));

// PhysicsScript contains a list of PhysicsScriptData entries
// Each has: startTime(double), hook(AnimationHook)
// AnimationHook: hookType, direction
// Various hook types include CreateParticle (type 8) which has emitterId
const hookCount = r.readUInt32();
console.log('  Hook count:', hookCount);

for (let i = 0; i < hookCount && r.position < psData.byteLength - 8; i++) {
  const startTime = r.readFloat64();
  const hookType = r.readUInt32();
  const direction = r.readUInt32();
  console.log(`  Hook ${i}: time=${startTime.toFixed(3)} type=${hookType} dir=${direction}`);

  // Read hook data based on type
  // Type 0 = NoOp, 1 = Sound, 2 = SoundTable, 3 = AnimDone
  // Type 4 = ReplaceObject, 5 = Ethereal, 6 = TransparentPart
  // Type 7 = Luminous, 8 = CreateParticle, 9 = DestroyParticle
  // Type 10 = StopParticle, 11 = NoDraw, 12 = DefaultScript
  // Type 13 = CallPES (PlayEffectScript)
  if (hookType === 8) { // CreateParticle
    const partIndex = r.readUInt32();
    const emitterInfoId = r.readUInt32(); // GfxObjId for emitter info
    const emitterId = r.readUInt32(); // ParticleEmitter ID (0x32)
    console.log(`    CreateParticle: partIdx=${partIndex} emitterInfo=0x${emitterInfoId.toString(16)} emitter=0x${emitterId.toString(16)}`);
  } else if (hookType === 9 || hookType === 10) { // DestroyParticle/StopParticle
    const emitterId = r.readUInt32();
    console.log(`    ${hookType === 9 ? 'Destroy' : 'Stop'}Particle: emitter=0x${emitterId.toString(16)}`);
  } else if (hookType === 13) { // CallPES
    const pesId = r.readUInt32();
    console.log(`    CallPES: 0x${pesId.toString(16)}`);
  } else if (hookType === 6) { // TransparentPart
    const partIdx = r.readUInt32();
    const start = r.readFloat32();
    const end = r.readFloat32();
    const duration = r.readFloat32();
    console.log(`    TransparentPart: part=${partIdx} ${start}->${end} dur=${duration}`);
  } else if (hookType === 7) { // Luminous
    const start = r.readFloat32();
    const end = r.readFloat32();
    const duration = r.readFloat32();
    console.log(`    Luminous: ${start}->${end} dur=${duration}`);
  } else if (hookType === 1) { // Sound
    const soundId = r.readUInt32();
    console.log(`    Sound: 0x${soundId.toString(16)}`);
  } else {
    console.log(`    (unknown hook type ${hookType})`);
  }
}