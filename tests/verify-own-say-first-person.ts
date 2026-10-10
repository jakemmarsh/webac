/**
 * BUG.own-say-rendered-third-person — own /say and cast words render
 * first-person: retail 'You say, "%s"' (demangled.txt:19347), not
 * '%s says, "%s"' (demangled.txt:19365).
 *
 * Retail's ClientCommunicationSystem::Handle_Communication__HearSpeech
 * (acclient @ 005712a0) checks sender==smartbox->player_id before anything
 * else and takes a dedicated AddTextToScroll path with the 'You say' format.
 * ACE never sends a pre-formatted self line — the only echo of your own /say
 * (Player.cs HandleActionTalk) and cast incantations (Player_Magic.cs
 * DoSpellWords, ChatMessageType.Spellcasting) is the self-inclusive
 * HearSpeech broadcast — so first-person formatting is client-side, keyed
 * purely on the sender guid (not the chat type).
 *
 * Behavioral: drives the real HearSpeech wire parser with bytes, then the
 * real formatter with the parsed sender guid, exactly as main.ts's
 * onHearSpeech non-emote branch does.
 */
import { describe, it, expect } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { formatSpeechLine } from '../packages/renderer/src/chat/SpeechLine.js';
import { GameMessageOpcode } from '@ac/network';
import type { HearSpeechData } from '../packages/renderer/src/network/ServerMessageHandler.js';

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

const PLAYER_GUID = 0x50000abc;
const OTHER_GUID = 0x50000def;

/** Parse a HearSpeech wire payload through the real ServerMessageHandler. */
function hearSpeech(message: string, senderName: string, senderGuid: number, chatType: number): HearSpeechData {
  const events: HearSpeechData[] = [];
  const handler = new ServerMessageHandler();
  handler.setHandlers({ onHearSpeech: d => events.push(d) });
  handler.handleMessage({
    type: 'direct',
    opcode: GameMessageOpcode.HearSpeech,
    payload: concat(string16L(message), string16L(senderName), u32(senderGuid), u32(chatType)),
  } as any);
  expect(events).toHaveLength(1);
  return events[0];
}

/** The main.ts onHearSpeech non-emote branch: format keyed on parsed guid. */
function renderLine(d: HearSpeechData, myGuid: number): string {
  return formatSpeechLine(d.senderName, d.message, d.senderGuid === myGuid);
}

describe('own speech renders first-person (BUG.own-say-rendered-third-person)', () => {
  it("own /say echo renders retail 'You say, \"...\"'", () => {
    const d = hearSpeech('hello Dereth', 'Zorbo', PLAYER_GUID, 0x02 /* Speech */);
    expect(renderLine(d, PLAYER_GUID)).toBe('You say, "hello Dereth"');
  });

  it("another player's speech keeps the third-person 'Name says' format", () => {
    const d = hearSpeech('hail!', 'Bob', OTHER_GUID, 0x02);
    expect(renderLine(d, PLAYER_GUID)).toBe('Bob says, "hail!"');
  });

  it('own cast incantation (Spellcasting) also renders first-person — keyed on guid, not chatType', () => {
    const d = hearSpeech('Zojak Quareth', 'Zorbo', PLAYER_GUID, 0x11 /* Spellcasting */);
    expect(renderLine(d, PLAYER_GUID)).toBe('You say, "Zojak Quareth"');
  });

  it("another caster's incantation stays third-person", () => {
    const d = hearSpeech('Malar Quareth', 'Enemy Mage', OTHER_GUID, 0x11);
    expect(renderLine(d, PLAYER_GUID)).toBe('Enemy Mage says, "Malar Quareth"');
  });

  it('a same-named other player (different guid) is NOT treated as self', () => {
    // Retail keys on guid alone — a doppelgänger name must not trigger 'You say'.
    const d = hearSpeech('imposter!', 'Zorbo', OTHER_GUID, 0x02);
    expect(renderLine(d, PLAYER_GUID)).toBe('Zorbo says, "imposter!"');
  });
});

/**
 * SWEEP1006 npc-say — an NPC's Say emote (ACE EmoteManager.cs:1127/1129
 * sends HearSpeech / HearRangedSpeech with chat type Emote) reads
 * 'X says, "…"': retail Handle_Communication__HearSpeech @ 005712a0 and
 * HandleRangedTalkEvent @ 00589f60 have no chat-type branch (the binary's
 * only speech formats are '%s says, "%s"' and the tell-link form).
 */
describe('an NPC Say line (chat type Emote) still says', () => {
  it('formats the Town Crier like any speaker', () => {
    expect(formatSpeechLine('Town Crier', 'Welcome to Holtburg!', false)).toBe('Town Crier says, "Welcome to Holtburg!"');
  });
});
