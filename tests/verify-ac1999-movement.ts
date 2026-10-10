/**
 * The 1999 movement, event and chat codecs (packages/network/src/era1999/codecs/Movement1999.ts):
 * the real 1999 server's movement and 0xF7B0 events from the committed session capture go through
 * the adapter and into our REAL end-of-retail parsers (ServerMessageHandler, parseMovementData);
 * the real 1999 client's captured actions are rebuilt with our own EoL builders, translated, and
 * compared byte for byte; chat (absent from the capture) is built from the AC1999 server's layouts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeCapture, type Message1999 } from '../tools/ac1999/decode-capture.js';
import { Adapter1999, emptyCodecs } from '../packages/network/src/era1999/Adapter1999.js';
import { registerMovement1999 } from '../packages/network/src/era1999/codecs/Movement1999.js';
import { Reader1999, Writer1999 } from '../packages/network/src/era1999/Wire1999.js';
import {
  BinaryWriter, buildAutonomousPositionPayload, buildJumpActionPayload, buildMoveToStatePayload, deserializeMessage,
  parseAutonomousPositionPayload, parseMoveToStatePayload, serializeGameAction,
} from '../packages/network/src/MessageSerializer.js';
import { parseMovementData } from '../packages/network/src/MovementDataParser.js';
import { GameActionType } from '../packages/network/src/GameActionType.js';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';

const capture: Message1999[] = decodeCapture(readFileSync(resolve(__dirname, 'fixtures', 'ac1999-session-001.jsonl.gz')));
const s2c = capture.filter((m) => m.dir === 's2c');
const c2s = capture.filter((m) => m.dir === 'c2s');

function adapter() {
  const logs: string[] = [];
  const c = emptyCodecs();
  registerMovement1999(c);
  return { a: new Adapter1999(c, { account: 'acjs', log: (m) => logs.push(m) }), logs };
}

/** A ServerMessageHandler recording everything movement / events / chat reach. */
function recording() {
  const got: Record<string, any[]> = {};
  const rec = (k: string) => (d: unknown) => { (got[k] ??= []).push(d); };
  const h = new ServerMessageHandler();
  h.setHandlers({
    onUpdatePosition: rec('pos'), onMovementEvent: rec('move'), onUpdateTitle: rec('title'),
    onViewContents: rec('view'), onUseDone: rec('useDone'), onAllegianceUpdateDone: rec('allegDone'),
    onAllegianceUpdate: rec('alleg'), onBookData: rec('book'), onHearSpeech: rec('speech'), onTell: rec('tell'),
    onServerMessage: rec('server'), onEmoteText: rec('emote'), onSoulEmote: rec('soul'), onChannelBroadcast: rec('channel'),
  });
  const feed = (msgs: Uint8Array[]) => { for (const m of msgs) h.handleMessage(deserializeMessage(m)); };
  return { got, feed };
}

const payloadOf = (m: Uint8Array) => m.subarray(12); // after 0xF7B1, seq, type
const seqOf = (m: Uint8Array) => new DataView(m.buffer, m.byteOffset).getUint32(4, true);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('inbound movement from the real 1999 server', () => {
  it('every captured 0xF748 is end of retail\'s UpdatePosition, parsed whole', () => {
    const { a } = adapter();
    const { got, feed } = recording();
    const moves = s2c.filter((m) => m.opcode === 0xf748);
    expect(moves.length).toBe(50);
    for (const m of moves) {
      const out = a.inbound(m.data, m.group);
      expect(out.map(hex)).toEqual([hex(m.data)]);
      feed(out);
    }
    expect(got.pos).toHaveLength(50);
    const first = got.pos[0];
    // 48f70000 1a000060 34000000 0b0050dd …: flags 0x34 = contact, no x / no y.
    expect(first.guid).toBe(0x6000001a);
    expect(first.flags).toBe(0x34);
    expect(first.landblock).toBe(0xdd50000b);
    expect(first.rx).toBe(0);
    expect(first.ry).toBe(0);
    expect(Math.hypot(first.rw, first.rz)).toBeCloseTo(1, 4);
    expect(first.instanceSequence).toBe(1);
    expect(first.positionSequence).toBe(1);
  });

  it('every captured 0xF74C parses with MovementDataParser (run speed, stance, stance index)', () => {
    const { a } = adapter();
    const { got, feed } = recording();
    const anims = s2c.filter((m) => m.opcode === 0xf74c);
    expect(anims.length).toBe(10);
    for (const m of anims) feed(a.inbound(m.data, m.group));
    expect(got.move).toHaveLength(10);
    const parsed = got.move.map((e) => parseMovementData(e.movementData, true)!);
    for (const p of parsed) {
      expect(p).not.toBeNull();
      expect(p.movementType).toBe(0);
      expect(p.styleIndex).toBe(0x3d); // NonCombat
    }
    // 06000000 0700 f06c b43f: forward command RunForward (index 7) at the run rate.
    const run = parsed.find((p) => p.forwardCommand === 7)!;
    expect(run.forwardSpeed).toBeCloseTo(1.4096, 3);
    // 60000000 0d00 c0bf: TurnLeft (index 0xd), turn speed -1.5.
    const turn = parsed.find((p) => p.turnCommand === 0xd)!;
    expect(turn.turnSpeed).toBeCloseTo(-1.5, 5);
    // 80000000 5700 0100 0000803f: one action, index 0x57 stamp 1, speed 1.
    const act = parsed.find((p) => p.actions.length === 1)!;
    expect(act.actions[0]).toEqual({ command: 0x57, sequence: 1, speed: 1 });
    // The header: guid, instance, then movement seq 1..10 and the autonomous byte.
    expect(got.move.map((e) => e.instanceSequence)).toEqual(Array(10).fill(2));
    expect(parsed.filter((p) => p.autonomous).length).toBe(9);
  });

  it('splits a 0xF619 PositionAndMovement into UpdatePosition + MovementEvent', () => {
    const w = new Writer1999().u32(0xf619).u32(0x50000003);
    w.u32(0x04 | 0x10 | 0x20).u32(0xdd51001d).f32(10).f32(20).f32(30).f32(0.5).f32(0.866); // flags, cell, origin, w, z
    w.u16(2).u16(7).u16(3).u16(1); // instance, position, teleport, forcePosition
    w.u16(12).u16(4).u8(0).align4(); // movement, serverControl, autonomous
    w.u16(0).u16(0x3d).u32(0x2).u16(0x11).align4(); // Invalid, NonCombat, forward = Dead (0x11)
    const { a } = adapter();
    const { got, feed } = recording();
    feed(a.inbound(w.toBytes(), 3));
    expect(got.pos[0]).toMatchObject({ guid: 0x50000003, landblock: 0xdd51001d, x: 10, y: 20, z: 30, instanceSequence: 2, teleportSequence: 3 });
    expect(got.move[0]).toMatchObject({ guid: 0x50000003, instanceSequence: 2 });
    const p = parseMovementData(got.move[0].movementData, true)!;
    expect(p.forwardCommand).toBe(0x11);
    expect(new DataView(got.move[0].movementData.buffer, got.move[0].movementData.byteOffset).getUint16(0, true)).toBe(12);
  });
});

describe('the server\'s 0xF7B0 events', () => {
  const events = s2c.filter((m) => m.opcode === 0xf7b0);

  it('every captured event translates and reaches its EoL handler', () => {
    const { a } = adapter();
    const { got, feed } = recording();
    for (const m of events) {
      const out = a.inbound(m.data, m.group);
      expect(out.length, `inner 0x${m.inner!.toString(16)}`).toBe(1);
      feed(out);
    }
    expect(a.unknownInbound.size).toBe(0);
    expect(got.title).toEqual([{ titleId: 1, setAsDisplay: false }, { titleId: 1, setAsDisplay: true }]);
    expect(got.view).toEqual([{ containerGuid: 0x90000058, items: [] }]);
    expect(got.useDone).toEqual([{ errorType: 0 }]);
    expect(got.allegDone).toEqual([{ errorType: 0 }, { errorType: 0 }]);
    expect(got.alleg).toHaveLength(2);
    expect(got.alleg[0].parsed).toMatchObject({ playerRank: 0, totalMembers: 0, totalVassals: 0, members: [] });
    expect(got.book).toHaveLength(2);
    const book = got.book[0];
    expect(book.bookGuid).toBe(0x90000057);
    expect(book.maxPages).toBe(1);
    expect(book.pages).toHaveLength(1);
    expect(book.pages[0].authorId).toBe(0xffffffff);
    expect(book.pages[0].authorName).toBe("Welcome to Asheron's Call  ");
    expect(book.pages[0].textIncluded).toBe(true);
    expect(book.pages[0].pageText.startsWith('Hail, traveler, welcome to Dereth!')).toBe(true);
    expect(book.pages[0].pageText.endsWith('Enjoy!\n')).toBe(true);
    expect(book.inscription).toBe('');
    expect(book.inscriptionAuthorId).toBe(0);
  });

  it('translates an allegiance with members (patron links, rank, names)', () => {
    const w = new Writer1999().u32(0xf7b0).u32(0x50000003).u32(9).u32(0x20);
    w.u32(2).u32(1).u32(2); // members, vassals, nodes
    const node = (id: number, rank: number, name: string, bits: number) =>
      w.u32(id).u32(100).u32(55).u32(bits).u8(1).u8(2).u16(rank).u16(30).u16(40).f64(3600.7).acString(name);
    node(0x50000001, 2, 'Monarch', 0x1);
    w.u32(0x50000001);
    node(0x50000003, 1, 'Me', 0x8 | 0x4);
    const { a } = adapter();
    const { got, feed } = recording();
    feed(a.inbound(w.toBytes(), 4));
    const p = got.alleg[0].parsed;
    expect(p.playerRank).toBe(1);
    expect(p.totalMembers).toBe(2);
    expect(p.members).toEqual([
      expect.objectContaining({ guid: 0x50000001, parentGuid: 0, name: 'Monarch', rank: 2, isOnline: true, xpProduced: 55, gender: 1, heritage: 2 }),
      expect.objectContaining({ guid: 0x50000003, parentGuid: 0x50000001, name: 'Me', rank: 1, isOnline: false, level: 0 }),
    ]);
  });
});

describe('chat, server → client', () => {
  /** A 1999 message flat, and the same body 0xF7B0-wrapped. */
  function bothForms(op: number, body: (w: Writer1999) => void): Uint8Array[] {
    const flat = new Writer1999().u32(op);
    body(flat);
    const wrapped = new Writer1999().u32(0xf7b0).u32(0x50000003).u32(5).u32(op);
    body(wrapped);
    return [flat.toBytes(), wrapped.toBytes()];
  }

  it('0x37 HearSpeech → HearSpeech (AcStrings with the counted NUL)', () => {
    const { a } = adapter();
    const { got, feed } = recording();
    for (const m of bothForms(0x37, (w) => w.acString('Hello there').acString('Bob').u32(0x50000009))) feed(a.inbound(m, 4));
    expect(got.speech).toEqual(Array(2).fill({ message: 'Hello there', senderName: 'Bob', senderGuid: 0x50000009, chatType: 2, range: undefined }));
  });

  it('0x38 HearDirectSpeech → Tell event', () => {
    const { a } = adapter();
    const { got, feed } = recording();
    for (const m of bothForms(0x38, (w) => w.acString('psst').acString('Alice').u32(0x50000009).u32(0x50000003))) feed(a.inbound(m, 4));
    expect(got.tell).toEqual(Array(2).fill({ message: 'psst', senderName: 'Alice', senderGuid: 0x50000009, targetGuid: 0x50000003, chatType: 3 }));
  });

  it('0xF62C ServerChatLine → ServerMessage, channel kept', () => {
    const { a } = adapter();
    const { got, feed } = recording();
    for (const m of bothForms(0xf62c, (w) => w.acString('Welcome to the 1999 server.').u32(0))) feed(a.inbound(m, 4));
    expect(got.server).toEqual(Array(2).fill({ message: 'Welcome to the 1999 server.', chatType: 0 }));
  });

  it('0x1E0 / 0x1E2 emotes and 0x14A channel text', () => {
    const { a } = adapter();
    const { got, feed } = recording();
    for (const m of bothForms(0x1e0, (w) => w.u32(7).acString('Bob').acString('waves.'))) feed(a.inbound(m, 4));
    for (const m of bothForms(0x1e2, (w) => w.u32(7).acString('Bob').acString('laughs.'))) feed(a.inbound(m, 4));
    for (const m of bothForms(0x14a, (w) => w.u32(0x800).acString('').acString('hi fellows'))) feed(a.inbound(m, 4));
    expect(got.emote).toEqual(Array(2).fill({ senderGuid: 7, senderName: 'Bob', message: 'waves.' }));
    expect(got.soul).toEqual(Array(2).fill({ senderGuid: 7, senderName: 'Bob', message: 'laughs.' }));
    expect(got.channel).toEqual(Array(2).fill({ channel: 0x800, senderName: '', message: 'hi fellows' }));
  });
});

describe('outbound actions against the real 1999 client', () => {
  const actions = c2s.filter((m) => m.opcode === 0xf7b1);

  it('every captured MoveToState, rebuilt with our builder, translates to the client\'s bytes', () => {
    const { a } = adapter();
    const moves = actions.filter((m) => m.inner === 0xf61c);
    expect(moves.length).toBe(10);
    for (const m of moves) {
      const { motion, position } = parseMoveToStatePayload(payloadOf(m.data));
      const ours = serializeGameAction(seqOf(m.data), GameActionType.MoveToState, buildMoveToStatePayload(motion, position));
      const out = a.outbound(ours)!;
      expect(out).toHaveLength(1);
      expect(out[0].group).toBe(5);
      expect(hex(out[0].message)).toBe(hex(m.data));
    }
    // The bitfields seen: none, run hold key, + WalkForward, + TurnLeft (raw u32 commands).
    const fields = moves.map((m) => new DataView(m.data.buffer, m.data.byteOffset).getUint32(12, true));
    expect(new Set(fields)).toEqual(new Set([0x0, 0x1, 0x5, 0x101]));
  });

  it('every captured AutonomousPosition, rebuilt, translates to the client\'s bytes', () => {
    const { a } = adapter();
    const autos = actions.filter((m) => m.inner === 0xf753);
    expect(autos.length).toBe(6);
    for (const m of autos) {
      const ours = serializeGameAction(seqOf(m.data), GameActionType.AutonomousPosition, buildAutonomousPositionPayload(parseAutonomousPositionPayload(payloadOf(m.data))));
      expect(hex(a.outbound(ours)![0].message)).toBe(hex(m.data));
    }
  });

  it('Jump: our EoL Jump + the last position sent = the client\'s 0xF61B, byte for byte', () => {
    const jump = actions.find((m) => m.inner === 0xf61b)!.data;
    expect(jump.length).toBe(68);
    const r = new Reader1999(jump, 12);
    const extent = r.f32(); const vx = r.f32(); const vy = r.f32(); const vz = r.f32();
    const cell = r.u32(); const xyz = [r.f32(), r.f32(), r.f32()]; const q = [r.f32(), r.f32(), r.f32(), r.f32()];
    const seqs = [r.u16(), r.u16(), r.u16(), r.u16()];
    expect(r.remaining).toBe(0);
    const { a, logs } = adapter();
    const eolJump = serializeGameAction(seqOf(jump), GameActionType.Jump, buildJumpActionPayload(extent, vx, vy, vz, seqs[0], seqs[1], seqs[2], seqs[3]));
    expect(a.outbound(eolJump)).toBeNull(); // no position yet: not sent
    expect(logs.some((l) => /Jump before any position/.test(l))).toBe(true);
    const pos = {
      landblockId: cell, x: xyz[0], y: xyz[1], z: xyz[2], qw: q[0], qx: q[1], qy: q[2], qz: q[3],
      instanceSequence: seqs[0], serverControlSequence: seqs[1], teleportSequence: seqs[2], forcePositionSequence: seqs[3], contact: true,
    };
    a.outbound(serializeGameAction(1, GameActionType.AutonomousPosition, buildAutonomousPositionPayload(pos)));
    const out = a.outbound(eolJump)!;
    expect(hex(out[0].message)).toBe(hex(jump));
    expect(out[0].group).toBe(5);
  });

  it('Jump: a server move of OUR player (0xF748 after our last send) is the position sent; another guid\'s is not', () => {
    const logs: string[] = [];
    const c = emptyCodecs();
    let me = 0;
    registerMovement1999(c, { playerGuid: () => me });
    const a = new Adapter1999(c, { account: 'acjs', log: (m) => logs.push(m) });
    const eolJump = serializeGameAction(9, GameActionType.Jump, buildJumpActionPayload(0.5, 0, 1, 4, 1, 2, 3, 4));
    // PositionPack: flags 0x34 (contact, no qx/qy), cell, origin, qw, qz, 4 × u16.
    const move = (guid: number, cell: number, x: number) => new Writer1999().u32(0xf748).u32(guid)
      .u32(0x34).u32(cell).f32(x).f32(20).f32(30).f32(0.6).f32(0.8).u16(1).u16(5).u16(0).u16(0).toBytes();
    const jumpPos = (out: { message: Uint8Array }[]) => {
      const r = new Reader1999(out[0].message, 28);
      return { cell: r.u32(), x: r.f32(), y: r.f32(), z: r.f32(), q: [r.f32(), r.f32(), r.f32(), r.f32()] };
    };

    // Before the guid is known, or for someone else, an 0xF748 is not ours.
    a.inbound(move(0x50000001, 0xa9b40017, 10), 3);
    me = 0x50000001;
    a.inbound(move(0x50000002, 0xa9b40017, 11), 3);
    expect(a.outbound(eolJump)).toBeNull();
    // Our own: the jump goes out from where the server put us (quaternion parts it omitted are 0).
    a.inbound(move(0x50000001, 0xa9b40018, 12), 3);
    expect(jumpPos(a.outbound(eolJump)!)).toEqual({ cell: 0xa9b40018, x: 12, y: 20, z: 30, q: [Math.fround(0.6), 0, 0, Math.fround(0.8)] });
    // Our next send is newer again.
    const pos = { landblockId: 0xa9b40019, x: 1, y: 2, z: 3, qw: 1, qx: 0, qy: 0, qz: 0,
      instanceSequence: 1, serverControlSequence: 0, teleportSequence: 0, forcePositionSequence: 0, contact: true };
    a.outbound(serializeGameAction(10, GameActionType.AutonomousPosition, buildAutonomousPositionPayload(pos)));
    expect(jumpPos(a.outbound(eolJump)!)).toMatchObject({ cell: 0xa9b40019, x: 1, y: 2, z: 3 });
    // The 0xF748 still passes through untouched.
    const raw = move(0x50000001, 0xa9b40018, 12);
    expect(hex(a.inbound(raw, 3)[0])).toBe(hex(raw));
  });

  it('LoginComplete, Use, CancelAttack, AllegianceUpdateRequest pass through as captured', () => {
    const { a } = adapter();
    for (const inner of [0xa1, 0x36, 0x1b7, 0x1f]) {
      for (const m of actions.filter((x) => x.inner === inner)) {
        const out = a.outbound(m.data)!;
        expect(hex(out[0].message), `0x${inner.toString(16)}`).toBe(hex(m.data));
      }
    }
    const identify = serializeGameAction(3, GameActionType.IdentifyObject, new Uint8Array([0x57, 0, 0, 0x90]));
    expect(hex(a.outbound(identify)![0].message)).toBe(hex(identify));
  });

  it('movement actions the 1999 server ignores are not sent; unknown ones neither', () => {
    const { a } = adapter();
    for (const t of [GameActionType.TurnTo, GameActionType.StopMovementCommand, GameActionType.DoMovementCommand, GameActionType.AutonomyLevel]) {
      expect(a.outbound(serializeGameAction(1, t, new Uint8Array(8)))).toBeNull();
    }
  });
});

describe('chat, client → server', () => {
  const eolAction = (type: number, build: (w: BinaryWriter) => void) => {
    const w = new BinaryWriter(64);
    build(w);
    return serializeGameAction(0x21, type, w.toBuffer());
  };

  it('Talk → 0x15 with a 1999 AcString (length counts the NUL, padded from the message start)', () => {
    const { a } = adapter();
    const out = a.outbound(eolAction(GameActionType.Talk, (w) => w.writeString16('hi')))!;
    expect(out[0].group).toBe(5);
    // b1f70000 21000000 15000000 | 0300 6869 00 | 000000
    expect(hex(out[0].message)).toBe('b1f70000' + '21000000' + '15000000' + '0300' + '6869' + '00' + '000000');
  });

  it('Tell, TalkDirect, Emote, SoulEmote, ChatChannel', () => {
    const { a } = adapter();
    const read = (m: Uint8Array) => { const r = new Reader1999(m); r.u32(); expect(r.u32()).toBe(0x21); return r; };

    let r = read(a.outbound(eolAction(GameActionType.Tell, (w) => { w.writeString16('meet me at the well'); w.writeString16('Bob'); }))![0].message);
    expect(r.u32()).toBe(0x5d);
    expect([r.acString(), r.acString(), r.remaining]).toEqual(['meet me at the well', 'Bob', 0]);

    r = read(a.outbound(eolAction(GameActionType.TalkDirect, (w) => { w.writeString16('hey'); w.writeUInt32(0x50000009); }))![0].message);
    expect(r.u32()).toBe(0x32);
    expect([r.acString(), r.u32(), r.remaining]).toEqual(['hey', 0x50000009, 0]);

    for (const t of [GameActionType.Emote, GameActionType.SoulEmote]) {
      r = read(a.outbound(eolAction(t, (w) => w.writeString16('dances wildly')))![0].message);
      expect(r.u32()).toBe(t);
      expect([r.acString(), r.remaining]).toEqual(['dances wildly', 0]);
    }

    r = read(a.outbound(eolAction(GameActionType.ChatChannel, (w) => { w.writeUInt32(0x1000); w.writeString16('vassals, report'); }))![0].message);
    expect(r.u32()).toBe(0x147);
    expect([r.u32(), r.acString(), r.remaining]).toEqual([0x1000, 'vassals, report', 0]);
  });
});
