import * as fs from 'fs';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';
import { GfxObj } from '../../packages/dat-parser/src/file-types/GfxObj.js';
import { Surface } from '../../packages/dat-parser/src/file-types/Surface.js';
import { SurfaceTexture } from '../../packages/dat-parser/src/file-types/SurfaceTexture.js';
import { Texture } from '../../packages/dat-parser/src/file-types/Texture.js';

const portalBuf = fs.readFileSync('dat/client_portal.dat').buffer;
const db = new DatDatabase(portalBuf as ArrayBuffer);

// PhysicsScriptTable 0x34xxxxxx and PhysicsScript 0x33xxxxxx
// The portal setup references defaultScript: 0x3300067A
// Let's scan it for ParticleEmitter (0x32) references

function scanForRefs(data: Uint8Array, label: string) {
  const refs = new Map<number, number[]>();
  // Scan for uint32 values that look like file IDs
  for (let i = 0; i < data.length - 3; i++) {
    const val = (data[i+3] << 24) | (data[i+2] << 16) | (data[i+1] << 8) | data[i]; // LE
    const hi = (val >>> 24) & 0xFF;
    if (hi === 0x32 || hi === 0x33 || hi === 0x34 || hi === 0x01 || hi === 0x06 || hi === 0x05 || hi === 0x08) {
      if (!refs.has(hi)) refs.set(hi, []);
      refs.get(hi)!.push(val);
    }
  }
  for (const [type, ids] of refs) {
    const unique = [...new Set(ids)];
    console.log(`  ${label} type 0x${type.toString(16)}: ${unique.map(id => '0x' + id.toString(16).padStart(8, '0')).join(', ')}`);
  }
  return refs;
}

// Check PhysicsScript 0x3300067A
console.log('=== PhysicsScript 0x3300067A ===');
const psData = db.getFileData(0x3300067a);
if (psData) {
  const psBytes = new Uint8Array(psData);
  console.log('  Size:', psBytes.length);
  scanForRefs(psBytes, 'PS');
}

// Check PhysicsScriptTable referenced by portal weenie
// The setup says defaultScript=0x3300067a but defaultScriptTable might be separate
// Let's also check 0x34 range for scriptTables
console.log('\n=== Scanning PhysicsScript refs for ParticleEmitters ===');
const emitterIds = new Set<number>();
if (psData) {
  const psBytes = new Uint8Array(psData);
  for (let i = 0; i < psBytes.length - 3; i++) {
    const val = (psBytes[i+3] << 24) | (psBytes[i+2] << 16) | (psBytes[i+1] << 8) | psBytes[i];
    if (((val >>> 24) & 0xFF) === 0x32) emitterIds.add(val);
  }
}

// Also check nearby PhysicsScripts
for (let sid = 0x33000670; sid <= 0x33000690; sid++) {
  const dBuf = db.getFileData(sid);
  if (!dBuf) continue;
  const d = new Uint8Array(dBuf);
  for (let i = 0; i < d.length - 3; i++) {
    const val = (d[i+3] << 24) | (d[i+2] << 16) | (d[i+1] << 8) | d[i];
    if (((val >>> 24) & 0xFF) === 0x32) emitterIds.add(val);
  }
  if (d.length > 20) {
    console.log(`  PS 0x${sid.toString(16)}: size=${d.length}`);
    scanForRefs(d, `PS 0x${sid.toString(16)}`);
  }
}

console.log('\nTotal unique ParticleEmitter IDs:', emitterIds.size);

// Check each ParticleEmitter for GfxObj references
for (const eid of emitterIds) {
  const eData = db.getFileData(eid);
  if (!eData) continue;
  const eBytes = new Uint8Array(eData);
  console.log(`\n  ParticleEmitter 0x${eid.toString(16)}: size=${eBytes.length}`);

  // Scan for GfxObj (0x01) refs - these are the particle sprite meshes
  const gfxRefs = new Set<number>();
  for (let i = 0; i < eBytes.length - 3; i++) {
    const val = (eBytes[i+3] << 24) | (eBytes[i+2] << 16) | (eBytes[i+1] << 8) | eBytes[i];
    const hi = (val >>> 24) & 0xFF;
    if (hi === 0x01) gfxRefs.add(val);
  }

  for (const gid of gfxRefs) {
    const gData = db.getFileData(gid);
    if (!gData) continue;
    try {
      const gfx = new GfxObj(new DatReader(gData));
      console.log(`    GfxObj 0x${gid.toString(16)}: surfaces=[${gfx.surfaces.map((s: number) => '0x' + s.toString(16)).join(',')}]`);

      for (const surfId of gfx.surfaces) {
        const surfData = db.getFileData(surfId);
        if (!surfData) continue;
        const surf = Surface.read(new DatReader(surfData));
        console.log(`      Surface 0x${surfId.toString(16)}: type=0x${surf.type.toString(16)} tex=0x${surf.origTextureId.toString(16)} trans=${surf.translucency} lum=${surf.luminosity}`);

        if (surf.origTextureId && (surf.origTextureId >> 24) === 0x05) {
          const stData = db.getFileData(surf.origTextureId);
          if (stData) {
            const st = SurfaceTexture.read(new DatReader(stData));
            for (const texId of st.textures) {
              const texData = db.getFileData(texId);
              if (!texData) continue;
              const tex = Texture.read(new DatReader(texData));
              const rgba = tex.toRGBA();
              let rSum=0, gSum=0, bSum=0, aSum=0;
              const px = rgba.width * rgba.height;
              for (let i=0; i<px; i++) {
                rSum += rgba.data[i*4]; gSum += rgba.data[i*4+1];
                bSum += rgba.data[i*4+2]; aSum += rgba.data[i*4+3];
              }
              console.log(`        Tex 0x${texId.toString(16)}: ${tex.width}x${tex.height} avg=(${Math.round(rSum/px)},${Math.round(gSum/px)},${Math.round(bSum/px)},${Math.round(aSum/px)})`);

              // Write a PPM if it's interesting (non-zero avg)
              if (rSum/px > 5 || gSum/px > 5 || bSum/px > 5) {
                const fname = `/tmp/portal_particle_0x${texId.toString(16)}.ppm`;
                const header = `P6\n${rgba.width} ${rgba.height}\n255\n`;
                const rgb = new Uint8Array(rgba.width * rgba.height * 3);
                for (let i = 0; i < px; i++) {
                  rgb[i*3] = rgba.data[i*4]; rgb[i*3+1] = rgba.data[i*4+1]; rgb[i*3+2] = rgba.data[i*4+2];
                }
                const buf = Buffer.concat([Buffer.from(header, 'ascii'), Buffer.from(rgb)]);
                fs.writeFileSync(fname, buf);
                console.log(`        Written ${fname}`);
              }
            }
          }
        }
      }
    } catch (e) {
      console.log(`    GfxObj 0x${gid.toString(16)}: parse error`);
    }
  }
}
