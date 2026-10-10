/**
 * VISUAL.chargen-heritage-lore-spacing — the char-gen Heritage lore panel
 * (0x21000046:0x100003c4) is ONE text, built the way retail's
 * gmCGHeritagePage::Update @ 00483210 builds it (annotated decomp
 * ~133296-133440): SetStringInfoWithFont(StartingSkills_Header, 0, 1), then
 * AppendStringInfoWithFont of StartingSkills (0), BonusSkills_Trained_Header
 * (1), <X>Text_BonusSkills_Trained (0), AppendText("\n"), <X>Text (0).
 *
 * Ours drew each string in its own block with invented 2px / 10px margins,
 * so every string's trailing "\n" became a blank line on top of the block
 * gap: header → body was ~33 px where char-create-ref1.png shows one line.
 * Now the runs are laid out as a single glyph list (a run's "\n" ends its
 * line; the next run starts on the following one) with each glyph in its
 * run's p27 colour.
 *
 * Pure helpers + the real ACFontRenderer (synthetic font) + the real GameUI
 * run everywhere; the DAT suite skipIf's with every load in beforeAll.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { acStringHash, registerStringTable, getString } from '@ac/dat-parser/file-types/LayoutDesc.js';
import type { StringTableData } from '@ac/dat-parser/file-types/LayoutDesc.js';
import type { ACFont, FontCharDesc } from '@ac/dat-parser/file-types/ACFont.js';
import {
  heritageLoreRuns, heritageLoreStringId, heritageBonusSkillsStringId, HERITAGE_TEXT_TOKEN,
  STARTING_SKILLS_HEADER_ID, STARTING_SKILLS_ID, BONUS_SKILLS_HEADER_ID, encodeTextRunsAttr, parseTextRuns,
} from '../packages/renderer/src/ui/HeritageText.js';
import { ACFontRenderer, lineSourceSpans } from '../packages/renderer/src/ui/ACFontRenderer.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const LANG_DAT = resolve(REPO, 'dat/client_local_English.dat');

describe('HeritageText — the retail composition (gmCGHeritagePage::Update)', () => {
  it('string ids are compute_str_hash of the decomp tokens (and match the DAT ids)', () => {
    expect(STARTING_SKILLS_HEADER_ID).toBe(acStringHash('ID_CharGen_Heritage_StartingSkills_Header'));
    expect(STARTING_SKILLS_HEADER_ID).toBe(261918658);
    expect(STARTING_SKILLS_ID).toBe(130514755);
    expect(BONUS_SKILLS_HEADER_ID).toBe(4947682);
    expect(heritageLoreStringId(1)).toBe(79636388);
    expect(heritageBonusSkillsStringId(1)).toBe(33995732);
  });

  it('Umbraen (5) and Penumbraen (10) both use "Shad"; Olthoi 12/13 are Olthoi / OlthoiAcid', () => {
    expect(HERITAGE_TEXT_TOKEN[5]).toBe('Shad');
    expect(HERITAGE_TEXT_TOKEN[10]).toBe('Shad');
    expect(heritageLoreStringId(5)).toBe(heritageLoreStringId(10));
    expect(heritageLoreStringId(12)).toBe(acStringHash('ID_CharGen_OlthoiText'));
    expect(heritageLoreStringId(13)).toBe(acStringHash('ID_CharGen_OlthoiAcidText'));
    expect(heritageBonusSkillsStringId(13)).toBe(7224932);
    expect(heritageLoreStringId(0)).toBeNull();
    expect(heritageLoreStringId(14)).toBeNull();
  });

  it('runs: header(1), body(0), header(1), bonus(0), one explicit "\\n"(0), lore(0) — no other spacing', () => {
    const lookup = (id: number): string => `<${id}>`;
    const runs = heritageLoreRuns(2, lookup);
    expect(runs).toEqual([
      { text: `<${STARTING_SKILLS_HEADER_ID}>`, colorIndex: 1 },
      { text: `<${STARTING_SKILLS_ID}>`, colorIndex: 0 },
      { text: `<${BONUS_SKILLS_HEADER_ID}>`, colorIndex: 1 },
      { text: `<${heritageBonusSkillsStringId(2)}>`, colorIndex: 0 },
      { text: '\n', colorIndex: 0 },
      { text: `<${heritageLoreStringId(2)}>`, colorIndex: 0 },
    ]);
  });

  it('unresolved strings contribute nothing', () => {
    expect(heritageLoreRuns(1, () => null)).toEqual([{ text: '\n', colorIndex: 0 }]);
  });

  it('encodeTextRunsAttr round-trips through an HTML attribute', () => {
    const runs = [{ text: 'a "q" <b> & \'s\'\n', colorIndex: 1 }];
    const html = `<span data-x="${encodeTextRunsAttr(runs)}"></span>`;
    const m = /data-x="([^"]*)"/.exec(html)!;
    const decoded = m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    expect(parseTextRuns(decoded)).toEqual(runs);
    expect(parseTextRuns('nope')).toBeNull();
  });
});

describe('lineSourceSpans — wrapped lines map back to their source offsets', () => {
  it('consumes the hard "\\n" and the wrap-point space between lines', () => {
    const text = 'Head:\nBody one two\n\nX';
    expect(lineSourceSpans(text, ['Head:', 'Body one', 'two', '', 'X'])).toEqual([0, 6, 15, 19, 20]);
  });
});

/** A synthetic font: every printable ASCII glyph 5 px wide, 10 px line height. */
function syntheticFont(): ACFont {
  const charDescs: FontCharDesc[] = [];
  for (let c = 32; c < 127; c++) {
    charDescs.push({ unicode: c, offsetX: 0, offsetY: 0, width: 5, height: 10, horizontalOffsetBefore: 0, horizontalOffsetAfter: 0, verticalOffsetBefore: 0 });
  }
  return { charDescs, maxCharHeight: 10, foregroundSurfaceDataId: 0, backgroundSurfaceDataId: 0 } as unknown as ACFont;
}

describe('ACFontRenderer.renderWrappedRunsToCanvas — one glyph list, per-run colour', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H.teardown());

  function draw(runs: Array<{ text: string; color?: string }>, maxWidth: number) {
    const r = new ACFontRenderer(syntheticFont());
    (r as unknown as { spritesheetCanvas: unknown }).spritesheetCanvas = H.win.document.createElement('canvas');
    const calls: Array<[string, number, number, string | undefined]> = [];
    vi.spyOn(r, 'renderToCanvas').mockImplementation((_ctx, text, x, y, color) => {
      calls.push([text, x, y, color]);
      return r.layoutText(text);
    });
    const canvas = r.renderWrappedRunsToCanvas(runs, maxWidth);
    return { calls, canvas };
  }

  it('a run\'s trailing "\\n" ends its line — the next run is on the very next row (no blank line)', () => {
    const { calls, canvas } = draw([
      { text: 'Head:\n', color: 'green' },
      { text: 'Body.\n\n', color: 'white' },
      { text: 'H2:\n', color: 'green' },
    ], 200);
    expect(calls).toEqual([
      ['Head:', 0, 0, 'green'],
      ['Body.', 0, 10, 'white'],
      ['H2:', 0, 30, 'green'],
    ]);
    // Head / Body / blank / H2 / the trailing "\n"'s empty row.
    expect(canvas.height).toBe(50);
  });

  it('a colour change mid-line draws each segment at its measured x', () => {
    const { calls } = draw([{ text: 'ab', color: 'red' }, { text: 'cd ef', color: 'blue' }], 200);
    expect(calls).toEqual([['ab', 0, 0, 'red'], ['cd ef', 10, 0, 'blue']]);
  });

  it('wrapping crosses run boundaries like a single text', () => {
    // 20 px = 4 glyphs per line: "aa bb" wraps after "aa".
    const { calls } = draw([{ text: 'aa b', color: 'red' }, { text: 'b', color: 'blue' }], 20);
    expect(calls).toEqual([['aa', 0, 0, 'red'], ['b', 0, 10, 'red'], ['b', 5, 10, 'blue']]);
  });

  it('renderWrappedTextToCanvas is the single-run case', () => {
    const r = new ACFontRenderer(syntheticFont());
    (r as unknown as { spritesheetCanvas: unknown }).spritesheetCanvas = H.win.document.createElement('canvas');
    const calls: string[] = [];
    vi.spyOn(r, 'renderToCanvas').mockImplementation((_ctx, text, _x, _y, color) => { calls.push(`${text}|${color}`); return r.layoutText(text); });
    r.renderWrappedTextToCanvas('one\n\ntwo', 200, 'gold');
    expect(calls).toEqual(['one|gold', 'two|gold']);
  });
});

describe('GameUI Heritage step — the lore panel is one text element', () => {
  let H: GameUIFixture;
  beforeAll(async () => {
    H = await mountGameUI();
    H.ui.getTexURL = () => null;
    const ids = [STARTING_SKILLS_HEADER_ID, STARTING_SKILLS_ID, BONUS_SKILLS_HEADER_ID, heritageBonusSkillsStringId(5)!, heritageLoreStringId(5)!];
    const table: StringTableData = {
      id: 0x23000002, language: 1, unknown: 0,
      entries: ids.map((id) => ({ id, varNames: [], vars: [], strings: [`T${id}\\n`], comments: [], unknown: 0 })) as unknown as StringTableData['entries'],
    };
    registerStringTable(table);
  });
  afterAll(() => H.teardown());

  it('renderRaceStep emits exactly one data-ac-runs text in .heritage-lore (Umbraen shows the Shad lore)', () => {
    H.ui.wizard.heritage = 5;
    const host = H.win.document.createElement('div');
    host.innerHTML = H.ui.renderRaceStep();
    const lore = host.querySelector('.heritage-lore')!;
    expect(lore.querySelectorAll('[data-ac-text]').length).toBe(1);
    const runs = parseTextRuns(lore.querySelector('[data-ac-runs]')!.getAttribute('data-ac-runs')!)!;
    expect(runs.map(r => r.text).join('')).toBe(
      `T${STARTING_SKILLS_HEADER_ID}\nT${STARTING_SKILLS_ID}\nT${BONUS_SKILLS_HEADER_ID}\nT${heritageBonusSkillsStringId(5)}\n\nT${heritageLoreStringId(5)}\n`);
    expect(runs.map(r => r.colorIndex)).toEqual([1, 0, 1, 0, 0, 0]);
    // No invented block margins inside the lore column.
    expect(lore.innerHTML).not.toMatch(/margin-bottom/);
    // Wraps at the panel's 265 px less the text margins p35 / p36 (9 + 26).
    expect(H.mod.HERITAGE_LORE_WRAP_WIDTH).toBe(230);
    expect(lore.querySelector('[data-ac-runs]')!.getAttribute('data-ac-maxwidth')).toBe('230');
  });

  it('replaceACTextElements renders the runs as one element carrying the whole text', () => {
    H.ui.wizard.heritage = 1;
    const host = H.win.document.createElement('div');
    host.innerHTML = H.ui.renderRaceStep();
    H.ui.replaceACTextElements(host);
    const lore = host.querySelector('.heritage-lore')!;
    expect(lore.children.length).toBe(1);
    const el = lore.children[0] as HTMLElement;
    expect(el.dataset.acRunText).toBe(`T${STARTING_SKILLS_HEADER_ID}\nT${STARTING_SKILLS_ID}\nT${BONUS_SKILLS_HEADER_ID}\n\n`);
    expect(el.dataset.acDesc?.toLowerCase()).toBe('21000046:100003c4');
  });
});

describe.skipIf(!existsSync(LANG_DAT))('DAT — Aluvian lore text reads exactly as retail lays it out', () => {
  let text = '';
  beforeAll(async () => {
    const { DatDatabase, DatReader, parseStringTable } = await import('@ac/dat-parser');
    const db = openDat(LANG_DAT);
    registerStringTable(parseStringTable(new DatReader(db.getFileData(0x23000002)!)));
    text = heritageLoreRuns(1, getString).map(r => r.text).join('');
  });

  it('header, body, blank, header, bonus paragraphs, two blank rows, lore (char-create-ref1.png)', () => {
    const lines = text.split('\n');
    expect(lines.slice(0, 4)).toEqual(['Trained Starting Skills:', 'Jump, Loyalty, Magic Defense, Run and Salvaging.', '', 'Bonus Racial Skills:']);
    expect(lines[4]).toMatch(/^You gain mastery in Dagger and Bow/);
    expect(lines[5]).toBe('');
    expect(lines[6]).toMatch(/^You start with the 'Jack of All Trades'/);
    expect(lines.slice(7, 9)).toEqual(['', '']);
    expect(lines[9]).toMatch(/^ALUVIANS are a fiercely individualistic/);
  });
});
