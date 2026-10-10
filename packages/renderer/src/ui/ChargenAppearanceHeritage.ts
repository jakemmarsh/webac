/**
 * CHARGEN.appearance-gear-olthoi — what `gmCGAppearancePage::Update`
 * @ 0047e8f0 does to the Face page per heritage (decomp :129023-129215):
 *
 *  - Gearknight (6): hides the Clothes button and the Nose / Mouth rows
 *    (SetVisible via vtable +0x18), labels Hair / Eyes / Skin with
 *    ID_CharGen_GearText_{Hair,Eyes,Skin}Button (table enum 0x10000002 =
 *    0x23000002), disables the Eyes row's arrows 0x1000030a / 0x1000030b
 *    (SetAttribute_Bool(0xd, true)), moves the Skin row to (0, 0x5a) (vtable
 *    +0x2c), then SetChoice(FACE) + SetSelection(HAIR). Coming from another
 *    heritage (m_LastHeritageGroup != 6) it first runs RandomizeAppearance(0)
 *    + RandomizeClothing(1).
 *  - Olthoi (12) / Olthoi Acid (13): the same layout with the OlthoiText
 *    strings, no randomizing.
 *  - Every other heritage: the ordinary labels (ID_CharGen_HairStyle /
 *    _Eyes / _Skin), the Eyes arrows enabled, the rows and Clothes shown;
 *    coming from Gearknight (m_LastHeritageGroup == 6) it randomizes first.
 *
 * Ours drew every heritage's page the ordinary way — a Gearknight or Olthoi
 * got Nose / Mouth / Clothes pickers and live Eyes arrows retail never offers.
 */

export const HERITAGE_GEARKNIGHT = 6;
export const HERITAGE_OLTHOI = 12;
export const HERITAGE_OLTHOI_ACID = 13;

/** The Face stack's rows in 0x21000049. */
export const APPEARANCE_ROWS = {
  hair: 0x100003af, eyes: 0x100003b0, nose: 0x100003b1, mouth: 0x100003b2, skin: 0x100003b3,
} as const;
/** gmCGAppearancePage::m_pFaceChoices / m_pClothesChoices — the two row stacks SetChoice swaps. */
export const APPEARANCE_FACE_STACK = 0x100003ae;
export const APPEARANCE_CLOTHES_STACK = 0x100003b4;
/** The Clothes mode button. */
export const APPEARANCE_CLOTHES_BUTTON = 0x100003aa;
/** Update's SetPosition(0, 0x5a) on the Skin row for Gearknight / Olthoi. */
export const APPEARANCE_SKIN_ROW_LIMITED_Y = 0x5a;

export interface AppearanceHeritageRules {
  /** Gearknight / Olthoi: the reduced page. */
  limited: boolean;
  /** Rows Update hides. */
  hiddenRows: ReadonlySet<number>;
  clothesHidden: boolean;
  eyesArrowsDisabled: boolean;
  /** The Skin row's y when Update moves it, else null (its DAT place). */
  skinRowY: number | null;
  /** The row-label tokens (table 0x23000002) when Update relabels them, else null. */
  labels: { hair: string; eyes: string; skin: string } | null;
}

const NORMAL: AppearanceHeritageRules = {
  limited: false, hiddenRows: new Set(), clothesHidden: false, eyesArrowsDisabled: false, skinRowY: null, labels: null,
};

export function appearanceHeritageRules(heritage: number): AppearanceHeritageRules {
  const gear = heritage === HERITAGE_GEARKNIGHT;
  if (!gear && heritage !== HERITAGE_OLTHOI && heritage !== HERITAGE_OLTHOI_ACID) return NORMAL;
  const t = gear ? 'GearText' : 'OlthoiText';
  return {
    limited: true,
    hiddenRows: new Set([APPEARANCE_ROWS.nose, APPEARANCE_ROWS.mouth]),
    clothesHidden: true,
    eyesArrowsDisabled: true,
    skinRowY: APPEARANCE_SKIN_ROW_LIMITED_Y,
    labels: {
      hair: `ID_CharGen_${t}_HairButton`,
      eyes: `ID_CharGen_${t}_EyesButton`,
      skin: `ID_CharGen_${t}_SkinButton`,
    },
  };
}

/**
 * Update's m_LastHeritageGroup step: whether to RandomizeAppearance(0) +
 * RandomizeClothing(1) before laying the page out. Gearknight randomizes
 * coming from any other heritage, an ordinary heritage coming from
 * Gearknight; Olthoi never. Update ends in SetSelection @ 0047e260, which
 * stores the current heritage, so the kept value is always `heritage`.
 */
export function appearanceUpdateRandomize(lastHeritage: number, heritage: number): { randomize: boolean; last: number } {
  if (heritage === HERITAGE_GEARKNIGHT) return { randomize: lastHeritage !== HERITAGE_GEARKNIGHT, last: heritage };
  if (heritage === HERITAGE_OLTHOI || heritage === HERITAGE_OLTHOI_ACID) return { randomize: false, last: heritage };
  return { randomize: lastHeritage === HERITAGE_GEARKNIGHT, last: heritage };
}
