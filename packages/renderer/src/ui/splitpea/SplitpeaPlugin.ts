/**
 * Splitpea ("The Taper Program", Rainpea 2000), AC1999 only: a VVS-bar plugin with the 1999 spell list and
 * the tapers worked out from the ones you found. Spec, sources and the approved mockups:
 * reference/plugin-specs/splitpea.md and splitpea-mockups/ (drawn with this kit). The original was a
 * standalone Windows program; ours is drawn ONLY with the VVS kit, in a VVS frame, like our other plugins.
 *
 * Pure parts (solver, model, store, export) are in @ac/shared splitpea/. This file holds the window's state
 * and drawing; GameUI hosts it (setSplitpea, toggleSplitpeaWindow, the bar entry) and main.ts passes reads.
 *
 * Hooks for the 1999 Spell Research panel (the Create Spell tab):
 * - `research` (SplitpeaResearchLink): set it to fill the tab's FORMULA slots. "Load into Research" calls
 *   `loadFormula(componentIds)`; unset, or when it returns false, the window says "Open the Create Spell tab first".
 * - `onSpellLearned(spellId)`: call it when research teaches a spell. The spellbook add (0x4C) already reaches
 *   it through GameUI.setSpellData, so a learned spell's tapers count as known either way.
 */
import {
  LOWEST_TAPER_ID, TAPER_COLOR_COUNT, SplitpeaModel, SPLITPEA_SCHOOLS, loadKnownTapers, openSlotText, saveKnownTapers, splitpeaExportHtml, splitpeaList,
  splitpeaSpells, taperShortName, type SplitpeaSlot, type SplitpeaSort, type SplitpeaSpell, type SplitpeaSpellSource,
  type SplitpeaStorage,
} from '@ac/shared';
import type { EraProfile } from '../../era/EraProfiles.js';
import { eraClientRules } from '../../era/EraFeatures.js';
import type { MenuItem } from '../automation/AutomationPanel.js';
import type { VTankKit } from '../automation/VTankWindow.js';

/** What the plugin reads from the game (main.ts). */
export interface SplitpeaReads {
  /** The account, for the window title and the storage key only: the solver never sees it. */
  account(): string;
  server(): string;
  /** The era's SpellTable (0x0E00000E), null until it is loaded. */
  spells(): ReadonlyMap<number, SplitpeaSpellSource> | null;
  /** A SpellComponentTable entry's name and icon. */
  component(id: number): { name: string; icon: number } | null;
  /** Spells you know, each with the personal formula the client shows (and casts) for it. */
  spellbook(): Array<{ id: number; formula: number[] }>;
  /** You carry at least one of this component. */
  carries(componentId: number): boolean;
  storage(): SplitpeaStorage | null;
}

/** The 1999 Spell Research panel's side: fill its FORMULA slots (0 = leave a slot empty). False when the tab isn't open. */
export interface SplitpeaResearchLink {
  loadFormula(componentIds: number[]): boolean;
}

/** What GameUI lends the plugin: the VVS kit and its own small windows. */
export interface SplitpeaHost {
  kit: VTankKit;
  redraw(): void;
  openAux(key: string, title: string, w: number, h: number, draw: (body: HTMLElement, redraw: () => void, close: () => void) => void): void;
  closeAux(key: string): void;
}

/** The main window's frame (the mockup's 400 × 465) and the Edit Tapers dialog's. */
export const SPLITPEA_FRAME = { w: 400, h: 465 } as const;
export const SPLITPEA_EDIT_FRAME = { w: 330, h: 270 } as const;
export const SPLITPEA_EDIT_KEY = 'splitpea-edit';
export const SPLITPEA_TABS = ['Spell List', 'Known Tapers', 'Options'] as const;
export const SPLITPEA_FILTERS = ['All Spells', 'War', 'Life', 'Item', 'Creature'] as const;
export const SPLITPEA_NOT_LINKED = 'Open the Create Spell tab first';
const SORTS: Array<{ label: string; value: SplitpeaSort }> = [{ label: 'Name', value: 'name' }, { label: 'Level', value: 'level' }, { label: 'School', value: 'school' }];

/** The mockups' colours (splitpea-mockups/mockup-script.js). */
const GOLD = '#f0c060', MUTED = '#a8a08a', RED = '#e05a4a', GREEN = '#7fd07f', TEXT = '#e8e0c8';
/** A spell card's pitch and the list's viewport. */
export const SPLITPEA_CARD = 60;
const LIST = { x: 6, y: 64, w: 384, h: 330 };

/** Splitpea for this era: only where the era's client researched spells (eraClientRules().splitpea), else null. */
export function createSplitpea(era: EraProfile | null | undefined, reads: SplitpeaReads): SplitpeaPlugin | null {
  return eraClientRules(era).splitpea ? new SplitpeaPlugin(reads) : null;
}

export class SplitpeaPlugin {
  /** HOOK: the Create Spell tab connects here (SpellResearch1999). Null until it does. */
  research: SplitpeaResearchLink | null = null;
  host: SplitpeaHost | null = null;
  tab = 0;
  school = 0;
  sort: SplitpeaSort = 'name';
  selected: number | null = null;
  options = { hideSettled: false, carriedOnly: false };
  /** A short message in place of the status line (Load into Research, Export HTML). */
  notice: { text: string; color: string } | null = null;
  private model: SplitpeaModel | null = null;
  private modelKey = '';
  private modelTable: unknown = null;
  private bookDirty = true;
  private scrollTop = 0;
  private knownSel: number | null = null;
  /** Edit Tapers' choices before Save: slot → taper (null = unknown). */
  private draft = new Map<number, number | null>();

  constructor(readonly reads: SplitpeaReads) {
    try {
      const o = JSON.parse(reads.storage()?.getItem('acjs.splitpea.options') ?? 'null') as Partial<SplitpeaPlugin['options']> | null;
      if (o) this.options = { hideSettled: !!o.hideSettled, carriedOnly: !!o.carriedOnly };
    } catch { /* storage blocked */ }
  }

  title(): string { return `Splitpea - Spell List - ${this.reads.account()}`; }

  /** The model for this server + account and spell table, with the stored tapers and the spellbook's. */
  ensure(): SplitpeaModel | null {
    const table = this.reads.spells();
    if (!table) return null;
    const key = `${this.reads.server()}\u0000${this.reads.account()}`;
    if (!this.model || key !== this.modelKey || table !== this.modelTable) {
      const m = new SplitpeaModel(splitpeaSpells(table));
      m.setKnown(loadKnownTapers(this.reads.storage(), this.reads.server(), this.reads.account()));
      m.onChange = () => saveKnownTapers(this.reads.storage(), this.reads.server(), this.reads.account(), m.knownTapers());
      this.model = m; this.modelKey = key; this.modelTable = table; this.bookDirty = true;
    }
    if (this.bookDirty) { this.bookDirty = false; this.model.syncSpellbook(this.reads.spellbook()); }
    return this.model;
  }

  /** The spellbook changed (a spell learned or lost): its tapers are read again on the next draw. */
  spellbookChanged(): void { this.bookDirty = true; this.host?.redraw(); }

  /** HOOK: research taught `spellId`. Its personal formula is in the spellbook now. */
  onSpellLearned(spellId: number): void {
    this.bookDirty = true;
    const name = this.ensure()?.spell(spellId)?.name;
    if (name) this.notice = { text: `Learned ${name}: its tapers are known now.`, color: GREEN };
    this.host?.redraw();
  }

  private name(id: number): string { return this.reads.component(id)?.name ?? '?'; }
  private saveOptions(): void {
    try { this.reads.storage()?.setItem('acjs.splitpea.options', JSON.stringify(this.options)); } catch { /* storage blocked */ }
  }

  /** The rows the Spell List shows now. */
  rows(): SplitpeaSpell[] {
    const m = this.ensure();
    if (!m) return [];
    return splitpeaList(m, { school: this.school, sort: this.sort, hideSettled: this.options.hideSettled, carried: this.options.carriedOnly ? (id) => this.reads.carries(id) : null });
  }

  /** "Load into Research": the selected spell's formula into the Create Spell tab (0 where a taper is open). */
  loadIntoResearch(): void {
    const m = this.ensure();
    const s = this.selected === null ? undefined : m?.spell(this.selected);
    if (!m || !s) { this.notice = { text: 'Pick a spell first', color: MUTED }; return; }
    const formula = m.researchFormula(s.id);
    if (!this.research || !this.research.loadFormula(formula)) { this.notice = { text: SPLITPEA_NOT_LINKED, color: GOLD }; return; }
    const open = m.view(s.id).filter((v) => v.kind === 'open').map((v) => v.role);
    this.notice = { text: `Loaded ${s.name}${open.length ? `; pick ${open.join(' and ')} yourself` : ''}`, color: GREEN };
  }

  /** "Export HTML": the list as shown, a self-contained page (a browser download). */
  exportHtml(kit: VTankKit): string | null {
    const m = this.ensure();
    if (!m) return null;
    const html = splitpeaExportHtml(m, this.rows(), (id) => this.name(id), this.title());
    kit.download(`splitpea-${this.reads.account() || 'account'}.html`, html);
    this.notice = { text: 'Exported the spell list', color: GREEN };
    return html;
  }

  // ── drawing ──

  render(body: HTMLElement, redraw: () => void): void {
    const kit = this.host?.kit;
    if (!kit) return;
    body.innerHTML = '';
    const act = (fn: () => void) => () => { this.notice = null; fn(); redraw(); };
    SPLITPEA_TABS.forEach((t, i) => body.appendChild(place(tagged(kit.textTab(t, i === this.tab, act(() => { this.tab = i; this.notice = null; })), 'splitpeaTab', t), 8 + i * 74, 4)));
    const m = this.ensure();
    if (!m) { body.appendChild(place(kit.text('The spell table is still loading.', { color: MUTED }), 8, 30)); return; }
    if (this.tab === 1) return this.renderKnown(body, kit, m, redraw);
    if (this.tab === 2) return this.renderOptions(body, kit, redraw);

    body.appendChild(place(kit.text('Filter by:', { color: MUTED }), 8, 26));
    SPLITPEA_FILTERS.forEach((t, i) => body.appendChild(place(tagged(kit.textTab(t, this.school === i, act(() => { this.school = i; this.scrollTop = 0; })), 'splitpeaFilter', t), 62 + [0, 58, 88, 116, 144][i], 26)));
    body.appendChild(place(kit.text('Sort by:', { color: MUTED }), 262, 26));
    const sortLabel = SORTS.find((s) => s.value === this.sort)!.label;
    body.appendChild(place(tagged(kit.dropdown(sortLabel, (anchor) => kit.menu(anchor, SORTS.map((s) => ({ label: s.label, value: s.value })), (v) => { this.sort = v as SplitpeaSort; this.scrollTop = 0; redraw(); }), 80), 'splitpeaSort', sortLabel), 306, 23));
    body.appendChild(place(tagged(this.statusLine(kit, m), 'splitpeaStatus', ''), 8, 46));

    const rows = this.rows();
    if (this.selected === null || !rows.some((r) => r.id === this.selected)) this.selected = rows[0]?.id ?? this.selected;
    const host = place(document.createElement('div'), LIST.x, LIST.y, LIST.w, LIST.h);
    host.style.overflow = 'hidden';
    const content = document.createElement('div');
    content.dataset.splitpeaList = '1';
    Object.assign(content.style, { position: 'relative', height: `${rows.length * SPLITPEA_CARD}px` });
    host.appendChild(content);
    kit.list(host);
    body.appendChild(host);
    if (rows.length === 0) content.appendChild(place(kit.text(this.options.carriedOnly ? 'You carry the components for none of these.' : 'No spells.', { color: MUTED }), 4, 4));
    // Only the cards in view are drawn (the 1999 table has 1,580 researchable spells).
    const scroller = (content.parentElement ?? host) as HTMLElement;
    const drawn = new Set<number>();
    const fill = () => {
      const top = scroller.scrollTop || 0;
      const first = Math.max(0, Math.floor(top / SPLITPEA_CARD) - 2);
      const last = Math.min(rows.length, Math.ceil((top + LIST.h) / SPLITPEA_CARD) + 2);
      for (const el of [...content.querySelectorAll<HTMLElement>('[data-splitpea-card]')]) {
        const i = Number(el.dataset.index);
        if (i < first || i >= last) { el.remove(); drawn.delete(i); }
      }
      for (let i = first; i < last; i++) if (!drawn.has(i)) { drawn.add(i); content.appendChild(this.card(kit, m, rows[i], i, act(() => { this.selected = rows[i].id; }))); }
    };
    scroller.scrollTop = this.scrollTop;
    fill();
    scroller.addEventListener('scroll', () => { this.scrollTop = scroller.scrollTop; fill(); });

    body.appendChild(place(kit.flatButton('Edit Tapers', () => this.openEdit(redraw), 84, 20), 8, 402));
    body.appendChild(place(kit.flatButton('Load into Research', act(() => this.loadIntoResearch()), 120, 20), 98, 402));
    body.appendChild(place(kit.flatButton('Export HTML', act(() => { this.exportHtml(kit); }), 84, 20), 300, 402));
  }

  private statusLine(kit: VTankKit, m: SplitpeaModel): HTMLElement {
    if (this.notice) return kit.text(this.notice.text, { color: this.notice.color });
    if (m.conflict()) return kit.text('Your tapers disagree: no key fits them all. Check the ones you entered.', { color: RED });
    const keys = m.keysLeft();
    const settled = keys === 1;
    return kit.text(`${m.spellsWithTapers()} spells with known tapers, ${keys.toLocaleString('en-US')} taper key${keys === 1 ? '' : 's'} left${settled ? ' (every taper settled)' : ''}`, { color: settled ? GREEN : MUTED, maxWidth: 380 });
  }

  /** One spell card (mockup 1): icon, name, Mana / Diff, school, one line of description, the formula. */
  private card(kit: VTankKit, m: SplitpeaModel, s: SplitpeaSpell, index: number, select: () => void): HTMLElement {
    const row = kit.row(s.id === this.selected, select);
    row.dataset.splitpeaCard = String(s.id);
    row.dataset.index = String(index);
    place(row, 0, index * SPLITPEA_CARD, 368, SPLITPEA_CARD - 2);
    row.appendChild(place(kit.icon(s.icon, 24), 4, 4));
    row.appendChild(place(kit.text(s.name, { color: GOLD }), 34, 2));
    row.appendChild(place(kit.text(`Mana ${s.mana}   Diff ${s.difficulty}`, { color: MUTED }), 206, 4));
    row.appendChild(place(kit.text(SPLITPEA_SCHOOLS[s.school] ?? '', { color: MUTED }), 318, 4));
    row.appendChild(place(kit.text(s.desc.length > 54 ? `${s.desc.slice(0, 52)}…` : s.desc, { color: MUTED, maxWidth: 330 }), 34, 18));
    let x = 34;
    for (const v of m.view(s.id)) {
      if (v.kind === 'open') {
        const text = openSlotText(v.ids, (id) => this.name(id));
        const t = kit.text(text, { color: RED });
        t.dataset.splitpeaOpen = String(v.slot);
        t.title = `${v.role}: ${v.ids.map((id) => this.name(id)).join(', ') || 'no key fits'}`;
        row.appendChild(place(t, x, 39));
        x += 8 + (v.ids.length > 0 && v.ids.length <= 3 ? text.length * 6 : 36);
      } else {
        const ic = kit.icon(this.reads.component(v.id)?.icon ?? 0, 16);
        ic.title = `${v.role}: ${this.name(v.id)}`;
        ic.dataset.splitpeaSlot = `${v.slot}:${v.kind}`;
        row.appendChild(place(ic, x, 37));
        if (v.kind === 'solved') row.appendChild(place(kit.text('✓', { color: GREEN }), x + 11, 30));
        x += 20;
      }
    }
    return row;
  }

  /** Known Tapers (mockup 2): each found taper with where it came from; Add… / Remove; the keys left. */
  private renderKnown(body: HTMLElement, kit: VTankKit, m: SplitpeaModel, redraw: () => void): void {
    body.appendChild(place(kit.text('Tapers you have found. Each one narrows the rest.', { color: MUTED }), 8, 26));
    const host = place(document.createElement('div'), 6, 46, 384, 348);
    host.style.overflow = 'hidden';
    const inner = document.createElement('div');
    inner.style.position = 'relative';
    ['Spell', 'Taper 2', 'Taper 3', 'From'].forEach((h, i) => inner.appendChild(place(kit.text(h, { color: GOLD }), [4, 170, 240, 306][i], 0)));
    const bySpell = new Map<number, { t2?: number; t3?: number; source: string }>();
    for (const k of m.knownTapers()) {
      const e = bySpell.get(k.spell) ?? { source: k.source };
      if (k.slot === 3) e.t2 = k.taper; else e.t3 = k.taper;
      if (k.source === 'entered') e.source = 'entered';
      bySpell.set(k.spell, e);
    }
    const ids = [...bySpell.keys()].sort((a, b) => (m.spell(a)?.name ?? '').localeCompare(m.spell(b)?.name ?? ''));
    if (this.knownSel !== null && !bySpell.has(this.knownSel)) this.knownSel = null;
    let y = 20;
    for (const id of ids) {
      const e = bySpell.get(id)!;
      const row = kit.row(id === this.knownSel, () => { this.knownSel = id; this.selected = id; redraw(); });
      row.dataset.splitpeaKnown = String(id);
      place(row, 0, y, 368, 18);
      row.appendChild(place(kit.text(m.spell(id)?.name ?? `Spell ${id}`, { color: TEXT }), 4, 1));
      row.appendChild(place(kit.text(e.t2 !== undefined ? taperShortName(this.name(e.t2)) : '-', { color: TEXT }), 170, 1));
      row.appendChild(place(kit.text(e.t3 !== undefined ? taperShortName(this.name(e.t3)) : '-', { color: TEXT }), 240, 1));
      row.appendChild(place(kit.text(e.source, { color: MUTED }), 306, 1));
      inner.appendChild(row);
      y += 18;
    }
    if (ids.length === 0) inner.appendChild(place(kit.text('None yet. Spells you know add theirs; Add... enters one.', { color: MUTED }), 4, 20));
    inner.style.height = `${y}px`;
    host.appendChild(inner);
    kit.list(host);
    body.appendChild(host);
    body.appendChild(place(kit.flatButton('Add...', () => this.openEdit(redraw), 70, 20), 8, 402));
    body.appendChild(place(kit.flatButton('Remove', () => { if (this.knownSel !== null) { m.remove(this.knownSel); this.knownSel = null; redraw(); } }, 70, 20), 84, 402));
    const keys = m.keysLeft();
    // Right-aligned inside the window: "1,299,827 taper keys left" from a fixed left ran into the frame.
    const keysEl = kit.text(m.conflict() ? 'No key fits' : `${keys.toLocaleString('en-US')} taper key${keys === 1 ? '' : 's'} left`, { color: m.conflict() ? RED : keys === 1 ? GREEN : MUTED });
    keysEl.dataset.splitpeaKeys = '1';
    Object.assign(keysEl.style, { position: 'absolute', right: '10px', top: '405px' });
    body.appendChild(keysEl);
  }

  /** Options: two list filters, kept per browser. */
  private renderOptions(body: HTMLElement, kit: VTankKit, redraw: () => void): void {
    const opt = (y: number, label: string, on: boolean, flip: () => void, note: string) => {
      const c = kit.check(on, () => { flip(); this.saveOptions(); this.scrollTop = 0; redraw(); });
      c.dataset.splitpeaOption = label;
      body.appendChild(place(c, 10, y));
      body.appendChild(place(kit.text(label, { color: TEXT }), 32, y));
      body.appendChild(place(kit.text(note, { color: MUTED, maxWidth: 340 }), 32, y + 16));
    };
    opt(32, 'Hide spells whose tapers are all known', this.options.hideSettled, () => { this.options.hideSettled = !this.options.hideSettled; }, 'Leaves the spells you still have tapers to find.');
    opt(76, 'Only spells you have the components for', this.options.carriedOnly, () => { this.options.carriedOnly = !this.options.carriedOnly; }, 'Every known component in your pack, and at least one of the tapers an open slot could be.');
  }

  /** Edit Tapers (mockup 3): one row per formula slot; an unknown personal taper is a dropdown, the narrowed set first. */
  openEdit(redrawMain: () => void): void {
    const host = this.host;
    const m = this.ensure();
    const s = this.selected === null ? undefined : m?.spell(this.selected);
    if (!host || !m) return;
    if (!s || m.personalSlots(s.id).length === 0) {
      this.notice = { text: 'Pick a spell with a Taper 2 or Taper 3 on the Spell List', color: GOLD };
      redrawMain();
      return;
    }
    this.draft = new Map();
    host.closeAux(SPLITPEA_EDIT_KEY);
    host.openAux(SPLITPEA_EDIT_KEY, 'Edit Tapers', SPLITPEA_EDIT_FRAME.w, SPLITPEA_EDIT_FRAME.h, (body, redraw, close) => this.renderEdit(body, s, redraw, () => { close(); redrawMain(); }));
  }

  private renderEdit(body: HTMLElement, s: SplitpeaSpell, redraw: () => void, close: () => void): void {
    const kit = this.host?.kit;
    const m = this.model;
    if (!kit || !m) return;
    body.innerHTML = '';
    body.appendChild(place(kit.icon(s.icon, 24), 8, 6));
    body.appendChild(place(kit.text(s.name, { color: GOLD }), 38, 4));
    body.appendChild(place(kit.text('Enter the tapers you found by research. The rest are worked out from them.', { color: MUTED, maxWidth: 280 }), 38, 20));
    const personal = new Set(m.personalSlots(s.id).map((p) => p.slot));
    const known = new Map(m.knownTapers().filter((k) => k.spell === s.id).map((k) => [k.slot, k] as const));
    m.view(s.id).forEach((v: SplitpeaSlot, i) => {
      const y = 48 + i * 20;
      body.appendChild(place(kit.text(v.role, { color: MUTED }), 10, y + 2));
      const fromBook = known.get(v.slot)?.source === 'spellbook';
      if (personal.has(v.slot) && !fromBook) {
        const chosen = this.draft.has(v.slot) ? this.draft.get(v.slot)! : (known.get(v.slot)?.taper ?? null);
        const narrowed = v.kind === 'open' ? v.ids : v.kind === 'solved' ? [v.id] : [];
        const label = chosen !== null ? this.name(chosen) : narrowed.length > 0 && narrowed.length <= 3 ? `Unknown (${narrowed.map((id) => taperShortName(this.name(id))).join(' / ')})` : v.kind === 'solved' ? `Unknown (${taperShortName(this.name(v.id))}, worked out)` : 'Unknown';
        const items: MenuItem[] = [{ label: 'Unknown', value: '' }];
        // The narrowed set first, then the colours no key left gives.
        const rest = Array.from({ length: TAPER_COLOR_COUNT }, (_, k) => LOWEST_TAPER_ID + k).filter((id) => !narrowed.includes(id));
        for (const id of narrowed) items.push({ label: this.name(id), value: String(id), hint: 'possible' });
        for (const id of rest) items.push({ label: this.name(id), value: String(id), hint: 'ruled out' });
        const dd = kit.dropdown(label, (anchor) => kit.menu(anchor, items, (val) => { this.draft.set(v.slot, val === '' ? null : Number(val)); redraw(); }), 180);
        dd.dataset.splitpeaEditSlot = String(v.slot);
        body.appendChild(place(dd, 80, y));
      } else {
        const id = v.kind === 'open' ? 0 : v.id;
        body.appendChild(place(kit.icon(this.reads.component(id)?.icon ?? 0, 16), 80, y));
        const note = v.kind === 'solved' ? '   (worked out)' : fromBook ? '   (spellbook)' : '';
        body.appendChild(place(kit.text(this.name(id) + note, { color: v.kind === 'solved' ? GREEN : TEXT }), 100, y + 1));
      }
    });
    const save = kit.flatButton('Save', () => {
      for (const [slot, taper] of this.draft) m.enter(s.id, slot, taper);
      this.draft = new Map();
      close();
    }, 70, 20);
    body.appendChild(place(save, 160, 216));
    body.appendChild(place(kit.flatButton('Cancel', () => { this.draft = new Map(); close(); }, 70, 20), 240, 216));
  }
}

function place<T extends HTMLElement>(el: T, x: number, y: number, w?: number, h?: number): T {
  Object.assign(el.style, { position: 'absolute', left: `${x}px`, top: `${y}px` });
  if (w) el.style.width = `${w}px`;
  if (h) el.style.height = `${h}px`;
  return el;
}

function tagged<T extends HTMLElement>(el: T, key: string, value: string): T {
  el.dataset[key] = value;
  return el;
}
