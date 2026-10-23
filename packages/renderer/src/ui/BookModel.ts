/**
 * BookModel — the state machine of the retail book / journal window
 * (gmBookUI, layout 0x21000019), ported from the decompiled client. The view
 * (GameUI.renderBookPanel) draws it; this file owns what is shown, what is
 * editable and what goes to the server.
 *
 *  - OpenBook @ 004bbca0: keeps the current page when the same book reopens,
 *    closes the previous book (saving its page), rebuilds the page menu and
 *    shows page min(current, numPages - 1) (0 for a new book). The title is
 *    the inscription when the book has a scribe, else the book's name.
 *  - SetCurPage @ 004bb570: refused while a request is pending, out of
 *    range, or already showing. Leaving the last page for the next one while
 *    it is blank and our own → "The <book> is already open to a blank page".
 *    Otherwise CloseCurPage (which may delete the page we leave), then: a page
 *    past the list → BookAddPage; a page whose text did not come with the book
 *    → BookPageData; either way the text clears and waits (requestPending).
 *    Prev is ghosted on page 0, Next on the last page the book can hold.
 *  - DisplayPageData @ 004bb1e0: editable when we wrote the page or it
 *    ignores its author.
 *  - CloseCurPage @ 004bb340: on our own (or author-ignoring) page, a blank
 *    page of ours is deleted (BookDeletePage); anything else is saved
 *    (BookModifyPage), changed or not.
 *  - BookPageDataResponseEvent @ 004bb470 / BookAddPageResponseEvent
 *    @ 004bb820: the server's page replaces ours; a granted add inserts a
 *    blank page by us; a refused add (or one for another page) asks for the
 *    whole book again.
 *  - ListenToElementMessage @ 004bba10, an edit attempt (message 0x19) on a
 *    page we may not change: "Only <author> can change this page", or "You
 *    cannot change this page" when the page has no author.
 *  - UpdateMenu @ 004baf80 / AddPageInfo @ 004bae90: one menu row per page
 *    the book can hold — the author's name for a written page, "(blank)"
 *    past the end — each with "Page <n>".
 * The notice strings are acclient.exe literals.
 *
 * Era rules (EraClientRules.book, VTE-8): the 1999 ReadWritePanel_UpdateMenu
 * @ 0x00521230 writes a written page's row as "- <author>" (nothing for an
 * empty author), and ReadWritePanel_CloseCurPage @ 0x00521820 saves a page
 * only when its text region is dirty (here: the text differs from the page's).
 */

export interface BookPage {
  authorId: number;
  authorName: string;
  /** False when the text was not sent with the book (ACE never sends it): ask with BookPageData. */
  textIncluded: boolean;
  /** Anyone may edit the page. */
  ignoreAuthor: boolean;
  pageText: string;
}

export interface BookIO {
  playerId(): number;
  playerName(): string;
  bookName(bookId: number): string;
  pageData(bookId: number, page: number): void;
  addPage(bookId: number): void;
  modifyPage(bookId: number, page: number, text: string): void;
  deletePage(bookId: number, page: number): void;
  bookData(bookId: number): void;
  /** The spew-box notice (ECM_UI::SendNotice_DisplayStringInfo 0x1a). */
  notice(text: string): void;
}

export const BOOK_BLANK_ROW = '(blank)';
export const bookAlreadyBlankText = (bookName: string): string => `The ${bookName} is already open to a blank page`;
export const bookOnlyAuthorText = (author: string): string => `Only ${author} can change this page`;
export const BOOK_CANNOT_CHANGE_TEXT = 'You cannot change this page';
export const bookPageLabel = (index: number): string => `Page ${index + 1}`;

/** PageTextBlank @ 004bb280: nothing but spaces and newlines. */
export function pageTextBlank(text: string): boolean {
  return /^[ \n\0]*$/.test(text);
}

/** The era's book rules (EraClientRules.book); end of retail's by default. */
export interface BookModelRules {
  menuAuthorFormat: string;
  saveOnlyChanged: boolean;
}
const EOR_BOOK_RULES: BookModelRules = { menuAuthorFormat: '%s', saveOnlyChanged: false };

export class BookModel {
  rules: BookModelRules = EOR_BOOK_RULES;
  bookId = 0;
  maxNumPages = 0;
  pages: BookPage[] | null = null;
  curPage = -1;
  requestPending = false;
  inscription = '';
  scribeId = 0;
  scribeName = '';
  /** The text the page shows (what the editor holds while the page is editable). */
  pageText = '';

  constructor(private readonly io: BookIO) {}

  get open(): boolean { return this.bookId !== 0; }

  /** The title bar: the inscription when the book has a scribe, else the book's name. */
  get title(): string {
    return this.scribeId !== 0 ? this.inscription : this.io.bookName(this.bookId);
  }

  get page(): BookPage | null { return this.pages?.[this.curPage] ?? null; }

  /** DisplayPageData's SetEditable: our page, or one that ignores its author, once its text is here. */
  get editable(): boolean {
    const p = this.page;
    if (!p || this.requestPending || !p.textIncluded) return false;
    return p.authorId === this.io.playerId() || p.ignoreAuthor;
  }

  get prevEnabled(): boolean { return this.curPage >= 1; }
  get nextEnabled(): boolean { return this.curPage < this.maxNumPages - 1; }

  /** UpdateMenu: one row per page the book can hold. */
  get menu(): Array<{ text: string; pageLabel: string }> {
    const rows: Array<{ text: string; pageLabel: string }> = [];
    const pages = this.pages ?? [];
    const author = (name: string): string => (name ? this.rules.menuAuthorFormat.replace('%s', name) : '');
    for (let i = 0; i < pages.length; i++) rows.push({ text: author(pages[i].authorName), pageLabel: bookPageLabel(i) });
    for (let i = pages.length; i < this.maxNumPages; i++) rows.push({ text: BOOK_BLANK_ROW, pageLabel: bookPageLabel(i) });
    return rows;
  }

  openBook(bookId: number, maxNumPages: number, pages: BookPage[], inscription: string, scribeId: number, scribeName: string): void {
    const keep = this.bookId === bookId ? this.curPage : 0;
    if (this.bookId !== 0) this.closeBook();
    this.bookId = bookId;
    this.maxNumPages = maxNumPages;
    this.pages = pages.map((p) => ({ ...p }));
    const target = Math.max(0, Math.min(keep, this.pages.length - 1));
    this.setCurPage(target);
    this.inscription = inscription;
    this.scribeId = scribeId;
    this.scribeName = scribeName;
  }

  setCurPage(n: number): void {
    const pages = this.pages;
    if (!pages || this.requestPending || n < 0 || n >= this.maxNumPages || n === this.curPage) return;
    const cur = this.page;
    const numPages = pages.length;
    const leavingBlankLastPage = this.curPage === numPages - 1 && this.curPage !== -1 && this.curPage < n
      && pageTextBlank(this.pageText) && cur !== null && cur.authorId === this.io.playerId();
    if (n > numPages || leavingBlankLastPage) {
      this.io.notice(bookAlreadyBlankText(this.io.bookName(this.bookId)));
      return;
    }
    if (this.closeCurPage() && this.curPage < n) n -= 1;
    this.curPage = n;
    const page = pages[n];
    if (!page) {
      this.pageText = '';
      this.io.addPage(this.bookId);
      this.requestPending = true;
    } else if (page.textIncluded) {
      this.pageText = page.pageText;
    } else {
      this.pageText = '';
      this.io.pageData(this.bookId, n);
      this.requestPending = true;
    }
  }

  /** CloseCurPage: returns true when the page was deleted. `editorText` is what the page shows now. */
  closeCurPage(): boolean {
    const page = this.page;
    if (!this.bookId || !this.pages || this.requestPending || !page) return false;
    const me = this.io.playerId();
    if (page.authorId !== me && !page.ignoreAuthor) return false;
    if (pageTextBlank(this.pageText) && page.authorId === me) {
      this.io.deletePage(this.bookId, this.curPage);
      this.pages.splice(this.curPage, 1);
      return true;
    }
    if (this.rules.saveOnlyChanged && page.pageText === this.pageText) return false;
    page.pageText = this.pageText;
    this.io.modifyPage(this.bookId, this.curPage, page.pageText);
    return false;
  }

  closeBook(): void {
    this.closeCurPage();
    this.bookId = 0;
    this.maxNumPages = 0;
    this.pages = null;
    this.curPage = -1;
    this.inscription = '';
    this.scribeId = 0;
    this.scribeName = '';
    this.requestPending = false;
    this.pageText = '';
  }

  pageDataResponse(bookId: number, index: number, page: BookPage): void {
    if (bookId !== this.bookId || !this.bookId || !this.pages) return;
    this.pages[index] = { ...page, textIncluded: true };
    if (index === this.curPage) this.pageText = page.pageText;
    this.requestPending = false;
  }

  addPageResponse(bookId: number, index: number, success: boolean): void {
    if (bookId !== this.bookId || !this.bookId || !this.pages) return;
    if (success && index === this.curPage) {
      this.pages.splice(index, 0, {
        authorId: this.io.playerId(), authorName: this.io.playerName(),
        textIncluded: true, ignoreAuthor: false, pageText: '',
      });
      this.pageText = '';
      this.requestPending = false;
      return;
    }
    if (success) this.curPage = index;
    this.io.bookData(this.bookId);
  }

  /** An edit attempt on a page we may not change (message 0x19): the notice, or null when editing is allowed. */
  editRefusal(): string | null {
    const page = this.page;
    if (!this.pages || !page || this.editable) return null;
    if (page.ignoreAuthor) return null;
    return page.authorName.trim() ? bookOnlyAuthorText(page.authorName) : BOOK_CANNOT_CHANGE_TEXT;
  }
}
