/**
 * VISUAL.char-panel-body-too-bright.a.a.a.b — gmBookUI's state machine
 * (packages/renderer/src/ui/BookModel.ts), driven directly. Each case cites
 * the decompiled routine it follows.
 */
import { describe, it, expect } from 'vitest';
import {
  BookModel, pageTextBlank, bookAlreadyBlankText, bookOnlyAuthorText, BOOK_CANNOT_CHANGE_TEXT, BOOK_BLANK_ROW,
  type BookPage,
} from '../packages/renderer/src/ui/BookModel.js';

const ME = 0x50000001;
const OTHER = 0x50000002;
const BOOK = 0x80001234;

function harness() {
  const sent: string[] = [];
  const notices: string[] = [];
  const io = {
    playerId: () => ME, playerName: () => 'Me',
    bookName: () => 'Tome',
    pageData: (b: number, n: number) => sent.push(`pageData ${n}`),
    addPage: () => sent.push('addPage'),
    modifyPage: (b: number, n: number, t: string) => sent.push(`modify ${n} ${JSON.stringify(t)}`),
    deletePage: (b: number, n: number) => sent.push(`delete ${n}`),
    bookData: () => sent.push('bookData'),
    notice: (t: string) => notices.push(t),
  };
  return { m: new BookModel(io), sent, notices };
}
const page = (authorId: number, authorName: string, over: Partial<BookPage> = {}): BookPage =>
  ({ authorId, authorName, textIncluded: false, ignoreAuthor: false, pageText: '', ...over });

describe('OpenBook @ 004bbca0 / SetCurPage @ 004bb570 — reading', () => {
  it('opening a book shows page 0 and asks for its text (ACE never sends it with the book)', () => {
    const { m, sent } = harness();
    m.openBook(BOOK, 4, [page(OTHER, 'Asheron'), page(OTHER, 'Asheron')], '', 0, '');
    expect(m.curPage).toBe(0);
    expect(sent).toEqual(['pageData 0']);
    expect(m.requestPending).toBe(true);
    // While the request is pending, nothing turns.
    m.setCurPage(1);
    expect(m.curPage).toBe(0);
    m.pageDataResponse(BOOK, 0, page(OTHER, 'Asheron', { pageText: 'Once upon a time' }));
    expect(m.pageText).toBe('Once upon a time');
    expect(m.requestPending).toBe(false);
  });

  it('the title is the inscription for a scribed book, the book\'s name otherwise', () => {
    const { m } = harness();
    m.openBook(BOOK, 1, [], 'My Journal', OTHER, 'Bob');
    expect(m.title).toBe('My Journal');
    m.openBook(BOOK + 1, 1, [], 'ignored', 0, '');
    expect(m.title).toBe('Tome');
  });

  it('reopening the same book keeps the current page; another book starts at 0', () => {
    const { m } = harness();
    const pages = [page(OTHER, 'A', { textIncluded: true }), page(OTHER, 'A', { textIncluded: true }), page(OTHER, 'A', { textIncluded: true })];
    m.openBook(BOOK, 3, pages, '', 0, '');
    m.setCurPage(2);
    m.openBook(BOOK, 3, pages, '', 0, '');
    expect(m.curPage).toBe(2);
    m.openBook(BOOK + 1, 3, pages, '', 0, '');
    expect(m.curPage).toBe(0);
  });

  it('Prev is ghosted on page 0, Next on the last page the book can hold', () => {
    const { m } = harness();
    m.openBook(BOOK, 2, [page(OTHER, 'A', { textIncluded: true }), page(OTHER, 'A', { textIncluded: true })], '', 0, '');
    expect([m.prevEnabled, m.nextEnabled]).toEqual([false, true]);
    m.setCurPage(1);
    expect([m.prevEnabled, m.nextEnabled]).toEqual([true, false]);
  });

  it('a page another player wrote is read-only: "Only <author> can change this page" (or the unsigned form)', () => {
    const { m } = harness();
    m.openBook(BOOK, 2, [page(OTHER, 'Asheron', { textIncluded: true }), page(OTHER, '', { textIncluded: true })], '', 0, '');
    expect(m.editable).toBe(false);
    expect(m.editRefusal()).toBe(bookOnlyAuthorText('Asheron'));
    m.setCurPage(1);
    expect(m.editRefusal()).toBe(BOOK_CANNOT_CHANGE_TEXT);
  });

  it('a page that ignores its author, or one we wrote, is editable', () => {
    const { m } = harness();
    m.openBook(BOOK, 2, [page(OTHER, 'A', { textIncluded: true, ignoreAuthor: true }), page(ME, 'Me', { textIncluded: true })], '', 0, '');
    expect(m.editable).toBe(true);
    expect(m.editRefusal()).toBeNull();
  });
});

describe('CloseCurPage @ 004bb340 / BookAddPageResponseEvent @ 004bb820 — writing', () => {
  it('leaving our own page saves it (BookModifyPage), changed or not', () => {
    const { m, sent } = harness();
    m.openBook(BOOK, 3, [page(ME, 'Me', { textIncluded: true, pageText: 'one' }), page(ME, 'Me', { textIncluded: true, pageText: 'two' })], '', 0, '');
    m.pageText = 'one, edited';
    m.setCurPage(1);
    expect(sent).toEqual(['modify 0 "one, edited"']);
    expect(m.pages![0].pageText).toBe('one, edited');
  });

  it('leaving our own page blank deletes it (BookDeletePage) and the target index shifts down', () => {
    const { m, sent } = harness();
    m.openBook(BOOK, 4, [page(ME, 'Me', { textIncluded: true }), page(OTHER, 'A', { textIncluded: true, pageText: 'x' }), page(OTHER, 'A', { textIncluded: true, pageText: 'y' })], '', 0, '');
    m.pageText = '  \n ';
    m.setCurPage(2);
    expect(sent).toEqual(['delete 0']);
    expect(m.pages!.length).toBe(2);
    expect(m.curPage).toBe(1);
    expect(m.pageText).toBe('y');
  });

  it('turning past the last page asks the server for a new one; the granted page is a blank page by us', () => {
    const { m, sent } = harness();
    m.openBook(BOOK, 3, [page(OTHER, 'A', { textIncluded: true, pageText: 'x' })], '', 0, '');
    m.setCurPage(1);
    expect(sent).toEqual(['addPage']);
    expect(m.requestPending).toBe(true);
    m.addPageResponse(BOOK, 1, true);
    expect(m.pages!.length).toBe(2);
    expect(m.page).toMatchObject({ authorId: ME, authorName: 'Me', pageText: '' });
    expect(m.editable).toBe(true);
  });

  it('a refused add asks for the whole book again', () => {
    const { m, sent } = harness();
    m.openBook(BOOK, 3, [page(OTHER, 'A', { textIncluded: true })], '', 0, '');
    m.setCurPage(1);
    m.addPageResponse(BOOK, 1, false);
    expect(sent).toEqual(['addPage', 'bookData']);
  });

  it('a blank last page of ours does not turn forward: "The <book> is already open to a blank page"', () => {
    const { m, sent, notices } = harness();
    m.openBook(BOOK, 3, [page(OTHER, 'A', { textIncluded: true, pageText: 'x' }), page(ME, 'Me', { textIncluded: true })], '', 0, '');
    m.setCurPage(1);
    sent.length = 0;
    m.setCurPage(2);
    expect(notices).toEqual([bookAlreadyBlankText('Tome')]);
    expect(sent).toEqual([]);
    expect(m.curPage).toBe(1);
  });

  it('closing the book saves the page it was on', () => {
    const { m, sent } = harness();
    m.openBook(BOOK, 1, [page(ME, 'Me', { textIncluded: true, pageText: 'a' })], '', 0, '');
    m.pageText = 'b';
    m.closeBook();
    expect(sent).toEqual(['modify 0 "b"']);
    expect(m.open).toBe(false);
  });
});

describe('UpdateMenu @ 004baf80 — the page menu', () => {
  it('one row per page the book can hold: the author for written pages, "(blank)" past the end, each "Page n"', () => {
    const { m } = harness();
    m.openBook(BOOK, 3, [page(OTHER, 'Asheron', { textIncluded: true })], '', 0, '');
    expect(m.menu).toEqual([
      { text: 'Asheron', pageLabel: 'Page 1' },
      { text: BOOK_BLANK_ROW, pageLabel: 'Page 2' },
      { text: BOOK_BLANK_ROW, pageLabel: 'Page 3' },
    ]);
  });
  it('PageTextBlank @ 004bb280: only spaces and newlines', () => {
    expect(pageTextBlank(' \n ')).toBe(true);
    expect(pageTextBlank(' a ')).toBe(false);
  });
});
