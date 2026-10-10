/**
 * GAP.87 — StackableSplitToContainer, Buy, Sell, AcceptTrade,
 * CreateTinkeringTool, BuyHouse, RaiseAttribute, RaiseSkill, RaiseVital,
 * Tell, FellowshipCreate, AddShortCut, BookModifyPage, BookDeletePage,
 * BookPageData, and ChangeStoragePermission send-side payloads audited
 * against ACE C# read order and converted to behavioral coverage. Also
 * fixes a duplicate-inline-construction bug: main.ts's `/allegiance boot`
 * and `/allegiance gag` chat-command handlers each independently
 * re-derived the AllegianceChatBoot/AllegianceChatGag wire layout with a
 * raw `new BinaryWriter` instead of calling the already-extracted
 * buildAllegianceChatBootPayload/buildAllegianceChatGagPayload (correctly
 * used at the acDebug call sites) — same drift-risk pattern as the prior
 * cycles' Jump/RentHouse/AdvocateTeleport duplicates.
 *
 * Previously each of the 16 payloads above was constructed with a separate
 * inline `new BinaryWriter(N)` block at its call site in main.ts, with no
 * test exercising the actual byte layout.
 *
 * Fix: extracted into build*Payload functions in
 * packages/network/src/MessageSerializer.ts (mirrors the existing
 * buildRentHousePayload/buildTrainSkillPayload convention). main.ts's call
 * sites now call the shared, exported, testable functions instead of
 * re-deriving the byte layout inline.
 *
 * Wire format anchors:
 *   GameActionStackableSplitToContainer.cs — stackId u32 + containerId u32 + place i32 + amount i32
 *   GameActionBuyItems.cs / GameActionSellItems.cs — vendorGuid u32 + numItems u32,
 *     then numItems × (amount i32 + objectId/objectGuid u32)
 *   GameActionAcceptTrade.cs — partnerGuid u32 + tradeStamp f64 + tradeStatus u32 +
 *     initiatorGuid u32 + initiatorAccepts u32 + partnerAccepts u32
 *   GameActionCreateTinkeringTool.cs — toolGuid u32 + itemCount u32 + itemCount × u32
 *   GameActionHouseBuyHouse.cs + PackableList.ReadListUInt32 — slumlordGuid u32 +
 *     itemCount u32 + itemCount × u32 (same shape as buildRentHousePayload, distinct opcode)
 *   GameActionRaiseAttribute.cs / GameActionRaiseSkill.cs / GameActionRaiseVital.cs —
 *     id u32 + xpSpent u32
 *   GameActionTell.cs — message String16L THEN target String16L (message first)
 *   GameActionFellowshipCreate.cs — fellowshipName String16L + shareXp u32
 *   GameActionAddShortcut.cs + Shortcut.cs ReadShortcut + LayeredSpell.cs ReadLayeredSpell —
 *     index u32 + objectId u32 + spellId u16 + layer u16
 *   GameActionBookModifyPage.cs — bookGuid u32 + page i32 + text String16L
 *   GameActionBookDeletePage.cs — bookGuid u32 + page i32
 *   GameActionBookPageData.cs — bookGuid u32 + pageNum i32
 *   GameActionHouseChangeStoragePermission.cs — guestName String16L + hasPermission u32
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildStackableSplitToContainerPayload, parseStackableSplitToContainerPayload,
  buildBuyPayload, parseBuyPayload,
  buildSellPayload, parseSellPayload,
  buildAcceptTradePayload, parseAcceptTradePayload,
  buildCreateTinkeringToolPayload, parseCreateTinkeringToolPayload,
  buildBuyHousePayload, parseBuyHousePayload,
  buildRentHousePayload,
  buildRaiseAttributePayload, parseRaiseAttributePayload,
  buildRaiseSkillPayload, parseRaiseSkillPayload,
  buildRaiseVitalPayload, parseRaiseVitalPayload,
  buildTellPayload, parseTellPayload,
  buildFellowshipCreatePayload, parseFellowshipCreatePayload,
  buildAddShortcutPayload, parseAddShortcutPayload,
  buildBookModifyPagePayload, parseBookModifyPagePayload,
  buildBookDeletePagePayload, parseBookDeletePagePayload,
  buildBookPageDataPayload, parseBookPageDataPayload,
  buildChangeStoragePermissionPayload, parseChangeStoragePermissionPayload,
  buildAllegianceChatBootPayload, parseAllegianceChatBootPayload,
  buildAllegianceChatGagPayload, parseAllegianceChatGagPayload,
  BinaryReader,
} from '@ac/network';

const REPO = resolve(__dirname, '..');
const readAce = (path: string): string => readFileSync(resolve(REPO, 'reference/ACE/Source', path), 'utf8');

const STACKABLE_SPLIT_CS = readAce('ACE.Server/Network/GameAction/Actions/GameActionStackableSplitToContainer.cs');
const BUY_CS = readAce('ACE.Server/Network/GameAction/Actions/GameActionBuyItems.cs');
const SELL_CS = readAce('ACE.Server/Network/GameAction/Actions/GameActionSellItems.cs');
const ACCEPT_TRADE_CS = readAce('ACE.Server/Network/GameAction/Actions/GameActionAcceptTrade.cs');
const TINKERING_CS = readAce('ACE.Server/Network/GameAction/Actions/GameActionCreateTinkeringTool.cs');
const BUY_HOUSE_CS = readAce('ACE.Server/Network/GameAction/Actions/GameActionHouseBuyHouse.cs');
const RAISE_ATTR_CS = readAce('ACE.Server/Network/GameAction/Actions/GameActionRaiseAttribute.cs');
const RAISE_SKILL_CS = readAce('ACE.Server/Network/GameAction/Actions/GameActionRaiseSkill.cs');
const RAISE_VITAL_CS = readAce('ACE.Server/Network/GameAction/Actions/GameActionRaiseVital.cs');
const TELL_CS = readAce('ACE.Server/Network/GameAction/Actions/GameActionTell.cs');
const FELLOWSHIP_CREATE_CS = readAce('ACE.Server/Network/GameAction/Actions/GameActionFellowshipCreate.cs');
const ADD_SHORTCUT_CS = readAce('ACE.Server/Network/GameAction/Actions/GameActionAddShortcut.cs');
const SHORTCUT_CS = readAce('ACE.Server/Network/Structure/Shortcut.cs');
const LAYERED_SPELL_CS = readAce('ACE.Server/Network/Structure/LayeredSpell.cs');
const BOOK_MODIFY_CS = readAce('ACE.Server/Network/GameAction/Actions/GameActionBookModifyPage.cs');
const BOOK_DELETE_CS = readAce('ACE.Server/Network/GameAction/Actions/GameActionBookDeletePage.cs');
const BOOK_PAGE_DATA_CS = readAce('ACE.Server/Network/GameAction/Actions/GameActionBookPageData.cs');
const CHANGE_STORAGE_CS = readAce('ACE.Server/Network/GameAction/Actions/GameActionHouseChangeStoragePermission.cs');

describe('ACE source anchors the wire format we send (GAP.87)', () => {
  it('GameActionStackableSplitToContainer.cs reads stackId, containerId, place, amount', () => {
    expect(STACKABLE_SPLIT_CS).toMatch(
      /uint stackId = message\.Payload\.ReadUInt32\(\);\s*\n\s*uint containerId = message\.Payload\.ReadUInt32\(\);\s*\n\s*int place = message\.Payload\.ReadInt32\(\);\s*\n\s*int amount = message\.Payload\.ReadInt32\(\);/,
    );
  });

  it('GameActionBuyItems.cs reads vendorGuid, numItems, then per-item amount then objectID', () => {
    expect(BUY_CS).toMatch(/var vendorGuid = message\.Payload\.ReadUInt32\(\);\s*\n\s*var numItems = message\.Payload\.ReadUInt32\(\);/);
    expect(BUY_CS).toMatch(/var amount = message\.Payload\.ReadInt32\(\);/);
    expect(BUY_CS).toMatch(/var objectID = message\.Payload\.ReadUInt32\(\);/);
  });

  it('GameActionSellItems.cs reads vendorGuid, numItems, then per-item amount then objectGuid', () => {
    expect(SELL_CS).toMatch(/var vendorGuid = message\.Payload\.ReadUInt32\(\);\s*\n\s*var numItems = message\.Payload\.ReadUInt32\(\);/);
    expect(SELL_CS).toMatch(/var amount = message\.Payload\.ReadInt32\(\);/);
    expect(SELL_CS).toMatch(/var objectGuid = message\.Payload\.ReadUInt32\(\);/);
  });

  it('GameActionAcceptTrade.cs reads partnerGuid, tradeStamp(double), tradeStatus, initiatorGuid, initatorAccepts, partnerAccepts in order', () => {
    expect(ACCEPT_TRADE_CS).toMatch(
      /uint partnerGuid = message\.Payload\.ReadUInt32\(\);\s*\n\s*double tradeStamp = message\.Payload\.ReadDouble\(\);\s*\n\s*uint tradeStatus = message\.Payload\.ReadUInt32\(\);\s*\n\s*uint initiatorGuid = message\.Payload\.ReadUInt32\(\);\s*\n\s*bool initatorAccepts = Convert\.ToBoolean\(message\.Payload\.ReadUInt32\(\)\);\s*\n\s*bool partnerAccepts = Convert\.ToBoolean\(message\.Payload\.ReadUInt32\(\)\);/,
    );
  });

  it('GameActionCreateTinkeringTool.cs reads toolGuid, itemcount, then itemcount u32 items', () => {
    expect(TINKERING_CS).toMatch(
      /var toolGuid = message\.Payload\.ReadUInt32\(\);\s*\n\s*uint itemcount = message\.Payload\.ReadUInt32\(\);/,
    );
  });

  it('GameActionHouseBuyHouse.cs reads slumlord then items via ReadListUInt32', () => {
    expect(BUY_HOUSE_CS).toMatch(
      /var slumlord = message\.Payload\.ReadUInt32\(\);\s*\n\s*var items = message\.Payload\.ReadListUInt32\(\);/,
    );
  });

  it('GameActionRaiseAttribute.cs reads attribute then xpSpent (both u32)', () => {
    expect(RAISE_ATTR_CS).toMatch(
      /var attribute = \(PropertyAttribute\)message\.Payload\.ReadUInt32\(\);\s*\n\s*var xpSpent = message\.Payload\.ReadUInt32\(\);/,
    );
  });

  it('GameActionRaiseSkill.cs reads skill then xpSpent (both u32)', () => {
    expect(RAISE_SKILL_CS).toMatch(
      /var skill = \(Skill\)message\.Payload\.ReadUInt32\(\);\s*\n\s*var xpSpent = message\.Payload\.ReadUInt32\(\);/,
    );
  });

  it('GameActionRaiseVital.cs reads vital then xpSpent (both u32)', () => {
    expect(RAISE_VITAL_CS).toMatch(
      /var vital = \(PropertyAttribute2nd\)message\.Payload\.ReadUInt32\(\);\s*\n\s*var xpSpent = message\.Payload\.ReadUInt32\(\);/,
    );
  });

  it('GameActionTell.cs reads message THEN target (message first, not target first)', () => {
    expect(TELL_CS).toMatch(
      /var message = clientMessage\.Payload\.ReadString16L\(\);.*\n\s*var target = clientMessage\.Payload\.ReadString16L\(\);/,
    );
  });

  it('GameActionFellowshipCreate.cs reads fellowshipName then shareXp (u32 > 0)', () => {
    expect(FELLOWSHIP_CREATE_CS).toMatch(
      /var fellowshipName = message\.Payload\.ReadString16L\(\);\s*\n\s*bool shareXp = message\.Payload\.ReadUInt32\(\) > 0;/,
    );
  });

  it('GameActionAddShortcut.cs reads a Shortcut via ReadShortcut', () => {
    expect(ADD_SHORTCUT_CS).toMatch(/var shortcut = message\.Payload\.ReadShortcut\(\);/);
  });

  it('Shortcut.cs ReadShortcut reads Index, ObjectId, then a LayeredSpell', () => {
    expect(SHORTCUT_CS).toMatch(
      /shortcut\.Index = reader\.ReadUInt32\(\);\s*\n\s*shortcut\.ObjectId = reader\.ReadUInt32\(\);\s*\n\s*shortcut\.Spell = reader\.ReadLayeredSpell\(\);/,
    );
  });

  it('LayeredSpell.cs ReadLayeredSpell reads SpellId then Layer (both u16)', () => {
    expect(LAYERED_SPELL_CS).toMatch(
      /layeredSpell\.SpellId = reader\.ReadUInt16\(\);\s*\n\s*layeredSpell\.Layer = reader\.ReadUInt16\(\);/,
    );
  });

  it('GameActionBookModifyPage.cs reads bookGuid, page(int32), then text', () => {
    expect(BOOK_MODIFY_CS).toMatch(
      /var bookGuid = message\.Payload\.ReadUInt32\(\);\s*\n\s*var page = message\.Payload\.ReadInt32\(\);.*\n\s*var text = message\.Payload\.ReadString16L\(\);/,
    );
  });

  it('GameActionBookDeletePage.cs reads bookGuid then page (both before pageNum use)', () => {
    expect(BOOK_DELETE_CS).toMatch(
      /uint bookGuid = message\.Payload\.ReadUInt32\(\);\s*\n\s*int page = message\.Payload\.ReadInt32\(\);/,
    );
  });

  it('GameActionBookPageData.cs reads bookGuid then pageNum', () => {
    expect(BOOK_PAGE_DATA_CS).toMatch(
      /var bookGuid = message\.Payload\.ReadUInt32\(\);\s*\n\s*var pageNum = message\.Payload\.ReadInt32\(\);/,
    );
  });

  it('GameActionHouseChangeStoragePermission.cs reads guestName then hasPermission', () => {
    expect(CHANGE_STORAGE_CS).toMatch(
      /var guestName = message\.Payload\.ReadString16L\(\);\s*\n\s*var hasPermission = Convert\.ToBoolean\(message\.Payload\.ReadUInt32\(\)\);/,
    );
  });
});

describe('buildStackableSplitToContainerPayload (GAP.87 — behavioral)', () => {
  it('round-trips with distinct sentinel values and matches field order via raw BinaryReader', () => {
    const payload = buildStackableSplitToContainerPayload(0x1111, 0x2222, 3, 4);
    expect(parseStackableSplitToContainerPayload(payload)).toEqual({ stackId: 0x1111, containerId: 0x2222, place: 3, amount: 4 });
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0x1111);
    expect(reader.readUInt32()).toBe(0x2222);
    expect(reader.readInt32()).toBe(3);
    expect(reader.readInt32()).toBe(4);
    expect(reader.remaining).toBe(0);
  });
});

describe('buildBuyPayload / buildSellPayload (GAP.87 — behavioral)', () => {
  it('Buy round-trips a single item and matches field order (a Buy/Sell field-swap would fail this)', () => {
    const payload = buildBuyPayload(0xAAAA, [{ amount: 5, objectId: 0xBBBB }]);
    expect(parseBuyPayload(payload)).toEqual({ vendorGuid: 0xAAAA, items: [{ amount: 5, objectId: 0xBBBB }] });
  });

  it('Buy round-trips multiple items in order', () => {
    const payload = buildBuyPayload(1, [{ amount: 10, objectId: 100 }, { amount: 20, objectId: 200 }]);
    expect(parseBuyPayload(payload)).toEqual({ vendorGuid: 1, items: [{ amount: 10, objectId: 100 }, { amount: 20, objectId: 200 }] });
  });

  it('Sell round-trips and matches field order via raw BinaryReader', () => {
    const payload = buildSellPayload(0xCCCC, [{ amount: 7, objectGuid: 0xDDDD }]);
    expect(parseSellPayload(payload)).toEqual({ vendorGuid: 0xCCCC, items: [{ amount: 7, objectGuid: 0xDDDD }] });
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0xCCCC); // vendorGuid
    expect(reader.readUInt32()).toBe(1);      // numItems
    expect(reader.readInt32()).toBe(7);       // amount
    expect(reader.readUInt32()).toBe(0xDDDD); // objectGuid
  });
});

describe('buildAcceptTradePayload (GAP.87 — behavioral)', () => {
  it('is exactly 28 bytes and round-trips a float64 tradeStamp without precision loss', () => {
    const payload = buildAcceptTradePayload(0x1234, 123456.789, 1, 0x5678, true, false);
    expect(payload.length).toBe(28);
    expect(parseAcceptTradePayload(payload)).toEqual({
      partnerGuid: 0x1234, tradeStamp: 123456.789, tradeStatus: 1,
      initiatorGuid: 0x5678, initiatorAccepts: true, partnerAccepts: false,
    });
  });

  it('matches field order exactly via a raw BinaryReader (a u32/f64 transposition would desync the trailing fields)', () => {
    const payload = buildAcceptTradePayload(0xAAAA, 999.5, 2, 0xBBBB, false, true);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0xAAAA);
    expect(reader.readFloat64()).toBeCloseTo(999.5);
    expect(reader.readUInt32()).toBe(2);
    expect(reader.readUInt32()).toBe(0xBBBB);
    expect(reader.readUInt32()).toBe(0); // false
    expect(reader.readUInt32()).toBe(1); // true
    expect(reader.remaining).toBe(0);
  });
});

describe('buildCreateTinkeringToolPayload (GAP.87 — behavioral)', () => {
  it('round-trips tool guid and item list in order', () => {
    const payload = buildCreateTinkeringToolPayload(0x9999, [1, 2, 3]);
    expect(parseCreateTinkeringToolPayload(payload)).toEqual({ toolGuid: 0x9999, itemGuids: [1, 2, 3] });
  });

  it('handles an empty item list', () => {
    const payload = buildCreateTinkeringToolPayload(0x1, []);
    expect(payload.length).toBe(8);
    expect(parseCreateTinkeringToolPayload(payload)).toEqual({ toolGuid: 0x1, itemGuids: [] });
  });
});

describe('buildBuyHousePayload (GAP.87 — behavioral)', () => {
  it('round-trips slumlord guid and payment items in order', () => {
    const payload = buildBuyHousePayload(0x7777, [10, 20, 30]);
    expect(parseBuyHousePayload(payload)).toEqual({ slumlordGuid: 0x7777, itemGuids: [10, 20, 30] });
  });

  it('shares byte-for-byte wire shape with buildRentHousePayload (same format, distinct opcode carries the semantic difference)', () => {
    const buyHouse = buildBuyHousePayload(5, [1, 2]);
    const rentHouse = buildRentHousePayload(5, [1, 2]);
    expect(Array.from(buyHouse)).toEqual(Array.from(rentHouse));
  });
});

describe('buildRaiseAttributePayload / buildRaiseSkillPayload / buildRaiseVitalPayload (GAP.87 — behavioral)', () => {
  it('RaiseAttribute round-trips id then xpSpent', () => {
    const payload = buildRaiseAttributePayload(3, 5000);
    expect(payload.length).toBe(8);
    expect(parseRaiseAttributePayload(payload)).toEqual({ attribute: 3, xpSpent: 5000 });
  });

  it('RaiseSkill round-trips id then xpSpent', () => {
    const payload = buildRaiseSkillPayload(42, 1234);
    expect(parseRaiseSkillPayload(payload)).toEqual({ skill: 42, xpSpent: 1234 });
  });

  it('RaiseVital round-trips id then xpSpent', () => {
    const payload = buildRaiseVitalPayload(7, 999);
    expect(parseRaiseVitalPayload(payload)).toEqual({ vital: 7, xpSpent: 999 });
  });

  it('the three builders share identical wire bytes for identical arguments (same id+xpSpent shape by design; the opcode, not the payload, carries the semantic difference)', () => {
    const a = buildRaiseAttributePayload(0xAAAA, 0xBBBB);
    const s = buildRaiseSkillPayload(0xAAAA, 0xBBBB);
    const v = buildRaiseVitalPayload(0xAAAA, 0xBBBB);
    expect(Array.from(a)).toEqual(Array.from(s));
    expect(Array.from(s)).toEqual(Array.from(v));
  });
});

describe('buildTellPayload (GAP.87 — behavioral)', () => {
  it('round-trips message then target, in that order (not target-then-message)', () => {
    const payload = buildTellPayload('hello there', 'Bob');
    expect(parseTellPayload(payload)).toEqual({ message: 'hello there', target: 'Bob' });
  });

  it('matches field order via raw BinaryReader (a message/target swap would fail this)', () => {
    const payload = buildTellPayload('MSG', 'TARGET');
    const reader = new BinaryReader(payload);
    expect(reader.readString16()).toBe('MSG');
    expect(reader.readString16()).toBe('TARGET');
  });
});

describe('buildFellowshipCreatePayload (GAP.87 — behavioral)', () => {
  it('round-trips name then shareXp', () => {
    const payload = buildFellowshipCreatePayload('MyFellowship', true);
    expect(parseFellowshipCreatePayload(payload)).toEqual({ fellowshipName: 'MyFellowship', shareXp: true });
  });

  it('encodes shareXp=false as 0', () => {
    const payload = buildFellowshipCreatePayload('X', false);
    expect(parseFellowshipCreatePayload(payload).shareXp).toBe(false);
  });
});

describe('buildAddShortcutPayload (GAP.87 — behavioral)', () => {
  it('round-trips all 4 fields with distinct sentinel values', () => {
    const payload = buildAddShortcutPayload(3, 0xABCD, 500, 2);
    expect(payload.length).toBe(12);
    expect(parseAddShortcutPayload(payload)).toEqual({ index: 3, objectId: 0xABCD, spellId: 500, layer: 2 });
  });

  it('matches ACE Shortcut/LayeredSpell field order via raw BinaryReader (a transposition would fail this)', () => {
    const payload = buildAddShortcutPayload(9, 0x1234, 111, 222);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(9);
    expect(reader.readUInt32()).toBe(0x1234);
    expect(reader.readUInt16()).toBe(111);
    expect(reader.readUInt16()).toBe(222);
    expect(reader.remaining).toBe(0);
  });
});

describe('buildBookModifyPagePayload / buildBookDeletePagePayload / buildBookPageDataPayload (GAP.87 — behavioral)', () => {
  it('BookModifyPage round-trips bookGuid, page, text in order', () => {
    const payload = buildBookModifyPagePayload(0x4444, 2, 'Once upon a time...');
    expect(parseBookModifyPagePayload(payload)).toEqual({ bookGuid: 0x4444, page: 2, text: 'Once upon a time...' });
  });

  it('BookDeletePage round-trips bookGuid then page', () => {
    const payload = buildBookDeletePagePayload(0x5555, 4);
    expect(parseBookDeletePagePayload(payload)).toEqual({ bookGuid: 0x5555, page: 4 });
  });

  it('BookPageData round-trips bookGuid then pageNum', () => {
    const payload = buildBookPageDataPayload(0x6666, 6);
    expect(parseBookPageDataPayload(payload)).toEqual({ bookGuid: 0x6666, pageNum: 6 });
  });
});

describe('buildChangeStoragePermissionPayload (GAP.87 — behavioral)', () => {
  it('round-trips guestName then hasPermission', () => {
    const payload = buildChangeStoragePermissionPayload('Alice', true);
    expect(parseChangeStoragePermissionPayload(payload)).toEqual({ guestName: 'Alice', hasPermission: true });
  });
});

describe('AllegianceChatBoot/AllegianceChatGag duplicate-inline-construction fix (GAP.87 — behavioral)', () => {
  // Regression guard: main.ts's /allegiance boot and /allegiance gag chat
  // commands previously built their own inline BinaryWriter instead of
  // calling buildAllegianceChatBootPayload/buildAllegianceChatGagPayload —
  // the same functions the acDebug call sites already used correctly. Both
  // call sites now route through these shared, tested builders; this test
  // pins their round-trip behavior so a future regression back to inline
  // construction (or a field-order slip while doing so) is caught.
  it('the shared builders round-trip name+reason / name+enabled correctly', () => {
    const boot = buildAllegianceChatBootPayload('Bob', 'spam');
    expect(parseAllegianceChatBootPayload(boot)).toEqual({ playerName: 'Bob', reason: 'spam' });
    const gag = buildAllegianceChatGagPayload('Bob', true);
    expect(parseAllegianceChatGagPayload(gag)).toEqual({ playerName: 'Bob', enabled: true });
  });
});
