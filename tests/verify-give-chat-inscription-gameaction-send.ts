/**
 * GAP.87 — GiveObjectRequest, ChatChannel, SetInscription, TalkDirect,
 * StackableSplitToWield, and TrainSkill send-side payloads audited against
 * ACE C# read order and converted to behavioral coverage.
 *
 * Previously each was constructed with a separate inline `new BinaryWriter(N)`
 * block at its call site(s) in main.ts, with no test exercising the actual
 * byte layout. Several also had DUPLICATE inline construction sites that had
 * drifted out of sync with the "canonical" callback of the same name:
 *   - useWithTarget (acDebug callback, main.ts ~11813) re-derived
 *     UseWithTarget's byte layout inline instead of calling the
 *     already-extracted buildUseWithTargetPayload (cycle f/GAP.87).
 *   - giveObjectRequest had a second inline site in the item context-menu
 *     onGive handler (main.ts ~5387-5395).
 *   - trainSkill had a second inline site in onTrainSkill (main.ts ~5607-5614).
 *   - chatChannel had a second inline site in the /f /fellowship /v /p /m /c
 *     slash-command handler (main.ts ~11157-11163), which bypasses the
 *     sendGameAction wrapper and calls serializeGameAction directly.
 * None of the duplicates had drifted incorrectly (all matched ACE read
 * order), but the duplication itself was the risk: a future edit to one
 * copy silently leaves the other stale, which is exactly the failure mode
 * this series has been closing one GameAction at a time.
 *
 * Fix: extracted into buildGiveObjectRequestPayload / buildChatChannelPayload
 * / buildSetInscriptionPayload / buildTalkDirectPayload /
 * buildStackableSplitToWieldPayload / buildTrainSkillPayload in
 * packages/network/src/MessageSerializer.ts (mirrors the existing
 * buildUseWithTargetPayload convention). All main.ts call sites (both the
 * "canonical" callback and every duplicate found by grepping the relevant
 * GameActionType across the whole file) now call the shared, exported,
 * testable functions instead of re-deriving the byte layout inline.
 *
 * Wire format anchors:
 *   GameActionGiveObjectRequest.cs — targetGuid u32 + objectGuid u32 + amount i32
 *   GameActionChatChannel.cs — channel u32 (Channel enum) + message String16L
 *   GameActionSetInscription.cs — objectGuid u32 + inscriptionText String16L
 *   GameActionTalkDirect.cs — message String16L + targetGuid u32 (unusual: text before guid)
 *   GameActionStackableSplitToWield.cs — stackId u32 + location i32 (EquipMask) + amount i32
 *   GameActionTrainSkill.cs — skill u32 (Skill enum) + creditsSpent i32
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildGiveObjectRequestPayload, parseGiveObjectRequestPayload,
  buildChatChannelPayload, parseChatChannelPayload,
  buildSetInscriptionPayload, parseSetInscriptionPayload,
  buildTalkDirectPayload, parseTalkDirectPayload,
  buildStackableSplitToWieldPayload, parseStackableSplitToWieldPayload,
  buildTrainSkillPayload, parseTrainSkillPayload,
  BinaryReader,
} from '@ac/network';

const REPO = resolve(__dirname, '..');
const GIVE_OBJECT_REQUEST_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionGiveObjectRequest.cs'),
  'utf8',
);
const CHAT_CHANNEL_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionChatChannel.cs'),
  'utf8',
);
const SET_INSCRIPTION_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionSetInscription.cs'),
  'utf8',
);
const TALK_DIRECT_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionTalkDirect.cs'),
  'utf8',
);
const STACKABLE_SPLIT_TO_WIELD_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionStackableSplitToWield.cs'),
  'utf8',
);
const TRAIN_SKILL_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionTrainSkill.cs'),
  'utf8',
);

describe('ACE source anchors the wire format we send (GAP.87)', () => {
  it('GameActionGiveObjectRequest.cs reads targetGuid, objectGuid (both u32), then amount (i32)', () => {
    expect(GIVE_OBJECT_REQUEST_CS).toMatch(
      /targetGuid = message\.Payload\.ReadUInt32\(\);\s*\n\s*uint objectGuid = message\.Payload\.ReadUInt32\(\);\s*\n\s*int amount = message\.Payload\.ReadInt32\(\);/,
    );
  });

  it('GameActionChatChannel.cs reads groupChatType (u32 Channel enum) then message (String16L)', () => {
    expect(CHAT_CHANNEL_CS).toMatch(
      /groupChatType = \(Channel\)clientMessage\.Payload\.ReadUInt32\(\);\s*\n\s*var message = clientMessage\.Payload\.ReadString16L\(\);/,
    );
  });

  it('GameActionSetInscription.cs reads objectGuid (u32) then inscriptionText (String16L)', () => {
    expect(SET_INSCRIPTION_CS).toMatch(
      /objectGuid = message\.Payload\.ReadUInt32\(\);\s*\n\s*string inscriptionText = message\.Payload\.ReadString16L\(\);/,
    );
  });

  it('GameActionTalkDirect.cs reads message (String16L) BEFORE targetGuid (u32) — unusual order', () => {
    expect(TALK_DIRECT_CS).toMatch(
      /message = clientMessage\.Payload\.ReadString16L\(\);\s*\n\s*var targetGuid = clientMessage\.Payload\.ReadUInt32\(\);/,
    );
  });

  it('GameActionStackableSplitToWield.cs reads stackId (u32), location (i32 EquipMask), amount (i32) in that order', () => {
    expect(STACKABLE_SPLIT_TO_WIELD_CS).toMatch(
      /stackId\s+= message\.Payload\.ReadUInt32\(\);\s*\n\s*var location\s+= \(EquipMask\)message\.Payload\.ReadInt32\(\);\s*\n\s*int amount\s+= message\.Payload\.ReadInt32\(\);/,
    );
  });

  it('GameActionTrainSkill.cs reads skill (u32 Skill enum) then creditsSpent (i32)', () => {
    expect(TRAIN_SKILL_CS).toMatch(
      /skill = \(Skill\)message\.Payload\.ReadUInt32\(\);\s*\n\s*var creditsSpent = message\.Payload\.ReadInt32\(\);/,
    );
  });
});

describe('buildGiveObjectRequestPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 12 bytes', () => {
    expect(buildGiveObjectRequestPayload(1, 2, 3).length).toBe(12);
  });

  it('round-trips through parseGiveObjectRequestPayload with distinct sentinel values', () => {
    const payload = buildGiveObjectRequestPayload(0x1111, 0x2222, 5);
    expect(parseGiveObjectRequestPayload(payload)).toEqual({ targetGuid: 0x1111, objectGuid: 0x2222, amount: 5 });
  });

  it('matches GameActionGiveObjectRequest.cs field order exactly via a raw BinaryReader (a field transposition would fail this)', () => {
    const payload = buildGiveObjectRequestPayload(0xAAAA, 0xBBBB, 7);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0xAAAA); // targetGuid
    expect(reader.readUInt32()).toBe(0xBBBB); // objectGuid
    expect(reader.readInt32()).toBe(7);       // amount
    expect(reader.remaining).toBe(0);
  });
});

describe('buildChatChannelPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('round-trips through parseChatChannelPayload with distinct sentinel values', () => {
    const payload = buildChatChannelPayload(0x9, 'hello fellowship');
    expect(parseChatChannelPayload(payload)).toEqual({ channel: 0x9, message: 'hello fellowship' });
  });

  it('matches GameActionChatChannel.cs field order exactly via a raw BinaryReader (channel then message)', () => {
    const payload = buildChatChannelPayload(0x40, 'vassal chat');
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0x40); // channel
    expect(reader.readString16()).toBe('vassal chat');
  });
});

describe('buildSetInscriptionPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('round-trips through parseSetInscriptionPayload with distinct sentinel values', () => {
    const payload = buildSetInscriptionPayload(0x3333, 'For a friend');
    expect(parseSetInscriptionPayload(payload)).toEqual({ objectGuid: 0x3333, text: 'For a friend' });
  });

  it('matches GameActionSetInscription.cs field order exactly via a raw BinaryReader (objectGuid then text)', () => {
    const payload = buildSetInscriptionPayload(0xCCCC, 'A book of great import');
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0xCCCC); // objectGuid
    expect(reader.readString16()).toBe('A book of great import');
  });
});

describe('buildTalkDirectPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('round-trips through parseTalkDirectPayload with distinct sentinel values', () => {
    const payload = buildTalkDirectPayload('hey there', 0x4444);
    expect(parseTalkDirectPayload(payload)).toEqual({ message: 'hey there', targetGuid: 0x4444 });
  });

  it('matches GameActionTalkDirect.cs field order exactly via a raw BinaryReader (message BEFORE targetGuid — a swap would fail this)', () => {
    const payload = buildTalkDirectPayload('psst', 0xDDDD);
    const reader = new BinaryReader(payload);
    expect(reader.readString16()).toBe('psst'); // message
    expect(reader.readUInt32()).toBe(0xDDDD);   // targetGuid
  });
});

describe('buildStackableSplitToWieldPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 12 bytes', () => {
    expect(buildStackableSplitToWieldPayload(1, 2, 3).length).toBe(12);
  });

  it('round-trips through parseStackableSplitToWieldPayload with distinct sentinel values', () => {
    const payload = buildStackableSplitToWieldPayload(0x5555, 0x2, 10);
    expect(parseStackableSplitToWieldPayload(payload)).toEqual({ stackId: 0x5555, equipMask: 0x2, amount: 10 });
  });

  it('matches GameActionStackableSplitToWield.cs field order exactly via a raw BinaryReader (a field transposition would fail this)', () => {
    const payload = buildStackableSplitToWieldPayload(0xEEEE, 0x4, 3);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0xEEEE); // stackId
    expect(reader.readInt32()).toBe(0x4);     // location (EquipMask)
    expect(reader.readInt32()).toBe(3);       // amount
    expect(reader.remaining).toBe(0);
  });
});

describe('buildTrainSkillPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 8 bytes', () => {
    expect(buildTrainSkillPayload(1, 2).length).toBe(8);
  });

  it('round-trips through parseTrainSkillPayload with distinct sentinel values', () => {
    const payload = buildTrainSkillPayload(0x6666, 4);
    expect(parseTrainSkillPayload(payload)).toEqual({ skill: 0x6666, creditsSpent: 4 });
  });

  it('matches GameActionTrainSkill.cs field order exactly via a raw BinaryReader (a skill/creditsSpent transposition would fail this)', () => {
    const payload = buildTrainSkillPayload(0xFFFF, 2);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0xFFFF); // skill
    expect(reader.readInt32()).toBe(2);       // creditsSpent
    expect(reader.remaining).toBe(0);
  });
});
