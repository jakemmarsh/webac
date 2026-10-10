/**
 * The 1999 ⇄ end-of-retail message adapter (docs/ac1999-support-scope.md
 * Phase 4). Connection1999 hands every whole 1999 message to `inbound`, which
 * returns the end-of-retail messages our ServerMessageHandler already parses;
 * every message the client sends goes through `outbound`, which returns the
 * 1999 messages (and queue group) to put on the wire, or null when 1999 has no
 * counterpart (the feature didn't exist yet; the caller drops it).
 *
 * Each codec is a pure function over bytes, registered per opcode (and per
 * inner GameEvent / GameAction type). Layouts come from the real client's
 * captures first, the AC1999 server's writers and readers second, the KB
 * third (docs/ac1999-support.md, "source order").
 *
 * Unknown inbound messages are dropped (logged once each), never passed on
 * half-understood: an end-of-retail parser fed a 1999 layout would misread it.
 */
import { BinaryWriter } from '../MessageSerializer.js';
import { Reader1999 } from './Wire1999.js';
import { ABSENT_1999, absent1999FeatureOfAction, absent1999FeatureOfOpcode } from './Absent1999.js';

/** 1999 queue groups: server 3 = objects, 4 = private / events, 7 = DAT sync; client 5 = game actions, 6 = login / char select. */
export const Group1999 = { Object: 3, Private: 4, Ddd: 7, ClientAction: 5, ClientLogin: 6 } as const;

export interface Outbound1999 { message: Uint8Array; group: number }

export interface AdapterContext {
  /** The account name the session logged in with (1999 messages carry it as a fixed blob). */
  account: string;
  /** Log a translation note (once per kind is up to the caller). */
  log(msg: string): void;
}

/** An inbound codec: the whole 1999 message (reader positioned after the opcode) → end-of-retail messages. */
export type InboundCodec = (r: Reader1999, ctx: AdapterContext, raw: Uint8Array) => Uint8Array[];
/** An outbound codec: the whole end-of-retail message → 1999 messages, or null when 1999 has no counterpart. */
export type OutboundCodec = (eol: Uint8Array, ctx: AdapterContext) => Outbound1999[] | null;

export interface Codecs1999 {
  /** By 1999 opcode (direct messages). */
  inbound: Map<number, InboundCodec>;
  /** By inner event type, for 1999 messages the server wraps in 0xF7B0 (guid, sequence, type, payload). */
  inboundEvent: Map<number, InboundCodec>;
  /** By end-of-retail opcode (direct messages the client builds). */
  outbound: Map<number, OutboundCodec>;
  /** By end-of-retail GameAction type (inside 0xF7B1). */
  outboundAction: Map<number, OutboundCodec>;
  /**
   * Runs over each translated inbound message's end-of-retail output, where the 1999 server's
   * message ORDER differs from end of retail's (ContainOrder1999: a 0x22 sent before its item's
   * CreateObject). May hold messages back and release them with a later call's output.
   */
  inboundOrder?: (out: Uint8Array[], ctx: AdapterContext) => Uint8Array[];
}

export function emptyCodecs(): Codecs1999 {
  return { inbound: new Map(), inboundEvent: new Map(), outbound: new Map(), outboundAction: new Map() };
}

/** End-of-retail message builder: opcode + body. */
export function eol(opcode: number, build?: (w: BinaryWriter) => void): Uint8Array {
  const w = new BinaryWriter(64);
  w.writeUInt32(opcode);
  build?.(w);
  return w.toBuffer();
}

export class Adapter1999 {
  private readonly warned = new Set<string>();
  readonly unknownInbound = new Map<string, number>();

  constructor(private readonly codecs: Codecs1999, private readonly ctx: AdapterContext) {}

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.ctx.log(msg);
  }

  inbound(message: Uint8Array, group: number): Uint8Array[] {
    if (message.length < 4) return [];
    const r = new Reader1999(message);
    const opcode = r.u32();
    let codec = this.codecs.inbound.get(opcode);
    let key = `0x${opcode.toString(16)}`;
    if (opcode === 0xf7b0 && message.length >= 16) {
      const type = new DataView(message.buffer, message.byteOffset).getUint32(12, true);
      codec = this.codecs.inboundEvent.get(type);
      key = `0xf7b0/0x${type.toString(16)}`;
    }
    if (!codec) {
      this.unknownInbound.set(key, (this.unknownInbound.get(key) ?? 0) + 1);
      this.warnOnce(`in:${key}`, `[1999] no codec for inbound ${key} (group ${group}, ${message.length} bytes); dropped`);
      return [];
    }
    let out: Uint8Array[];
    try {
      out = codec(r, this.ctx, message);
    } catch (err) {
      this.warnOnce(`inerr:${key}`, `[1999] inbound ${key} failed to translate: ${(err as Error).message}`);
      out = [];
    }
    return this.codecs.inboundOrder ? this.codecs.inboundOrder(out, this.ctx) : out;
  }

  /** The 1999 messages for one end-of-retail message, or null when 1999 has no counterpart. */
  outbound(eolMessage: Uint8Array): Outbound1999[] | null {
    if (eolMessage.length < 4) return null;
    const v = new DataView(eolMessage.buffer, eolMessage.byteOffset, eolMessage.byteLength);
    const opcode = v.getUint32(0, true);
    let codec = this.codecs.outbound.get(opcode);
    let key = `0x${opcode.toString(16)}`;
    let absent = absent1999FeatureOfOpcode(opcode);
    if (opcode === 0xf7b1 && eolMessage.length >= 12) {
      const action = v.getUint32(8, true);
      codec = this.codecs.outboundAction.get(action);
      key = `0xf7b1/0x${action.toString(16)}`;
      absent = absent1999FeatureOfAction(action);
    }
    if (!codec) {
      // A feature the 1999 client lacked (Absent1999.ts) is named; the
      // interface hides its controls, so reaching here is a missed gate.
      const why = absent ? ` (${ABSENT_1999[absent].note}: not in the 1999 game)` : '';
      this.warnOnce(`out:${key}`, `[1999] ${key} has no 1999 counterpart${why}; not sent`);
      return null;
    }
    try {
      return codec(eolMessage, this.ctx);
    } catch (err) {
      this.warnOnce(`outerr:${key}`, `[1999] outbound ${key} failed to translate: ${(err as Error).message}`);
      return null;
    }
  }
}
