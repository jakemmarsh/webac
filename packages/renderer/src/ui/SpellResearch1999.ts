/**
 * SpellResearch1999 — the 1999 client's Spell Research panel, ported from
 * its client.exe (Oct 1999, 4.35752; no PDB twin: the panel was cut before
 * the 2005 client). The view is GameUI.renderResearchTab; only a 1999 world
 * builds it (eraClientRules().spellResearch).
 *
 * Where it lives: MagicPanBase @ 0x54c500 builds THREE tab panels — Spellbook
 * (+0xfc), Components (+0x100) and "Create Spell" (+0x104, CreateSpellPanel,
 * ctor @ 0x5ab060) — each tab 0x5c (92) wide (MagicPanBase_CreateTopTab @
 * 0x54cca0; 2005 fits two at 0x8a). There is no LayoutDesc: the 1999 client
 * builds its interface in code and its DATs carry no 0x21 layouts
 * (docs/ac1999-support.md, "The 1999 DATs"), so the geometry below is the
 * ctor's, read from the disassembly.
 *
 * What it does (CreateSpellPanel_ListenToMessage @ 0x5ab710 and its formula
 * row, vtable 0x613a60):
 *  - the COMPONENTS grid lists every component the player carries, one icon
 *    per component name, categories 0..5 in order (CreateSpellPanel_
 *    UpdateComponents @ 0x5ab980 walks the six ComponentTracker lists:
 *    scarabs, herbs, powdered gems, alchemical substances, talismans, tapers);
 *  - clicking a grid icon appends it to the FORMULA row when the row has
 *    room (8 slots) and the player owns more of it than the row already
 *    uses; otherwise nothing happens;
 *  - dragging a grid icon onto the row inserts it at the slot under the
 *    pointer (clamped to the end; FormulaRow drop @ 0x5ac6b0); a component
 *    the row already uses as often as the player owns it is refused with
 *    "You do not have enough of this component";
 *  - picking an icon up out of the row removes it (FormulaRow @ 0x5ac5e0);
 *  - Clear (FormulaRow_Clear @ 0x5ac940) empties the row;
 *  - Test: enabled only while the row is non-empty and the player is in magic
 *    mode. A click on it while disabled out of magic mode prints "You must
 *    first enter magic mode to test spell formulae"; enabled, with nothing
 *    selected, "You must first select a target for the spell"; otherwise the
 *    row's components (WCIDtoSCID @ 0x5e46a0 of each, in row order, slots past
 *    the row 0) and the selected object go out as 0x4B ResearchSpell
 *    (the research send @ 0x4d1e90: get_selectedID → CM_Magic_Event_
 *    ResearchSpell @ 0x57c440 → PanelUI_IncrementBusyCount). The row is not
 *    cleared by a test.
 *
 * The server answers as it does a cast (AC1999 ClientEvents.cpp case
 * RESEARCH_SPELL_EVENT, SpellcastingManager.cpp BeginResearchCast /
 * ResolveResearchCast): a formula with fewer than 5 components or no
 * talisman is refused ("That is not a valid spell formula." + UseDone); a
 * well-shaped one winds up, then either casts and teaches the spell (0x4C
 * UpdateSpell → the spellbook's AddSpell) or fizzles ("Your spell fizzled.");
 * every exit ends in exactly one 0x1C7 UseDone, which releases the busy count.
 */
import { SPELL_FORMULA_SLOTS } from '@ac/network';
import { buildComponentRows, SPELL_COMPONENTS_ITEM_TYPE, type ComponentSource } from './SpellComponentList.js';

/** MagicPanBase_CreateTopTab @ 0x54cca0: the 1999 tab width (three tabs + the close box span the 300 px panel). */
export const RESEARCH_TAB_WIDTH = 0x5c;

/** The 1999 panel's own text (client.exe .rdata; addresses are virtual). */
export const RESEARCH_TEXT = Object.freeze({
  /** The tab: MagicPanBase's third CreateTopTab label. */
  tab: 'Create Spell', // 0x609a5c, beside 'Components' 0x609a6c and 'Spellbook' 0x609a78
  formula: 'FORMULA', // 0x6042f0
  components: 'COMPONENTS', // 0x613810
  test: 'Test', // 0x613808
  clear: 'Clear', // 0x613800
  /** Test's tooltip (AC_ToolTipHandler id 0x59; string 0x60e910). */
  testTip: 'Click to test your current spell formula',
  /** Clear's tooltip (id 0x58; string 0x60e974). */
  clearTip: 'Click to clear the Formula',
  /** The grid icons' tooltip (string 0x60e990). */
  cellTip: 'Drag this icon to add it to the Formula',
});

/**
 * CreateSpellPanel's layout, panel-local pixels (ctor @ 0x5ab060). The panel
 * paints 0x06001399 (300x51) tiled as its own background (Region_SetImage +
 * Region_SetTileImageState(1)).
 */
export const RESEARCH_LAYOUT = Object.freeze({
  background: 0x06001399,
  /** TextRegion (parent, 0, x 0, y 5, w parent.width, h 0x14, 'FORMULA'). */
  formulaLabel: { x: 0, y: 5, w: 300, h: 0x14 },
  /** The formula row (class 0x613a60): (0x16, 0x19) 0x100 x 0x20, eight 32 px slots. */
  formulaRow: { x: 0x16, y: 0x19, w: 0x100, h: 0x20 },
  /** TextRegion y 0x41 'COMPONENTS'. */
  componentsLabel: { x: 0, y: 0x41, w: 300, h: 0x14 },
  /** The component grid (class 0x613940): (0xc, 0x55) 0x100 x 0xc0 = 8 columns x 6 rows of 32 px. */
  grid: { x: 0xc, y: 0x55, w: 0x100, h: 0xc0 },
  /** Its VScrollbar: (0x10c, 0x55) 0x14 x 0xc0. */
  scrollbar: { x: 0x10c, y: 0x55, w: 0x14, h: 0xc0 },
  /** Buttons (x, y 0x122, width 0x6e): Test at 0x14, Clear at 0xaa. */
  test: { x: 0x14, y: 0x122, w: 0x6e },
  clear: { x: 0xaa, y: 0x122, w: 0x6e },
  cell: 32,
});

/**
 * Where a push button of `artWidth` (the interface DAT button's own width:
 * its art is one image, never stretched) sits in a 1999 button slot of
 * `slotWidth`: centred, integer pixels.
 */
export function researchButtonLeft(slotWidth: number, artWidth: number): number {
  return (slotWidth - artWidth) >> 1;
}

/** The ComponentTracker lists the 1999 panel walks (`i < 6`; 2005 added a seventh, PEAS). */
export const RESEARCH_CATEGORIES = 6;

export interface ResearchCell {
  name: string;
  wcid: number;
  scid: number;
  category: number;
  /** Owned count (ComponentData numItems: stacks summed, a stack of 0 counting 1). */
  numItems: number;
  firstObjectId: number;
}

/** The grid's icons: the ComponentTracker rows (SpellComponentList.ts) of the six 1999 categories, headers dropped. */
export function researchGridCells(
  items: readonly ComponentSource[],
  scidOf: (wcid: number) => number | undefined,
  categoryOf: (scid: number) => number | undefined,
): ResearchCell[] {
  const out: ResearchCell[] = [];
  for (const row of buildComponentRows(items, scidOf, categoryOf)) {
    if (row.kind !== 'component' || row.category >= RESEARCH_CATEGORIES) continue;
    const e = row.entry;
    out.push({ name: e.name, wcid: e.wcid, scid: e.scid, category: row.category, numItems: e.numItems, firstObjectId: e.firstObjectId });
  }
  return out;
}

/** Owned spell components by wcid (ItemType SpellComponents 0x1000; a stack of 0 counts 1, as ComponentData::AddItem). */
export function ownedComponentCounts(items: readonly ComponentSource[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const it of items) {
    if (((it.itemType ?? 0) & SPELL_COMPONENTS_ITEM_TYPE) === 0) continue;
    const n = (it.stackSize ?? 0) === 0 ? 1 : it.stackSize!;
    out.set(it.weenieClassId, (out.get(it.weenieClassId) ?? 0) + n);
  }
  return out;
}

/** A key that changes exactly when the carried components (kinds or counts) change: the ComponentTracker's "changed" verdict. */
export function researchComponentSignature(items: readonly ComponentSource[]): string {
  return [...ownedComponentCounts(items)].sort((a, b) => a[0] - b[0]).map(([w, n]) => `${w}:${n}`).join(',');
}

export type ResearchAddResult = 'added' | 'full' | 'not-enough';

/** The formula row: up to eight component wcids, in placement order. */
export class ResearchFormula {
  private slots: number[] = [];

  get wcids(): readonly number[] { return this.slots; }
  get count(): number { return this.slots.length; }

  /** How many slots already hold `wcid`. */
  uses(wcid: number): number {
    let n = 0;
    for (const w of this.slots) if (w === wcid) n++;
    return n;
  }

  /**
   * Insert `wcid` at `at` (default: the end; clamped to the end, FormulaRow
   * drop @ 0x5ac6b0). Full (8, FormulaRow_Add @ 0x5aca30) or already using
   * every one the player owns refuses.
   */
  add(wcid: number, owned: number, at: number = this.slots.length): ResearchAddResult {
    if (this.slots.length >= SPELL_FORMULA_SLOTS) return 'full';
    if (this.uses(wcid) >= owned) return 'not-enough';
    const i = Math.max(0, Math.min(Math.trunc(at), this.slots.length));
    this.slots.splice(i, 0, wcid);
    return 'added';
  }

  /** Remove slot `i` (an icon picked up out of the row, FormulaRow @ 0x5ac5e0 / remove @ 0x5acb10). */
  removeAt(i: number): number | undefined {
    if (i < 0 || i >= this.slots.length) return undefined;
    return this.slots.splice(i, 1)[0];
  }

  /** Move slot `from` to `to` (an icon picked up out of the row and dropped back on it). */
  move(from: number, to: number): void {
    const w = this.removeAt(from);
    if (w === undefined) return;
    const i = Math.max(0, Math.min(Math.trunc(to), this.slots.length));
    this.slots.splice(i, 0, w);
  }

  /** FormulaRow_Clear @ 0x5ac940. */
  clear(): void { this.slots = []; }

  /**
   * Drop the row's uses of a component past what the player still owns, last
   * first (the row follows the ComponentTracker: FormulaRow @ 0x5ac790 /
   * 0x5ac880 remove a region whose component left the pack). True when it
   * changed.
   */
  prune(owned: (wcid: number) => number): boolean {
    let changed = false;
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const w = this.slots[i];
      if (this.uses(w) > owned(w)) { this.slots.splice(i, 1); changed = true; }
    }
    return changed;
  }

  /** The SpellFormula the row makes (FormulaRow @ 0x5ac9b0): WCIDtoSCID of each slot in order, then zeros to 8. */
  components(scidOf: (wcid: number) => number | undefined): number[] {
    const out = new Array<number>(SPELL_FORMULA_SLOTS).fill(0);
    this.slots.forEach((w, i) => { out[i] = scidOf(w) ?? 0; });
    return out;
  }
}

export type ResearchTestResult =
  /** Test is disabled and the player is in magic mode (empty row): the click does nothing. */
  | { kind: 'nothing' }
  | { kind: 'refuse'; reason: 'magicMode' | 'target' }
  | { kind: 'send'; components: number[]; target: number };

/**
 * A click on Test (CreateSpellPanel_ListenToMessage @ 0x5ab710, sender
 * testBut): the button is enabled only while the row is non-empty and the
 * player is in magic mode, and it reports clicks while disabled (ctor:
 * SetDisabled(1) + 0x451430(1)).
 */
export function testResearchFormula(o: {
  formula: ResearchFormula;
  scidOf: (wcid: number) => number | undefined;
  inMagicMode: boolean;
  /** ACCWeenieObject::get_selectedID: 0 when nothing is selected. */
  selectedId: number;
}): ResearchTestResult {
  const enabled = o.formula.count > 0 && o.inMagicMode;
  if (!enabled) return o.inMagicMode ? { kind: 'nothing' } : { kind: 'refuse', reason: 'magicMode' };
  if (!o.selectedId) return { kind: 'refuse', reason: 'target' };
  return { kind: 'send', components: o.formula.components(o.scidOf), target: o.selectedId >>> 0 };
}
