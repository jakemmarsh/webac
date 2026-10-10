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
const targets = process.argv.slice(2).map(s => parseInt(s, 10));

// Iterate StringTables in 0x23xxxxxx range and search for the string IDs
const tableIds = ui.listFileIds(0x23);
console.log(`Searching ${tableIds.length} StringTables for string IDs: ${targets.join(', ')}`);

const found = new Map();
for (const tid of tableIds) {
  const data = ui.getFileData(tid);
  if (!data) continue;
  try {
    const table = parseStringTable(new DatReader(data));
    for (const entry of table.entries) {
      if (targets.includes(entry.id) && entry.strings.length > 0) {
        found.set(entry.id, { tableId: tid, strings: entry.strings });
      }
    }
  } catch (e) {}
}
for (const id of targets) {
  const hit = found.get(id);
  if (hit) {
    console.log(`${id} (0x${id.toString(16)}) — table 0x${hit.tableId.toString(16)}:`);
    for (const s of hit.strings) console.log(`  "${s.substring(0, 80)}"`);
  } else {
    console.log(`${id} — NOT FOUND`);
  }
}
