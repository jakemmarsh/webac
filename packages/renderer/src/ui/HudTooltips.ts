/**
 * CORE.17.k.b.b.a.g — the in-game (HUD) hover tooltips: which 0x21000041
 * root the HUD elements name, the per-root box geometry, and the texts the
 * retail client sets through UIElement::SetTooltip on its item icons,
 * paperdoll slots, spell shortcuts and the radar.
 *
 * Ground truth (the decompiled EoL client + client_local_English.dat,
 * docs/retail-client-symbols.md CORE.17.k.b.b.a.g):
 *  - Every in-game element the DAT gives a tooltip names root 0x10000395
 *    in p71 (the toolbar's selected-item field 0x21000016:0x1000019f, the
 *    paperdoll drag band 0x21000024:0x100001d6, the chat / vitals / panel
 *    title texts …); 0x10000397 is the paperdoll's "Slots" gem 0x100005be,
 *    0x10000398 the map notes (0x21000026, font 0x40000015). The chargen
 *    pages use 0x10000487 (DatTooltip.ts).
 *  - Layout 0x21000041: 0x10000487 / 0x10000397 hold their text child
 *    0x10000396 at (2,2) 26x26 with p60 MaxHeight 512; 0x10000395 /
 *    0x10000398 hold it at (2,1) 26x28 with p60 128 — the same 30x30 chrome
 *    (fill 0x06004cc2, 1-px edges 0x06004cc8), one pixel less inset above
 *    and below. p61 MaxWidth is 256 on all four.
 *  - UIElement_UIItem::UpdateTooltip @ 004e1cb0: the item's
 *    GetObjectNameWide(NameType 2 − (stack > 1)) — the plural for a stack —
 *    sprintf'd with the stack count when it is above 1 (the exe's L"%d %s"),
 *    then SetTooltip + the SetTooltipOn bit (| 0x20). Nothing else: no
 *    value, burden, stack or effect lines.
 *  - gmPaperDollUI::UpdateItemSlotTooltip @ 004a4e90: an empty slot carries
 *    its "Drag … here to …" literal (below, per slot), an occupied one the
 *    worn item's GetObjectNameWide(id, 2).
 *  - SpellCastSubMenu::UpdateFromPlayerModule @ 004c6570 / AddFavorite @
 *    004c7060: each spell shortcut's tooltip is CSpellBase::InqName — the
 *    spell's name alone.
 *  - gmRadarUI::DrawObjects @ 004d9380: the nearest blip within 5 px gets
 *    GetObjectNameWide(obj, 2) as the radar element's own tooltip;
 *    nothing under the mouse → ClearTooltip + the bit cleared.
 *  - UIElement::SetTooltip @ 004617c0: a changed text while this element
 *    owns the shown tooltip → UIElementManager::ResetTooltip.
 */
import { EquipMask, getAppropriateName } from '@ac/shared';
import { TOOLTIP_ROOT_ELEMENT, TOOLTIP_MAX_HEIGHT, TOOLTIP_MAX_WIDTH, TOOLTIP_TEXT_INSET, TOOLTIP_FONT, TOOLTIP_TEXT_MARGIN } from './DatTooltip.js';

/**
 * CORE.17.k.b.b.a.g.a — the remaining retail SetTooltip carriers, decoded
 * from the decompiled EoL client (docs/retail-client-symbols.md):
 *  - AttributeInfoRegion / Attribute2ndInfoRegion / SkillInfoRegion ctors
 *    (@ 004f1530 / 004f1680 / 004f2140): the character panel's list ROW
 *    (m_pElement, `[esi+0x8]`, the 0x10000248 template item) carries
 *    SkillSystem::InqAttributeDescription / InqAttribute2ndDescription (the
 *    exe's literals below) / SkillInfoRegion::GetTooltip @ 004f1fe0 =
 *    InqSkillFormula + "\n" + the SkillTable description.
 *  - SkillSystem::InqSkillFormula @ 005c89b0: "( " [ "(" ] term1 [ " + " term2
 *    ")" ] [ " / %u" when z ≠ 1 ] [ "+%u" when w ≠ 0 ] " )", a term being the
 *    attribute name or "(%u x %s)" when its multiplier is above 1.
 *  - gmSpellcastingUI::UpdateCastButtonTooltip @ 004c6a30: the Cast button
 *    0x100000b2's tooltip — "Select a spell to cast" / "You have no spells
 *    ready to cast" without a selection; with one, "CAST %hs" (untargeted /
 *    self spells, or with a compatible target: + " on %s"), "You must select a
 *    target for %hs", "You must select an appropriate target for %hs".
 *  - gmMapUI::PostInit @ 004a1c70: 53 `s_rgLocations` (.rdata 0x7aa3f8)
 *    become 0x100001f0 children of the map 0x100001ec (AddMapNote @ 004a1bb0:
 *    MoveTo / ResizeTo / SetTooltip(name)); 0x100001f0 names root 0x10000398
 *    with p80 0 — the town's name shows at once.
 *  - UIElement_SmartBoxWrapper::RecvNotice_SmartBoxObjectFound @ 004e5ad0:
 *    the 3D view 0x2100000f:0x10000037 (root 0x10000395) carries the object
 *    under the mouse's GetObjectName(NAME_APPROPRIATE) while
 *    PlayerModule::ShowTooltips is on (WorldHoverTooltip.ts).
 *  - Layout 0x21000041 through the base chain (0x2100003f): 0x10000395 /
 *    0x10000397 / 0x10000487's text child is font 0x40000002, white, margins
 *    2 all round, vertically centred; 0x10000398's is font 0x40000015, white,
 *    margins 2 left / right only, top-aligned.
 */

/** The 0x21000041 root every in-game HUD element names in p71. */
export const HUD_TOOLTIP_ROOT = 0x10000395;
/** The paperdoll "Slots" gem 0x21000024:0x100005be names this root. */
export const PAPERDOLL_GEM_TOOLTIP_ROOT = 0x10000397;
/** The map notes (0x21000026) name this root — its text child is in font 0x40000015. */
export const MAP_NOTE_TOOLTIP_ROOT = 0x10000398;

export interface TooltipRootGeometry {
  /** The text child's x inside the root (its left; the right inset is the same). */
  insetX: number;
  /** The text child's y inside the root (its top; the bottom inset is the same). */
  insetY: number;
  /** The text child's p60 MaxHeight. */
  maxHeight: number;
  /** The text child's p61 MaxWidth. */
  maxWidth: number;
  /** The text child's p26 font through the base chain (0x2100003f). */
  font: number;
  /** The text child's p35 / p36 margins. */
  marginX: number;
  /** The text child's p37 / p38 margins (0x10000398 carries none). */
  marginY: number;
  /** The text child's p21: 1 = vertically centred, absent = top. */
  vCenter: boolean;
}

/** The map notes' root 0x10000398 draws its text child in this font (base 0x2100003f:0x10000373). */
export const MAP_NOTE_TOOLTIP_FONT = 0x40000015;

/** Layout 0x21000041's four roots — the text child 0x10000396's rect at the 30x30 default size. */
export const TOOLTIP_ROOT_GEOMETRY: Readonly<Record<number, TooltipRootGeometry>> = {
  [TOOLTIP_ROOT_ELEMENT]: { insetX: TOOLTIP_TEXT_INSET, insetY: 2, maxHeight: TOOLTIP_MAX_HEIGHT, maxWidth: TOOLTIP_MAX_WIDTH, font: TOOLTIP_FONT, marginX: TOOLTIP_TEXT_MARGIN, marginY: TOOLTIP_TEXT_MARGIN, vCenter: true },
  [HUD_TOOLTIP_ROOT]: { insetX: TOOLTIP_TEXT_INSET, insetY: 1, maxHeight: 128, maxWidth: TOOLTIP_MAX_WIDTH, font: TOOLTIP_FONT, marginX: TOOLTIP_TEXT_MARGIN, marginY: TOOLTIP_TEXT_MARGIN, vCenter: true },
  [PAPERDOLL_GEM_TOOLTIP_ROOT]: { insetX: TOOLTIP_TEXT_INSET, insetY: 2, maxHeight: TOOLTIP_MAX_HEIGHT, maxWidth: TOOLTIP_MAX_WIDTH, font: TOOLTIP_FONT, marginX: TOOLTIP_TEXT_MARGIN, marginY: TOOLTIP_TEXT_MARGIN, vCenter: true },
  [MAP_NOTE_TOOLTIP_ROOT]: { insetX: TOOLTIP_TEXT_INSET, insetY: 1, maxHeight: 128, maxWidth: TOOLTIP_MAX_WIDTH, font: MAP_NOTE_TOOLTIP_FONT, marginX: TOOLTIP_TEXT_MARGIN, marginY: 0, vCenter: false },
};

/** The geometry for a root (an unknown root gets the chargen root's). */
export function tooltipRootGeometry(rootId: number | undefined): TooltipRootGeometry {
  return TOOLTIP_ROOT_GEOMETRY[rootId ?? TOOLTIP_ROOT_ELEMENT] ?? TOOLTIP_ROOT_GEOMETRY[TOOLTIP_ROOT_ELEMENT];
}

/** 0x21000024:0x100001d6's p73 — "Drag clothing and armor here to wear them" (table 0x23000001). */
export const PAPERDOLL_DRAG_BAND_TOOLTIP_STRING = 145646981;

/** The exe's format for a stack's tooltip (UIElement_UIItem::UpdateTooltip). */
export const ITEM_STACK_TOOLTIP_FORMAT = '%d %s';

/**
 * UIElement_UIItem::UpdateTooltip @ 004e1cb0: a stack above 1 reads
 * "<count> <plural name>", anything else the item's name.
 */
export function itemTooltipText(name: string, pluralName: string | undefined, stackSize: number | undefined): string {
  const n = stackSize ?? 0;
  if (n > 1) return `${n} ${getAppropriateName(name, pluralName, n)}`;
  return name;
}

/** gmPaperDollUI::UpdateItemSlotTooltip's empty-slot literals, in the function's own test order. */
export const PAPERDOLL_EMPTY_SLOT_TOOLTIPS: ReadonlyArray<{ mask: number; text: string }> = [
  { mask: EquipMask.NeckWear, text: 'Drag necklaces here to wear them' },
  { mask: EquipMask.WristWearLeft | EquipMask.WristWearRight, text: 'Drag bracelets here to wear them' },
  { mask: EquipMask.FingerWearLeft | EquipMask.FingerWearRight, text: 'Drag rings here to wear them' },
  { mask: EquipMask.MeleeWeapon | EquipMask.MissileWeapon | EquipMask.Held | EquipMask.TwoHanded, text: 'Drag weapons here to wield them' },
  { mask: EquipMask.MissileAmmo, text: 'Drag missile ammunition here to wield it' },
  { mask: EquipMask.Shield, text: 'Drag shields here to wield them' },
  { mask: EquipMask.TrinketOne, text: 'Drag trinkets here to activate them' },
  { mask: EquipMask.Cloak, text: 'Drag cloaks here to activate them' },
  { mask: EquipMask.SigilOne, text: 'Drag a Blue Aetheria sigil here to activate it' },
  { mask: EquipMask.SigilTwo, text: 'Drag a Yellow Aetheria sigil here to activate it' },
  { mask: EquipMask.SigilThree, text: 'Drag a Red Aetheria sigil here to activate it' },
  { mask: EquipMask.UpperLegWear | EquipMask.ChestWear, text: 'Drag clothing items here to wear them' },
  { mask: EquipMask.HeadWear, text: 'Drag head items here to wear them' },
  { mask: EquipMask.ChestArmor, text: 'Drag chest items here to wear them' },
  { mask: EquipMask.AbdomenArmor, text: 'Drag abdomen items here to wear them' },
  { mask: EquipMask.UpperArmArmor, text: 'Drag upper arm items here to wear them' },
  { mask: EquipMask.LowerArmArmor, text: 'Drag lower arm items here to wear them' },
  { mask: EquipMask.HandWear, text: 'Drag glove items here to wear them' },
  { mask: EquipMask.UpperLegArmor, text: 'Drag upper leg items here to wear them' },
  { mask: EquipMask.LowerLegArmor, text: 'Drag lower leg items here to wear them' },
  { mask: EquipMask.FootWear, text: 'Drag foot coverings here to wear them' },
];

/** The empty-slot literal for a paperdoll slot's mask (null: retail has none — the tooltip stays empty). */
export function paperdollEmptySlotTooltip(slotMask: number): string | null {
  for (const { mask, text } of PAPERDOLL_EMPTY_SLOT_TOOLTIPS) if ((slotMask & mask) !== 0) return text;
  return null;
}

/**
 * gmPaperDollUI::UpdateItemSlotTooltip @ 004a4e90: the worn item's name, or
 * the slot's "Drag … here" literal while it is empty.
 */
export function paperdollSlotTooltip(slotMask: number, equippedName: string | null | undefined): string | null {
  if (equippedName) return equippedName;
  return paperdollEmptySlotTooltip(slotMask);
}

/** SpellCastSubMenu::UpdateFromPlayerModule @ 004c6570: the shortcut's tooltip is the spell's name. */
export function spellShortcutTooltip(spellName: string): string {
  return spellName;
}

/* ── the paperdoll "Slots" gem ─────────────────────────────────────── */

/** 0x21000024:0x100005be's p73 — "When this option is chosen, you will see explicit equipment slots…" (table 0x23000001). */
export const PAPERDOLL_SLOTS_GEM_TOOLTIP_STRING = 130562064;

/* ── the character panel rows ──────────────────────────────────────── */

/** SkillSystem::InqAttributeDescription @ 005c8e30 — by PropertyAttribute id (the exe's literals; Coordination's has no period). */
export const ATTRIBUTE_ROW_TOOLTIPS: Readonly<Record<number, string>> = {
  1: "Measures your character's muscular power.",
  2: 'Measures how healthy your character is.',
  3: 'Measures how fast your character is.',
  4: "Measures your character's reflexes",
  5: "Measures your character's mind and senses.",
  6: "Measures your character's willpower.",
};

/** AttributeInfoRegion @ 004f1530: the row's tooltip is the attribute's description (null: none — InqAttributeDescription returns false). */
export function attributeRowTooltip(attributeId: number): string | null {
  return ATTRIBUTE_ROW_TOOLTIPS[attributeId] ?? null;
}

/**
 * SkillSystem::InqAttribute2ndDescription @ 005c8f70 — by PropertyAttribute2nd
 * id; the Max / current pairs (1/2, 3/4, 5/6) share a text. Two lines (the
 * exe's "\n"): the formula, then the effect.
 */
export const VITAL_ROW_TOOLTIPS: Readonly<Record<number, string>> = {
  1: '(Endurance/2)\nIf you run out of health, you will die!',
  2: '(Endurance/2)\nIf you run out of health, you will die!',
  3: '(Endurance)\nAffects your actions and movement.',
  4: '(Endurance)\nAffects your actions and movement.',
  5: '(Self)\nAffects how much magic you can cast.',
  6: '(Self)\nAffects how much magic you can cast.',
};

/** Attribute2ndInfoRegion @ 004f1680: the row's tooltip is the vital's description. */
export function vitalRowTooltip(attribute2ndId: number): string | null {
  return VITAL_ROW_TOOLTIPS[attribute2ndId] ?? null;
}

/** SkillSystem::InqAttributeName @ 005c8800 — the names InqSkillFormula prints. */
export const FORMULA_ATTRIBUTE_NAMES: Readonly<Record<number, string>> = {
  1: 'Strength', 2: 'Endurance', 3: 'Quickness', 4: 'Coordination', 5: 'Focus', 6: 'Self',
};

/** The exe's fragments (.rdata 0x7e7930–0x7e7954). */
export const SKILL_FORMULA_FRAGMENTS = {
  open: '( ', close: ' )', groupOpen: '(', groupClose: ')', plus: ' + ',
  term: '(%u x %s)', divisor: ' / %u', offset: '+%u',
} as const;

export interface SkillFormulaLike { w: number; x: number; y: number; z: number; attr1: number; attr2: number }

/**
 * SkillSystem::InqSkillFormula @ 005c89b0: null when neither term exists
 * (x or attr1 zero AND y or attr2 zero); else "( " + [ "(" ] + term1 +
 * [ " + " + term2 + ")" ] + [ " / z" when z ≠ 1 ] + [ "+w" when w ≠ 0 ] + " )",
 * where a term is the attribute's name, or "(n x name)" when its multiplier
 * is above 1.
 */
export function skillFormulaText(f: SkillFormulaLike): string | null {
  const has1 = f.x !== 0 && f.attr1 !== 0;
  const has2 = f.y !== 0 && f.attr2 !== 0;
  if (!has1 && !has2) return null;
  const both = has1 && has2;
  const term = (mult: number, attr: number): string => {
    const name = FORMULA_ATTRIBUTE_NAMES[attr] ?? '';
    return mult > 1 ? `(${mult} x ${name})` : name;
  };
  let s = SKILL_FORMULA_FRAGMENTS.open;
  if (both) s += SKILL_FORMULA_FRAGMENTS.groupOpen;
  if (has1) s += term(f.x, f.attr1);
  if (both) s += SKILL_FORMULA_FRAGMENTS.plus;
  if (has2) s += term(f.y, f.attr2);
  if (both) s += SKILL_FORMULA_FRAGMENTS.groupClose;
  if (f.z !== 1) s += ` / ${f.z}`;
  if (f.w !== 0) s += `+${f.w}`;
  return s + SKILL_FORMULA_FRAGMENTS.close;
}

/**
 * SkillInfoRegion::GetTooltip @ 004f1fe0: the formula + "\n" when the skill
 * has one, then the SkillTable description (InqSkillDescription) when it is
 * not empty. Null when both are missing (the row shows no tooltip).
 */
export function skillRowTooltip(skill: { formula?: SkillFormulaLike; description?: string } | null | undefined): string | null {
  if (!skill) return null;
  const formula = skill.formula ? skillFormulaText(skill.formula) : null;
  let s = formula ? `${formula}\n` : '';
  if (skill.description) s += skill.description;
  return s === '' ? null : s;
}

/* ── the spell bar's Cast button ───────────────────────────────────── */

/** gmSpellcastingUI::PostInit @ 004c78d0: m_spellcastButton is 0x100000b2 (the outlined "Cast" text), m_spellName 0x1000048b, m_endowmentIcon 0x100000b1. */
export const SPELLBAR_CAST_BUTTON = 0x100000b2;
export const SPELLBAR_SPELL_NAME_TEXT = 0x1000048b;
export const SPELLBAR_ENDOWMENT_ICON = 0x100000b1;

/** The exe's literals / formats (UpdateCastButtonTooltip @ 004c6a30, .rdata 0x7b6348–0x7b6520). */
export const CAST_BUTTON_TOOLTIPS = {
  noSpells: 'You have no spells ready to cast',
  selectSpell: 'Select a spell to cast',
  cast: 'CAST %hs',
  on: ' on %s',
  selectTarget: 'You must select a target for %hs',
  selectAppropriateTarget: 'You must select an appropriate target for %hs',
  // CORE.17.k.b.b.a.g.e — the endowment branch (m_endowmentItemID set, no
  // spell selected): m_spellName "%s (%hs)" (0x7b64d8: the item's name, the
  // spell's name), "USE the %s" (0x7b64c0), "You must select a target for
  // the %s" (0x7b6478), "You must select an appropriate\ntarget for the %s"
  // (0x7b6400) — %s = GetObjectNameWide(item, 2).
  endowmentName: '%s (%hs)',
  use: 'USE the %s',
  selectTargetForItem: 'You must select a target for the %s',
  selectAppropriateTargetForItem: 'You must select an appropriate\ntarget for the %s',
} as const;

/** The endowment item UpdateCastButtonTooltip reads when no spell is selected. */
export interface CastButtonEndowment {
  /** GetObjectNameWide(m_endowmentItemID, 2). */
  itemName: string;
  /** CSpellBase::InqName(m_endowmentSpellID). */
  spellName: string;
  /** ItemUses::IsUseable_SelfTarget(pwd._useability): no target needed. */
  selfTarget: boolean;
  /** ItemHolder::TargetCompatibleWithObject(selectedID, item, true, false). */
  targetCompatible?: boolean;
}

export interface CastButtonTooltipState {
  /** CSpellBase::InqName of the sub-menu's m_selectedSpellID (null: none selected). */
  selectedSpellName: string | null;
  /** Any shortcut on any of the 8 sub-menus (the m_numSpells sum). */
  anySpellReady: boolean;
  /** CSpellBase::IsUntargeted, or the self-target bit (_bitfield & 8): no target needed. */
  untargeted?: boolean;
  /** GetObjectNameWide(ACCWeenieObject::selectedID, 2) — null: nothing selected. */
  targetName?: string | null;
  /** ClientMagicSystem::ObjectCompatibleWithSpell(selectedID, spell). */
  targetCompatible?: boolean;
  /** m_endowmentItemID != 0: the wielded caster's item spell (its branch runs only without a spell selection). */
  endowment?: CastButtonEndowment | null;
  /** m_endowmentPresent — with it the no-selection text is never "You have no spells ready to cast". */
  endowmentPresent?: boolean;
}

export interface CastButtonTooltip {
  text: string;
  castable: boolean;
  /** UIElement_Text::SetText(m_spellName): the spell's name, or "%s (%hs)" for the endowment; '' when cleared. */
  nameField: string;
}

/**
 * gmSpellcastingUI::UpdateCastButtonTooltip @ 004c6a30: without a selection,
 * "Select a spell to cast" or, with no shortcut anywhere and no endowment,
 * "You have no spells ready to cast"; with one, "CAST <spell>" for an
 * untargeted / self spell, "You must select a target for <spell>" without a
 * target, "CAST <spell> on <target>" for a compatible one, "You must select
 * an appropriate target for <spell>" otherwise. With the endowment item and
 * no spell selected (CORE.17.k.b.b.a.g.e): m_spellName "<item> (<spell>)",
 * "USE the <item>" for a self-target item, "You must select a target for the
 * <item>" without a target, "USE the <item> on <target>" for a compatible
 * one, "You must select an appropriate\ntarget for the <item>" otherwise.
 * The button enters state 1 (castable) only on the CAST / USE texts.
 */
export function castButtonTooltip(state: CastButtonTooltipState): CastButtonTooltip {
  const name = state.selectedSpellName;
  if (!name) {
    const e = state.endowment;
    if (e) {
      const nameField = CAST_BUTTON_TOOLTIPS.endowmentName.replace('%s', e.itemName).replace('%hs', e.spellName);
      if (e.selfTarget) return { text: CAST_BUTTON_TOOLTIPS.use.replace('%s', e.itemName), castable: true, nameField };
      if (!state.targetName) return { text: CAST_BUTTON_TOOLTIPS.selectTargetForItem.replace('%s', e.itemName), castable: false, nameField };
      if (e.targetCompatible) {
        return { text: CAST_BUTTON_TOOLTIPS.use.replace('%s', e.itemName) + CAST_BUTTON_TOOLTIPS.on.replace('%s', state.targetName), castable: true, nameField };
      }
      return { text: CAST_BUTTON_TOOLTIPS.selectAppropriateTargetForItem.replace('%s', e.itemName), castable: false, nameField };
    }
    const noSpells = !state.anySpellReady && !state.endowmentPresent;
    return { text: noSpells ? CAST_BUTTON_TOOLTIPS.noSpells : CAST_BUTTON_TOOLTIPS.selectSpell, castable: false, nameField: '' };
  }
  if (state.untargeted) return { text: CAST_BUTTON_TOOLTIPS.cast.replace('%hs', name), castable: true, nameField: name };
  if (!state.targetName) return { text: CAST_BUTTON_TOOLTIPS.selectTarget.replace('%hs', name), castable: false, nameField: name };
  if (state.targetCompatible) {
    return { text: CAST_BUTTON_TOOLTIPS.cast.replace('%hs', name) + CAST_BUTTON_TOOLTIPS.on.replace('%s', state.targetName), castable: true, nameField: name };
  }
  return { text: CAST_BUTTON_TOOLTIPS.selectAppropriateTarget.replace('%hs', name), castable: false, nameField: name };
}

/* ── the map notes ─────────────────────────────────────────────────── */

/** gmMapUI's LocationRolloverInfo: a rect on the 257x267 map 0x100001ec and the tooltip it shows. */
export interface MapNoteLocation { x: number; y: number; width: number; height: number; name: string }

/** 0x21000026:0x100001ec's p71: the note template 0x100001f0 (its own root is 0x10000398 with p80 0). */
export const MAP_NOTE_TEMPLATE_ELEMENT = 0x100001f0;
/** 0x100001f0's p80 — the town name shows with no delay. */
export const MAP_NOTE_TOOLTIP_DELAY_SECONDS = 0;
/** 0x21000026:0x100001ee's p73 — "Your House" (the house icon, root 0x10000398, p80 0). */
export const MAP_HOUSE_ICON_TOOLTIP_STRING = 258601413;

/** acclient.exe `s_rgLocations` @ .rdata 0x7aa3f8 — the 53 entries gmMapUI::PostInit @ 004a1c70 adds (0x35, in table order). */
export const MAP_NOTE_LOCATIONS: readonly MapNoteLocation[] = [
  { x: 178, y: 20, width: 11, height: 12, name: 'Aerlinthe Island' },
  { x: 18, y: 74, width: 5, height: 5, name: 'Ahurenga' },
  { x: 141, y: 166, width: 7, height: 6, name: 'Al-Arqas' },
  { x: 129, y: 121, width: 7, height: 6, name: 'Al-Jalima' },
  { x: 190, y: 88, width: 9, height: 8, name: 'Arwic' },
  { x: 19, y: 201, width: 7, height: 6, name: 'Ayan Baqur' },
  { x: 200, y: 190, width: 7, height: 6, name: 'Baishi' },
  { x: 184, y: 53, width: 5, height: 5, name: 'Bandit Castle' },
  { x: 34, y: 84, width: 5, height: 5, name: 'Bluespire' },
  { x: 44, y: 235, width: 5, height: 5, name: 'Candeth Keep' },
  { x: 180, y: 97, width: 9, height: 8, name: 'Cragstone' },
  { x: 91, y: 102, width: 5, height: 5, name: "Danby's Outpost" },
  { x: 211, y: 138, width: 9, height: 8, name: 'Dryreach' },
  { x: 199, y: 106, width: 9, height: 8, name: 'Eastham' },
  { x: 56, y: 13, width: 5, height: 5, name: 'Fiun Outpost' },
  { x: 37, y: 127, width: 9, height: 8, name: 'Fort Tethana' },
  { x: 156, y: 94, width: 9, height: 8, name: 'Glenden Wood' },
  { x: 43, y: 79, width: 5, height: 5, name: 'Greenspire' },
  { x: 224, y: 177, width: 7, height: 6, name: 'Hebian-to' },
  { x: 164, y: 77, width: 9, height: 8, name: 'Holtburg' },
  { x: 182, y: 230, width: 7, height: 6, name: 'Kara' },
  { x: 155, y: 185, width: 7, height: 6, name: 'Khayyaban' },
  { x: 224, y: 218, width: 7, height: 6, name: 'Kryst' },
  { x: 212, y: 195, width: 7, height: 6, name: 'Lin' },
  { x: 159, y: 224, width: 5, height: 5, name: 'Linvak Tukal' },
  { x: 185, y: 126, width: 9, height: 8, name: 'Lytelthorpe' },
  { x: 235, y: 220, width: 7, height: 6, name: "MacNiall's Freehold" },
  { x: 223, y: 203, width: 7, height: 6, name: 'Mayoi' },
  { x: 141, y: 53, width: 5, height: 5, name: 'Mt Esper-Crater Village' },
  { x: 224, y: 191, width: 7, height: 6, name: 'Nanto' },
  { x: 142, y: 46, width: 5, height: 5, name: 'Neydisa' },
  { x: 240, y: 128, width: 5, height: 5, name: "Oolutanga's Refuge" },
  { x: 74, y: 79, width: 5, height: 5, name: 'Plateau Village' },
  { x: 148, y: 218, width: 7, height: 6, name: "Qalaba'r" },
  { x: 26, y: 83, width: 5, height: 5, name: 'Redspire' },
  { x: 193, y: 114, width: 9, height: 8, name: 'Rithwic' },
  { x: 146, y: 133, width: 7, height: 6, name: 'Samsur' },
  { x: 50, y: 42, width: 5, height: 5, name: 'Sanamar' },
  { x: 195, y: 163, width: 7, height: 6, name: 'Sawato' },
  { x: 213, y: 171, width: 7, height: 6, name: 'Shoushi' },
  { x: 41, y: 25, width: 5, height: 5, name: 'Silyun' },
  { x: 6, y: 239, width: 15, height: 16, name: 'Singularity Caul Island' },
  { x: 100, y: 48, width: 5, height: 5, name: 'Stonehold' },
  { x: 32, y: 76, width: 5, height: 5, name: 'Timaru' },
  { x: 239, y: 163, width: 7, height: 6, name: 'Tou-Tou' },
  { x: 131, y: 148, width: 7, height: 6, name: 'Tufa' },
  { x: 112, y: 244, width: 5, height: 5, name: "Ulgrim's Island" },
  { x: 159, y: 160, width: 7, height: 6, name: 'Uziz' },
  { x: 63, y: 203, width: 7, height: 6, name: 'Wai Jhou' },
  { x: 144, y: 181, width: 7, height: 6, name: 'Xarabydun' },
  { x: 175, y: 145, width: 7, height: 6, name: 'Yanshi' },
  { x: 121, y: 156, width: 7, height: 6, name: 'Yaraq' },
  { x: 123, y: 112, width: 7, height: 6, name: 'Zaikhal' },
];
