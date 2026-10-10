/**
 * FAITHFUL.568 (revises .357) — `/`-prefixed unknown chat commands are
 * rewritten to `@`-prefix and forwarded to the server's command parser
 * instead of being blocked locally.
 *
 * Per ACE `GameActionTalk.cs:21` the server-side command parser ONLY
 * matches `@` prefix:
 *
 *   if (message.StartsWith("@")) { ...command parser... }
 *   else                          { HandleActionTalk(...broadcast...) }
 *
 * Per FAITHFUL.241 (Microsoft KB Q243622) `/` and `@` are
 * user-interchangeable in retail AC — typing `/myquests` should work
 * identically to `@myquests`. The conversion has to happen on the client
 * because ACE's server only accepts `@`.
 *
 * Pre-fix the FAITHFUL.357 guard caught all unhandled `/`-commands and
 * emitted a local "Unknown command: foo" SystemChat, SWALLOWING the
 * request. So legitimate server commands typed with `/` (e.g.
 * `/myquests`, `/finger Bob`, `/grantxp 1000000`, `/smite all`,
 * `/teleloc ...`, `/create <wcid>`) never reached the server.
 *
 * Post-fix the client rewrites `/foo bar` to `@foo bar` and forwards via
 * GameAction.Talk. The server's `CommandHandlerResponse.InvalidCommand`
 * branch (GameActionTalk.cs:85-87) emits the canonical "Unknown command:
 * foo" SystemChat reply if the command really is unknown — so the user
 * still gets feedback for typos, sourced authoritatively from the server.
 *
 * `@`-prefixed unknowns continue to be passed through verbatim
 * (FAITHFUL.241 pin in verify-at-prefix-commands.ts) — no change there.
 *
 * The client side is now the retail command system: OnChatCommand turns a
 * leading '/' into '@' and DoCommand sends any name with no table entry (and
 * no channel alias) to the server as Event_Talk of the whole line — driven in
 * verify-retail-command-dispatch.ts ("an unknown command goes to the server
 * as Talk") and verify-tier-command-passthrough.ts. This file keeps the ACE
 * anchors that make the '@' rewrite necessary.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const ACE_TALK = readFileSync(resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionTalk.cs'), 'utf8');

describe('FAITHFUL.568 — ACE source anchor remains valid', () => {
  it('ACE GameActionTalk.cs:21 still gates on `@` prefix exclusively', () => {
    expect(ACE_TALK).toMatch(/if \(message\.StartsWith\("@"\)\)/);
  });

  it('ACE GameActionTalk.cs still emits the canonical "Unknown command" SystemChat on InvalidCommand', () => {
    expect(ACE_TALK).toMatch(/InvalidCommand/);
    expect(ACE_TALK).toMatch(/Unknown command:/);
  });

  it('the non-@ branch still calls HandleActionTalk (would broadcast `/foo` as say-chat without rewrite)', () => {
    expect(ACE_TALK).toMatch(/HandleActionTalk\(message\)/);
  });
});
