import fs from 'fs';
import { DatDatabase, DatReader, parseMasterProperty } from '../../packages/dat-parser/src/index.ts';

const buf = fs.readFileSync('dat/client_portal.dat');
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const db = new DatDatabase(ab, 0);
await db.readHeader();
await db.readDirectory();

const mpData = db.getFileData(0x39000001);
const types = parseMasterProperty(new DatReader(mpData));

const typeNames = ['Invalid','Bool','Integer','LongInteger','Float','Vector','Color','String','StringInfo','Enum','DataFile','Waveform','InstanceID','Position','TimeStamp','Bitfield32','Bitfield64','Array','Struct','StringToken','PropertyName','TriState'];

const ids = process.argv.slice(2).map(s => parseInt(s, 10));
for (const id of ids.length ? ids : [114, 88, 87, 46, 18, 23]) {
  const t = types.get(id);
  console.log(`p${id}: type=${t} (${typeNames[t] ?? '?'})`);
}
