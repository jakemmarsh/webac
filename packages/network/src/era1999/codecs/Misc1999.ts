/**
 * The rest of the 1999 adapter (docs/ac1999-support.md, "Client actions" and
 * "Server messages"): social (allegiance, fellowship, friends, squelch),
 * books, options, shortcuts, channels, queries, advocate teleport, and the
 * account lifecycle messages. Layouts from the AC1999 server, the authority
 * (Server/Source ClientEvents.cpp + Client.cpp readers; FellowshipManager.cpp,
 * Book.cpp, ChatMsgs.cpp, Network.cpp writers), with the KB's opcode pages for
 * the 1999 client's side. Strings: the server reads every client string as an
 * AcString (ReadString / ReadAcString1999 accept it), so String16L becomes
 * AcString going out.
 *
 * ── Client → server (0xF7B1 [u32 seq][u32 type][payload], group 5) ─────────
 *   same dwords (passed through): 0x05 SetSingleCharacterOption {option, value} (CHANGE_PLAYER_OPTION
 *     maps the end-of-retail option onto the options word, whose bits are 1999's), 0x1D Swear /
 *     0x1E Break allegiance {guid}, 0xA4 Dismiss / 0xA5 Recruit {guid}, 0xA6 FellowshipUpdate {i32},
 *     0xAA BookData {book}, 0xAC BookAddPage {book}, 0xAD BookDeletePage / 0xAE BookPageData
 *     {book, i32 page}, 0x145 AddChannel / 0x146 RemoveChannel / 0x148 ListChannels {channel},
 *     0x149 IndexChannels {}, 0x19D RemoveShortCut {index}
 *   0x1A1 SetCharacterOptions  EoL {flags, options1, …PlayerModule tail} → 1999 {u32 options}: the
 *        1999 handler reads ONE dword, the whole options word (CharacterOptions1's bits)
 *   0xA2 FellowshipCreate  EoL {String16 name, u32 shareXP} → 1999 {AcString name}: the server takes
 *        shareXP from the player's FellowshipShareXP option
 *   0xA3 FellowshipQuit  EoL {u32 disband} → 1999 {} (no disband: a disband is not sent)
 *   0xAB BookModifyPage  {book, i32 page, String16} → {book, i32 page, AcString}
 *   0x58 ModifyCharacterSquelch  EoL {add, guid, String16 name, chatType} → 1999 by id 0x5A add /
 *        0x5B remove {guid}, or by name 0x58 add / 0x59 remove {AcString}; 1999 squelches every channel
 *   0x18 AddFriend {String16} / 0x25 RemoveAllFriends {} → the 1999 top-level 0xF7CD FriendsCommand
 *        {u32 command, AcString name} (1 add, 3 remove all); 0x17 RemoveFriend {guid} is not sent:
 *        1999 removes by name only (the page sends 0xF7CD itself, see below)
 *   0x19C AddShortCut  EoL {index, objectId, u16 spell, u16 layer} → 1999 {index, objectId, u32 spell}
 *        (ShortCutData; the 1999 tray is slots 0-8, others are not sent)
 *   0x1C2 QueryAge / 0x1C4 QueryBirth  EoL {String16 target} → 1999 {u32 target}: the server reads a
 *        dword and ignores it (answers for the caller)
 *   0xD6 AdvocateTeleport  {String16 target, Position} → {AcString, Position}
 *   0x140 AbuseLogRequest  {String16 name, u32 status, String16 text} → AcStrings (the server ignores it)
 *
 * Top-level, client → server (group 6)
 *   0xF7CD FriendsCommand  the page builds {u32 command, String16 name} (buildFriendsCommand1999) on a
 *        1999 world only, for @friends; → {u32 command, AcString name}
 *
 * ── Server → client ───────────────────────────────────────────────────────
 * The server sends these with event=TRUE (0xF7B0-wrapped, keyed by inner type); each is also
 * registered flat, enveloped from the player module's session state.
 *   0xAF FellowshipUpdate {PackableHashTable<u32, Fellow{u16 cp, u16 level, AcString name}>,
 *        AcString name, u32 leader} → 0x2BE FellowshipFullUpdate (no vitals, lum, share flags,
 *        departed table: zeros / empty)
 *   0xB0 UpdateFellow {u32 guid, Fellow} → 0x2C0 FellowshipUpdateFellow (updateType 1 Full)
 *   0xA7 QuitFellowship {u32 guid} → 0xA3 FellowshipQuit; 0xB1 DismissFellow {u32} → 0xA4;
 *   0xB3 DisbandFellowship {} → 0x2BF
 *   0xB5 / 0xB6 / 0xB7 Book Modify / Add / Delete page response {book, i32 page, u32 ok} → same
 *   0xB8 BookPageDataResponse {book, i32 page, PageData1999{authorId, AcString author, AcString
 *        account, i32 textIncluded, [AcString text]}} → EoL PageData (String16, the 0xFFFF0002 marker,
 *        ignoreAuthor 0)
 *   0x5A / 0x5B SquelchList add / remove {AcString name, u32 id} (flat) → the end-of-retail full
 *        snapshot 0x1F4 SetSquelchDB (this module keeps the list; 1999 squelches all channels) and the
 *        1999 line "You have squelched <name>." / "You have un-squelched <name>." when it changed
 * Flat, direct (GDLE leftovers, already end-of-retail layout → passed through):
 *   0xF7C1 AccountBanned {u32 seconds, String16}, 0xF7DC AccountBoot {u32 0}
 */
import { ChatMessageType, SquelchMask } from '@ac/shared';
import { BinaryReader, BinaryWriter, FELLOW_FIELD_NOT_CARRIED } from '../../MessageSerializer.js';
import { Group1999, eol, type AdapterContext, type Codecs1999, type InboundCodec, type Outbound1999, type OutboundCodec } from '../Adapter1999.js';
import { Reader1999, Writer1999 } from '../Wire1999.js';
import type { Player1999State } from './Player1999.js';

/** The 1999 top-level @friends message (KB 0xF7CD-FriendsCommand; Client.cpp FRIENDS_COMMAND_OPCODE). */
export const FRIENDS_COMMAND_1999 = 0xf7cd;
/** FriendsCommand commands: 0 list, 1 add, 2 remove, 3 remove all. */
export const FriendsCommand1999 = { List: 0, Add: 1, Remove: 2, RemoveAll: 3 } as const;

/**
 * The page's FriendsCommand for a 1999 world (EoL framing: [u32 0xF7CD][u32 command][String16 name]);
 * the adapter turns the name into an AcString. Only a 1999 world's page sends it.
 */
export function buildFriendsCommand1999(command: number, name = ''): Uint8Array {
  return eol(FRIENDS_COMMAND_1999, (w) => { w.writeUInt32(command); w.writeString16(name); });
}

/**
 * The 1999 client's @friends rules (kb 0xF7CD-FriendsCommand, CmdHandlers_DoFriends / DoFriendsAdd /
 * DoFriendsRemove): `sub` is the word after /friends (or add / remove for /friends_add, _remove).
 * add / remove strip one leading '+', cut the name to 32 characters and trim trailing spaces, and an
 * empty name sends nothing (null); remove "all" (exact, case-sensitive) is remove-all; any other
 * word, or none, lists.
 */
export function friendsCommand1999Plan(sub: string, nameArg: string): { command: number; name: string } | null {
  if (sub !== 'add' && sub !== 'remove') return { command: FriendsCommand1999.List, name: '' };
  if (sub === 'remove' && nameArg === 'all') return { command: FriendsCommand1999.RemoveAll, name: '' };
  const name = (nameArg.startsWith('+') ? nameArg.slice(1) : nameArg).slice(0, 32).replace(/\s+$/, '');
  if (!name) return null;
  return { command: sub === 'add' ? FriendsCommand1999.Add : FriendsCommand1999.Remove, name };
}

/** The 1999 shortcut tray's slots (KB Character/0x19C: index 0–8). */
const SHORTCUT_SLOTS_1999 = 9;

const EOL_EVENT = {
  FellowshipQuit: 0xa3, FellowshipDismiss: 0xa4, FellowshipFullUpdate: 0x2be, FellowshipDisband: 0x2bf,
  FellowshipUpdateFellow: 0x2c0, SetSquelchDB: 0x1f4,
} as const;

export interface Misc1999Options {
  /** The player's session state (guid, event sequence), read lazily: flat events are enveloped from it. */
  player?: () => Player1999State | null;
}

interface Fellow1999 { cp: number; level: number; name: string }

function readFellow1999(r: Reader1999): Fellow1999 {
  const cp = r.u16();
  const level = r.u16();
  return { cp, level, name: r.acString() };
}

/**
 * An end-of-retail Fellow (ACE Fellowship.cs): cp, lum, level, six vitals, shareLoot, String16 name.
 * 1999 has only cp, level, name: the vitals are written as FELLOW_FIELD_NOT_CARRIED, so the roster
 * says it lacks them and the fellowship rows draw no bars (not empty 0/0 ones).
 */
function writeFellowEoL(w: BinaryWriter, f: Fellow1999): void {
  w.writeUInt32(f.cp);
  w.writeUInt32(0); // lum: none in 1999
  w.writeUInt32(f.level);
  for (let i = 0; i < 6; i++) w.writeUInt32(FELLOW_FIELD_NOT_CARRIED); // max / current health, stamina, mana: not in the 1999 roster
  w.writeUInt32(0); // shareLoot
  w.writeString16(f.name);
}

export function registerMisc1999(c: Codecs1999, opts: Misc1999Options = {}): void {
  // ── Client → server ──
  const out = (type: number, codec: OutboundCodec) => c.outboundAction.set(type, codec);
  const typeOf = (m: Uint8Array): number => new DataView(m.buffer, m.byteOffset, m.byteLength).getUint32(8, true);
  /** A 1999 action of `type1999` with the EoL action's sequence; `build` writes the payload from the EoL reader (at the payload). */
  const action1999 = (m: Uint8Array, type1999: number, build?: (w: Writer1999, r: BinaryReader) => void): Outbound1999[] => {
    const r = new BinaryReader(m);
    r.readUInt32();
    const seq = r.readUInt32();
    r.readUInt32();
    const w = new Writer1999().u32(0xf7b1).u32(seq).u32(type1999);
    build?.(w, r);
    return [{ message: w.toBytes(), group: Group1999.ClientAction }];
  };
  /** A GameAction whose 1999 payload is end of retail's first `n` dwords. */
  const dwords = (n: number): OutboundCodec => (m) => {
    if (m.length < 12 + 4 * n) throw new RangeError(`action payload ${m.length - 12} bytes, expected ${4 * n}`);
    return [{ message: m.slice(0, 12 + 4 * n), group: Group1999.ClientAction }];
  };
  const friends = (command: number, name: string): Outbound1999[] => [{
    message: new Writer1999().u32(FRIENDS_COMMAND_1999).u32(command).acString(name).toBytes(),
    group: Group1999.ClientLogin,
  }];

  for (const [type, n] of [
    [0x05, 2], [0x1d, 1], [0x1e, 1], [0xa4, 1], [0xa5, 1], [0xa6, 1], [0xaa, 1], [0xac, 1], [0xad, 2], [0xae, 2],
    [0x145, 1], [0x146, 1], [0x148, 1], [0x149, 0],
  ] as const) out(type, dwords(n));

  out(0x1a1, (m) => action1999(m, 0x1a1, (w, r) => { r.readUInt32(); w.u32(r.readUInt32()); }));
  out(0xa2, (m) => action1999(m, 0xa2, (w, r) => { w.acString(r.readString16()); }));
  out(0xa3, (m, ctx) => {
    const disband = m.length >= 16 ? new DataView(m.buffer, m.byteOffset, m.byteLength).getUint32(12, true) : 0;
    if (disband) {
      ctx.log('[1999] fellowship disband has no 1999 counterpart (fellowshipLeadership); not sent');
      return null;
    }
    return action1999(m, 0xa3);
  });
  out(0xab, (m) => action1999(m, 0xab, (w, r) => { w.u32(r.readUInt32()); w.i32(r.readInt32()); w.acString(r.readString16()); }));

  out(0x58, (m, ctx) => {
    const r = new BinaryReader(m, 12);
    const add = r.readUInt32() !== 0;
    const guid = r.readUInt32();
    const name = r.readString16();
    const chatType = r.readUInt32();
    if (chatType !== ChatMessageType.AllChannels) ctx.log(`[1999] squelch of chat type ${chatType} squelches every channel in 1999`);
    if (guid) return action1999(m, add ? 0x5a : 0x5b, (w) => { w.u32(guid); });
    return action1999(m, add ? 0x58 : 0x59, (w) => { w.acString(name); });
  });

  out(0x18, (m) => friends(FriendsCommand1999.Add, new BinaryReader(m, 12).readString16()));
  out(0x25, () => friends(FriendsCommand1999.RemoveAll, ''));
  out(0x17, (_m, ctx) => {
    ctx.log('[1999] RemoveFriend by guid: 1999 removes friends by name (@friends remove); not sent');
    return null;
  });
  c.outbound.set(FRIENDS_COMMAND_1999, (m) => {
    const r = new BinaryReader(m, 4);
    const command = r.readUInt32();
    return friends(command, r.remaining >= 2 ? r.readString16() : '');
  });

  out(0x19c, (m, ctx) => {
    const r = new BinaryReader(m, 12);
    const index = r.readUInt32();
    const objectId = r.readUInt32();
    const spell = r.readUInt16();
    if (index >= SHORTCUT_SLOTS_1999) {
      ctx.log(`[1999] shortcut slot ${index} is past the 1999 tray (0-8); not sent`);
      return null;
    }
    return action1999(m, 0x19c, (w) => { w.u32(index).u32(objectId).u32(spell); });
  });
  out(0x19d, (m, ctx) => {
    const index = new DataView(m.buffer, m.byteOffset, m.byteLength).getUint32(12, true);
    if (index >= SHORTCUT_SLOTS_1999) {
      ctx.log(`[1999] shortcut slot ${index} is past the 1999 tray (0-8); not sent`);
      return null;
    }
    return dwords(1)(m, ctx);
  });

  for (const type of [0x1c2, 0x1c4]) out(type, (m) => action1999(m, typeOf(m), (w) => { w.u32(0); }));

  out(0xd6, (m) => action1999(m, 0xd6, (w, r) => {
    w.acString(r.readString16());
    for (let i = 0; i < 8; i++) w.u32(r.readUInt32()); // cell, origin, quaternion w/x/y/z
  }));
  out(0x140, (m) => action1999(m, 0x140, (w, r) => {
    w.acString(r.readString16());
    w.u32(r.readUInt32());
    w.acString(r.readString16());
  }));

  // ── Server → client ──
  const flatEnvelope = (ctx: AdapterContext, op: number): { guid: number; sequence: number } => {
    const st = opts.player?.() ?? null;
    if (!st || !st.guid) ctx.log(`[1999] flat 0x${op.toString(16)} before the player guid was known; event guid 0`);
    return { guid: st?.guid ?? 0, sequence: st ? ++st.eventSequence : 0 };
  };
  const eolEvent = (env: { guid: number; sequence: number }, type: number, build?: (w: BinaryWriter) => void): Uint8Array =>
    eol(0xf7b0, (w) => { w.writeUInt32(env.guid); w.writeUInt32(env.sequence); w.writeUInt32(type); build?.(w); });
  /** Register a 1999 event both 0xF7B0-wrapped (by inner type) and flat (by opcode); `body` writes the EoL payload. */
  const both = (op: number, type: number, body: (r: Reader1999) => ((w: BinaryWriter) => void) | undefined) => {
    c.inbound.set(op, (r, ctx) => {
      const build = body(r);
      return [eolEvent(flatEnvelope(ctx, op), type, build)];
    });
    c.inboundEvent.set(op, (r) => {
      const guid = r.u32();
      const sequence = r.u32();
      r.u32(); // inner type
      return [eolEvent({ guid, sequence }, type, body(r))];
    });
  };

  both(0xaf, EOL_EVENT.FellowshipFullUpdate, (r) => {
    const count = r.u16();
    const buckets = r.u16();
    const fellows = Array.from({ length: count }, () => ({ guid: r.u32(), fellow: readFellow1999(r) }));
    const name = r.acString();
    const leader = r.u32();
    return (w) => {
      w.writeUInt16(fellows.length);
      w.writeUInt16(buckets);
      for (const f of fellows) { w.writeUInt32(f.guid); writeFellowEoL(w, f.fellow); }
      w.writeString16(name);
      w.writeUInt32(leader);
      // shareXP, evenShare: not in 1999 (the server reads the leader's option), so not carried: the
      // rows show no XP share. open, locked: 0 (no openness or locks in 1999; their controls are hidden).
      w.writeUInt32(FELLOW_FIELD_NOT_CARRIED); w.writeUInt32(FELLOW_FIELD_NOT_CARRIED);
      w.writeUInt32(0); w.writeUInt32(0);
      w.writeUInt16(0); w.writeUInt16(32); // empty departed table
      w.writeUInt16(0); w.writeUInt16(32); // empty locks table
    };
  });
  both(0xb0, EOL_EVENT.FellowshipUpdateFellow, (r) => {
    const guid = r.u32();
    const fellow = readFellow1999(r);
    return (w) => { w.writeUInt32(guid); writeFellowEoL(w, fellow); w.writeUInt32(1); /* Full */ };
  });
  both(0xa7, EOL_EVENT.FellowshipQuit, (r) => { const guid = r.u32(); return (w) => w.writeUInt32(guid); });
  both(0xb1, EOL_EVENT.FellowshipDismiss, (r) => { const guid = r.u32(); return (w) => w.writeUInt32(guid); });
  both(0xb3, EOL_EVENT.FellowshipDisband, () => undefined);

  for (const op of [0xb5, 0xb6, 0xb7]) {
    both(op, op, (r) => {
      const book = r.u32();
      const page = r.i32();
      const ok = r.u32();
      return (w) => { w.writeUInt32(book); w.writeInt32(page); w.writeUInt32(ok); };
    });
  }
  both(0xb8, 0xb8, (r) => {
    const book = r.u32();
    const page = r.i32();
    const authorId = r.u32();
    const author = r.acString();
    const account = r.acString();
    const textIncluded = r.i32();
    const text = textIncluded ? r.acString() : '';
    return (w) => {
      w.writeUInt32(book);
      w.writeInt32(page);
      w.writeUInt32(authorId);
      w.writeString16(author);
      w.writeString16(account);
      w.writeUInt32(0xffff0002);
      w.writeUInt32(textIncluded ? 1 : 0);
      w.writeUInt32(0); // ignoreAuthor: not in 1999
      if (textIncluded) w.writeString16(text);
    };
  });

  // Squelch list: 1999's is a list of ids the server adds to / removes from one at a time.
  const squelched = new Map<number, string>();
  const squelchDb = (env: { guid: number; sequence: number }): Uint8Array => eolEvent(env, EOL_EVENT.SetSquelchDB, (w) => {
    w.writeUInt16(0); w.writeUInt16(0); // no account squelches
    w.writeUInt16(squelched.size); w.writeUInt16(32);
    for (const [id, name] of squelched) {
      w.writeUInt32(id);
      w.writeUInt32(1); w.writeUInt32(SquelchMask.AllChannels);
      w.writeString16(name);
      w.writeUInt32(0); // not an account squelch
    }
    w.writeUInt32(0); w.writeString16(''); w.writeUInt32(0); // no global filter
  });
  const squelchCodec = (added: boolean): ((r: Reader1999, env: () => { guid: number; sequence: number }) => Uint8Array[]) => (r, env) => {
    const name = r.acString();
    const id = r.u32();
    if (added === squelched.has(id)) return []; // no change: the 1999 client does nothing, silently
    if (added) squelched.set(id, name); else squelched.delete(id);
    const line = added ? `You have squelched ${name}.` : `You have un-squelched ${name}.`;
    return [squelchDb(env()), eol(0xf7e0, (w) => { w.writeString16(line); w.writeUInt32(ChatMessageType.Broadcast); })];
  };
  for (const [op, added] of [[0x5a, true], [0x5b, false]] as const) {
    const codec = squelchCodec(added);
    c.inbound.set(op, (r, ctx) => codec(r, () => flatEnvelope(ctx, op)));
    c.inboundEvent.set(op, (r) => {
      const guid = r.u32();
      const sequence = r.u32();
      r.u32();
      return codec(r, () => ({ guid, sequence }));
    });
  }

  const pass: InboundCodec = (_r, _ctx, raw) => [raw.slice()];
  c.inbound.set(0xf7c1, pass);
  c.inbound.set(0xf7dc, pass);
}
