/**
 * ac-wire — decode what a client sends ACE: client→server datagrams (as
 * captured by tools/retail-client-udp-relay.mjs RELAY_CAPTURE) into the
 * movement game actions ACE acts on.
 *
 * Layouts follow ACE's readers, not our serializer, so the same decoder judges
 * the retail client and ours:
 *  - packet header + optional headers: ACE.Server/Network/PacketHeader.cs,
 *    PacketHeaderOptional.cs (field order below), fragments: PacketFragmentHeader.cs;
 *  - MoveToState 0xF61C: Motion/MoveToState.cs + RawMotionState.cs + MotionItem.cs;
 *  - AutonomousPosition 0xF753: GameActionAutonomousPosition.cs;
 *  - Jump 0xF61B: GameActionJump.cs + Structure/JumpPack.cs;
 *  - CastUntargetedSpell 0x0048 / CastTargetedSpell 0x004A.
 */

export interface WirePosition { cell: number; x: number; y: number; z: number; rw: number; rx: number; ry: number; rz: number }

/** RawMotionState as ACE reads it; absent fields stay undefined (RawMotionFlags gating). */
export interface RawMotion {
  flags: number;
  holdKey?: number; style?: number;
  forward?: number; forwardHold?: number; forwardSpeed?: number;
  sidestep?: number; sidestepHold?: number; sidestepSpeed?: number;
  turn?: number; turnHold?: number; turnSpeed?: number;
  commands: Array<{ command: number; seq: number; speed: number }>;
}

export type WireAction =
  | { kind: 'moveToState'; seq: number; raw: RawMotion; pos: WirePosition; seqs: number[]; contactLongJump: number; bytes: string }
  | { kind: 'autoPos'; seq: number; pos: WirePosition; seqs: number[]; contact: number }
  | { kind: 'jump'; seq: number; extent: number; vx: number; vy: number; vz: number; seqs: number[] }
  | { kind: 'cast'; seq: number; targeted: boolean; target: number; spell: number }
  | { kind: 'attack'; seq: number; missile: boolean; target: number; height: number; power: number }
  | { kind: 'cancelAttack'; seq: number }
  | { kind: 'other'; seq: number; type: number };

export interface CaptureLine { t: number; d: 'c2s' | 's2c'; c: string; p: number; b: string }

const F = {
  ServerSwitch: 0x100, RequestRetransmit: 0x1000, RejectRetransmit: 0x2000, AckSequence: 0x4000,
  LoginRequest: 0x10000, WorldLoginRequest: 0x20000, ConnectResponse: 0x80000, CICMDCommand: 0x400000,
  TimeSync: 0x1000000, EchoRequest: 0x2000000, EchoResponse: 0x4000000, Flow: 0x8000000, BlobFragments: 0x4,
  ConnectRequest: 0x40000,
} as const;

/**
 * One datagram → its complete fragment payloads (single- and multi-part, keyed
 * by the fragment Sequence the parts of one message share — ACE
 * NetworkSession's partialFragments key; the server gives every fragment
 * Id 0x80000000, so keying by Id spliced different messages together).
 * Client→server optional headers in ACE's read order
 * (PacketHeaderOptional.Unpack); server→client in ACE's write order
 * (NetworkSession.WriteOptionalHeaders, as our ClientConnection reads them).
 * A fragment seen before (a retransmission) is dropped.
 */
export class C2SAssembler {
  private partial = new Map<number, { count: number; parts: Map<number, Uint8Array> }>();
  private seen = new Set<string>();
  constructor(private dir: 'c2s' | 's2c' = 'c2s') {}

  push(buf: Uint8Array): Uint8Array[] {
    if (buf.length < 20) return [];
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const flags = v.getUint32(4, true);
    if (flags & (F.LoginRequest | F.WorldLoginRequest | F.ConnectResponse | F.ConnectRequest)) return [];
    if (!(flags & F.BlobFragments)) return [];
    let o = 20;
    if (this.dir === 'c2s') {
      if (flags & F.ServerSwitch) o += 8;
      if (flags & F.RequestRetransmit) o += 4 + 4 * v.getUint32(o, true);
      if (flags & F.RejectRetransmit) o += 4 + 4 * v.getUint32(o, true);
      if (flags & F.AckSequence) o += 4;
      if (flags & F.CICMDCommand) o += 8;
      if (flags & F.TimeSync) o += 8;
      if (flags & F.EchoRequest) o += 4;
      if (flags & F.Flow) o += 6;
    } else {
      if (flags & F.AckSequence) o += 4;
      if (flags & F.TimeSync) o += 8;
      if (flags & F.EchoRequest) o += 4;
      if (flags & F.Flow) o += 6;
      if (flags & F.RequestRetransmit) o += 4 + 4 * v.getUint32(o, true);
      if (flags & F.RejectRetransmit) o += 4 + 4 * v.getUint32(o, true);
      if (flags & F.EchoResponse) o += 8;
      if (flags & F.ServerSwitch) o += 8;
    }
    const out: Uint8Array[] = [];
    while (o + 16 <= buf.length) {
      const fseq = v.getUint32(o, true);
      const id = v.getUint32(o + 4, true);
      const count = v.getUint16(o + 8, true);
      const size = v.getUint16(o + 10, true);
      const index = v.getUint16(o + 12, true);
      if (size < 16 || o + size > buf.length) break;
      const data = buf.subarray(o + 16, o + size);
      o += size;
      const key = `${fseq}:${id}:${index}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      if (count <= 1) { out.push(data); continue; }
      let p = this.partial.get(fseq);
      if (!p) { p = { count, parts: new Map() }; this.partial.set(fseq, p); }
      p.parts.set(index, data);
      if (p.parts.size === p.count) {
        const chunks = [...p.parts.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
        const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let w = 0; for (const c of chunks) { all.set(c, w); w += c.length; }
        out.push(all);
        this.partial.delete(fseq);
      }
    }
    return out;
  }
}

class R {
  o = 0;
  v: DataView;
  constructor(public b: Uint8Array) { this.v = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  u8() { return this.v.getUint8(this.o++); }
  u16() { const x = this.v.getUint16(this.o, true); this.o += 2; return x; }
  u32() { const x = this.v.getUint32(this.o, true); this.o += 4; return x; }
  f32() { const x = this.v.getFloat32(this.o, true); this.o += 4; return x; }
}

function readPos(r: R): WirePosition {
  return { cell: r.u32(), x: r.f32(), y: r.f32(), z: r.f32(), rw: r.f32(), rx: r.f32(), ry: r.f32(), rz: r.f32() };
}

/** RawMotionState::Unpack as ACE reads it (RawMotionState.cs). */
export function readRawMotion(r: R): RawMotion {
  const packed = r.u32();
  const flags = packed & 0x7ff;
  const n = packed >>> 11;
  const m: RawMotion = { flags, commands: [] };
  if (flags & 0x1) m.holdKey = r.u32();
  if (flags & 0x2) m.style = r.u32();
  if (flags & 0x4) m.forward = r.u32();
  if (flags & 0x8) m.forwardHold = r.u32();
  if (flags & 0x10) m.forwardSpeed = r.f32();
  if (flags & 0x20) m.sidestep = r.u32();
  if (flags & 0x40) m.sidestepHold = r.u32();
  if (flags & 0x80) m.sidestepSpeed = r.f32();
  if (flags & 0x100) m.turn = r.u32();
  if (flags & 0x200) m.turnHold = r.u32();
  if (flags & 0x400) m.turnSpeed = r.f32();
  for (let i = 0; i < n; i++) m.commands.push({ command: r.u16(), seq: r.u16(), speed: r.f32() });
  return m;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** One complete message → a game action (null for non-GameAction messages). */
export function decodeMessage(msg: Uint8Array): WireAction | null {
  if (msg.length < 12) return null;
  const r = new R(msg);
  if (r.u32() !== 0xf7b1) return null;
  const seq = r.u32();
  const type = r.u32();
  try {
    switch (type) {
      case 0xf61c: {
        const start = r.o;
        const raw = readRawMotion(r);
        const rawEnd = r.o;
        const pos = readPos(r);
        const seqs = [r.u16(), r.u16(), r.u16(), r.u16()];
        const contactLongJump = r.u8();
        return { kind: 'moveToState', seq, raw, pos, seqs, contactLongJump, bytes: hex(msg.subarray(start, rawEnd)) };
      }
      case 0xf753: {
        const pos = readPos(r);
        const seqs = [r.u16(), r.u16(), r.u16(), r.u16()];
        return { kind: 'autoPos', seq, pos, seqs, contact: r.u8() };
      }
      case 0xf61b: {
        const extent = r.f32(); const vx = r.f32(), vy = r.f32(), vz = r.f32();
        return { kind: 'jump', seq, extent, vx, vy, vz, seqs: [r.u16(), r.u16(), r.u16(), r.u16()] };
      }
      case 0x0008: { const target = r.u32(); const height = r.u32(); return { kind: 'attack', seq, missile: false, target, height, power: r.f32() }; }
      case 0x000a: { const target = r.u32(); const height = r.u32(); return { kind: 'attack', seq, missile: true, target, height, power: r.f32() }; }
      case 0x01b7: return { kind: 'cancelAttack', seq };
      case 0x0048: return { kind: 'cast', seq, targeted: false, target: 0, spell: r.u32() };
      case 0x004a: { const target = r.u32(); return { kind: 'cast', seq, targeted: true, target, spell: r.u32() }; }
      default: return { kind: 'other', seq, type };
    }
  } catch {
    return { kind: 'other', seq, type };
  }
}

export interface TimedAction { t: number; client: string; a: WireAction }

/** What ACE tells a client in text: system chat 0xF7E0 and WeenieError(WithString) game events. */
export interface ServerText { t: number; client: string; text: string; error?: number }

function pstring16(r: R): string {
  const n = r.u16();
  const s = Buffer.from(r.b.subarray(r.o, r.o + n)).toString('latin1');
  r.o += n;
  return s;
}

export function decodeServerText(msg: Uint8Array): { text: string; error?: number } | null {
  if (msg.length < 8) return null;
  const r = new R(msg);
  const op = r.u32();
  try {
    if (op === 0xf7e0) return { text: pstring16(r) };
    if (op === 0xf7b0) {
      r.u32(); r.u32();
      const ev = r.u32();
      if (ev === 0x028a) { const e = r.u32(); return { text: `WeenieError 0x${e.toString(16)}`, error: e }; }
      if (ev === 0x028b) { const e = r.u32(); return { text: `WeenieError 0x${e.toString(16)}: ${pstring16(r)}`, error: e }; }
    }
  } catch { /* truncated */ }
  return null;
}

export function decodeServerTexts(lines: CaptureLine[]): ServerText[] {
  const asm = new Map<string, C2SAssembler>();
  const out: ServerText[] = [];
  for (const l of lines) {
    if (l.d !== 's2c') continue;
    let a = asm.get(l.c);
    if (!a) { a = new C2SAssembler('s2c'); asm.set(l.c, a); }
    for (const m of a.push(new Uint8Array(Buffer.from(l.b, 'base64')))) {
      const x = decodeServerText(m);
      if (x) out.push({ t: l.t, client: l.c, ...x });
    }
  }
  return out;
}

/** A server UpdateMotion (0xF74C) for some object, as the receiving client got it. */
export interface ServerMotion {
  t: number; client: string; guid: number; autonomous: boolean; movementType: number;
  style: number; forward: number; forwardSpeed: number; sidestep: number; turn: number;
  /** The commands list (actions: windups, gestures, swings) as wire indices. */
  actions: { command: number; speed: number }[];
}

/** Every 0xF74C the server sent, per receiving client (parseMovementData from @ac/network). */
export async function decodeServerMotions(lines: CaptureLine[]): Promise<ServerMotion[]> {
  const { parseMovementData } = await import('@ac/network');
  const asm = new Map<string, C2SAssembler>();
  const out: ServerMotion[] = [];
  for (const l of lines) {
    if (l.d !== 's2c') continue;
    let a = asm.get(l.c);
    if (!a) { a = new C2SAssembler('s2c'); asm.set(l.c, a); }
    for (const m of a.push(new Uint8Array(Buffer.from(l.b, 'base64')))) {
      if (m.length < 14) continue;
      const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
      if (dv.getUint32(0, true) !== 0xf74c) continue;
      const guid = dv.getUint32(4, true);
      const p = parseMovementData(m.subarray(10), true);
      if (!p) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const acts = ((p as any).actions ?? []) as { command: number; speed: number }[];
      out.push({ t: l.t, client: l.c, guid, autonomous: p.autonomous, movementType: p.movementType, style: p.styleIndex,
        forward: p.forwardCommand, forwardSpeed: p.forwardSpeed, sidestep: p.sidestepCommand, turn: p.turnCommand,
        actions: acts.map((x) => ({ command: x.command, speed: x.speed })) });
    }
  }
  return out;
}

/** A server object's PhysicsState as a client got it: CreateObject (0xF745) or SetState (0xF74B). */
export interface ServerObjectState { t: number; client: string; guid: number; state: number }

/**
 * Every object PhysicsState the server sent, per receiving client. A door the
 * server holds open is Ethereal (0x4) until its ResetInterval closes it (ACE
 * Door.Reset); the retail recordings ran past doors in either state.
 */
export async function decodeServerObjectStates(lines: CaptureLine[]): Promise<ServerObjectState[]> {
  const { parseCreateObject } = await import('@ac/network');
  const asm = new Map<string, C2SAssembler>();
  const out: ServerObjectState[] = [];
  for (const l of lines) {
    if (l.d !== 's2c') continue;
    let a = asm.get(l.c);
    if (!a) { a = new C2SAssembler('s2c'); asm.set(l.c, a); }
    for (const m of a.push(new Uint8Array(Buffer.from(l.b, 'base64')))) {
      if (m.length < 12) continue;
      const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
      const op = dv.getUint32(0, true);
      if (op === 0xf74b) out.push({ t: l.t, client: l.c, guid: dv.getUint32(4, true), state: dv.getUint32(8, true) });
      else if (op === 0xf745) {
        const c = parseCreateObject(m.subarray(4));
        if (c) out.push({ t: l.t, client: l.c, guid: c.guid, state: c.physicsState });
      }
    }
  }
  return out;
}

/** The combat game events a client got: AttackDone (0x01A7, its WeenieError) and CombatCommenceAttack (0x01B8). */
export interface ServerCombatEvent { t: number; client: string; event: 'attackDone' | 'commenceAttack'; code: number }

export function decodeServerCombatEvents(lines: CaptureLine[]): ServerCombatEvent[] {
  const asm = new Map<string, C2SAssembler>();
  const out: ServerCombatEvent[] = [];
  for (const l of lines) {
    if (l.d !== 's2c') continue;
    let a = asm.get(l.c);
    if (!a) { a = new C2SAssembler('s2c'); asm.set(l.c, a); }
    for (const m of a.push(new Uint8Array(Buffer.from(l.b, 'base64')))) {
      if (m.length < 16) continue;
      const dv = new DataView(m.buffer, m.byteOffset, m.byteLength);
      if (dv.getUint32(0, true) !== 0xf7b0) continue;
      const ev = dv.getUint32(12, true);
      if (ev === 0x01a7) out.push({ t: l.t, client: l.c, event: 'attackDone', code: m.length >= 20 ? dv.getUint32(16, true) : 0 });
      else if (ev === 0x01b8) out.push({ t: l.t, client: l.c, event: 'commenceAttack', code: 0 });
    }
  }
  return out;
}

/** Capture lines → the time-ordered client→server game actions, per client endpoint. */
export function decodeCapture(lines: CaptureLine[]): TimedAction[] {
  const asm = new Map<string, C2SAssembler>();
  const out: TimedAction[] = [];
  for (const l of lines) {
    if (l.d !== 'c2s') continue;
    let a = asm.get(l.c);
    if (!a) { a = new C2SAssembler(); asm.set(l.c, a); }
    for (const m of a.push(new Uint8Array(Buffer.from(l.b, 'base64')))) {
      const act = decodeMessage(m);
      if (act) out.push({ t: l.t, client: l.c, a: act });
    }
  }
  return out;
}

/** Heading (deg, AC compass: 0 = north, 90 = east) of a Z-axis quaternion. */
export function headingOf(p: WirePosition): number {
  // AC: yaw about +Z, counter-clockwise from north (+Y). Compass is clockwise.
  const yaw = 2 * Math.atan2(p.rz, p.rw); // CCW radians from north
  return ((-yaw * 180) / Math.PI + 360) % 360;
}

/** Global AC coordinates (m) of a cell-relative position, so tracks crossing landblocks stay continuous. */
export function globalXY(p: WirePosition): { x: number; y: number } {
  const lbx = (p.cell >>> 24) & 0xff, lby = (p.cell >>> 16) & 0xff;
  return { x: lbx * 192 + p.x, y: lby * 192 + p.y };
}
