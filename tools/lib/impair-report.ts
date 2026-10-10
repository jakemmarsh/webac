/**
 * impair-report — what each client did on the wire through the impaired relay
 * (HARNESS.retail-under-impairment, tools/probe-retail-impaired.ts).
 *
 * Input: the relay's RELAY_CAPTURE lines. c2s lines are what reached ACE, s2c
 * lines what reached the client (the relay records after the impairment), so
 * a datagram the path lost is absent and each client is judged on what it
 * actually saw. Retail and ours run the same script through the same relay,
 * so their rows compare directly.
 *
 * Per client endpoint:
 *  - session: CharacterEnterWorld (0xF657) → PlayerCreate (0xF746) time,
 *    duration, a Disconnect (PacketHeaderFlags 0x8000) from either side;
 *  - transport: RequestRetransmit (0x1000) packets and the sequences they
 *    named, each direction; packets carrying the Retransmission flag (0x1);
 *    and, client side, how many sequences the server NAKed were sent again
 *    (with or without the flag) and how fast;
 *  - chat delay: a Talk (GameAction 0x0015) reaching ACE to the speaker's own
 *    HearSpeech (0x02BB) of that text reaching the client: ACE's handling plus
 *    the downstream leg, as each client is served (spoken lines only; an
 *    "@" admin command has no speech echo);
 *  - movement: MoveToState / AutonomousPosition sent, and the UpdatePosition
 *    (0xF748) messages for the client's own guid the server sent back.
 *
 * Layouts: ACE PacketHeader.cs, PacketHeaderFlags.cs, GameMessageHearSpeech.cs
 * (String16L = u16 length + cp1252 bytes, padded to 4 with the length),
 * GameActionPacket (0xF7B1, u32 sequence, u32 action).
 */
import { C2SAssembler, type CaptureLine, decodeMessage } from './ac-wire.ts';

const FLAG_RETRANSMISSION = 0x1;
const FLAG_ENCRYPTED_CHECKSUM = 0x2;
const FLAG_REQUEST_RETRANSMIT = 0x1000;
const FLAG_DISCONNECT = 0x8000;
const OP_GAME_ACTION = 0xf7b1;
const ACTION_TALK = 0x0015;
const OP_HEAR_SPEECH = 0x02bb;
const OP_PLAYER_CREATE = 0xf746;
const OP_ENTER_WORLD = 0xf657;
const OP_UPDATE_POSITION = 0xf748;

export interface ChatTiming { text: string; sentAt: number; heardAt?: number; ms?: number }

export interface ClientWireStats {
  client: string;
  firstAt: number; lastAt: number; durationS: number;
  datagrams: { c2s: number; s2c: number };
  /** Packets carrying the Retransmission flag, by sender. */
  retransmitted: { c2s: number; s2c: number };
  /** RequestRetransmit packets and the sequence numbers they asked for, by sender. */
  nak: { c2s: number; c2sSeqs: number; s2c: number; s2cSeqs: number };
  disconnect: { by: 'client' | 'server'; at: number } | null;
  selfGuid: number | null;
  /** CharacterEnterWorld sent → PlayerCreate received. */
  enterWorldMs: number | null;
  /** Server-NAKed client sequences, how many were sent again, and the NAK → resend delays (ms). */
  serverNakAnswered: { asked: number; resent: number; delaysMs: number[] };
  chat: ChatTiming[];
  moveToState: number; autoPos: number;
  /** Server UpdatePosition for the client's own guid. */
  selfPositionUpdates: number;
}

function string16(b: Uint8Array, o: number): { s: string; next: number } | null {
  if (o + 2 > b.length) return null;
  const n = b[o] | (b[o + 1] << 8);
  if (o + 2 + n > b.length) return null;
  const s = Buffer.from(b.subarray(o + 2, o + 2 + n)).toString('latin1');
  const raw = 2 + n;
  return { s, next: o + raw + ((4 - (raw % 4)) % 4) };
}

const u32 = (b: Uint8Array, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** A Talk game action's text, or null. */
export function talkText(msg: Uint8Array): string | null {
  if (msg.length < 14 || u32(msg, 0) !== OP_GAME_ACTION || u32(msg, 8) !== ACTION_TALK) return null;
  return string16(msg, 12)?.s ?? null;
}

/** A HearSpeech's text and sender guid, or null. */
export function hearSpeech(msg: Uint8Array): { text: string; sender: number } | null {
  if (msg.length < 6 || u32(msg, 0) !== OP_HEAR_SPEECH) return null;
  const t = string16(msg, 4);
  if (!t) return null;
  const n = string16(msg, t.next);
  if (!n || n.next + 4 > msg.length) return null;
  return { text: t.s, sender: u32(msg, n.next) };
}

export function summarizeWire(lines: CaptureLine[]): ClientWireStats[] {
  const by = new Map<string, {
    st: ClientWireStats; up: C2SAssembler; down: C2SAssembler; enterAt: number | null;
    pendingChat: Map<string, ChatTiming[]>;
    /** client sequence the server NAKed → when (first NAK), until it is seen again */
    naked: Map<number, number>;
  }>();
  for (const l of [...lines].sort((a, b) => a.t - b.t)) {
    let e = by.get(l.c);
    if (!e) {
      e = {
        st: {
          client: l.c, firstAt: l.t, lastAt: l.t, durationS: 0, datagrams: { c2s: 0, s2c: 0 }, retransmitted: { c2s: 0, s2c: 0 },
          nak: { c2s: 0, c2sSeqs: 0, s2c: 0, s2cSeqs: 0 }, disconnect: null, selfGuid: null, enterWorldMs: null,
          serverNakAnswered: { asked: 0, resent: 0, delaysMs: [] }, chat: [],
          moveToState: 0, autoPos: 0, selfPositionUpdates: 0,
        },
        up: new C2SAssembler('c2s'), down: new C2SAssembler('s2c'), enterAt: null, pendingChat: new Map(), naked: new Map(),
      };
      by.set(l.c, e);
    }
    const st = e.st;
    st.lastAt = l.t;
    const buf = new Uint8Array(Buffer.from(l.b, 'base64'));
    st.datagrams[l.d]++;
    if (buf.length < 20) continue;
    const flags = u32(buf, 4);
    if (flags & FLAG_RETRANSMISSION) st.retransmitted[l.d]++;
    const seq = u32(buf, 0);
    if (flags & FLAG_REQUEST_RETRANSMIT) {
      // c2s: the first optional header after ServerSwitch (8 bytes) — ACE
      // PacketHeaderOptional.Unpack; s2c: after Ack/TimeSync/Echo/Flow.
      const o = optionalOffset(flags, l.d);
      const n = o + 4 <= buf.length ? Math.min(u32(buf, o), Math.floor((buf.length - o - 4) / 4)) : 0;
      if (l.d === 'c2s') { st.nak.c2s++; st.nak.c2sSeqs += n; } else {
        st.nak.s2c++; st.nak.s2cSeqs += n;
        for (let i = 0; i < n; i++) {
          const asked = u32(buf, o + 4 + 4 * i);
          if (!e.naked.has(asked)) { e.naked.set(asked, l.t); st.serverNakAnswered.asked++; }
        }
      }
    }
    // An encrypted-checksum client packet with a sequence the server NAKed is
    // its resend. Cleartext control packets (ACK / NAK, no 0x2) carry seq 0 or
    // the last real sequence and are not.
    if (l.d === 'c2s' && seq !== 0 && (flags & FLAG_ENCRYPTED_CHECKSUM) && e.naked.has(seq)) {
      st.serverNakAnswered.resent++;
      st.serverNakAnswered.delaysMs.push(l.t - e.naked.get(seq)!);
      e.naked.delete(seq);
    }
    if ((flags & FLAG_DISCONNECT) && !st.disconnect) st.disconnect = { by: l.d === 'c2s' ? 'client' : 'server', at: l.t };
    const msgs = (l.d === 'c2s' ? e.up : e.down).push(buf);
    for (const m of msgs) {
      if (l.d === 'c2s') {
        if (m.length >= 4 && u32(m, 0) === OP_ENTER_WORLD && e.enterAt === null) e.enterAt = l.t;
        const text = talkText(m);
        if (text !== null && text.startsWith('@')) continue;
        if (text !== null) {
          const c: ChatTiming = { text, sentAt: l.t };
          st.chat.push(c);
          const q = e.pendingChat.get(text) ?? [];
          q.push(c);
          e.pendingChat.set(text, q);
          continue;
        }
        const a = decodeMessage(m);
        if (a?.kind === 'moveToState') st.moveToState++;
        else if (a?.kind === 'autoPos') st.autoPos++;
      } else {
        const op = m.length >= 4 ? u32(m, 0) : 0;
        if (op === OP_PLAYER_CREATE && m.length >= 8 && st.selfGuid === null) {
          st.selfGuid = u32(m, 4);
          if (e.enterAt !== null) st.enterWorldMs = l.t - e.enterAt;
        } else if (op === OP_UPDATE_POSITION && m.length >= 8 && st.selfGuid !== null && u32(m, 4) === st.selfGuid) {
          st.selfPositionUpdates++;
        } else {
          const h = hearSpeech(m);
          if (h && st.selfGuid !== null && h.sender === st.selfGuid) {
            const c = e.pendingChat.get(h.text)?.shift();
            if (c) { c.heardAt = l.t; c.ms = l.t - c.sentAt; }
          }
        }
      }
    }
  }
  return [...by.values()].map((e) => ({ ...e.st, durationS: Math.round((e.st.lastAt - e.st.firstAt) / 100) / 10 }));
}

/** Byte offset of the RequestRetransmit optional header (ACE read/write order, as C2SAssembler). */
function optionalOffset(flags: number, d: 'c2s' | 's2c'): number {
  let o = 20;
  if (d === 'c2s') {
    if (flags & 0x100) o += 8; // ServerSwitch
    return o;
  }
  if (flags & 0x4000) o += 4; // AckSequence
  if (flags & 0x1000000) o += 8; // TimeSync
  if (flags & 0x2000000) o += 4; // EchoRequest
  if (flags & 0x8000000) o += 6; // Flow
  return o;
}

/** Median / p90 / max of the measured chat delays, ms. */
export function chatDelay(st: ClientWireStats): { n: number; lost: number; median: number | null; p90: number | null; max: number | null } {
  const ms = st.chat.map((c) => c.ms).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
  const q = (p: number): number | null => (ms.length ? ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] : null);
  return { n: ms.length, lost: st.chat.length - ms.length, median: q(0.5), p90: q(0.9), max: ms.length ? ms[ms.length - 1] : null };
}
