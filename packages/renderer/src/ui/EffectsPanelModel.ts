/**
 * GAP.indicator-bar-interactive — the retail Positive / Negative Effects
 * windows (gmEffectsUI, element class 0x1000001b, LayoutDesc 0x2100001b).
 *
 * Ground truth (the decompiled EoL client, build ac1_sep13):
 *
 *  - LayoutDesc 0x2100001b holds ONE window template, 0x10000122 (300x362,
 *    class 0x1000001b): the title bar 0x10000120 (0,0) 276x25, the close
 *    button 0x100000fc (276,0) 24x25, the list box 0x10000123 (0,25) 300x249
 *    (L1T1R1B1, scrollbar 0x10000124 by its p114, row template 0x10000128 by
 *    its p100), and the info block 0x10000125 (0,274) 300x88 (T2 — it rides
 *    the bottom) whose text 0x10000126 (0,8) 280x78 is centred both ways
 *    (p20 = p21 = 1) under scrollbar 0x10000127. Two elements derive from it:
 *      0x1000011f — p268435468 (attr 0x1000000c) = 1, p87 = InputAction
 *                   0x10000006 "Show/Hide Positive Magic Panel", title p23
 *                   str 3828901 "Beneficial Spells in Effect", and
 *                   p268435529 (attr 0x10000049) = true;
 *      0x10000121 — attr 0x1000000c = 2, p87 = 0x10000007 "Show/Hide
 *                   Negative Magic Panel", title str 224554165 "Harmful
 *                   Spells in Effect".
 *    The EoL floaty panels window 0x2100006e:0x100005fe stacks them in its
 *    body 0x10000180 as slots 0x10000184 (panel id 4) / 0x10000185 (panel
 *    id 5) — every slot 300x362 at (0,0), so the two draw at the same rect.
 *  - gmEffectsUI::PostInit @ 004b7560 reads attr 0x1000000c into
 *    m_effectsUIType, the info text 0x10000126 and the list box 0x10000123.
 *  - gmEffectsUI::SpellEffectMatchesUIType @ 004b76c0: type 1 lists spells
 *    whose CSpellBase bitfield has 0x4 (SpellFlags.Beneficial, ACE
 *    SpellFlags.cs), type 2 the ones without; a spell the magic system
 *    cannot resolve is in neither.
 *  - gmEffectsUI::RebuildList @ 004b8350: CACQualities::GetEnchantmentsInEffect
 *    (CEnchantmentRegistry::GetEnchantmentsInEffect @ 00594540 — the mult
 *    list then the add list through Duel @ 005942b0: one winner per spell
 *    category; vitae and cooldowns live in other members and never show),
 *    each matching one inserted at GetSortedInsertionPlace @ 004b78c0 (before
 *    the first row whose spell name is >= its own — byte-wise strcmp), an
 *    EffectInfoRegion per row (ctor @ 004f2560: label 0x1000012a = the spell
 *    name, icon 0x10000129 = the spell icon), then its duration.
 *  - EffectInfoRegion::Update(double) @ 004f1c00: only while PlayerModule::
 *    SpellDuration (the "Display Spell Durations" option) — a negative
 *    remaining time is an empty string, else t = ftol(remaining), h = t/3600,
 *    m = t%3600/60, s = t%60 → L"%d:%02d:%02d" (h, m, s) when h > 0 else
 *    L"%d:%02d" (m, s) (the literals at 0x7c40b0 / 0x7c40a0) into the value
 *    text 0x1000012b.
 *  - gmEffectsUI::UpdateDurations @ 004b7670 re-runs every row's Update and
 *    schedules the next at cur_time + 1.0 (ListenToGlobalMessage @ 004b7f40,
 *    registered only while the window is visible — ListenToElementMessage
 *    @ 004b8660 msg 0x18).
 *  - gmEffectsUI::SetSelectedSpell @ 004b8290 (a row click, msg 0x1c on the
 *    list): clicking the selected spell deselects it. UpdateSelection @
 *    004b7f90: the selected row enters state 6, the rest state 1; the info
 *    text is ID_Effects_Info_NoSpells with no rows, ID_Effects_Info_SelectASpell
 *    with none selected, else the spell name + "\n\n" + its description.
 *    RebuildList drops a selection the registry no longer holds.
 *  - gmPanelUI::RecvNotice_SetPanelVisibility @ 004bc6f0 (the panels window
 *    shows one panel at a time): showing a panel hides the visible one; if
 *    the new panel carries attr 0x10000049 and the hidden one does not, the
 *    hidden one is remembered and re-shown when the new one is hidden.
 */

import { setPanelsWindowPanelVisibility, type PanelsWindowSlotState } from './PanelsWindow.js';

/** LayoutDesc 0x2100001b — gmEffectsUI's layout. */
export const EFFECTS_LAYOUT = 0x2100001b;

/** Element ids of the window template 0x10000122 (and its row template 0x10000128). */
export const EFFECTS_ELEMENTS = {
  template: 0x10000122,
  title: 0x10000120,
  close: 0x100000fc,
  list: 0x10000123,
  listScrollbar: 0x10000124,
  infoBlock: 0x10000125,
  infoText: 0x10000126,
  infoScrollbar: 0x10000127,
  row: 0x10000128,
  rowIcon: 0x10000129,
  rowLabel: 0x1000012a,
  rowValue: 0x1000012b,
} as const;

/** Row template 0x10000128 geometry (300x32; icon 32x32 at 0; label (37,0) 188x32; value (225,0) 50x32). */
export const EFFECTS_ROW = {
  width: 300, height: 32,
  icon: { x: 0, w: 32 },
  label: { x: 37, w: 188 },
  value: { x: 225, w: 50 },
  /** Row state 1 (normal) / 6 (selected) — UpdateSelection's SetState. */
  stateNormal: 1, stateSelected: 6,
  /** The DAT media of those states (0x2100001b:0x10000128 state1 / state6). */
  bgNormal: 0x06001396, bgSelected: 0x06001397,
} as const;

/** Info text 0x10000126 geometry inside the info block 0x10000125. */
export const EFFECTS_INFO = { x: 0, y: 8, w: 280, h: 78 } as const;

/** 1 beneficial, 2 harmful (gmEffectsUI m_effectsUIType); 0 every spell (the 1999 combined window). */
export type EffectsUIType = 0 | 1 | 2;

export interface EffectsWindowDef {
  /** 'positive' / 'negative' — our key. */
  readonly key: 'positive' | 'negative';
  /** The derived element in 0x2100001b rendered as the window. */
  readonly element: number;
  /** attr 0x1000000c — m_effectsUIType. */
  readonly uiType: EffectsUIType;
  /** Title 0x10000120 p23 string id (table 0x23000001). */
  readonly titleString: number;
  /** Verbatim DAT title — the fallback while the string tables are not loaded. */
  readonly titleFallback: string;
  /** p87 — the InputAction that toggles it (the close button's p18 too). */
  readonly inputAction: number;
  /** attr 0x10000029 of its panels-window slot (0x2100006e: 0x10000184 / 0x10000185). */
  readonly panelId: number;
  /** attr 0x10000049 — remembers the panel it displaced (gmPanelUI). */
  readonly returnsToPrevious: boolean;
}

export const POSITIVE_EFFECTS: EffectsWindowDef = {
  key: 'positive', element: 0x1000011f, uiType: 1,
  titleString: 3828901, titleFallback: 'Beneficial Spells in Effect',
  inputAction: 0x10000006, panelId: 4, returnsToPrevious: true,
};

export const NEGATIVE_EFFECTS: EffectsWindowDef = {
  key: 'negative', element: 0x10000121, uiType: 2,
  titleString: 224554165, titleFallback: 'Harmful Spells in Effect',
  inputAction: 0x10000007, panelId: 5, returnsToPrevious: false,
};

/**
 * SWEEP1999.magic MAG-4 — an era with ONE effects window (the 1999 client's
 * "Spells in Effect", SpellsInEffectPanel ctor @ 0x59ac70): the positive
 * window's slot, element and InputAction, listing every spell in effect
 * (uiType 0) under the era's own title. The negative window never shows.
 */
export function combinedEffectsWindow(title: string): EffectsWindowDef {
  return { ...POSITIVE_EFFECTS, uiType: 0, titleString: 0, titleFallback: title };
}

/** compute_str_hash("ID_Effects_Info_NoSpells") / ("ID_Effects_Info_SelectASpell") in 0x23000001. */
export const EFFECTS_INFO_STRINGS = {
  noSpells: 210467827,
  selectASpell: 135163484,
} as const;
export const EFFECTS_INFO_FALLBACKS: Record<number, string> = {
  [EFFECTS_INFO_STRINGS.noSpells]: 'NO SPELLS',
  [EFFECTS_INFO_STRINGS.selectASpell]: 'SELECT A SPELL',
};

/** SpellFlags.Beneficial (ACE SpellFlags.cs) — the CSpellBase bitfield bit SpellEffectMatchesUIType tests. */
export const SPELL_FLAG_BENEFICIAL = 0x4;
/** EnchantmentTypeFlags.Multiplicative — the mult list GetEnchantmentsInEffect reads first. */
const STAT_MOD_MULTIPLICATIVE = 0x4000;

/** One registry entry as GameUI tracks it (MagicUpdateEnchantment + the local receipt time). */
export interface EffectsEnchantment {
  spellId: number;
  layer: number;
  name: string;
  iconId: number;
  isBeneficial: boolean;
  isVitae: boolean;
  isCooldown: boolean;
  /** Seconds; negative = no expiry (an item spell's -1). */
  duration: number;
  /** ACE StartTime: 0 at cast, then minus the seconds elapsed server-side when sent. */
  startTime: number;
  /** Local seconds when the entry arrived. */
  appliedAt: number;
  spellCategory?: number;
  powerLevel?: number;
  statModType?: number;
}

/** What the magic system knows about a spell (ClientMagicSystem::InqSpellBase). */
export interface EffectsSpellInfo {
  name: string;
  desc: string;
  icon: number;
  bitfield: number;
}

/** The start of an entry in local seconds (the client's absolute _start_time). */
function absStart(e: EffectsEnchantment): number {
  return e.appliedAt + e.startTime;
}

/** Enchantment::Duel @ 005cace0 — does the list's `held` beat the incoming `cand`? */
function heldWins(held: EffectsEnchantment, cand: EffectsEnchantment): boolean {
  const hp = held.powerLevel ?? 0;
  const cp = cand.powerLevel ?? 0;
  return !(hp <= cp && (hp !== cp || absStart(held) <= absStart(cand)));
}

/**
 * CEnchantmentRegistry::GetEnchantmentsInEffect @ 00594540: the mult list,
 * then the add list, each entry Duel'd (@ 005942b0) against the result — one
 * winner per spell category, a loser dropped, a new winner appended at the
 * tail. Vitae and cooldowns are separate registry members and never enter.
 */
export function enchantmentsInEffect(entries: Iterable<EffectsEnchantment>): EffectsEnchantment[] {
  const all = [...entries].filter((e) => !e.isVitae && !e.isCooldown);
  const mult = all.filter((e) => ((e.statModType ?? 0) & STAT_MOD_MULTIPLICATIVE) !== 0);
  const add = all.filter((e) => ((e.statModType ?? 0) & STAT_MOD_MULTIPLICATIVE) === 0);
  const out: EffectsEnchantment[] = [];
  for (const cand of [...mult, ...add]) {
    const cat = cand.spellCategory;
    const i = cat === undefined ? -1 : out.findIndex((h) => h.spellCategory === cat);
    if (i >= 0) {
      if (heldWins(out[i], cand)) continue;
      out.splice(i, 1);
    }
    out.push(cand);
  }
  return out;
}

/** gmEffectsUI::SpellEffectMatchesUIType @ 004b76c0. */
export function spellEffectMatchesUIType(uiType: EffectsUIType, bitfield: number): boolean {
  if (uiType === 0) return true; // the 1999 window lists every spell (0x0059b530 inserts each)
  const beneficial = (bitfield & SPELL_FLAG_BENEFICIAL) !== 0;
  return uiType === 1 ? beneficial : !beneficial;
}

/** Byte-wise strcmp (GetSortedInsertionPlace's inline compare loop). */
function strcmp(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

export interface EffectsRow {
  spellId: number;
  name: string;
  icon: number;
  /** (start + duration) − now, in seconds (RebuildList / EffectInfoRegion::GetDuration). */
  remaining: number;
}

/**
 * gmEffectsUI::RebuildList @ 004b8350 — the rows one window lists: the
 * enchantments in effect whose spell matches the window's type, each at
 * GetSortedInsertionPlace (before the first row whose name is >= its own).
 * `spellInfo` is InqSpellBase; when it returns null (no spell table loaded)
 * the entry's own name / icon / Beneficial stat-mod bit stand in.
 */
export function buildEffectsRows(
  entries: Iterable<EffectsEnchantment>, uiType: EffectsUIType, nowSec: number,
  spellInfo: (spellId: number) => EffectsSpellInfo | null,
): EffectsRow[] {
  const rows: EffectsRow[] = [];
  for (const e of enchantmentsInEffect(entries)) {
    const info = spellInfo(e.spellId);
    const bitfield = info ? info.bitfield : (e.isBeneficial ? SPELL_FLAG_BENEFICIAL : 0);
    if (!spellEffectMatchesUIType(uiType, bitfield)) continue;
    const row: EffectsRow = {
      spellId: e.spellId,
      name: info?.name ?? e.name,
      icon: info?.icon || e.iconId,
      // (start + duration) − now, grouped so a just-received entry is exact.
      remaining: (e.startTime + e.duration) - (nowSec - e.appliedAt),
    };
    let at = rows.findIndex((r) => strcmp(row.name, r.name) <= 0);
    if (at < 0) at = rows.length;
    rows.splice(at, 0, row);
  }
  return rows;
}

/** EffectInfoRegion::Update(double) @ 004f1c00 — the value text for `remaining` seconds. */
export function formatEffectDuration(remaining: number): string {
  if (!(remaining >= 0)) return '';
  const t = Math.trunc(remaining) >>> 0; // _ftol2, then unsigned divl
  const h = Math.floor(t / 3600);
  const r = t % 3600;
  const m = Math.floor(r / 60);
  const s = r % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * gmEffectsUI::UpdateSelection @ 004b7f90 — the info text 0x10000126.
 * `str` resolves a 0x23000001 string id (null when the tables are not loaded).
 */
export function effectsInfoText(
  rowCount: number, selectedSpell: number,
  spellInfo: (spellId: number) => EffectsSpellInfo | null,
  str: (id: number) => string | null,
): string {
  const s = (id: number) => str(id) ?? EFFECTS_INFO_FALLBACKS[id];
  if (rowCount === 0) return s(EFFECTS_INFO_STRINGS.noSpells);
  if (!selectedSpell) return s(EFFECTS_INFO_STRINGS.selectASpell);
  const info = spellInfo(selectedSpell);
  return `${info?.name ?? ''}\n\n${info?.desc ?? ''}`;
}

/**
 * gmPanelUI::RecvNotice_SetPanelVisibility @ 004bc6f0 for the two effects
 * slots of the panels window (the shared rule lives in PanelsWindow.ts).
 */
export type EffectsPanelSlotState = PanelsWindowSlotState<EffectsWindowDef>;

export function setEffectsPanelVisibility(
  state: EffectsPanelSlotState, panel: EffectsWindowDef, show: boolean,
): EffectsPanelSlotState {
  return setPanelsWindowPanelVisibility(state, panel, show);
}
