/**
 * Milestones M3 (movement) and M4 (chat) of the 1999 adapter, plus the
 * server's 0xF7B0-wrapped events seen live (docs/ac1999-support.md). Source
 * order: the real client's capture (tests/fixtures/ac1999-session-001.jsonl.gz),
 * then the AC1999 server's writers and readers, then the KB.
 *
 * ── Movement, server → client ─────────────────────────────────────────────
 *   0xF748 MoveEntity  1999: u32 guid, PositionPack (u32 flags, u32 cell, 3×f32 origin,
 *                      quaternion w/x/y/z each OMITTED under 0x08/0x10/0x20/0x40, Vector3
 *                      velocity under 0x01, u32 placement under 0x02, 0x04 = contact,
 *                      4×u16 instance/position/teleport/forcePosition)  (PhatSDK Frame.cpp
 *                      PositionPack::Pack; 50 captured, e.g. flags 0x34 = contact, no x/y).
 *                      = end of retail's UpdatePosition byte for byte → passed through.
 *   0xF74C SetObjectMovement  1999: u32 guid, u16 instance, u16 movement, u16 server_control,
 *                      u8 autonomous, align4, then the release ("compressed") blob: u16
 *                      pack_word (u8 MovementType, u8 flags 0x01 sticky / 0x02 longjump),
 *                      u16 style, then per type: 0 = InterpretedMotionState (u32 flags | n<<7,
 *                      u16 command INDICES style/fwd/side/turn, then f32 speeds, n × {u16
 *                      index, u16 stamp|0x8000, f32 speed}, align4, [u32 sticky id]);
 *                      6/7 = [guid] cell+origin, 7 MovementParameters dwords, f32 run rate;
 *                      8/9 = [guid, f32 heading] 3 dwords  (Animate.cpp L202-215,
 *                      PhatSDK Movement.cpp InterpretedMotionState::Pack, MovementParameters::PackNet).
 *                      = ACE's GameMessageUpdateMotion layout exactly; the 1999 index table maps
 *                      index N to the command whose low word is N, as end of retail's does (KB
 *                      0xF74C, "release is correct by construction") → passed through, and
 *                      MovementDataParser maps the indices as for an ACE server.
 *   0xF619 PositionAndMovement (death respawn, WeenieObject.cpp ~L7598): u32 guid,
 *                      PositionPack, u16 movement, u16 server_control, u8 autonomous, align4,
 *                      blob. Our handler ignores 0xF619, so it is split into an 0xF748 and an
 *                      0xF74C (instance = the PositionPack's instance timestamp).
 *
 * ── Events (0xF7B0: u32 opcode, u32 guid, u32 sequence, u32 type: the EoL envelope) ──
 *   0x2B UpdateTitle (u32 title, u32 set), 0x196 ViewContents (u32 container, u32 n,
 *   n × {u32 guid, u32 type}), 0x1C7 UseDone (u32 error), 0x1C8 AllegianceUpdateDone (u32),
 *   0x1CA FellowshipStatsDone (u32, the 0xCA RequestAppraisal ack): identical → passed through.
 *   0xB4 BookData  1999 (Book.cpp SendBookData, Qualities.cpp Pack1999): u32 book, u32 maxPages,
 *                  u32 maxPages, u32 maxChars, u32 numPages, numPages × {u32 authorId, AcString
 *                  author, AcString account, u32 textIncluded, [AcString text]}, AcString
 *                  inscription, u32 scribe, AcString scribeName (no 0xFFFF0002 page marker).
 *                  → EoL BookDataResponse (String16, the marker, ignoreAuthor 0).
 *   0x20 AllegianceUpdate  1999 (AllegianceManager.cpp PackAllegianceProfile1999): u32 members,
 *                  u32 vassals, u32 n, records (all but the first prefixed by u32 patron):
 *                  {u32 id, u32 cpCached, u32 cpTithed, u32 bits, u8 gender, u8 heritage, u16 rank,
 *                  u16 loyalty, u16 leadership, f64 secondsOnline, AcString name}.
 *                  → EoL: leading u32 rank (the player's own node's: 1999 has none), the
 *                  version-0xB hierarchy header (empty officers/titles/MOTD/bind point/name),
 *                  records with u64 time online.
 *
 * ── Chat, server → client (flat, or 0xF7B0-wrapped when a sender passes event=TRUE: both
 *    are registered; ChatMsgs.cpp) ──
 *   0x37 HearSpeech {AcString text, AcString name, u32 speaker} → EoL 0x02BB (+ chatType 2 Speech)
 *   0x38 HearDirectSpeech {AcString text, AcString name, u32 sender, u32 target}
 *        → EoL Tell event 0x02BD (+ chatType 3 Tell, u32 0)
 *   0xF62C ServerChatLine {AcString text, i32 channel} → EoL 0xF7E0 ServerMessage (same number:
 *        the server writes its LogTextType, which is end of retail's ChatMessageType)
 *   0x1E0 HearEmote / 0x1E2 HearSoulEmote {u32 sender, AcString name, AcString text}
 *        → EoL 0x01E0 / 0x01E2 (String16)
 *   0x14A ChannelMessage {u32 channel, AcString name, AcString text} → EoL ChannelBroadcast
 *        event 0x147 (same Channel ids: Fellow 0x800 … Covassals 0x1000000)
 *
 * ── Client → server (0xF7B1 [u32 seq][u32 type][payload], group 5) ──
 *   0xF61C MoveToState: RawMotionState (u32 bits: 0 holdKey, 1 style, 2 fwd cmd, 3 fwd holdKey,
 *        4 fwd speed, 5-7 sidestep, 8-10 turn, 11-15 action count; raw u32 commands), Position
 *        (cell, origin, quaternion WXYZ), 4×u16 instance/serverControl/teleport/forcePosition,
 *        u8 contact|longjump<<1, align4. PhatSDK RawMotionState::UnPack is end of retail's read;
 *        all 10 captured 0xF61C rebuild byte for byte through our builder (the KB's bit 3-4
 *        "speed/scale" reading is the holdKey/speed pair) → passed through.
 *   0xF753 AutonomousPosition: Position + 4×u16 + u8 contact + align4 (all 6 captured rebuild
 *        byte for byte) → passed through.
 *   0xF61B Jump  EoL: f32 extent, Vector3 velocity, 4×u16, u32 object, u32 spell
 *        1999: f32 extent, Vector3 velocity, Position, 4×u16  (ClientEvents.cpp MOVEMENT_JUMP)
 *   0x15 Talk, 0x1DF Emote, 0x1E1 SoulEmote {String16} → same type {AcString}
 *   0x5D Tell {String16 text, String16 target} → {AcString, AcString}
 *   0x32 TalkDirect {String16 text, u32 target} → {AcString, u32}
 *   0x147 ChatChannel {u32 channel, String16 text} → {u32, AcString}
 *   0xA1 LoginComplete, 0x36 Use {u32}, 0xC8 IdentifyObject {u32}, 0x1B7 CancelAttack,
 *   0x1F AllegianceUpdateRequest {u32}: identical (captured 0xA1/0x36/0x1B7/0x1F) → passed through.
 *   0xF61E DoMovementCommand, 0xF649 TurnTo, 0xF661 StopMovementCommand, 0xF752 AutonomyLevel:
 *        the 1999 server reads none of them (ClientEvents.cpp) → not sent.
 *
 * Lossy:
 *   - Jump: end of retail's Jump carries no Position. We send the newest of (a) the last Position
 *     our client put in a MoveToState / AutonomousPosition and (b) the last 0xF748 the server sent
 *     for our own guid (a server move: teleport, force-position snap). MovementSync sends a
 *     MoveToState at every jump charge (CommenceJump), so (a) is normally the charge spot; (b)
 *     covers a server move after it. The server (ClientEvents.cpp MOVEMENT_JUMP) moves the player
 *     there when within 10 m of ITS position, else snaps back, and its position is whichever of
 *     those it last applied, so the newest one is the one that can't trigger a snap. With
 *     neither, the jump is not sent.
 *   - HearSpeech/Tell carry no chat type in 1999 (Speech / Tell are assumed).
 *   - AllegianceUpdate: no officers, titles, MOTD, allegiance name or bind point exist in 1999;
 *     the player's rank is taken from their own node; heritage/gender pass through as sent.
 *   - Book pages: no ignoreAuthor in 1999 (sent as 0).
 *   - 0xF748 PositionPack: AC1999's writer packs a NON-zero velocity before the flags word
 *     (Frame.cpp), which nothing can parse; it never sends one (velocity is commented out).
 */
import { ChatMessageType } from '@ac/shared';
import { BinaryReader, BinaryWriter, parseAutonomousPositionPayload, parseMoveToStatePayload, type MovementPositionFields } from '../../MessageSerializer.js';
import { Group1999, eol, type Codecs1999, type InboundCodec, type Outbound1999, type OutboundCodec } from '../Adapter1999.js';
import { Reader1999, Writer1999 } from '../Wire1999.js';

/** The F7B0 envelope's fields, when the message arrived wrapped. */
interface Envelope { guid: number; sequence: number }

/** A codec over a 1999 message body: reader after the (inner) opcode, envelope when wrapped. */
type BodyCodec = (r: Reader1999, env: Envelope | null) => Uint8Array[];

/** An end-of-retail GameEvent (0xF7B0) message. */
function eolEvent(env: Envelope | null, type: number, build: (w: BinaryWriter) => void): Uint8Array {
  return eol(0xf7b0, (w) => {
    w.writeUInt32(env?.guid ?? 0);
    w.writeUInt32(env?.sequence ?? 0);
    w.writeUInt32(type);
    build(w);
  });
}

/** Register a 1999 message both flat (by opcode) and 0xF7B0-wrapped (by inner type). */
function both(c: Codecs1999, op: number, codec: BodyCodec): void {
  c.inbound.set(op, (r) => codec(r, null));
  c.inboundEvent.set(op, (r) => {
    const guid = r.u32();
    const sequence = r.u32();
    r.u32(); // inner type
    return codec(r, { guid, sequence });
  });
}

/** Byte length of a PositionPack starting at `at` (Frame.cpp PositionPack::Pack). */
export function positionPackLength1999(data: Uint8Array, at: number): number {
  const flags = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(at, true);
  let n = 4 + 16; // flags, cell + origin
  for (const bit of [0x08, 0x10, 0x20, 0x40]) if (!(flags & bit)) n += 4;
  if (flags & 0x01) n += 12;
  if (flags & 0x02) n += 4;
  return n + 8;
}

/** EoL's MoveToState / AutonomousPosition / Jump position, the 1999 Position (cell, origin, WXYZ). */
function writePosition(w: Writer1999, p: Pick<MovementPositionFields, 'landblockId' | 'x' | 'y' | 'z' | 'qw' | 'qx' | 'qy' | 'qz'>): void {
  w.u32(p.landblockId).f32(p.x).f32(p.y).f32(p.z).f32(p.qw).f32(p.qx).f32(p.qy).f32(p.qz);
}

/** An action whose 1999 layout is end of retail's: the same bytes. */
const action = (m: Uint8Array): Outbound1999[] => [{ message: m.slice(), group: Group1999.ClientAction }];

/** A 1999 0xF7B1 action built from the EoL action's sequence and type. */
function action1999(eolMsg: Uint8Array, build: (w: Writer1999, r: BinaryReader) => void): Outbound1999[] {
  const r = new BinaryReader(eolMsg);
  r.readUInt32();
  const seq = r.readUInt32();
  const type = r.readUInt32();
  const w = new Writer1999().u32(0xf7b1).u32(seq).u32(type);
  build(w, r);
  return [{ message: w.toBytes(), group: Group1999.ClientAction }];
}

/** The 1999 Position (cell, origin, WXYZ) a PositionPack at `at` carries; omitted quaternion parts are 0 (Frame.cpp UnPack). */
export function readPositionPack1999(data: Uint8Array, at: number): Pick<MovementPositionFields, 'landblockId' | 'x' | 'y' | 'z' | 'qw' | 'qx' | 'qy' | 'qz'> {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const flags = v.getUint32(at, true);
  let p = at + 4;
  const f = () => { const x = v.getFloat32(p, true); p += 4; return x; };
  const landblockId = v.getUint32(p, true); p += 4;
  const x = f(), y = f(), z = f();
  const q = [0x08, 0x10, 0x20, 0x40].map((bit) => (flags & bit ? 0 : f()));
  return { landblockId, x, y, z, qw: q[0], qx: q[1], qy: q[2], qz: q[3] };
}

export interface Movement1999Options {
  /** The player's guid once known (0 before): an 0xF748 for it is the server moving us. */
  playerGuid?: () => number;
}

export function registerMovement1999(c: Codecs1999, opts: Movement1999Options = {}): void {
  /** The newest Position for the player: ours (MoveToState / AutonomousPosition) or the server's (0xF748). The Jump needs one. */
  let lastPosition: Pick<MovementPositionFields, 'landblockId' | 'x' | 'y' | 'z' | 'qw' | 'qx' | 'qy' | 'qz'> | null = null;

  // ── Movement, inbound ──
  const pass: InboundCodec = (_r, _ctx, raw) => [raw.slice()];
  c.inbound.set(0xf748, (r, _ctx, raw) => {
    const guid = r.u32();
    const player = opts.playerGuid?.() ?? 0;
    if (player !== 0 && guid === player) lastPosition = readPositionPack1999(raw, r.pos);
    return [raw.slice()];
  });
  c.inbound.set(0xf74c, pass);

  c.inbound.set(0xf619, (r, _ctx, raw) => {
    const guid = r.u32();
    const posAt = r.pos;
    const posLen = positionPackLength1999(raw, posAt);
    const pack = raw.slice(posAt, posAt + posLen);
    const instance = new DataView(pack.buffer).getUint16(posLen - 8, true);
    r.pos = posAt + posLen;
    const movement = r.u16();
    const serverControl = r.u16();
    const autonomous = r.u8();
    r.align4();
    const blob = raw.slice(r.pos);
    return [
      eol(0xf748, (w) => { w.writeUInt32(guid); w.writeBytes(pack); }),
      eol(0xf74c, (w) => {
        w.writeUInt32(guid);
        w.writeUInt16(instance);
        w.writeUInt16(movement);
        w.writeUInt16(serverControl);
        w.writeUInt8(autonomous);
        w.writeUInt8(0); // align4
        w.writeBytes(blob);
      }),
    ];
  });

  // ── Events with an identical layout ──
  for (const type of [0x2b, 0x196, 0x1c7, 0x1c8, 0x1ca]) c.inboundEvent.set(type, pass);

  c.inboundEvent.set(0xb4, (r) => {
    const guid = r.u32();
    const sequence = r.u32();
    r.u32();
    const book = r.u32();
    const maxPages = r.u32();
    r.u32(); // maxNumPages again (PageDataList::Pack1999)
    const maxChars = r.u32();
    const numPages = r.u32();
    const pages = Array.from({ length: numPages }, () => {
      const authorId = r.u32();
      const author = r.acString();
      const account = r.acString();
      const textIncluded = r.u32();
      const text = textIncluded ? r.acString() : '';
      return { authorId, author, account, textIncluded, text };
    });
    const inscription = r.acString();
    const scribe = r.u32();
    const scribeName = r.acString();
    return [eolEvent({ guid, sequence }, 0xb4, (w) => {
      w.writeUInt32(book);
      w.writeUInt32(maxPages);
      w.writeUInt32(numPages);
      w.writeUInt32(maxChars);
      w.writeUInt32(numPages);
      for (const p of pages) {
        w.writeUInt32(p.authorId);
        w.writeString16(p.author);
        w.writeString16(p.account);
        w.writeUInt32(0xffff0002);
        w.writeUInt32(p.textIncluded ? 1 : 0);
        w.writeUInt32(0); // ignoreAuthor: not in 1999
        if (p.textIncluded) w.writeString16(p.text);
      }
      w.writeString16(inscription);
      w.writeUInt32(scribe);
      w.writeString16(scribeName);
    })];
  });

  c.inboundEvent.set(0x20, (r) => {
    const guid = r.u32();
    const sequence = r.u32();
    r.u32();
    const totalMembers = r.u32();
    const totalVassals = r.u32();
    const n = r.u32();
    const nodes = Array.from({ length: n }, (_, i) => {
      const patron = i === 0 ? 0 : r.u32();
      const id = r.u32();
      const cpCached = r.u32();
      const cpTithed = r.u32();
      const bits = r.u32();
      const gender = r.u8();
      const heritage = r.u8();
      const rank = r.u16();
      const loyalty = r.u16();
      const leadership = r.u16();
      const seconds = r.f64();
      const name = r.acString();
      return { patron, id, cpCached, cpTithed, bits, gender, heritage, rank, loyalty, leadership, seconds, name };
    });
    const playerRank = nodes.find((x) => x.id === guid)?.rank ?? 0;
    return [eolEvent({ guid, sequence }, 0x20, (w) => {
      w.writeUInt32(playerRank);
      w.writeUInt32(totalMembers);
      w.writeUInt32(totalVassals);
      w.writeUInt16(nodes.length);
      w.writeUInt16(0x000b); // hierarchy version
      w.writeUInt16(0); w.writeUInt16(0); // officers (count, buckets)
      w.writeUInt32(0); // officer titles
      for (let i = 0; i < 4; i++) w.writeUInt32(0); // broadcast times / counts
      w.writeString16(''); w.writeString16(''); // MOTD, set by
      w.writeUInt32(0); // chat room
      for (let i = 0; i < 8; i++) w.writeUInt32(0); // bind point
      w.writeString16(''); // allegiance name
      w.writeUInt32(0); w.writeUInt32(0); w.writeInt32(0); // name set time, locked, approved vassal
      nodes.forEach((x, i) => {
        if (i > 0) w.writeUInt32(x.patron);
        w.writeUInt32(x.id);
        w.writeUInt32(x.cpCached);
        w.writeUInt32(x.cpTithed);
        w.writeUInt32(x.bits & ~(0x4 | 0x8)); // no HasAllegianceAge / HasPackedLevel fields follow
        w.writeUInt8(x.gender);
        w.writeUInt8(x.heritage);
        w.writeUInt16(x.rank);
        w.writeUInt16(x.loyalty);
        w.writeUInt16(x.leadership);
        const secs = Number.isFinite(x.seconds) && x.seconds > 0 ? Math.floor(x.seconds) : 0;
        w.writeUInt32(secs % 0x100000000);
        w.writeUInt32(Math.floor(secs / 0x100000000));
        w.writeString16(x.name);
      });
    })];
  });

  // ── Chat, inbound ──
  both(c, 0x37, (r) => {
    const text = r.acString();
    const name = r.acString();
    const speaker = r.u32();
    return [eol(0x02bb, (w) => {
      w.writeString16(text); w.writeString16(name); w.writeUInt32(speaker); w.writeUInt32(ChatMessageType.Speech);
    })];
  });

  both(c, 0x38, (r, env) => {
    const text = r.acString();
    const name = r.acString();
    const sender = r.u32();
    const target = r.u32();
    return [eolEvent(env, 0x02bd, (w) => {
      w.writeString16(text); w.writeString16(name); w.writeUInt32(sender); w.writeUInt32(target);
      w.writeUInt32(ChatMessageType.Tell); w.writeUInt32(0);
    })];
  });

  both(c, 0xf62c, (r) => {
    const text = r.acString();
    const channel = r.u32();
    return [eol(0xf7e0, (w) => { w.writeString16(text); w.writeUInt32(channel); })];
  });

  for (const op of [0x1e0, 0x1e2]) {
    both(c, op, (r) => {
      const sender = r.u32();
      const name = r.acString();
      const text = r.acString();
      return [eol(op, (w) => { w.writeUInt32(sender); w.writeString16(name); w.writeString16(text); })];
    });
  }

  both(c, 0x14a, (r, env) => {
    const channel = r.u32();
    const name = r.acString();
    const text = r.acString();
    return [eolEvent(env, 0x147, (w) => { w.writeUInt32(channel); w.writeString16(name); w.writeString16(text); })];
  });

  // ── Movement, outbound ──
  const out = (type: number, codec: OutboundCodec) => c.outboundAction.set(type, codec);

  out(0xf61c, (m, ctx) => {
    const parsed = parseMoveToStatePayload(m.subarray(12));
    lastPosition = parsed.position;
    if (parsed.motion.commandListLength > 0x1f) {
      ctx.log(`[1999] MoveToState with ${parsed.motion.commandListLength} actions; 1999 carries at most 31`);
      return null;
    }
    return action(m);
  });

  out(0xf753, (m) => {
    lastPosition = parseAutonomousPositionPayload(m.subarray(12));
    return action(m);
  });

  out(0xf61b, (m, ctx) => {
    if (!lastPosition) {
      ctx.log('[1999] Jump before any position was sent; not sent');
      return null;
    }
    const pos = lastPosition;
    return action1999(m, (w, r) => {
      w.f32(r.readFloat32()); // extent
      w.f32(r.readFloat32()).f32(r.readFloat32()).f32(r.readFloat32()); // velocity
      writePosition(w, pos);
      for (let i = 0; i < 4; i++) w.u16(r.readUInt16()); // instance, serverControl, teleport, forcePosition
      // EoL's trailing object guid / spell id have no 1999 field.
    });
  });

  for (const type of [0xf61e, 0xf649, 0xf661, 0xf752]) out(type, () => null);

  // ── Identical actions ──
  for (const type of [0xa1, 0x36, 0xc8, 0x1b7, 0x1f]) out(type, (m) => action(m));

  // ── Chat, outbound ──
  for (const type of [0x15, 0x1df, 0x1e1]) out(type, (m) => action1999(m, (w, r) => { w.acString(r.readString16()); }));
  out(0x5d, (m) => action1999(m, (w, r) => { w.acString(r.readString16()); w.acString(r.readString16()); }));
  out(0x32, (m) => action1999(m, (w, r) => { w.acString(r.readString16()); w.u32(r.readUInt32()); }));
  out(0x147, (m) => action1999(m, (w, r) => { w.u32(r.readUInt32()); w.acString(r.readString16()); }));
}
