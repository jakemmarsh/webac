/**
 * scan-layout-sounds.ts — every Sound media item in every LayoutDesc (0x21).
 *
 * Retail's only UI-driven sound path is the layout media machine:
 * `MediaMachine::Update_Sound @ 004658b0` plays an MD_Data_Sound's SoundType
 * from its table (m_file, enum-mapped via 0x22) with
 * `SoundManager::PlaySoundFromCenter`, or its raw wave when the type is 0.
 * Hard-coded client sounds are only UI_EnterPortal / UI_ExitPortal
 * (gmSmartBoxUI::BeginTeleportAnimation / UseTime) and the admin Environs
 * sounds; everything else is a server Sound message or an animation hook.
 * This dump says which UI sounds retail actually plays and where
 * (BUG.duplicate-local-sounds audit, 2026-09-28).
 *
 * The raw scan finds the media where it is AUTHORED (three template
 * elements). `--resolved` resolves every layout's elements through their
 * base chains first (LayoutDesc::InqFullDesc @ 0069a520 →
 * ElementDesc::Incorporate @ 0069b5a0 concatenates base media), so it lists
 * every element that actually CARRIES the media at runtime — the set
 * `audio/LayoutSoundElements.ts` is generated from
 * (BUG.ui-buttonpress-on-every-button, 2026-09-28).
 *
 * Usage: npx tsx tools/scan-layout-sounds.ts [--by-sound] [--resolved] [--ts]
 */
import * as fs from 'fs';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import {
  parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes, resolveLayoutDesc, MediaType,
  type ElementDesc, type MediaDesc, type LayoutDescData,
} from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { Sound } from '../packages/shared/src/enums/Sound.js';

const portalDb = new DatDatabase(fs.readFileSync('dat/client_portal.dat').buffer as ArrayBuffer);
const langDb = new DatDatabase(fs.readFileSync('dat/client_local_English.dat').buffer as ArrayBuffer);
setMasterPropertyTypes(parseMasterProperty(portalDb.getReader(0x39000001)));

const hex = (n: number) => '0x' + (n >>> 0).toString(16).padStart(8, '0');
interface Row { layout: number; path: number[]; element: number; state: number; file: number; sType: number }
const rows: Row[] = [];

function scanMedia(layout: number, path: number[], element: number, state: number, media: MediaDesc[]): void {
  for (const m of media) {
    if (m.type === MediaType.Sound) rows.push({ layout, path, element, state, file: m.file ?? 0, sType: m.sType ?? 0 });
  }
}
function scanElement(layout: number, el: ElementDesc, parents: number[]): void {
  const path = [...parents, el.elementId];
  scanMedia(layout, path, el.elementId, el.stateId, el.media);
  for (const [sid, st] of el.states) scanMedia(layout, path, el.elementId, sid, st.media);
  for (const child of el.children.values()) scanElement(layout, child, path);
}

const resolved = process.argv.includes('--resolved') || process.argv.includes('--ts');
const cache = new Map<number, LayoutDescData | null>();
const load = (id: number): LayoutDescData | null => {
  if (!cache.has(id)) {
    let l: LayoutDescData | null = null;
    try { l = parseLayoutDesc(langDb.getReader(id)); } catch { l = null; }
    cache.set(id, l);
  }
  return cache.get(id)!;
};

for (const id of langDb.listFileIds(0x21).sort((a, b) => a - b)) {
  const raw = load(id);
  if (!raw) continue;
  const layout = resolved ? resolveLayoutDesc(raw, load) : raw;
  for (const el of layout.elements.values()) scanElement(id, el, []);
}

if (process.argv.includes('--ts')) {
  // Distinct element ids → the states whose media carries a sound.
  const byEl = new Map<number, Map<number, Set<number>>>();
  for (const r of rows) {
    const states = byEl.get(r.element) ?? new Map<number, Set<number>>();
    const sounds = states.get(r.state) ?? new Set<number>();
    sounds.add(r.sType);
    states.set(r.state, sounds);
    byEl.set(r.element, states);
  }
  for (const [el, states] of [...byEl].sort((a, b) => a[0] - b[0])) {
    const parts = [...states].map(([s, snd]) => `[${hex(s)}, [${[...snd].map((x) => `Sound.${Sound[x] ?? x}`).join(', ')}]]`);
    const where = [...new Set(rows.filter((r) => r.element === el).map((r) => hex(r.layout)))].join(' ');
    console.log(`  [${hex(el)}, new Map([${parts.join(', ')}])], // ${where}`);
  }
} else if (process.argv.includes('--by-sound')) {
  const by = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${Sound[r.sType] ?? r.sType} (${r.sType}) table ${hex(r.file)}`;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  for (const [k, rs] of [...by].sort((a, b) => b[1].length - a[1].length)) {
    const layouts = [...new Set(rs.map((r) => hex(r.layout)))];
    console.log(`${k}: ${rs.length} media items in ${layouts.length} layouts (${layouts.slice(0, 8).join(' ')}${layouts.length > 8 ? ' …' : ''})`);
  }
} else {
  for (const r of rows) {
    console.log(`${hex(r.layout)} ${r.path.map(hex).join(' > ')} state ${hex(r.state)}: ${Sound[r.sType] ?? r.sType} table ${hex(r.file)}`);
  }
}
console.error(`${rows.length} sound media items${resolved ? ' (base chains resolved)' : ''}`);
