/**
 * GAP.87 — ModifyAccountSquelch, ModifyGlobalSquelch, BreakAllegianceBoot,
 * SetAllegianceOfficer, SetAllegianceOfficerTitle, AllegianceChatBoot, and
 * AllegianceChatGag send-side payloads audited against ACE C# read order
 * and converted to behavioral coverage.
 *
 * Previously each was constructed with a separate inline `new BinaryWriter`
 * block at its call site in main.ts (the acDebug allegiance-officer/chat
 * helpers, plus onAllegianceKick and onUnsquelch), with no test exercising
 * the actual byte layout — same gap as the rest of this series. Two of the
 * seven were outright duplicates of an already-extracted builder never
 * routed through it: onUnsquelch re-derived the exact
 * ModifyCharacterSquelch byte layout inline instead of calling
 * buildModifyCharacterSquelchPayload (extracted in an earlier cycle), and
 * the acDebug modifyCharacterSquelch helper did the same.
 *
 * Fix: extracted buildModifyAccountSquelchPayload,
 * buildModifyGlobalSquelchPayload, buildBreakAllegianceBootPayload,
 * buildSetAllegianceOfficerPayload, buildSetAllegianceOfficerTitlePayload,
 * buildAllegianceChatBootPayload, and buildAllegianceChatGagPayload into
 * packages/network/src/MessageSerializer.ts. main.ts's onUnsquelch,
 * onAllegianceKick, and the acDebug modifyAccountSquelch /
 * modifyCharacterSquelch / modifyGlobalSquelch / setAllegianceOfficer /
 * setAllegianceOfficerTitle / allegianceChatBoot / allegianceChatGag /
 * breakAllegianceBoot callbacks now route through the shared builders
 * (onUnsquelch and the acDebug modifyCharacterSquelch helper now call the
 * pre-existing buildModifyCharacterSquelchPayload instead of duplicating
 * its byte layout).
 *
 * Wire format anchors:
 *   GameActionModifyAccountSquelch.cs — squelch u32 (bool) + playerName String16L
 *   GameActionModifyGlobalSquelch.cs — squelch u32 (bool) + messageType u32
 *   GameActionBreakAllegianceBoot.cs — playerName String16L + accountBoot u32 (bool)
 *   GameActionSetAllegianceOfficer.cs — playerName String16L + officerLevel u32
 *   GameActionSetAllegianceOfficerTitle.cs — level u32 + title String16L
 *   GameActionAllegianceChatBoot.cs — playerName String16L + reason String16L
 *   GameActionAllegianceChatGag.cs — playerName String16L + enabled u32 (bool)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildModifyAccountSquelchPayload, parseModifyAccountSquelchPayload,
  buildModifyGlobalSquelchPayload, parseModifyGlobalSquelchPayload,
  buildBreakAllegianceBootPayload, parseBreakAllegianceBootPayload,
  buildSetAllegianceOfficerPayload, parseSetAllegianceOfficerPayload,
  buildSetAllegianceOfficerTitlePayload, parseSetAllegianceOfficerTitlePayload,
  buildAllegianceChatBootPayload, parseAllegianceChatBootPayload,
  buildAllegianceChatGagPayload, parseAllegianceChatGagPayload,
  BinaryReader,
} from '@ac/network';

const REPO = resolve(__dirname, '..');
const ACTIONS_DIR = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions');
const readCs = (name: string) => readFileSync(resolve(ACTIONS_DIR, `${name}.cs`), 'utf8');

const ACCOUNT_SQUELCH_CS = readCs('GameActionModifyAccountSquelch');
const GLOBAL_SQUELCH_CS = readCs('GameActionModifyGlobalSquelch');
const BREAK_ALLEGIANCE_BOOT_CS = readCs('GameActionBreakAllegianceBoot');
const SET_OFFICER_CS = readCs('GameActionSetAllegianceOfficer');
const SET_OFFICER_TITLE_CS = readCs('GameActionSetAllegianceOfficerTitle');
const CHAT_BOOT_CS = readCs('GameActionAllegianceChatBoot');
const CHAT_GAG_CS = readCs('GameActionAllegianceChatGag');

describe('ACE source anchors the wire format we send (GAP.87)', () => {
  it('GameActionModifyAccountSquelch.cs reads squelch (u32 bool) then playerName (String16L)', () => {
    expect(ACCOUNT_SQUELCH_CS).toMatch(
      /squelch = Convert\.ToBoolean\(message\.Payload\.ReadUInt32\(\)\);\s*\n\s*var playerName = message\.Payload\.ReadString16L\(\);/,
    );
  });

  it('GameActionModifyGlobalSquelch.cs reads squelch (u32 bool) then messageType (u32 ChatMessageType)', () => {
    expect(GLOBAL_SQUELCH_CS).toMatch(
      /squelch = Convert\.ToBoolean\(message\.Payload\.ReadUInt32\(\)\);\s*\n\s*var messageType = \(ChatMessageType\)message\.Payload\.ReadUInt32\(\);/,
    );
  });

  it('GameActionBreakAllegianceBoot.cs reads playerName (String16L) then accountBoot (u32 bool)', () => {
    expect(BREAK_ALLEGIANCE_BOOT_CS).toMatch(
      /playerName = message\.Payload\.ReadString16L\(\);\s*\n\s*var accountBoot = Convert\.ToBoolean\(message\.Payload\.ReadUInt32\(\)\);/,
    );
  });

  it('GameActionSetAllegianceOfficer.cs reads playerName (String16L) then officerLevel (u32)', () => {
    expect(SET_OFFICER_CS).toMatch(
      /playerName = message\.Payload\.ReadString16L\(\);.*\n\s*var officerLevel = message\.Payload\.ReadUInt32\(\);/,
    );
  });

  it('GameActionSetAllegianceOfficerTitle.cs reads level (u32) then title (String16L)', () => {
    expect(SET_OFFICER_TITLE_CS).toMatch(
      /level = message\.Payload\.ReadUInt32\(\);\s*\n\s*var title = message\.Payload\.ReadString16L\(\);/,
    );
  });

  it('GameActionAllegianceChatBoot.cs reads playerName (String16L) then reason (String16L)', () => {
    expect(CHAT_BOOT_CS).toMatch(
      /playerName = message\.Payload\.ReadString16L\(\);\s*\n\s*var reason = message\.Payload\.ReadString16L\(\);/,
    );
  });

  it('GameActionAllegianceChatGag.cs reads playerName (String16L) then enabled (u32 bool)', () => {
    expect(CHAT_GAG_CS).toMatch(
      /playerName = message\.Payload\.ReadString16L\(\);\s*\n\s*var enabled = Convert\.ToBoolean\(message\.Payload\.ReadUInt32\(\)\);/,
    );
  });
});

describe('buildModifyAccountSquelchPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('round-trips through parseModifyAccountSquelchPayload with distinct sentinel values', () => {
    const payload = buildModifyAccountSquelchPayload(true, 'Griefer');
    expect(parseModifyAccountSquelchPayload(payload)).toEqual({ squelch: true, playerName: 'Griefer' });
  });

  it('matches GameActionModifyAccountSquelch.cs field order exactly via a raw BinaryReader', () => {
    const payload = buildModifyAccountSquelchPayload(false, 'Someone');
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0); // squelch
    expect(reader.readString16()).toBe('Someone'); // playerName
  });
});

describe('buildModifyGlobalSquelchPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 8 bytes', () => {
    expect(buildModifyGlobalSquelchPayload(true, 5).length).toBe(8);
  });

  it('round-trips through parseModifyGlobalSquelchPayload with distinct sentinel values', () => {
    const payload = buildModifyGlobalSquelchPayload(true, 0x9);
    expect(parseModifyGlobalSquelchPayload(payload)).toEqual({ squelch: true, messageType: 0x9 });
  });

  it('matches GameActionModifyGlobalSquelch.cs field order exactly via a raw BinaryReader (a squelch/messageType transposition would fail this)', () => {
    const payload = buildModifyGlobalSquelchPayload(false, 0x1234);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0);      // squelch
    expect(reader.readUInt32()).toBe(0x1234); // messageType
    expect(reader.remaining).toBe(0);
  });
});

describe('buildBreakAllegianceBootPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('round-trips through parseBreakAllegianceBootPayload with distinct sentinel values', () => {
    const payload = buildBreakAllegianceBootPayload('Kicked', true);
    expect(parseBreakAllegianceBootPayload(payload)).toEqual({ playerName: 'Kicked', accountBoot: true });
  });

  it('matches GameActionBreakAllegianceBoot.cs field order exactly via a raw BinaryReader (playerName before accountBoot, not after)', () => {
    const payload = buildBreakAllegianceBootPayload('Target', false);
    const reader = new BinaryReader(payload);
    expect(reader.readString16()).toBe('Target'); // playerName
    expect(reader.readUInt32()).toBe(0);           // accountBoot
    expect(reader.remaining).toBe(0);
  });
});

describe('buildSetAllegianceOfficerPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('round-trips through parseSetAllegianceOfficerPayload with distinct sentinel values', () => {
    const payload = buildSetAllegianceOfficerPayload('Officer', 3);
    expect(parseSetAllegianceOfficerPayload(payload)).toEqual({ playerName: 'Officer', officerLevel: 3 });
  });

  it('matches GameActionSetAllegianceOfficer.cs field order exactly via a raw BinaryReader (playerName before officerLevel)', () => {
    const payload = buildSetAllegianceOfficerPayload('Seneschal', 2);
    const reader = new BinaryReader(payload);
    expect(reader.readString16()).toBe('Seneschal'); // playerName
    expect(reader.readUInt32()).toBe(2);              // officerLevel
    expect(reader.remaining).toBe(0);
  });
});

describe('buildSetAllegianceOfficerTitlePayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('round-trips through parseSetAllegianceOfficerTitlePayload with distinct sentinel values', () => {
    const payload = buildSetAllegianceOfficerTitlePayload(1, 'Castellan');
    expect(parseSetAllegianceOfficerTitlePayload(payload)).toEqual({ level: 1, title: 'Castellan' });
  });

  it('matches GameActionSetAllegianceOfficerTitle.cs field order exactly via a raw BinaryReader (level before title, opposite of SetAllegianceOfficer)', () => {
    const payload = buildSetAllegianceOfficerTitlePayload(4, 'Marshal');
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(4);           // level
    expect(reader.readString16()).toBe('Marshal'); // title
    expect(reader.remaining).toBe(0);
  });
});

describe('buildAllegianceChatBootPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('round-trips through parseAllegianceChatBootPayload with distinct sentinel values', () => {
    const payload = buildAllegianceChatBootPayload('Booted', 'spamming');
    expect(parseAllegianceChatBootPayload(payload)).toEqual({ playerName: 'Booted', reason: 'spamming' });
  });

  it('matches GameActionAllegianceChatBoot.cs field order exactly via a raw BinaryReader (two String16L fields, playerName first)', () => {
    const payload = buildAllegianceChatBootPayload('Alpha', 'Beta');
    const reader = new BinaryReader(payload);
    expect(reader.readString16()).toBe('Alpha'); // playerName
    expect(reader.readString16()).toBe('Beta');  // reason
    expect(reader.remaining).toBe(0);
  });
});

describe('buildAllegianceChatGagPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('round-trips through parseAllegianceChatGagPayload with distinct sentinel values', () => {
    const payload = buildAllegianceChatGagPayload('Gagged', true);
    expect(parseAllegianceChatGagPayload(payload)).toEqual({ playerName: 'Gagged', enabled: true });
  });

  it('matches GameActionAllegianceChatGag.cs field order exactly via a raw BinaryReader (playerName before enabled)', () => {
    const payload = buildAllegianceChatGagPayload('Someone', false);
    const reader = new BinaryReader(payload);
    expect(reader.readString16()).toBe('Someone'); // playerName
    expect(reader.readUInt32()).toBe(0);            // enabled
    expect(reader.remaining).toBe(0);
  });
});
