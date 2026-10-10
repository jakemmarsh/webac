import * as fs from 'fs';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';
import { SetupModel } from '../../packages/dat-parser/src/file-types/SetupModel.js';
import { SoundTable } from '../../packages/dat-parser/src/file-types/SoundTable.js';
import { Wave } from '../../packages/dat-parser/src/file-types/Wave.js';

const portalBuf = fs.readFileSync('dat/client_portal.dat').buffer;
const db = new DatDatabase(portalBuf as ArrayBuffer);

// Portal Setup model 0x020001B3
const setupData = db.getFileData(0x020001B3);
if (!setupData) { console.log('Setup NOT FOUND'); process.exit(1); }
const setup = new SetupModel(new DatReader(setupData));
console.log('Portal Setup 0x020001B3:');
console.log('  defaultSoundTable:', setup.defaultSoundTable ? '0x' + setup.defaultSoundTable.toString(16) : 'none');
console.log('  defaultAnimation:', setup.defaultAnimation ? '0x' + setup.defaultAnimation.toString(16) : 'none');
console.log('  defaultScript:', setup.defaultScript ? '0x' + setup.defaultScript.toString(16) : 'none');
console.log('  defaultMotionTable:', setup.defaultMotionTable ? '0x' + setup.defaultMotionTable.toString(16) : 'none');
console.log('  defaultScriptTable:', setup.defaultScriptTable ? '0x' + setup.defaultScriptTable.toString(16) : 'none');

if (setup.defaultSoundTable) {
  const stData = db.getFileData(setup.defaultSoundTable);
  if (stData) {
    const st = SoundTable.read(new DatReader(stData));
    console.log('\nSoundTable 0x' + setup.defaultSoundTable.toString(16) + ':');
    console.log('  Entries:', st.data.size);
    for (const [key, val] of st.data) {
      const waves = val.data.map(d => `0x${d.soundId.toString(16)}(vol=${d.volume.toFixed(2)})`).join(', ');
      console.log(`  [0x${key.toString(16)}]: ${waves}`);
    }

    // Check for portal loop sound
    for (const se of [0x47, 0x48, 0x49, 0x01]) {
      const resolved = st.resolveSound(se);
      if (resolved) {
        console.log(`\n  Sound 0x${se.toString(16)}: wave=0x${resolved.waveId.toString(16)} vol=${resolved.volume}`);
        const waveData = db.getFileData(resolved.waveId);
        if (waveData) {
          const wave = new Wave(new DatReader(waveData));
          const hdr = new DataView(wave.header.buffer, wave.header.byteOffset, wave.header.byteLength);
          const channels = hdr.getUint16(2, true);
          const sampleRate = hdr.getUint32(4, true);
          const byteRate = hdr.getUint32(8, true);
          const bitsPerSample = hdr.getUint16(14, true);
          const duration = wave.data.length / byteRate;
          console.log(`    ${channels}ch ${sampleRate}Hz ${bitsPerSample}bit ${wave.data.length}bytes (${duration.toFixed(1)}s) isMP3=${wave.isMP3}`);
        }
      }
    }
  }
}
