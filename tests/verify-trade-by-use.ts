/**
 * Trade opens by USING another player (retail), now that the invented world
 * right-click "Trade" entry is gone: ItemHolder::DetermineUseResult
 * @ 00588460 case 5 (not useable + a player other than us) →
 * CPlayerSystem::UsingItem @ 00562f70 → ClientTradeSystem::
 * AttemptToOpenTradeNegotiations @ 0056dee0 (peace mode only, else
 * "You need to be in peace mode to trade.").
 */
import { describe, it, expect } from 'vitest';
import { isTradeUse, attemptToOpenTradeNegotiations, PEACE_MODE_TO_TRADE_TEXT } from '@ac/shared';

const ME = 0x50000003;
describe('isTradeUse (DetermineUseResult case 5)', () => {
  // ItemUses::IsUseable @ 004fccc0 = ~bits & 1; ACE sends a player
  // ItemUseable = Usable.No (0x1) — observed live: flags 0x10000c, usable 1.
  it('another player with the No bit (as ACE sends players) → trade', () => {
    expect(isTradeUse({ guid: 0x50000002, objectDescFlags: 0x10000c, usable: 1 }, ME)).toBe(true);
  });
  it('ourselves, a useable player (Undef 0 counts as useable), an NPC or an item → not a trade', () => {
    expect(isTradeUse({ guid: ME, objectDescFlags: 0x8, usable: 1 }, ME)).toBe(false);
    expect(isTradeUse({ guid: 0x50000002, objectDescFlags: 0x8, usable: 0 }, ME)).toBe(false);
    expect(isTradeUse({ guid: 0x50000002, objectDescFlags: 0x8, usable: 0x20 }, ME)).toBe(false);
    expect(isTradeUse({ guid: 0x80000100, objectDescFlags: 0x10, usable: 1 }, ME)).toBe(false);
  });
});

describe('attemptToOpenTradeNegotiations', () => {
  it('peace mode sends; any combat mode refuses with the retail line', () => {
    expect(attemptToOpenTradeNegotiations(true, 0x50000002)).toEqual({ send: true });
    expect(attemptToOpenTradeNegotiations(false, 0x50000002)).toEqual({ send: false, message: PEACE_MODE_TO_TRADE_TEXT });
    expect(PEACE_MODE_TO_TRADE_TEXT).toBe('You need to be in peace mode to trade.');
  });
});
