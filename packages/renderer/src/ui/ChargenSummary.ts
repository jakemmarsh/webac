/**
 * CORE.17.k.b.b.a.c — the chargen Summary page's contents, as the retail
 * client builds them (layout 0x2100004b, class gmCGSummaryPage @ 0047ac70).
 *
 * Ground truth (the decompiled EoL client + acclient.exe .rdata/.data):
 *
 * - `gmCGSummaryPage::SetSummaryText @ 0047b1d0` flushes the listbox
 *   0x10000400 and adds rows from three item templates (the listbox's p100
 *   list, layout 0x2100004c): template 0 = 0x100002f8 (plain text row, child
 *   0x100002f9), 1 = 0x100002fa (the header bar with media 0x06004d0b, child
 *   0x100000fe), 2 = 0x100002fb (name 0x100002fc / value 0x100002fd). Rows,
 *   in order: "Profession: " + pcProfessions[template] (7 entries @
 *   0x8191a8), "Gender: " + pcGender[gender] (3 @ 0x8191c4), "Heritage: " +
 *   pcHeritage[heritage] only while heritage < 5 (5 entries @ 0x8191d0 — the
 *   later heritages print a bare "Heritage: "), "Starting Town: " +
 *   pcTown[startArea] (4 @ 0x8191e4); the header "Attributes"; ten
 *   name/value rows Strength…Self, Health = _ftol2(Endurance * 0.5 + 0.5)
 *   (fmul/fadd the double @ 0x798088), Stamina = Endurance, Mana = Self,
 *   "Skill Credits" = the remaining credits; then four headers
 *   "Specialized Skills" / "Trained Skills" / "Useable Untrained Skills" /
 *   "Unuseable Untrained Skills", each followed by a name/value row per
 *   skill of that class (the untrained split on the SkillBase's MinLevel:
 *   < 2 useable) with the name through L"%hs" (0x79f3f0) and the value from
 *   `CharGenState::GetSkillScore @ 005c4b50`. The skill list is
 *   `CharGenState::skillRecordList`, built @ 005c6b6a by strcmp insertion —
 *   alphabetical by name (strncpy'd to 30 chars).
 * - `CharGenState::GetSkillScore`: 0 unless the SkillBase's min_level <=
 *   the advancement class; else `SkillFormula::Calculate @ 00591960` =
 *   ftol(floor((x·attr1 + y·attr2 + w) / z + 0.5)) (0 when z == 0), + 5
 *   trained / + 10 specialized. `CharGenState::GetAttribute @ 005c39b0`:
 *   1 strength, 2 endurance, 3 quickness, 4 coordination, 5 focus, 6 self.
 * - `gmCGSummaryPage::SetHowToText @ 0047ae20`: ID_CharGen_SummaryHowTo +
 *   ID_CharGen_<Heritage><Male|Female>Names + ID_CharGen_SummaryHowToEnd
 *   (table 0x10000002 = 0x23000002) → 0x10000404. The heritage switch:
 *   1 Alu, 2 Gharu, 3 Sho, 4 Via, 5 and 10 Shad, 6 Gear, 7 AunT, 8 Lug,
 *   9 Emp, 11 Und, 12 and 13 Olthoi; gender 2 = Female, anything else Male;
 *   an unlisted heritage sets no text at all.
 * - `gmCGSummaryPage::Update @ 0047baa0`: while m_bNameEntered is false the
 *   name field 0x10000402 shows ID_CharGen_NamePrompt ("\[ Name \]" — the
 *   string-table escape of "[ Name ]") selected whole; the 3D view camera is
 *   (0, −2.5, 0.95) facing +y for every heritage but Olthoi (12: (0, −3.8,
 *   1.15)) and Olthoi Acid (13: (0, −5.7, 1.65)), heading 180
 *   (`InitializePage @ 0047bbf0`), the viewport's CreatureMode FOV π/4
 *   vertical (`CreatureMode::CreatureMode @ 00454390`, `Render::SetFOVInternal`).
 * - `gmCGSummaryPage::ListenToElementMessage @ 0047bf40`: a change (0x12 /
 *   0x44) on 0x10000402 sets m_bNameEntered; a text of 33+ characters is
 *   put back to the state's name and `DoNameLimitDialog @ 0047bd80` raises
 *   the type-3 (OK) dialog ID_CharGen_NameTooLong. The field's
 *   `NameInputFilter @ 004663b0` admits isalpha() characters below 0x100,
 *   the apostrophe, the space and the hyphen.
 * - `gmCharGenMainUI::DoFinish @ 004e9170`: trims "[] " off both ends of the
 *   name; no name entered (or nothing left) → the type-3 dialog
 *   ID_CharGen_NoNameWarning; attribute credits left → the type-1 (Yes /
 *   No) ID_CharGen_CreditWarning, Yes = DoFinish(false); else the
 *   CharGenResult is sent.
 */
import { SkillAdvancementClass } from '@ac/shared';

/** pcProfessions @ 0x8191a8 — indexed by the chargen template (0 = Custom). */
export const SUMMARY_PROFESSIONS: readonly string[] = ['Custom', 'Bow Hunter', 'Swashbuckler', 'Life Caster', 'War Mage', 'Wayfarer', 'Soldier'];
/** pcGender @ 0x8191c4 — indexed by the Gender enum (1 Male, 2 Female). */
export const SUMMARY_GENDERS: readonly string[] = ['?', 'Male', 'Female'];
/** pcHeritage @ 0x8191d0 — five entries; SetSummaryText prints nothing for heritage >= 5. */
export const SUMMARY_HERITAGES: readonly string[] = ['?', 'Aluvian', "Gharu'ndim", 'Sho', 'Viamontian'];
/** pcTown @ 0x8191e4 — indexed by the CharGen.StarterAreas index. */
export const SUMMARY_TOWNS: readonly string[] = ['Holtburg', 'Shoushi', 'Yaraq', 'Sanamar'];

/** The row prefixes / labels SetSummaryText appends (wide literals in .rdata). */
export const SUMMARY_LABELS = {
  profession: 'Profession: ',
  gender: 'Gender: ',
  heritage: 'Heritage: ',
  town: 'Starting Town: ',
  attributes: 'Attributes',
  attributeRows: ['Strength', 'Endurance', 'Coordination', 'Quickness', 'Focus', 'Self', 'Health', 'Stamina', 'Mana', 'Skill Credits'],
  skillSections: ['Specialized Skills', 'Trained Skills', 'Useable Untrained Skills', 'Unuseable Untrained Skills'],
} as const;

/** strncpy(SkillRecord::name, …, 0x1e) — the summary row shows at most 30 characters of a skill name. */
export const SUMMARY_SKILL_NAME_MAX = 30;
/** ListenToElementMessage: a name of 0x22 − 1 = 33 or more characters is refused. */
export const SUMMARY_NAME_MAX = 32;

/** The string-table tokens SetHowToText / Update / the dialogs bind (table 0x10000002). */
export const SUMMARY_TOKENS = {
  howTo: 'ID_CharGen_SummaryHowTo',
  howToEnd: 'ID_CharGen_SummaryHowToEnd',
  namePrompt: 'ID_CharGen_NamePrompt',
  nameTooLong: 'ID_CharGen_NameTooLong',
  noNameWarning: 'ID_CharGen_NoNameWarning',
  creditWarning: 'ID_CharGen_CreditWarning',
} as const;

/** SetHowToText's heritage switch → the naming-convention token prefix. */
export const SUMMARY_NAME_TOKEN_PREFIX: Readonly<Record<number, string>> = {
  1: 'Alu', 2: 'Gharu', 3: 'Sho', 4: 'Via', 5: 'Shad', 6: 'Gear', 7: 'AunT', 8: 'Lug', 9: 'Emp', 10: 'Shad', 11: 'Und', 12: 'Olthoi', 13: 'Olthoi',
};

/** The ID_CharGen_<Heritage><Sex>Names token for a heritage / gender, or null when SetHowToText has no case for it. */
export function summaryNameToken(heritage: number, gender: number): string | null {
  const prefix = SUMMARY_NAME_TOKEN_PREFIX[heritage];
  if (!prefix) return null;
  return `ID_CharGen_${prefix}${gender === 2 ? 'Female' : 'Male'}Names`;
}

/**
 * The how-to panel's text: SummaryHowTo + the naming conventions + SummaryHowToEnd.
 * SetHowToText appends each string only while the previous one resolved and
 * sets the text only once all three did — so a heritage without a case, or
 * a missing string, leaves the panel empty.
 */
export function summaryHowToText(heritage: number, gender: number, getStr: (token: string) => string | null): string {
  const howTo = getStr(SUMMARY_TOKENS.howTo);
  if (howTo === null) return '';
  const token = summaryNameToken(heritage, gender);
  const names = token ? getStr(token) : null;
  if (names === null) return '';
  const end = getStr(SUMMARY_TOKENS.howToEnd);
  if (end === null) return '';
  return howTo + names + end;
}

/** Health as the summary prints it: _ftol2(Endurance * 0.5 + 0.5) — truncation of end/2 + 1/2. */
export function summaryHealth(endurance: number): number {
  return Math.trunc(endurance * 0.5 + 0.5);
}

export interface SummaryAttributes {
  strength: number; endurance: number; coordination: number; quickness: number; focus: number; self: number;
}

/** CharGenState::GetAttribute's index → attribute (1 strength … 6 self); 0 for anything else. */
export function summaryAttribute(attrs: SummaryAttributes, index: number): number {
  switch (index) {
    case 1: return attrs.strength;
    case 2: return attrs.endurance;
    case 3: return attrs.quickness;
    case 4: return attrs.coordination;
    case 5: return attrs.focus;
    case 6: return attrs.self;
    default: return 0;
  }
}

export interface SummarySkillFormula { w: number; x: number; y: number; z: number; attr1: number; attr2: number }

/**
 * CharGenState::GetSkillScore: 0 unless the skill's min_level <= its
 * advancement class (Untrained 1 / Trained 2 / Specialized 3) and the
 * formula's divisor is non-zero; else floor((x·a1 + y·a2 + w) / z + 0.5)
 * plus 5 for a trained, 10 for a specialized skill.
 */
export function summarySkillScore(
  formula: SummarySkillFormula, attrs: SummaryAttributes, advClass: number, minLevel: number,
): number {
  if (formula.z === 0) return 0;
  if (minLevel > advClass) return 0;
  const a1 = summaryAttribute(attrs, formula.attr1);
  const a2 = summaryAttribute(attrs, formula.attr2);
  const base = Math.floor((formula.x * a1 + formula.y * a2 + formula.w) / formula.z + 0.5);
  if (advClass === SkillAdvancementClass.Trained) return base + 5;
  if (advClass === SkillAdvancementClass.Specialized) return base + 10;
  return base;
}

export interface SummarySkill {
  id: number;
  name: string;
  minLevel: number;
  formula: SummarySkillFormula;
  /** The SkillAdvancementClass the chargen state holds for it (Untrained / Trained / Specialized; anything else is listed nowhere). */
  advClass: number;
}

export interface SummaryState {
  /** The chargen template index (pcProfessions); −1 / out of range prints the bare prefix. */
  profession: number;
  gender: number;
  heritage: number;
  startArea: number;
  attributes: SummaryAttributes;
  skillCreditsRemaining: number;
  skills: readonly SummarySkill[];
  /**
   * The 1999 world (era ac1999-retail) only: the profession and town names to
   * print in place of pcProfessions / pcTown, which index end-of-retail
   * templates and towns (its CharGen has 8 other templates and 18 start
   * areas). Absent in every other era.
   */
  professionName?: string;
  townName?: string;
}

export type SummaryRow =
  | { kind: 'text'; text: string }
  | { kind: 'header'; text: string }
  | { kind: 'value'; name: string; value: number };

/** strcmp order (byte-wise) — the order CharGenState's skillRecordList keeps. */
export function summarySkillOrder(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Which of the four skill sections a skill lands in (SetSummaryText's per-section filter), or −1 for none. */
export function summarySkillSection(advClass: number, minLevel: number): number {
  if (advClass === SkillAdvancementClass.Specialized) return 0;
  if (advClass === SkillAdvancementClass.Trained) return 1;
  if (advClass === SkillAdvancementClass.Untrained) return minLevel < 2 ? 2 : 3;
  return -1;
}

/** The listbox rows SetSummaryText builds, in order. */
export function buildSummaryRows(state: SummaryState): SummaryRow[] {
  const rows: SummaryRow[] = [];
  const at = (list: readonly string[], i: number): string => (i >= 0 && i < list.length ? list[i] : '');
  rows.push({ kind: 'text', text: SUMMARY_LABELS.profession + (state.professionName ?? at(SUMMARY_PROFESSIONS, state.profession)) });
  rows.push({ kind: 'text', text: SUMMARY_LABELS.gender + at(SUMMARY_GENDERS, state.gender) });
  rows.push({ kind: 'text', text: SUMMARY_LABELS.heritage + at(SUMMARY_HERITAGES, state.heritage) });
  rows.push({ kind: 'text', text: SUMMARY_LABELS.town + (state.townName ?? at(SUMMARY_TOWNS, state.startArea)) });
  rows.push({ kind: 'header', text: SUMMARY_LABELS.attributes });
  const a = state.attributes;
  const values = [a.strength, a.endurance, a.coordination, a.quickness, a.focus, a.self,
    summaryHealth(a.endurance), a.endurance, a.self, state.skillCreditsRemaining];
  SUMMARY_LABELS.attributeRows.forEach((name, i) => rows.push({ kind: 'value', name, value: values[i] }));
  const ordered = [...state.skills].sort(summarySkillOrder);
  SUMMARY_LABELS.skillSections.forEach((header, section) => {
    rows.push({ kind: 'header', text: header });
    for (const s of ordered) {
      if (summarySkillSection(s.advClass, s.minLevel) !== section) continue;
      rows.push({ kind: 'value', name: s.name.slice(0, SUMMARY_SKILL_NAME_MAX), value: summarySkillScore(s.formula, a, s.advClass, s.minLevel) });
    }
  });
  return rows;
}

/** NameInputFilter @ 004663b0: letters (isalpha, code < 0x100), apostrophe, space, hyphen. */
export function nameInputAllowed(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0x100) return false;
  if (ch === "'" || ch === ' ' || ch === '-') return true;
  return /[A-Za-zÀ-ÖØ-öø-ÿªµº]/.test(ch);
}

/** The typed text with every character NameInputFilter refuses removed. */
export function filterNameInput(text: string): string {
  return Array.from(text).filter(nameInputAllowed).join('');
}

/** DoFinish's trim: "[] " stripped off both ends (PStringBase<char>::trim with the "[] " set). */
export function trimFinishName(name: string): string {
  const set = '[] ';
  let start = 0; let end = name.length;
  while (start < end && set.includes(name[start])) start++;
  while (end > start && set.includes(name[end - 1])) end--;
  return name.slice(start, end);
}

/** The 3D view camera per heritage (gmCGSummaryPage::Update): AC position (x, y, z), facing +y; the FOV is CreatureMode's π/4. */
export const SUMMARY_VIEW_FOV_DEGREES = 45;
export function summaryViewCamera(heritage: number): { y: number; z: number } {
  if (heritage === 12) return { y: -3.8, z: 1.15 };
  if (heritage === 13) return { y: -5.7, z: 1.65 };
  return { y: -2.5, z: 0.95 };
}

/** Text → safe inside a double-quoted HTML attribute (the data-ac-text carriers). */
export function escapeHtmlAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
