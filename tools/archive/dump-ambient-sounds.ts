/**
 * Quick dump of RegionDesc ambient sound data to verify what's available.
 * Usage: npx tsx tools/dump-ambient-sounds.ts
 */
import * as fs from 'fs';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';
import { RegionDesc } from '../../packages/dat-parser/src/file-types/RegionDesc.js';
import { SoundTable } from '../../packages/dat-parser/src/file-types/SoundTable.js';

const buf = fs.readFileSync('dat/client_portal.dat').buffer;
const db = new DatDatabase(buf as ArrayBuffer);

const regionData = db.getFileData(0x13000000);
if (!regionData) {
  console.log('No RegionDesc found');
  process.exit(1);
}

const rd = new RegionDesc(new DatReader(regionData));
console.log(`Region: "${rd.regionName}"`);
console.log(`partsMask: 0x${rd.partsMask.toString(16)}`);
console.log(`soundInfo present: ${rd.soundInfo !== null}`);

if (rd.soundInfo) {
  console.log(`\nSound STB descriptors: ${rd.soundInfo.stbDesc.length}`);
  for (const stb of rd.soundInfo.stbDesc) {
    console.log(`\n  STB ID: 0x${stb.stbId.toString(16).padStart(8, '0')}`);
    console.log(`  Ambient sounds: ${stb.ambientSounds.length}`);

    // Load the SoundTable to resolve sounds
    const stbData = db.getFileData(stb.stbId);
    let soundTable: SoundTable | null = null;
    if (stbData) {
      soundTable = SoundTable.read(new DatReader(stbData));
      console.log(`  SoundTable entries: ${soundTable.data.size}`);
    }

    for (const amb of stb.ambientSounds) {
      const continuous = amb.baseChance === 0;
      console.log(`    Sound 0x${amb.sType.toString(16)} (${amb.sType}): vol=${amb.volume.toFixed(2)} baseChance=${amb.baseChance.toFixed(3)} minRate=${amb.minRate.toFixed(1)} maxRate=${amb.maxRate.toFixed(1)} [${continuous ? 'CONTINUOUS' : 'PROBABILISTIC'}]`);

      // Try to resolve through SoundTable
      if (soundTable) {
        const resolved = soundTable.resolveSound(amb.sType);
        if (resolved) {
          console.log(`      → Wave 0x${resolved.waveId.toString(16).padStart(8, '0')} vol=${resolved.volume.toFixed(2)}`);
        } else {
          console.log(`      → NOT FOUND in SoundTable`);
        }
      }
    }
  }
} else {
  console.log('No soundInfo in RegionDesc');
}
