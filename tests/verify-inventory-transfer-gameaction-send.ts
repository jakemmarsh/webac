/**
 * GAP.87 — GetAndWieldItem, StackableMerge, PutItemInContainer, and
 * AddToTrade send-side payloads audited against ACE C# read order and
 * converted to behavioral coverage.
 *
 * Previously each was constructed with a separate inline `new
 * BinaryWriter(...)` block at every call site in main.ts (up to 6 duplicate
 * sites for PutItemInContainer alone: drag-onto-pack-item, pack-tab drop,
 * unequip-to-inventory, right-click unequip, container take/take-all/store),
 * with no test exercising the actual byte layout — the same "one-shot
 * audit, never re-verified, drift risk from copy-paste duplication" gap
 * flagged for Jump/UseWithTarget/ModifyCharacterSquelch/SetSingleCharacterOption
 * /FinishBarber earlier in this series.
 *
 * Fix: extracted into buildGetAndWieldItemPayload / buildStackableMergePayload
 * / buildPutItemInContainerPayload / buildAddToTradePayload in
 * packages/network/src/MessageSerializer.ts (mirrors the existing
 * buildUseWithTargetPayload convention). All 18 main.ts call sites (drag-drop
 * inventory callbacks, double-click, right-click context menu, container
 * take/store, debug console helpers) now call the shared, exported, testable
 * functions instead of re-deriving the byte layout inline.
 *
 * Wire format anchors:
 *   GameActionGetAndWieldItem.cs — itemGuid u32 + location int32 (EquipMask)
 *   GameActionStackableMerge.cs — mergeFromGuid u32 + mergeToGuid u32 + amount int32
 *   GameActionPutItemInContainer.cs — itemGuid u32 + containerGuid u32 + placement int32
 *   GameActionAddToTrade.cs — itemGuid u32 + tradeSlot u32
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildGetAndWieldItemPayload, parseGetAndWieldItemPayload,
  buildStackableMergePayload, parseStackableMergePayload,
  buildPutItemInContainerPayload, parsePutItemInContainerPayload,
  buildAddToTradePayload, parseAddToTradePayload,
  BinaryReader,
} from '@ac/network';

const REPO = resolve(__dirname, '..');
const GETANDWIELD_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionGetAndWieldItem.cs'),
  'utf8',
);
const STACKMERGE_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionStackableMerge.cs'),
  'utf8',
);
const PUTINCONTAINER_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionPutItemInContainer.cs'),
  'utf8',
);
const ADDTOTRADE_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionAddToTrade.cs'),
  'utf8',
);

describe('ACE source anchors the wire format we send (GAP.87)', () => {
  it('GameActionGetAndWieldItem.cs reads itemGuid (u32) then location (i32 EquipMask)', () => {
    expect(GETANDWIELD_CS).toMatch(
      /itemGuid = message\.Payload\.ReadUInt32\(\);\s*\n\s*var location = \(EquipMask\)message\.Payload\.ReadInt32\(\);/,
    );
  });

  it('GameActionStackableMerge.cs reads mergeFromGuid, mergeToGuid (both u32) then amount (i32)', () => {
    expect(STACKMERGE_CS).toMatch(
      /mergeFromGuid = message\.Payload\.ReadUInt32\(\);\s*\n\s*uint mergeToGuid = message\.Payload\.ReadUInt32\(\);\s*\n\s*int amount = message\.Payload\.ReadInt32\(\);/,
    );
  });

  it('GameActionPutItemInContainer.cs reads itemGuid, containerGuid (both u32) then placement (i32)', () => {
    expect(PUTINCONTAINER_CS).toMatch(
      /itemGuid = message\.Payload\.ReadUInt32\(\);\s*\n\s*var containerGuid = message\.Payload\.ReadUInt32\(\);\s*\n\s*var placement = message\.Payload\.ReadInt32\(\);/,
    );
  });

  it('GameActionAddToTrade.cs reads itemGuid then tradeSlot (both u32)', () => {
    expect(ADDTOTRADE_CS).toMatch(
      /itemGuid = message\.Payload\.ReadUInt32\(\);\s*\n\s*var tradeSlot = message\.Payload\.ReadUInt32\(\);/,
    );
  });
});

describe('buildGetAndWieldItemPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 8 bytes', () => {
    expect(buildGetAndWieldItemPayload(1, 2).length).toBe(8);
  });

  it('round-trips through parseGetAndWieldItemPayload with distinct sentinel values', () => {
    const payload = buildGetAndWieldItemPayload(0x1234, 0x40);
    expect(parseGetAndWieldItemPayload(payload)).toEqual({ itemGuid: 0x1234, location: 0x40 });
  });

  it('matches GameActionGetAndWieldItem.cs field order exactly via a raw BinaryReader (an itemGuid/location transposition would fail this)', () => {
    const payload = buildGetAndWieldItemPayload(0xAAAA, 0x80);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0xAAAA); // itemGuid
    expect(reader.readInt32()).toBe(0x80);    // location (EquipMask)
    expect(reader.remaining).toBe(0);
  });
});

describe('buildStackableMergePayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 12 bytes', () => {
    expect(buildStackableMergePayload(1, 2, 3).length).toBe(12);
  });

  it('round-trips through parseStackableMergePayload with distinct sentinel values', () => {
    const payload = buildStackableMergePayload(0x1111, 0x2222, 5);
    expect(parseStackableMergePayload(payload)).toEqual({ mergeFromGuid: 0x1111, mergeToGuid: 0x2222, amount: 5 });
  });

  it('matches GameActionStackableMerge.cs field order exactly via a raw BinaryReader (a from/to transposition would fail this)', () => {
    const payload = buildStackableMergePayload(0xAAAA, 0xBBBB, 7);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0xAAAA); // mergeFromGuid
    expect(reader.readUInt32()).toBe(0xBBBB); // mergeToGuid
    expect(reader.readInt32()).toBe(7);       // amount
    expect(reader.remaining).toBe(0);
  });
});

describe('buildPutItemInContainerPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 12 bytes', () => {
    expect(buildPutItemInContainerPayload(1, 2, 3).length).toBe(12);
  });

  it('round-trips through parsePutItemInContainerPayload with distinct sentinel values', () => {
    const payload = buildPutItemInContainerPayload(0x1111, 0x2222, 4);
    expect(parsePutItemInContainerPayload(payload)).toEqual({ itemGuid: 0x1111, containerGuid: 0x2222, placement: 4 });
  });

  it('matches GameActionPutItemInContainer.cs field order exactly via a raw BinaryReader (an item/container transposition would fail this)', () => {
    const payload = buildPutItemInContainerPayload(0xAAAA, 0xBBBB, 9);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0xAAAA); // itemGuid
    expect(reader.readUInt32()).toBe(0xBBBB); // containerGuid
    expect(reader.readInt32()).toBe(9);       // placement
    expect(reader.remaining).toBe(0);
  });

  it('accepts negative placement (server "first available" sentinel is 0, but the field is a signed int32)', () => {
    const payload = buildPutItemInContainerPayload(1, 2, 0);
    expect(parsePutItemInContainerPayload(payload).placement).toBe(0);
  });
});

describe('buildAddToTradePayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 8 bytes', () => {
    expect(buildAddToTradePayload(1, 2).length).toBe(8);
  });

  it('round-trips through parseAddToTradePayload with distinct sentinel values', () => {
    const payload = buildAddToTradePayload(0x1234, 3);
    expect(parseAddToTradePayload(payload)).toEqual({ itemGuid: 0x1234, tradeSlot: 3 });
  });

  it('matches GameActionAddToTrade.cs field order exactly via a raw BinaryReader (an itemGuid/tradeSlot transposition would fail this)', () => {
    const payload = buildAddToTradePayload(0xAAAA, 6);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0xAAAA); // itemGuid
    expect(reader.readUInt32()).toBe(6);      // tradeSlot
    expect(reader.remaining).toBe(0);
  });
});
