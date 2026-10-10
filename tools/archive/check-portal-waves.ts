import * as fs from 'fs';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';
import { Wave } from '../../packages/dat-parser/src/file-types/Wave.js';

const portalBuf = fs.readFileSync('dat/client_portal.dat').buffer;
const db = new DatDatabase(portalBuf as ArrayBuffer);

// Portal-related wave IDs
const waves: Record<number, string> = {
  0x0A000246: 'UI_EnterPortal',
  0x0A000245: 'UI_ExitPortal',
  0x0A00009C: 'PortalLoop (ST 0x20000017)',
  0x0A000201: 'PortalLoop (ST 0x2000001B)',
  0x0A0001FF: 'PortalLoop (ST 0x20000027)',
  0x0A000231: 'PortalLoop (ST 0x20000030)',
  0x0A000224: 'PortalLoop (ST 0x2000002D)',
};

for (const [waveId, name] of Object.entries(waves)) {
  const id = parseInt(waveId);
  const data = db.getFileData(id);
  if (!data) { console.log(`${name} (0x${id.toString(16)}): NOT FOUND`); continue; }
  const wave = new Wave(new DatReader(data));
  // Parse header bytes to get format info
  const hdr = new DataView(wave.header.buffer, wave.header.byteOffset, wave.header.byteLength);
  const formatTag = hdr.getUint16(0, true);
  const channels = hdr.getUint16(2, true);
  const sampleRate = hdr.getUint32(4, true);
  const byteRate = hdr.getUint32(8, true);
  const blockAlign = hdr.getUint16(12, true);
  const bitsPerSample = hdr.getUint16(14, true);
  const duration = wave.data.length / byteRate;
  console.log(`${name} (0x${id.toString(16)}): fmt=${formatTag} ${channels}ch ${sampleRate}Hz ${bitsPerSample}bit data=${wave.data.length}bytes (${duration.toFixed(1)}s) isMP3=${wave.isMP3}`);
}
