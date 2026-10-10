/**
 * EndTradeReason enum + label helper tests.
 *
 * Pins values to ACE source so the wire format can't drift:
 *   Normal=0x01, EnteredCombat=0x02, Canceled=0x51.
 *
 * DECOMP.trade-closed-notice — the close text does NOT depend on the reason:
 * retail Handle_Trade__Recv_CloseTrade @ 0056de30 always posts "The trade
 * has been cancelled." as type 0x1a (the spew box). The reason→text helper
 * (with its invented "entered combat" wording) is gone.
 */
import { describe, it, expect } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as shared from '../packages/shared/src/index.js';
import { EndTradeReason } from '../packages/shared/src/enums/EndTradeReason.js';
import { tradeClosedLine, addTextToScroll, TRADE_CLOSED_TEXT } from '../packages/renderer/src/ui/ServerMessageText.js';

const REPO = resolve(__dirname, '..');
const ACE_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/EndTradeReason.cs');

describe('EndTradeReason enum (FAITHFUL.130)', () => {
  it.skipIf(!aceReferenceExists(ACE_PATH))('matches ACE source 1:1', () => {
    const src = readFileSync(ACE_PATH, 'utf8');
    expect(src).toMatch(/Normal\s*=\s*0x1\b/);
    expect(src).toMatch(/EnteredCombat\s*=\s*0x2\b/);
    expect(src).toMatch(/Canceled\s*=\s*0x51\b/);
    expect(EndTradeReason.Normal).toBe(0x01);
    expect(EndTradeReason.EnteredCombat).toBe(0x02);
    expect(EndTradeReason.Canceled).toBe(0x51);
  });
});

describe('DECOMP.trade-closed-notice — Handle_Trade__Recv_CloseTrade @ 0056de30', () => {
  it('the close line is always "The trade has been cancelled." as type 0x1a', () => {
    expect(TRADE_CLOSED_TEXT).toBe('The trade has been cancelled.');
    expect(tradeClosedLine()).toEqual({ text: 'The trade has been cancelled.', type: 0x1a });
  });

  it('it lands in the spew box (displayErrorText), not as a chat line', () => {
    const calls: string[] = [];
    addTextToScroll({
      displayErrorText: (t) => calls.push(`spew:${t}`),
      addSystemMessage: (t) => calls.push(`chat:${t}`),
    }, tradeClosedLine());
    expect(calls).toEqual(['spew:The trade has been cancelled.']);
  });

  it('the invented reason→text helper is no longer exported', () => {
    expect('endTradeReasonText' in shared).toBe(false);
  });
});
