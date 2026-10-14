/**
 * GDLE.first-login-tutorial-book — a new character on a GDLE server (Classic
 * Dereth / Seedsow, Dark Majesty era) saw no welcome or instructions.
 *
 * GDLE has no welcome popup: CPlayerWeenie::SetLoginPlayerQualities
 * (reference/classic/ClassicDereth/Source/Player.cpp, !FIRST_ENTER_WORLD_DONE_BOOL)
 * Uses the tutorial book it put in the new character's pack
 * (Client.cpp W_TUTORIALBOOK_CLASS), so CBookWeenie::Use (Book.cpp) sends
 * BookDataResponse 0xB4 with the pages' text ("Hail, traveler, welcome to
 * Dereth! ...", "To enter the Training Academy, WALK INTO THE SPINNING PURPLE
 * PORTAL.", ...). ClientEvents::LoginCharacter calls that BEFORE CreateEntity,
 * so the event lands before the player's CreateObject, which is what starts
 * our game and builds the HUD (GameUI.showGame → renderHUD empties the HUD
 * layer). The book window was drawn, then swept away. Retail builds the
 * gameplay UI (gmBookUI with it) at BeginEnterWorld, before any login event,
 * so the book showed.
 *
 * Real GDLE-shaped bytes through the real ServerMessageHandler into the real
 * GameUI with a real LayoutRenderer over the local DAT.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { GameEventType, GameMessageOpcode } from '@ac/network';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { ServerMessageHandler, type BookDataResponse } from '../packages/renderer/src/network/ServerMessageHandler.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);
const BOOK = 0x80000123;
const ME = 0x50000001;
const PAGE1 = "Hail, traveler, welcome to Dereth! Your adventure awaits you. Your first task is to find the Greeter, who will train you in your new skills.";
const PAGE2 = 'To enter the Training Academy, WALK INTO THE SPINNING PURPLE PORTAL.';

/** GDLE BinaryWriter::WriteString: u16 length + CP1252 bytes, padded to 4. */
function str(s: string): number[] {
  const out = [s.length & 0xff, s.length >> 8, ...Array.from(s, (c) => c.charCodeAt(0))];
  while (out.length % 4) out.push(0);
  return out;
}
const u32 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];

/** CBookWeenie::Use: 0xB4, book id, maxNumPages, then PageDataList::Pack + inscription, scribe id, scribe name. */
function gdleBookData(pages: string[]): Uint8Array {
  const page = (text: string) => [
    ...u32(0xffffffff), ...str('Asheron'), ...str(''), // authorID, authorName, authorAccount
    ...u32(0xffff0002), ...u32(1), ...u32(0), // PageData version 2: textIncluded, ignoreAuthor
    ...str(text),
  ];
  return new Uint8Array([
    ...u32(BOOK), ...u32(pages.length),
    ...u32(pages.length), ...u32(1000), ...u32(pages.length), // maxNumPages, maxNumCharsPerPage, numPages
    ...pages.flatMap(page),
    ...str(''), ...u32(0), ...str(''),
  ]);
}

describe.skipIf(!hasDats)('GDLE first-login tutorial book survives the HUD coming up', () => {
  let fx: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const handler = new ServerMessageHandler();

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
    ui.playerGuid = ME;
    ui.loadFontRenderer = () => ({
      isReady: true, lineHeight: 18, outlinePadding: { x: 1, y: 1 },
      measureText: (t: string) => t.length * 10,
      renderTextToCanvas: () => document.createElement('canvas'),
      renderWrappedTextToCanvas: () => document.createElement('canvas'),
    });
    ui.setBookCallbacks({ bookName: () => 'Welcome to Asheron\'s Call', pageData: () => undefined });
    // main.ts onBookData: gameUI.openBook(...) with the parsed event.
    handler.setHandlers({
      onBookData: (d: BookDataResponse) => ui.openBook(d.bookGuid, d.maxPages, d.pages, d.inscription, d.inscriptionAuthorId, d.inscriptionAuthor),
    });
  });
  afterAll(() => fx?.teardown());
  afterEach(() => ui.hideBookPanel());

  const deliver = (payload: Uint8Array) => handler.handleMessage({
    type: 'event', opcode: GameMessageOpcode.GameEvent, sequence: 1,
    eventType: GameEventType.BookDataResponse, objectGuid: ME, payload,
  } as never);
  const shownBook = (): HTMLElement | null => {
    const el = document.querySelector('.ac-book') as HTMLElement | null;
    return el && el.isConnected ? el : null;
  };
  const pageRuns = (): string => {
    const cell = shownBook()?.querySelector('[data-element-id="0x10000111"] .ac-book-page-text') as HTMLElement | null;
    return ([...(cell?.querySelectorAll('[data-ac-run-text]') ?? [])] as HTMLElement[]).map((r) => r.dataset.acRunText).join(' ');
  };

  it('a book opened before the game starts is on screen after showGame, on its first page', () => {
    deliver(gdleBookData([PAGE1, PAGE2]));
    expect(ui.isBookVisible).toBe(true);
    ui.showGame(); // the player's CreateObject → startGame
    const book = shownBook();
    expect(book).not.toBeNull();
    expect(fx.container.contains(book)).toBe(true);
    expect(ui.agentOpenWindows()).toEqual(['Book']);
    // The page's words were laid out (wrapped into runs), not a blank page.
    expect(pageRuns().replace(/\s+/g, ' ')).toContain('Hail, traveler, welcome to Dereth!');
    expect(ui.agentBook().pages.map((p: { text: string | null }) => p.text)).toEqual([PAGE1, PAGE2]);
  });

  it('showGame without an open book draws no book window', () => {
    ui.showGame();
    expect(shownBook()).toBeNull();
    expect(ui.isBookVisible).toBe(false);
  });

  it('the book opened after the game started is untouched by the fix (one window, not two)', () => {
    deliver(gdleBookData([PAGE2]));
    expect(document.querySelectorAll('.ac-book').length).toBe(1);
    expect(pageRuns().replace(/\s+/g, ' ')).toContain('SPINNING PURPLE PORTAL');
  });
});
