/**
 * FAITHFUL.519 — No local "Welcome to Asheron's Call!" echo on login.
 *
 *  ACE `WorldManager.cs:267-268` ships the canonical multi-line welcome
 *  alongside every login:
 *    "Welcome to Asheron's Call\n  powered by ACEmulator\n\n
 *     For more information on commands supported by this server, type @acehelp\n"
 *  Plus a PopupString modal (lines 251-264) with header + motd + welcome
 *  body.
 *
 *  Pre-fix our client emitted a hardcoded
 *  `addSystemMessage('Welcome to Asheron's Call!', ...)` immediately
 *  after startGame(), duplicating the server's first line (modulo the
 *  trailing "!"). After FAITHFUL.511's `\n` preservation, the server's
 *  "Welcome to Asheron's Call" rendered as its own visible row, making
 *  the duplication starkly visible.
 *
 *  CORE.17.k (2026-09-09): the companion local "X has entered the world."
 *  line is gone as well. It was our own invention — neither ACE.Server nor
 *  the decompiled EoL client carries that string — i.e. a client
 *  diagnostic printed into the in-game chat log, which retail never does
 *  (client notices go to the spew box / console, see SpewBoxModel.ts).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('FAITHFUL.519 — no local "Welcome to Asheron\'s Call!" echo', () => {
  it('no local addSystemMessage with the "Welcome to Asheron\'s Call!" string', () => {
    expect(MAIN).not.toMatch(/addSystemMessage\('Welcome to Asheron\\'s Call!'/);
  });

  it('no local "X has entered the world." chat line either (CORE.17.k — invented client diagnostic)', () => {
    expect(MAIN).not.toMatch(/addSystemMessage\([^;]*has entered the world/);
  });

  it('cites FAITHFUL.519 + ACE WorldManager.cs', () => {
    expect(MAIN).toMatch(/FAITHFUL\.519[\s\S]+?WorldManager\.cs/);
  });
});
