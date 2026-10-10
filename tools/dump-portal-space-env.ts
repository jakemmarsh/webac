import * as fs from 'fs';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { EnvCell } from '../packages/dat-parser/src/file-types/EnvCell.js';
import { Surface } from '../packages/dat-parser/src/file-types/Surface.js';
import { SurfaceTexture } from '../packages/dat-parser/src/file-types/SurfaceTexture.js';
import { Texture } from '../packages/dat-parser/src/file-types/Texture.js';

const cellBuf = fs.readFileSync('dat/client_cell_1.dat').buffer;
const cellDb = new DatDatabase(cellBuf as ArrayBuffer);

const portalBuf = fs.readFileSync('dat/client_portal.dat').buffer;
const portalDb = new DatDatabase(portalBuf as ArrayBuffer);

// Portal space is in landblock 0x526A
// EnvCell IDs: 0x526A0100 through 0x526A01FF
const lb = 0x526A;

// Try a few cell IDs
for (let cellIdx = 0x0100; cellIdx <= 0x01FF; cellIdx++) {
  const cellId = ((lb << 16) | cellIdx) >>> 0;
  const data = cellDb.getFileData(cellId);
  if (!data) continue;

  try {
    const cell = new EnvCell(new DatReader(data));
    console.log(`\n=== EnvCell 0x${cellId.toString(16).padStart(8, '0')} ===`);
    console.log(`  Environment: 0x${cell.environmentId.toString(16).padStart(8, '0')}`);
    console.log(`  CellStructure: ${cell.cellStructure}`);
    console.log(`  Surfaces (${cell.surfaces.length}): ${cell.surfaces.map(s => '0x' + s.toString(16).padStart(8, '0')).join(', ')}`);
    console.log(`  StaticObjects: ${cell.staticObjects.length}`);
    console.log(`  Portals: ${cell.cellPortals.length}`);

    // Load each surface and find textures
    for (const surfId of cell.surfaces) {
      const surfData = portalDb.getFileData(surfId);
      if (!surfData) { console.log(`    Surface 0x${surfId.toString(16)}: NOT FOUND`); continue; }
      const surf = Surface.read(new DatReader(surfData));
      console.log(`    Surface 0x${surfId.toString(16)}: tex=0x${surf.origTextureId.toString(16)}, pal=0x${surf.origPaletteId.toString(16)}, translucency=${surf.translucency}, luminosity=${surf.luminosity}, type=0x${surf.type.toString(16)}`);

      // Load the SurfaceTexture to see the actual texture files
      if (surf.origTextureId && (surf.origTextureId >> 24) === 0x05) {
        const stData = portalDb.getFileData(surf.origTextureId);
        if (stData) {
          const st = SurfaceTexture.read(new DatReader(stData));
          for (const texId of st.textures) {
            const texData = portalDb.getFileData(texId);
            if (texData) {
              const tex = Texture.read(new DatReader(texData));
              console.log(`      Tex 0x${texId.toString(16)}: ${tex.width}x${tex.height} fmt=0x${tex.format.toString(16)} jpeg=${tex.isJPEG}`);
              // Show first few pixel values
              const rgba = tex.toRGBA();
              let nonZero = 0;
              for (let i = 0; i < rgba.data.length; i++) { if (rgba.data[i] !== 0) nonZero++; }
              console.log(`        RGBA: ${rgba.width}x${rgba.height}, nonZero=${nonZero}/${rgba.data.length}`);
            }
          }
        }
      }
    }
  } catch (e) {
    // skip malformed cells
  }

  // Just show a few cells, not all
  if (cellIdx > 0x0105) break;
}
