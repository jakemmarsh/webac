/**
 * FAITHFUL.195 — account/character lifecycle wiring (chess: see the note below).
 *
 * Pre-FAITHFUL.195 these handlers were parsed by the network layer but
 * never registered in main.ts. Account boot/ban/character-delete/logoff
 * events vanished silently. Chess minigame opponent moves, game-over,
 * stalemate, and start-game events fired into the void.
 *
 * Mirrors FAITHFUL.190/194 wiring drift-guard pattern.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN_SRC = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');

describe('FAITHFUL.195 — account/character lifecycle wiring', () => {
  // onAccountBoot: the old chat-line pin was retired 2026-10-04. Retail
  // (CPlayerSystem::Handle_AccountBooted @ 00562a70) leaves for the
  // disconnected flow; a chat line left a refused login on "Please Wait"
  // forever. Behaviour is covered by tests/verify-account-boot.ts against
  // the real module.

  // onAccountBanned: the formatBanDuration source pin was retired
  // 2026-10-06 (SWEEP1006B.message-reactions.accountbanned-goes-hidden-pre-world).
  // Retail's ban text and its disconnected-flow routing are covered against
  // the real module in tests/verify-account-banned-text.ts.

  it('onCharacterDelete registered', () => {
    expect(MAIN_SRC).toContain('onCharacterDelete:');
  });

  it('onCharacterLogOff registered', () => {
    expect(MAIN_SRC).toContain('onCharacterLogOff:');
  });

  it('onAdminEnvirons registered (admin global-env trigger)', () => {
    expect(MAIN_SRC).toContain('onAdminEnvirons:');
  });
});

// The chess half of FAITHFUL.195 used to pin invented chat strings in
// main.ts's source ("Chess: game started.", "White wins", …). GAP.indicator-
// bar-interactive routed every chess GameEvent into the retail chess panel's
// state machine (gmMiniGameUI), which prints the decompiled client's own
// lines; that behaviour is driven directly in verify-minigame-chess-logic.ts
// and verify-minigame-chess-panel.ts.
