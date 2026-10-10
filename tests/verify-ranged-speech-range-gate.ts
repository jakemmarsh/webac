/**
 * BUG.hearrangedspeech-range-gate-missing — behavioral coverage for the
 * retail client-side ranged-speech range gate.
 *
 * Ground truth:
 *  - ACE writes the emote's Extent as the wire `range` float on
 *    GameMessageHearRangedSpeech (EmoteManager.cs:1127) while broadcasting
 *    at LocalBroadcastRange = 96m (WorldObject.cs:1018) — the server
 *    over-broadcasts and expects the client to enforce the smaller range.
 *  - Retail enforces it: gmCCommunicationSystem::HandleRangedTalkEvent
 *    @ 00589f60 only calls AddTextToScroll when
 *    ACCWeenieObject::ObjectsInRange(player_id, sender, range, false, false)
 *    returns nonzero. ObjectsInRange @ 0058c1a0 with both flags false is a
 *    plain 3D Position::distance between origins tested `dist <= range`,
 *    and returns 0 (suppress) when either object is unknown.
 *
 * This drives the shipped gate helper (imported by main.ts's
 * onHearRangedSpeech before any scroll line or speech bubble) with the
 * scenarios from the task: an Extent-12 emote heard at 10m displays, at 50m
 * is suppressed, and an unknown sender is suppressed.
 */
import { describe, it, expect } from 'vitest';
import { rangedSpeechInRange } from '../packages/renderer/src/chat/RangedSpeechGate.js';

const PLAYER = { x: 100, y: 20, z: 100 };

describe('rangedSpeechInRange (retail ObjectsInRange mirror)', () => {
  it('displays an Extent-12 emote heard from 10m away', () => {
    expect(rangedSpeechInRange(PLAYER, { x: 110, y: 20, z: 100 }, 12)).toBe(true);
  });

  it('suppresses the same emote heard from 50m away (inside ACE 96m broadcast)', () => {
    expect(rangedSpeechInRange(PLAYER, { x: 150, y: 20, z: 100 }, 12)).toBe(false);
  });

  it('suppresses when the sender object is unknown (ObjectsInRange null → 0)', () => {
    expect(rangedSpeechInRange(PLAYER, null, 12)).toBe(false);
  });

  it('distance is 3D — vertical separation counts (Position::distance)', () => {
    // 10m horizontal + 10m vertical = ~14.14m > 12m range.
    expect(rangedSpeechInRange(PLAYER, { x: 110, y: 30, z: 100 }, 12)).toBe(false);
    // Same offsets against a 15m range pass.
    expect(rangedSpeechInRange(PLAYER, { x: 110, y: 30, z: 100 }, 15)).toBe(true);
  });

  it('boundary is inclusive — retail tests dist <= range', () => {
    expect(rangedSpeechInRange(PLAYER, { x: 112, y: 20, z: 100 }, 12)).toBe(true);
    expect(rangedSpeechInRange(PLAYER, { x: 112.01, y: 20, z: 100 }, 12)).toBe(false);
  });

  it('non-finite range suppresses rather than throwing', () => {
    expect(rangedSpeechInRange(PLAYER, { x: 101, y: 20, z: 100 }, Number.NaN)).toBe(false);
  });
});
