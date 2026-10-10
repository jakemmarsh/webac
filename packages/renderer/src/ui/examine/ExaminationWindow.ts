/**
 * VISUAL.examine-panel-layout-2100001c — the EoL examine window: identity,
 * placement, page choice and title (the pages' contents are
 * ItemAppraisalText / CreatureAppraisalText).
 *
 * Ground truth (client_local_English.dat + the decompiled EoL client):
 *  - The root HUD 0x21000005 authors the window as slot 0x100005f7 at
 *    (180,128) 310x400, hidden until shown (p59), edges L2 T2 R1 B1,
 *    WindowID (attr 0x1000007e) = 7, base element 0x100005f2 of layout
 *    0x2100006b — gmFloatyExaminationUI (class 0x1000004c), NOT the docked
 *    0x2100001c panel (whose leather/gold art the old retail screenshots
 *    show; the EoL window draws the alpha-175 black scrim 0x06004cc2 with
 *    0x0600612c dividers).
 *  - Root 0x100005f2: resize limits p63 minW 310 / p62 minH 400 / p61 maxW
 *    2000 / p60 maxH 2000; close 0x100005f3; title text 0x1000012d
 *    (5,5) 300x20 over the scrim; pages at (5,30) 300x365: item
 *    0x1000012e, creature/character 0x10000140, spell 0x10000153.
 *  - gmExaminationUI::SetAppraiseInfo @ 004adae0: no creature profile →
 *    the item page; a creature profile with PropertyString 5 (Template) or
 *    PropertyInt 0x105 (CharacterTitleId) → the character page; otherwise
 *    the creature page. SetActiveExamineUI @ 004ab420 shows exactly one.
 *  - Title: PropertyString 0x34 (GearPlatingName) when present, else the
 *    object's GetObjectName(NAME_APPROPRIATE); SetTitleText @ 004ad930
 *    prefixes "<count> " (commas, PStringBase::convert(n, 1)) for a stack
 *    of 2 or more.
 */

export const EXAMINATION_WINDOW = {
  hudLayout: 0x21000005, hudSlot: 0x100005f7,
  layout: 0x2100006b, root: 0x100005f2,
  close: 0x100005f3,
  title: 0x1000012d,
  pages: { item: 0x1000012e, creature: 0x10000140, character: 0x10000140, spell: 0x10000153 },
  /** Item page elements (0x2100006b): body text + its scrollbar, the inscription block. */
  item: { body: 0x1000013c, scrollbar: 0x1000013d, inscriptionBlock: 0x10000137, inscription: 0x1000013e, signature: 0x1000013f },
  windowId: 7,
  /** The HUD slot's authored rect in the 800x600 design and its right/bottom gaps (edges R1/B1). */
  design: { x: 180, y: 128, w: 310, h: 400, right: 800 - (180 + 310), bottom: 600 - (128 + 400) },
  minW: 310, minH: 400, maxW: 2000, maxH: 2000,
} as const;

export type ExaminePage = 'item' | 'creature' | 'character' | 'spell';

/** Everything GameUI.showExaminationWindow draws (built in main.ts from the IdentifyResponse). */
export interface ExaminationView {
  /** The appraised object (gmExaminationUI::current_appraisal_ID). */
  guid: number;
  title: string;
  page: ExaminePage;
  item?: import('./ItemAppraisalText.js').ItemAppraisalText;
  inscription?: InscriptionView;
  /** The spell page (SpellExamineUI::ExamineSpell — a local notice, no appraisal). */
  spell?: import('./SpellExamine.js').SpellExamineModel;
  creature?: import('./CreatureAppraisalText.js').CreaturePageModel | import('./CreatureAppraisalText.js').CharacterPageModel;
  /** The live world model to clone into the creature page's viewport. */
  previewMesh?: import('three').Group | null;
}

/** SetAppraiseInfo @ 004adae0's page choice. */
export function chooseExaminePage(info: {
  hasCreatureProfile: boolean;
  propertiesString?: Map<number, string>;
  propertiesInt?: Map<number, number>;
}): ExaminePage {
  if (!info.hasCreatureProfile) return 'item';
  const TEMPLATE = 5, CHARACTER_TITLE_ID = 0x105;
  if (info.propertiesString?.has(TEMPLATE) || info.propertiesInt?.has(CHARACTER_TITLE_ID)) return 'character';
  return 'creature';
}

/** SetTitleText @ 004ad930 with SetAppraiseInfo's name choice. */
export function examineTitle(appropriateName: string, stackSize: number, propertiesString?: Map<number, string>): string {
  const GEAR_PLATING_NAME = 0x34;
  const name = propertiesString?.get(GEAR_PLATING_NAME) ?? appropriateName;
  if (stackSize < 2) return name;
  return `${stackSize.toLocaleString('en-US')} ${name}`;
}

/** A persisted examine-window rect (chat-window options 0x10000086-89 under WindowID 7). */
export interface ExaminationGeometry { x?: number; y?: number; w?: number; h?: number }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Where the window opens on a `screenW` x `screenH` HUD: a persisted size is
 * clamped to the root's limits; without a persisted position the slot's
 * R1/B1 edges keep its authored right (310) and bottom (72) gaps — so it
 * opens just left of the right-flush panels window — clamped on screen.
 */
export function examinationWindowPlacement(geo: ExaminationGeometry, screenW: number, screenH: number): { x: number; y: number; w: number; h: number } {
  const E = EXAMINATION_WINDOW;
  const w = finite(geo.w) ? Math.round(Math.max(E.minW, Math.min(E.maxW, geo.w))) : E.design.w;
  const h = finite(geo.h) ? Math.round(Math.max(E.minH, Math.min(E.maxH, geo.h))) : E.design.h;
  let x = screenW - E.design.right - w;
  let y = screenH - E.design.bottom - h;
  if (finite(geo.x) && finite(geo.y)) { x = geo.x; y = geo.y; }
  x = Math.round(Math.max(0, Math.min(x, screenW - w)));
  y = Math.round(Math.max(0, Math.min(y, screenH - h)));
  return { x, y, w, h };
}

/**
 * ItemExamineUI::SetInscription @ 004ae2f0 — the inscription block
 * (0x1000013e text, 0x1000013f signature):
 *  - not inscribable (PWD bitfield 0x2) → the text element hidden;
 *  - no ScribeName (8) → "<Inscribe here>";
 *  - a scribe and an Inscription (7) → the text, signature "--" + scribe;
 *  - a scribe but no inscription → both left clear.
 * (A PSR viewer also sees " <account>" — not a player path.)
 */
export function examineInscription(objectDescFlags: number, propertiesString?: Map<number, string>): InscriptionView {
  const INSCRIBABLE = 0x2;
  if ((objectDescFlags & INSCRIBABLE) === 0) return { visible: false, text: '', signature: '', scribe: '', inscription: '' };
  const scribe = propertiesString?.get(8) ?? '';
  if (!scribe) return { visible: true, text: INSCRIBE_HERE, signature: '', scribe: '', inscription: '' };
  const text = propertiesString?.get(7) ?? '';
  if (!text) return { visible: true, text: '', signature: '', scribe, inscription: '' };
  return { visible: true, text, signature: `--${scribe}`, scribe, inscription: text };
}

/** The item page's inscription block as drawn, plus ItemExamineUI's m_scribe_name / m_old_inscription. */
export interface InscriptionView {
  visible: boolean;
  text: string;
  signature: string;
  /** PropertyString 8 (ScribeName); '' = never inscribed. */
  scribe: string;
  /** PropertyString 7 (Inscription) — m_old_inscription. */
  inscription: string;
}

/** acclient.exe 0x3af564. */
export const INSCRIBE_HERE = '<Inscribe here>';

/** The 0x1a notices of ItemExamineUI::HandleInscriptionMousePresses @ 004ac230 (acclient.exe 0x3af3f8 / 0x3af3b8 / 0x3af360). */
export const INSCRIPTION_STRINGS = {
  onlyScribe: 'Only %hs can change the inscription',
  notInscribable: 'This item is not inscribable.',
  notInInventory: 'Item must be in your inventory to inscribe.',
} as const;

/**
 * ItemExamineUI::HandleInscriptionMousePresses @ 004ac230 /
 * SetInscriptionEditableState @ 004ac720 — a click on the inscription block:
 * another player's inscription → "Only %hs can change the inscription"; a
 * non-inscribable object (PWD bitfield 0x2) or one the player does not
 * carry → its notice; otherwise null (the text takes the edit focus).
 */
export function inscriptionPressRefusal(o: { inscribable: boolean; owned: boolean; scribe: string; playerName: string }): string | null {
  if (o.scribe && o.scribe !== o.playerName) return INSCRIPTION_STRINGS.onlyScribe.replace('%hs', o.scribe);
  if (!o.inscribable) return INSCRIPTION_STRINGS.notInscribable;
  if (!o.owned) return INSCRIPTION_STRINGS.notInInventory;
  return null;
}

/**
 * ItemExamineUI::HandleInscriptionLosingFocus @ 004ae620 — the edit ends:
 * CM_Writing::Event_SetInscription(item, text) unless nothing changed (an
 * empty text on a never-inscribed item, or the same text again); an empty
 * text redraws "<Inscribe here>" with no signature and no scribe, any other
 * text is signed "--<player>" and the player becomes the scribe.
 */
export function inscriptionCommit(text: string, view: InscriptionView, playerName: string): { send: string | null; view: InscriptionView } {
  const changed = !(text === '' && view.scribe === '');
  const send = changed && text !== view.inscription ? text : null;
  const next: InscriptionView = text === ''
    ? { visible: true, text: INSCRIBE_HERE, signature: '', scribe: '', inscription: '' }
    : { visible: true, text, signature: `--${playerName}`, scribe: playerName, inscription: text };
  return { send, view: next };
}
