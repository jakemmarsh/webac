/**
 * FAITHFUL.346 — TurbineChat consumer uses the canonical channel label
 *  for the bracket prefix instead of hardcoded "[General]".
 *
 * Pre-fix `onTurbineChat` in main.ts always rendered:
 *   `[General] sender: message`
 * regardless of the wire-level `channelId`. Every Trade / LFG / Roleplay
 * / Society / Olthoi / Allegiance chat message was mislabeled "[General]".
 *
 * Channel IDs sourced from `reference/ACE/Source/ACE.Server/Entity/
 * TurbineChatChannel.cs`:
 *   1  = Allegiance (dynamic per-player; default fallback)
 *   2  = General
 *   3  = Trade
 *   4  = LFG
 *   5  = Roleplay
 *   6  = Society
 *   7  = SocietyCelestialHand
 *   8  = SocietyEldrytchWeb
 *   9  = SocietyRadiantBlood
 *   10 = Olthoi
 *
 * Allegiance channel IDs are NOT fixed — they're shipped to the client
 * at login via `SetTurbineChatChannels` (the per-player allegiance ID).
 * Treating any unknown channel ID as "Allegiance" matches retail
 * behavior (the allegiance channel is the only one a player would
 * receive that doesn't match a fixed constant).
 */
import { describe, it, expect } from 'vitest';
import { formatTurbineChatLine } from '../packages/renderer/src/chat/TurbineChatLine.js';
import { turbineChannelMessageType, chatColorFor } from '@ac/shared';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TurbineChatChannel, turbineChannelLabel } from '@ac/shared';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('TurbineChatChannel enum mirrors ACE source (FAITHFUL.346)', () => {
  it('all 10 channel IDs map to the canonical retail labels', () => {
    expect(turbineChannelLabel(TurbineChatChannel.General)).toBe('General');
    expect(turbineChannelLabel(TurbineChatChannel.Trade)).toBe('Trade');
    expect(turbineChannelLabel(TurbineChatChannel.LFG)).toBe('LFG');
    expect(turbineChannelLabel(TurbineChatChannel.Roleplay)).toBe('Roleplay');
    expect(turbineChannelLabel(TurbineChatChannel.Society)).toBe('Society');
    expect(turbineChannelLabel(TurbineChatChannel.SocietyCelestialHand)).toBe('Celestial Hand');
    expect(turbineChannelLabel(TurbineChatChannel.SocietyEldrytchWeb)).toBe('Eldrytch Web');
    expect(turbineChannelLabel(TurbineChatChannel.SocietyRadiantBlood)).toBe('Radiant Blood');
    expect(turbineChannelLabel(TurbineChatChannel.Olthoi)).toBe('Olthoi');
  });

  it('numeric values match ACE TurbineChatChannel.cs verbatim', () => {
    expect(TurbineChatChannel.Allegiance).toBe(1);
    expect(TurbineChatChannel.General).toBe(2);
    expect(TurbineChatChannel.Trade).toBe(3);
    expect(TurbineChatChannel.LFG).toBe(4);
    expect(TurbineChatChannel.Roleplay).toBe(5);
    expect(TurbineChatChannel.Society).toBe(6);
    expect(TurbineChatChannel.SocietyCelestialHand).toBe(7);
    expect(TurbineChatChannel.SocietyEldrytchWeb).toBe(8);
    expect(TurbineChatChannel.SocietyRadiantBlood).toBe(9);
    expect(TurbineChatChannel.Olthoi).toBe(10);
  });

  it('unknown channel IDs fall back to Allegiance (per ACE SetTurbineChatChannels)', () => {
    // Allegiance channel IDs are dynamic (shipped per-player at login).
    // The label fallback is "Allegiance" since that's the only non-fixed
    // channel a normal player receives.
    expect(turbineChannelLabel(0x12345678)).toBe('Allegiance');
    expect(turbineChannelLabel(99)).toBe('Allegiance');
    expect(turbineChannelLabel(0)).toBe('Allegiance');
  });
});

describe('main.ts onTurbineChat uses turbineChannelLabel (FAITHFUL.346)', () => {
  it('handler imports turbineChannelLabel from @ac/shared', () => {
    expect(MAIN).toMatch(/turbineChannelLabel[\s\S]*?from '@ac\/shared'/);
  });

  // SWEEP1006 channel lines — behavioural: ChatRoomTracker::GetChatFormat
  // @ 005cd7c0 '[%ws] <Tell…>%ws<\Tell> says, "%ws"' and its text types.
  it('a room line reads [Room] Name says, "msg" in the room\'s text type and colour', () => {
    expect(formatTurbineChatLine('Trade', 'Bob', 'wts sword')).toBe('[Trade] Bob says, "wts sword"');
    expect(turbineChannelMessageType(TurbineChatChannel.General)).toBe(0x1b);
    expect(turbineChannelMessageType(TurbineChatChannel.Roleplay)).toBe(0x1e);
    expect(turbineChannelMessageType(TurbineChatChannel.Society)).toBe(0x20);
    expect(turbineChannelMessageType(TurbineChatChannel.SocietyRadiantBlood)).toBe(0x20);
    expect(turbineChannelMessageType(TurbineChatChannel.Olthoi)).toBe(0x12);
    expect(chatColorFor(0x1c)).toBe(chatColorFor(0x20)); // blue-grey
    expect(chatColorFor(0x12)).not.toBe(chatColorFor(0x08)); // orange, not Channel pink
  });

  it('does NOT regress to the hardcoded "[General]" prefix', () => {
    const block = MAIN.match(/onTurbineChat:[\s\S]+?^      \},/m)?.[0] ?? '';
    // Strip comments so the FAITHFUL.346 docblock quoting the pre-fix
    // expression doesn't poison the check.
    const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/addSystemMessage\(`\[General\]/);
  });
});
