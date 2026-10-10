import * as fs from 'fs';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';
import {
  parseLayoutDesc,
  parseMasterProperty,
  setMasterPropertyTypes,
  MediaType,
  type ElementDesc,
} from '../../packages/dat-parser/src/file-types/LayoutDesc.js';

function hex(n: number): string {
  return '0x' + (n >>> 0).toString(16).padStart(8, '0');
}

const portalBuf = fs.readFileSync('dat/client_portal.dat').buffer;
const portalDb = new DatDatabase(portalBuf as ArrayBuffer);
const langBuf = fs.readFileSync('dat/client_local_English.dat').buffer;
const langDb = new DatDatabase(langBuf as ArrayBuffer);

const mpReader = portalDb.getReader(0x39000001);
const masterTypes = parseMasterProperty(mpReader);
setMasterPropertyTypes(masterTypes);

// Enumerate all files in language DAT
const layoutIds = langDb.listFileIds(0x21).sort((a: number, b: number) => a - b);

console.log(`Found ${layoutIds.length} layout files:\n`);

function countElements(elements: Map<number, ElementDesc>): number {
  let count = elements.size;
  for (const el of elements.values()) count += countElements(el.children);
  return count;
}

function collectTextures(elements: Map<number, ElementDesc>): Set<number> {
  const textures = new Set<number>();
  function walk(el: ElementDesc) {
    for (const m of el.media) {
      if (m.file !== undefined) textures.add(m.file);
      if (m.frames) for (const f of m.frames) textures.add(f);
    }
    for (const state of el.states.values()) {
      for (const m of state.media) {
        if (m.file !== undefined) textures.add(m.file);
        if (m.frames) for (const f of m.frames) textures.add(f);
      }
    }
    for (const child of el.children.values()) walk(child);
  }
  for (const el of elements.values()) walk(el);
  return textures;
}

for (const id of layoutIds) {
  try {
    const reader = langDb.getReader(id);
    const layout = parseLayoutDesc(reader);
    const textures = collectTextures(layout.elements);
    const sorted = Array.from(textures).sort((a: number, b: number) => a - b);
    console.log(`${hex(id)}: ${layout.displayWidth}x${layout.displayHeight} elements=${countElements(layout.elements)} textures=${sorted.length}`);
    if (sorted.length > 0) {
      console.log(`  textures: ${sorted.map(hex).join(', ')}`);
    }
    console.log();
  } catch(e: any) {
    console.log(`${hex(id)}: PARSE ERROR - ${e.message}\n`);
  }
}
