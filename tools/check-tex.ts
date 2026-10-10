import * as fs from 'fs';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { Texture } from '../packages/dat-parser/src/file-types/Texture.js';

const portalBuf = fs.readFileSync('dat/client_portal.dat').buffer;
const portalDb = new DatDatabase(portalBuf as ArrayBuffer);

for (const texId of [0x06007576, 0x06004d64, 0x06004cc0, 0x06005d3f, 0x0600396b]) {
  const data = portalDb.getFileData(texId);
  if (!data) { console.log(`${texId.toString(16)}: NOT FOUND`); continue; }
  const tex = Texture.read(new DatReader(data));
  console.log(`0x${texId.toString(16).padStart(8,'0')}: ${tex.width}x${tex.height} format=0x${tex.format.toString(16)} isJPEG=${tex.isJPEG} palette=${tex.defaultPaletteId?.toString(16) ?? 'none'}`);
  if (texId === 0x0600396b) {
    const rgba = tex.toRGBA();
    console.log(`  RGBA: ${rgba.width}x${rgba.height}, bytes=${rgba.data.length}`);
    for (let i = 0; i < Math.min(16, rgba.data.length / 4); i++) {
      const o = i * 4;
      console.log(`  px[${i}]: R=${rgba.data[o]} G=${rgba.data[o+1]} B=${rgba.data[o+2]} A=${rgba.data[o+3]}`);
    }
    // Raw pixel bytes
    console.log(`  Raw pixel data length: ${tex.sourceData?.length ?? 'N/A'}`);
    if (tex.sourceData) {
      const hex = Array.from(tex.sourceData.slice(0, 64)).map((b: number) => b.toString(16).padStart(2,'0')).join(' ');
      console.log(`  Raw hex: ${hex}`);
    }
  }
}

// Also check SurfaceTexture 0x0500264C
import { SurfaceTexture } from '../packages/dat-parser/src/file-types/SurfaceTexture.js';
const stData = portalDb.getFileData(0x0500264c);
if (stData) {
  const st = SurfaceTexture.read(new DatReader(stData));
  console.log(`\nSurfaceTexture 0x0500264C: textures=[${st.textures.map((t: number) => '0x' + t.toString(16)).join(', ')}]`);
} else {
  console.log('\nSurfaceTexture 0x0500264C: NOT FOUND');
}
