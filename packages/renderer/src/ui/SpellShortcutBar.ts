/**
 * SpellShortcutBar — the retail spell bar's shortcut list + selection model
 * (CORE.17.k.b.b.a.g.c), ported from the decompiled EoL client
 * (reference/client-eol/decomp/acclient-decompiled.c) and layout 0x21000010.
 *
 * Each of the eight tabs is a `SpellCastSubMenu` (gmSpellcastingUI's
 * m_subMenus[8], ctor @ 004c5c40): an ordered ItemList of spell shortcuts
 * (0x100000b6 in every page 0x100000aa…0x100005c3, template 0x10000341,
 * 32x32 cells at (23,2) 639x32) with its own `m_selectedSpellID`.
 *
 *  - `ListenToElementMessage @ 004c7ab0`: message 0x1c on a shortcut,
 *    dwParam1 7 (a click) → `SetSelected(spellID)` + UpdateEndowmentIcon +
 *    UpdateCastButtonTooltip; dwParam1 10 (a double-click) → `Cast`.
 *    Message 1 on 0x100000b2 → `Cast`.
 *  - `Cast @ 004c6050`: the open tab's selection; none → "You must select a
 *    spell to cast" through SendNotice_DisplayStringInfo(0x1a); else
 *    ClientMagicSystem::CastSpell(id, true).
 *  - `RecvNotice_CastQuickslotSpell @ 004c78b0` (the Spell Slot N keys): the
 *    open tab's Nth item → SetSelected + the two updates + Cast.
 *  - `SetSelected @ 004c5b00`: every item's SetSelectedState(1 for the id,
 *    0 otherwise), ScrollToView; `m_selectedSpellID = id` (0 = none).
 *  - `SelectSpellFromIndex @ 004c5b90`, `RecvNotice_Next/Prev/First/Last
 *    SpellSelection @ 004c7460 / 004c75d0 / 004c77a0 / 004c7820`: the
 *    selection keys walk the list, wrapping.
 *  - `AddFavorite @ 004c7060`: RemoveSpellFromMenu (a move within the tab —
 *    the index shifts down when the old slot was before it), insert at the
 *    index (−1 = append), AddSpellToPlayerModule (Event_AddSpellFavorite),
 *    `SetSelected(the new spell)`, UpdateShortcutOverlays.
 *  - `RemoveSpellFromMenu @ 004c68f0`: RemoveSpellFromPlayerModule
 *    (Event_RemoveSpellFavorite) and `SetSelected(0)` when it was selected.
 *  - `UpdateShortcutOverlays @ 004c5be0`: item i gets SetShortcutNum(i for
 *    0..8, else −1). `UIElement_UIItem::SetShortcutNum @ 004e1590`: −1 hides
 *    0x1000034a; an EMPTY icon (state 0x1000001c) draws prop 0x1000005e[n]
 *    (0x060010fa+n, the engraved digit tile), else 0x10000042[n]
 *    (0x060019ed+n, the white corner numeral) or 0x10000043[n] ghosted.
 *  - `UIElement_ItemList::ItemList_AddSpellShortcut @ 004e40a0` +
 *    `UpdateEmptySlots @ 004e3700` with p0x10000017: one EMPTY item trails
 *    the shortcuts (the drop target — reddit-shutdown.jpg's lone "1" tile).
 *  - `UIElement_UIItem::SetSelectedState @ 004e1240`: the overlay
 *    0x10000342 (media 0x06004d21) shown for the selected item.
 */

// SpellFlags.SelfTargeted (CSpellBase::_bitfield & 8) — one source, shared with CastTargeting.
import { SPELL_FLAG_SELF_TARGETED } from '@ac/shared';

/* ── layout 0x21000010 / template 0x10000341 ───────────────────────── */

/** The shortcut ItemList in every tab page (0x2100003d:0x10000339 base). */
export const SPELL_SHORTCUT_LIST = 0x100000b6;
/** The list's p0x1000000e: the UIItem template root in 0x21000037. */
export const SPELL_SHORTCUT_TEMPLATE = 0x10000341;
/** The list's rect inside the tab page (p0x10000057 / p0x10000059 = the 32 px cell). */
export const SPELL_SHORTCUT_LIST_RECT = { x: 23, y: 2, width: 639, height: 32 } as const;
export const SPELL_SHORTCUT_CELL = 32;
/** floor(639 / 32): the cells the list can show. */
export const SPELL_SHORTCUT_VISIBLE = Math.floor(SPELL_SHORTCUT_LIST_RECT.width / SPELL_SHORTCUT_CELL);
/** 0x10000341's root media + the icon 0x1000033b's EMPTY-state media: the dark leather recess. */
export const SPELL_SHORTCUT_SLOT_MEDIA = 0x06001a97;
/** 0x10000342 (m_elem_Icon_Selected): the selected overlay. */
export const SPELL_SHORTCUT_SELECTED_ELEMENT = 0x10000342;
export const SPELL_SHORTCUT_SELECTED_MEDIA = 0x06004d21;
/** 0x1000034a (m_elem_Icon_ShortcutNum) and its three media tables. */
export const SPELL_SHORTCUT_NUM_ELEMENT = 0x1000034a;
export const SHORTCUT_NUM_FILLED_BASE = 0x060019ed;   // prop 0x10000042[n]
export const SHORTCUT_NUM_GHOSTED_BASE = 0x06001acc;  // prop 0x10000043[n]
export const SHORTCUT_NUM_EMPTY_BASE = 0x060010fa;    // prop 0x1000005e[n]
/**
 * The pack / paperdoll UIItem's own 0x1000034a tables (overlay template
 * 0x21000037:0x10000346, under the inventory cell template 0x1000033a and
 * the paperdoll slot templates): p0x10000042 = 0x0600109e+n (a cream tag
 * with the digit, gold-striped corner) for n 0..8, then the blank tag
 * 0x060074d3; p0x10000043 = 0x06001acc+n, then 0x060074d2. No EMPTY table
 * (p0x1000005e) — an empty pack cell has no object, so no number.
 */
export const ITEM_OVERLAY_SHORTCUT_NUM_BASE = 0x0600109e;
export const ITEM_OVERLAY_SHORTCUT_NUM_BLANK = 0x060074d3;
export const ITEM_OVERLAY_SHORTCUT_NUM_GHOSTED_BLANK = 0x060074d2;
/**
 * The pack / paperdoll UIItem's waiting ghost, overlays 0x21000037:0x10000346
 * child 0x10000349 (m_elem_Icon_Ghosted, 32x32 at (0,0), p59 hidden): media
 * 0x0600109a, a dark checker stipple. UIElement_UIItem::SetWaitingState @
 * 004e11b0 shows it while ACCWeenieObject::waiting is set.
 */
export const ITEM_WAITING_GHOST_ELEMENT = 0x10000349;
export const ITEM_WAITING_GHOST_MEDIA = 0x0600109a;
/**
 * The UIItem's sell-state badge, overlays 0x21000037:0x10000346 child
 * 0x10000437 (m_elem_Icon_SellState, 32x32 at (0,0), p59 hidden): media
 * 0x060012d9, a small check tag in the top-left corner. UIElement_UIItem::
 * UIItem_Update @ 004e21d0 shows it while ACCWeenieObject::sellState is set
 * (the object waits on the vendor's sell list).
 */
export const ITEM_SELL_STATE_ELEMENT = 0x10000437;
export const ITEM_SELL_STATE_MEDIA = 0x060012d9;
/** ACCWeenieObject::shortcutNum spans the toolbar's 18 slots (gmToolbarUI::AddShortcut @ 004bd9a0). */
export const ITEM_SHORTCUT_SLOTS = 18;

/**
 * UIElement_UIItem::SetShortcutNum @ 004e1590 on a pack or paperdoll UIItem:
 * UIItem_Update @ 004e21d0 hands it the object's ACCWeenieObject::shortcutNum
 * (the toolbar slot that holds it, set by gmToolbarUI::AddShortcut) and
 * m_bShortcutGhosted (the toolbar's magic-mode ghosting, propagated by the
 * toolbar UIItem's own SetShortcutNum). Null = hidden (shortcutNum −1).
 */
export function itemOverlayShortcutNumMedia(index: number, ghosted = false): number | null {
  if (index < 0 || index >= ITEM_SHORTCUT_SLOTS) return null;
  if (index < MAX_NUMBERED_SHORTCUTS) return (ghosted ? SHORTCUT_NUM_GHOSTED_BASE : ITEM_OVERLAY_SHORTCUT_NUM_BASE) + index;
  return ghosted ? ITEM_OVERLAY_SHORTCUT_NUM_GHOSTED_BLANK : ITEM_OVERLAY_SHORTCUT_NUM_BLANK;
}

/** UpdateShortcutOverlays: indices 0..8 carry a numeral, the rest −1. */
export const MAX_NUMBERED_SHORTCUTS = 9;
/** UIItem icon states. */
export const UIITEM_STATE_EMPTY = 0x1000001c;
export const UIITEM_STATE_FILLED = 0x1000001d;

/** gmSpellcastingUI::Cast @ 004c6050 — the 0x1a spew with no selection. */
export const CAST_NO_SPELL_SELECTED_TEXT = 'You must select a spell to cast';

/* ── the endowment icon 0x100000b1 (CORE.17.k.b.b.a.g.e) ───────────── */

/**
 * gmSpellcastingUI::PostInit: m_endowmentIcon 0x100000b1 (32x32 at (4,24) in
 * 0x1000009f) with m_endowmentIcon_Underlay 0x10000452 (the spell's icon),
 * m_endowmentIcon_Overlay 0x10000453 (the item's drag icon) and
 * m_endowmentIcon_Selected 0x10000454 (media 0x06004d09, p59 hidden until
 * m_endowmentSelected).
 */
export const SPELLBAR_ENDOWMENT_UNDERLAY = 0x10000452;
export const SPELLBAR_ENDOWMENT_OVERLAY = 0x10000453;
export const SPELLBAR_ENDOWMENT_SELECTED = 0x10000454;
export const SPELLBAR_ENDOWMENT_SELECTED_MEDIA = 0x06004d09;
/** UpdateEndowmentIcon @ 004c6120: ACCWeenieObject::GetObjectAtLocation(player, 0x1000000, 0) — the Held (caster) location. */
export const ENDOWMENT_LOCATION = 0x1000000;
/** The endowment icon's tooltip format (.rdata 0x7b62a8): %s = the item's name (GetObjectNameWide, 2), %hs = CSpellBase::InqName. */
export const ENDOWMENT_ICON_TOOLTIP_FORMAT = '%s (%hs)\nDouble-click to cast this spell';
/** ItemHolder::UseObject @ 00588a80 (param_2 set, a targeted item, no ACCWeenieObject::selectedID): the 0x1a spew (.rdata 0x7e2ba8). */
export const USE_OBJECT_SELECT_TARGET_FORMAT = 'Select your target before using the %s';

/** UpdateEndowmentIcon's tooltip: "%s (%hs)\nDouble-click to cast this spell". */
export function endowmentIconTooltip(itemName: string, spellName: string): string {
  return ENDOWMENT_ICON_TOOLTIP_FORMAT.replace('%s', itemName).replace('%hs', spellName);
}

/** ItemHolder::UseObject's no-selection notice for a targeted item used from the Cast path. */
export function useObjectSelectTargetText(itemName: string): string {
  return USE_OBJECT_SELECT_TARGET_FORMAT.replace('%s', itemName);
}

/**
 * ItemUses::IsUseable_SelfTarget @ 004fcd30: the TARGET half of the item's
 * ItemUseable bits (>> 16) carries USEABLE_SELF (0x2 — ACE Usable.Self).
 */
export function isUseableSelfTarget(usable: number | undefined): boolean {
  return ((((usable ?? 0) >>> 16) & 0xffff) & 0x2) !== 0;
}

/** The wielded item UpdateEndowmentIcon draws: the one at the Held location that carries a pwd._spellID. */
export interface EndowmentSource { id: number; name: string; slot: number; spellDid?: number }
export function findEndowment<T extends EndowmentSource>(equipped: readonly T[]): T | null {
  return equipped.find((e) => (e.slot & ENDOWMENT_LOCATION) !== 0 && !!e.spellDid) ?? null;
}

/** The tab ids in GetNextTabID @ 004c5810 order (0x100000a9 → 0x100005c2 → 0x100000a3). */
export const SPELL_BAR_TAB_IDS = [0x100000a3, 0x100000a4, 0x100000a5, 0x100000a6, 0x100000a7, 0x100000a8, 0x100000a9, 0x100005c2] as const;
export const SPELL_BAR_PAGE_IDS = [0x100000aa, 0x100000ab, 0x100000ac, 0x100000ad, 0x100000ae, 0x100000af, 0x100000b0, 0x100005c3] as const;

/**
 * UIElement_UIItem::SetShortcutNum @ 004e1590 → the 0x1000034a media for a
 * shortcut at `index` (null = hidden, SetShortcutNum(−1)).
 */
export function shortcutNumMedia(index: number, opts: { empty?: boolean; ghosted?: boolean } = {}): number | null {
  if (index < 0 || index >= MAX_NUMBERED_SHORTCUTS) return null;
  if (opts.empty) return SHORTCUT_NUM_EMPTY_BASE + index;
  return (opts.ghosted ? SHORTCUT_NUM_GHOSTED_BASE : SHORTCUT_NUM_FILLED_BASE) + index;
}

/** SpellCastSubMenu::UpdateShortcutOverlays @ 004c5be0: the number each item carries. */
export function shortcutNumForIndex(index: number): number {
  return index >= 0 && index < MAX_NUMBERED_SHORTCUTS ? index : -1;
}

/** GetNextTabID @ 004c5810 / GetPrevTabID @ 004c5890: the tabs wrap. */
/** The eight tab pages (each holds a shortcut list 0x100000b6). */
export const SPELL_BAR_CONTENT_IDS = [0x100000aa, 0x100000ab, 0x100000ac, 0x100000ad, 0x100000ae, 0x100000af, 0x100000b0, 0x100005c3] as const;

/**
 * BUG.spellbar-classic-clip — the cells the shortcut list shows.
 * UIElement_ItemList::UpdateEmptySlots @ 004e3700: with attributes
 * 0x10000015 = −1 and 0x5f (p95) = −1 the list pads its visible WIDTH with
 * EMPTY items — (width − items·cell) / cell of them — then, under
 * p0x10000017, adds one more when the last item is filled. The numbered
 * cells (UpdateShortcutOverlays) are the shortcuts plus that one trailing
 * drop target; the padding is plain recesses. reddit-shutdown.jpg (EoL, an
 * empty tab): the engraved "1" + twelve recesses in the 439 px reflowed list.
 */
export function spellListPaddedCells(listWidth: number, numberedCells = 1): number {
  return Math.max(numberedCells, Math.floor(listWidth / SPELL_SHORTCUT_CELL));
}

/**
 * The era's tab count clamped to the eight tab pages the layout has (BUG.ac1999-spell-tabs:
 * eraClientRules().spellBarTabs — 8 for end of retail and the classic eras, 1 for the 1999 bar).
 */
export function clampSpellBarTabCount(count: number): number {
  return Number.isInteger(count) ? Math.max(1, Math.min(SPELL_BAR_TAB_IDS.length, count)) : SPELL_BAR_TAB_IDS.length;
}
export function nextSpellBarTab(tab: number, count: number = SPELL_BAR_TAB_IDS.length): number { const n = clampSpellBarTabCount(count); return (tab + 1) % n; }
export function prevSpellBarTab(tab: number, count: number = SPELL_BAR_TAB_IDS.length): number { const n = clampSpellBarTabCount(count); return (tab + n - 1) % n; }

/* ── the per-tab sub-menu ──────────────────────────────────────────── */

export type SpellBarEvent =
  | { kind: 'remove'; spellId: number }
  | { kind: 'add'; spellId: number; index: number };

/**
 * One SpellCastSubMenu: the ordered shortcuts of a tab and its selection.
 * Pure — the events it returns are the PlayerModule / server round-trips
 * (Event_AddSpellFavorite / Event_RemoveSpellFavorite) the caller ships.
 */
export class SpellCastSubMenu {
  /** The ItemList's shortcuts in order (the favorites list). */
  spells: number[] = [];
  /** m_selectedSpellID (0 = none). */
  selectedSpellId = 0;
  /**
   * m_endowmentSelected (CORE.17.k.b.b.a.g.e): the tab's selection is the
   * endowment icon 0x100000b1 — set with SetSelected(0) by a click on the
   * icon, UpdateEndowmentIcon (present + no spell selected) and the
   * selection walks; cleared by SetSelected of a spell the list carries.
   */
  endowmentSelected = false;

  constructor(public readonly tabIndex: number = 0) {}

  /** m_numSpells. */
  get numSpells(): number { return this.spells.length; }

  /** UpdateFromPlayerModule @ 004c6570: the list from the PlayerModule, then SetSelected(m_selectedSpellID) re-applied. */
  setSpells(spells: readonly number[]): void {
    this.spells = spells.filter((id) => id !== 0);
    this.setSelected(this.selectedSpellId);
  }

  /**
   * SetSelected @ 004c5b00: every item's SetSelectedState; the item whose
   * spellID matches also clears m_endowmentSelected (only that branch does —
   * SetSelected(0) leaves the flag as the caller set it).
   */
  setSelected(spellId: number): void {
    if (spellId !== 0 && this.spells.includes(spellId)) this.endowmentSelected = false;
    this.selectedSpellId = spellId;
  }

  /** ListenToElementMessage on 0x100000b1 dwParam1 7 (and the walks' endowment branch): m_endowmentSelected = true, SetSelected(0). */
  selectEndowment(): void {
    this.endowmentSelected = true;
    this.setSelected(0);
  }

  /** The item list index of the selection (−1 when none / not on this tab). */
  get selectedIndex(): number {
    return this.selectedSpellId === 0 ? -1 : this.spells.indexOf(this.selectedSpellId);
  }

  /** SelectSpellFromIndex @ 004c5b90. */
  selectSpellFromIndex(index: number): boolean {
    const id = this.spells[index];
    if (!id) return false;
    this.setSelected(id);
    return true;
  }

  /**
   * RecvNotice_NextSpellSelection @ 004c7460: an empty list is a no-op
   * unless the endowment is present (m_endowmentPresent → the endowment);
   * from the endowment → the first item; else the item after the selection,
   * wrapping to the endowment when present or to the first; nothing selected
   * → the first. The order is endowment, item 0 … item N−1.
   */
  selectNext(endowmentPresent = false): boolean {
    if (this.spells.length === 0) {
      if (!endowmentPresent) return false;
      this.selectEndowment();
      return true;
    }
    if (this.endowmentSelected) return this.selectSpellFromIndex(0);
    const i = this.selectedIndex;
    let next = i < 0 ? 0 : i + 1;
    if (next === this.spells.length) {
      if (endowmentPresent) { this.selectEndowment(); return true; }
      next = 0;
    }
    return this.selectSpellFromIndex(next);
  }

  /**
   * RecvNotice_PrevSpellSelection @ 004c75d0: the mirror — from the endowment
   * → the last item; before the first item → the endowment when present,
   * else the last; nothing selected → the first.
   */
  selectPrev(endowmentPresent = false): boolean {
    if (this.spells.length === 0) {
      if (!endowmentPresent) return false;
      this.selectEndowment();
      return true;
    }
    if (this.endowmentSelected) return this.selectSpellFromIndex(this.spells.length - 1);
    const i = this.selectedIndex;
    let prev = i < 0 ? 0 : i - 1;
    if (prev < 0) {
      if (endowmentPresent) { this.selectEndowment(); return true; }
      prev = this.spells.length - 1;
    }
    return this.selectSpellFromIndex(prev);
  }

  /** RecvNotice_FirstSpellSelection @ 004c77a0: the endowment when present, else the first item. */
  selectFirst(endowmentPresent = false): boolean {
    if (endowmentPresent) { this.selectEndowment(); return true; }
    return this.selectSpellFromIndex(0);
  }

  /** RecvNotice_LastSpellSelection @ 004c7820: the last item, or the endowment when the list is empty and it is present. */
  selectLast(endowmentPresent = false): boolean {
    if (this.spells.length > 0) return this.selectSpellFromIndex(this.spells.length - 1);
    if (endowmentPresent) { this.selectEndowment(); return true; }
    return false;
  }

  /**
   * AddFavorite @ 004c7060: RemoveSpellFromMenu first (a spell already on the
   * tab moves — its removal shifts an index past it down by one), insert at
   * `index` (−1 / past the end = append), select it. Returns the round-trips
   * in order: Remove for a move, then Add with the index retail ships
   * (the shifted request as given, or m_numSpells after the add for −1 —
   * ACE's AddSpellToBar clamps an index past the end to the end).
   */
  addFavorite(spellId: number, index = -1): SpellBarEvent[] {
    if (spellId === 0) return [];
    const events: SpellBarEvent[] = [];
    const prev = this.removeSpell(spellId);
    if (prev !== -1) {
      events.push({ kind: 'remove', spellId });
      if (index !== -1 && prev < index) index -= 1;
    }
    const at = index < 0 || index > this.spells.length ? this.spells.length : index;
    this.spells.splice(at, 0, spellId);
    events.push({ kind: 'add', spellId, index: index === -1 ? this.spells.length : index });
    this.setSelected(spellId);
    return events;
  }

  /**
   * RemoveSpellFromMenu @ 004c68f0: the spell's index (−1 when absent); the
   * selection clears when it was the selected one. The caller ships
   * Event_RemoveSpellFavorite when the index is not −1.
   */
  removeSpell(spellId: number): number {
    const i = spellId === 0 ? -1 : this.spells.indexOf(spellId);
    if (i === -1) return -1;
    this.spells.splice(i, 1);
    if (this.selectedSpellId === spellId) this.setSelected(0);
    return i;
  }

  /**
   * The cells the ItemList shows: the shortcuts, then ONE trailing EMPTY
   * item (ItemList_AddSpellShortcut → UpdateEmptySlots with p0x10000017),
   * clipped to the 19 the 639 px list fits.
   */
  cells(): Array<{ index: number; spellId: number; empty: boolean; selected: boolean; numeral: number | null }> {
    const out = [] as Array<{ index: number; spellId: number; empty: boolean; selected: boolean; numeral: number | null }>;
    const n = Math.min(this.spells.length + 1, SPELL_SHORTCUT_VISIBLE);
    for (let i = 0; i < n; i++) {
      const spellId = this.spells[i] ?? 0;
      const empty = spellId === 0;
      out.push({
        index: i, spellId, empty,
        selected: !empty && spellId === this.selectedSpellId,
        numeral: shortcutNumMedia(shortcutNumForIndex(i), { empty }),
      });
    }
    return out;
  }
}

/**
 * SWEEP1006B.magic-casting.forgotten-spell-stays-spell-bar —
 * SpellCastSubMenu::UpdateFromPlayerModule @ 004c6570 for every tab
 * (gmSpellcastingUI::RecvNotice_SpellRemoved @ 004c6a00 and
 * RecvNotice_PlayerDescReceived @ 004c69a0 loop all 8): each favorite whose
 * spell CACQualities::IsSpellKnown no longer knows is dropped — the rest
 * close up in order — and RemoveSpellFromPlayerModule @ 004c6410 sends
 * Event_RemoveSpellFavorite(spell, tab) for it.
 */
export function pruneUnknownSpellFavorites(
  tabs: ReadonlyArray<ReadonlyArray<number>>, isKnown: (spellId: number) => boolean,
): { tabs: number[][]; removed: Array<{ spellId: number; tab: number }> } {
  const removed: Array<{ spellId: number; tab: number }> = [];
  const out = tabs.map((ids, tab) => {
    const kept: number[] = [];
    for (const id of ids) {
      if (!id) continue;
      if (isKnown(id)) kept.push(id);
      else removed.push({ spellId: id, tab });
    }
    return kept;
  });
  return { tabs: out, removed };
}

/**
 * The login restore (gmSpellcastingUI::RecvNotice_PlayerDescReceived @
 * 004c69a0 → UpdateFromPlayerModule on every tab): PlayerDescription's 8
 * favorites lists pruned of unknown spells (one removal each for the
 * server), resolved to definitions, padded to the 9-slot shape the bar's
 * older callers expect. Nothing is cut at 9: the favorites list is
 * unbounded. Only the era's `tabCount` tabs are read (BUG.ac1999-spell-tabs:
 * the 1999 client has one bar); any list past them is left empty and never
 * pruned, so no removal for a tab the era lacks goes to the server.
 */
export function restoreSpellBars<T>(
  spellBars: ReadonlyArray<ReadonlyArray<number>>, isKnown: (spellId: number) => boolean, resolve: (spellId: number) => T | null | undefined,
  tabCount: number = SPELL_BAR_TAB_IDS.length,
): { slots: Array<Array<T | null>>; removed: Array<{ spellId: number; tab: number }>; restored: number } {
  const n = clampSpellBarTabCount(tabCount);
  const { tabs, removed } = pruneUnknownSpellFavorites(Array.from({ length: 8 }, (_, t) => (t < n ? spellBars[t] ?? [] : [])), isKnown);
  let restored = 0;
  const slots = tabs.map((ids) => {
    const page: Array<T | null> = [];
    for (const id of ids) { const sp = resolve(id); if (sp) { page.push(sp); restored++; } }
    while (page.length < 9) page.push(null);
    return page;
  });
  return { slots, removed, restored };
}

/* ── the Cast button's target logic ────────────────────────────────── */

/** ItemType bits ObjectCompatibleWithSpellTargetType @ 00567230 treats as "may target the caster" (param_2 & 0x8107). */
export const SELF_TARGETABLE_TYPE_MASK = 0x8107;

/**
 * UpdateCastButtonTooltip's "CAST %hs" branch: the self bit, or
 * CSpellBase::IsUntargeted @ 005974a0 — the FORMULA's targeting type is 0
 * (`formulaTargetingType` = spellFormulaTargetingType(spell.formula); retail
 * never consults the DAT NonComponentTargetType here).
 */
export function spellNeedsNoTarget(bitfield: number, formulaTargetingType: number): boolean {
  return (bitfield & SPELL_FLAG_SELF_TARGETED) !== 0 || formulaTargetingType === 0;
}

/** PublicWeenieDesc._bitfield Attackable (ObjectDescriptionFlag 0x10). */
const PWD_ATTACKABLE = 0x10;

/**
 * The ACCWeenieObject facts ObjectCompatibleWithSpellTargetType reads about
 * the target. `null` = GetWeenieObject found nothing.
 */
export interface SpellTargetObject {
  /** The target is the player (CPlayerSystem::playerID). */
  isSelf: boolean;
  /** InqType (vtable +0x18): the wire ItemType. */
  itemType: number;
  /** pwd._stackSize (0 / 1 = not a stack). */
  stackSize?: number;
  /** IsPlayer (vtable +0x10). */
  isPlayer?: boolean;
  /** pwd._bitfield (ObjectDescriptionFlag); `undefined` = not known — treated as attackable (ACE's default). */
  objectDescFlags?: number;
  /** pwd._pet_owner. */
  petOwner?: number;
  /** GetObjectNameWide(NAME_APPROPRIATE) — the singular name (a stack never reaches the name). */
  name?: string;
}

/** Why ObjectCompatibleWithSpellTargetType refused (null = compatible). */
export type SpellTargetRefusal = 'no-target-type' | 'self' | 'unknown' | 'stack' | 'incompatible' | 'pet';

/**
 * ClientMagicSystem::ObjectCompatibleWithSpellTargetType @ 00567230 for a
 * non-zero target id, in retail's order:
 *  1. target type 0 → refuse ("This spell would require no target").
 *  2. the caster, with a type lacking the 0x8107 bits → 'self'.
 *  3. GetWeenieObject null → 'unknown' (silent).
 *  4. _stackSize >= 2 → 'stack'.
 *  5. `((T & InqType()) == 0 && (T & 0x8107) == 0) || (!IsPlayer() &&
 *     !(_bitfield & 0x10 Attackable))` → 'incompatible'.
 *  6. _pet_owner != 0 → 'pet'.
 */
export function spellTargetRefusal(targetType: number, target: SpellTargetObject | null): SpellTargetRefusal | null {
  if (targetType === 0) return 'no-target-type';
  if ((targetType & SELF_TARGETABLE_TYPE_MASK) === 0 && target?.isSelf) return 'self';
  if (!target) return 'unknown';
  if ((target.stackSize ?? 0) >= 2) return 'stack';
  const typeMismatch = (targetType & target.itemType) === 0 && (targetType & SELF_TARGETABLE_TYPE_MASK) === 0;
  const flags = target.objectDescFlags;
  const notAttackable = !target.isPlayer && flags !== undefined && (flags & PWD_ATTACKABLE) === 0;
  if (typeMismatch || notAttackable) return 'incompatible';
  if ((target.petOwner ?? 0) !== 0) return 'pet';
  return null;
}

/** The quiet form (param_3 = true) the Cast-button tooltip uses. */
export function objectCompatibleWithSpellTargetType(targetType: number, target: SpellTargetObject | null): boolean {
  return spellTargetRefusal(targetType, target) === null;
}

/** "Casting %hs" (.rdata 0x7ce8f0) — ObjectCompatibleWithSpell @ 00567c30's 0x1a line on a compatible target. */
export function castingSpellText(spellName: string): string {
  return `Casting ${spellName}`;
}

/**
 * The 0x1a line the loud form (param_3 = false, from CastSpell) raises for
 * a refusal; null for the silent ones.
 */
export function spellTargetRefusalText(refusal: SpellTargetRefusal, targetName: string): string | null {
  switch (refusal) {
    case 'no-target-type': return 'This spell would require no target';
    case 'self': return 'You cannot cast this spell upon yourself';
    case 'stack': return 'Cannot cast spell on a stack of items.';
    case 'incompatible':
    case 'pet': return `This spell cannot be cast on ${targetName}`;
    case 'unknown': return null;
  }
}

/**
 * The loud ObjectCompatibleWithSpell(selectedID, spell, false, true) @
 * 00567c30 CastSpell @ 00568040 runs before FreeHandsAndCastSpell: either
 * refuse (send nothing; `text` is the 0x1a line, null = silent) or pass
 * with "Casting %hs" as the 0x1a line.
 */
export function spellCastTargetCheck(
  targetType: number, target: SpellTargetObject | null, spellName: string,
): { ok: true; text: string } | { ok: false; refusal: SpellTargetRefusal; text: string | null } {
  const refusal = spellTargetRefusal(targetType, target);
  if (refusal === null) return { ok: true, text: castingSpellText(spellName) };
  return { ok: false, refusal, text: spellTargetRefusalText(refusal, target?.name ?? '') };
}
