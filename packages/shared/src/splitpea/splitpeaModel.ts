/**
 * Splitpea ("The Taper Program", Rainpea 2000; reference/plugin-specs/splitpea.md): a personal spell
 * database for the 1999 spell research system, which works out the tapers you haven't found from the
 * ones you have. Pure model: the researchable spells, the known tapers (with where each came from), the
 * seed solver, per-slot views, the list's filter / sort, the known-tapers store and the HTML export.
 *
 * It never reads an account name or hash. Tapers come from the spellbook (the personal formula of a spell
 * you know, which the client already shows you), or the player enters them; the solver does the rest.
 */
import { LOWEST_TAPER_ID, TAPER_COLOR_COUNT, spellLevelFromPower, version1Tapers } from '../magic/SpellFormula.js';
import { SeedSolver, coloursToTapers, type TaperConstraint } from './seedSolver.js';

/** SpellIndex bit 0x80, NotResearchable (AC1999 server GameEnums.h; ACE SpellFlags.NotResearchable). */
export const NOT_RESEARCHABLE_SPELL_FLAG = 0x80;

/** The schools as Splitpea's filter names them (MagicSchool 1–4). */
export const SPLITPEA_SCHOOLS: Readonly<Record<number, string>> = Object.freeze({ 1: 'War', 2: 'Life', 3: 'Item', 4: 'Creature' });

/** What Splitpea reads of a SpellTable entry (dat-parser SpellBase). */
export interface SplitpeaSpellSource {
  name: string; desc: string; school: number; icon: number; bitfield: number;
  baseMana: number; baseRangeConstant: number; power: number; duration?: number; formula: number[];
}

export interface SplitpeaSpell {
  id: number; name: string; desc: string; school: number; icon: number;
  mana: number; difficulty: number; level: number; range: number; duration: number;
  /** The base formula from the DAT (its taper slots are rewritten per account). */
  formula: readonly number[];
}

/** The researchable spells of a SpellTable: every spell without NotResearchable that has a formula. */
export function splitpeaSpells(table: ReadonlyMap<number, SplitpeaSpellSource>): SplitpeaSpell[] {
  const out: SplitpeaSpell[] = [];
  for (const [id, s] of table) {
    if (s.bitfield & NOT_RESEARCHABLE_SPELL_FLAG) continue;
    const formula = s.formula.filter((c) => c !== 0);
    if (formula.length < 5) continue;
    out.push({
      id, name: s.name, desc: s.desc, school: s.school, icon: s.icon,
      mana: s.baseMana, difficulty: s.power, level: spellLevelFromPower(s.power),
      range: s.baseRangeConstant, duration: s.duration && s.duration > 0 ? s.duration : 0, formula,
    });
  }
  return out;
}

export type SplitpeaSource = 'spellbook' | 'entered';
/** A taper the player has found: spell, formula slot (3 = taper 2, 6 = taper 3), taper component, source. */
export interface KnownTaper { spell: number; slot: number; taper: number; source: SplitpeaSource }

/** A formula slot's role, by the formula's length (the order RandomizeVersion1 reads). */
export function splitpeaSlotRoles(length: number): string[] {
  if (length >= 8) return ['Scarab', 'Taper 1', 'Herb', 'Taper 2', 'Gem', 'Alchemy', 'Taper 3', 'Talisman'];
  if (length === 7) return ['Scarab', 'Taper 1', 'Herb', 'Taper 2', 'Gem', 'Alchemy', 'Talisman'];
  if (length === 6) return ['Scarab', 'Taper 1', 'Herb', 'Gem', 'Alchemy', 'Talisman'];
  return ['Scarab', 'Herb', 'Gem', 'Alchemy', 'Talisman'].slice(0, length);
}

/**
 * A slot as the list shows it: known (a fixed component, the public taper 1, or a taper you found),
 * solved (every key left gives this taper), or open (one of `ids`; empty when the found tapers disagree).
 */
export type SplitpeaSlot =
  | { slot: number; role: string; kind: 'known'; id: number; source?: SplitpeaSource }
  | { slot: number; role: string; kind: 'solved'; id: number }
  | { slot: number; role: string; kind: 'open'; ids: number[] };

const isTaper = (id: number): boolean => id >= LOWEST_TAPER_ID && id < LOWEST_TAPER_ID + TAPER_COLOR_COUNT;

export class SplitpeaModel {
  readonly spells: readonly SplitpeaSpell[];
  readonly solver = new SeedSolver();
  private readonly byId = new Map<number, SplitpeaSpell>();
  private known: KnownTaper[] = [];
  /** Runs after any change to the known tapers (the plugin saves them). */
  onChange: (() => void) | null = null;

  constructor(spells: readonly SplitpeaSpell[]) {
    this.spells = spells;
    for (const s of spells) this.byId.set(s.id, s);
  }

  spell(id: number): SplitpeaSpell | undefined { return this.byId.get(id); }
  knownTapers(): readonly KnownTaper[] { return this.known; }
  /** Account keys still possible (1,299,827 before any taper is known). */
  keysLeft(): number { return this.solver.count; }
  /** The found tapers disagree: no key fits them all. */
  conflict(): boolean { return this.solver.constraints.length > 0 && this.solver.count === 0; }
  /** Spells with at least one found taper. */
  spellsWithTapers(): number { return new Set(this.known.map((k) => k.spell)).size; }

  /** The personal taper slots of a spell (3 and / or 6), with their terms. */
  personalSlots(spellId: number): Array<{ slot: number; mul: number; div: number }> {
    const s = this.byId.get(spellId);
    return s ? version1Tapers(s.formula).personal : [];
  }

  /** Replace the known tapers (a load from storage). Records that don't fit this spell table are dropped. */
  setKnown(list: readonly KnownTaper[]): void {
    const kept = new Map<string, KnownTaper>();
    for (const k of list) {
      if (!isTaper(k.taper) || !this.personalSlots(k.spell).some((p) => p.slot === k.slot)) continue;
      kept.set(`${k.spell}:${k.slot}`, { spell: k.spell, slot: k.slot, taper: k.taper, source: k.source === 'spellbook' ? 'spellbook' : 'entered' });
    }
    this.known = [...kept.values()];
    this.resolve();
  }

  /** Enter (or with null, clear) a taper the player found. */
  enter(spell: number, slot: number, taper: number | null): void {
    const rest = this.known.filter((k) => !(k.spell === spell && k.slot === slot));
    this.setKnown(taper === null ? rest : [...rest, { spell, slot, taper, source: 'entered' }]);
    this.onChange?.();
  }

  /** Forget a spell's found tapers (all its slots, or one). */
  remove(spell: number, slot?: number): void {
    this.setKnown(this.known.filter((k) => !(k.spell === spell && (slot === undefined || k.slot === slot))));
    this.onChange?.();
  }

  /**
   * The spellbook's spells: each one you know shows its full personal formula, so its tapers are found.
   * A spellbook taper replaces an entered one for the same slot. Returns how many records changed.
   */
  syncSpellbook(book: Iterable<{ id: number; formula: readonly number[] }>): number {
    const next = new Map<string, KnownTaper>(this.known.map((k) => [`${k.spell}:${k.slot}`, k]));
    let changed = 0;
    for (const b of book) {
      for (const p of this.personalSlots(b.id)) {
        const taper = b.formula[p.slot];
        if (taper === undefined || !isTaper(taper)) continue;
        const key = `${b.id}:${p.slot}`;
        const had = next.get(key);
        if (had && had.taper === taper && had.source === 'spellbook') continue;
        next.set(key, { spell: b.id, slot: p.slot, taper, source: 'spellbook' });
        changed++;
      }
    }
    if (changed) { this.setKnown([...next.values()]); this.onChange?.(); }
    return changed;
  }

  private resolve(): void {
    const cs: TaperConstraint[] = [];
    for (const k of this.known) {
      const p = this.personalSlots(k.spell).find((x) => x.slot === k.slot);
      if (p) cs.push({ mul: p.mul, div: p.div, taper: k.taper });
    }
    this.solver.set(cs);
  }

  /** Each slot of a spell's formula, known / solved / open. */
  view(spellId: number): SplitpeaSlot[] {
    const s = this.byId.get(spellId);
    if (!s) return [];
    const roles = splitpeaSlotRoles(s.formula.length);
    const t = version1Tapers(s.formula);
    const personal = new Map(t.personal.map((p) => [p.slot, p] as const));
    return s.formula.map((id, slot): SplitpeaSlot => {
      const role = roles[slot] ?? '';
      if (t.taper1 && slot === t.taper1.slot) return { slot, role, kind: 'known', id: t.taper1.id };
      const p = personal.get(slot);
      if (!p) return { slot, role, kind: 'known', id };
      const found = this.known.find((k) => k.spell === spellId && k.slot === slot);
      if (found) return { slot, role, kind: 'known', id: found.taper, source: found.source };
      const ids = coloursToTapers(this.solver.colours(p));
      return ids.length === 1 ? { slot, role, kind: 'solved', id: ids[0] } : { slot, role, kind: 'open', ids };
    });
  }

  /** Every slot known or worked out. */
  settled(spellId: number): boolean { return this.view(spellId).every((v) => v.kind !== 'open'); }

  /** The formula to research: each known or worked-out component, 0 where a taper is still open. */
  researchFormula(spellId: number): number[] {
    return this.view(spellId).map((v) => (v.kind === 'open' ? 0 : v.id));
  }
}

export type SplitpeaSort = 'name' | 'level' | 'school';
export interface SplitpeaListOptions {
  /** 0 = All Spells, else the MagicSchool (1 War, 2 Life, 3 Item, 4 Creature). */
  school: number;
  sort: SplitpeaSort;
  /** Leave out spells whose every taper is known or worked out. */
  hideSettled?: boolean;
  /** Only spells you could research now: every settled component carried, and some candidate for each open taper. */
  carried?: ((componentId: number) => boolean) | null;
}

/** The Spell List's rows, filtered and sorted. */
export function splitpeaList(model: SplitpeaModel, o: SplitpeaListOptions): SplitpeaSpell[] {
  const rows = model.spells.filter((s) => {
    if (o.school && s.school !== o.school) return false;
    if (o.hideSettled && model.settled(s.id)) return false;
    if (o.carried) {
      const has = o.carried;
      if (!model.view(s.id).every((v) => (v.kind === 'open' ? v.ids.some(has) : has(v.id)))) return false;
    }
    return true;
  });
  const byName = (a: SplitpeaSpell, b: SplitpeaSpell) => a.name.localeCompare(b.name);
  if (o.sort === 'level') rows.sort((a, b) => a.level - b.level || byName(a, b));
  else if (o.sort === 'school') rows.sort((a, b) => a.school - b.school || a.level - b.level || byName(a, b));
  else rows.sort(byName);
  return rows;
}

/** A taper's short name for an open slot ("Red Taper" → "Red"). */
export function taperShortName(name: string): string { return name.replace(/ Taper$/, ''); }

/** An open slot's text: "Red/Blue" for up to three, "? (n)" past that. */
export function openSlotText(ids: readonly number[], componentName: (id: number) => string): string {
  if (ids.length === 0) return '?';
  return ids.length <= 3 ? ids.map((id) => taperShortName(componentName(id))).join('/') : `? (${ids.length})`;
}

// ── Known tapers in browser storage, per server + account ──

export interface SplitpeaStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** Where an account's known tapers are kept: one entry per server + account (the account is only a key). */
export function splitpeaStoreKey(server: string, account: string): string {
  return `acjs.splitpea.tapers.${server.trim().toLowerCase()}.${account.trim().toLowerCase()}`;
}

/** The stored form: { v: 1, tapers: [{ spell, slot, taper, source }] }. */
export function serializeKnownTapers(list: readonly KnownTaper[]): string {
  return JSON.stringify({ v: 1, tapers: list.map((k) => ({ spell: k.spell, slot: k.slot, taper: k.taper, source: k.source })) });
}

export function parseKnownTapers(text: string | null): KnownTaper[] {
  if (!text) return [];
  try {
    const doc = JSON.parse(text) as { v?: number; tapers?: unknown };
    if (doc?.v !== 1 || !Array.isArray(doc.tapers)) return [];
    const out: KnownTaper[] = [];
    for (const r of doc.tapers as Array<Record<string, unknown>>) {
      const spell = Number(r?.spell), slot = Number(r?.slot), taper = Number(r?.taper);
      if (![spell, slot, taper].every(Number.isInteger)) continue;
      out.push({ spell, slot, taper, source: r.source === 'spellbook' ? 'spellbook' : 'entered' });
    }
    return out;
  } catch { return []; }
}

export function loadKnownTapers(storage: SplitpeaStorage | null, server: string, account: string): KnownTaper[] {
  try { return parseKnownTapers(storage?.getItem(splitpeaStoreKey(server, account)) ?? null); } catch { return []; }
}

export function saveKnownTapers(storage: SplitpeaStorage | null, server: string, account: string, list: readonly KnownTaper[]): void {
  try { storage?.setItem(splitpeaStoreKey(server, account), serializeKnownTapers(list)); } catch { /* storage blocked or full */ }
}

// ── Export HTML (the original's sidebar button) ──

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** A self-contained HTML page of the list: each spell's numbers and formula, open tapers as "one of". */
export function splitpeaExportHtml(model: SplitpeaModel, rows: readonly SplitpeaSpell[], componentName: (id: number) => string, title: string): string {
  const head = ['Spell', 'School', 'Level', 'Mana', 'Difficulty', 'Range', 'Duration', 'Formula'];
  const body = rows.map((s) => {
    const formula = model.view(s.id).map((v) => {
      if (v.kind === 'open') return `<span class="open">${esc(openSlotText(v.ids, componentName))}</span>`;
      return esc(componentName(v.id)) + (v.kind === 'solved' ? ' &#10003;' : '');
    }).join(', ');
    const cells = [esc(s.name), esc(SPLITPEA_SCHOOLS[s.school] ?? ''), String(s.level), String(s.mana), String(s.difficulty),
      s.range > 0 ? `${s.range}` : '', s.duration > 0 ? `${Math.round(s.duration)} s` : '', formula];
    return `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  }).join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:"Times New Roman",serif;background:#000;color:#e8e0c8}table{border-collapse:collapse}td,th{border:1px solid #6b5a3a;padding:2px 6px;text-align:left}th{color:#f0c060}.open{color:#e05a4a}</style>
</head><body>
<h1>${esc(title)}</h1>
<p>${model.spellsWithTapers()} spells with found tapers, ${model.keysLeft().toLocaleString('en-US')} taper keys left. &#10003; = worked out from the tapers you found.</p>
<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
<tbody>
${body}
</tbody></table>
</body></html>
`;
}
