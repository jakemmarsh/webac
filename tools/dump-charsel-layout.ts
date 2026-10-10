import * as fs from 'fs';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import {
  parseLayoutDesc,
  parseMasterProperty,
  setMasterPropertyTypes,
  MediaType,
  type ElementDesc,
  type StateDesc,
  type MediaDesc,
  type BaseProperty,
  BasePropertyType,
} from '../packages/dat-parser/src/file-types/LayoutDesc.js';

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

// Dump specific layouts in detail
const LAYOUTS = [0x21000001, 0x21000002, 0x21000004, 0x21000037];

function printElement(el: ElementDesc, indent: string = '  '): void {
  console.log(
    `${indent}ELEMENT id=${hex(el.elementId)} type=${el.type} ` +
    `pos=(${el.x}, ${el.y}) size=(${el.width} x ${el.height}) z=${el.zLevel} ` +
    `edges=(L=${el.leftEdge} T=${el.topEdge} R=${el.rightEdge} B=${el.bottomEdge}) ` +
    `baseElement=${hex(el.baseElement)} baseLayout=${hex(el.baseLayout)} ` +
    `defaultState=${hex(el.defaultState)}`
  );

  // Media in base state
  for (const m of el.media) {
    if (m.type === MediaType.Image) {
      console.log(`${indent}  [base] Image file=${hex(m.file!)} drawMode=${m.drawMode}`);
    } else if (m.type === MediaType.Animation) {
      console.log(`${indent}  [base] Animation frames=[${(m.frames || []).map(hex).join(', ')}]`);
    } else if (m.type === MediaType.Stretch) {
      console.log(`${indent}  [base] Stretch file=${hex(m.file!)}`);
    }
  }

  // Properties
  for (const [propId, prop] of el.properties) {
    if (prop.propertyType === BasePropertyType.StringInfo && prop.valueString) {
      const s = prop.valueString;
      console.log(`${indent}  [prop ${hex(propId)}] StringInfo: token=${s.strToken} tableId=${hex(s.tableId)} override="${s.override}"`);
    } else if (prop.propertyType === BasePropertyType.DataFile) {
      console.log(`${indent}  [prop ${hex(propId)}] DataFile: ${hex(prop.valueDataFile!)}`);
    } else if (prop.propertyType === BasePropertyType.Color) {
      console.log(`${indent}  [prop ${hex(propId)}] Color: ${hex(prop.valueColor!)}`);
    }
  }

  // Named states
  for (const [stateKey, state] of el.states) {
    for (const m of state.media) {
      if (m.type === MediaType.Image) {
        console.log(`${indent}  [state ${hex(stateKey)}] Image file=${hex(m.file!)} drawMode=${m.drawMode}`);
      } else if (m.type === MediaType.Animation) {
        console.log(`${indent}  [state ${hex(stateKey)}] Animation frames=[${(m.frames || []).map(hex).join(', ')}]`);
      }
    }
    for (const [propId, prop] of state.properties) {
      if (prop.propertyType === BasePropertyType.StringInfo && prop.valueString) {
        const s = prop.valueString;
        console.log(`${indent}  [state ${hex(stateKey)} prop ${hex(propId)}] StringInfo: token=${s.strToken} tableId=${hex(s.tableId)} override="${s.override}"`);
      }
    }
  }

  // Children
  for (const [childKey, child] of el.children) {
    printElement(child, indent + '  ');
  }
}

for (const layoutId of LAYOUTS) {
  console.log('\n' + '='.repeat(100));
  console.log(`LAYOUT ${hex(layoutId)}`);
  console.log('='.repeat(100));
  try {
    const reader = langDb.getReader(layoutId);
    const layout = parseLayoutDesc(reader);
    console.log(`Screen: ${layout.displayWidth}x${layout.displayHeight}`);
    for (const [key, el] of layout.elements) {
      printElement(el);
    }
  } catch (e: any) {
    console.log(`ERROR: ${e.message}`);
  }
}
