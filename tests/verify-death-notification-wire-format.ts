/**
 * FAITHFUL.333 — Align death-event wire-format parsers with ACE source.
 *
 * Three handlers in `packages/renderer/src/network/ServerMessageHandler.ts`
 * were reading non-existent fields past the end of the payload:
 *
 * 1. `GameEventVictimNotification` (event 0x01AC) — read `message + bogus
 *    killerGuid`. Per ACE `GameEventVictimNotification.cs:9-12` the wire is
 *    JUST `WriteString16L(deathMessage)`. The extra `r.readUInt32()` ran
 *    past the end and either threw RangeError or pulled junk bytes from
 *    fragment padding.
 *
 * 2. `GameEventKillerNotification` (event 0x01AD) — read `message + bogus
 *    victimGuid + bogus xpGranted`. Per ACE `GameEventKillerNotification.cs:9-12`
 *    the wire is JUST the message. The xpGranted field then caused main.ts
 *    to emit a phantom "You've earned N experience points." chat line from
 *    garbage data. (Real XP-on-kill chat already arrives via separate
 *    GameMessageSystemChat with ChatMessageType.Advancement.)
 *
 * 3. `GameMessagePlayerKilled` (direct 0x019E) — read `message + 1 guid`
 *    mislabeled `killerGuid`. Per ACE `GameMessagePlayerKilled.cs:11-13`
 *    the wire is `WriteString16L(deathMessage) + WriteGuid(victimId) +
 *    WriteGuid(killerId)` — the ACTUAL killer guid was silently dropped.
 *
 * This test pins every handler to its ACE wire-format truth + verifies the
 * consumer side no longer emits the phantom xpGranted chat line.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { playerKilledLine } from '../packages/renderer/src/ui/ServerMessageText.js';
import { GameEventType, GameMessageOpcode } from '@ac/network';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');
const HANDLER = readFileSync(resolve(REPO, 'packages/renderer/src/network/ServerMessageHandler.ts'), 'utf8');

// Pack ACE WriteString16L: u16 length + Windows-1252 bytes + 4-byte align.
function string16L(s: string): Uint8Array {
  const ascii = Array.from(s, c => c.charCodeAt(0));
  const total = 2 + ascii.length;
  const padded = (4 - (total % 4)) % 4;
  const out = new Uint8Array(total + padded);
  out[0] = ascii.length & 0xff;
  out[1] = (ascii.length >> 8) & 0xff;
  for (let i = 0; i < ascii.length; i++) out[2 + i] = ascii[i];
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

describe('VictimNotification wire-format (FAITHFUL.333)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({
      onVictimNotification: (data) => calls.push(data),
    });
  });

  it('parses payload of exactly string16 + alignment (no trailing fields)', () => {
    const msg = 'You have been slashed to death by Tumerok Brigand.';
    const payload = string16L(msg);
    handler.handleMessage({
      type: 'event',
      opcode: GameMessageOpcode.GameEvent,
      sequence: 1,
      eventType: GameEventType.VictimNotification,
      objectGuid: 0,
      payload,
    } as any);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ message: msg });
  });

  it('does NOT throw RangeError when payload contains only the string', () => {
    // Pre-fix this payload would trigger `r.readUInt32()` past end → throw.
    const payload = string16L('X is dead.');
    expect(() => {
      handler.handleMessage({
        type: 'event',
        opcode: GameMessageOpcode.GameEvent,
        sequence: 1,
        eventType: GameEventType.VictimNotification,
        objectGuid: 0,
        payload,
      } as any);
    }).not.toThrow();
  });
});

describe('KillerNotification wire-format (FAITHFUL.333)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({
      onKillerNotification: (data) => calls.push(data),
    });
  });

  it('parses payload of exactly string16 + alignment (no trailing fields)', () => {
    const msg = 'You have slain Olthoi Ripper.';
    handler.handleMessage({
      type: 'event',
      opcode: GameMessageOpcode.GameEvent,
      sequence: 2,
      eventType: GameEventType.KillerNotification,
      objectGuid: 0,
      payload: string16L(msg),
    } as any);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ message: msg });
  });

  it('main.ts no longer emits the phantom "You\'ve earned N experience points" line', () => {
    // Strip line comments + block comments so the docblock that explains
    // the fix doesn't poison the check.
    const stripped = MAIN
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(stripped).not.toContain("You've earned");
    expect(stripped).not.toContain('data.xpGranted');
  });
});

describe('PlayerKilled wire-format — message + victimGuid + killerGuid (FAITHFUL.333)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({
      onPlayerKilled: (data) => calls.push(data),
    });
  });

  it('reads BOTH victim and killer guids per GameMessagePlayerKilled.cs:11-13', () => {
    const msg = 'Bob has been slain by Tumerok Brigand.';
    const VICTIM = 0x50000042;
    const KILLER = 0x80000777;
    const payload = concat(string16L(msg), u32(VICTIM), u32(KILLER));
    handler.handleMessage({
      type: 'direct',
      opcode: GameMessageOpcode.PlayerKilled,
      payload,
    } as any);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ message: msg, victimGuid: VICTIM, killerGuid: KILLER });
  });

  it('main.ts has an onPlayerKilled handler separate from onVictimNotification', () => {
    // The broadcast PlayerKilled must NOT route through onVictimNotification
    // — otherwise we'd duplicate the chat line whenever the local player
    // dies (PlayerKilled is broadcast to all observers including the victim).
    expect(MAIN).toMatch(/onPlayerKilled:\s*\(data\)\s*=>/);
  });

  it('the broadcast copy is dropped when we are the victim OR the killer (HandlePlayerDeathEvent @ 0056c320)', () => {
    // The whole point of having a separate handler is to skip the broadcast
    // emit when the local player already got the private Victim / Killer
    // notification (DECOMP.kill-death-chat-lines: the killer too).
    const me = 0x50000001;
    expect(playerKilledLine('x', me, 0x80000002, me)).toBeNull();
    expect(playerKilledLine('x', 0x50000009, me, me)).toBeNull();
    expect(playerKilledLine('x', 0x50000009, 0x80000002, me)).toEqual({ text: 'x', type: 0 });
  });
});

describe('ServerMessageHandler.ts cites the authoritative sources (FAITHFUL.333)', () => {
  it('VictimNotification case cites ACE wire-format file', () => {
    expect(HANDLER).toMatch(/VictimNotification[\s\S]*?GameEventVictimNotification\.cs/);
  });

  it('KillerNotification case cites ACE wire-format file', () => {
    expect(HANDLER).toMatch(/KillerNotification[\s\S]*?GameEventKillerNotification\.cs/);
  });

  it('PlayerKilled case cites ACE wire-format file', () => {
    expect(HANDLER).toMatch(/PlayerKilled[\s\S]*?GameMessagePlayerKilled\.cs/);
  });
});
