/**
 * RELEASE.gdle-untested-surfaces.a — a completed GDLE trade never moved the
 * items in either client: the giver's InventoryRemoveObject arrives wrapped
 * in a game event (GDLE TradeManager: 0x24 + item, game_event = TRUE; ACE
 * sends the top-level 0x0024), and the receiver gets only a ContainerID
 * update (CPlayerWeenie::OnReceiveInventoryItem → SetWeenieContainer) and a
 * PickupEvent, no 0x0022. Live (local GDLE 1.34): after a Gem Template
 * trade the giver's pack still listed it and the receiver's did not.
 */
import { describe, it, expect } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { tradeReceiveContainsIn } from '../packages/renderer/src/inventory/TradeReceiveContainId.js';

const ME = 0x50000001;
const PACK = 0x80000100;
const GEM = 0x90000998;
const ctx = (over: Partial<Parameters<typeof tradeReceiveContainsIn>[2]> = {}) => ({
  playerGuid: ME, sidePackGuids: [PACK], partnerTradeGuids: [GEM], holds: () => false, ...over,
});

describe('InventoryRemoveObject wrapped in a game event (GDLE)', () => {
  it('event 0x0024 reaches onInventoryRemove like the top-level message', () => {
    const removed: number[] = [];
    const handler = new ServerMessageHandler();
    handler.setHandlers({ onInventoryRemove: (d) => removed.push(d.itemGuid) });
    const payload = new Uint8Array([0x98, 0x09, 0x00, 0x90]);
    handler.handleMessage({ type: 'event', eventType: 0x0024, objectGuid: 0x50000002, sequence: 7, payload } as never);
    handler.handleMessage({ type: 'direct', opcode: 0x0024, payload } as never);
    expect(removed).toEqual([GEM, GEM]);
  });
});

describe('tradeReceiveContainsIn', () => {
  it('a partner\'s traded item contained in us or one of our packs is placed (the ServerSaysContainID path)', () => {
    expect(tradeReceiveContainsIn(GEM, ME, ctx())).toBe(true);
    expect(tradeReceiveContainsIn(GEM, PACK, ctx())).toBe(true);
  });

  it('anything else keeps to the 0x0022 path: not on the table, another container, already held, or no character', () => {
    expect(tradeReceiveContainsIn(0x90000111, ME, ctx())).toBe(false); // e.g. ACE's ground pickup
    expect(tradeReceiveContainsIn(GEM, 0x50000002, ctx())).toBe(false);
    expect(tradeReceiveContainsIn(GEM, ME, ctx({ holds: () => true }))).toBe(false);
    expect(tradeReceiveContainsIn(GEM, ME, ctx({ playerGuid: null }))).toBe(false);
  });
});
