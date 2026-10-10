/**
 * FAITHFUL.510 — "not enough mana" always reads with the retail-canonical
 *  wording.
 *
 *  ACE `Player_Magic.cs:583` rejects an under-mana cast with
 *  `WeenieError.YouDontHaveEnoughManaToCast` (0x0401), and the retail
 *  client prints it from ClientCommunicationSystem::HandleFailureEvent
 *  (case 0x401, decomp line 359910) as a 0x1a spew line:
 *    "You don't have enough Mana to cast this spell."
 *
 *  Pre-fix a client-side short-circuit printed a divergent short form
 *  ("You don't have enough mana!"). That local mana check lived only in
 *  the legacy non-ACE cast fallback, which was provably unreachable (the
 *  cast action is wired before the connection opens) and was deleted in
 *  DEBT.shared-dead-server-logic — so the server's WeenieError is now the
 *  only source of this line, exactly as in retail.
 */
import { describe, it, expect } from 'vitest';
import {
  WeenieError, weenieErrorText, weenieErrorTextType, WEENIE_ERROR_TEXT_TYPE_SPEW,
} from '@ac/shared';
import { CLIENT_NOTICES } from '../packages/renderer/src/ui/ClientNotices.js';

describe('FAITHFUL.510 — InsufficientMana uses the canonical retail text', () => {
  it('WeenieError 0x0401 resolves to the retail HandleFailureEvent literal', () => {
    expect(weenieErrorText(WeenieError.YouDontHaveEnoughManaToCast)).toBe(
      "You don't have enough Mana to cast this spell.",
    );
  });

  it('it routes to the 0x1a spew box, as HandleFailureEvent does', () => {
    expect(weenieErrorTextType(WeenieError.YouDontHaveEnoughManaToCast)).toBe(WEENIE_ERROR_TEXT_TYPE_SPEW);
  });

  it('no client-originated notice duplicates the server error (retail has no local mana pre-check)', () => {
    const texts = Object.values(CLIENT_NOTICES).map((n) => n.text);
    expect(texts).not.toContain("You don't have enough Mana to cast this spell.");
    expect(texts).not.toContain("You don't have enough mana!");
  });
});
