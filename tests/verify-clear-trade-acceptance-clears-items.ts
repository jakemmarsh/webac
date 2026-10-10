/**
 * FAITHFUL.533 — onClearTradeAcceptance also wipes items, not just ready.
 *
 *  ACE Player_Trade.cs:189-194 ClearTradeAcceptance() body:
 *    ItemsInTradeWindow.Clear();   // server-side items wiped
 *    TradeAccepted = false;        // server-side ready wiped
 *    Session.Network.EnqueueSend(new GameEventClearTradeAcceptance(Session));
 *
 *  The server fires this for BOTH players from VerifyTrade_BusyState
 *  (Player_Trade.cs:356-357) and VerifyTrade_Inventory (Player_Trade.cs:
 *  424-425) when FinalizeTrade can't commit (someone busy, or no pack
 *  space for the inbound items). Server-side `ItemsInTradeWindow` is
 *  cleared for both sides BEFORE the GameEventClearTradeAcceptance
 *  goes out, so the client receiving the event MUST mirror by clearing
 *  yourItems + theirItems alongside the ready flags. Pre-fix the
 *  handler only cleared the ready flags — the trade slots visibly
 *  retained items while server-side state was empty, and the next
 *  Accept-click would finalize a zero-item trade.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('FAITHFUL.533 — onClearTradeAcceptance clears items + ready', () => {
  it('handler body resets yourItems and theirItems to []', () => {
    const handler = MAIN.match(/onClearTradeAcceptance: \(\) => \{[\s\S]+?^\s{6}\},/m)?.[0] ?? '';
    expect(handler.length).toBeGreaterThan(100);
    expect(handler).toMatch(/yourItems: \[\]/);
    expect(handler).toMatch(/theirItems: \[\]/);
  });

  it('handler body also resets yourReady and theirReady to false', () => {
    const handler = MAIN.match(/onClearTradeAcceptance: \(\) => \{[\s\S]+?^\s{6}\},/m)?.[0] ?? '';
    expect(handler).toMatch(/yourReady: false/);
    expect(handler).toMatch(/theirReady: false/);
  });

  it('handler preserves partnerGuid / initiatorGuid / theirName (trade negotiation still open)', () => {
    // The handler spreads `...td` over the existing state — partnerGuid,
    // initiatorGuid, and theirName are NOT explicitly reset because the
    // trade negotiation itself remains open (the user can re-add items
    // and retry Accept). Only the items + ready get wiped, NOT the
    // trade context.
    const handler = MAIN.match(/onClearTradeAcceptance: \(\) => \{[\s\S]+?^\s{6}\},/m)?.[0] ?? '';
    expect(handler).toMatch(/\.\.\.td/);
    // Must NOT zero out partnerGuid (would close the trade entirely
    // — different from FAITHFUL.531's hideTradeWindow reset path).
    expect(handler).not.toMatch(/partnerGuid: 0/);
    expect(handler).not.toMatch(/initiatorGuid: 0/);
    expect(handler).not.toMatch(/theirName: ''/);
  });

  it('cites FAITHFUL.533 + ACE source anchor', () => {
    const handler = MAIN.match(/onClearTradeAcceptance: \(\) => \{[\s\S]+?^\s{6}\},/m)?.[0] ?? '';
    expect(handler).toMatch(/FAITHFUL\.533/);
    expect(handler).toMatch(/Player_Trade\.cs/);
    expect(handler).toMatch(/ItemsInTradeWindow\.Clear/);
  });
});
