import fs from 'fs';
import { DatDatabase, DatReader, parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes } from '../packages/dat-parser/src/index.ts';

async function openDat(path) {
  const buf = fs.readFileSync(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const db = new DatDatabase(ab, 0);
  await db.readHeader();
  await db.readDirectory();
  return db;
}

const portal = await openDat('dat/client_portal.dat');
const ui = await openDat('dat/client_local_English.dat');

const mpData = portal.getFileData(0x39000001);
if (mpData) {
  const types = parseMasterProperty(new DatReader(mpData));
  setMasterPropertyTypes(types);
}

const ids = process.argv.slice(2).map(s => parseInt(s, 16));
const layouts = ids.length ? ids : [0x2100002e, 0x2100001a];
const full = process.argv.includes('--full');
const filterElemId = process.argv.find(a => a.startsWith('--elem='));
const targetElem = filterElemId ? parseInt(filterElemId.split('=')[1], 16) : null;

function mediaSummary(state) {
  if (!state?.media || state.media.length === 0) return '';
  return state.media.map(m => {
    // Indexed by @ac/dat-parser MediaType (ACE MediaType.cs). The old table
    // here was misaligned (Image printed as "Msg", Pause as "Snd", State as
    // "Movie"), which hid the selection-flash Pause→State chain.
    const tag = ['Undef','Movie','Alpha','Ani','Cursor','Img','Jump','Msg','Pause','Snd','State','Fade','Stretch'][m.type] ?? `t${m.type}`;
    if (m.file != null) return `${tag}(0x${m.file.toString(16)})`;
    if (m.fileName) return `${tag}(${m.fileName})`;
    if (m.frames) return `${tag}(frames=${m.frames.map(f => '0x'+f.toString(16)).join(',')})`;
    const rest = Object.entries(m).filter(([k]) => k !== 'type').map(([k, v]) => `${k}=${typeof v === 'number' && v > 0xffff ? '0x' + v.toString(16) : JSON.stringify(v)}`);
    return rest.length ? `${tag}(${rest.join(' ')})` : tag;
  }).join(',');
}

function propSummary(state, verbose=false) {
  if (!state?.properties || state.properties.size === 0) return '';
  const bits = [];
  for (const [pid, p] of state.properties) {
    let val = '?';
    if (p.valueString) val = `str#${p.valueString.stringId}`;
    else if (p.valueDataFile != null) val = `file=0x${p.valueDataFile.toString(16)}`;
    else if (p.valueInt != null) val = `int=${p.valueInt}`;
    else if (p.valueEnum != null) val = `enum=${p.valueEnum}`;
    else if (p.valueColor != null) val = `color=0x${p.valueColor.toString(16)}`;
    else if (p.valueFloat != null) val = `f=${p.valueFloat}`;
    else if (p.valueBool != null) val = `b=${p.valueBool}`;
    else if (p.valueArray) val = `arr[${p.valueArray.length}]`;
    else if (p.valueStruct) {
      if (verbose) {
        const structBits = [];
        for (const [sk, sv] of p.valueStruct) {
          let sval = '?';
          if (sv.valueInt != null) sval = 'i'+sv.valueInt;
          else if (sv.valueDataFile != null) sval = 'f0x'+sv.valueDataFile.toString(16);
          else if (sv.valueFloat != null) sval = 'fl'+sv.valueFloat;
          else if (sv.valueBool != null) sval = 'b'+sv.valueBool;
          else if (sv.valueColor != null) sval = 'c0x'+sv.valueColor.toString(16);
          else if (sv.valueArray) sval = `ar[${sv.valueArray.length}]`;
          else if (sv.valueStruct) sval = `st[${sv.valueStruct.size}]`;
          else if (sv.valueString) sval = `s#${sv.valueString.stringId}`;
          structBits.push(`${sk}=${sval}`);
        }
        val = `{${structBits.join(',')}}`;
      } else {
        val = `struct[${p.valueStruct.size}]`;
      }
    }
    bits.push(`p${pid}=${val}`);
  }
  return bits.join(' ');
}

for (const lid of layouts) {
  console.log(`\n=== LayoutDesc 0x${lid.toString(16)} ===`);
  const data = ui.getFileData(lid);
  if (!data) { console.log('not found'); continue; }
  try {
    const layout = parseLayoutDesc(new DatReader(data));
    console.log('displayWH=' + layout.displayWidth + 'x' + layout.displayHeight + ', elements=' + layout.elements.size);
    const dump = (eid, el, depth=0) => {
      const pad = '  '.repeat(depth);
      const m = mediaSummary(el);
      const p = propSummary(el, full || (targetElem !== null && eid === targetElem));
      console.log(`${pad}- elem=0x${(eid>>>0).toString(16)} type=${el.type} xy=(${el.x},${el.y}) wh=${el.width}x${el.height} defSt=${el.defaultState}${el.baseElement ? ` base=0x${(el.baseLayout>>>0).toString(16)}:0x${(el.baseElement>>>0).toString(16)}` : ''} media=[${m}] props=[${p}]`);
      for (const [sid, st] of el.states) {
        const sm = mediaSummary(st);
        const sp = propSummary(st, full || (targetElem !== null && eid === targetElem));
        if (sm || sp) console.log(`${pad}    state${sid}: media=[${sm}] props=[${sp}]`);
      }
      for (const [ckey, c] of el.children) dump(ckey, c, depth+1);
    };
    for (const [ek, e] of layout.elements) dump(ek, e);
  } catch(e) {
    console.log('parse error:', e.message);
  }
}
