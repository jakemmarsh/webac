/**
 * scan-layout-center-anchors — every LayoutDesc element with a mode-3
 * (centred) left/top edge whose authored x/y is NOT already centred in its
 * parent. Retail centres these as soon as the element is attached
 * (UIElement::SetParent @ 00462a50 → UpdateForParentSizeChange @ 00462640),
 * and LayoutRenderer does the same (applyAttachTimeAnchors in
 * getResolvedLayout, LAYOUT.attach-time-center-anchors). Each row is an
 * element whose raw DAT rect is a placeholder: hand-built UI that copies a
 * template's x/y instead of reading the resolved desc gets these wrong.
 *   npx tsx tools/scan-layout-center-anchors.mts
 */
import fs from 'fs';
import { DatDatabase, DatReader, parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes, resolveLayoutDesc } from '../packages/dat-parser/src/index.ts';

const open = (p: string): DatDatabase => {
  const b = fs.readFileSync(p);
  return new DatDatabase(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
};
const portal = open('dat/client_portal.dat');
setMasterPropertyTypes(parseMasterProperty(new DatReader(portal.getFileData(0x39000001)!)));
const local = open('dat/client_local_English.dat');
const cache = new Map<number, ReturnType<typeof parseLayoutDesc> | null>();
const load = (id: number) => {
  if (!cache.has(id)) { const d = local.getFileData(id); cache.set(id, d ? parseLayoutDesc(new DatReader(d)) : null); }
  return cache.get(id) ?? null;
};
const hex = (n: number): string => n.toString(16);
const rows: string[] = [];
for (const id of local.listFileIds(0x21)) {
  const raw = load(id);
  if (!raw) continue;
  const layout = resolveLayoutDesc(raw, load);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (m: Map<number, any>, pw: number, ph: number, path: string): void => {
    for (const e of m.values()) {
      const cx = Math.floor(pw / 2) - Math.floor(e.width / 2);
      const cy = Math.floor(ph / 2) - Math.floor(e.height / 2);
      if ((e.leftEdge === 3 && e.x !== cx) || (e.topEdge === 3 && e.y !== cy)) {
        rows.push(`${hex(id)} ${path}/${hex(e.elementId)} xy=(${e.x},${e.y}) wh=${e.width}x${e.height} parent=${pw}x${ph} ` +
          `L${e.leftEdge}T${e.topEdge}R${e.rightEdge}B${e.bottomEdge} -> (${e.leftEdge === 3 ? cx : e.x},${e.topEdge === 3 ? cy : e.y})`);
      }
      walk(e.children, e.width, e.height, `${path}/${hex(e.elementId)}`);
    }
  };
  walk(layout.elements, layout.width ?? 800, layout.height ?? 600, '');
}
console.log(`${rows.length} off-centre mode-3 elements`);
for (const r of rows) console.log(r);
