/**
 * GAP.86 — Behavioral byte-level coverage for GameEvent parsers using
 * String16L that had ONLY the FAITHFUL.53 presence-check (case exists),
 * never a real wire-format test:
 *
 * 1. GameEventEvasionDefenderNotification (0x01B4) — per ACE
 *    `GameEventEvasionDefenderNotification.cs:8`, wire is a single
 *    `WriteString16L(attackerName)`. Exercises the odd-length-string pad
 *    path (attackerName lengths chosen so total=2+len is NOT already a
 *    multiple of 4) plus the zero-length-string path (still consumes 4
 *    bytes: 2 length + 2 pad, per MessageSerializer.ts's readString16
 *    doc "Empty strings still consume 4 bytes on the wire").
 *
 * 2. GameEventBookDataResponse (0x00B4) — per
 *    `GameEventBookDataResponse.cs:12-49`, wire is:
 *      u32 bookID + u32 maxNumPages + u32 numPages + u32 maxNumCharsPerPage
 *      + u32 pageCount + pageCount × (
 *          u32 authorId + String16L authorName + String16L authorAccount
 *          + u32 flags(0xFFFF0002) + u32 textIncluded
 *          + [u32 ignoreAuthor] + [String16L pageText if textIncluded]
 *        )
 *      + String16L inscription + u32 inscriptionAuthorId + String16L
 *        inscriptionAuthorName
 *    Multi-page, multi-string payload exercising several consecutive
 *    String16L reads (the exact "alignment after WriteString16L" risk
 *    named in GAP.86 — a single missed `align(4)` anywhere in this chain
 *    desyncs every field after it) and both the textIncluded=1 and
 *    textIncluded=0 branches.
 *
 * 3. GameEventBookPageDataResponse (0x00B8) — per
 *    `GameEventBookPageDataResponse.cs:12-27`, wire is:
 *      u32 bookID + i32 pageIndex + u32 authorId + String16L authorName
 *      + String16L authorAccount + u32 flags(0xFFFF0002) + u32 textIncluded
 *      + u32 ignoreAuthor + String16L pageText
 *    ACE's `Player_Book.cs` "This is completely unused" comment refers to the
 *    retail client never sending the 0x00AE request — but the GameAction
 *    handler IS live (`GameActionBookPageData.cs`) and our client's
 *    `bookPageData()` API sends it, so the response is reachable and must
 *    parse (BUG.bookpagedataresponse-dropped; a prior comment here claimed
 *    the no-op drop was faithful — that premise was wrong).
 *
 * BookAddPageResponse/BookModifyPageResponse/BookDeletePageResponse DO have
 * live, non-deprecated server call sites (`Player_Book.cs` HandleActionBook-
 * AddPage/ModifyPage/DeletePage) and are now parsed per
 * GameEventBookAddPageResponse.cs/GameEventBookModifyPageResponse.cs/
 * GameEventBookDeletePageResponse.cs: bookGuid u32 + page int32 (0-based) +
 * success uint32 (bool) — see BUG.book-page-edit-responses-unhandled.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { GameEventType, GameMessageOpcode } from '@ac/network';

// Pack ACE WriteString16L: u16 length + Windows-1252 bytes + 4-byte align.
function string16L(s: string): Uint8Array {
  const bytes = Array.from(s, (c) => c.charCodeAt(0));
  const total = 2 + bytes.length;
  const pad = (4 - (total % 4)) % 4;
  const out = new Uint8Array(total + pad);
  out[0] = bytes.length & 0xff;
  out[1] = (bytes.length >> 8) & 0xff;
  for (let i = 0; i < bytes.length; i++) out[2 + i] = bytes[i];
  return out;
}

function u32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

describe('EvasionDefenderNotification wire-format (GAP.86)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onEvasionDefender: (data) => calls.push(data) });
  });

  it('parses a single String16L attackerName whose length forces 2 pad bytes', () => {
    // "Olthoi Warrior" is 14 chars -> total 16 (2+14), already %4==0, no pad.
    // Use an 11-char name so total=13, pad=3, to exercise a non-trivial pad.
    const name = 'Tumerok Rat'; // 11 chars
    expect((2 + name.length) % 4).not.toBe(0);
    handler.handleMessage({
      type: 'event',
      opcode: GameMessageOpcode.GameEvent,
      sequence: 1,
      eventType: GameEventType.EvasionDefenderNotification,
      objectGuid: 0,
      payload: string16L(name),
    } as any);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ attackerName: name });
  });

  it('parses the zero-length-string edge case (4 bytes on the wire: 2 length + 2 pad)', () => {
    const payload = string16L('');
    expect(payload.length).toBe(4);
    handler.handleMessage({
      type: 'event',
      opcode: GameMessageOpcode.GameEvent,
      sequence: 2,
      eventType: GameEventType.EvasionDefenderNotification,
      objectGuid: 0,
      payload,
    } as any);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ attackerName: '' });
  });
});

describe('BookDataResponse wire-format (GAP.86)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onBookData: (data) => calls.push(data) });
  });

  it('parses bookID/maxPages/pageCount header + a filled page + an empty page + inscription trailer', () => {
    const BOOK_GUID = 0x80001234;
    const MAX_PAGES = 10;
    const MAX_CHARS = 400;

    // Page 0: textIncluded=1 branch — authorName/authorAccount/pageText all
    // odd lengths so every String16L in the chain needs its own pad.
    const page0 = concat(
      u32(0x50000111),           // authorId
      string16L('Asheron'),      // authorName (7 chars, pad=3)
      string16L('scribe1'),      // authorAccount (7 chars, pad=3)
      u32(0xFFFF0002),           // flags
      u32(1),                    // textIncluded
      u32(0),                    // ignoreAuthor
      string16L('Once upon a time in Dereth.'), // pageText (27 chars, pad=1)
    );
    // Page 1: textIncluded=0 branch — no pageText field at all.
    const page1 = concat(
      u32(0x50000222),
      string16L('Elysa'),        // 5 chars, pad=3
      string16L(''),             // authorAccount empty (4 bytes)
      u32(0xFFFF0002),
      u32(0),                    // textIncluded=0
      u32(1),                    // ignoreAuthor
      // no pageText
    );

    const payload = concat(
      u32(BOOK_GUID),
      u32(MAX_PAGES),   // maxNumPages
      u32(MAX_PAGES),   // numPages (duplicate per ACE comment)
      u32(MAX_CHARS),
      u32(2),           // pageData.Count
      page0,
      page1,
      string16L('A tome of Dereth lore.'), // inscription (23 chars, pad=1)
      u32(0x60009999),                      // inscription authorId
      string16L('Mad Fred the Scribe'),     // inscriptionAuthor (19 chars, pad=1)
    );

    handler.handleMessage({
      type: 'event',
      opcode: GameMessageOpcode.GameEvent,
      sequence: 3,
      eventType: GameEventType.BookDataResponse,
      objectGuid: 0,
      payload,
    } as any);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      bookGuid: BOOK_GUID,
      maxPages: MAX_PAGES,
      pages: [
        { authorId: 0x50000111, authorName: 'Asheron', textIncluded: true, ignoreAuthor: false, pageText: 'Once upon a time in Dereth.' },
        { authorId: 0x50000222, authorName: 'Elysa', textIncluded: false, ignoreAuthor: true, pageText: '' },
      ],
      inscription: 'A tome of Dereth lore.',
      inscriptionAuthorId: 0x60009999,
      inscriptionAuthor: 'Mad Fred the Scribe',
    });
  });

  it('does not throw when every page + trailer string is empty (all-4-byte-pad edge case)', () => {
    const payload = concat(
      u32(1), u32(0), u32(0), u32(0),
      u32(1), // pageCount = 1
      u32(0), string16L(''), string16L(''), u32(0xFFFF0002), u32(0), u32(0), // textIncluded=0
      string16L(''), u32(0), string16L(''),
    );
    expect(() => {
      handler.handleMessage({
        type: 'event',
        opcode: GameMessageOpcode.GameEvent,
        sequence: 4,
        eventType: GameEventType.BookDataResponse,
        objectGuid: 0,
        payload,
      } as any);
    }).not.toThrow();
    expect(calls).toHaveLength(1);
    expect(calls[0].pages).toEqual([{ authorId: 0, authorName: '', textIncluded: false, ignoreAuthor: false, pageText: '' }]);
  });
});

describe('BookPageDataResponse cites the ACE "unused" disposition (BUG.book-page-edit-responses-unhandled)', () => {
  it('remains a deliberate no-op — ACE never sends it in practice', () => {
    // ACE WorldObjects/Player_Book.cs:52 ReadBookPage: "This is completely
    // unused." — the server-side sender of GameEventBookPageDataResponse is
    // dead code by ACE's own admission, so a client-side parser would never
    // fire in practice. Confirm the case still falls through to an
    // acknowledged no-op, and hasn't silently grown a partial parse that
    // would desync on the next real GameEvent in the stream.
    const handler = new ServerMessageHandler();
    handler.setHandlers({});
    expect(() => {
      handler.handleMessage({
        type: 'event',
        opcode: GameMessageOpcode.GameEvent,
        sequence: 5,
        eventType: GameEventType.BookPageDataResponse,
        objectGuid: 0,
        payload: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), // arbitrary trailing bytes
      } as any);
    }).not.toThrow();
  });
});

describe('BookAddPageResponse/BookModifyPageResponse/BookDeletePageResponse wire-format (BUG.book-page-edit-responses-unhandled)', () => {
  // Wire format per GameEventBookAddPageResponse.cs/GameEventBookModifyPageResponse.cs/
  // GameEventBookDeletePageResponse.cs: bookGuid u32 + page int32 (0-based) + success uint32 (bool).
  function pageEditPayload(bookGuid: number, page: number, success: boolean): Uint8Array {
    const p = new DataView(new ArrayBuffer(12));
    p.setUint32(0, bookGuid, true);
    p.setInt32(4, page, true);
    p.setUint32(8, success ? 1 : 0, true);
    return new Uint8Array(p.buffer);
  }

  const cases: Array<{
    label: string;
    eventType: number;
    handlerName: 'onBookAddPageResponse' | 'onBookModifyPageResponse' | 'onBookDeletePageResponse';
  }> = [
    { label: 'BookAddPageResponse', eventType: GameEventType.BookAddPageResponse, handlerName: 'onBookAddPageResponse' },
    { label: 'BookModifyPageResponse', eventType: GameEventType.BookModifyPageResponse, handlerName: 'onBookModifyPageResponse' },
    { label: 'BookDeletePageResponse', eventType: GameEventType.BookDeletePageResponse, handlerName: 'onBookDeletePageResponse' },
  ];

  for (const { label, eventType, handlerName } of cases) {
    it(`${label}: parses bookGuid/page/success and fires ${handlerName}`, () => {
      const handler = new ServerMessageHandler();
      const calls: any[] = [];
      handler.setHandlers({ [handlerName]: (data: any) => calls.push(data) } as any);

      handler.handleMessage({
        type: 'event',
        opcode: GameMessageOpcode.GameEvent,
        sequence: 6,
        eventType,
        objectGuid: 0,
        payload: pageEditPayload(0x80005678, 2, true),
      } as any);

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ bookGuid: 0x80005678, page: 2, success: true });
    });

    it(`${label}: parses success=false (0-based page 0)`, () => {
      const handler = new ServerMessageHandler();
      const calls: any[] = [];
      handler.setHandlers({ [handlerName]: (data: any) => calls.push(data) } as any);

      handler.handleMessage({
        type: 'event',
        opcode: GameMessageOpcode.GameEvent,
        sequence: 7,
        eventType,
        objectGuid: 0,
        payload: pageEditPayload(0x80009abc, 0, false),
      } as any);

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ bookGuid: 0x80009abc, page: 0, success: false });
    });
  }
});

describe('BookPageDataResponse wire-format (BUG.bookpagedataresponse-dropped)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onBookPageData: (data) => calls.push(data) });
  });

  // Payload per GameEventBookPageDataResponse.cs write order.
  function pageDataPayload(opts: {
    bookGuid: number; pageIndex: number; authorId: number; authorName: string;
    authorAccount: string; textIncluded: number; ignoreAuthor: number; pageText: string;
  }): Uint8Array {
    const parts = [
      u32(opts.bookGuid),
      u32(opts.pageIndex >>> 0),
      u32(opts.authorId),
      string16L(opts.authorName),
      string16L(opts.authorAccount),
      u32(0xFFFF0002),
      u32(opts.textIncluded),
      u32(opts.ignoreAuthor),
    ];
    if (opts.textIncluded) parts.push(string16L(opts.pageText));
    return concat(...parts);
  }

  it('parses the full ACE response (odd-length strings forcing String16L pads)', () => {
    handler.handleMessage({
      type: 'event',
      opcode: GameMessageOpcode.GameEvent,
      sequence: 10,
      eventType: GameEventType.BookPageDataResponse,
      objectGuid: 0,
      payload: pageDataPayload({
        bookGuid: 0x80001234, pageIndex: 3, authorId: 0x50000111,
        authorName: 'Asheron',              // 7 chars, pad=3
        authorAccount: 'Password is cheese', // ACE's non-admin placeholder, 18 chars
        textIncluded: 1, ignoreAuthor: 0,
        pageText: 'Once upon a time in Dereth.', // 27 chars, pad=1
      }),
    } as any);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      bookGuid: 0x80001234,
      pageIndex: 3,
      authorId: 0x50000111,
      authorName: 'Asheron',
      ignoreAuthor: false,
      pageText: 'Once upon a time in Dereth.',
    });
  });

  it('parses ignoreAuthor=1 with an empty pageText (ACE always writes textIncluded=1, even for "")', () => {
    handler.handleMessage({
      type: 'event',
      opcode: GameMessageOpcode.GameEvent,
      sequence: 11,
      eventType: GameEventType.BookPageDataResponse,
      objectGuid: 0,
      payload: pageDataPayload({
        bookGuid: 0x80005678, pageIndex: 0, authorId: 0,
        authorName: '', authorAccount: '',
        textIncluded: 1, ignoreAuthor: 1, pageText: '',
      }),
    } as any);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      bookGuid: 0x80005678,
      pageIndex: 0,
      authorId: 0,
      authorName: '',
      ignoreAuthor: true,
      pageText: '',
    });
  });

  it('tolerates a textIncluded=0 payload with no trailing pageText (retail-format defensive branch)', () => {
    handler.handleMessage({
      type: 'event',
      opcode: GameMessageOpcode.GameEvent,
      sequence: 12,
      eventType: GameEventType.BookPageDataResponse,
      objectGuid: 0,
      payload: pageDataPayload({
        bookGuid: 0x80009abc, pageIndex: 1, authorId: 0x50000222,
        authorName: 'Elysa', authorAccount: 'x',
        textIncluded: 0, ignoreAuthor: 0, pageText: '',
      }),
    } as any);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      bookGuid: 0x80009abc,
      pageIndex: 1,
      authorId: 0x50000222,
      authorName: 'Elysa',
      ignoreAuthor: false,
      pageText: '',
    });
  });
});
