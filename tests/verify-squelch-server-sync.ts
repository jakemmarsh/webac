/**
 * FAITHFUL.251 — /squelch and /unsquelch now sync to the server.
 *
 * Pre-fix /squelch only updated a local Set (FAITHFUL.227 client-side
 * filtering). The squelch didn't persist across logins, and the server
 * continued streaming the squelched player's messages to us (we just
 * dropped them locally).
 *
 * Fix: /squelch and /unsquelch ALSO send GameActionModifyCharacterSquelch
 * per ACE SquelchManager.cs:74-122. Wire format:
 *   squelch u32 (1=mute, 0=unmute) + playerGuid u32 (0 → server resolves by
 *   name) + playerName S16L + ChatMessageType u32 (AllChannels=0x01).
 * Server stores persistently in its DB and emits its own feedback ('X has
 * been squelched.', 'X not found.', etc.) via SystemChat (already wired).
 *
 * GAP.87 (2026-07-24): the payload construction was extracted out of
 * main.ts's inline `new BinaryWriter(48)` blocks (one per add/remove
 * sub-command) into buildModifyCharacterSquelchPayload() in
 * packages/network/src/MessageSerializer.ts, mirroring the
 * buildJumpActionPayload convention (see verify-jump-gameaction-send.ts).
 * main.ts now calls that shared, exported, testable function instead of
 * re-deriving the byte layout inline in two places. The source-text
 * assertions below were updated to match the new call sites, and real
 * behavioral round-trip coverage (driving the actual shipped builder/parser
 * pair) was added below them.
 *
 * The @squelch / @unsquelch commands are now the retail DoSquelch port
 * (chat/commands/AllegianceSocialCommands.ts), driven in
 * verify-retail-commands-allegiance-social.ts; this file keeps the wire
 * format of the ModifyCharacterSquelch action they send.
 */
import { describe, it, expect } from 'vitest';
import { GameActionType } from '../packages/network/src/GameActionType';
import { ChatMessageType } from '@ac/shared';
import { buildModifyCharacterSquelchPayload, parseModifyCharacterSquelchPayload, BinaryReader } from '@ac/network';


describe('FAITHFUL.251 — squelch/unsquelch sync to server', () => {
  it('GameActionType.ModifyCharacterSquelch opcode is reachable from the dispatcher', () => {
    expect(GameActionType.ModifyCharacterSquelch).toBe(0x0058);
  });

  it('ChatMessageType.AllChannels (= 0x01) is the right "all channels" marker', () => {
    expect(ChatMessageType.AllChannels).toBe(0x01);
  });

  it('buildModifyCharacterSquelchPayload round-trips real add/remove values byte-exact (GAP.87 — behavioral)', () => {
    const addPayload = buildModifyCharacterSquelchPayload(true, 0, 'Aerbax', ChatMessageType.AllChannels);
    expect(parseModifyCharacterSquelchPayload(addPayload)).toEqual({
      squelch: true, playerGuid: 0, playerName: 'Aerbax', messageType: ChatMessageType.AllChannels,
    });
    const removePayload = buildModifyCharacterSquelchPayload(false, 0, 'Aerbax', ChatMessageType.AllChannels);
    expect(parseModifyCharacterSquelchPayload(removePayload)).toEqual({
      squelch: false, playerGuid: 0, playerName: 'Aerbax', messageType: ChatMessageType.AllChannels,
    });
  });

  it('matches GameActionModifyCharacterSquelch.cs field order exactly via a raw BinaryReader (a name/guid transposition would fail this)', () => {
    const payload = buildModifyCharacterSquelchPayload(true, 0x4242, 'Zzyx', 0x07);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(1);        // squelch (bool as u32) — GameActionModifyCharacterSquelch.cs:12
    expect(reader.readUInt32()).toBe(0x4242);   // playerGuid — :13
    expect(reader.readString16()).toBe('Zzyx'); // playerName (String16L) — :14
    expect(reader.readUInt32()).toBe(0x07);     // messageType — :15
    expect(reader.remaining).toBe(0);
  });
});
