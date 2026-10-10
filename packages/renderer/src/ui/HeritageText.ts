/**
 * VISUAL.chargen-heritage-lore-spacing — the char-gen Heritage page's lore
 * text (0x21000046:0x100003c4), composed the way retail's
 * gmCGHeritagePage::Update @ 00483210 builds it (annotated decomp
 * ~133296-133440): ONE UIElement_Text filled by
 *
 *   SetStringInfoWithFont(ID_CharGen_Heritage_StartingSkills_Header, 0, 1)
 *   AppendStringInfoWithFont(ID_CharGen_Heritage_StartingSkills, 0, 0)
 *   AppendStringInfoWithFont(ID_CharGen_Heritage_BonusSkills_Trained_Header, 0, 1)
 *   AppendStringInfoWithFont(ID_CharGen_<X>Text_BonusSkills_Trained, 0, 0)
 *   AppendText(L"\n")
 *   AppendStringInfoWithFont(ID_CharGen_<X>Text, 0, 0)
 *
 * (last argument = the p27 colour-table index: 1 the green headers, 0 the
 * white body), all from StringTable 0x10000002 (= 0x23000002). The line
 * breaks are only the strings' own "\n" escapes plus that one explicit
 * "\n" — no block spacing of any kind.
 *
 * <X> is picked by `heritage - 1` in the decomp's two switches; cases 4 and
 * 9 (Umbraen = 5 and Penumbraen = 10) both use "Shad". Ids are the tokens'
 * compute_str_hash (acStringHash), never hand-copied numbers.
 */
import { acStringHash } from '@ac/dat-parser/file-types/LayoutDesc.js';

/** A run of one text element: its string and p27 colour-table index. */
export interface TextRun { text: string; colorIndex?: number }

/** The <X> of ID_CharGen_<X>Text per heritage (gmCGHeritagePage::Update's switch on heritage - 1). */
export const HERITAGE_TEXT_TOKEN: Readonly<Record<number, string>> = Object.freeze({
  1: 'Aluvian', 2: 'Garu', 3: 'Sho', 4: 'Via', 5: 'Shad', 6: 'Gear', 7: 'AunT',
  8: 'Lug', 9: 'Emp', 10: 'Shad', 11: 'Und', 12: 'Olthoi', 13: 'OlthoiAcid',
});

/** The lore string id (ID_CharGen_<X>Text) for `heritage`, or null outside 1..13. */
export function heritageLoreStringId(heritage: number): number | null {
  const t = HERITAGE_TEXT_TOKEN[heritage];
  return t ? acStringHash(`ID_CharGen_${t}Text`) : null;
}

/** The bonus-skills string id (ID_CharGen_<X>Text_BonusSkills_Trained) for `heritage`, or null outside 1..13. */
export function heritageBonusSkillsStringId(heritage: number): number | null {
  const t = HERITAGE_TEXT_TOKEN[heritage];
  return t ? acStringHash(`ID_CharGen_${t}Text_BonusSkills_Trained`) : null;
}

export const STARTING_SKILLS_HEADER_ID = acStringHash('ID_CharGen_Heritage_StartingSkills_Header');
export const STARTING_SKILLS_ID = acStringHash('ID_CharGen_Heritage_StartingSkills');
export const BONUS_SKILLS_HEADER_ID = acStringHash('ID_CharGen_Heritage_BonusSkills_Trained_Header');

/**
 * The runs of the Heritage lore text for `heritage`. `lookup` resolves a
 * StringTable id (unescaped, e.g. getString); an unresolved string
 * contributes nothing, as an empty StringInfo does.
 */
export function heritageLoreRuns(heritage: number, lookup: (id: number) => string | null): TextRun[] {
  const s = (id: number | null): string => (id === null ? '' : lookup(id) ?? '');
  return [
    { text: s(STARTING_SKILLS_HEADER_ID), colorIndex: 1 },
    { text: s(STARTING_SKILLS_ID), colorIndex: 0 },
    { text: s(BONUS_SKILLS_HEADER_ID), colorIndex: 1 },
    { text: s(heritageBonusSkillsStringId(heritage)), colorIndex: 0 },
    { text: '\n', colorIndex: 0 },
    { text: s(heritageLoreStringId(heritage)), colorIndex: 0 },
  ].filter(r => r.text !== '');
}

/** `runs` as an HTML attribute value (JSON, attribute-escaped). */
export function encodeTextRunsAttr(runs: ReadonlyArray<TextRun>): string {
  return JSON.stringify(runs).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The runs a `data-ac-runs` attribute carries (already attribute-decoded by the DOM), or null when malformed. */
export function parseTextRuns(json: string): TextRun[] | null {
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return null;
    return v.filter((r): r is TextRun => r && typeof r.text === 'string');
  } catch {
    return null;
  }
}
