import fs from 'fs';
import { DatDatabase, DatReader, parseStringTable } from '../packages/dat-parser/src/index.ts';

async function openDat(path) {
  const buf = fs.readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const db = new DatDatabase(ab, 0);
  await db.readHeader();
  await db.readDirectory();
  return db;
}

const ui = await openDat('dat/client_local_English.dat');
const query = process.argv.slice(2).join(' ');
if (!query) {
  console.log('Usage: search-strings.mjs <text-to-find>');
  process.exit(1);
}
const needle = query.toLowerCase();

const tableIds = ui.listFileIds(0x23);
console.log(`Searching ${tableIds.length} StringTables for "${query}"`);

let hits = 0;
for (const tid of tableIds) {
  const data = ui.getFileData(tid);
  if (!data) continue;
  try {
    const table = parseStringTable(new DatReader(data));
    for (const entry of table.entries) {
      for (const s of entry.strings) {
        if (s.toLowerCase().includes(needle)) {
          console.log(`  table 0x${tid.toString(16)} id=${entry.id} (0x${entry.id.toString(16)}): "${s.substring(0, 120)}"`);
          hits++;
          if (hits > 30) {
            console.log('(truncated)');
            process.exit(0);
          }
        }
      }
    }
  } catch (e) {}
}
console.log(`${hits} hits.`);
