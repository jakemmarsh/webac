/**
 * dump-layout-descs.ts
 *
 * Loads client_local_English.dat and client_portal.dat, parses MasterProperty,
 * then iterates all LayoutDesc files (0x21xxxxxx), printing their structure
 * to help identify which layouts correspond to character creation screens.
 *
 * Usage: npx tsx tools/dump-layout-descs.ts
 */

import * as fs from 'fs';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import {
  parseLayoutDesc,
  parseMasterProperty,
  setMasterPropertyTypes,
  MediaType,
  type ElementDesc,
  type LayoutDescData,
  type MediaDesc,
  type StateDesc,
} from '../packages/dat-parser/src/file-types/LayoutDesc.js';

// ── Load DAT files ──────────────────────────────────────────────────────

const portalPath = 'dat/client_portal.dat';
const langPath = 'dat/client_local_English.dat';

console.log('Loading portal DAT...');
const portalBuf = fs.readFileSync(portalPath).buffer;
const portalDb = new DatDatabase(portalBuf as ArrayBuffer);
console.log(`  Portal DAT: ${portalDb.fileCount} files`);

console.log('Loading language DAT...');
const langBuf = fs.readFileSync(langPath).buffer;
const langDb = new DatDatabase(langBuf as ArrayBuffer);
console.log(`  Language DAT: ${langDb.fileCount} files`);

// ── Parse MasterProperty ────────────────────────────────────────────────

console.log('\nParsing MasterProperty (0x39000001)...');
const mpReader = portalDb.getReader(0x39000001);
const masterTypes = parseMasterProperty(mpReader);
setMasterPropertyTypes(masterTypes);
console.log(`  ${masterTypes.size} property types loaded\n`);

// ── Helpers ─────────────────────────────────────────────────────────────

function hex(n: number): string {
  return '0x' + (n >>> 0).toString(16).padStart(8, '0');
}

function hexShort(n: number): string {
  return '0x' + (n >>> 0).toString(16);
}

/** Collect all image texture IDs from media items */
function collectImageTextures(media: MediaDesc[]): number[] {
  const textures: number[] = [];
  for (const m of media) {
    if (m.type === MediaType.Image && m.file !== undefined) {
      textures.push(m.file);
    }
  }
  return textures;
}

/** Collect all media texture/file IDs from media items (any type with a file ref) */
function collectAllMediaFiles(media: MediaDesc[]): Array<{ type: MediaType; file: number }> {
  const refs: Array<{ type: MediaType; file: number }> = [];
  for (const m of media) {
    if (m.file !== undefined) {
      refs.push({ type: m.type, file: m.file });
    }
    if (m.frames) {
      for (const f of m.frames) {
        refs.push({ type: m.type, file: f });
      }
    }
  }
  return refs;
}

/** Count total elements recursively including children */
function countElementsRecursive(elements: Map<number, ElementDesc>): number {
  let count = elements.size;
  for (const el of elements.values()) {
    count += countElementsRecursive(el.children);
  }
  return count;
}

/** Collect all unique texture IDs from an element tree */
function collectAllTextures(elements: Map<number, ElementDesc>): Set<number> {
  const textures = new Set<number>();

  function walkElement(el: ElementDesc) {
    // From element's own media (inherited from StateDesc base)
    for (const tex of collectImageTextures(el.media)) {
      textures.add(tex);
    }
    // From element's states
    for (const state of el.states.values()) {
      for (const tex of collectImageTextures(state.media)) {
        textures.add(tex);
      }
    }
    // Recurse into children
    for (const child of el.children.values()) {
      walkElement(child);
    }
  }

  for (const el of elements.values()) {
    walkElement(el);
  }
  return textures;
}

/** Print an element and its children with indentation */
function printElement(el: ElementDesc, indent: string = '    ') {
  const imageTextures = collectImageTextures(el.media);
  const stateImageTextures: number[] = [];
  for (const state of el.states.values()) {
    stateImageTextures.push(...collectImageTextures(state.media));
  }
  const allTextures = [...imageTextures, ...stateImageTextures];

  const textureStr = allTextures.length > 0
    ? ` textures=[${allTextures.map(hex).join(', ')}]`
    : '';

  const mediaCount = el.media.length;
  let totalStateMedia = 0;
  for (const state of el.states.values()) {
    totalStateMedia += state.media.length;
  }

  console.log(
    `${indent}Element id=${hexShort(el.elementId)} type=${el.type} ` +
    `pos=(${el.x},${el.y}) size=(${el.width}x${el.height}) ` +
    `media=${mediaCount} stateMedia=${totalStateMedia} states=${el.states.size} children=${el.children.size}` +
    textureStr
  );

  // Print children
  for (const [_key, child] of el.children) {
    printElement(child, indent + '  ');
  }
}

// ── Parse and dump all LayoutDesc files ─────────────────────────────────

// Get all 0x21xxxxxx files from language DAT
const layoutIds = langDb.listFileIds(0x21).sort((a, b) => a - b);
console.log(`Found ${layoutIds.length} LayoutDesc files\n`);
console.log('='.repeat(100));

const layoutSummaries: Array<{
  id: number;
  width: number;
  height: number;
  totalElements: number;
  uniqueTextures: number;
  textureIds: Set<number>;
}> = [];

for (const fileId of layoutIds) {
  try {
    const reader = langDb.getReader(fileId);
    const layout = parseLayoutDesc(reader);

    const totalElements = countElementsRecursive(layout.elements);
    const allTextures = collectAllTextures(layout.elements);

    layoutSummaries.push({
      id: fileId,
      width: layout.displayWidth,
      height: layout.displayHeight,
      totalElements,
      uniqueTextures: allTextures.size,
      textureIds: allTextures,
    });

    console.log(`\nLayout ${hex(fileId)} — ${layout.displayWidth}x${layout.displayHeight} — ` +
      `${layout.elements.size} top-level elements, ${totalElements} total (recursive), ` +
      `${allTextures.size} unique textures`);

    // Print top-level elements
    for (const [_key, el] of layout.elements) {
      printElement(el);
    }

    // Print all unique textures for this layout
    if (allTextures.size > 0) {
      console.log(`  All textures: ${Array.from(allTextures).map(hex).join(', ')}`);
    }

  } catch (err: any) {
    console.log(`\nLayout ${hex(fileId)} — ERROR: ${err.message}`);
  }
}

// ── Summary table ───────────────────────────────────────────────────────

console.log('\n' + '='.repeat(100));
console.log('\nSUMMARY TABLE');
console.log('-'.repeat(100));
console.log(
  'File ID'.padEnd(14) +
  'Size'.padEnd(12) +
  'Top Elems'.padEnd(12) +
  'Total Elems'.padEnd(14) +
  'Textures'.padEnd(10)
);
console.log('-'.repeat(100));

for (const s of layoutSummaries) {
  console.log(
    hex(s.id).padEnd(14) +
    `${s.width}x${s.height}`.padEnd(12) +
    `${s.totalElements}`.padEnd(12) +
    `${s.totalElements}`.padEnd(14) +
    `${s.uniqueTextures}`.padEnd(10)
  );
}

// ── Identify likely chargen candidates ──────────────────────────────────

console.log('\n' + '='.repeat(100));
console.log('\nANALYSIS: Likely Character Creation Layouts');
console.log('(Sorted by total element count, descending — chargen screens tend to be complex)\n');

const sorted = [...layoutSummaries].sort((a, b) => b.totalElements - a.totalElements);
for (const s of sorted.slice(0, 20)) {
  console.log(
    `  ${hex(s.id)} — ${s.width}x${s.height}, ${s.totalElements} elements, ${s.uniqueTextures} textures`
  );
}

console.log('\nDone.');
