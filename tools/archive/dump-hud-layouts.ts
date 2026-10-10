/**
 * dump-hud-layouts.ts
 *
 * Loads client_local_English.dat and client_portal.dat, parses MasterProperty,
 * then dumps the full element hierarchy for key in-game HUD layouts.
 *
 * Outputs: layout ID, name, screen size, and for each element recursively:
 *   name, type, position (x,y), size (w,h), z-level, edge anchors,
 *   and for each state: all media references (especially image texture IDs).
 *
 * Usage: npx tsx tools/dump-hud-layouts.ts
 */

import * as fs from 'fs';
import { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';
import {
  parseLayoutDesc,
  parseMasterProperty,
  setMasterPropertyTypes,
  MediaType,
  BasePropertyType,
  IncorporationFlags,
  type ElementDesc,
  type LayoutDescData,
  type MediaDesc,
  type StateDesc,
  type BaseProperty,
  type StringInfo,
} from '../../packages/dat-parser/src/file-types/LayoutDesc.js';

// ── Layout IDs and their known names ─────────────────────────────────────

const HUD_LAYOUTS: Array<{ id: number; name: string }> = [
  { id: 0x21000005, name: 'classic_gameplay (root HUD)' },
  { id: 0x21000014, name: 'classic_vitals (vital bars)' },
  { id: 0x2100000b, name: 'classic_radar (compass)' },
  { id: 0x21000016, name: 'classic_toolbar (bottom bar / panel buttons)' },
  { id: 0x21000015, name: 'classic_indicators (status icons)' },
  { id: 0x21000013, name: 'classic_statusbar' },
];

// ── Helpers ──────────────────────────────────────────────────────────────

function hex(n: number): string {
  return '0x' + (n >>> 0).toString(16).padStart(8, '0');
}

function hexShort(n: number): string {
  return '0x' + (n >>> 0).toString(16);
}

const MediaTypeName: Record<number, string> = {
  [MediaType.Undef]: 'Undef',
  [MediaType.Movie]: 'Movie',
  [MediaType.Alpha]: 'Alpha',
  [MediaType.Animation]: 'Animation',
  [MediaType.Cursor]: 'Cursor',
  [MediaType.Image]: 'Image',
  [MediaType.Jump]: 'Jump',
  [MediaType.Message]: 'Message',
  [MediaType.Pause]: 'Pause',
  [MediaType.Sound]: 'Sound',
  [MediaType.State]: 'State',
  [MediaType.Fade]: 'Fade',
  [MediaType.Stretch]: 'Stretch',
};

const BasePropertyTypeName: Record<number, string> = {
  [BasePropertyType.Invalid]: 'Invalid',
  [BasePropertyType.Bool]: 'Bool',
  [BasePropertyType.Integer]: 'Integer',
  [BasePropertyType.LongInteger]: 'LongInteger',
  [BasePropertyType.Float]: 'Float',
  [BasePropertyType.Vector]: 'Vector',
  [BasePropertyType.Color]: 'Color',
  [BasePropertyType.String]: 'String',
  [BasePropertyType.StringInfo]: 'StringInfo',
  [BasePropertyType.Enum]: 'Enum',
  [BasePropertyType.DataFile]: 'DataFile',
  [BasePropertyType.Waveform]: 'Waveform',
  [BasePropertyType.InstanceID]: 'InstanceID',
  [BasePropertyType.Position]: 'Position',
  [BasePropertyType.TimeStamp]: 'TimeStamp',
  [BasePropertyType.Bitfield32]: 'Bitfield32',
  [BasePropertyType.Bitfield64]: 'Bitfield64',
  [BasePropertyType.Array]: 'Array',
  [BasePropertyType.Struct]: 'Struct',
  [BasePropertyType.StringToken]: 'StringToken',
  [BasePropertyType.PropertyName]: 'PropertyName',
  [BasePropertyType.TriState]: 'TriState',
};

const IncorporationFlagNames: Array<{ flag: number; name: string }> = [
  { flag: IncorporationFlags.PassToChildren, name: 'PassToChildren' },
  { flag: IncorporationFlags.X, name: 'X' },
  { flag: IncorporationFlags.Y, name: 'Y' },
  { flag: IncorporationFlags.Width, name: 'Width' },
  { flag: IncorporationFlags.Height, name: 'Height' },
  { flag: IncorporationFlags.ZLevel, name: 'ZLevel' },
];

function incorporationFlagsStr(flags: number): string {
  const parts: string[] = [];
  for (const { flag, name } of IncorporationFlagNames) {
    if (flags & flag) parts.push(name);
  }
  return parts.length > 0 ? parts.join('|') : 'None';
}

function colorStr(c: number): string {
  const a = (c >>> 24) & 0xff;
  const r = (c >>> 16) & 0xff;
  const g = (c >>> 8) & 0xff;
  const b = c & 0xff;
  return `rgba(${r},${g},${b},${a})`;
}

function formatPropertyValue(prop: BaseProperty): string {
  const typeName = BasePropertyTypeName[prop.propertyType] ?? `Unknown(${prop.propertyType})`;
  let valStr = '';

  switch (prop.propertyType) {
    case BasePropertyType.Bool:
      valStr = `${prop.valueBool}`;
      break;
    case BasePropertyType.Integer:
      valStr = `${prop.valueInt}`;
      break;
    case BasePropertyType.Float:
      valStr = `${prop.valueFloat?.toFixed(4)}`;
      break;
    case BasePropertyType.Enum:
      valStr = `${prop.valueEnum} (${hex(prop.valueEnum!)})`;
      break;
    case BasePropertyType.Color:
      valStr = `${hex(prop.valueColor!)} ${colorStr(prop.valueColor!)}`;
      break;
    case BasePropertyType.DataFile:
      valStr = hex(prop.valueDataFile!);
      break;
    case BasePropertyType.StringInfo:
      if (prop.valueString) {
        const s = prop.valueString;
        valStr = `token=${s.strToken} stringId=${hex(s.stringId)} tableId=${hex(s.tableId)} override=${s.override}`;
      }
      break;
    case BasePropertyType.Vector:
      if (prop.valueVector) {
        const v = prop.valueVector;
        valStr = `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
      }
      break;
    case BasePropertyType.Bitfield32:
      valStr = `${hex(prop.valueBitfield32!)} (${prop.valueBitfield32!.toString(2)})`;
      break;
    case BasePropertyType.Bitfield64:
      valStr = `${prop.valueBitfield64}`;
      break;
    case BasePropertyType.InstanceID:
      valStr = hex(prop.valueInstanceId!);
      break;
    case BasePropertyType.Array:
      if (prop.valueArray) {
        valStr = `[${prop.valueArray.length} items]`;
      }
      break;
    case BasePropertyType.Struct:
      if (prop.valueStruct) {
        valStr = `{${prop.valueStruct.size} fields}`;
      }
      break;
    default:
      valStr = '?';
      break;
  }

  return `${typeName}=${valStr}`;
}

function formatMedia(m: MediaDesc): string {
  const typeName = MediaTypeName[m.type] ?? `Unknown(${m.type})`;
  const parts = [typeName];

  switch (m.type) {
    case MediaType.Image:
      parts.push(`file=${hex(m.file!)} drawMode=${m.drawMode}`);
      break;
    case MediaType.Alpha:
      parts.push(`file=${hex(m.file!)}`);
      break;
    case MediaType.Animation:
      parts.push(`duration=${m.duration} drawMode=${m.drawMode} frames=[${(m.frames || []).map(hex).join(', ')}]`);
      break;
    case MediaType.Cursor:
      parts.push(`file=${hex(m.file!)} hotspot=(${m.xHotspot},${m.yHotspot})`);
      break;
    case MediaType.Sound:
      parts.push(`file=${hex(m.file!)} sType=${m.sType}`);
      break;
    case MediaType.State:
      parts.push(`stateId=${hexShort(m.stateId!)} probability=${m.probability}`);
      break;
    case MediaType.Jump:
      parts.push(`jumpItemIndex=${m.jumpItemIndex} probability=${m.probability}`);
      break;
    case MediaType.Message:
      parts.push(`messageId=${hexShort(m.messageId!)} probability=${m.probability}`);
      break;
    case MediaType.Pause:
      parts.push(`min=${m.minDuration} max=${m.maxDuration}`);
      break;
    case MediaType.Fade:
      parts.push(`startAlpha=${m.startAlpha} endAlpha=${m.endAlpha} duration=${m.duration}`);
      break;
    case MediaType.Movie:
      parts.push(`file="${m.fileName}" stretch=${m.stretchToFullScreen}`);
      break;
  }

  return parts.join(' ');
}

function printState(state: StateDesc, indent: string, label: string): void {
  console.log(`${indent}${label} stateId=${hexShort(state.stateId)} passToChildren=${state.passToChildren} incFlags=${incorporationFlagsStr(state.incorporationFlags)}`);

  // Properties
  if (state.properties.size > 0) {
    for (const [propId, prop] of state.properties) {
      console.log(`${indent}  prop ${hexShort(propId)}: ${formatPropertyValue(prop)}`);
      // If it's an array or struct, dump children
      if (prop.propertyType === BasePropertyType.Array && prop.valueArray) {
        for (let i = 0; i < prop.valueArray.length; i++) {
          console.log(`${indent}    [${i}]: ${formatPropertyValue(prop.valueArray[i])}`);
        }
      }
      if (prop.propertyType === BasePropertyType.Struct && prop.valueStruct) {
        for (const [k, v] of prop.valueStruct) {
          console.log(`${indent}    .${hexShort(k)}: ${formatPropertyValue(v)}`);
        }
      }
    }
  }

  // Media
  if (state.media.length > 0) {
    for (const m of state.media) {
      console.log(`${indent}  media: ${formatMedia(m)}`);
    }
  }
}

function printElement(el: ElementDesc, indent: string = '  '): void {
  console.log(
    `${indent}ELEMENT elementId=${hexShort(el.elementId)} type=${el.type} ` +
    `pos=(${el.x}, ${el.y}) size=(${el.width} x ${el.height}) z=${el.zLevel} ` +
    `edges=(L=${el.leftEdge} T=${el.topEdge} R=${el.rightEdge} B=${el.bottomEdge}) ` +
    `baseElement=${hexShort(el.baseElement)} baseLayout=${hexShort(el.baseLayout)} ` +
    `defaultState=${hexShort(el.defaultState)} uiReadOrder=${el.uiReadOrder}`
  );

  // Print element's own base state (inherited from StateDesc)
  if (el.properties.size > 0 || el.media.length > 0) {
    printState(el as StateDesc, indent + '  ', '[base-state]');
  }

  // Print named states
  if (el.states.size > 0) {
    for (const [stateKey, state] of el.states) {
      printState(state, indent + '  ', `[state ${hexShort(stateKey)}]`);
    }
  }

  // Children
  if (el.children.size > 0) {
    console.log(`${indent}  children (${el.children.size}):`);
    for (const [childKey, child] of el.children) {
      printElement(child, indent + '    ');
    }
  }
}

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

// ── Parse and dump each HUD layout ─────────────────────────────────────

for (const layoutInfo of HUD_LAYOUTS) {
  const { id, name } = layoutInfo;
  console.log('='.repeat(120));
  console.log(`\nLAYOUT ${hex(id)} — ${name}`);
  console.log('='.repeat(120));

  try {
    const reader = langDb.getReader(id);
    const layout = parseLayoutDesc(reader);

    console.log(`  Screen size: ${layout.displayWidth} x ${layout.displayHeight}`);
    console.log(`  Top-level elements: ${layout.elements.size}`);

    // Count total elements recursively
    function countRecursive(elements: Map<number, ElementDesc>): number {
      let count = elements.size;
      for (const el of elements.values()) {
        count += countRecursive(el.children);
      }
      return count;
    }
    console.log(`  Total elements (recursive): ${countRecursive(layout.elements)}`);

    // Collect all texture IDs
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

    const allTextures = collectTextures(layout.elements);
    console.log(`  Unique texture/file refs: ${allTextures.size}`);
    if (allTextures.size > 0) {
      const sorted = Array.from(allTextures).sort((a, b) => a - b);
      console.log(`  Texture IDs: ${sorted.map(hex).join(', ')}`);
    }

    console.log('\n  --- Element Hierarchy ---\n');

    for (const [key, el] of layout.elements) {
      printElement(el, '  ');
      console.log('');
    }

  } catch (err: any) {
    console.log(`  ERROR: ${err.message}`);
    if (err.stack) {
      console.log(`  ${err.stack.split('\n').slice(1, 4).join('\n  ')}`);
    }
  }
}

console.log('\n' + '='.repeat(120));
console.log('Done.');
