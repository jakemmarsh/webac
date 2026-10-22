/**
 * VISUAL.ac1999-examine-panel-docked (webac#3) — the 1999 client.exe's
 * ExaminePanel (ctor @ 0x00508f80), docked in the right-hand column, built
 * in code (ui/examine/ExaminePanel1999.ts). A 1999 world examines there
 * (eraClientRules().examinePanel 'docked1999'); end of retail and Dark
 * Majesty keep the floaty gmFloatyExaminationUI window.
 *
 * Models and the DOM panel drive the real module; the GameUI cases drive the
 * real GameUI in happy-dom with stub DATs; the art case reads the real 1999
 * portal (skips without dat-sets/ac1999-retail; loads in beforeAll).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { APPRAISAL_1999_INT, getAllegianceRankTitle } from '@ac/shared';
import {
  buildCreatureExamine1999, buildSpellExamine1999, creatureTypeName1999, examineInscription1999, examineTitle1999,
  gdiFontCss, inscriptionCommit1999, inscriptionRefusal1999, renderExaminePanel1999, spellDuration1999, spellRange1999,
  EXAMINE_PANEL_1999, EXAMINE_PANEL_1999_HEIGHT, GDI_FONTS_1999, ITEM_PANEL_1999, SCROLLBAR_1999, SUB_FRAME_1999,
  CREATURE_PANEL_1999, FACE_STRIPS_1999, faceDids1999, facePalette1999, type ExaminePanel1999View,
} from '../packages/renderer/src/ui/examine/ExaminePanel1999.js';
import { SpellCharge1999, spellChargeText1999, SPELL_CHARGE_1999 } from '../packages/renderer/src/magic/SpellCharge1999.js';
import { parsePlayerDescription } from '../packages/renderer/src/network/PlayerDescriptionParser.js';
import { DatReader } from '../packages/dat-parser/src/DatReader.js';
import { CharacterGenerator } from '../packages/dat-parser/src/file-types/CharacterGenerator.js';
import { finishAppraisalText } from '../packages/renderer/src/ui/examine/ItemAppraisalText.js';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile, EOR_ERA_ID } from '../packages/renderer/src/era/EraProfiles.js';
import { EXAMINE_1999_PANEL } from '../packages/renderer/src/ui/PanelsWindow.js';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { TextureManager } from '../packages/renderer/src/models/TextureManager.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1280, innerHeight: 800 });
const doc: Document = domWindow.document;

const identify = (over: Partial<IdentifyResponseData>): IdentifyResponseData => ({
  guid: 0x80000001, flags: 0, success: true, ...over,
} as IdentifyResponseData);

const px = (el: Element | null, prop: 'left' | 'top' | 'width' | 'height'): number => parseFloat((el as HTMLElement).style[prop]);

describe('era rules: only a 1999 world docks the examine panel', () => {
  it('1999 → docked1999; end of retail, the Dark Majesty profiles and no profile keep the floaty window', () => {
    expect(eraClientRules(eraProfile('ac1999-retail')).examinePanel).toBe('docked1999');
    for (const id of [EOR_ERA_ID, 'classic-dereth', 'classic-dereth-1-0', 'classicace-customdm', 'classicace-infiltration']) {
      expect(eraProfile(id), id).not.toBeNull();
      expect(eraClientRules(eraProfile(id)).examinePanel).toBe('floaty');
    }
    expect(eraClientRules(null).examinePanel).toBe('floaty');
  });
});

describe('the 1999 models (ExaminePanel / sub-panel SetAppraiseInfo)', () => {
  it('title: the name, or "%d <name>" for a stack with no separators', () => {
    expect(examineTitle1999('Yumi', 1)).toBe('Yumi');
    expect(examineTitle1999('Arrows', 1500)).toBe('1500 Arrows');
  });

  it('inscription: hidden unless inscribable; "(inscribe here)" until a scribe; "--" + scribe under the text', () => {
    expect(examineInscription1999(0, new Map()).visible).toBe(false);
    const fresh = examineInscription1999(0x2, new Map());
    expect(fresh).toMatchObject({ visible: true, placeholder: true, text: '(inscribe here)', signature: '' });
    expect(examineInscription1999(0x2, new Map([[8, 'Bob'], [7, 'Mine']]))).toMatchObject({ placeholder: false, text: 'Mine', signature: '--Bob', scribe: 'Bob' });
    expect(examineInscription1999(0x2, new Map([[8, 'Bob']]))).toMatchObject({ placeholder: false, text: '', signature: '' });
  });

  it('inscription press refusals and the commit (0x0050acc0)', () => {
    expect(inscriptionRefusal1999({ inscribable: true, owned: true, scribe: 'Bob', playerName: 'Ann' })).toBe('Only Bob can change the inscription');
    expect(inscriptionRefusal1999({ inscribable: false, owned: true, scribe: '', playerName: 'Ann' })).toBe('This item is not inscribable.');
    expect(inscriptionRefusal1999({ inscribable: true, owned: false, scribe: '', playerName: 'Ann' })).toBe('Item must be in your inventory to inscribe.');
    expect(inscriptionRefusal1999({ inscribable: true, owned: true, scribe: '', playerName: 'Ann' })).toBeNull();
    const fresh = examineInscription1999(0x2, new Map());
    expect(inscriptionCommit1999('', fresh, 'Ann').send).toBeNull();
    const r = inscriptionCommit1999('Hello', fresh, 'Ann');
    expect(r.send).toBe('Hello');
    expect(r.view).toMatchObject({ placeholder: false, text: 'Hello', signature: '--Ann', scribe: 'Ann' });
    expect(inscriptionCommit1999('', r.view, 'Ann')).toMatchObject({ send: '', view: { placeholder: true, text: '(inscribe here)' } });
  });

  const attrs = { strength: 60, endurance: 50, quickness: 40, coordination: 30, focus: 20, self: 10, stamina: 80, mana: 90, staminaMax: 100, manaMax: 110 };

  it('creature: nine rows in the ctor\'s order, the enchanted ones coloured, the subtype title', () => {
    // Endurance (key 2) lowered, Coordination (key 4) raised.
    const d = identify({
      creatureProfile: { profileFlags: 0x9, health: 40, healthMax: 55, attributes: attrs, attributeHighlights: 0x2 | 0x8, attributeColors: 0x8 },
      propertiesInt: new Map([[2, 32], [25, 12]]),
    });
    const m = buildCreatureExamine1999(d, { objectName: 'Gnawer Shreth' })!;
    expect(m.page).toBe('creature');
    expect(m.title).toBe('Gnawer Shreth');
    expect(m.level).toBe('12');
    expect(m.creatureType).toBe('Shreth');
    expect(m.rows).toEqual([
      { label: 'Strength', value: '60', color: 0 },
      { label: 'Endurance', value: '50', color: 2 },
      { label: 'Coordination', value: '30', color: 1 },
      { label: 'Quickness', value: '40', color: 0 },
      { label: 'Focus', value: '20', color: 0 },
      { label: 'Self', value: '10', color: 0 },
      { label: 'Health', value: '40/55 (72 %)', color: 0 },
      { label: 'Stamina', value: '80/100', color: 0 },
      { label: 'Mana', value: '90/110', color: 0 },
    ]);
  });

  it('creature, failed appraisal (no attributes): "???" rows, Health in percent, Stamina / Mana "???"; level -1 when none came', () => {
    const m = buildCreatureExamine1999(identify({ creatureProfile: { profileFlags: 0, health: 40, healthMax: 55 } }), { objectName: 'Drudge' })!;
    expect(m.rows.map((r) => r.value)).toEqual(['???', '???', '???', '???', '???', '???', '72 %', '???', '???']);
    expect(m.level).toBe('-1');
    expect(m.creatureType).toBe('');
    expect(creatureTypeName1999(39)).toBe('Unknown');
  });

  it('character: header lines, PK, fellowship, the allegiance line\'s three forms, the rank title', () => {
    const base = {
      creatureProfile: { profileFlags: 0x8, health: 40, healthMax: 55, attributes: attrs },
      propertiesString: new Map([[3, 'Female'], [4, "Gharu'ndim"], [5, 'Bow Hunter'], [10, 'The Band']]),
    };
    const sworn = buildCreatureExamine1999(identify({ ...base, propertiesInt: new Map([[30, 2], [35, 3], [113, 2], [188, 2], [25, 12]]) }),
      { objectName: 'Acjs', publicWeenieBitfield: 0x20 })!;
    expect(sworn.page).toBe('character');
    expect(sworn.title).toBe(`${getAllegianceRankTitle(2, 2, 2)} Acjs`);
    expect(sworn.character).toEqual({
      genderHeritage: "Female Gharu'ndim", profession: 'Bow Hunter', playerKiller: 'Player Killer',
      fellowship: 'Fellowship: The Band', allegiance: 'Allegiance Monarch: 3 Followers', face: null,
    });
    const one = buildCreatureExamine1999(identify({ ...base, propertiesInt: new Map([[30, 1], [35, 1]]) }), { objectName: 'A', publicWeenieBitfield: 0 })!;
    expect(one.character!.allegiance).toBe('Allegiance Monarch: 1 Follower');
    expect(one.character!.playerKiller).toBe('Non-Player Killer');
    const vassal = buildCreatureExamine1999(identify({
      ...base, propertiesString: new Map([...base.propertiesString, [21, 'Lord Bob']]), propertiesInt: new Map([[30, 1]]),
    }), { objectName: 'A' })!;
    expect(vassal.character!.allegiance).toBe('Monarch: Lord Bob');
    const free = buildCreatureExamine1999(identify({
      ...base, propertiesInt: new Map([[30, -1], [APPRAISAL_1999_INT.loyalty, 7], [APPRAISAL_1999_INT.leadership, 9]]),
    }), { objectName: 'A' })!;
    expect(free.title).toBe('A');
    expect(free.character!.allegiance).toBe('No Allegiance\n Loyalty: 7  Leadership: 9');
    const bare = buildCreatureExamine1999(identify({ ...base, propertiesString: new Map([[5, 'Adventurer'], [3, 'Male']]) }), { objectName: 'A' })!;
    expect(bare.character!.genderHeritage).toBe('Male Unknown Heritage');
    expect(bare.character!.fellowship).toBe('No Fellowship');
    const nogender = buildCreatureExamine1999(identify({ ...base, propertiesString: new Map([[5, 'Adventurer']]) }), { objectName: 'A' })!;
    expect(nogender.character!.genderHeritage).toBe('Unknown Gender');
  });

  it('spell: the 1999 school, mana, the 0.75-1.25 duration (exact for a portal summon), range, body and components', () => {
    expect(spellDuration1999(1, 1800)).toBe('Duration: 22.5-37.5 min.');
    expect(spellDuration1999(1, 60)).toBe('Duration: 45-75 sec.');
    expect(spellDuration1999(1, -1)).toBe('');
    expect(spellDuration1999(7, 45)).toBe('Duration: 45 sec.');
    expect(spellDuration1999(7, 150)).toBe('Duration: 2 min.');
    expect(spellRange1999({ school: 1, baseRangeMod: 0.5, baseRangeConstant: 5 }, (id) => (id === 0x22 ? 100 : 0))).toBe(`Range: ${(55 / 0.9144).toFixed(1)} yds.`);
    expect(spellRange1999({ school: 2, baseRangeMod: 0, baseRangeConstant: 0 }, () => 100)).toBe('');
    const m = buildSpellExamine1999({
      spellId: 1,
      spell: { name: 'Flame Bolt I', desc: 'Shoots a bolt of flame.', school: 1, icon: 0x06001200, baseMana: 1500, baseRangeConstant: 5, baseRangeMod: 1, metaSpellType: 2 },
      formula: [1, 2, 3],
      skillLevel: () => 10,
      component: (scid) => (scid === 3 ? null : { name: `Comp ${scid}`, icon: 0x06000000 + scid }),
    });
    expect(m.title).toBe('Flame Bolt I');
    expect(m.school).toBe('School: War Magic');
    expect(m.mana).toBe('Mana: 1,500');
    expect(m.duration).toBe('');
    expect(m.body).toBe('Shoots a bolt of flame.\n\nCOMPONENTS:\n     Comp 1\n     Comp 2');
    expect(m.components.map((c) => c.scid)).toEqual([1, 2]);
  });

  it('GDI fonts: Times New Roman at the cell height, stretched to the average width', () => {
    const t = gdiFontCss(GDI_FONTS_1999.title);
    expect(t.fontSize).toBeCloseTo(16 * 2048 / 2268, 5);
    expect(t.fontSize * 821 / 2048 * t.scaleX).toBeCloseTo(7, 5);
    expect(t.lineHeight).toBe(16);
    expect(GDI_FONTS_1999.signature.italic).toBe(true);
    expect(GDI_FONTS_1999.body.rgb).toBe(0xd2d2c8);
  });
});

describe('the 1999 spell Charge (magic/SpellCharge1999.ts)', () => {
  it('seeds raw, decays a known spell x0.92 on 0x4C, adds a new one at 1.0, clamps to 0.5..1.0, regenerates 1/120 per s in >= 5 s steps', () => {
    const c = new SpellCharge1999();
    c.seed(new Map([[1, 0.8], [2, 0.52], [3, 1.4]]), 100);
    expect(c.inq(3, 100)).toBe(1.4); // UnPack does not clamp
    c.updateSpell(1, 100);
    expect(c.inq(1, 100)).toBeCloseTo(0.8 * SPELL_CHARGE_1999.decay, 10);
    c.updateSpell(2, 100);
    expect(c.inq(2, 100)).toBe(0.5);
    c.updateSpell(9, 100);
    expect(c.inq(9, 100)).toBe(1.0);
    expect(c.inq(77, 100)).toBe(1.0); // not in the book
    expect(c.inq(2, 104)).toBe(0.5); // under 5 s: no regen yet
    expect(c.inq(2, 112)).toBeCloseTo(0.5 + 12 / 120, 10);
    expect(c.inq(2, 1000)).toBe(1.0);
    c.removeSpell(2);
    expect(c.inq(2, 1000)).toBe(1.0);
  });

  it('ExamineSpell prints ftol(charge x 100 + 0.5)', () => {
    expect(spellChargeText1999(1)).toBe('Charge: 100%');
    expect(spellChargeText1999(0.736)).toBe('Charge: 74%');
    expect(spellChargeText1999(0.5)).toBe('Charge: 50%');
  });

  it('the PlayerDescription keeps a charge below ACE 2.0 and ignores the 2.0 end of retail sends', () => {
    const b = new DataView(new ArrayBuffer(16 + 4 + 16));
    let o = 0;
    for (const v of [0, 0, 0x100, 1]) { b.setUint32(o, v, true); o += 4; }
    b.setUint16(o, 2, true); b.setUint16(o + 2, 64, true); o += 4;
    b.setInt32(o, 0x3e1, true); b.setFloat32(o + 4, 2.0, true); o += 8;
    b.setInt32(o, 0x3e2, true); b.setFloat32(o + 4, 0.6, true);
    const d = parsePlayerDescription(new Uint8Array(b.buffer))!;
    expect(d.spellIds).toEqual([0x3e1, 0x3e2]);
    expect([...d.spellCharges1999]).toEqual([[0x3e2, Math.fround(0.6)]]);
  });
});

describe('the 1999 face strips (CharExaminePanel @ 0x0050fbc4, FaceStripRegion @ 0x0056e960)', () => {
  it('needs all six DIDs; builds skin 0..0x18, eyes 0x18..0x20, hair 0x20..0x28 over a black palette', () => {
    const all = new Map([[9, 1], [10, 2], [11, 3], [15, 0x04000015], [16, 0x04000016], [17, 0x04000017]]);
    expect(faceDids1999(new Map([...all].filter(([k]) => k !== 10)))).toBeNull();
    const f = faceDids1999(all)!;
    expect(f).toEqual({ eyesTexture: 1, noseTexture: 2, mouthTexture: 3, hairPalette: 0x04000015, eyesPalette: 0x04000016, skinPalette: 0x04000017 });
    const pal = facePalette1999(f, (id) => Array.from({ length: 256 }, () => id & 0xff));
    expect([pal[0], pal[0x17], pal[0x18], pal[0x1f], pal[0x20], pal[0x27], pal[0x28]]).toEqual([0x17, 0x17, 0x16, 0x16, 0x15, 0x15, 0xff000000]);
  });

  it('draws eyes as texture + mirror (26 x 30 each), then nose 52 x 11 and mouth 52 x 30, stacked with no gap', () => {
    const art = () => null;
    const c = {
      page: 'character' as const, title: 'A', level: '1', rows: [], creatureType: '',
      character: { genderHeritage: '', profession: '', playerKiller: '', fellowship: '', allegiance: '', face: null },
    };
    const root = renderExaminePanel1999(doc, { page: 'character', title: 'A', creature: { ...c, iconUrl: null, faceStrips: ['data:e', 'data:n', 'data:m'] } }, { art, onMinimize: () => {} });
    const face = root.querySelector('[data-examine1999="face"]')!;
    expect([px(face, 'left'), px(face, 'top'), px(face, 'width'), px(face, 'height')]).toEqual([0xb3, 0, 0x36, 0x47]);
    const strips = [...face.children] as HTMLElement[];
    expect(strips.map((e) => [e.dataset.faceStrip, px(e, 'left'), px(e, 'top'), px(e, 'width'), px(e, 'height')])).toEqual([
      ['eyes', 0, 0, 26, 30], ['eyes-mirror', 26, 0, 26, 30], ['nose', 0, 30, 52, 11], ['mouth', 0, 41, 52, 30],
    ]);
    expect(strips[1].style.transform).toBe('scaleX(-1)');
    expect(strips[0].style.backgroundImage).toContain('data:e');
    expect(strips[2].style.transform).toBe('');
    expect(FACE_STRIPS_1999.reduce((h, st) => h + st.h, 0)).toBe(0x47);
  });
});

describe('renderExaminePanel1999 (happy-dom)', () => {
  const art = (did: number) => `data:art,${did.toString(16)}`;
  const itemText = finishAppraisalText({ value: 'Value: 400 p', burden: '980 Burden Units' }, [
    { separator: '', text: 'Use this item, or drag it to the weapon slot on the Inventory Panel, to wield it.', color: 0, section: 'Use' },
    { separator: '\n\n', text: 'Speed: Average (45)', color: 1, section: 'Weapon' },
  ]);
  const itemView = (inscription = examineInscription1999(0x2, new Map())): ExaminePanel1999View => ({
    page: 'item', title: 'Yumi', item: { text: itemText, iconUrl: 'data:icon', inscription },
  });

  it('the shell: 300 x 362, the title bar and its minimize box at the ctor\'s rects; a click minimizes', () => {
    let minimized = 0;
    const root = renderExaminePanel1999(doc, itemView(), { art, onMinimize: () => { minimized++; } });
    expect([px(root, 'width'), px(root, 'height')]).toEqual([300, EXAMINE_PANEL_1999_HEIGHT]);
    expect(EXAMINE_PANEL_1999_HEIGHT).toBe(362);
    const bar = root.querySelector('[data-art1999="0x06001291"]');
    expect([px(bar, 'left'), px(bar, 'top'), px(bar, 'width'), px(bar, 'height')]).toEqual([0, 0, 276, 25]);
    expect(root.querySelector('[data-examine1999="title"]')!.textContent).toBe('Yumi');
    const min = root.querySelector('[data-examine1999="minimize"]') as HTMLElement;
    expect([px(min, 'left'), px(min, 'width'), px(min, 'height')]).toEqual([276, 24, 25]);
    expect(min.dataset.art1999).toBe('0x06001283');
    min.dispatchEvent(new domWindow.MouseEvent('mousedown'));
    expect(min.style.backgroundImage).toContain('6001282');
    min.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(minimized).toBe(1);
  });

  it('the item panel: header centred over the icon\'s left, the icon at (0xf5, 0xa), body, dividers, inscription block', () => {
    const root = renderExaminePanel1999(doc, itemView(), { art, onMinimize: () => {} });
    const sub = root.querySelector('[data-examine1999-sub="item"]')!;
    expect(px(sub, 'top')).toBe(25);
    const value = sub.querySelector('[data-examine1999="value"]')!;
    expect([px(value, 'left'), px(value, 'top'), px(value, 'width')]).toEqual([4, 5, 241]);
    expect(value.textContent).toBe('Value: 400 p');
    expect((value.firstElementChild as HTMLElement).style.textAlign).toBe('center');
    expect(sub.querySelector('[data-examine1999="burden"]')!.textContent).toBe('980 Burden Units');
    const icon = sub.querySelector('[data-examine1999="icon"]')!;
    expect([px(icon, 'left'), px(icon, 'top')]).toEqual([245, 10]);
    const body = sub.querySelector('[data-examine1999="body"]')!;
    expect([px(body, 'left'), px(body, 'top'), px(body, 'width'), px(body, 'height')]).toEqual([9, 60, 266, 192]);
    const lines = [...body.firstElementChild!.children] as HTMLElement[];
    expect(lines.map((l) => l.textContent)).toEqual([itemText.lines[0].text, ' ', 'Speed: Average (45)']);
    expect(lines[2].style.color).toBe('rgb(0, 255, 0)');
    const dividers = [...sub.querySelectorAll(`[data-art1999="0x0${SUB_FRAME_1999.divider.toString(16)}"]`)].map((d) => px(d, 'top'));
    expect(dividers).toEqual(ITEM_PANEL_1999.dividers);
    const block = sub.querySelector('[data-art1999="0x0600126f"]')!;
    expect([px(block, 'left'), px(block, 'top'), px(block, 'width'), px(block, 'height')]).toEqual([4, 260, 292, 73]);
    const ph = sub.querySelector('[data-examine1999="inscription"]')!;
    expect(ph.textContent).toBe('(inscribe here)');
    expect((ph.firstElementChild as HTMLElement).style.fontStyle).toBe('italic');
    expect((ph.firstElementChild as HTMLElement).style.top).toBe('16px');
  });

  it('the inscription edit: a refused press does nothing; an accepted one edits and redraws what the commit returns', () => {
    let allow = false;
    const commits: string[] = [];
    const root = renderExaminePanel1999(doc, itemView(), {
      art, onMinimize: () => {},
      onInscriptionPress: () => allow,
      onInscriptionCommit: (t) => { commits.push(t); return inscriptionCommit1999(t, examineInscription1999(0x2, new Map()), 'Ann').view; },
    });
    const block = root.querySelector('[data-examine1999="inscription-block"]') as HTMLElement;
    block.dispatchEvent(new domWindow.MouseEvent('click'));
    expect(block.querySelector('textarea')).toBeNull();
    allow = true;
    block.dispatchEvent(new domWindow.MouseEvent('click'));
    const input = block.querySelector('textarea') as HTMLTextAreaElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe('');
    input.value = 'Mine ';
    input.dispatchEvent(new domWindow.Event('blur'));
    expect(commits).toEqual(['Mine']);
    expect(block.querySelector('[data-examine1999="inscription"]')!.textContent).toBe('Mine');
    expect(block.querySelector('[data-examine1999="signature"]')!.textContent).toBe('--Ann');
  });

  it('the creature and character panels: level column, nine rows over 0x060012c3, stat colours, character header', () => {
    const attrs = { strength: 60, endurance: 50, quickness: 40, coordination: 30, focus: 20, self: 10, stamina: 80, mana: 90, staminaMax: 100, manaMax: 110 };
    const c = buildCreatureExamine1999(identify({
      creatureProfile: { profileFlags: 0x9, health: 40, healthMax: 55, attributes: attrs, attributeHighlights: 0x1, attributeColors: 0 },
      propertiesInt: new Map([[2, 3], [25, 7]]),
    }), { objectName: 'Drudge Skulker' })!;
    const root = renderExaminePanel1999(doc, { page: 'creature', title: c.title, creature: { ...c, iconUrl: 'data:icon' } }, { art, onMinimize: () => {} });
    expect(root.querySelector('[data-examine1999="level"]')!.textContent).toBe('7');
    expect(root.querySelector('[data-examine1999="creature-type"]')!.textContent).toBe('Drudge');
    const icon = root.querySelector('[data-examine1999="icon"]')!;
    expect([px(icon, 'left'), px(icon, 'top')]).toEqual([190, 15]);
    const stats = root.querySelector('[data-examine1999="stats"]')!;
    expect([px(stats, 'left'), px(stats, 'top'), px(stats, 'width')]).toEqual([4, 79, 292]);
    const rows = [...stats.children] as HTMLElement[];
    expect(rows.map((r) => r.dataset.examine1999Row)).toEqual(['Strength', 'Endurance', 'Coordination', 'Quickness', 'Focus', 'Self', 'Health', 'Stamina', 'Mana']);
    expect(rows.map((r) => px(r, 'top'))).toEqual([0, 20, 40, 60, 80, 100, 120, 140, 160]);
    expect(rows[0].style.backgroundImage).toContain(CREATURE_PANEL_1999.row.background.toString(16));
    const strengthValue = rows[0].querySelector('[data-examine1999="value"]')!.firstElementChild as HTMLElement;
    expect(strengthValue.style.color).toBe('rgb(255, 0, 0)');
    expect(strengthValue.style.textAlign).toBe('right');

    const ch = buildCreatureExamine1999(identify({
      creatureProfile: { profileFlags: 0x8, health: 40, healthMax: 55, attributes: attrs },
      propertiesString: new Map([[3, 'Female'], [4, "Gharu'ndim"], [5, 'Bow Hunter']]),
      propertiesInt: new Map([[30, -1], [APPRAISAL_1999_INT.loyalty, 5], [APPRAISAL_1999_INT.leadership, 6]]),
    }), { objectName: 'Acjs' })!;
    const cr = renderExaminePanel1999(doc, { page: 'character', title: ch.title, creature: { ...ch, iconUrl: null } }, { art, onMinimize: () => {} });
    expect(cr.querySelector('[data-examine1999="gender-heritage"]')!.textContent).toBe("Female Gharu'ndim");
    expect(cr.querySelector('[data-examine1999="profession"]')!.textContent).toBe('Bow Hunter');
    expect(cr.querySelector('[data-examine1999="player-killer"]')!.textContent).toBe('Non-Player Killer');
    expect(cr.querySelector('[data-examine1999="allegiance"]')!.textContent).toBe('No Allegiance\n Loyalty: 5  Leadership: 6');
    expect(cr.querySelector('[data-examine1999="creature-type"]')).toBeNull();
    expect(cr.querySelectorAll(`[data-art1999="0x0${SUB_FRAME_1999.columnRule.toString(16)}"]`)).toHaveLength(2);
  });

  it('the spell panel: school, mana / duration rows, body, the component row centred on x 150', () => {
    const s = buildSpellExamine1999({
      spellId: 1,
      spell: { name: 'Strength Self I', desc: 'Raises Strength.', school: 4, icon: 0x06001200, baseMana: 15, baseRangeConstant: 0, baseRangeMod: 0, metaSpellType: 1, duration: 1800 },
      formula: [1, 2, 3], skillLevel: () => 0, component: (scid) => ({ name: `C${scid}`, icon: 0x06000100 + scid }),
      charge: spellChargeText1999(0.87),
    });
    const root = renderExaminePanel1999(doc, { page: 'spell', title: s.title, spell: { ...s, iconUrl: null, componentIconUrl: (d) => `data:c,${d}` } }, { art, onMinimize: () => {} });
    expect(root.querySelector('[data-examine1999="school"]')!.textContent).toBe('School: Creature Enchantment');
    expect(root.querySelector('[data-examine1999="mana"]')!.textContent).toBe('Mana: 15');
    const dur = root.querySelector('[data-examine1999="duration"]')!;
    expect(dur.textContent).toBe('Duration: 22.5-37.5 min.');
    expect([px(dur, 'left'), px(dur, 'top')]).toEqual([150, 68]);
    expect(root.querySelector('[data-examine1999="range"]')).toBeNull();
    const charge = root.querySelector('[data-examine1999="charge"]')!;
    expect(charge.textContent).toBe('Charge: 87%');
    expect([px(charge, 'left'), px(charge, 'top'), px(charge, 'width')]).toEqual([150, 51, 146]);
    expect((charge.firstElementChild as HTMLElement).style.textAlign).toBe('right');
    const row = root.querySelector('[data-examine1999="formula"]')!;
    expect([px(row, 'left'), px(row, 'top'), px(row, 'width')]).toEqual([150 - 48, 294, 96]);
    expect(row.children).toHaveLength(3);
  });

  it('the body scrollbar shows only while the text overflows; its arrows and the wheel step a line', () => {
    const many = finishAppraisalText({ value: 'v', burden: 'b' }, Array.from({ length: 40 }, (_, i) => ({ separator: i ? '\n' : '', text: `line ${i}`, color: 0, section: 'x' } as const)));
    const root = renderExaminePanel1999(doc, { page: 'item', title: 'T', item: { text: many, iconUrl: null, inscription: examineInscription1999(0, new Map()) } }, { art, onMinimize: () => {} });
    const bar = root.querySelector('[data-examine1999="body-scrollbar"]') as HTMLElement;
    expect(bar.style.display).toBe('block');
    expect([px(bar, 'left'), px(bar, 'top'), px(bar, 'width')]).toEqual([0x113, 0x3c, 0x15]);
    const content = root.querySelector('[data-examine1999="body"]')!.firstElementChild as HTMLElement;
    expect(content.style.top).toBe('2px');
    const down = bar.querySelector(`[data-art1999="0x0${SCROLLBAR_1999.down.toString(16)}"]`) as HTMLElement;
    down.dispatchEvent(new domWindow.MouseEvent('mousedown'));
    expect(content.style.top).toBe('-13px');
    const few = renderExaminePanel1999(doc, itemView(), { art, onMinimize: () => {} });
    expect((few.querySelector('[data-examine1999="body-scrollbar"]') as HTMLElement).style.display).toBe('none');
  });
});

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('GameUI: a 1999 world docks the examine panel in the panels window; the other eras keep the floaty window', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    mod = await import('../packages/renderer/src/ui/GameUI.js');
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  const emptyDb = () => ({
    overlayKind: null, container: 'tod', masterMapId: 0x27000000, totalIterations: 1,
    getFileData: (): ArrayBuffer | null => null, hasFile: () => false,
    getReader: (): never => { throw new Error('no file'); }, listFileIds: () => [] as number[],
  });
  const faceCalls: Array<{ tex: number; colors: number[] }> = [];
  const tm = () => ({
    getIconRGBA: () => null, getIconDataURL: (id: number) => `data:image/png;id,${id}`,
    getJPEGDataURL: () => null, getTextureDataURL: () => null,
    // Each palette's entry i is (palette id low byte << 8) | i, so the composite shows where every entry came from.
    getPaletteColors: (id: number) => Array.from({ length: 256 }, (_, i) => (((id & 0xff) << 8) | i) >>> 0),
    getRGBAWithPalette: (tex: number, colors: number[]) => { faceCalls.push({ tex, colors }); return { width: 2, height: 2, data: new Uint8Array(16) }; },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const make = (): { gui: any; hud: HTMLElement } => {
    const c = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(c);
    const gui = new mod.GameUI(c, {}, emptyDb(), tm(), undefined, undefined, null, null, undefined, null);
    return { gui, hud: gui.hudContainer as HTMLElement };
  };
  const view = (guid: number) => ({
    guid, title: 'Yumi', page: 'item' as const,
    item: finishAppraisalText({ value: 'Value: 400 p', burden: '980 Burden Units' }, []),
    inscription1999: examineInscription1999(0x2, new Map()),
  });

  it('docked1999: an examine opens the 1999 panel as the panels window\'s panel, drawn from the world portal\'s art', () => {
    const { gui, hud } = make();
    gui.setExaminePanel('docked1999');
    gui.showExaminationWindow(view(0x80000010));
    const wrapper = hud.querySelector('[data-panel="examine1999"]') as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(gui.panelsSlot.current).toBe(EXAMINE_1999_PANEL);
    expect(gui.examinedGuid).toBe(0x80000010);
    const panel = wrapper.querySelector('[data-examine-panel1999="item"]')!;
    expect(panel.querySelector('[data-examine1999="title"]')!.textContent).toBe('Yumi');
    // The panel sits in the body at (5,5), 300 wide; the art is the world texture manager's.
    expect([px(panel.parentElement, 'left'), px(panel.parentElement, 'top'), px(panel.parentElement, 'width')]).toEqual([5, 5, 300]);
    expect((panel.querySelector('[data-art1999="0x06001291"]') as HTMLElement).style.backgroundImage).toContain(`id,${0x06001291}`);
    // A second examine refills the same panel; a reply for another object does not repaint it.
    gui.showExaminationWindow({ ...view(0x80000011), title: 'Arrows' });
    expect(hud.querySelectorAll('[data-panel="examine1999"]')).toHaveLength(1);
    expect(hud.querySelector('[data-examine1999="title"]')!.textContent).toBe('Arrows');
    expect(gui.refreshExaminationWindow({ ...view(0x80000099), title: 'Other' })).toBe(false);
    expect(gui.refreshExaminationWindow({ ...view(0x80000011), title: 'Arrows again' })).toBe(true);
    expect(hud.querySelector('[data-examine1999="title"]')!.textContent).toBe('Arrows again');
    // No 1999 re-appraise timer (gmExaminationUI::UseTime is end of retail's).
    expect(gui.examineUseTime(1e9, false)).toBe(0);
    // The minimize box empties the column.
    (hud.querySelector('[data-examine1999="minimize"]') as HTMLElement).dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(hud.querySelector('[data-panel="examine1999"]')).toBeNull();
    expect(gui.panelsSlot.current).toBeNull();
    expect(gui.examinedGuid).toBeNull();
  });

  it('docked1999: the panel takes the column from the open panel and does not hand it back', () => {
    const { gui } = make();
    gui.setExaminePanel('docked1999');
    gui.setPanelsWindowPanel({ key: 'vitae', slot: 0x1000018a, returnsToPrevious: true }, true);
    gui.showExaminationWindow(view(0x80000012));
    expect(gui.panelsSlot.current).toBe(EXAMINE_1999_PANEL);
    gui.hideExaminePanel();
    expect(gui.panelsSlot.current).toBeNull();
  });

  it('docked1999: a new selection is examined; a cleared one closes the panel only when it shows that object', () => {
    const { gui, hud } = make();
    gui.setExaminePanel('docked1999');
    const examined: number[] = [];
    gui.onExamineSelection = (g: number) => { examined.push(g); };
    if (gui.uiManager.currentScreen !== 'game') gui.uiManager.setScreen('game');
    gui.hudState.target = { id: 0x80000020, name: 'Yumi' };
    gui.showExaminationWindow(view(0x80000020));
    gui.updateHUD();
    expect(examined).toEqual([]);
    gui.hudState.target = { id: 0x80000021, name: 'Bow' };
    gui.updateHUD();
    expect(examined).toEqual([0x80000021]);
    // The panel still shows 0x80000020 (no reply yet): clearing the selection of 0x80000021 keeps it.
    gui.hudState.target = null;
    gui.updateHUD();
    expect(hud.querySelector('[data-panel="examine1999"]')).not.toBeNull();
    // Once it shows the selected object, clearing the selection closes it.
    gui.hudState.target = { id: 0x80000021, name: 'Bow' };
    gui.updateHUD();
    gui.showExaminationWindow(view(0x80000021));
    gui.hudState.target = null;
    gui.updateHUD();
    expect(hud.querySelector('[data-panel="examine1999"]')).toBeNull();
  });

  it('docked1999: a character with all six face DIDs gets its three strips decoded through the composite palette', () => {
    const { gui, hud } = make();
    gui.setExaminePanel('docked1999');
    const attrs = { strength: 60, endurance: 50, quickness: 40, coordination: 30, focus: 20, self: 10, stamina: 80, mana: 90, staminaMax: 100, manaMax: 110 };
    const c = buildCreatureExamine1999(identify({
      creatureProfile: { profileFlags: 0x8, health: 40, healthMax: 55, attributes: attrs },
      propertiesString: new Map([[3, 'Female'], [4, 'Sho'], [5, 'Bow Hunter']]),
      propertiesDataID: new Map([[9, 0x05000a01], [10, 0x05000a02], [11, 0x05000a03], [15, 0x040000c1], [16, 0x040000c2], [17, 0x040000c3]]),
    }), { objectName: 'Acjs' })!;
    faceCalls.length = 0;
    gui.showExaminationWindow({ guid: 0x50000001, title: 'Acjs', page: 'character', creature1999: c });
    expect(faceCalls.map((f) => f.tex)).toEqual([0x05000a01, 0x05000a02, 0x05000a03]);
    const pal = faceCalls[0].colors;
    expect(pal[0]).toBe(0xc300); // skin (17) 0..0x17
    expect(pal[0x17]).toBe(0xc317);
    expect(pal[0x18]).toBe(0xc218); // eyes (16) 0x18..0x1f
    expect(pal[0x20]).toBe(0xc120); // hair (15) 0x20..0x27
    expect(pal[0x28]).toBe(0xff000000); // the rest of the fresh palette
    expect(hud.querySelectorAll('[data-examine1999="face"] [data-face-strip]')).toHaveLength(4);
  });

  it('floaty (end of retail, Dark Majesty): no docked panel is ever built', () => {
    const { gui, hud } = make();
    expect(gui.examinePanelKind).toBe('floaty');
    gui.showExaminationWindow(view(0x80000013));
    expect(hud.querySelector('[data-panel="examine1999"]')).toBeNull();
    expect(gui.panelsSlot.current).toBeNull();
  });
});

const PORTAL_1999 = resolve(__dirname, '..', 'dat-sets', 'ac1999-retail', 'portal.dat');

describe.skipIf(!existsSync(PORTAL_1999))('the panel\'s art is in the 1999 portal at the sizes the ctors draw it', () => {
  let tm: TextureManager;
  beforeAll(() => {
    const db = new DatDatabase(new FileDatBytes(PORTAL_1999));
    db.setOverlay(ac1999PortalOverlay());
    tm = new TextureManager(db);
  });

  it.each([
    [0x06001291, 276, 25], [0x06001283, 24, 25], [0x06001282, 24, 25], [0x0600128a, 220, 77],
    [0x060012bc, 4, 337], [0x060012bd, 4, 337], [0x060012bb, 292, 4], [0x060012c5, 292, 8], [0x060012c4, 17, 8],
    [0x060012c6, 7, 71], [0x060012c3, 292, 20], [0x0600126f, 265, 100],
    [SCROLLBAR_1999.up, 20, 20], [SCROLLBAR_1999.down, 20, 20], [SCROLLBAR_1999.track, 20, 32], [SCROLLBAR_1999.thumb, 20, 28],
  ])('0x%s: %i x %i', (did, w, h) => {
    const img = tm.getIconRGBA(did);
    expect(img).not.toBeNull();
    expect([img!.width, img!.height]).toEqual([w, h]);
  });
});

describe.skipIf(!existsSync(PORTAL_1999))('real 1999 face strips: the chargen face textures decode through the composite palette', () => {
  let tm: TextureManager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sex: any;
  let db: DatDatabase;
  beforeAll(() => {
    db = new DatDatabase(new FileDatBytes(PORTAL_1999));
    db.setOverlay(ac1999PortalOverlay());
    tm = new TextureManager(db);
    const cg = new CharacterGenerator(new DatReader(db.getFileData(0x0e000002)!));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sex = [...([...cg.heritageGroups.values()][0] as any).genders.values()][0];
  });

  it('eyes / nose / mouth decode (the eyes a half face), coloured from the composite palette', () => {
    // A palette set's first palette (PaletteSet: id, count, ids).
    const firstOfSet = (id: number): number => new DataView(db.getFileData(id)!).getUint32(8, true);
    const f = {
      eyesTexture: sex.eyeStripList[0].objDesc.textureChanges[0].newTexture,
      noseTexture: sex.noseStripList[0].objDesc.textureChanges[0].newTexture,
      mouthTexture: sex.mouthStripList[0].objDesc.textureChanges[0].newTexture,
      skinPalette: firstOfSet(sex.skinPalSet), eyesPalette: sex.eyeColorList[0], hairPalette: firstOfSet(sex.hairColorList[0]),
    };
    const colors = facePalette1999(f, (id) => tm.getPaletteColors(id));
    const sizes = [f.eyesTexture, f.noseTexture, f.mouthTexture].map((t) => {
      const img = tm.getRGBAWithPalette(t, colors)!;
      // Every pixel takes a colour the three palettes supplied (index < 0x28), none the black fill.
      let black = 0;
      for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === 0 && img.data[i + 1] === 0 && img.data[i + 2] === 0) black++;
      expect(black).toBe(0);
      return [img.width, img.height];
    });
    expect(sizes).toEqual([[64, 64], [64, 32], [128, 64]]);
  });
});
