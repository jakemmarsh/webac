import { describe, it, expect } from 'vitest';
import { ChatMessageType, chatColorFor, RETAIL_CHAT_COLORS } from '@ac/shared';

/**
 * ChatMessageType enum (ACE.Entity.Enum.ChatMessageType) + the default chat
 * colours. CORE.17.s: the colours are the retail EoL client's
 * ChatInterface::BuildChatColorLookupTable @ 004f31c0 (see
 * tests/verify-core17s-chat-colors.ts for the full derivation); the older
 * hand-written table pinned here before 2026-09-09 was invented.
 */
describe('ChatMessageType — enum values + retail default chat colours', () => {
  it('exposes the full ChatMessageType enum from ACE.Entity.Enum.ChatMessageType', () => {
    expect(ChatMessageType.Broadcast).toBe(0x00);
    expect(ChatMessageType.AllChannels).toBe(0x01);
    expect(ChatMessageType.Speech).toBe(0x02);
    expect(ChatMessageType.Tell).toBe(0x03);
    expect(ChatMessageType.OutgoingTell).toBe(0x04);
    expect(ChatMessageType.System).toBe(0x05);
    expect(ChatMessageType.Combat).toBe(0x06);
    expect(ChatMessageType.Magic).toBe(0x07);
    expect(ChatMessageType.Channel).toBe(0x08);
    expect(ChatMessageType.Emote).toBe(0x0C);
    expect(ChatMessageType.Advancement).toBe(0x0D);
    expect(ChatMessageType.Spellcasting).toBe(0x11);
    expect(ChatMessageType.Allegiance).toBe(0x12);
    expect(ChatMessageType.Fellowship).toBe(0x13);
    expect(ChatMessageType.WorldBroadcast).toBe(0x14);
    expect(ChatMessageType.AdminTell).toBe(0x1F);
  });

  it('returns a well-formed hex color for every defined type', () => {
    const hex = /^#[0-9a-f]{6}$/;
    for (const val of Object.values(ChatMessageType)) {
      if (typeof val !== 'number') continue;
      expect(chatColorFor(val)).toMatch(hex);
    }
  });

  it('maps Speech (0x02) to colorWhite — the one explicit white override', () => {
    expect(chatColorFor(ChatMessageType.Speech)).toBe('#ffffff');
  });

  it('maps Tell (0x03) to colorYellow (shared with AdminTell, Social, Fellowship)', () => {
    expect(chatColorFor(ChatMessageType.Tell)).toBe(RETAIL_CHAT_COLORS.yellow);
    expect(chatColorFor(ChatMessageType.Tell)).toBe(chatColorFor(ChatMessageType.AdminTell));
  });

  it('maps System (0x05) to colorBrightPurple, not grey', () => {
    expect(chatColorFor(ChatMessageType.System)).toBe('#ff7fff');
  });

  it('maps Magic (0x07) and Spellcasting (0x11) to colorLightBlue', () => {
    expect(chatColorFor(ChatMessageType.Magic)).toBe('#3fbfff');
    expect(chatColorFor(ChatMessageType.Spellcasting)).toBe('#3fbfff');
  });

  it('maps Emote (0x0C) to colorGrey', () => {
    expect(chatColorFor(ChatMessageType.Emote)).toBe('#d2d2c8');
  });

  it('maps Advancement (0x0D) to colorCyan — "You are now level X!"', () => {
    expect(chatColorFor(ChatMessageType.Advancement)).toBe('#3fdcdc');
  });

  it('maps Allegiance (0x12) to colorOrange', () => {
    expect(chatColorFor(ChatMessageType.Allegiance)).toBe('#ee921e');
  });

  it('maps Fellowship (0x13) to colorYellow (ACE comment "Bright Yellow Text" agrees)', () => {
    expect(chatColorFor(ChatMessageType.Fellowship)).toBe('#ffff3f');
  });

  it('maps WorldBroadcast (0x14) to the green default (ACE comment "Green Text" agrees)', () => {
    expect(chatColorFor(ChatMessageType.WorldBroadcast)).toBe('#80ff7f');
  });

  it('maps CombatEnemy (0x15) to colorDarkRed (ACE "Red Text"), CombatSelf (0x16) to colorLightRed (ACE "Pink Text")', () => {
    expect(chatColorFor(ChatMessageType.CombatEnemy)).toBe('#ff3f3f');
    expect(chatColorFor(ChatMessageType.CombatSelf)).toBe('#f57572');
  });

  it('reserved 0x1B–0x1E render colorBlueGrey (ACE calls it "light cyan (sky blue)") — FAITHFUL.327 upheld with the retail value', () => {
    for (const t of [0x1B, 0x1C, 0x1D, 0x1E]) expect(chatColorFor(t)).toBe('#b4dcf0');
    expect(chatColorFor(ChatMessageType.Abuse)).toBe('#b4dcf0');
  });

  it('type 0x1A (client notices) is bright red; types beyond the 34-entry table fall back to white', () => {
    expect(chatColorFor(0x1A)).toBe('#ff0000');
    expect(chatColorFor(0xFF)).toBe('#ffffff');
  });

  it('does not treat chatType=1 (AllChannels) as local Speech — bug-fix pin', () => {
    // Previously, the renderer hardcoded `case 1: Local Speech` which was a
    // bug: AllChannels is a squelch-mask bit, not a local speech marker.
    // The real HearSpeech packet uses Speech=0x02 for local dialog.
    expect(ChatMessageType.AllChannels).toBe(0x01);
    expect(ChatMessageType.Speech).toBe(0x02);
    expect(chatColorFor(ChatMessageType.Speech)).toBe('#ffffff');
    expect(chatColorFor(ChatMessageType.AllChannels)).toBe('#80ff7f');
  });
});
