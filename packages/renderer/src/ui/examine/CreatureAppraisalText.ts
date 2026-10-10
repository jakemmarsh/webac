/**
 * CreatureAppraisalText — what the EoL examine window's creature and
 * character pages show, as pure functions of an IdentifyResponse.
 *
 * Ground truth: the decompiled end-of-retail client (reference/client-eol,
 * build ac1_sep13; function addresses below, line numbers are in
 * decomp/acclient-decompiled.annotated.c) plus layout 0x2100006b
 * (gmFloatyExaminationUI — the EoL window; the element ids are shared with
 * the docked 0x2100001c panel).
 *
 * One page, two sub-UIs. Both CreatureExamineUI and CharExamineUI derive
 * from BasicCreatureExamineUI and fill the SAME page 0x10000140
 * (BasicCreatureExamineUI ctor @ 004acd30, l.171385). They differ only in
 * the header sub-panel they show (Show @ 004ab5a0 / 004ab5d0, l.169957:
 * this+0x74 = page 0x10000140, +0x78 = creature header 0x1000014d,
 * +0x7c = character header 0x1000014f) and in how they fill it.
 * Page 0x10000153 is the SPELL page (SpellExamineUI ctor, l.170427) — not
 * part of this module.
 *
 * Which sub-UI: gmExaminationUI::SetAppraiseInfo @ 004adae0 (l.172168) —
 * a creature profile with PropertyString 5 (Template) or PropertyInt 0x105
 * (CharacterTitleId) → CharExamineUI, otherwise CreatureExamineUI. So a
 * templated NPC such as "Sir Daeglan" (Template "Royal Investigator") gets
 * the character page.
 *
 * Page 0x10000140 (300x365 at (5,30) in 0x2100006b):
 *  - 0x1000014a / 0x1000014b  static labels "Character" / "Level"
 *    (StringTable 0x23000001 ids 160473570 / 118492588 in 0x2100006b).
 *  - 0x1000014c  level value — BasicCreatureExamineUI::SetLevelValueText
 *    @ 004b3e70: PropertyInt 25 < 1 → "???", else the decimal.
 *  - 0x1000014d > 0x1000014e  creature header (one 222x54 text).
 *  - 0x1000014f > 0x10000150/51/52  character header (three 222x18 lines:
 *    gender+heritage, title, PK status).
 *  - 0x10000148  UIElement_Viewport (the 3D model, "paper doll"), same
 *    rect as the stat list 0x10000149 at (0,68) 300x265 — the model draws
 *    behind the rows. BasicCreatureExamineUI::Init @ 004ab9c0 (l.170286).
 *  - 0x10000149  stat list, template 0x10000166 (0x2100006b): 9 rows,
 *    label 0x1000012a + value 0x1000012b.
 *  - 0x10000335  "misc info" list at (0,278) 292x87, template 0x10000337
 *    of layout 0x2100001c: label 0x1000012a + value 0x1000012b rows
 *    (BasicCreatureExamineUI::AddLineToMiscInfo @ 004abbb0, l.170353).
 *  - 0x1000053a  allegiance-name line (0,258) 292x20.
 *
 * Colours are font-colour INDICES into the element's p27 (0x1b) colour
 * array (UIElement_Text::SetTextWithFont → AppendStringInfoWithFont
 * @ 00469de0 → SetFontColorHelper(0x1b, index)); the DAT arrays are
 * exported below.
 */

import type { IdentifyResponseData } from '../../network/ServerMessageHandler.js';
import { getAllegianceRankTitle } from '@ac/shared';

// ─── Element ids + DAT constants ────────────────────────────────────────

export const CREATURE_EXAMINE_ELEMENTS = {
  /** Page shared by the creature and character sub-UIs. */
  page: 0x10000140,
  characterLabel: 0x1000014a,
  levelLabel: 0x1000014b,
  levelValue: 0x1000014c,
  creatureHeader: 0x1000014d,
  creatureDisplayName: 0x1000014e,
  characterHeader: 0x1000014f,
  heritage: 0x10000150,
  title: 0x10000151,
  playerKiller: 0x10000152,
  /** UIElement_Viewport: the examined object's 3D model. */
  paperDoll: 0x10000148,
  statList: 0x10000149,
  /** Stat-row template (0x2100006b) and its children. */
  statRowTemplate: 0x10000166,
  miscInfoList: 0x10000335,
  /** Misc-row template — lives in layout 0x2100001c (list p100 → 0x2100001c). */
  miscRowTemplate: 0x10000337,
  miscRowTemplateLayout: 0x2100001c,
  rowLabel: 0x1000012a,
  rowValue: 0x1000012b,
  allegianceName: 0x1000053a,
  /** Window title (gmExaminationUI m_displayedNameText, PostInit l.171923). */
  windowTitle: 0x1000012d,
} as const;

/** StringTable 0x23000001 ids of the static page labels (layout 0x2100006b). */
export const CREATURE_EXAMINE_STRING_IDS = {
  table: 0x23000001,
  /** 0x1000014a p23 — "Character". */
  character: 160473570,
  /** 0x1000014b p23 — "Level". */
  level: 118492588,
} as const;

/** Verbatim DAT literals for the ids above (fallback when tables aren't loaded). */
export const CREATURE_EXAMINE_LABELS = {
  character: 'Character',
  level: 'Level',
} as const;

/**
 * Font-colour arrays (property 0x1b / p27) from the DAT, ARGB.
 *  - stat value 0x1000012b of template 0x10000166: white, green, red, yellow
 *    (index 3 is used only for an unsuccessful appraisal).
 *  - misc label/value of template 0x10000337: white, green, red.
 */
export const STAT_VALUE_COLORS = [0xffffffff, 0xff00ff00, 0xffff0000, 0xffffff00] as const;
export const MISC_INFO_COLORS = [0xffffffff, 0xff00ff00, 0xffff0000] as const;

/** 0 = normal, 1 = green (buffed / same society), 2 = red (debuffed / rival), 3 = yellow (failed appraisal). */
export type FontColorIndex = 0 | 1 | 2 | 3;

// ─── Output model ───────────────────────────────────────────────────────

export interface StatRow {
  /** Retail attribute/vital id (SkillSystem enum): attributes 1-6, vitals 2/4/6 (cur). */
  kind: 'attribute' | 'vital';
  id: number;
  /** Row label 0x1000012a — SkillSystem::InqAttributeName / InqAttribute2ndName. */
  label: string;
  /** Row value 0x1000012b. */
  value: string;
  /** Index into STAT_VALUE_COLORS. */
  color: FontColorIndex;
}

export interface MiscInfoLine {
  label: string;
  value: string;
  /** Index into MISC_INFO_COLORS (applies to both label and value). */
  color: FontColorIndex;
}

interface BasicCreaturePage {
  /** Which header sub-panel is shown (the other stays hidden). */
  headerPanel: number;
  /** 0x1000014c. */
  level: string;
  /** 0x10000149 rows, in list order. */
  stats: StatRow[];
  /** 0x10000335 rows, in list order (the list is flushed first). */
  miscInfo: MiscInfoLine[];
}

export interface CreaturePageModel extends BasicCreaturePage {
  page: 'creature';
  /**
   * 0x1000014e. null = retail doesn't touch the element (no CreatureType,
   * or no EnumMapper entry) — it keeps whatever it last showed.
   */
  creatureDisplayName: string | null;
  /** 0x1000053a — CreatureExamineUI clears it (ClearAllText). */
  allegianceName: '';
}

export interface CharacterPageModel extends BasicCreaturePage {
  page: 'character';
  /** 0x10000150 — always set (may be ''). */
  heritage: string;
  /** 0x10000151 — null = not touched (no title and no Template). */
  title: string | null;
  /** 0x10000152 — null = not touched (no weenie object known). */
  playerKiller: string | null;
  /** 0x1000053a — '' = cleared. */
  allegianceName: string;
  /** 0x1000012d — CharExamineUI overwrites the window title with AllegianceData::GetFullName. */
  windowTitle: string;
}

// ─── Injected context (no DAT access in this module) ────────────────────

export interface CreatureExamineContext {
  /**
   * The IdentifyResponse `success` uint32 (AppraisalProfile::success_flag).
   * Drives the "???" / yellow stat rendering.
   */
  success: boolean;
  /** EnumMapper 0x2200000A (enum 0x10000001) raw name for a Gender value ("Male"). */
  genderEnumName?: (gender: number) => string | null | undefined;
  /** EnumMapper 0x2200000B (enum 0x10000002) raw name for a HeritageGroup value ("Aluvian"). */
  heritageEnumName?: (heritage: number) => string | null | undefined;
  /** EnumMapper 0x2200000E (enum 0x10000005) raw name for a CreatureType value ("Olthoi_Larvae"). */
  creatureTypeEnumName?: (creatureType: number) => string | null | undefined;
  /**
   * CharacterTitleTable::GetCharacterTitleFromID: EnumMapper 0x22000041
   * (enum 0x10000006) token "ID_CharacterTitle_X" → StringTable 0x2300000E
   * entry acStringHash(token). null when unknown.
   */
  characterTitle?: (titleId: number) => string | null | undefined;
  /**
   * The examined object's PublicWeenieDesc bitfield (ACCWeenieObject::IsPK
   * reads bit 0x20, IsPKLite bit 0x02000000). undefined = no weenie object.
   */
  publicWeenieBitfield?: number;
  /** The VIEWER's own PropertyInt 0x119 (Faction1Bits), from PlayerDesc. */
  viewerFaction1Bits?: number;
  /** ACCWeenieObject::GetObjectName(NAME_APPROPRIATE) of the examined object. */
  objectName?: string;
  /**
   * AllegianceSystem::GetTitle(rank, heritage, gender) — '' / null when none.
   * Defaults to @ac/shared getAllegianceRankTitle.
   */
  allegianceRankTitle?: (heritage: number, gender: number, rank: number) => string | null | undefined;
}

// ─── Property ids ───────────────────────────────────────────────────────

const PI = {
  CreatureType: 2, Level: 25, AllegianceRank: 30, AllegianceFollowers: 35,
  NumDeaths: 43, Gender: 113, Age: 125, ChessRank: 181, HeritageGroup: 188,
  FakeFishingSkill: 192, CharacterTitleId: 261, NumCharacterTitles: 262,
  Faction1Bits: 281, SocietyRankCelhan: 287, SocietyRankEldweb: 288, SocietyRankRadblo: 289,
  DamageRating: 307, DamageResistRating: 308, CritRating: 313, CritDamageRating: 314,
  CritResistRating: 315, CritDamageResistRating: 316, DotResistRating: 350, LifeResistRating: 351,
} as const;
const PS = { Template: 5, Fellowship: 10, MonarchsTitle: 21, PatronsTitle: 35, DateOfBirth: 43, AllegianceName: 47 } as const;

// ─── Small retail helpers ───────────────────────────────────────────────

/** Page choice — gmExaminationUI::SetAppraiseInfo @ 004adae0. */
export function creatureExamineSubPage(d: Pick<IdentifyResponseData, 'creatureProfile' | 'propertiesString' | 'propertiesInt'>): 'creature' | 'character' | null {
  if (!d.creatureProfile) return null;
  if (d.propertiesString?.has(PS.Template) || d.propertiesInt?.has(PI.CharacterTitleId)) return 'character';
  return 'creature';
}

/** Windows MulDiv(a, b, c): 64-bit product, rounded half away from zero; -1 on c = 0. */
export function mulDiv(a: number, b: number, c: number): number {
  if (c === 0) return -1;
  const p = a * b;
  const q = Math.abs(p) / Math.abs(c);
  const r = Math.floor(q + 0.5);
  return (p < 0) !== (c < 0) ? -r : r;
}

/** SkillSystem::InqAttributeName @ 005c8800. */
export function attributeName(id: number): string | null {
  return ({ 1: 'Strength', 2: 'Endurance', 3: 'Quickness', 4: 'Coordination', 5: 'Focus', 6: 'Self' } as Record<number, string>)[id] ?? null;
}

/** SkillSystem::InqAttribute2ndName @ 005c88a0. */
export function attribute2ndName(id: number): string | null {
  return ({
    1: 'Maximum Health', 2: 'Health', 3: 'Maximum Stamina', 4: 'Stamina', 5: 'Maximum Mana', 6: 'Mana',
  } as Record<number, string>)[id] ?? null;
}

/**
 * AppraisalSystem::InqHeritageGroupDisplayName @ 005b4710: 2 → "Gharu'ndim",
 * 5 → "Umbraen", 13 → "Olthoi" are hard-coded; everything else is the raw
 * EnumMapper name.
 */
export function heritageDisplayName(heritage: number, enumName?: (h: number) => string | null | undefined): string | null {
  if (heritage === 2) return "Gharu'ndim";
  if (heritage === 5) return 'Umbraen';
  if (heritage === 13) return 'Olthoi';
  return enumName?.(heritage) ?? null;
}

/** AppraisalSystem::InqCreatureDisplayName @ 005b59e0: EnumMapper name with every '_' → ' '. */
export function creatureDisplayName(creatureType: number, enumName?: (c: number) => string | null | undefined): string | null {
  const raw = enumName?.(creatureType);
  return raw == null ? null : raw.split('_').join(' ');
}

/**
 * AppraisalSystem::InqGenderHeritageDisplay @ 005b5ae0: gender name (when
 * gender ≠ 0 and known), then — heritage ≠ 0 → " " + heritage name, else
 * creatureType ≠ 0 → " " + creature name. The space is only added when a
 * gender name was found; a failed second lookup leaves just the gender.
 */
export function genderHeritageDisplay(
  gender: number, heritage: number, creatureType: number,
  ctx: Pick<CreatureExamineContext, 'genderEnumName' | 'heritageEnumName' | 'creatureTypeEnumName'>,
): string {
  let out = '';
  let hasGender = false;
  if (gender !== 0) {
    const g = ctx.genderEnumName?.(gender);
    if (g != null) { out = g; hasGender = true; }
  }
  let second: string | null = null;
  if (heritage !== 0) second = heritageDisplayName(heritage, ctx.heritageEnumName);
  else if (creatureType !== 0) second = creatureDisplayName(creatureType, ctx.creatureTypeEnumName);
  if (second != null) out += (hasGender ? ' ' : '') + second;
  return out;
}

/**
 * ClientUISystem::DeltaTimeToString @ 00565e10: "%dmo %dd %dh %dm %ds" with
 * 30-day months, each zero unit skipped except seconds, trailing space cut.
 */
export function deltaTimeToString(seconds: number): string {
  const t = Math.trunc(seconds) >>> 0;
  const mo = Math.floor(t / 2592000);
  const rem = t % 2592000;
  const d = Math.floor(rem / 86400);
  const h = Math.floor((rem % 86400) / 3600);
  const m = Math.floor((rem % 3600) / 60);
  const s = rem % 60;
  let out = '';
  if (mo) out += `${mo}mo `;
  if (d) out += `${d}d `;
  if (h) out += `${h}h `;
  if (m) out += `${m}m `;
  out += `${s}s `;
  return out.slice(0, -1);
}

/** CharExamineUI armor cell: a value ≥ 9999 is "*" + (value − 9999) (unenchantable), else "%d". */
export function armorLevelCell(v: number): string {
  const n = v | 0;
  return n >= 9999 ? `*${n - 9999}` : `${n}`;
}

/** Society rank suffix (CharExamineUI::SetAppraiseInfo, asm 004b4aad-004b4b84). */
export function societyRankSuffix(rank: number): string {
  if (rank >= 1 && rank <= 100) return ' ~ Initiate';
  if (rank >= 101 && rank <= 300) return ' ~ Adept';
  if (rank >= 301 && rank <= 600) return ' ~ Knight';
  if (rank >= 601 && rank <= 1000) return ' ~ Lord';
  if (rank >= 1001 && rank <= 1500) return ' ~ Master';
  return '';
}

// ─── Shared page pieces ─────────────────────────────────────────────────

interface RetailCreatureProfile {
  attr: Record<number, number>;   // 1..6
  vital: Record<number, number>;  // 1..6 (odd = max, even = cur)
  enchantmentBitfield: number;
}

/** IdentifyResponse creature profile → retail CreatureAppraisalProfile fields. */
function toRetailProfile(cp: NonNullable<IdentifyResponseData['creatureProfile']>): RetailCreatureProfile {
  const a = cp.attributes;
  return {
    attr: {
      1: a?.strength ?? 0, 2: a?.endurance ?? 0, 3: a?.quickness ?? 0,
      4: a?.coordination ?? 0, 5: a?.focus ?? 0, 6: a?.self ?? 0,
    },
    vital: {
      1: cp.healthMax ?? 0, 2: cp.health ?? 0,
      3: a?.staminaMax ?? 0, 4: a?.stamina ?? 0,
      5: a?.manaMax ?? 0, 6: a?.mana ?? 0,
    },
    // The wire's two u16s are the retail uint32: highlights low, colours high.
    enchantmentBitfield: ((cp.attributeHighlights ?? 0) & 0xffff) | (((cp.attributeColors ?? 0) & 0xffff) << 16),
  };
}

/** CreatureAppraisalProfile::InqAttributeEnchantmentMod @ 005b5ec0 bits. */
const ATTR_ENCH_BIT: Record<number, number> = { 1: 0x1, 2: 0x2, 3: 0x4, 4: 0x8, 5: 0x10, 6: 0x20 };
/** InqAttribute2ndEnchantmentMod @ 005b5fb0 — keyed by the MAX vital (1/3/5). */
const VITAL_ENCH_BIT: Record<number, number> = { 1: 0x40, 3: 0x80, 5: 0x100 };

function enchantColor(bitfield: number, bit: number | undefined, success: boolean): FontColorIndex {
  if (!success) return 3;
  if (bit === undefined || (bitfield & bit) === 0) return 0;
  // (mod == 0) + 1: colour bit clear → 2 (red), set → 1 (green).
  return (bitfield & (bit << 16)) === 0 ? 2 : 1;
}

/**
 * The nine stat rows (list 0x10000149). Order and kinds from the
 * BasicCreatureExamineUI ctor (l.171385): AttributeInfoRegion 1,2,4,3,5,6
 * then Attribute2ndInfoRegion 2 (percent), 4, 6.
 *  - AttributeInfoRegion::Update(AppraisalProfile) @ 004f1d90: 0 → "???",
 *    else "%d".
 *  - Attribute2ndInfoRegion::Update(AppraisalProfile) @ 004f1e80:
 *    success → "%d/%d (%d %%)" (Health) / "%d/%d"; failure → "%d %%"
 *    (Health) / "???"; either value 0 → "???". Percent = MulDiv(100,cur,max).
 */
export function creatureStatRows(d: Pick<IdentifyResponseData, 'creatureProfile'>, success: boolean): StatRow[] {
  const cp = d.creatureProfile;
  const p = cp ? toRetailProfile(cp) : { attr: {}, vital: {}, enchantmentBitfield: 0 } as RetailCreatureProfile;
  const rows: StatRow[] = [];
  for (const id of [1, 2, 4, 3, 5, 6]) {
    const v = p.attr[id] ?? 0;
    rows.push({
      kind: 'attribute', id, label: attributeName(id)!,
      value: v === 0 ? '???' : `${v | 0}`,
      color: enchantColor(p.enchantmentBitfield, ATTR_ENCH_BIT[id], success),
    });
  }
  for (const [cur, showPercent] of [[2, true], [4, false], [6, false]] as const) {
    const max = cur - 1;
    const c = (p.vital[cur] ?? 0) | 0;
    const m = (p.vital[max] ?? 0) | 0;
    let value = '???';
    if (c !== 0 && m !== 0) {
      const pct = mulDiv(100, c, m);
      if (success) value = showPercent ? `${c}/${m} (${pct} %)` : `${c}/${m}`;
      else if (showPercent) value = `${pct} %`;
    }
    rows.push({
      kind: 'vital', id: cur, label: attribute2ndName(cur)!, value,
      color: enchantColor(p.enchantmentBitfield, VITAL_ENCH_BIT[max], success),
    });
  }
  return rows;
}

/** SetLevelValueText @ 004b3e70. */
export function creatureLevelText(d: Pick<IdentifyResponseData, 'propertiesInt'>): string {
  const lvl = d.propertiesInt?.get(PI.Level) ?? 0;
  return lvl < 1 ? '???' : `${lvl}`;
}

const BLANK: MiscInfoLine = { label: '', value: '', color: 0 };

/**
 * The rating block both sub-UIs append (CreatureExamineUI::SetAppraiseInfo
 * l.176496 / asm 004b41af-004b45b1; CharExamineUI asm 004b542a-004b5898).
 * A blank row opens it and closes it. Format strings are "%Rating: %d/%d"
 * and "%Resist: %d/%d"; MSVCR70's printf emits an unknown conversion
 * character literally, so "%R" renders "R". The label is "Dmg/CritDmg" for
 * both the rating and the resist line (retail reuses the literal).
 * HealingBoostRating (0x143) is read but never shown.
 */
export function ratingLines(d: Pick<IdentifyResponseData, 'propertiesInt'>): MiscInfoLine[] {
  const g = (id: number) => d.propertiesInt?.get(id) ?? 0;
  const dr = g(PI.DamageRating), drr = g(PI.DamageResistRating);
  const cr = g(PI.CritRating), cdr = g(PI.CritDamageRating);
  const crr = g(PI.CritResistRating), cdrr = g(PI.CritDamageResistRating);
  const dot = g(PI.DotResistRating), life = g(PI.LifeResistRating);
  const out: MiscInfoLine[] = [];
  if (dr > 0 || cr > 0 || cdr > 0) {
    out.push(BLANK);
    out.push({ label: 'Dmg/CritDmg', value: `Rating: ${dr}/${cdr}`, color: 0 });
  }
  if (drr > 0 || crr > 0 || cdrr > 0) {
    if (out.length === 0) out.push(BLANK);
    out.push({ label: 'Dmg/CritDmg', value: `Resist: ${drr}/${cdrr}`, color: 0 });
  }
  if (dot > 0 || life > 0) {
    if (out.length === 0) out.push(BLANK);
    out.push({ label: 'DoT/Life:', value: `Resist: ${dot}/${life}`, color: 0 });
  }
  if (out.length) out.push(BLANK);
  return out;
}

// ─── CreatureExamineUI ──────────────────────────────────────────────────

/** CreatureExamineUI::SetAppraiseInfo @ 004b3ff0 (l.176496) + BasicCreatureExamineUI::SetAppraiseInfo @ 004b3f70. */
export function buildCreaturePage(d: IdentifyResponseData, ctx: CreatureExamineContext): CreaturePageModel {
  let name: string | null = null;
  const ct = d.propertiesInt?.get(PI.CreatureType) ?? 0;
  if (d.creatureProfile && ct !== 0) name = creatureDisplayName(ct, ctx.creatureTypeEnumName);
  return {
    page: 'creature',
    headerPanel: CREATURE_EXAMINE_ELEMENTS.creatureHeader,
    creatureDisplayName: name,
    allegianceName: '',
    level: creatureLevelText(d),
    stats: creatureStatRows(d, ctx.success),
    miscInfo: ratingLines(d),
  };
}

// ─── CharExamineUI ──────────────────────────────────────────────────────

/** The society row (asm 004b4973-004b4bb5). Colour from the VIEWER's own Faction1Bits. */
function societyLine(d: IdentifyResponseData, viewerBits: number): MiscInfoLine | null {
  const bits = d.propertiesInt?.get(PI.Faction1Bits);
  if (bits === undefined) return null;
  const socs = [
    { bit: 1, rival: 6, rankProp: PI.SocietyRankCelhan, name: 'Celestial Hand' },
    { bit: 2, rival: 5, rankProp: PI.SocietyRankEldweb, name: 'Eldrytch Web' },
    { bit: 4, rival: 3, rankProp: PI.SocietyRankRadblo, name: 'Radiant Blood' },
  ];
  const s = socs.find(x => (bits & x.bit) !== 0);
  if (!s) return { label: 'Society:', value: '???', color: 0 };
  const rank = d.propertiesInt?.get(s.rankProp) ?? 0;
  const color: FontColorIndex = (viewerBits & s.bit) ? 1 : (viewerBits & s.rival) ? 2 : 0;
  return { label: 'Society:', value: s.name + societyRankSuffix(rank), color };
}

/** CharExamineUI::SetAppraiseInfo @ 004b45f0 (l.176720) + BasicCreatureExamineUI::SetAppraiseInfo. */
export function buildCharacterPage(d: IdentifyResponseData, ctx: CreatureExamineContext): CharacterPageModel {
  const pi = (id: number) => d.propertiesInt?.get(id);
  const ps = (id: number) => d.propertiesString?.get(id);
  const gender = pi(PI.Gender) ?? 0;
  const heritage = pi(PI.HeritageGroup) ?? 0;
  const creatureType = heritage === 0 ? (pi(PI.CreatureType) ?? 0) : 0;

  // 0x10000151: CharacterTitleId via the title table, else PropertyString 5 (Template).
  let title: string | null = null;
  const titleId = pi(PI.CharacterTitleId);
  if (titleId !== undefined) title = (titleId !== 0 ? ctx.characterTitle?.(titleId) : null) ?? null;
  if (title == null) title = ps(PS.Template) ?? null;

  // 0x10000152: vtable IsPK (+0x20) then IsPKLite (+0x24) of the ACCWeenieObject.
  let playerKiller: string | null = null;
  if (ctx.publicWeenieBitfield !== undefined) {
    const bf = ctx.publicWeenieBitfield;
    playerKiller = (bf & 0x20) ? 'Player Killer' : (bf & 0x02000000) ? 'Player Killer Lite' : 'Non-Player Killer';
  }

  const misc: MiscInfoLine[] = [];
  const society = societyLine(d, ctx.viewerFaction1Bits ?? 0);
  if (society) misc.push(society);

  // Window title: AllegianceData::GetFullName @ 005b6950 — "<title> <name>" or the name.
  const rank = pi(PI.AllegianceRank) ?? 0;
  const objectName = ctx.objectName ?? '';
  const rankTitle = (ctx.allegianceRankTitle ?? getAllegianceRankTitle)(heritage, gender, rank);
  const windowTitle = rankTitle ? `${rankTitle} ${objectName}` : objectName;

  let allegianceName = '';
  if (rank >= 1) {
    allegianceName = ps(PS.AllegianceName) ?? '';
    const monarch = ps(PS.MonarchsTitle);
    if (monarch === undefined) {
      let followers = pi(PI.AllegianceFollowers) ?? 0;
      if (followers < 0) followers = 0;
      misc.push({ label: 'Alleg. Monarch:', value: followers === 1 ? '1 Follower' : `${followers} Followers`, color: 0 });
    } else {
      const patron = ps(PS.PatronsTitle);
      if (patron === undefined) misc.push({ label: 'Monarch:', value: monarch, color: 0 });
      else if (patron === monarch) misc.push({ label: 'Monarch/Patron:', value: monarch, color: 0 });
      else {
        misc.push({ label: 'Monarch:', value: monarch, color: 0 });
        misc.push({ label: 'Patron:', value: patron, color: 0 });
      }
    }
  }

  // Armor block (asm 004b4f54-004b53a4): AppraisalProfile base_armor_* in wire order.
  const al = d.armorLevels;
  if (al) {
    const all = [al.head, al.chest, al.abdomen, al.upperArm, al.lowerArm, al.hand, al.upperLeg, al.lowerLeg, al.foot];
    if (all.some(v => (v | 0) > 0)) {
      const cells = (a: number, b: number, c: number) => `AL: ${armorLevelCell(a)}/${armorLevelCell(b)}/${armorLevelCell(c)}`;
      misc.push(BLANK);
      misc.push({ label: 'Head/Chest/Groin', value: cells(al.head, al.chest, al.abdomen), color: 0 });
      misc.push({ label: 'Bicep/Wrist/Hand', value: cells(al.upperArm, al.lowerArm, al.hand), color: 0 });
      misc.push({ label: 'Thigh/Shin/Foot', value: cells(al.upperLeg, al.lowerLeg, al.foot), color: 0 });
    }
  }

  misc.push(...ratingLines(d));

  const fellowship = ps(PS.Fellowship);
  if (fellowship !== undefined) misc.push({ label: 'Fellowship:', value: fellowship, color: 0 });
  const dob = ps(PS.DateOfBirth);
  if (dob !== undefined) misc.push({ label: 'Arrived in Dereth:', value: dob, color: 0 });
  const age = pi(PI.Age);
  if (age !== undefined) misc.push({ label: 'Time in Dereth:', value: deltaTimeToString(age), color: 0 });
  const chess = pi(PI.ChessRank);
  if (chess !== undefined) misc.push({ label: 'Chess Rank:', value: `${chess}`, color: 0 });
  const fishing = pi(PI.FakeFishingSkill);
  if (fishing !== undefined) misc.push({ label: 'Fishing Skill:', value: `${fishing}`, color: 0 });
  const deaths = pi(PI.NumDeaths);
  if (deaths !== undefined) misc.push({ label: 'Deaths:', value: deaths < 1 ? 'Has never died' : `${deaths}`, color: 0 });
  const titles = pi(PI.NumCharacterTitles);
  if (titles !== undefined) misc.push({ label: 'Titles Earned:', value: `${titles}`, color: 0 });
  misc.push({ label: '* = Unenchantable', value: '', color: 0 });

  return {
    page: 'character',
    headerPanel: CREATURE_EXAMINE_ELEMENTS.characterHeader,
    heritage: genderHeritageDisplay(gender, heritage, creatureType, ctx),
    title,
    playerKiller,
    allegianceName,
    windowTitle,
    level: creatureLevelText(d),
    stats: creatureStatRows(d, ctx.success),
    miscInfo: misc,
  };
}

/** Dispatch like gmExaminationUI::SetAppraiseInfo; null when the response has no creature profile (item page). */
export function buildCreatureExaminePage(d: IdentifyResponseData, ctx: CreatureExamineContext): CreaturePageModel | CharacterPageModel | null {
  const sub = creatureExamineSubPage(d);
  if (sub === 'character') return buildCharacterPage(d, ctx);
  if (sub === 'creature') return buildCreaturePage(d, ctx);
  return null;
}

/**
 * The paper-doll viewport setup (BasicCreatureExamineUI::Init @ 004ab9c0):
 * a copy of the object's CPhysicsObj, heading 191.3679°, DISTANT_LIGHT
 * intensity 2.0 along (0.3, 1.9, 0.65); camera at the bbox centre pulled
 * back along −Y by (fit + dy/2), fit = max(dz, dx·h/w)·1.2071068, looking
 * with zero angles.
 */
export const PAPER_DOLL = {
  heading: 191.3679,
  light: { type: 'distant' as const, intensity: 2.0, direction: [0.3, 1.9, 0.65] as const },
  fitScale: 1.2071068,
} as const;

export function paperDollCameraOffsetY(bbox: { dx: number; dy: number; dz: number }, viewW: number, viewH: number): number {
  let fit = bbox.dz;
  if (bbox.dz / bbox.dx < viewH / viewW) fit = bbox.dx * (viewH / viewW);
  fit *= PAPER_DOLL.fitScale;
  return -(fit + bbox.dy * 0.5);
}
