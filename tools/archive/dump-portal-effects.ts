import * as fs from 'fs';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';
import { SetupModel } from '../../packages/dat-parser/src/file-types/SetupModel.js';
import { GfxObj } from '../../packages/dat-parser/src/file-types/GfxObj.js';
import { Surface } from '../../packages/dat-parser/src/file-types/Surface.js';
import { SurfaceTexture } from '../../packages/dat-parser/src/file-types/SurfaceTexture.js';
import { Texture } from '../../packages/dat-parser/src/file-types/Texture.js';

const portalBuf = fs.readFileSync('dat/client_portal.dat').buffer;
const db = new DatDatabase(portalBuf as ArrayBuffer);

// Portal Setup 0x020001B3 - find all GfxObj parts and their textures
const setupData = db.getFileData(0x020001B3);
if (!setupData) { console.log('Setup NOT FOUND'); process.exit(1); }
const setup = new SetupModel(new DatReader(setupData));

console.log('Portal Setup 0x020001B3:');
console.log('  Parts:', setup.parts.length, setup.parts.map(p => '0x' + p.toString(16)));
console.log('  PhysicsScriptTable:', setup.defaultScriptTable ? '0x' + setup.defaultScriptTable.toString(16) : 'none');

// Check each GfxObj part for its surfaces/textures
for (const partId of setup.parts) {
  const gfxData = db.getFileData(partId);
  if (!gfxData) { console.log('  GfxObj 0x' + partId.toString(16) + ': NOT FOUND'); continue; }
  const gfx = new GfxObj(new DatReader(gfxData));
  console.log('\n  GfxObj 0x' + partId.toString(16) + ':');
  console.log('    Surfaces:', gfx.surfaces.length, gfx.surfaces.map((s: number) => '0x' + s.toString(16)));
  console.log('    Vertices:', gfx.vertexArray?.vertices.size ?? 0);

  for (const surfId of gfx.surfaces) {
    const surfData = db.getFileData(surfId);
    if (!surfData) continue;
    const surf = Surface.read(new DatReader(surfData));
    console.log('    Surface 0x' + surfId.toString(16) + ': type=0x' + surf.type.toString(16) + ' tex=0x' + surf.origTextureId.toString(16) + ' pal=0x' + surf.origPaletteId.toString(16) + ' trans=' + surf.translucency + ' lum=' + surf.luminosity + ' diff=' + surf.diffuse + ' color=0x' + surf.colorValue.toString(16));

    // Load the texture
    if (surf.origTextureId && (surf.origTextureId >> 24) === 0x05) {
      const stData = db.getFileData(surf.origTextureId);
      if (stData) {
        const st = SurfaceTexture.read(new DatReader(stData));
        for (const texId of st.textures) {
          const texData = db.getFileData(texId);
          if (texData) {
            const tex = Texture.read(new DatReader(texData));
            const rgba = tex.toRGBA();
            // Average color
            let rSum=0, gSum=0, bSum=0, aSum=0;
            const px = rgba.width * rgba.height;
            for (let i=0; i<px; i++) {
              rSum += rgba.data[i*4];
              gSum += rgba.data[i*4+1];
              bSum += rgba.data[i*4+2];
              aSum += rgba.data[i*4+3];
            }
            console.log(`      Tex 0x${texId.toString(16)}: ${tex.width}x${tex.height} fmt=0x${tex.format.toString(16)} avg=(${Math.round(rSum/px)},${Math.round(gSum/px)},${Math.round(bSum/px)},${Math.round(aSum/px)})`);
          }
        }
      }
    }
  }
}

// Also check some portal-variant setups (blue, green, orange portals)
console.log('\n\n=== Other portal variant setups ===');
const variants = [0x020005D2, 0x020005D3, 0x020005D4]; // Blue, Green, Orange
for (const sid of variants) {
  const sData = db.getFileData(sid);
  if (!sData) { console.log('Setup 0x' + sid.toString(16) + ': NOT FOUND'); continue; }
  const s = new SetupModel(new DatReader(sData));
  console.log('Setup 0x' + sid.toString(16) + ': parts=' + s.parts.map((p: number) => '0x' + p.toString(16)).join(','));
}

// Check PhysicsScriptTable for particle emitter references
console.log('\n\n=== PhysicsScriptTable 0x3300067A ===');
const pstData = db.getFileData(0x3300067a);
if (pstData) {
  console.log('  Data size:', pstData.byteLength, 'bytes');
  // Scan for any 0x32 (ParticleEmitter) or 0x06 (Texture) references
  const view = new DataView(pstData);
  for (let i = 0; i < pstData.byteLength - 4; i += 4) {
    const val = view.getUint32(i, true);
    const hi = (val >> 24) & 0xFF;
    if (hi === 0x32 || hi === 0x33 || hi === 0x34) {
      console.log(`  offset ${i}: 0x${val.toString(16).padStart(8,'0')} (type 0x${hi.toString(16)})`);
    }
  }
} else {
  console.log('  NOT FOUND');
}

// Check PhysicsScript 0x3300067A referenced scripts
console.log('\n\n=== Scanning for ParticleEmitter textures ===');
// Particle Emitters (0x32) reference GfxObj IDs for the particle sprites
// Let's find particle emitters referenced by the portal's physics scripts
const pstView = pstData ? new DataView(pstData) : null;
if (pstView) {
  const emitterIds = new Set<number>();
  for (let i = 0; i < pstData!.byteLength - 4; i += 4) {
    const val = pstView.getUint32(i, true);
    if (((val >> 24) & 0xFF) === 0x32) {
      emitterIds.add(val);
    }
  }
  console.log('Found', emitterIds.size, 'potential ParticleEmitter refs');
  for (const eid of emitterIds) {
    const eData = db.getFileData(eid);
    if (!eData) continue;
    console.log('  Emitter 0x' + eid.toString(16) + ': size=' + eData.byteLength);
    // Scan for GfxObj/Texture refs inside emitter
    const ev = new DataView(eData);
    for (let i = 0; i < eData.byteLength - 4; i += 4) {
      const val = ev.getUint32(i, true);
      const hi = (val >> 24) & 0xFF;
      if (hi === 0x01 || hi === 0x06 || hi === 0x05) {
        console.log(`    offset ${i}: 0x${val.toString(16).padStart(8,'0')} (type 0x${hi.toString(16)})`);
      }
    }
  }
}
