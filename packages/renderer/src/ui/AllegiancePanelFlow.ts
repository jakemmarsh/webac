/**
 * BUG.ac1999-fellowship-refusal-wording (allegiance sweep) — how the allegiance pane's Swear and
 * Break buttons run in each era's client (eraClientRules().allegianceFlow).
 *
 * End of retail (and Dark Majesty): gmAllegianceUI asks first. Swear opens
 * MakeSwearConfirmationDialog @ 004927b0 ("Do you wish to swear to %s?"), Break
 * MakeBreakConfirmationDialog, Kick MakeKickConfirmationDialog @ 00492e10.
 *
 * 1999 (AllegPanel_ListenToMessage @ 0x00530a70): no dialogs and no Kick. Swear sends
 * SwearAllegiance(selectedID) at once. Break prints a prompt on the status line (UI vtable +0x114)
 * and arms SetTargetMode(6); the next click on the patron's or a vassal's row breaks with that
 * character (0x0052db90), any other click prints "Break Allegiance cancelled". With neither a patron
 * nor a vassal, Break does nothing.
 */

export interface AllegianceBreakText {
  readonly patronOrVassal: string;
  readonly patron: string;
  readonly vassal: string;
  readonly cancelled: string;
}

export interface AllegianceFlowRules {
  /** Swear / Break / Kick confirm in a Yes / No dialog first (end of retail). */
  readonly confirmDialogs: boolean;
  /** The pane has a Kick button (end of retail); 1999 breaks with a vassal through Break's click. */
  readonly kickButton: boolean;
  /** 1999's click-to-break mode and its lines; null: Break acts on the patron at once. */
  readonly breakMode: AllegianceBreakText | null;
  /**
   * The 1999 pane's own parts: the swear area (no patron: the cost, the "Swear Allegiance To <name>"
   * button or the select prompt), rank titles before names, the Show XP / Show Titles toggle in Kick's
   * place and the "Break Allegiance" label.
   */
  readonly pane1999: boolean;
  /**
   * The cursor while Break's click mode is armed: a texture in the era's WORLD portal, or null. 1999:
   * SetTargetMode(6) @ 0x004d0220 sets the UI's +0x380 cursor, 0x0600144f (loaded @ 0x004d37ea), hotspot
   * (0, 0). The 1999 era's interface portal is end of retail's and has no such texture; its world portal does.
   */
  readonly breakCursor: number | null;
}

export const EOR_ALLEGIANCE_FLOW: AllegianceFlowRules = Object.freeze({
  confirmDialogs: true,
  kickButton: true,
  breakMode: null,
  pane1999: false,
  breakCursor: null,
});

/** The 1999 client.exe's literals (features-1999.json: AllegPanel_ListenToMessage @ 0x00530a70, 0x0052db90). */
export const AC1999_ALLEGIANCE_BREAK_TEXT: AllegianceBreakText = Object.freeze({
  patronOrVassal: 'Click your Patron or a Vassal to break Allegiance. Click anywhere to abort.',
  patron: 'Click your Patron to break Allegiance. Click anywhere to abort.',
  vassal: 'Click a Vassal to break Allegiance. Click anywhere to abort.',
  cancelled: 'Break Allegiance cancelled',
});

export const AC1999_ALLEGIANCE_FLOW: AllegianceFlowRules = Object.freeze({
  confirmDialogs: false,
  kickButton: false,
  breakMode: AC1999_ALLEGIANCE_BREAK_TEXT,
  pane1999: true,
  breakCursor: 0x0600144f,
});

/** The 1999 Break press: the prompt for what can be broken, or null (nothing to break: no line, no mode). */
export function breakPrompt1999(text: AllegianceBreakText, hasPatron: boolean, vassalCount: number): string | null {
  if (hasPatron) return vassalCount > 0 ? text.patronOrVassal : text.patron;
  return vassalCount > 0 ? text.vassal : null;
}

export type BreakClickResult = { kind: 'break'; guid: number } | { kind: 'cancelled'; text: string };

/**
 * The click after a 1999 Break press: the patron's or a vassal's row breaks with that character,
 * anything else cancels. `clickedGuid` is the row's character, or null off every row.
 */
export function breakClick1999(
  text: AllegianceBreakText, clickedGuid: number | null, patronGuid: number | null, vassalGuids: readonly number[],
): BreakClickResult {
  if (clickedGuid !== null && clickedGuid !== 0 && (clickedGuid === patronGuid || vassalGuids.includes(clickedGuid))) {
    return { kind: 'break', guid: clickedGuid };
  }
  return { kind: 'cancelled', text: text.cancelled };
}

// ── The 1999 pane's swear area and Show XP / Show Titles (VISUAL.ac1999-allegpanel-swear-label) ──

/**
 * The 1999 AllegPanel's literals (features-1999.json): AllegPanel_HandleSelection @ 0x0052fcd0 ("Swear
 * Allegiance To " + the selection's name, or "SELECT A CHARACTER TO SWEAR ALLEGIANCE TO."),
 * AllegPanel_SetXPChange @ 0x0052ddd0 (the xp lines and the two not-enough messages), the ctor
 * @ 0x0052bf80 / ListenToMessage @ 0x00530a70 (the "Show XP" / "Show Titles" toggle and "Break Allegiance").
 */
export const AC1999_ALLEGIANCE_PANE_TEXT = Object.freeze({
  swearTo: 'Swear Allegiance To ',
  selectPrompt: 'SELECT A CHARACTER TO SWEAR ALLEGIANCE TO.',
  xpCost: 'xp cost: ',
  xpAvailable: 'xp available: ',
  xpNeeded: 'xp needed: ',
  notEnough: "You don't have enough available xp to swear Allegiance.",
  notAtLevel: "You don't have enough available xp to swear Allegiance at your current level.",
  checkAgain: 'Check again when your level increases.',
  showXp: 'Show XP',
  showTitles: 'Show Titles',
  breakButton: 'Break Allegiance',
});

const f32 = Math.fround;

/**
 * AllegianceSystem_SwearAllegianceCost @ 0x005ee070 (level, breaks): the XP to raise level → level + 1
 * (ExperienceSystem_ExperienceToRaiseLevel @ 0x005edec0) × 0.05 (float @ 0x618848), clamped to
 * 100 … 5000 (@ 0x61883c / 0x618838), × (breaks / 4 + 1) (@ 0x61884c / 0x618850), + 0.5 (@ 0x618854),
 * truncated (__ftol). `breaks` is int 0x84 NumAllegianceBreaks (SetXPChange @ 0x0052de6d). `table[n]`
 * is the XP to reach level n.
 */
export function swearAllegianceCost1999(level: number, table: readonly bigint[] | null, breaks: number): number {
  const to = table && level >= 0 && level + 1 < table.length ? Number(table[level + 1]) : 0;
  const from = table && level >= 0 && level < table.length ? Number(table[level]) : 0;
  const raise = to > from ? to - from : 0;
  let v = f32(raise * f32(0.05));
  if (v > 5000) v = 5000;
  else if (v < 100) v = 100;
  const m = f32((breaks >>> 0) / 4 + 1);
  return Math.trunc(v * m + 0.5);
}

/** What the 1999 swear area shows (SetXPChange + HandleSelection); nothing with a patron. */
export type SwearArea1999 =
  | { kind: 'hidden' }
  /** Short of the cost, and the XP to the next level is more: xp available / xp needed (the cost) + notEnough. */
  | { kind: 'short'; available: number; needed: number }
  /** Short, and the cost is at least the XP to the next level: notAtLevel + checkAgain. */
  | { kind: 'level' }
  /** Affordable, nothing valid selected: the select prompt and the cost. */
  | { kind: 'select'; cost: number }
  /** Affordable and a valid character selected: the "Swear Allegiance To <name>" button and the cost. */
  | { kind: 'swear'; cost: number; name: string };

export interface SwearArea1999Input {
  hasPatron: boolean;
  level: number;
  totalXp: number;
  unassignedXp: number;
  table: readonly bigint[] | null;
  breaks: number;
  /** The selection's name when it is a player you can swear to (not yourself, not your vassal), else null. */
  eligibleTarget: string | null;
}

export function swearArea1999(o: SwearArea1999Input): SwearArea1999 {
  if (o.hasPatron) return { kind: 'hidden' };
  const cost = swearAllegianceCost1999(o.level, o.table, o.breaks);
  const avail = Math.max(0, Math.trunc(o.unassignedXp));
  if (cost > avail) {
    // 0x0052df8a: ExperienceToLevel(level + 1) − total XP (int 0x15), compared unsigned with the cost.
    const next = o.table && o.level + 1 < o.table.length ? Number(o.table[o.level + 1]) : 0;
    const untilNext = (next - Math.trunc(o.totalXp)) >>> 0;
    return untilNext > cost ? { kind: 'short', available: avail, needed: cost } : { kind: 'level' };
  }
  return o.eligibleTarget ? { kind: 'swear', cost, name: o.eligibleTarget } : { kind: 'select', cost };
}

/**
 * A member as the 1999 pane names it in titles mode: the rank title (0x005ee120, the same table as
 * end of retail's for its three heritages), a space, the name (0x005ae8b0); the name alone when
 * there is no title.
 */
export function titledName1999(name: string, title: string | null | undefined): string {
  return title ? `${title} ${name}` : name;
}

/**
 * The 1999 AllegPanel buttons' rects (ctor @ 0x0052bf80; the button ctor 0x00452730 takes x, y, width):
 * Swear at (4, 0x3a) 0x124 wide; Show XP at x 0x19 and Break Allegiance at x 0x96, 0x78 wide each, on
 * the row at y 0x12d (ours keeps the layout's own row y and height).
 */
export const AC1999_ALLEGIANCE_BUTTON_RECTS = Object.freeze({
  swear: Object.freeze({ x: 4, y: 0x3a, w: 0x124 }),
  showXp: Object.freeze({ x: 0x19, w: 0x78 }),
  breakButton: Object.freeze({ x: 0x96, w: 0x78 }),
});

/**
 * The 1999 text button's look (the button class 0x00452730 on base 0x00450880): the label in the UI's
 * button font (UI + 0x1a8: Times New Roman 16, RGB 210, 210, 200, made @ 0x004c5c4e) and, while
 * disabled, UI + 0x1ac's RGB 100, 100, 100 (@ 0x004c5c83). Disabling (0x004511d0) swaps only the text
 * colour; the body art stays.
 */
export const AC1999_BUTTON_LOOK = Object.freeze({
  enabledColor: 'rgb(210, 210, 200)',
  disabledColor: 'rgb(100, 100, 100)',
});
