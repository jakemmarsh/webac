/**
 * ExaminePanel1999 — the 1999 client's examine panel, docked in the
 * right-hand column under the radar (webac#3, VISUAL.ac1999-examine-panel-docked).
 *
 * The 1999 DATs carry no LayoutDesc, so the 1999 client.exe (Oct 1999,
 * 4.35752) builds the panel in code. Everything below was read from its
 * disassembly (capstone; recipe in docs/ac1999-support.md "Item examine
 * text"). Only a 1999 world builds it (eraClientRules().examinePanel);
 * end of retail and Dark Majesty keep gmFloatyExaminationUI.
 *
 * ── Where it lives ────────────────────────────────────────────────────────
 * PanelUI's ctor (call @ 0x004ef9cb) makes ExaminePanel (ctor @ 0x00508f80)
 * at (0, 0) 0x12c x 0x17c in the right-column host [PanelUI+0x304], the same
 * host and size as the Map and the other column panels; the host shows one
 * panel at a time (UI::SetActivePanel @ 0x004d06f0). Ours is the panels
 * window, whose 300-wide body is that column (PanelsWindow.ts).
 *
 * ── The shell (ExaminePanel @ 0x00508f80) ────────────────────────────────
 *  - title-bar art 0x06001291 at (0,0), (w − 0x18) x 0x19;
 *  - the title, a TextRegion (0, 2) (w − 0x18) x 0x14, font UI+0x17c,
 *    centred, "No Name" until SetAppraiseInfo @ 0x00509920 names it;
 *  - the minimize box, a button (w − 0x18, 0) 0x18 x 0x19 with art
 *    0x06001283 (up) / 0x06001282 (pressed). Its click
 *    (ListenToElementMessage @ 0x00509610) runs PanelUI @ 0x004f3ef0:
 *    SetActivePanel(PanelUI+0x308), a slot PanelUI's ctor zeroes (0x004eb202)
 *    and nothing sets, so the column empties: the panel closes;
 *  - four sub-panels at (0, 0x19) 0x12c x 0x151: ItemExaminePanel
 *    (0x0050a200), CreatureExaminePanel (0x0050ef40), CharExaminePanel
 *    (0x0050f210), SpellExaminePanel (0x005106c0). SetAppraiseInfo picks the
 *    item panel without a creature profile, else the character panel when
 *    the profile names a profession (InqString 5), else the creature panel
 *    (reference/ac1999 kb appraise-panel-routing).
 *
 * ── Opening and clicks ────────────────────────────────────────────────────
 *  - An appraisal reply for the awaited object fills the sub-panel and, when
 *    the column shows another panel, makes this one active
 *    (SetAppraiseInfo @ 0x00509920 → SetActivePanel). ExamineSpell
 *    (@ 0x00509720) does the same for a spell.
 *  - While the panel shows, a new selection is examined (PanelUI's
 *    selection notice @ 0x004fcb20 → ExamineObject @ 0x005096d0); a cleared
 *    selection closes it when it shows the object that was selected
 *    (0x005098b0 → 0x004f3ef0).
 *
 * ── Fonts ─────────────────────────────────────────────────────────────────
 * The 1999 client draws text with Windows fonts it creates at startup
 * (UI ctor @ 0x004c5600-0x004c5900: (face, cell height, average width,
 * weight 0x1f4) plus a colour packed by 0x0040b980 from (r, g, b)), not
 * the DAT fonts. GDI_FONTS_1999 lists the ones the panel uses.
 */
import type { IdentifyResponseData } from '../../network/ServerMessageHandler.js';
import { getAllegianceRankTitle, APPRAISAL_1999_INT } from '@ac/shared';
import type { AppraisalLine, ItemAppraisalText } from './ItemAppraisalText.js';
import { INSCRIPTION_STRINGS } from './ExaminationWindow.js';

// ─── Fonts ────────────────────────────────────────────────────────────────

/** A font the 1999 UI creates: face, cell height and average width in px, weight, colour (0xRRGGBB). */
export interface GdiFont1999 {
  face: string;
  italic: boolean;
  height: number;
  width: number;
  weight: number;
  rgb: number;
}

const TNR = 'Times New Roman';
const font = (height: number, width: number, rgb: number, italic = false): GdiFont1999 =>
  ({ face: TNR, italic, height, width, weight: 0x1f4, rgb });

/**
 * The fonts (UI object offsets, 1999 client.exe UI ctor; ItemExaminePanel's
 * own two at its ctor @ 0x0050a200). Colours are 0x0040b980(cl = r, dl = g, push = b).
 */
export const GDI_FONTS_1999 = Object.freeze({
  /** UI+0x17c: TNR 16/7 (0xd2,0xd2,0xc8) — titles, the item header, the character header. */
  title: font(16, 7, 0xd2d2c8),
  /** UI+0x178: TNR 15/6 (0xd2,0xd2,0xc8) — body text and small labels. */
  body: font(15, 6, 0xd2d2c8),
  /** UI+0x14c: TNR 15/6 (8,8,8) — the inscription. */
  inscription: font(15, 6, 0x080808),
  /** UI+0x150: "Times New Roman Italic" 15/6 (8,8,8) — "(inscribe here)" and the signature. */
  signature: font(15, 6, 0x080808, true),
  /** UI+0x18c: TNR 35/16 (0xd2,0xd2,0xc8) — the creature level number. */
  level: font(35, 16, 0xd2d2c8),
  /** UI+0x1a8: TNR 16/7 (0xd2,0xd2,0xc8) — a stat row (label, and an unmodified value). */
  stat: font(16, 7, 0xd2d2c8),
  /** UI+0x1a4: TNR 16/7 (0,0xff,0) — a raised stat (StatRow @ 0x00510460, > 0). */
  statUp: font(16, 7, 0x00ff00),
  /** UI+0x1a0: TNR 16/7 (0xff,0,0) — a lowered stat. */
  statDown: font(16, 7, 0xff0000),
  /** ItemExaminePanel+0x208: TNR 15/6 (0,0xff,0) — an item line in AddItemInfo colour 1. */
  bodyUp: font(15, 6, 0x00ff00),
  /** ItemExaminePanel+0x20c: TNR 15/6 (0xff,0,0) — colour 2. */
  bodyDown: font(15, 6, 0xff0000),
});

/** A packed 0xRRGGBB as CSS. */
export function rgbCss1999(rgb: number): string {
  return `rgb(${(rgb >>> 16) & 0xff}, ${(rgb >>> 8) & 0xff}, ${rgb & 0xff})`;
}

/** Times New Roman's em and average width per GDI cell height (OS/2: ascent 1825 + descent 443, xAvgCharWidth 821, 2048 upem). */
const TNR_EM_PER_CELL = 2048 / (1825 + 443);
const TNR_AVG_PER_EM = 821 / 2048;

/**
 * How a GDI font maps to CSS: a positive CreateFont height is the cell
 * height (em = height x upem / (ascent + descent)), and an explicit width
 * stretches the glyphs so the average character is that wide.
 */
export function gdiFontCss(f: GdiFont1999): { fontSize: number; scaleX: number; lineHeight: number } {
  const fontSize = f.height * TNR_EM_PER_CELL;
  const scaleX = f.width / (fontSize * TNR_AVG_PER_EM);
  return { fontSize, scaleX, lineHeight: f.height };
}

// ─── Geometry and art ─────────────────────────────────────────────────────

export interface Rect1999 { x: number; y: number; w: number; h: number }

/** TextRegion justification (0x0045bbf0 / 0x004543e0 argument): 0/1 left, 4 centre, 8 right. */
export type Justify1999 = 'left' | 'center' | 'right';

/** ExaminePanel @ 0x00508f80, as PanelUI sizes it (w 0x12c). */
export const EXAMINE_PANEL_1999 = Object.freeze({
  width: 0x12c,
  titleBar: { did: 0x06001291, rect: { x: 0, y: 0, w: 0x12c - 0x18, h: 0x19 } },
  title: { x: 0, y: 2, w: 0x12c - 0x18, h: 0x14 },
  minimize: { rect: { x: 0x12c - 0x18, y: 0, w: 0x18, h: 0x19 }, up: 0x06001283, down: 0x06001282 },
  /** Every sub-panel: (0, 0x19) 0x12c x 0x151. */
  sub: { x: 0, y: 0x19, w: 0x12c, h: 0x151 },
  defaultTitle: 'No Name',
});

/** The panel's height: the title bar plus a sub-panel (362, the panels-window body). */
export const EXAMINE_PANEL_1999_HEIGHT = EXAMINE_PANEL_1999.sub.y + EXAMINE_PANEL_1999.sub.h;

/** The frame every sub-panel draws in its ctor (W = 0x12c, H = 0x151). */
export const SUB_FRAME_1999 = Object.freeze({
  /** 0x0600128a (220x77, tiled) — the parchment; the item panel's stops at 0x104, the others run the full height. */
  background: 0x0600128a,
  left: 0x060012bc, right: 0x060012bd, bottom: 0x060012bb,
  /** A divider: 0x060012c5 at (4, y) 0x113 x 8 and its end 0x060012c4 at (W − 0x15, y) 0x11 x 8. */
  divider: 0x060012c5, dividerEnd: 0x060012c4,
  /** The header column rule 0x060012c6 (7 x 0x47). */
  columnRule: 0x060012c6,
});

/** ItemExaminePanel ctor @ 0x0050a200. */
export const ITEM_PANEL_1999 = Object.freeze({
  backgroundHeight: 0x104,
  dividers: [0x34, 0xfc],
  /** The inscription parchment 0x0600126f at (4, 0x104) 0x124 x 0x49. */
  inscriptionBlock: { did: 0x0600126f, rect: { x: 4, y: 0x104, w: 0x124, h: 0x49 } },
  /** "Value: …" (4, 5) and "… Burden Units" (4, 0x19), (0xf5 − 4) x 0x14, UI+0x17c, centred. */
  value: { x: 4, y: 5, w: 0xf5 - 4, h: 0x14 },
  burden: { x: 4, y: 0x19, w: 0xf5 - 4, h: 0x14 },
  /** The object's icon, drawn at the base's (0xf5, 0xa) (0x0050a0a0). */
  icon: { x: 0xf5, y: 0xa, w: 32, h: 32 },
  /** The appraisal text (9, 0x3c) 0x10a x 0xc0, UI+0x178, margins 2. */
  body: { x: 9, y: 0x3c, w: 0x10a, h: 0xc0 },
  scrollbar: { x: 0x113, y: 0x3c, w: 0x15, h: 0xc0 },
  /** The inscription edit (4, 0x104) 0x124 x 0x37, UI+0x14c. */
  inscription: { x: 4, y: 0x104, w: 0x124, h: 0x37 },
  /** The signature (4, 0x13b) 0x124 x 0x11, UI+0x150, right-justified. */
  signature: { x: 4, y: 0x13b, w: 0x124, h: 0x11 },
  /** "(inscribe here)" sits 0x10 below the edit's top (SetInscription @ 0x0050b4c2). */
  placeholderTop: 0x10,
});

/** BasicCreatureExaminePanel ctor @ 0x0050d690 (+ CreatureExaminePanel @ 0x0050ef40 / CharExaminePanel @ 0x0050f210). */
export const CREATURE_PANEL_1999 = Object.freeze({
  dividers: [0x47, 0x115],
  /** The level column at x 0xe8, 0x44 wide: "character" (y 2), "level" (y 0x12), the number (y 0x22, 0x23 high, UI+0x18c). */
  levelRule: { x: 0xe8, y: 0, w: 7, h: 0x47 },
  characterLabel: { x: 0xe8, y: 2, w: 0x44, h: 0x10 },
  levelLabel: { x: 0xe8, y: 0x12, w: 0x44, h: 0x10 },
  levelValue: { x: 0xe8, y: 0x22, w: 0x44, h: 0x23 },
  /** The creature's icon at the base's (0xbe, 0xf) (CreatureExaminePanel::SetAppraiseInfo @ 0x0050f080). */
  icon: { x: 0xbe, y: 0xf, w: 32, h: 32 },
  /** The stat list (4, 0x4f) 0x124 x 0xc6; rows 0x124 x 0x14 over 0x060012c3. */
  stats: { x: 4, y: 0x4f, w: 0x124, h: 0xc6 },
  row: { h: 0x14, background: 0x060012c3, label: { x: 5, w: 0x91 }, value: { x: 0x96, w: 0x8c } },
  /** CreatureExaminePanel: the subtype title (0, 0x19) 0xb4 x 0x14, UI+0x17c. */
  creatureTitle: { x: 0, y: 0x19, w: 0xb4, h: 0x14 },
  /** CharExaminePanel: three 0xac x 0x14 header lines, UI+0x17c. */
  genderHeritage: { x: 0, y: 5, w: 0xac, h: 0x14 },
  profession: { x: 0, y: 0x19, w: 0xac, h: 0x14 },
  playerKiller: { x: 0, y: 0x32, w: 0xac, h: 0x14 },
  characterRule: { x: 0xac, y: 0, w: 7, h: 0x47 },
  /** The face strips' region (0xb3, 0) 0x36 x 0x47, a margin-less text region holding the three strips inline (FACE_STRIPS_1999). */
  face: { x: 0xb3, y: 0, w: 0x36, h: 0x47 },
  fellowship: { x: 0, y: 0x11a, w: 0x12c, h: 0x10 },
  allegiance: { x: 0, y: 0x12a, w: 0x12c, h: 0x20 },
});

/** SpellExaminePanel ctor @ 0x005106c0 (a running y from 0, x 9). */
export const SPELL_PANEL_1999 = Object.freeze({
  icon: { x: 0xf5, y: 5, w: 32, h: 32 },
  school: { x: 9, y: 0xa, w: 0x12c - 0x41, h: 0x14 },
  dividers: [0x28, 0x58, 0x10a],
  mana: { x: 9, y: 0x33, w: 0x92 - 9, h: 0x14 },
  /** "Charge: %u%%" (ExamineSpell @ 0x00511956), right-justified (magic/SpellCharge1999.ts). */
  charge: { x: 0x96, y: 0x33, w: 0x92, h: 0x14 },
  range: { x: 9, y: 0x44, w: 0x92 - 9, h: 0x14 },
  duration: { x: 0x96, y: 0x44, w: 0x92, h: 0x14 },
  body: { x: 9, y: 0x60, w: 0x10a, h: 0xaa },
  scrollbar: { x: 0x113, y: 0x60, w: 0x15, h: 0xaa },
  formulaLabel: { x: 4, y: 0x112, w: 0x124, h: 0x14 },
  /** The component row: centred on x 0x96 at y 0x126, 32 px a component (ExamineSpell @ 0x005116b9). */
  formulaY: 0x126,
});

/** The 1999 scrollbar (0x004948a0; art set by UI @ 0x004d5721-0x004d5c3a). */
export const SCROLLBAR_1999 = Object.freeze({
  up: 0x0600125a, upPressed: 0x0600125b, down: 0x06001257, downPressed: 0x06001258,
  track: 0x06001259, thumb: 0x0600125c, thumbPressed: 0x0600125d,
  arrow: 20, thumbHeight: 28,
});

/** The client's own strings (1999 client.exe .rdata). */
export const EXAMINE_TEXT_1999 = Object.freeze({
  inscribeHere: '(inscribe here)', // 0x6032cc
  signaturePrefix: '--', // 0x6032dc
  characterLabel: 'character', // 0x603d6c
  levelLabel: 'level', // 0x603d64
  unknownStat: '???', // 0x603eb4
  unknownGender: 'Unknown Gender', // 0x6041d4
  unknownHeritage: ' Unknown Heritage', // 0x6041e4
  unknownProfession: 'Unknown Profession', // 0x6041c0
  playerKiller: 'Player Killer', // 0x6041b0
  nonPlayerKiller: 'Non-Player Killer', // 0x603ff4
  noFellowship: 'No Fellowship', // 0x603fe4
  fellowship: 'Fellowship:', // 0x604144
  monarch: 'Monarch:', // 0x6041a4
  allegianceMonarch: 'Allegiance Monarch:', // 0x604190
  noAllegiance: 'No Allegiance\n Loyalty:', // 0x604160
  leadership: '  Leadership: ', // 0x604150
  follower: ' Follower', // 0x604184
  followers: ' Followers', // 0x604178
  formula: 'FORMULA', // 0x6042f0
  school: 'School: ', // 0x60450c
  mana: 'Mana: ', // 0x604504
  components: '\nCOMPONENTS:', // 0x604484
  componentIndent: '     ', // 0x60447c
});

/** BasicCreatureExaminePanel ctor @ 0x0050d690: the nine stat rows, in order. */
export const STAT_ROW_LABELS_1999 = ['Strength', 'Endurance', 'Coordination', 'Quickness', 'Focus', 'Self', 'Health', 'Stamina', 'Mana'] as const;

/** InqCreatureDisplayName @ 0x005eb940 (1999): the 37 names; anything else "Unknown" (reference/ac1999 kb creature-type-id). */
export const CREATURE_TYPE_NAMES_1999: readonly string[] = [
  '', 'Olthoi', 'Banderling', 'Drudge', 'Mosswart', 'Lugian', 'Tumerok', 'Mite', 'Tusker', 'PhyntosWasp', 'Rat', 'Auroch',
  'Cow', 'Golem', 'Undead', 'Gromnie', 'Reedshark', 'Armoredillo', 'Fae', 'Virindi', 'Wisp', 'Knathtead', 'Shadow',
  'Mattekar', 'Mumiyah', 'Rabbit', 'Sclavus', 'ShallowsShark', 'Monouga', 'Zefir', 'Skeleton', 'Human', 'Shreth',
  'Chittick', 'Moarsmen', 'Olthoi_Larvae', 'Slithis', 'Deru',
];

export function creatureTypeName1999(type: number): string {
  return (type >= 1 && type < CREATURE_TYPE_NAMES_1999.length) ? CREATURE_TYPE_NAMES_1999[type] : 'Unknown';
}

/**
 * The character's face (CharExaminePanel::SetAppraiseInfo @ 0x0050fbc4-0x0050fed5): three
 * FaceStripRegions (ctor @ 0x0056e960) stacked in the face region, one "\n" apart with no gap
 * (30 + 11 + 30 = 0x47): eyes 0x34 x 0x1e, nose 0x34 x 0x0b, mouth 0x34 x 0x1e. Each is made with
 * its texture and the composite palette; SetPalette @ 0x0056ebe0 decodes the texture through the
 * palette (0x00462250) and sizes it to the strip (0x00460c3f keeps the source size: the blit
 * scales). The eyes strip alone passes the mirror flag (its texture is the left half of the face):
 * SetPalette also copies it mirrored left-to-right, sizes both to (w / 2) x h, and the draw
 * @ 0x0056ee50 puts the texture at the strip's left and the mirror at x + w / 2. The nose and
 * mouth textures are whole and fill their strip.
 */
export const FACE_STRIPS_1999 = Object.freeze([
  { part: 'eyes', w: 0x34, h: 0x1e, mirror: true },
  { part: 'nose', w: 0x34, h: 0x0b, mirror: false },
  { part: 'mouth', w: 0x34, h: 0x1e, mirror: false },
] as const);

/** The profile's six face DIDs (all non-zero, or no face is built). */
export interface FaceDids1999 {
  eyesTexture: number; noseTexture: number; mouthTexture: number;
  skinPalette: number; eyesPalette: number; hairPalette: number;
}

/**
 * The face DIDs from an appraisal (the 1999 adapter files the profile's +0x90/+0x94/+0x98 as
 * EyesTexture 9 / NoseTexture 10 / MouthTexture 11 and +0x9c/+0xa4/+0xa0 as HairPalette 15 /
 * EyesPalette 16 / SkinPalette 17, the AC1999 server's own names, Appraisal.cpp). Null unless all six
 * are set (the && chain @ 0x0050fbc4).
 */
export function faceDids1999(propertiesDataID?: Map<number, number>): FaceDids1999 | null {
  const g = (k: number) => propertiesDataID?.get(k) ?? 0;
  const f = { eyesTexture: g(9), noseTexture: g(10), mouthTexture: g(11), hairPalette: g(15), eyesPalette: g(16), skinPalette: g(17) };
  return Object.values(f).every((v) => v !== 0) ? f : null;
}

/**
 * The composite palette (0x0050fc6c): a fresh Palette (0x00467620, empty: black) with
 * Palette::Modify @ 0x004674c6 copying entries [off, off + n) from each source: skin 0..0x18,
 * eyes 0x18..0x20, hair 0x20..0x28. Colours are ARGB as Palette.read gives them.
 */
export function facePalette1999(f: FaceDids1999, colorsOf: (paletteId: number) => readonly number[] | null): number[] {
  const out = new Array<number>(2048).fill(0xff000000);
  const copy = (pal: number, off: number, n: number): void => {
    const src = colorsOf(pal);
    if (!src) return;
    for (let i = off; i < off + n && i < src.length; i++) out[i] = src[i];
  };
  copy(f.skinPalette, 0, 0x18);
  copy(f.eyesPalette, 0x18, 8);
  copy(f.hairPalette, 0x20, 8);
  return out;
}

// ─── Models ───────────────────────────────────────────────────────────────

/** SetAppraiseInfo @ 0x00509920's title: the name, or "%d <name>" for a stack (no thousands separators). */
export function examineTitle1999(name: string, stackSize: number): string {
  return stackSize > 1 ? `${Math.trunc(stackSize)} ${name}` : name;
}

/** ItemExaminePanel::SetInscription @ 0x0050b2e0. */
export interface Inscription1999 {
  /** The item is inscribable (0x0050af90): otherwise the text and signature are hidden. */
  visible: boolean;
  /** "(inscribe here)" drawn centred in italics (no scribe yet). */
  placeholder: boolean;
  text: string;
  signature: string;
  /** PropertyString 8 (ScribeName); '' = never inscribed. */
  scribe: string;
  /** PropertyString 7 (Inscription). */
  inscription: string;
}

export function examineInscription1999(objectDescFlags: number, propertiesString?: Map<number, string>): Inscription1999 {
  const INSCRIBABLE = 0x2;
  if ((objectDescFlags & INSCRIBABLE) === 0) return { visible: false, placeholder: false, text: '', signature: '', scribe: '', inscription: '' };
  const scribe = propertiesString?.get(8) ?? '';
  if (!scribe) return { visible: true, placeholder: true, text: EXAMINE_TEXT_1999.inscribeHere, signature: '', scribe: '', inscription: '' };
  const text = propertiesString?.get(7) ?? '';
  // A scribe but no inscription: SetInscription leaves both cleared.
  if (!text) return { visible: true, placeholder: false, text: '', signature: '', scribe, inscription: '' };
  return { visible: true, placeholder: false, text, signature: `${EXAMINE_TEXT_1999.signaturePrefix}${scribe}`, scribe, inscription: text };
}

/**
 * The inscription's press (0x0050acc0): the same three refusals as end of
 * retail ("Only " + scribe + " can change the inscription", "This item is not
 * inscribable.", "Item must be in your inventory to inscribe.").
 */
export function inscriptionRefusal1999(o: { inscribable: boolean; owned: boolean; scribe: string; playerName: string }): string | null {
  if (o.scribe && o.scribe !== o.playerName) return INSCRIPTION_STRINGS.onlyScribe.replace('%hs', o.scribe);
  if (!o.inscribable) return INSCRIPTION_STRINGS.notInscribable;
  if (!o.owned) return INSCRIPTION_STRINGS.notInInventory;
  return null;
}

/** The edit ends: SetInscription goes out unless nothing changed; an empty text draws "(inscribe here)" again. */
export function inscriptionCommit1999(text: string, view: Inscription1999, playerName: string): { send: string | null; view: Inscription1999 } {
  const changed = !(text === '' && view.scribe === '');
  const send = changed && text !== view.inscription ? text : null;
  const next: Inscription1999 = text === ''
    ? { visible: true, placeholder: true, text: EXAMINE_TEXT_1999.inscribeHere, signature: '', scribe: '', inscription: '' }
    : { visible: true, placeholder: false, text, signature: `${EXAMINE_TEXT_1999.signaturePrefix}${playerName}`, scribe: playerName, inscription: text };
  return { send, view: next };
}

export interface StatRow1999 { label: string; value: string; /** 0 normal, 1 raised (UI+0x1a4), 2 lowered (UI+0x1a0). */ color: 0 | 1 | 2 }

export interface CreatureExamine1999 {
  page: 'creature' | 'character';
  /** The panel title: the name; a character's carries its allegiance rank title (AllegianceData @ 0x005ae8b0). */
  title: string;
  /** "%d" of the profile's level (0x00455f50); -1 when the server sent none. */
  level: string;
  rows: StatRow1999[];
  /** CreatureExaminePanel: the subtype's name, '' = none drawn. */
  creatureType: string;
  character?: {
    genderHeritage: string;
    profession: string;
    playerKiller: string;
    fellowship: string;
    allegiance: string;
    /** The face strips' DIDs; null = no face built. */
    face: FaceDids1999 | null;
  };
}

export interface CreatureExamine1999Context {
  objectName: string;
  /** The examined weenie's PublicWeenieDesc bitfield (IsPK = 0x20); undefined = no weenie known. */
  publicWeenieBitfield?: number;
  allegianceRankTitle?: (heritage: number, gender: number, rank: number) => string | null | undefined;
}

const NOT_SET = (v: number | undefined): boolean => v === undefined || (v | 0) === -1;

/** The attribute row for 1999 key `key` (1 Str, 2 End, 3 Quick, 4 Coord, 5 Focus, 6 Self). */
const ROW_FOR_KEY = [-1, 0, 1, 3, 2, 4, 5];

/**
 * BasicCreatureExaminePanel::SetAppraiseInfo @ 0x0050e050 (+ CreatureExaminePanel
 * @ 0x0050f080 / CharExaminePanel @ 0x0050f760), reference/ac1999 kb
 * CreatureAppraisalProfile "Creature-panel consumption".
 */
export function buildCreatureExamine1999(d: IdentifyResponseData, ctx: CreatureExamine1999Context): CreatureExamine1999 | null {
  const cp = d.creatureProfile;
  if (!cp) return null;
  const pi = (id: number) => d.propertiesInt?.get(id);
  const ps = (id: number) => d.propertiesString?.get(id);
  const T = EXAMINE_TEXT_1999;
  const a = cp.attributes;
  const hi = cp.attributeHighlights ?? 0;
  const raised = cp.attributeColors ?? 0;
  // InqAttribute (key 1..6) is "found" when the value is non-zero; InqAttributeEnchantment
  // (0x005ea740): bit (key − 1) of the low half = enchanted, of the high half = raised.
  const attr = (key: number, v: number | undefined): StatRow1999 => {
    const label = STAT_ROW_LABELS_1999[ROW_FOR_KEY[key]];
    if (!v) return { label, value: T.unknownStat, color: 0 };
    const bit = 1 << (key - 1);
    const color: 0 | 1 | 2 = (hi & bit) ? ((raised & bit) ? 1 : 2) : 0;
    return { label, value: String(v | 0), color };
  };
  const rows: StatRow1999[] = [
    attr(1, a?.strength), attr(2, a?.endurance), attr(4, a?.coordination), attr(3, a?.quickness), attr(5, a?.focus), attr(6, a?.self),
  ];
  // A missing Strength puts the panel in health-percent mode: Health "%d %%", Stamina / Mana "???".
  const percentMode = !a?.strength;
  const pct = (cur: number, max: number) => Math.trunc((cur / max) * 100);
  const health = cp.health | 0, healthMax = cp.healthMax | 0;
  rows.push({
    label: 'Health', color: 0,
    value: !health || !healthMax ? T.unknownStat : percentMode ? `${pct(health, healthMax)} %` : `${health}/${healthMax} (${pct(health, healthMax)} %)`,
  });
  const vital = (label: string, cur: number | undefined, max: number | undefined): StatRow1999 => ({
    label, color: 0, value: percentMode || !max ? T.unknownStat : `${(cur ?? 0) | 0}/${max | 0}`,
  });
  rows.push(vital('Stamina', a?.stamina, a?.staminaMax), vital('Mana', a?.mana, a?.manaMax));

  const levelRaw = pi(25);
  const level = String(levelRaw === undefined ? -1 : levelRaw | 0);
  if (!ps(5)) {
    const type = pi(2) ?? 0;
    return { page: 'creature', title: ctx.objectName, level, rows, creatureType: type ? creatureTypeName1999(type) : '' };
  }
  // CharExaminePanel::SetAppraiseInfo: gender, then " " + heritage or " Unknown Heritage"; no gender: "Unknown Gender".
  const gender = ps(3), heritage = ps(4);
  const genderHeritage = gender ? (heritage ? `${gender} ${heritage}` : `${gender}${T.unknownHeritage}`) : T.unknownGender;
  const playerKiller = ctx.publicWeenieBitfield !== undefined && (ctx.publicWeenieBitfield & 0x20) ? T.playerKiller : T.nonPlayerKiller;
  const fellowshipName = ps(10);
  const fellowship = fellowshipName ? `${T.fellowship} ${fellowshipName}` : T.noFellowship;
  const rankRaw = pi(30);
  const rank = NOT_SET(rankRaw) ? -1 : rankRaw! | 0;
  let allegiance: string;
  if (rank >= 1) {
    const monarch = ps(21);
    if (monarch) allegiance = `${T.monarch} ${monarch}`;
    else {
      const f = pi(35);
      const followers = NOT_SET(f) || (f! | 0) < 0 ? 0 : f! | 0;
      allegiance = `${T.allegianceMonarch} ${followers}${followers === 1 ? T.follower : T.followers}`;
    }
  } else {
    // The profile's +0x40 / +0x44 (0x00463eb0 / 0x005a2670): the character's Loyalty and Leadership.
    const loyalty = pi(APPRAISAL_1999_INT.loyalty) ?? 0;
    const leadership = pi(APPRAISAL_1999_INT.leadership) ?? 0;
    allegiance = `${T.noAllegiance} ${loyalty | 0}${T.leadership}${leadership | 0}`;
  }
  const rankTitle = (ctx.allegianceRankTitle ?? getAllegianceRankTitle)(pi(188) ?? 0, pi(113) ?? 0, rank);
  return {
    page: 'character',
    title: rankTitle ? `${rankTitle} ${ctx.objectName}` : ctx.objectName,
    level, rows, creatureType: '',
    character: { genderHeritage, profession: ps(5) ?? T.unknownProfession, playerKiller, fellowship, allegiance, face: faceDids1999(d.propertiesDataID) },
  };
}

/** SpellExaminePanel::ExamineSpell @ 0x00511110's model. */
export interface SpellExamine1999 {
  spellId: number;
  title: string;
  iconDid: number;
  school: string;
  mana: string;
  duration: string;
  range: string;
  /** "Charge: %u%%" (ExamineSpell @ 0x00511956) — the player's Charge for the spell (magic/SpellCharge1999.ts); '' = none known. */
  charge: string;
  /** The body text: the description, then "\nCOMPONENTS:" and one indented line a component (AddItemInfo @ 0x00511d70 joins with "\n"). */
  body: string;
  components: Array<{ scid: number; name: string; iconDid: number }>;
}

export interface SpellExamine1999Inputs {
  spellId: number;
  spell: {
    name: string; desc: string; school: number; icon: number; baseMana: number;
    baseRangeConstant: number; baseRangeMod: number;
    metaSpellType: number; duration?: number; portalLifetime?: number;
  };
  /** The spell's formula as the client shows it (GetAppropriateSpellFormula). */
  formula: readonly number[];
  /** InqSkillLevel of the caster (ranks + init). */
  skillLevel: (skillId: number) => number;
  component: (scid: number) => { name: string; icon: number } | null;
  /** The Charge line (spellChargeText1999), when the caller knows the player's charge. */
  charge?: string;
}

/** 0x00540600: the four 1999 schools. */
export function schoolName1999(school: number): string {
  switch (school) {
    case 1: return 'War Magic';
    case 2: return 'Life Magic';
    case 3: return 'Item Enchantment';
    case 4: return 'Creature Enchantment';
    default: return 'None';
  }
}

const SPELL_TYPE_PORTAL_SUMMON = 7;

/**
 * The duration line (ExamineSpell @ 0x00511360): none for −1 or ≤ 0; a
 * portal summon its exact lifetime ("%u sec." under a minute, else "%u min.");
 * any other spell 0.75–1.25 of its duration ("%u-%u sec." up to 90 s, else
 * "%.1f-%.1f min.").
 */
export function spellDuration1999(metaSpellType: number, duration: number | undefined): string {
  if (duration === undefined || duration === -1 || !(duration > 0)) return '';
  if (metaSpellType === SPELL_TYPE_PORTAL_SUMMON) {
    return duration < 60 ? `Duration: ${Math.trunc(duration)} sec.` : `Duration: ${Math.trunc(duration / 60)} min.`;
  }
  const lo = duration * 0.75, hi = duration * 1.25;
  if (hi <= 90) return `Duration: ${Math.trunc(lo)}-${Math.trunc(hi)} sec.`;
  return `Duration: ${(lo / 60).toFixed(1)}-${(hi / 60).toFixed(1)} min.`;
}

/** DetermineSpellRange (1999 @ 0x0057c680): base_range_mod x the school's skill (none: the best of the four) + constant, capped at 75 m. */
export function spellRange1999(s: { school: number; baseRangeMod: number; baseRangeConstant: number }, skillLevel: (id: number) => number): string {
  const skillFor = [0, 0x22, 0x21, 0x20, 0x1f][s.school] ?? 0;
  const level = skillFor ? skillLevel(skillFor) : Math.max(...[0x1f, 0x20, 0x21, 0x22].map(skillLevel));
  const r = Math.min(s.baseRangeMod * level + s.baseRangeConstant, 75);
  if (r === 0) return '';
  return `Range: ${(r / 0.9144).toFixed(1)} yds.`;
}

export function buildSpellExamine1999(i: SpellExamine1999Inputs): SpellExamine1999 {
  const s = i.spell;
  const T = EXAMINE_TEXT_1999;
  // "Mana: " + the base mana with commas when > 0, else "%d" of 0 (0x0051130e).
  const mana = s.baseMana > 0 ? Math.trunc(s.baseMana).toLocaleString('en-US') : '0';
  let body = '';
  // AddItemInfo @ 0x00511d70: "\n" first once the body holds more than one glyph.
  const add = (t: string) => { body += (body.length > 1 ? '\n' : '') + t; };
  if (s.desc) add(s.desc);
  const components: SpellExamine1999['components'] = [];
  const listed = i.formula.map((scid) => ({ scid, c: i.component(scid) })).filter((x) => x.c && x.c.icon);
  if (listed.length > 0) {
    add(T.components);
    for (const { scid, c } of listed) {
      components.push({ scid, name: c!.name, iconDid: c!.icon });
      add(`${T.componentIndent}${c!.name}`);
    }
  }
  const duration = s.metaSpellType === SPELL_TYPE_PORTAL_SUMMON ? s.portalLifetime : s.duration;
  return {
    spellId: i.spellId,
    title: s.name,
    iconDid: s.icon,
    school: `${T.school}${schoolName1999(s.school)}`,
    mana: `${T.mana}${mana}`,
    duration: spellDuration1999(s.metaSpellType, duration),
    range: spellRange1999(s, i.skillLevel),
    charge: i.charge ?? '',
    body,
    components,
  };
}

// ─── The view ─────────────────────────────────────────────────────────────

export interface ExaminePanel1999View {
  page: 'item' | 'creature' | 'character' | 'spell';
  title: string;
  item?: { text: ItemAppraisalText; iconUrl: string | null; inscription: Inscription1999 };
  /** `faceStrips`: the three decoded strips (eyes, nose, mouth) as image URLs, null = no face. */
  creature?: CreatureExamine1999 & { iconUrl: string | null; faceStrips?: ReadonlyArray<string | null> | null };
  spell?: SpellExamine1999 & { iconUrl: string | null; componentIconUrl: (did: number) => string | null };
}

export interface ExaminePanel1999Deps {
  /** A 1999 interface texture (the world portal's 0x06 art) as a URL. */
  art: (did: number) => string | null;
  /** The minimize box was clicked (the panel closes). */
  onMinimize: () => void;
  /** The inscription was pressed: true lets the edit begin (a refusal shows its own notice). */
  onInscriptionPress?: () => boolean;
  /** The edit ended with `text`: the inscription to draw now. */
  onInscriptionCommit?: (text: string) => Inscription1999;
}

interface TextOpts {
  justify?: Justify1999;
  margin?: number;
  wrap?: boolean;
  /** Vertical placement: centred in the region (default), or this many px from its top. */
  top?: number;
  role?: string;
}

/** Text in a GDI font, positioned in `r` and justified; returns the region. */
function textRegion(doc: Document, parent: HTMLElement, r: Rect1999, text: string, f: GdiFont1999, opts: TextOpts = {}): HTMLDivElement {
  const el = doc.createElement('div');
  if (opts.role) el.dataset.examine1999 = opts.role;
  const m = opts.margin ?? 2;
  const css = gdiFontCss(f);
  Object.assign(el.style, {
    position: 'absolute', left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`,
    overflow: 'hidden', pointerEvents: 'none',
  });
  const inner = doc.createElement('div');
  Object.assign(inner.style, {
    position: 'absolute', left: `${m}px`, width: `${Math.max(1, (r.w - 2 * m) / css.scaleX)}px`,
    fontFamily: `"${f.face}", Times, serif`, fontStyle: f.italic ? 'italic' : 'normal', fontWeight: String(f.weight),
    fontSize: `${css.fontSize.toFixed(2)}px`, lineHeight: `${css.lineHeight}px`, color: rgbCss1999(f.rgb),
    whiteSpace: opts.wrap ? 'pre-wrap' : 'pre', textAlign: opts.justify ?? 'left',
    transform: `scaleX(${css.scaleX.toFixed(4)})`, transformOrigin: '0 0',
    ...(opts.top !== undefined ? { top: `${opts.top}px` } : { top: '50%', translate: '0 -50%' }),
  });
  inner.textContent = text;
  el.appendChild(inner);
  parent.appendChild(el);
  return el;
}

function artBox(doc: Document, parent: HTMLElement, r: Rect1999, url: string | null, did: number, tile = true): HTMLDivElement {
  const el = doc.createElement('div');
  el.dataset.art1999 = `0x${did.toString(16).padStart(8, '0')}`;
  Object.assign(el.style, {
    position: 'absolute', left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, pointerEvents: 'none',
    ...(url ? { backgroundImage: `url(${url})`, backgroundRepeat: tile ? 'repeat' : 'no-repeat', backgroundPosition: '0 0' } : {}),
  });
  parent.appendChild(el);
  return el;
}

function iconBox(doc: Document, parent: HTMLElement, r: Rect1999, url: string | null, role: string): void {
  const el = doc.createElement('div');
  el.dataset.examine1999 = role;
  Object.assign(el.style, {
    position: 'absolute', left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, pointerEvents: 'none',
    ...(url ? { backgroundImage: `url(${url})`, backgroundSize: '100% 100%' } : {}),
  });
  parent.appendChild(el);
}

/** The sub-panel frame every 1999 examine sub-panel draws (parchment, edges, dividers). */
function subFrame(doc: Document, sub: HTMLElement, art: ExaminePanel1999Deps['art'], bgHeight: number, dividers: readonly number[]): void {
  const F = SUB_FRAME_1999;
  const W = EXAMINE_PANEL_1999.sub.w, H = EXAMINE_PANEL_1999.sub.h;
  artBox(doc, sub, { x: 4, y: 0, w: 0x124, h: bgHeight }, art(F.background), F.background);
  artBox(doc, sub, { x: 0, y: 0, w: 4, h: H }, art(F.left), F.left);
  artBox(doc, sub, { x: W - 4, y: 0, w: 4, h: H }, art(F.right), F.right);
  artBox(doc, sub, { x: 4, y: H - 4, w: 0x124, h: 4 }, art(F.bottom), F.bottom);
  for (const y of dividers) {
    artBox(doc, sub, { x: 4, y, w: 0x113, h: 8 }, art(F.divider), F.divider);
    artBox(doc, sub, { x: W - 0x15, y, w: 0x11, h: 8 }, art(F.dividerEnd), F.dividerEnd);
  }
}

/**
 * A 1999 scrolling text region (0x004543e0 + its 0x004948a0 scrollbar): one
 * block per line, wrapped at the region's width; the bar shows only while the
 * text overflows. The arrows step a line, the wheel too.
 */
function scrollText(doc: Document, parent: HTMLElement, r: Rect1999, bar: Rect1999, runs: ReadonlyArray<{ text: string; font: GdiFont1999 }>,
  art: ExaminePanel1999Deps['art'], role: string): HTMLDivElement {
  const box = doc.createElement('div');
  box.dataset.examine1999 = role;
  Object.assign(box.style, {
    position: 'absolute', left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, overflow: 'hidden', pointerEvents: 'auto',
  });
  const base = GDI_FONTS_1999.body;
  const css = gdiFontCss(base);
  const content = doc.createElement('div');
  const m = 2;
  Object.assign(content.style, {
    position: 'absolute', left: `${m}px`, top: `${m}px`, width: `${(r.w - 2 * m) / css.scaleX}px`,
    transform: `scaleX(${css.scaleX.toFixed(4)})`, transformOrigin: '0 0',
    fontFamily: `"${base.face}", Times, serif`, fontWeight: String(base.weight), fontSize: `${css.fontSize.toFixed(2)}px`,
    lineHeight: `${css.lineHeight}px`, whiteSpace: 'pre-wrap', color: rgbCss1999(base.rgb),
  });
  for (const run of runs) {
    const line = doc.createElement('div');
    line.textContent = run.text.length ? run.text : ' ';
    if (run.font.rgb !== base.rgb) line.style.color = rgbCss1999(run.font.rgb);
    content.appendChild(line);
  }
  box.appendChild(content);
  parent.appendChild(box);

  const S = SCROLLBAR_1999;
  const barEl = doc.createElement('div');
  barEl.dataset.examine1999 = `${role}-scrollbar`;
  Object.assign(barEl.style, { position: 'absolute', left: `${bar.x}px`, top: `${bar.y}px`, width: `${bar.w}px`, height: `${bar.h}px`, display: 'none', pointerEvents: 'auto' });
  artBox(doc, barEl, { x: 0, y: S.arrow, w: S.arrow, h: bar.h - 2 * S.arrow }, art(S.track), S.track);
  const up = artBox(doc, barEl, { x: 0, y: 0, w: S.arrow, h: S.arrow }, art(S.up), S.up, false);
  const down = artBox(doc, barEl, { x: 0, y: bar.h - S.arrow, w: S.arrow, h: S.arrow }, art(S.down), S.down, false);
  const thumb = artBox(doc, barEl, { x: 0, y: S.arrow, w: S.arrow, h: S.thumbHeight }, art(S.thumb), S.thumb, false);
  parent.appendChild(barEl);
  let offset = 0;
  const contentHeight = (): number => content.scrollHeight || runs.length * css.lineHeight;
  const maxOffset = (): number => Math.max(0, contentHeight() + 2 * m - r.h);
  const apply = (): void => {
    const max = maxOffset();
    offset = Math.max(0, Math.min(offset, max));
    content.style.top = `${m - offset}px`;
    barEl.style.display = max > 0 ? 'block' : 'none';
    const travel = bar.h - 2 * S.arrow - S.thumbHeight;
    thumb.style.top = `${S.arrow + (max > 0 ? Math.round((offset / max) * travel) : 0)}px`;
  };
  const step = (d: number): void => { offset += d * css.lineHeight; apply(); };
  for (const [el, d, pressed, normal] of [[up, -1, S.upPressed, S.up], [down, 1, S.downPressed, S.down]] as const) {
    el.style.pointerEvents = 'auto';
    const show = (did: number): void => { const u = art(did); if (u) el.style.backgroundImage = `url(${u})`; };
    el.addEventListener('mousedown', () => { show(pressed); step(d); });
    el.addEventListener('mouseup', () => show(normal));
    el.addEventListener('mouseleave', () => show(normal));
  }
  box.addEventListener('wheel', (e: WheelEvent) => { e.preventDefault(); step(e.deltaY > 0 ? 1 : -1); }, { passive: false });
  apply();
  // The webfont lays out after the first pass: measure again a frame later.
  const raf = doc.defaultView?.requestAnimationFrame?.bind(doc.defaultView);
  if (raf) raf(() => apply());
  return box;
}

const lineFont = (line: AppraisalLine): GdiFont1999 =>
  line.color === 1 ? GDI_FONTS_1999.bodyUp : line.color === 2 ? GDI_FONTS_1999.bodyDown : GDI_FONTS_1999.body;

function renderItem(doc: Document, sub: HTMLElement, v: NonNullable<ExaminePanel1999View['item']>, deps: ExaminePanel1999Deps): void {
  const P = ITEM_PANEL_1999;
  subFrame(doc, sub, deps.art, P.backgroundHeight, P.dividers);
  artBox(doc, sub, P.inscriptionBlock.rect, deps.art(P.inscriptionBlock.did), P.inscriptionBlock.did);
  textRegion(doc, sub, P.value, v.text.value, GDI_FONTS_1999.title, { justify: 'center', role: 'value' });
  textRegion(doc, sub, P.burden, v.text.burden, GDI_FONTS_1999.title, { justify: 'center', role: 'burden' });
  iconBox(doc, sub, P.icon, v.iconUrl, 'icon');
  const body = scrollText(doc, sub, P.body, P.scrollbar, v.text.lines.map((l) => ({ text: l.text, font: lineFont(l) })), deps.art, 'body');
  // The text region carries its own 0x0600128a background (vt +0x70), tiled from its origin.
  const bodyArt = deps.art(SUB_FRAME_1999.background);
  if (bodyArt) Object.assign(body.style, { backgroundImage: `url(${bodyArt})`, backgroundRepeat: 'repeat' });
  renderInscription(doc, sub, v.inscription, deps);
}

function renderInscription(doc: Document, sub: HTMLElement, initial: Inscription1999, deps: ExaminePanel1999Deps): void {
  const P = ITEM_PANEL_1999;
  const B = P.inscriptionBlock.rect;
  const host = doc.createElement('div');
  host.dataset.examine1999 = 'inscription-block';
  Object.assign(host.style, { position: 'absolute', left: `${B.x}px`, top: `${B.y}px`, width: `${B.w}px`, height: `${B.h}px`, pointerEvents: 'auto', cursor: 'text' });
  sub.appendChild(host);
  let view = initial;
  let editing = false;
  const local = (r: Rect1999): Rect1999 => ({ x: r.x - B.x, y: r.y - B.y, w: r.w, h: r.h });
  const draw = (): void => {
    host.replaceChildren();
    if (!view.visible) return;
    if (view.placeholder) {
      // Centred in italics, 0x10 below the edit's top (SetInscription @ 0x0050b4a1).
      textRegion(doc, host, local(P.inscription), view.text, GDI_FONTS_1999.signature, { justify: 'center', margin: 0, top: P.placeholderTop, role: 'inscription' });
    } else if (view.text) {
      textRegion(doc, host, local(P.inscription), view.text, GDI_FONTS_1999.inscription, { wrap: true, top: 2, role: 'inscription' });
    }
    if (view.signature) textRegion(doc, host, local(P.signature), view.signature, GDI_FONTS_1999.signature, { justify: 'right', role: 'signature' });
  };
  draw();
  host.addEventListener('click', () => {
    if (editing || !deps.onInscriptionPress?.()) return;
    editing = true;
    host.replaceChildren();
    const input = doc.createElement('textarea');
    input.dataset.examine1999 = 'inscription-edit';
    input.maxLength = 300;
    input.spellcheck = false;
    const f = GDI_FONTS_1999.inscription;
    const css = gdiFontCss(f);
    const r = local(P.inscription);
    Object.assign(input.style, {
      position: 'absolute', left: `${r.x + 2}px`, top: `${r.y + 2}px`, width: `${r.w - 4}px`, height: `${r.h - 4}px`,
      background: 'transparent', border: 'none', outline: 'none', resize: 'none', padding: '0', margin: '0', color: rgbCss1999(f.rgb),
      fontFamily: `"${f.face}", Times, serif`, fontSize: `${css.fontSize.toFixed(2)}px`, lineHeight: `${css.lineHeight}px`,
    });
    input.value = view.placeholder ? '' : view.inscription;
    host.appendChild(input);
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      editing = false;
      const next = deps.onInscriptionCommit?.(input.value.trim());
      if (next) view = next;
      draw();
    };
    input.addEventListener('blur', finish);
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); input.blur(); }
    });
    input.focus();
  });
}

function statRow(doc: Document, list: HTMLElement, i: number, row: StatRow1999, deps: ExaminePanel1999Deps): void {
  const R = CREATURE_PANEL_1999.row;
  const el = doc.createElement('div');
  el.dataset.examine1999Row = row.label;
  Object.assign(el.style, { position: 'absolute', left: '0', top: `${i * R.h}px`, width: `${CREATURE_PANEL_1999.stats.w}px`, height: `${R.h}px` });
  const bg = deps.art(R.background);
  if (bg) Object.assign(el.style, { backgroundImage: `url(${bg})`, backgroundRepeat: 'repeat' });
  list.appendChild(el);
  textRegion(doc, el, { x: R.label.x, y: 0, w: R.label.w, h: R.h }, row.label, GDI_FONTS_1999.stat, { justify: 'left', role: 'label' });
  const f = row.color === 1 ? GDI_FONTS_1999.statUp : row.color === 2 ? GDI_FONTS_1999.statDown : GDI_FONTS_1999.stat;
  textRegion(doc, el, { x: R.value.x, y: 0, w: R.value.w, h: R.h }, row.value, f, { justify: 'right', role: 'value' });
}

function renderCreature(doc: Document, sub: HTMLElement, v: NonNullable<ExaminePanel1999View['creature']>, deps: ExaminePanel1999Deps): void {
  const C = CREATURE_PANEL_1999;
  subFrame(doc, sub, deps.art, EXAMINE_PANEL_1999.sub.h, C.dividers);
  artBox(doc, sub, C.levelRule, deps.art(SUB_FRAME_1999.columnRule), SUB_FRAME_1999.columnRule);
  textRegion(doc, sub, C.characterLabel, EXAMINE_TEXT_1999.characterLabel, GDI_FONTS_1999.body, { justify: 'center' });
  textRegion(doc, sub, C.levelLabel, EXAMINE_TEXT_1999.levelLabel, GDI_FONTS_1999.body, { justify: 'center' });
  textRegion(doc, sub, C.levelValue, v.level, GDI_FONTS_1999.level, { justify: 'center', role: 'level' });
  if (v.page === 'creature') {
    iconBox(doc, sub, C.icon, v.iconUrl, 'icon');
    if (v.creatureType) textRegion(doc, sub, C.creatureTitle, v.creatureType, GDI_FONTS_1999.title, { justify: 'center', role: 'creature-type' });
  } else if (v.character) {
    const ch = v.character;
    artBox(doc, sub, C.characterRule, deps.art(SUB_FRAME_1999.columnRule), SUB_FRAME_1999.columnRule);
    textRegion(doc, sub, C.genderHeritage, ch.genderHeritage, GDI_FONTS_1999.title, { justify: 'center', role: 'gender-heritage' });
    textRegion(doc, sub, C.profession, ch.profession, GDI_FONTS_1999.title, { justify: 'center', role: 'profession' });
    textRegion(doc, sub, C.playerKiller, ch.playerKiller, GDI_FONTS_1999.title, { justify: 'center', role: 'player-killer' });
    textRegion(doc, sub, C.fellowship, ch.fellowship, GDI_FONTS_1999.body, { justify: 'center', role: 'fellowship' });
    textRegion(doc, sub, C.allegiance, ch.allegiance, GDI_FONTS_1999.body, { justify: 'center', wrap: true, top: 2, role: 'allegiance' });
    if (v.faceStrips) renderFace(doc, sub, v.faceStrips);
  }
  const list = doc.createElement('div');
  list.dataset.examine1999 = 'stats';
  Object.assign(list.style, { position: 'absolute', left: `${C.stats.x}px`, top: `${C.stats.y}px`, width: `${C.stats.w}px`, height: `${C.stats.h}px`, overflow: 'hidden' });
  sub.appendChild(list);
  v.rows.forEach((row, i) => statRow(doc, list, i, row, deps));
}

/** The three face strips in the face region: the eyes as texture + mirror at (w / 2) x h each, nose and mouth scaled to the strip. */
function renderFace(doc: Document, sub: HTMLElement, strips: ReadonlyArray<string | null>): void {
  const C = CREATURE_PANEL_1999;
  const face = doc.createElement('div');
  face.dataset.examine1999 = 'face';
  Object.assign(face.style, { position: 'absolute', left: `${C.face.x}px`, top: `${C.face.y}px`, width: `${C.face.w}px`, height: `${C.face.h}px`, overflow: 'hidden' });
  sub.appendChild(face);
  let y = 0;
  FACE_STRIPS_1999.forEach((s, i) => {
    const url = strips[i];
    const w = s.mirror ? s.w >> 1 : s.w;
    for (const mirror of s.mirror ? [false, true] : [false]) {
      const el = doc.createElement('div');
      el.dataset.faceStrip = `${s.part}${mirror ? '-mirror' : ''}`;
      Object.assign(el.style, {
        position: 'absolute', left: `${mirror ? w : 0}px`, top: `${y}px`, width: `${w}px`, height: `${s.h}px`,
        imageRendering: 'pixelated',
        ...(url ? { backgroundImage: `url(${url})`, backgroundSize: '100% 100%' } : {}),
        ...(mirror ? { transform: 'scaleX(-1)' } : {}),
      });
      face.appendChild(el);
    }
    y += s.h;
  });
}

function renderSpell(doc: Document, sub: HTMLElement, v: NonNullable<ExaminePanel1999View['spell']>, deps: ExaminePanel1999Deps): void {
  const S = SPELL_PANEL_1999;
  subFrame(doc, sub, deps.art, EXAMINE_PANEL_1999.sub.h, S.dividers);
  iconBox(doc, sub, S.icon, v.iconUrl, 'icon');
  textRegion(doc, sub, S.school, v.school, GDI_FONTS_1999.title, { justify: 'center', role: 'school' });
  textRegion(doc, sub, S.mana, v.mana, GDI_FONTS_1999.body, { justify: 'left', role: 'mana' });
  if (v.range) textRegion(doc, sub, S.range, v.range, GDI_FONTS_1999.body, { justify: 'left', role: 'range' });
  if (v.duration) textRegion(doc, sub, S.duration, v.duration, GDI_FONTS_1999.body, { justify: 'right', role: 'duration' });
  if (v.charge) textRegion(doc, sub, S.charge, v.charge, GDI_FONTS_1999.body, { justify: 'right', role: 'charge' });
  const body = scrollText(doc, sub, S.body, S.scrollbar, v.body.split('\n').map((text) => ({ text, font: GDI_FONTS_1999.body })), deps.art, 'body');
  const bodyArt = deps.art(SUB_FRAME_1999.background);
  if (bodyArt) Object.assign(body.style, { backgroundImage: `url(${bodyArt})`, backgroundRepeat: 'repeat' });
  textRegion(doc, sub, S.formulaLabel, EXAMINE_TEXT_1999.formula, GDI_FONTS_1999.body, { justify: 'center' });
  const n = v.components.length;
  const row = doc.createElement('div');
  row.dataset.examine1999 = 'formula';
  Object.assign(row.style, {
    position: 'absolute', left: `${(EXAMINE_PANEL_1999.sub.w >> 1) - ((n * 32) >> 1)}px`, top: `${S.formulaY}px`,
    width: `${n * 32}px`, height: '32px', display: 'flex',
  });
  for (const c of v.components) {
    const cell = doc.createElement('div');
    cell.dataset.spellComponent = String(c.scid);
    const url = v.componentIconUrl(c.iconDid);
    Object.assign(cell.style, { width: '32px', height: '32px', flexShrink: '0', ...(url ? { backgroundImage: `url(${url})`, backgroundSize: '100% 100%' } : {}) });
    row.appendChild(cell);
  }
  sub.appendChild(row);
}

/**
 * The whole panel (0x12c x 0x16a): the title bar, its minimize box and the
 * sub-panel the view names. Built fresh per view (SetAppraiseInfo refills
 * every region).
 */
export function renderExaminePanel1999(doc: Document, view: ExaminePanel1999View, deps: ExaminePanel1999Deps): HTMLDivElement {
  const E = EXAMINE_PANEL_1999;
  const root = doc.createElement('div');
  root.dataset.examinePanel1999 = view.page;
  Object.assign(root.style, { position: 'absolute', left: '0', top: '0', width: `${E.width}px`, height: `${EXAMINE_PANEL_1999_HEIGHT}px`, pointerEvents: 'auto' });
  artBox(doc, root, E.titleBar.rect, deps.art(E.titleBar.did), E.titleBar.did);
  textRegion(doc, root, E.title, view.title || E.defaultTitle, GDI_FONTS_1999.title, { justify: 'center', role: 'title' });
  const min = artBox(doc, root, E.minimize.rect, deps.art(E.minimize.up), E.minimize.up, false);
  min.dataset.examine1999 = 'minimize';
  min.style.pointerEvents = 'auto';
  min.style.cursor = 'pointer';
  const setArt = (did: number): void => { const u = deps.art(did); if (u) min.style.backgroundImage = `url(${u})`; };
  min.addEventListener('mousedown', () => setArt(E.minimize.down));
  min.addEventListener('mouseleave', () => setArt(E.minimize.up));
  min.addEventListener('mouseup', () => setArt(E.minimize.up));
  min.addEventListener('click', (e: MouseEvent) => { e.stopPropagation(); deps.onMinimize(); });

  const sub = doc.createElement('div');
  sub.dataset.examine1999Sub = view.page;
  Object.assign(sub.style, { position: 'absolute', left: `${E.sub.x}px`, top: `${E.sub.y}px`, width: `${E.sub.w}px`, height: `${E.sub.h}px`, overflow: 'hidden' });
  root.appendChild(sub);
  if (view.page === 'item' && view.item) renderItem(doc, sub, view.item, deps);
  else if (view.page === 'spell' && view.spell) renderSpell(doc, sub, view.spell, deps);
  else if (view.creature) renderCreature(doc, sub, view.creature, deps);
  return root;
}
