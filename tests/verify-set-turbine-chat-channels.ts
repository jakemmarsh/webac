/**
 * FAITHFUL.363 — SetTurbineChatChannels captures the per-player dynamic
 *  allegiance + society channel IDs.
 *
 * ACE `GameEventSetTurbineChatChannels.cs:7-21` ships 10 uint32 values
 * at login:
 *   allegiance (dynamic per-player, 0 if no allegiance)
 *   General, Trade, LFG, Roleplay   (fixed 2-5)
 *   Olthoi                          (fixed 10)
 *   society (dynamic per-player, 0 if not in a society)
 *   SocietyCelestialHand, SocietyEldrytchWeb, SocietyRadiantBlood (7-9)
 *
 * Pre-FAITHFUL.363 the dispatcher silently consumed this event. Without
 * the dynamic allegiance + society IDs, incoming ChannelBroadcast /
 * TurbineChat messages whose channelId is the player's dynamic
 * allegiance or society ID fall through `turbineChannelLabel`'s default
 * "Allegiance" — so a player's society chat would mislabel as
 * "Allegiance" in the chat panel.
 *
 * Fix: capture both dynamic IDs at login + use them in the TurbineChat
 * consumer to resolve the channel label before falling back to the
 * fixed-channel-ID helper.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { GameEventType, GameMessageOpcode } from '@ac/network';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

function u32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

describe('SetTurbineChatChannels captures dynamic IDs (FAITHFUL.363)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onSetTurbineChatChannels: d => calls.push(d) });
  });

  it('extracts allegiance + society IDs from positions 0 and 6', () => {
    const ALLEGIANCE = 0x100FFA01;
    const SOCIETY = 0x100FFB02;
    const payload = concat(
      u32(ALLEGIANCE),
      u32(2), u32(3), u32(4), u32(5), u32(10), // General, Trade, LFG, Roleplay, Olthoi (fixed)
      u32(SOCIETY),
      u32(7), u32(8), u32(9), // SocietyCelestialHand, EldrytchWeb, RadiantBlood (fixed)
    );
    expect(payload.length).toBe(40);
    handler.handleMessage({
      type: 'event',
      opcode: GameMessageOpcode.GameEvent,
      sequence: 1,
      eventType: GameEventType.SetTurbineChatChannels,
      objectGuid: 0,
      payload,
    } as any);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ allegiance: ALLEGIANCE, society: SOCIETY });
  });

  it('handles allegiance=0 + society=0 (player not in either)', () => {
    const payload = concat(
      u32(0),
      u32(2), u32(3), u32(4), u32(5), u32(10),
      u32(0),
      u32(7), u32(8), u32(9),
    );
    handler.handleMessage({
      type: 'event',
      opcode: GameMessageOpcode.GameEvent,
      sequence: 2,
      eventType: GameEventType.SetTurbineChatChannels,
      objectGuid: 0,
      payload,
    } as any);
    expect(calls[0]).toEqual({ allegiance: 0, society: 0 });
  });
});

describe('SetTurbineChatChannels as a top-level 0x0295 message (GDLE)', () => {
  // GDLE Client.cpp CClient::EnterWorld writes 0x295 then the same ten
  // uint32s and sends it unwrapped (no 0xF7B0 GameEvent header).
  it('a direct 0x0295 message reaches onSetTurbineChatChannels with the dynamic IDs', () => {
    const calls: any[] = [];
    const handler = new ServerMessageHandler();
    handler.setHandlers({ onSetTurbineChatChannels: d => calls.push(d) });
    const payload = concat(
      u32(0x100FFA01),
      u32(2), u32(3), u32(4), u32(5), u32(10),
      u32(0x100FFB02),
      u32(7), u32(8), u32(9),
    );
    handler.handleMessage({ type: 'direct', opcode: 0x0295, payload } as any);
    expect(calls).toEqual([{ allegiance: 0x100FFA01, society: 0x100FFB02 }]);
  });
});

describe('main.ts wires the consumer (FAITHFUL.363)', () => {
  it('main.ts onSetTurbineChatChannels stores both IDs', () => {
    const block = MAIN.match(/onSetTurbineChatChannels:[\s\S]+?^      \},/m)?.[0] ?? '';
    expect(block).toMatch(/playerAllegianceChannelId = data\.allegiance/);
    expect(block).toMatch(/playerSocietyChannelId = data\.society/);
  });

  it('TurbineChat consumer uses dynamic allegiance/society IDs before fixed-label fallback', () => {
    expect(MAIN).toMatch(/data\.channelId === playerAllegianceChannelId/);
    expect(MAIN).toMatch(/data\.channelId === playerSocietyChannelId/);
  });
});
