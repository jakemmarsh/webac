import * as fs from 'fs';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';
import { Texture } from '../../packages/dat-parser/src/file-types/Texture.js';
import { SurfaceTexture } from '../../packages/dat-parser/src/file-types/SurfaceTexture.js';
import { Surface } from '../../packages/dat-parser/src/file-types/Surface.js';

const portalBuf = fs.readFileSync('dat/client_portal.dat').buffer;
const db = new DatDatabase(portalBuf as ArrayBuffer);

// Check the 4 portal space textures from EnvCell surfaces
const stIds = [0x05002737, 0x05002738, 0x05002739, 0x0500273A];
for (const stId of stIds) {
  const stData = db.getFileData(stId);
  if (!stData) { console.log('ST 0x' + stId.toString(16) + ': NOT FOUND'); continue; }
  const st = SurfaceTexture.read(new DatReader(stData));
  console.log('SurfaceTexture 0x' + stId.toString(16) + ': textures=[' + st.textures.map((t: number) => '0x' + t.toString(16)).join(', ') + ']');

  for (const texId of st.textures) {
    const texData = db.getFileData(texId);
    if (!texData) continue;
    const tex = Texture.read(new DatReader(texData));
    const rgba = tex.toRGBA();
    // Sample pixels from various positions
    const positions = [0, 1, 2, 3, Math.floor(rgba.width/2), rgba.width * Math.floor(rgba.height/2), rgba.width * rgba.height - 1];
    const samples = positions.map(i => {
      const o = i * 4;
      return `[${i}]=(${rgba.data[o]},${rgba.data[o+1]},${rgba.data[o+2]},${rgba.data[o+3]})`;
    });
    console.log('  Tex 0x' + texId.toString(16) + ': ' + tex.width + 'x' + tex.height + ' fmt=0x' + tex.format.toString(16) + ' pal=' + (tex.defaultPaletteId ? '0x' + tex.defaultPaletteId.toString(16) : 'none'));
    console.log('    ' + samples.join(' '));
  }
}

// Surface properties
console.log('\n--- Surface Properties ---');
const surfIds = [0x080003F9, 0x080003FA, 0x080003FB, 0x080003FC, 0x08000034];
for (const surfId of surfIds) {
  const data = db.getFileData(surfId);
  if (!data) { console.log('Surface 0x' + surfId.toString(16) + ': NOT FOUND'); continue; }
  const surf = Surface.read(new DatReader(data));
  console.log('Surface 0x' + surfId.toString(16) + ': type=0x' + surf.type.toString(16) + ' tex=0x' + surf.origTextureId.toString(16) + ' pal=0x' + surf.origPaletteId.toString(16) + ' trans=' + surf.translucency + ' lum=' + surf.luminosity + ' diff=' + surf.diffuse + ' color=0x' + surf.colorValue.toString(16));
}

// Write one of the textures as a PPM to check visually
console.log('\n--- Writing portal_tex_0.ppm for visual inspection ---');
const stData = db.getFileData(0x05002739);
if (stData) {
  const st = SurfaceTexture.read(new DatReader(stData));
  const texId = st.textures[st.textures.length - 1]; // highest res
  const texData = db.getFileData(texId);
  if (texData) {
    const tex = Texture.read(new DatReader(texData));
    const rgba = tex.toRGBA();
    // Write PPM (P6 format)
    const header = `P6\n${rgba.width} ${rgba.height}\n255\n`;
    const rgb = new Uint8Array(rgba.width * rgba.height * 3);
    for (let i = 0; i < rgba.width * rgba.height; i++) {
      rgb[i * 3] = rgba.data[i * 4];
      rgb[i * 3 + 1] = rgba.data[i * 4 + 1];
      rgb[i * 3 + 2] = rgba.data[i * 4 + 2];
    }
    const buf = Buffer.concat([Buffer.from(header, 'ascii'), Buffer.from(rgb)]);
    fs.writeFileSync('/tmp/portal_tex_0.ppm', buf);
    console.log('Written /tmp/portal_tex_0.ppm (' + rgba.width + 'x' + rgba.height + ')');
  }
}
