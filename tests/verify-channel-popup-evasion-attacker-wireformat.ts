/**
 * GAP.86 — Behavioral byte-level coverage for GameEvent parsers that had
 * ZERO dedicated wire-format tests (only a FAITHFUL.53-style presence check,
 * or in EvasionAttackerNotification's case a downstream source-grep pin on
 * target-resolution logic that never exercises the actual byte parse):
 *
 * 1. GameEventEvasionAttackerNotification (0x01B3) — per ACE
 *    `GameEventEvasionAttackerNotification.cs:8`, wire is a single
 *    `WriteString16L(defenderName)` (named `targetName` in our wire shape).
 *    Sibling of EvasionDefenderNotification (already covered in
 *    verify-book-evasion-string16l-wireformat.ts); this is the missing half.
 *
 * 2. GameEventPopupString (0x0004) — per `GameEventPopupString.cs:8`, wire
 *    is a single `WriteString16L(message)`. Had no test anywhere in the
 *    suite before this file.
 *
 * 3. GameEventChannelIndex (0x0149) / GameEventChannelList (0x0148) — per
 *    `GameEventChannelIndex.cs`/`GameEventChannelList.cs`, wire is
 *    `u32 count + count × WriteString16L(name)`. The only existing test
 *    with "ChannelList" in its name (FAITHFUL.578) covers the unrelated
 *    OUTBOUND GameActionChannelList request, not these inbound parsers —
 *    the alignment-after-String16L risk on the actual inbound roster
 *    parse was untested.
 *
 * 4. GameEventGetInscriptionResponse (0x00C3) — per
 *    `GameEventInscriptionResponse.cs`, marked "THIS EVENT IS DEPRECIATED
 *    AND HAS NO HANDLER IN ACCLIENT". Confirms the shared no-op case
 *    (grouped with AllegianceUpdateDone/ItemAppraiseDone/FellowshipUpdateDone
 *    in ServerMessageHandler.ts) silently consumes an arbitrary payload
 *    without throwing or dispatching, matching retail's own disposition.
 *
 * GAP.86 final coverage pass (2026-07-24): the 3 siblings sharing that same
 * no-op case block had zero behavioral coverage — only a FAITHFUL.53-style
 * case-presence regex (verify-ace-event-coverage.ts) and an enum-value pin
 * (verify-message-event-enum-parity.ts), neither of which drives a byte
 * payload through handleMessage(). Added below:
 *
 * 5. GameEventAllegianceAllegianceUpdateDone (0x01C8) — per
 *    `GameEventAllegianceAllegianceUpdateDone.cs:9`, the ACE writer DOES emit
 *    a real 4-byte payload (`(uint)errorType`, a WeenieError). Every one of
 *    its 5 call sites (Player_Allegiance.cs:134/260, Allegiance.cs:361,
 *    AllegianceManager.cs:398, GameActionAllegianceUpdateRequest.cs:21) uses
 *    the default `errorType = WeenieError.None` today, but the event is NOT
 *    deprecated (unlike its former case-block neighbors below) — a non-stock
 *    server or future ACE build could populate a real error here.
 *    BUG.allegiance-update-done-error-dropped (2026-08-09) split this out of
 *    the shared no-op case so the field is read and dispatched via
 *    onAllegianceUpdateDone instead of silently discarded. Tests below drive
 *    both the always-None wire shape and a non-zero error code.
 *
 * 6. GameEventItemAppraiseDone (0x01CB) — no ACE.Server writer class exists
 *    for this event at all (grep across reference/ACE/Source finds only the
 *    GameEventType.cs enum value); real ACE never emits it. The no-op case
 *    exists purely so a non-stock server emitting one doesn't blow up the
 *    connection — test drives an arbitrary payload to confirm that.
 *
 * 7. GameEventFellowshipFellowUpdateDone (0x01C9) — per
 *    `GameEventFellowshipFellowUpdateDone.cs:6-9`, explicitly commented
 *    "outdated message, not found in end of retail?" with its own
 *    `Writer.Write` commented out — ACE itself sends zero payload bytes.
 *    Test drives a zero-length payload (the real wire shape) plus an
 *    arbitrary non-empty one (robustness against a non-stock server).
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

let seq = 100;
function event(eventType: GameEventType, payload: Uint8Array) {
  return {
    type: 'event',
    opcode: GameMessageOpcode.GameEvent,
    sequence: seq++,
    eventType,
    objectGuid: 0,
    payload,
  } as any;
}

describe('EvasionAttackerNotification wire-format (GAP.86)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onEvasionAttacker: (data) => calls.push(data) });
  });

  it('parses a single String16L targetName whose length forces a non-zero pad', () => {
    const name = 'Tumerok Rat'; // 11 chars -> total 13, pad 3
    expect((2 + name.length) % 4).not.toBe(0);
    handler.handleMessage(event(GameEventType.EvasionAttackerNotification, string16L(name)));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ targetName: name });
  });

  it('parses the zero-length-string edge case (4 bytes on the wire)', () => {
    const payload = string16L('');
    expect(payload.length).toBe(4);
    handler.handleMessage(event(GameEventType.EvasionAttackerNotification, payload));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ targetName: '' });
  });
});

describe('PopupString wire-format (GAP.86)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onPopupString: (data) => calls.push(data) });
  });

  it('parses a single String16L message needing a non-zero pad', () => {
    const message = 'Welcome to Dereth'; // 17 chars -> total 19, pad 1
    expect((2 + message.length) % 4).not.toBe(0);
    handler.handleMessage(event(GameEventType.PopupString, string16L(message)));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ message });
  });

  it('parses the zero-length-string edge case', () => {
    handler.handleMessage(event(GameEventType.PopupString, string16L('')));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ message: '' });
  });
});

describe('ChannelIndex / ChannelList wire-format (GAP.86)', () => {
  let handler: ServerMessageHandler;
  const indexCalls: any[] = [];
  const listCalls: any[] = [];

  beforeEach(() => {
    indexCalls.length = 0;
    listCalls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({
      onChannelIndex: (data) => indexCalls.push(data),
      onChannelList: (data) => listCalls.push(data),
    });
  });

  it('ChannelIndex parses count + N String16L names with mixed pad lengths', () => {
    // Names chosen so (2+len)%4 varies across 0/1/2/3 to exercise every pad case.
    const names = ['Abuse', 'Admin', 'Audit', 'Av1', 'Av2', 'Av3', 'Sentinel', 'Help'];
    const payload = concat(u32(names.length), ...names.map(string16L));
    handler.handleMessage(event(GameEventType.ChannelIndex, payload));
    expect(indexCalls).toHaveLength(1);
    expect(indexCalls[0]).toEqual({ channels: names });
  });

  it('ChannelIndex handles a zero-count roster (no names to read)', () => {
    handler.handleMessage(event(GameEventType.ChannelIndex, u32(0)));
    expect(indexCalls).toHaveLength(1);
    expect(indexCalls[0]).toEqual({ channels: [] });
  });

  // BUG.channel-index-multi-block-not-parsed: GameEventChannelIndex.cs writes
  // up to three independent (not else-if) count+names blocks back to back —
  // IsAdmin (8 names), IsArch||IsSentinel (7 names), IsAdvocate (5 names) —
  // since those flags aren't mutually exclusive on a GM character.
  it('ChannelIndex concatenates all names when IsArch/IsSentinel + IsAdvocate blocks are both present', () => {
    const archNames = ['Abuse', 'Audit', 'Av1', 'Av2', 'Av3', 'Sentinel', 'Help'];
    const advocateNames = ['Abuse', 'Av1', 'Av2', 'Av3', 'Help'];
    const payload = concat(
      u32(archNames.length), ...archNames.map(string16L),
      u32(advocateNames.length), ...advocateNames.map(string16L),
    );
    handler.handleMessage(event(GameEventType.ChannelIndex, payload));
    expect(indexCalls).toHaveLength(1);
    expect(indexCalls[0]).toEqual({ channels: [...archNames, ...advocateNames] });
  });

  it('ChannelIndex concatenates all three blocks when IsAdmin + IsArch-or-Sentinel + IsAdvocate are all set', () => {
    const adminNames = ['Abuse', 'Admin', 'Audit', 'Av1', 'Av2', 'Av3', 'Sentinel', 'Help'];
    const archNames = ['Abuse', 'Audit', 'Av1', 'Av2', 'Av3', 'Sentinel', 'Help'];
    const advocateNames = ['Abuse', 'Av1', 'Av2', 'Av3', 'Help'];
    const payload = concat(
      u32(adminNames.length), ...adminNames.map(string16L),
      u32(archNames.length), ...archNames.map(string16L),
      u32(advocateNames.length), ...advocateNames.map(string16L),
    );
    handler.handleMessage(event(GameEventType.ChannelIndex, payload));
    expect(indexCalls).toHaveLength(1);
    expect(indexCalls[0]).toEqual({ channels: [...adminNames, ...archNames, ...advocateNames] });
  });

  it('ChannelList parses count + N String16L player names', () => {
    const players = ['Asheron', 'Elysa', 'BaelZharon'];
    const payload = concat(u32(players.length), ...players.map(string16L));
    handler.handleMessage(event(GameEventType.ChannelList, payload));
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]).toEqual({ players });
  });

  it('ChannelList handles a zero-count roster (empty channel)', () => {
    handler.handleMessage(event(GameEventType.ChannelList, u32(0)));
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]).toEqual({ players: [] });
  });
});

describe('GetInscriptionResponse cites the ACE "deprecated, no client handler" disposition (GAP.86)', () => {
  it('silently consumes the payload without throwing or dispatching anything', () => {
    const handler = new ServerMessageHandler();
    handler.setHandlers({});
    // Arbitrary bytes shaped like the ACE writer (guid + string16L + guid +
    // string16L + string16L + align) — the point is the client never reads
    // any of it, so the exact shape shouldn't matter.
    const payload = concat(
      u32(0x80001234),
      string16L('An inscription.'),
      u32(0x50001111),
      string16L('Scribe'),
      string16L('scribeaccount'),
    );
    expect(() => {
      handler.handleMessage(event(GameEventType.GetInscriptionResponse, payload));
    }).not.toThrow();
  });
});

describe('AllegianceUpdateDone reads and dispatches the real (uint)errorType payload (BUG.allegiance-update-done-error-dropped)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onAllegianceUpdateDone: (d) => calls.push(d) });
  });

  it('parses the always-None wire shape every stock ACE call site sends', () => {
    handler.handleMessage(event(GameEventType.AllegianceUpdateDone, u32(0)));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ errorType: 0 });
  });

  it('parses a non-zero errorType instead of discarding it (a non-stock server / future ACE build)', () => {
    handler.handleMessage(event(GameEventType.AllegianceUpdateDone, u32(29)));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ errorType: 29 });
  });

  it('does not throw when no handler is registered', () => {
    const bare = new ServerMessageHandler();
    bare.setHandlers({});
    expect(() => {
      bare.handleMessage(event(GameEventType.AllegianceUpdateDone, u32(0)));
    }).not.toThrow();
  });
});

describe('ItemAppraiseDone cites having no ACE.Server writer at all (GAP.86)', () => {
  it('silently consumes an arbitrary payload without throwing or dispatching (non-stock-server robustness)', () => {
    const handler = new ServerMessageHandler();
    handler.setHandlers({});
    expect(() => {
      handler.handleMessage(event(GameEventType.ItemAppraiseDone, u32(0xdeadbeef)));
    }).not.toThrow();
  });
});

describe('FellowshipUpdateDone cites ACE\'s own commented-out writer (GAP.86)', () => {
  it('silently consumes the real zero-length payload without throwing or dispatching', () => {
    const handler = new ServerMessageHandler();
    handler.setHandlers({});
    expect(() => {
      handler.handleMessage(event(GameEventType.FellowshipUpdateDone, new Uint8Array(0)));
    }).not.toThrow();
  });

  it('tolerates an arbitrary non-empty payload too (non-stock-server robustness)', () => {
    const handler = new ServerMessageHandler();
    handler.setHandlers({});
    expect(() => {
      handler.handleMessage(event(GameEventType.FellowshipUpdateDone, u32(0x12345678)));
    }).not.toThrow();
  });
});
