/**
 * Every VirindiTank file kind in one place, for the importer and exporter
 * paths (the automation window's Import, `ac_routines action=import|export`,
 * the VirindiTank window's CopyTo and `/vt … save`): `.met`, `.nav`, `.utl`
 * (vtank.ts / vtankExport.ts), `.usd` settings (vtankUsd.ts) and metaf's
 * `.af` (vtankAf.ts).
 *
 * An `.af` is read into the meta or nav it stands for and imported as that
 * `.met` / `.nav` would be, so both forms give the same profile.
 */
import type { RoutineProfile } from './RoutineDoc.js';
import { importVTank, vtankKind, type ImportResult, type MetValue } from './vtank.js';
import { exportVTank, writeMetValue, type VTankExport } from './vtankExport.js';
import { exportAf, exportNavAf, parseAf, writeNavText } from './vtankAf.js';
import { exportUsd, importUsd, type VtNames } from './vtankUsd.js';

export type VTankFileKind = 'met' | 'nav' | 'utl' | 'usd' | 'af';

/** Which VirindiTank (or metaf) file this is, by extension, else by content. */
export function vtankFileKind(fileName: string, text: string): VTankFileKind | null {
  const ext = /\.(met|nav|utl|usd|af)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (ext) return ext as VTankFileKind;
  const k = vtankKind(fileName, text);
  if (k) return k;
  const t = text.replace(/^﻿/, '').trimStart();
  if (/^\d+\r?\n(AntiExtraBuffSpells|AssistItems|BuffedItems|MyMonsters|Settings)\r?\n/.test(t)) return 'usd';
  if (/^(~~|STATE:|NAV:)/m.test(t)) return 'af';
  return null;
}

/** An `.af` as the `.met` (or `.nav`) text it stands for. */
export function afToVTankText(text: string): { kind: 'met' | 'nav'; text: string } {
  const f = parseAf(text);
  if (f.kind === 'nav') return { kind: 'nav', text: writeNavText(f.nav) };
  const NL = '\r\n';
  const I = (v: number): MetValue => ({ t: 'i', v });
  const S = (v: string): MetValue => ({ t: 's', v });
  const header = ['1', 'CondAct', '5', 'CType', 'AType', 'CData', 'AData', 'State', 'n', 'n', 'n', 'n', 'n', String(f.rules.length)].join(NL) + NL;
  return { kind: 'met', text: header + f.rules.map((r) => writeMetValue(I(r.cond)) + writeMetValue(I(r.act)) + writeMetValue(r.condData) + writeMetValue(r.actData) + writeMetValue(S(r.state))).join('') };
}

/**
 * Import VirindiTank files of any kind into one profile: `.met` / `.af` metas
 * make the states, `.nav` / nav `.af` add routes, `.utl` the loot, and a
 * `.usd` the settings and VirindiTank tabs. `names` names the ids a `.usd`
 * holds (the client's spell table and carried items); without it they are
 * kept by id.
 */
export function importVTankFiles(files: Array<{ name: string; text: string }>, base: RoutineProfile | null, profileName: string, names: VtNames = {}): ImportResult<RoutineProfile> {
  const problems: string[] = [];
  const plain: Array<{ name: string; text: string }> = [];
  const usd: Array<{ name: string; text: string }> = [];
  for (const f of files) {
    const kind = vtankFileKind(f.name, f.text);
    if (kind === 'usd') { usd.push(f); continue; }
    if (kind === 'af') {
      try {
        const t = afToVTankText(f.text);
        plain.push({ name: f.name.replace(/\.af$/i, '') + `.${t.kind}`, text: t.text });
      } catch (e) { problems.push(`${f.name}: could not read it (${(e as Error).message})`); }
      continue;
    }
    if (!kind) { problems.push(`${f.name}: not a VirindiTank .met, .nav, .utl or .usd file, or a metaf .af`); continue; }
    plain.push(f);
  }
  const r = plain.length || !base ? importVTank(plain, base, profileName) : { value: structuredClone(base), problems: [] };
  let p = r.value;
  problems.push(...r.problems);
  for (const f of usd) {
    try {
      const u = importUsd(p, f.text, names);
      p = u.value;
      problems.push(...u.problems.map((x) => `${f.name}: ${x}`));
    } catch (e) { problems.push(`${f.name}: could not read it (${(e as Error).message})`); }
  }
  return { value: p, problems };
}

/**
 * One of a profile's files: `met`, `nav`, `utl` as exportVTank; `usd` its
 * settings and VirindiTank tabs; `af` its meta in metaf's form, or with
 * `which` naming a route, that route as a nav-only `.af`. Null when there is
 * no such route or loot set.
 */
export function exportVTankFile(p: RoutineProfile, kind: VTankFileKind, which?: string, names: VtNames = {}): VTankExport | null {
  if (kind === 'usd') return exportUsd(p, names);
  if (kind === 'af') {
    if (which === undefined) return exportAf(p);
    const r = p.routes.find((x) => x.name === which) ?? p.routes.find((x) => x.name.toLowerCase() === which.toLowerCase());
    return r ? exportNavAf(r) : null;
  }
  return exportVTank(p, kind, which);
}
