/**
 * AGENT.play-reports-2026-10-10 — the GameUI side of two agent reports, on the
 * real GameUI with a real LayoutRenderer over the local DAT:
 *  - item 3, windows opening by themselves: a book (gmBookUI, 0x10000049)
 *    shown over the Character panel hands the panels window back when it
 *    hides, so closeAllPanels (Escape, ac_close all) hid the book last and
 *    the Character panel came straight back.
 *  - item 8, a letter's text: agentBook / agentBookPage read the open book
 *    and ask for a page the way turning to it does.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);
const LETTER = 0x80000a01;

describe.skipIf(!hasDats)('agent windows and books on the real GameUI', () => {
  let fx: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const sent: string[] = [];

  beforeAll(async () => {
    fx = await mountGameUI();
    const dat = await import('@ac/dat-parser');
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(portal.getReader(0x39000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000001)));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const tex = { getTextureDataURL: (id: number) => `data:tex-${id.toString(16)}`, getTextureDataURLWithAlpha: (id: number) => `data:tex-${id.toString(16)}` };
    ui = fx.ui;
    ui.layoutRenderer = new LayoutRenderer(local, tex as never, null);
    ui.getTexURL = (id: number) => `tex:${id.toString(16)}`;
    ui.playerGuid = 0x50000001;
    ui.loadFontRenderer = () => ({
      isReady: true, lineHeight: 18, outlinePadding: { x: 1, y: 1 },
      measureText: (t: string) => t.length * 10,
      renderTextToCanvas: () => document.createElement('canvas'),
      renderWrappedTextToCanvas: () => document.createElement('canvas'),
    });
    ui.setBookCallbacks({ bookName: () => 'Letter From Home', pageData: (_b: number, n: number) => sent.push(`pageData ${n}`) });
  });
  afterAll(() => fx?.teardown());

  const page = (text: string | null) => ({ authorId: 7, authorName: 'Mother', textIncluded: text !== null, ignoreAuthor: false, pageText: text ?? '' });

  it('closing everything with a book open over the Character panel leaves nothing open (item 3)', () => {
    ui.toggleCharPanel();
    expect(ui.agentOpenWindows()).toEqual(['Character']);
    ui.openBook(LETTER, 2, [page(null), page(null)], '', 0, '');
    expect(ui.agentOpenWindows()).toEqual(['Book']);
    ui.closeAllPanels();
    expect(ui.agentOpenWindows()).toEqual([]);
    // Closing just the book still hands the window back to the Character panel, as gmPanelUI does.
    ui.toggleCharPanel();
    ui.openBook(LETTER, 2, [page(null), page(null)], '', 0, '');
    expect(ui.agentCloseWindow('Book')).toBeNull();
    expect(ui.agentOpenWindows()).toEqual(['Character']);
    ui.closeAllPanels();
  });

  it('agentBook reads the open book; agentBookPage asks for a page not yet sent (item 8)', () => {
    sent.length = 0;
    ui.openBook(LETTER, 2, [page(null), page(null)], '', 0, '');
    expect(sent).toEqual(['pageData 0']); // the page it opened on
    ui.bookPageDataResponse(LETTER, 0, page('Dear child,'));
    expect(ui.agentBook()).toEqual({ guid: LETTER, title: 'Letter From Home', pages: [{ author: 'Mother', text: 'Dear child,' }, { author: 'Mother', text: null }] });
    expect(ui.agentBookPage(0)).toBe(false); // already here
    expect(ui.agentBookPage(1)).toBe(true);
    expect(sent).toEqual(['pageData 0', 'pageData 1']);
    ui.bookPageDataResponse(LETTER, 1, page('Write soon.'));
    expect(ui.agentBook().pages[1].text).toBe('Write soon.');
    ui.hideBookPanel();
    expect(ui.agentBook()).toBeNull();
  });
});
