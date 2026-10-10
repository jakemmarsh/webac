import * as fs from 'fs';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';
import { GfxObj } from '../../packages/dat-parser/src/file-types/GfxObj.js';
import { Surface } from '../../packages/dat-parser/src/file-types/Surface.js';
import { Texture } from '../../packages/dat-parser/src/file-types/Texture.js';
import { SetupModel } from '../../packages/dat-parser/src/file-types/SetupModel.js';
import { SurfaceTexture } from '../../packages/dat-parser/src/file-types/SurfaceTexture.js';

const portalBuf = fs.readFileSync('dat/client_portal.dat').buffer;
const db = new DatDatabase(portalBuf as ArrayBuffer);

// Load purple portal setup model 0x020001B3
const setupData = db.getFileData(0x020001B3);
if (!setupData) { console.log('Setup not found'); process.exit(1); }
const setup = new SetupModel(new DatReader(setupData));
console.log(`Setup 0x020001B3: ${setup.parts.length} parts`);
console.log('Parts:', setup.parts.map((p: number) => '0x' + p.toString(16)));

// Load each part GfxObj
for (const partId of setup.parts) {
  const gfxData = db.getFileData(partId);
  if (!gfxData) { console.log(`  GfxObj 0x${partId.toString(16)}: NOT FOUND`); continue; }
  const gfx = new GfxObj(new DatReader(gfxData));
  console.log(`  GfxObj 0x${partId.toString(16)}: ${gfx.surfaces.length} surfaces, ${gfx.vertexArray?.vertices.size ?? 0} verts`);

  for (const surfId of gfx.surfaces) {
    const surfData = db.getFileData(surfId);
    if (!surfData) { console.log(`    Surface 0x${surfId.toString(16)}: NOT FOUND`); continue; }
    const surf = Surface.read(new DatReader(surfData));
    console.log(`    Surface 0x${surfId.toString(16)}: texture=0x${surf.origTextureId.toString(16)}, palette=0x${surf.origPaletteId.toString(16)}, translucency=${surf.translucency}`);

    // Load SurfaceTexture to get actual Texture IDs
    if (surf.origTextureId && (surf.origTextureId >> 24) === 0x05) {
      const stData = db.getFileData(surf.origTextureId);
      if (stData) {
        const st = SurfaceTexture.read(new DatReader(stData));
        console.log(`      SurfaceTex 0x${surf.origTextureId.toString(16)}: ${st.textures?.length ?? 0} textures`);
        if (st.textures) {
          for (const texId of st.textures) {
            const texData = db.getFileData(texId);
            if (texData) {
              const tex = Texture.read(new DatReader(texData));
              console.log(`        Tex 0x${texId.toString(16)}: ${tex.width}x${tex.height} format=0x${tex.format.toString(16)}`);
            }
          }
        }
      }
    }
  }
}

// Also check blue and shadow portal variants
console.log('\n--- Blue portal 0x020005D2 ---');
const blueData = db.getFileData(0x020005D2);
if (blueData) {
  const blueSetup = new SetupModel(new DatReader(blueData));
  console.log(`Parts:`, blueSetup.parts.map((p: number) => '0x' + p.toString(16)));
  for (const partId of blueSetup.parts) {
    const gfxData = db.getFileData(partId);
    if (!gfxData) continue;
    const gfx = new GfxObj(new DatReader(gfxData));
    for (const surfId of gfx.surfaces) {
      const surfData = db.getFileData(surfId);
      if (!surfData) continue;
      const surf = Surface.read(new DatReader(surfData));
      console.log(`  Surface 0x${surfId.toString(16)}: texture=0x${surf.origTextureId.toString(16)}, palette=0x${surf.origPaletteId.toString(16)}`);
    }
  }
}
