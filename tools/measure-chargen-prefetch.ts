/**
 * UX.chargen-preview-no-placeholder — the chargen prefetch's bytes per
 * heritage + sex, per era, from the local DATs (no network).
 *
 *   npx tsx tools/measure-chargen-prefetch.ts [eor|dm|ac1999 ...]
 *
 * For each heritage + sex of the era's CharGen: the base figure
 * (ChargenPrefetch.chargenBaseIds — warmed for every heritage while chargen is
 * open) and every Appearance-page option (chargenOptionIds — warmed for the
 * heritage + sex in force), as the per-file leaves DatClosure walks down to,
 * in payload and gzip -6 bytes (what a cold streamed client downloads, less
 * whatever the world pack already holds). Markdown table on stdout.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.ts';
import { DatReader } from '../packages/dat-parser/src/DatReader.ts';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.ts';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.ts';
import { CharacterGenerator } from '../packages/dat-parser/src/file-types/CharacterGenerator.ts';
import { ClothingTable } from '../packages/dat-parser/src/file-types/ClothingTable.ts';
import { AppearanceManager } from '../packages/renderer/src/models/AppearanceManager.ts';
import { SetupModel } from '../packages/dat-parser/src/file-types/SetupModel.ts';
import { loadChargenDidMapper, resolveChargenAnimationDids } from '../packages/renderer/src/ui/ChargenViewAnimation.ts';
import { chargenBaseIds, chargenOptionIds, type ChargenPrefetchSources } from '../packages/renderer/src/models/ChargenPrefetch.ts';
import { closureLeaves, leafBytes } from './lib/chargen-prefetch-plan.ts';

const ROOT = resolve(import.meta.dirname, '..');
const ERAS: Record<string, { path: string; overlay?: boolean }> = {
  eor: { path: 'dat/client_portal.dat' },
  'dm-classic-dereth-1.1': { path: 'dat-sets/classic-dereth-1.1/client_portal.dat' },
  'dm-customdm-1.60': { path: 'dat-sets/classicace-customdm-1.60/client_portal.dat' },
  ac1999: { path: 'dat-sets/ac1999-retail/portal.dat', overlay: true },
};

export function chargenSources(db: DatDatabase, uiDb: DatDatabase = db): ChargenPrefetchSources {
  const am = new AppearanceManager(db);
  const mapper = loadChargenDidMapper(uiDb);
  const tables = new Map<number, ClothingTable | null>();
  return {
    loadPaletteSet: (id) => am.loadPaletteSet(id),
    loadClothingTable: (id) => {
      if (!tables.has(id)) { const d = db.getFileData(id); tables.set(id, d ? new ClothingTable(new DatReader(d)) : null); }
      return tables.get(id)!;
    },
    setupParts: (id) => { const d = db.getFileData(id); return d ? new SetupModel(new DatReader(d)).parts : null; },
    chargenAnimations: (h) => { const d = resolveChargenAnimationDids(h, mapper); return [d.animation, d.rest, ...d.gestures]; },
  };
}

const mb = (n: number) => (n / 1048576).toFixed(2);

async function main(): Promise<void> {
  const want = process.argv.slice(2);
  for (const [era, spec] of Object.entries(ERAS)) {
    if (want.length && !want.includes(era)) continue;
    const path = join(ROOT, spec.path);
    if (!existsSync(path)) { console.log(`\n${era}: ${spec.path} absent, skipped`); continue; }
    const db = new DatDatabase(new FileDatBytes(path));
    if (spec.overlay) db.setOverlay(ac1999PortalOverlay());
    const cg = new CharacterGenerator(new DatReader(db.getFileData(0x0e000002)!));
    // The 1999 world's chargen animations come from the interface mapper (end of retail's portal).
    const src = chargenSources(db, spec.overlay && existsSync(join(ROOT, ERAS.eor.path)) ? new DatDatabase(new FileDatBytes(join(ROOT, ERAS.eor.path))) : db);
    console.log(`\n### ${era} (${spec.path})\n`);
    console.log('| heritage | sex | base files | base gz MB | options files | options payload MB | options gz MB |');
    console.log('|---|---|---:|---:|---:|---:|---:|');
    const allBase = new Set<number>();
    let maxGz = 0, sumGz = 0, n = 0;
    for (const [heritage, group] of cg.heritageGroups) {
      for (const [gender, sex] of group.genders) {
        const base = await closureLeaves(db, chargenBaseIds(sex, src, heritage));
        for (const id of base) allBase.add(id);
        const opts = await closureLeaves(db, chargenOptionIds(sex, src, heritage));
        const b = leafBytes(db, base), o = leafBytes(db, opts);
        maxGz = Math.max(maxGz, o.gz); sumGz += o.gz; n++;
        console.log(`| ${heritage} ${group.name} | ${gender === 1 ? 'M' : 'F'} | ${b.files} | ${mb(b.gz)} | ${o.files} | ${mb(o.payload)} | ${mb(o.gz)} |`);
      }
    }
    const ab = leafBytes(db, allBase);
    console.log(`\nevery heritage + sex base figure (deduplicated): ${ab.files} files, ${mb(ab.payload)} MB payload, ${mb(ab.gz)} MB gz`);
    console.log(`options per heritage + sex: mean ${mb(sumGz / Math.max(1, n))} MB gz, max ${mb(maxGz)} MB gz`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
