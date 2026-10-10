/**
 * FAITHFUL.264 — Remove redundant local 'You have died!' emit on ACE-mode death.
 *
 * Same double-emit pattern as FAITHFUL.263. ACE Player_Death.cs:34-93 sends
 * BOTH a private VictimNotification ('You have been slashed to death by X.')
 * AND a broadcast PlayerKilled ('Name has been slashed to death by X.').
 * Both route through `onVictimNotification`. A local generic 'You have died!'
 * was a third chat line for the same event.
 *
 * A second, solo-mode ("no ACE server in the loop") death fallback used to
 * live at a second call site and still used the local emit there, since
 * nothing else could provide VictimNotification text without a server. A
 * later cycle (GAP.81) traced that fallback's call graph and found it was
 * unreachable dead code — `checkPlayerDeath()` only ever runs once
 * `gameStarted` is true, which only happens once `aceCharGuid !== null` —
 * so it was deleted along with its own 'You have died!' emit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { victimOrKillerLine, playerKilledLine } from '../packages/renderer/src/ui/ServerMessageText.js';

const REPO = resolve(__dirname, '..');
const MAIN_TS = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');

describe('FAITHFUL.264 — death no double chat', () => {
  it("the ACE-mode death path no longer emits 'You have died!' as a chat call", () => {
    // The ACE-mode block is the one labeled '(ACE mode) — server will handle respawn'.
    const block = MAIN_TS.match(/console\.log\('\[AC\] Player died \(ACE mode\) — server will handle respawn'\);[\s\S]+?else if \(playerDead && !playerState\.isDead\)/)?.[0] ?? '';
    // Look for the actual addSystemMessage call with the string, not the text
    // mention in the FAITHFUL.264 explanatory comment.
    expect(block).not.toMatch(/gameUI\.addSystemMessage\('You have died!'/);
  });

  it("FAITHFUL.264 comment explains the removal + cross-references ACE source", () => {
    expect(MAIN_TS).toContain('FAITHFUL.264');
    expect(MAIN_TS).toContain('Player_Death.cs:53-69');
  });

  it("the unreachable solo-mode fallback (and its 'You have died!' emit) is gone (GAP.81 dead-code removal)", () => {
    expect(MAIN_TS).not.toMatch(/Client-side death handling fallback/);
    expect(MAIN_TS).not.toMatch(/function respawnPlayer\(/);
  });

  it("the server-provided death text is the chat line (HandleVictimNotificationEvent @ 0056c410, type 0)", () => {
    // DECOMP.kill-death-chat-lines — the private notification prints the
    // server's text verbatim as a type-0 line; the broadcast copy is dropped
    // for the victim, so exactly one line lands.
    expect(victimOrKillerLine('You have been slashed to death by a Drudge.'))
      .toEqual({ text: 'You have been slashed to death by a Drudge.', type: 0 });
    expect(playerKilledLine('Me has been slashed to death by a Drudge.', 0x50000001, 0x80000002, 0x50000001)).toBeNull();
  });
});
