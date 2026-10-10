/**
 * Resolve the retail portal-space teleport object + animation.
 *
 * gmSmartBoxUI::PostInit calls DBObj::GetDIDByEnum(0x10000001) to make the
 * teleportObj, and UseTime calls set_sequence_animation(GetDIDByEnum(0x10000002)).
 * GetDIDByEnum -> DBCache::GetDIDFromEnumStatic walks a DidMapper (0x25). The
 * enum keys 0x10000001 (WeenieDefaults) / 0x10000002 (CharacterGenerator) are
 * the DatFileType class ids; the *instance* DID is data-driven. Find which
 * DidMapper(s) carry those keys and print the resolved DID.
 */
import * as fs from 'fs';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { readDidMapper } from '../packages/dat-parser/src/file-types/DidMapper.js';

const portalDb = new DatDatabase(new Uint8Array(fs.readFileSync('dat/client_portal.dat')).buffer);

// Enumerate all DidMapper files (0x25xxxxxx) in the portal DAT.
const mapperIds: number[] = portalDb.listFileIds(0x25).sort((a, b) => a - b);
console.log('DidMapper files:', mapperIds.map((i) => '0x' + i.toString(16)).join(' '));

const TARGET = [0x10000001, 0x10000002];
for (const id of mapperIds) {
  const data = portalDb.getFileData(id);
  if (!data) continue;
  let m;
  try { m = readDidMapper(new DatReader(data)); } catch { continue; }
  for (const key of TARGET) {
    const c = m.client.enumToId.get(key);
    const s = m.server.enumToId.get(key);
    if (c !== undefined || s !== undefined) {
      console.log(
        `mapper 0x${id.toString(16)} key 0x${key.toString(16)}: ` +
        `client=${c !== undefined ? '0x' + c.toString(16) : '-'} ` +
        `server=${s !== undefined ? '0x' + s.toString(16) : '-'}`,
      );
    }
  }
  // Also dump any small mapper fully so we can see the teleport-related names
  if (m.client.enumToId.size < 40 && m.client.enumToId.size > 0) {
    const entries = [...m.client.enumToId.entries()]
      .map(([k, v]) => `0x${k.toString(16)}=0x${v.toString(16)}`).join(' ');
    const names = [...m.client.enumToName.entries()]
      .map(([k, v]) => `0x${k.toString(16)}:${v}`).join(' ');
    console.log(`  mapper 0x${id.toString(16)} client entries: ${entries}`);
    if (names) console.log(`  mapper 0x${id.toString(16)} names: ${names}`);
  }
}
