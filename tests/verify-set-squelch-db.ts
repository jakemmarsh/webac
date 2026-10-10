/**
 * FAITHFUL.362 — SetSquelchDB restores client-side squelch state on login.
 *
 * ACE `SquelchManager.cs:295` sends `GameEventSetSquelchDB` on login +
 * after each squelch-state change with the full character squelch list
 * (the server-persisted `PropertiesSquelch` Character table rows).
 *
 * Pre-FAITHFUL.362 the dispatcher silently consumed this event. So
 * even though our /squelch add command (FAITHFUL.227 + .251) correctly
 * sent `ModifyCharacterSquelch` to persist server-side, the LOCAL
 * `squelchedNames` Set was reset on every login. Visible bug: re-
 * logging then waiting for a previously-squelched player to chat —
 * their messages appeared until the user re-issued /squelch add.
 *
 * BUG.squelch-mask-per-channel-discarded — pre-fix, the parser read past
 * (and discarded) each entry's SquelchMask filter values, and never read
 * the trailing Globals SquelchInfo block at all despite a comment
 * claiming it did — so a per-channel character squelch (or a `/filter`
 * global squelch) restored as an ordinary blanket AllChannels squelch, or
 * not at all. The parser now keeps `Filters[0]` per entry (SquelchInfo's
 * single-filter constructor always repeats one value 4x) and actually
 * reads the Globals block into `globalMask`.
 *
 * Wire format per ACE source:
 *   SquelchDB.cs:158-198:
 *     accountHash:   PackableHashTable header (always empty in retail) = 4 bytes
 *     characterHash: PackableHashTable header + N × (key u32 + SquelchInfo)
 *     globals:       SquelchInfo
 *   SquelchInfo.cs:50-65:
 *     filters: u32 count + N × u32 SquelchMask
 *     playerName: s16L
 *     account: u32 bool
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { SquelchState } from '../packages/renderer/src/session/SquelchState.js';
import { GameEventType, GameMessageOpcode } from '@ac/network';
import { ChatMessageType, SquelchMask, squelchMaskForChatType } from '@ac/shared';

function u16(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
}

function u32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
}

function string16L(s: string): Uint8Array {
  const bytes = Array.from(s, c => c.charCodeAt(0));
  const total = 2 + bytes.length;
  const pad = (4 - (total % 4)) % 4;
  const out = new Uint8Array(total + pad);
  out[0] = bytes.length & 0xff;
  out[1] = (bytes.length >> 8) & 0xff;
  for (let i = 0; i < bytes.length; i++) out[2 + i] = bytes[i];
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** SquelchInfo per SquelchInfo.cs:50-65: a character entry always repeats
 *  its one real mask value 4x (SquelchInfo's single-filter constructor). */
function squelchInfo(name: string, mask: number, account = false): Uint8Array {
  return concat(
    u32(4),
    u32(mask), u32(mask), u32(mask), u32(mask),
    string16L(name),
    u32(account ? 1 : 0),
  );
}

/** Globals SquelchInfo: 0 filters when unset, 1 when `/filter` set a mask
 *  (SquelchDB.cs's ctor: `if (globals != SquelchMask.None) Globals.Filters.Add(globals)`). */
function globalsInfo(mask: number): Uint8Array {
  if (mask === SquelchMask.None) {
    return concat(u32(0), string16L(''), u32(0));
  }
  return concat(u32(1), u32(mask), string16L(''), u32(0));
}

describe('SetSquelchDB parses per-entry masks + the Globals mask (FAITHFUL.362, BUG.squelch-mask-per-channel-discarded)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onSetSquelchDB: d => calls.push(d) });
  });

  function send(charHeader: Uint8Array, entries: Uint8Array[], globals: Uint8Array, sequence = 1) {
    const accountHeader = concat(u16(0), u16(0));
    const payload = concat(accountHeader, charHeader, ...entries, globals);
    handler.handleMessage({
      type: 'event',
      opcode: GameMessageOpcode.GameEvent,
      sequence,
      eventType: GameEventType.SetSquelchDB,
      objectGuid: 0,
      payload,
    } as any);
  }

  it('extracts character names + their AllChannels mask from a blanket /squelch add', () => {
    const charHeader = concat(u16(2), u16(32));
    const entry1 = concat(u32(0x50000042), squelchInfo('Bob', SquelchMask.AllChannels));
    const entry2 = concat(u32(0x50000043), squelchInfo('Alice', SquelchMask.AllChannels));
    send(charHeader, [entry1, entry2], globalsInfo(SquelchMask.None));

    expect(calls).toHaveLength(1);
    expect(calls[0].entries).toEqual([
      { name: 'Bob', mask: SquelchMask.AllChannels, account: false },
      { name: 'Alice', mask: SquelchMask.AllChannels, account: false },
    ]);
    expect(calls[0].globalMask).toBe(0);
  });

  it('keeps a per-channel mask instead of collapsing it to a blanket squelch', () => {
    // A hypothetical per-channel character squelch (Tell + Emote only) —
    // not reachable through our own /squelch UI, but real server-side
    // state (SquelchManager.SquelchCharacter accepts any ChatMessageType).
    const tellPlusEmote = SquelchMask.Tell | SquelchMask.Emote;
    const charHeader = concat(u16(1), u16(32));
    const entry = concat(u32(0x50000042), squelchInfo('Carol', tellPlusEmote));
    send(charHeader, [entry], globalsInfo(SquelchMask.None));

    expect(calls[0].entries).toEqual([{ name: 'Carol', mask: tellPlusEmote, account: false }]);
  });

  it('CORE.5.c.d — keeps the SquelchInfo.Account flag (drives the squelch panel Type column)', () => {
    // ACE SquelchDB.cs ships ACCOUNT squelches inside the Characters table
    // flagged Account=true (its own comment: "it contains both the
    // Character and Account squelches (denoted by SquelchInfo.Account)").
    const charHeader = concat(u16(2), u16(32));
    const entry1 = concat(u32(0x50000042), squelchInfo('Bob', SquelchMask.AllChannels, false));
    const entry2 = concat(u32(0x50000044), squelchInfo('Mallory', SquelchMask.AllChannels, true));
    send(charHeader, [entry1, entry2], globalsInfo(SquelchMask.None));

    expect(calls[0].entries).toEqual([
      { name: 'Bob', mask: SquelchMask.AllChannels, account: false },
      { name: 'Mallory', mask: SquelchMask.AllChannels, account: true },
    ]);
  });

  it('reads the trailing Globals SquelchInfo into globalMask (the /filter command)', () => {
    const charHeader = concat(u16(0), u16(32));
    send(charHeader, [], globalsInfo(SquelchMask.Emote));

    expect(calls[0].entries).toEqual([]);
    expect(calls[0].globalMask).toBe(SquelchMask.Emote);
  });

  it('handles empty squelch DB (fresh character)', () => {
    const charHeader = concat(u16(0), u16(32));
    send(charHeader, [], globalsInfo(SquelchMask.None), 2);

    expect(calls[0].entries).toEqual([]);
    expect(calls[0].globalMask).toBe(0);
  });
});

describe('SquelchState.blocksChannel — per-name mask OR global mask (mirrors SquelchDB.Contains())', () => {
  it('a blanket AllChannels entry blocks every legal channel', () => {
    const s = new SquelchState();
    s.set('bob', 'Bob', SquelchMask.AllChannels);
    expect(s.blocksChannel('bob', squelchMaskForChatType(ChatMessageType.Tell))).toBe(true);
    expect(s.blocksChannel('bob', squelchMaskForChatType(ChatMessageType.Speech))).toBe(true);
    expect(s.blocksChannel('bob', squelchMaskForChatType(ChatMessageType.Fellowship))).toBe(true);
  });

  it('a per-channel entry only blocks the channel it covers', () => {
    const s = new SquelchState();
    s.set('carol', 'Carol', SquelchMask.Tell);
    expect(s.blocksChannel('carol', squelchMaskForChatType(ChatMessageType.Tell))).toBe(true);
    expect(s.blocksChannel('carol', squelchMaskForChatType(ChatMessageType.Speech))).toBe(false);
    expect(s.blocksChannel('carol', squelchMaskForChatType(ChatMessageType.Emote))).toBe(false);
  });

  it('an unsquelched name with no entry is never blocked by name alone', () => {
    const s = new SquelchState();
    expect(s.blocksChannel('dave', squelchMaskForChatType(ChatMessageType.Tell))).toBe(false);
  });

  it('the global mask blocks a channel account-wide, independent of any per-name entry', () => {
    const s = new SquelchState();
    s.globalMask = SquelchMask.Emote;
    expect(s.blocksChannel('anyone', squelchMaskForChatType(ChatMessageType.Emote))).toBe(true);
    expect(s.blocksChannel('anyone', squelchMaskForChatType(ChatMessageType.Tell))).toBe(false);
  });

  it('clear() resets the global mask alongside the per-name entries', () => {
    const s = new SquelchState();
    s.set('bob', 'Bob', SquelchMask.AllChannels);
    s.globalMask = SquelchMask.Emote;
    s.clear();
    expect(s.blocksChannel('bob', squelchMaskForChatType(ChatMessageType.Tell))).toBe(false);
    expect(s.globalMask).toBe(0);
  });
});

describe('SquelchState.replaceAll — full-snapshot semantics (BUG.squelch-db-snapshot-treated-as-merge)', () => {
  it('drops a name absent from the new snapshot instead of leaving it merged in', () => {
    // Repro: squelch Bob on Tell only, then unsquelch Bob on Tell — server-
    // side UnsquelchCharacter's mask goes to None so TryRemoveSquelch drops
    // the Characters entry entirely (SquelchManager.cs:181-186), and the
    // next SetSquelchDB's entries array simply omits Bob.
    const s = new SquelchState();
    s.set('bob', 'Bob', SquelchMask.Tell);
    s.set('alice', 'Alice', SquelchMask.AllChannels);

    s.replaceAll([{ name: 'Alice', mask: SquelchMask.AllChannels }]);

    expect(s.has('bob')).toBe(false);
    expect(s.blocksChannel('bob', squelchMaskForChatType(ChatMessageType.Tell))).toBe(false);
    expect(s.has('alice')).toBe(true);
  });

  it('replaces an existing entry\'s mask rather than merging the two', () => {
    const s = new SquelchState();
    s.set('carol', 'Carol', SquelchMask.Tell);

    s.replaceAll([{ name: 'Carol', mask: SquelchMask.Emote }]);

    expect(s.blocksChannel('carol', squelchMaskForChatType(ChatMessageType.Tell))).toBe(false);
    expect(s.blocksChannel('carol', squelchMaskForChatType(ChatMessageType.Emote))).toBe(true);
  });

  it('an empty snapshot clears every previously-squelched name (mask goes to zero server-side)', () => {
    const s = new SquelchState();
    s.set('bob', 'Bob', SquelchMask.AllChannels);
    s.set('alice', 'Alice', SquelchMask.AllChannels);

    s.replaceAll([]);

    expect(s.has('bob')).toBe(false);
    expect(s.has('alice')).toBe(false);
  });

  it('does not touch globalMask — callers assign it separately from the same event\'s Globals block', () => {
    const s = new SquelchState();
    s.globalMask = SquelchMask.Emote;

    s.replaceAll([{ name: 'Dave', mask: SquelchMask.AllChannels }]);

    expect(s.globalMask).toBe(SquelchMask.Emote);
  });
});
