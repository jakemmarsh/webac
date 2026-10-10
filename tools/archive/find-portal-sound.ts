import * as fs from 'fs';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';
import { SoundTable } from '../../packages/dat-parser/src/file-types/SoundTable.js';
import { Wave } from '../../packages/dat-parser/src/file-types/Wave.js';

const portalBuf = fs.readFileSync('dat/client_portal.dat').buffer;
const db = new DatDatabase(portalBuf as ArrayBuffer);

// Sound enum values from ACE.Entity/Enum/Sound.cs
const SOUND_ENUMS: Record<number, string> = {
  0x6A: 'UI_EnterPortal',
  0x6B: 'UI_ExitPortal',
  0x01: 'Cyclic', // ambient looping
  0x00: 'Invalid',
  0x69: 'UI_NewTarget',
  0x47: 'PortalEnter',  // Not UI_ prefix version
  0x48: 'PortalExit',
  0x49: 'PortalLoop',   // Portal ambient loop?
};

// UI SoundTable = 0x2000004B
console.log('=== UI SoundTable 0x2000004B ===');
const uiStData = db.getFileData(0x2000004B);
if (uiStData) {
  const uiSt = SoundTable.read(new DatReader(uiStData));
  console.log('  Total entries:', uiSt.data.size);
  // Dump ALL entries to find portal sounds
  for (const [key, val] of uiSt.data) {
    const name = SOUND_ENUMS[key] || `0x${key.toString(16)}`;
    const waves = val.data.map(d => `0x${d.soundId.toString(16)}(vol=${d.volume},prob=${d.probability})`).join(', ');
    if (key >= 0x45 && key <= 0x75) { // range around portal sounds
      console.log(`  [${name}] key=0x${key.toString(16)}: ${waves}`);
    }
  }

  // Specifically check portal sounds
  for (const se of [0x47, 0x48, 0x49, 0x6A, 0x6B]) {
    const resolved = uiSt.resolveSound(se);
    console.log(`  Resolve 0x${se.toString(16)} (${SOUND_ENUMS[se] || '?'}): ${resolved ? '0x' + resolved.waveId.toString(16) + ' vol=' + resolved.volume : 'null'}`);
  }
}

// Also check some other SoundTables that might have portal sounds
// Portal weenie SoundTable IDs - check several
const stIds = [0x20000001, 0x20000002, 0x20000003, 0x20000004, 0x20000005,
               0x20000014, 0x20000032, 0x2000004B, 0x2000004C, 0x2000004D];

console.log('\n=== Scanning SoundTables for portal-related entries ===');
for (const stId of stIds) {
  const data = db.getFileData(stId);
  if (!data) continue;
  const st = SoundTable.read(new DatReader(data));
  // Check for portal-related keys
  for (const key of [0x47, 0x48, 0x49, 0x6A, 0x6B, 0x01]) {
    const resolved = st.resolveSound(key);
    if (resolved) {
      console.log(`  ST 0x${stId.toString(16)} key=0x${key.toString(16)} (${SOUND_ENUMS[key] || '?'}): wave=0x${resolved.waveId.toString(16)} vol=${resolved.volume}`);
    }
  }
}

// Brute force: scan a wider range of SoundTables
console.log('\n=== Scanning wider SoundTable range ===');
for (let id = 0x20000001; id <= 0x200000FF; id++) {
  const data = db.getFileData(id);
  if (!data) continue;
  try {
    const st = SoundTable.read(new DatReader(data));
    for (const key of [0x47, 0x48, 0x49]) {
      const resolved = st.resolveSound(key);
      if (resolved) {
        console.log(`  ST 0x${id.toString(16)} key=0x${key.toString(16)} (${SOUND_ENUMS[key] || '?'}): wave=0x${resolved.waveId.toString(16)} vol=${resolved.volume}`);
        // Get wave info
        const waveData = db.getFileData(resolved.waveId);
        if (waveData) {
          const wave = new Wave(new DatReader(waveData));
          const hdr = wave.header;
          const channels = hdr.length >= 4 ? (hdr[2] | (hdr[3] << 8)) : 0;
          const sampleRate = hdr.length >= 8 ? (hdr[4] | (hdr[5] << 8) | (hdr[6] << 16) | (hdr[7] << 24)) : 0;
          const bitsPerSample = hdr.length >= 16 ? (hdr[14] | (hdr[15] << 8)) : 0;
          console.log(`    Wave: channels=${channels} sampleRate=${sampleRate} bitsPerSample=${bitsPerSample} dataSize=${wave.data.length} isMP3=${wave.isMP3}`);
        }
      }
    }
  } catch { /* skip malformed */ }
}

// Check the portal space landblock ambient sound
// The portal space weenie (14609) might have a SoundTableDID property
console.log('\n=== Checking ambient/looping sounds in portal-related SoundTables ===');
for (let id = 0x20000001; id <= 0x200000FF; id++) {
  const data = db.getFileData(id);
  if (!data) continue;
  try {
    const st = SoundTable.read(new DatReader(data));
    // key 0x01 = Cyclic (looping ambient), key 0x80 = Loop1
    for (const key of [0x01, 0x80, 0x81]) {
      const resolved = st.resolveSound(key);
      if (resolved && resolved.waveId) {
        const waveData = db.getFileData(resolved.waveId);
        if (waveData) {
          const wave = new Wave(new DatReader(waveData));
          if (wave.data.length > 50000) { // only substantial sounds
            const wHdr = wave.header;
            const wCh = wHdr.length >= 4 ? (wHdr[2] | (wHdr[3] << 8)) : 0;
            const wSr = wHdr.length >= 8 ? (wHdr[4] | (wHdr[5] << 8) | (wHdr[6] << 16) | (wHdr[7] << 24)) : 0;
            console.log(`  ST 0x${id.toString(16)} key=0x${key.toString(16)}: wave=0x${resolved.waveId.toString(16)} vol=${resolved.volume} (${wCh}ch ${wSr}Hz ${wave.data.length} bytes)`);
          }
        }
      }
    }
  } catch { /* skip */ }
}
