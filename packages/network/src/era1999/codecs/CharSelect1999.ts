/**
 * Milestone M1 of the 1999 adapter: login and character select
 * (docs/ac1999-support.md). Layouts from the real client's capture
 * (tests/fixtures/ac1999-session-001.jsonl.gz) and the AC1999 server
 * (Client.cpp, PhatSDK/ACCharGenResult.cpp).
 *
 * Server → client
 *   0xF658 CharacterList  1999: u32 count, u32 0, count × {u32 slot, u32 guid, AcString name, u32 deleteTimeout},
 *                         u32 0, char[20] account, u32 0
 *                         EoL:  u32 0, u32 count, {u32 guid, String16 name, u32 deleteTime}, u32 0,
 *                         u32 slotCount, String16 account, u32 useTurbineChat, u32 hasThroneOfDestiny
 *   0xF643 CharacterCreateResponse  1999: u32 code (1 = ok), then {u32 guid, AcString name, u32 timeout}
 *                                   EoL:  u32 code, u32 guid, String16 name
 *   0xF7C7 → 0xF7DF CharacterEnterWorldServerReady (the 1999 two-phase enter's "go")
 *   0xF65A char-select news (two AcStrings; the client shows the second) — no EoL counterpart: logged
 *   0xF653 CharacterLogOff acknowledgement — same opcode, empty
 *   0xF655 CharacterDelete acknowledgement — same opcode, empty (Client.cpp DeleteCharacter)
 *
 * Client → server (group 6)
 *   0xF656 CharacterCreate  EoL: String16 account, u32 1, heritage (1..3), gender (1 M / 2 F),
 *                           14 appearance u32, 6 f64 shades, i32 template, 6 attributes,
 *                           u32 slot, u32 class, u32 n + n skill classes, String16 name,
 *                           u32 startArea, u32 isAdmin, u32 isSentinel
 *                           1999: FixedBlob28 account, u32 1, heritage INDEX (0..2), gender INDEX
 *                           (0 F / 1 M), the same appearance/shades/template/attributes, u32 playerID,
 *                           u32 requestedAccess, i32 n + n skill classes, AcString name,
 *                           u32 0xFFFFFFFF, u32 ?, u32 startArea (0..17), u32 ?
 *   0xF7C8 CharacterEnterWorldRequest — same, empty
 *   0xF657 CharacterEnterWorld  EoL: u32 guid, String16 account  →  1999: u32 guid, FixedBlob28 account
 *   0xF653 CharacterLogOff — same opcode
 *   0xF655 CharacterDelete  EoL: String16 account, u32 slot  →  1999: FixedBlob28 account, i32 slot
 *                           (Client.cpp checks the 0xBEEFBEEF marker, skips the name, reads the slot,
 *                           an index into the list it sent, in the order the 0xF658 codec keeps)
 */
import { BinaryReader } from '../../MessageSerializer.js';
import { Group1999, eol, type Codecs1999 } from '../Adapter1999.js';
import { Writer1999 } from '../Wire1999.js';

/** The 1999 character select has five slots. */
export const CHARACTER_SLOTS_1999 = 5;

export function registerCharSelect1999(c: Codecs1999): void {
  c.inbound.set(0xf658, (r) => {
    const count = r.u32();
    r.u32();
    // Each entry is led by its slot index (Client.cpp writes slot++ before WriteCharListEntry;
    // the server's "entryForm=(guid,acstring,timeout)" log names only the entry after it).
    const chars = Array.from({ length: count }, () => { r.u32(); return { guid: r.u32(), name: r.acString(), timeout: r.u32() }; });
    r.u32();
    const account = r.fixedName(20);
    return [eol(0xf658, (w) => {
      w.writeUInt32(0);
      w.writeUInt32(chars.length);
      for (const ch of chars) { w.writeUInt32(ch.guid); w.writeString16(ch.name); w.writeUInt32(ch.timeout); }
      w.writeUInt32(0);
      w.writeUInt32(CHARACTER_SLOTS_1999);
      w.writeString16(account);
      w.writeUInt32(0); // no TurbineChat in 1999
      w.writeUInt32(0); // no Throne of Destiny
    })];
  });

  c.inbound.set(0xf643, (r) => {
    const code = r.u32();
    if (code !== 1 || r.remaining < 4) return [eol(0xf643, (w) => w.writeUInt32(code))];
    const guid = r.u32();
    const name = r.acString();
    return [eol(0xf643, (w) => { w.writeUInt32(code); w.writeUInt32(guid); w.writeString16(name); })];
  });

  c.inbound.set(0xf7c7, () => [eol(0xf7df)]);
  // CharacterError: {u32 code}, as end of retail (ClientEvents.cpp LoginError; GDLE's code numbering).
  c.inbound.set(0xf659, (r) => [eol(0xf659, (w) => w.writeUInt32(r.u32()))]);
  c.inbound.set(0xf653, () => [eol(0xf653)]);
  c.inbound.set(0xf655, () => [eol(0xf655)]);
  c.inbound.set(0xf65a, (r, ctx) => {
    r.acString();
    const news = r.acString();
    ctx.log(`[1999] char-select news: ${news.split('\n')[0]}`);
    return [];
  });

  c.outbound.set(0xf656, (m) => {
    const r = new BinaryReader(m);
    r.readUInt32();
    const account = r.readString16();
    const version = r.readUInt32();
    const heritage = r.readUInt32();
    const gender = r.readUInt32();
    const w = new Writer1999().u32(0xf656).fixedAccount(account).u32(version);
    w.u32(Math.max(0, heritage - 1)); // EoL HeritageGroup 1..3 → 1999 index 0..2
    w.u32(gender === 2 ? 0 : 1); // EoL 1 Male / 2 Female → 1999 index 0 Female / 1 Male
    for (let i = 0; i < 14; i++) w.u32(r.readUInt32());
    for (let i = 0; i < 6; i++) w.f64(r.readFloat64());
    w.i32(r.readInt32()); // template
    for (let i = 0; i < 6; i++) w.i32(r.readInt32()); // attributes
    r.readUInt32(); // slot
    r.readUInt32(); // class
    w.u32(0); // playerID
    w.u32(1); // requestedAccess, as the real client sends (the server ignores it)
    const n = r.readUInt32();
    w.i32(n);
    for (let i = 0; i < n; i++) w.u32(r.readUInt32());
    w.acString(r.readString16());
    const startArea = r.readUInt32();
    w.u32(0xffffffff).u32(0).u32(startArea).u32(0);
    return [{ message: w.toBytes(), group: Group1999.ClientLogin }];
  });

  c.outbound.set(0xf7c8, () => [{ message: new Writer1999().u32(0xf7c8).toBytes(), group: Group1999.ClientLogin }]);

  c.outbound.set(0xf657, (m) => {
    const r = new BinaryReader(m);
    r.readUInt32();
    const guid = r.readUInt32();
    const account = r.readString16();
    return [{ message: new Writer1999().u32(0xf657).u32(guid).fixedAccount(account).toBytes(), group: Group1999.ClientLogin }];
  });

  c.outbound.set(0xf655, (m) => {
    const r = new BinaryReader(m);
    r.readUInt32();
    const account = r.readString16();
    const slot = r.readUInt32();
    return [{ message: new Writer1999().u32(0xf655).fixedAccount(account).i32(slot).toBytes(), group: Group1999.ClientLogin }];
  });

  c.outbound.set(0xf653, () => [{ message: new Writer1999().u32(0xf653).toBytes(), group: Group1999.ClientLogin }]);
}
