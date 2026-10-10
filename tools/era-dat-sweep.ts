/**
 * era-dat-sweep.ts — run our DAT parsers over a foreign DAT set (an era
 * variant, a classic server's custom DATs) and report what parses cleanly.
 *
 * Built for the Dark Majesty planning pass (docs/roadmap-era-variants.md,
 * 2026-10-04). Handles both container formats:
 *   - ToD+ ("client_portal.dat"): header at 0x140, 24-byte directory entries,
 *     an Iteration record at 0xFFFF0001. Read through our DatDatabase.
 *   - pre-ToD retail ("portal.dat"/"cell.dat", 1999–2005): header at 0x12C
 *     (FileType, BlockSize, FileSize, Iteration, FreeHead, FreeTail, FreeCount,
 *     BTreeRoot; the 1999 retail CD reads Iteration 102 portal / 67 cell), 12-byte
 *     directory entries (ObjectId, FileOffset, FileSize), no Iteration record.
 *     Read by DatDatabase's pre-ToD mode, through the 1999 overlay (era1999/)
 *     that translates every file to the end-of-retail formats; --raw sweeps
 *     the stored bytes instead.
 *
 * With --base <dir> (ToD sets only) every file added or changed versus the
 * base set is parsed (capped per type); otherwise a spread sample per type.
 * A file is "clean" when its parser consumes every byte.
 *
 * Usage:
 *   npx tsx tools/era-dat-sweep.ts <dir> [--base dat] [--sample 200] [--raw]
 * <dir> holds client_portal.dat / client_cell_1.dat / client_local_English.dat
 * (ToD) or PORTAL.DAT / CELL.DAT (pre-ToD). Never point it at a git-tracked path.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import * as P from '../packages/dat-parser/src/index.js';
import { ac1999CellOverlay, ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';

type Parse = (r: DatReader) => unknown;
type Kind = 'portal' | 'cell' | 'local';

const PORTAL: Record<number, [string, Parse]> = {
  0x01: ['GfxObj', (r) => new P.GfxObj(r)], 0x02: ['Setup', (r) => new P.SetupModel(r)],
  0x03: ['Animation', (r) => new P.Animation(r)], 0x04: ['Palette', (r) => P.Palette.read(r)],
  0x05: ['SurfaceTexture', (r) => P.SurfaceTexture.read(r)], 0x06: ['Texture', (r) => P.Texture.read(r)],
  0x07: ['Texture (synthetic 1999)', (r) => P.Texture.read(r)],
  0x08: ['Surface', (r) => P.Surface.read(r)], 0x09: ['MotionTable', (r) => new P.MotionTable(r)],
  0x0a: ['Wave', (r) => new P.Wave(r)], 0x0d: ['Environment', (r) => new P.Environment(r)],
  0x0f: ['PaletteSet', (r) => new P.PaletteSet(r)], 0x10: ['Clothing', (r) => new P.ClothingTable(r)],
  0x11: ['DegradeInfo', (r) => P.GfxObjDegradeInfo.read(r)], 0x12: ['Scene', (r) => P.Scene.read(r)],
  0x13: ['Region', (r) => new P.RegionDesc(r)], 0x14: ['KeyMap', (r) => P.KeyMap.read(r)],
  0x20: ['SoundTable', (r) => P.SoundTable.read(r)], 0x26: ['ActionMap', (r) => P.ActionMap.read(r)],
  0x30: ['CombatTable', (r) => new P.CombatManeuverTable(r)], 0x31: ['String', (r) => P.LanguageString.read(r)],
  0x32: ['ParticleEmitter', (r) => new P.ParticleEmitterInfo(r)], 0x33: ['PhysicsScript', (r) => P.PhysicsScript.read(r)],
  0x34: ['PhysicsScriptTable', (r) => P.PhysicsScriptTable.read(r)],
};
const SPECIAL: Record<number, [string, Parse]> = {
  0x0e000002: ['CharGen', (r) => new P.CharacterGenerator(r)],
  0x0e000003: ['SecondaryAttributeTable', (r) => new P.SecondaryAttributeTable(r)],
  0x0e000004: ['SkillTable', (r) => new P.SkillTable(r)], 0x0e000007: ['ChatPoseTable', (r) => P.ChatPoseTable.read(r)],
  0x0e00000e: ['SpellTable', (r) => new P.SpellTable(r)], 0x0e00000f: ['SpellComponentTable', (r) => new P.SpellComponentTable(r)],
  0x0e000018: ['XpTable', (r) => new P.XpTable(r)], 0x0e00001a: ['BadData', (r) => P.BadData.read(r)],
  0x0e00001d: ['ContractTable', (r) => P.ContractTable.read(r)], 0x0e00001e: ['TabooTable', (r) => P.TabooTable.read(r)],
  0x0e000020: ['NameFilterTable', (r) => P.NameFilterTable.read(r)],
};

function parserFor(kind: Kind, id: number): [string, Parse] | null {
  if (id >>> 0 === 0xffff0001) return null;
  if (kind === 'portal') return SPECIAL[id >>> 0] ?? PORTAL[id >>> 24] ?? null;
  if (kind === 'cell') {
    const lo = id & 0xffff;
    if (lo === 0xffff) return ['CellLandblock', (r) => P.CellLandblock.read(r)];
    if (lo === 0xfffe) return ['LandblockInfo', (r) => new P.LandblockInfo(r)];
    return ['EnvCell', (r) => new P.EnvCell(r)];
  }
  const t = id >>> 24;
  if (t === 0x21) return ['LayoutDesc', (r) => P.parseLayoutDesc(r)];
  if (t === 0x23) return ['StringTable', (r) => P.parseStringTable(r)];
  return null;
}

function typeKey(kind: Kind, id: number): string {
  if (kind === 'cell') {
    const lo = id & 0xffff;
    return lo === 0xffff ? 'LandBlock' : lo === 0xfffe ? 'LBInfo' : 'EnvCell';
  }
  return (id >>> 24).toString(16).padStart(2, '0');
}

interface Tally { clean: number; leftover: number; threw: number; example: string }

function sweep(kind: Kind, ids: number[], get: (id: number) => ArrayBuffer | null, cap: number, spread: boolean): void {
  const groups = new Map<string, number[]>();
  for (const id of ids) {
    const p = parserFor(kind, id);
    if (!p) continue;
    const list = groups.get(p[0]) ?? [];
    list.push(id);
    groups.set(p[0], list);
  }
  for (const [name, list] of [...groups].sort()) {
    const step = spread ? Math.max(1, Math.floor(list.length / cap)) : 1;
    const pick = list.filter((_, i) => i % step === 0).slice(0, cap);
    const t: Tally = { clean: 0, leftover: 0, threw: 0, example: '' };
    for (const id of pick) {
      const data = get(id);
      if (!data) continue;
      const r = new DatReader(data);
      try {
        parserFor(kind, id)![1](r);
        if (r.remaining === 0) t.clean++;
        else { t.leftover++; t.example ||= `0x${id.toString(16)} left ${r.remaining}/${data.byteLength}`; }
      } catch (e) {
        t.threw++;
        t.example ||= `0x${id.toString(16)} ${String((e as Error).message).slice(0, 70)}`;
      }
    }
    console.log(`  ${name.padEnd(24)} n=${pick.length}/${list.length} clean=${t.clean} leftover=${t.leftover} threw=${t.threw} ${t.example}`);
  }
}

function histogram(kind: Kind, ids: number[]): string {
  const m = new Map<string, number>();
  for (const id of ids) m.set(typeKey(kind, id), (m.get(typeKey(kind, id)) ?? 0) + 1);
  return [...m].sort().map(([k, v]) => `${k}:${v}`).join(' ');
}

const args = process.argv.slice(2);
const dir = args[0];
const opt = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const baseDir = opt('--base');
const sample = Number(opt('--sample') ?? 200);
if (!dir) { console.error('usage: npx tsx tools/era-dat-sweep.ts <dir> [--base dat] [--sample 200]'); process.exit(2); }

const TOD: Array<[string, Kind]> = [['client_portal.dat', 'portal'], ['client_cell_1.dat', 'cell'], ['client_local_English.dat', 'local']];
const OLD: Array<[string, Kind]> = [['PORTAL.DAT', 'portal'], ['CELL.DAT', 'cell'], ['portal.dat', 'portal'], ['cell.dat', 'cell']];

for (const [file, kind] of TOD) {
  const path = join(dir, file);
  if (!existsSync(path)) continue;
  const db = new DatDatabase(new FileDatBytes(path));
  const it = db.iteration;
  const raw = db.getFileData(0xffff0001);
  console.log(`\n=== ${file} (ToD container): blockSize ${db.blockSize} dataSet ${db.dataSet} files ${db.fileCount} iteration ${it?.totalIterations ?? 'none'} raw=[${raw ? Array.from(new Int32Array(raw)).join(', ') : ''}]`);
  const ids = db.listFileIds();
  const basePath = baseDir ? join(baseDir, file) : '';
  if (basePath && existsSync(basePath)) {
    const base = new DatDatabase(new FileDatBytes(basePath));
    const baseIds = new Set(base.listFileIds());
    const added: number[] = [];
    const changed: number[] = [];
    for (const id of ids) {
      const a = db.getFileEntry(id)!;
      const b = base.getFileEntry(id);
      if (!b) added.push(id);
      else if (a.fileSize !== b.fileSize || a.iteration !== b.iteration || a.date !== b.date) changed.push(id);
    }
    const removed = [...baseIds].filter((id) => !db.hasFile(id));
    console.log(`  vs base (${base.fileCount} files, iteration ${base.totalIterations}): added ${added.length} [${histogram(kind, added)}] changed ${changed.length} [${histogram(kind, changed)}] removed ${removed.length}`);
    sweep(kind, [...added, ...changed], (id) => db.getFileData(id), 4000, false);
  } else {
    console.log(`  types: ${histogram(kind, ids)}`);
    sweep(kind, ids, (id) => db.getFileData(id), sample, true);
  }
}

const oldSeen = new Set<Kind>(); // case-insensitive filesystems match both spellings
for (const [file, kind] of OLD) {
  const path = join(dir, file);
  if (oldSeen.has(kind) || !existsSync(path)) continue;
  oldSeen.add(kind);
  const db = new DatDatabase(new FileDatBytes(path));
  // The 1999 overlay translates every file into the end-of-retail formats (era1999/); --raw sweeps the bytes as stored.
  const translated = !args.includes('--raw');
  if (translated) db.setOverlay(kind === 'portal' ? ac1999PortalOverlay() : ac1999CellOverlay());
  console.log(`\n=== ${file} (${db.container} container${translated ? ', 1999 overlay' : ''}): blockSize ${db.blockSize} files ${db.fileCount} iteration ${db.totalIterations}`);
  const ids = db.listFileIds().sort((a, b) => a - b);
  console.log(`  types: ${histogram(kind, ids)}`);
  sweep(kind, ids, (id) => db.getFileData(id), sample, true);
}
