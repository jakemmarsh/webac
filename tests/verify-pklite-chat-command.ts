/**
 * FAITHFUL.564 — /pklite chat command opts the player into PK Lite mode by
 * sending GameActionType.EnterPkLite (0x02A4). Pre-fix the only way to ship
 * the action was via `acDebug.enterPkLite()` — no user-facing chat command,
 * so a player who knew the retail behavior would type `/pklite` and get
 * "Unknown command" silently.
 *
 * Wire format anchor: GameActionEnterPkLite.cs:7-11 (no payload, just the
 * action opcode).
 *
 * Server-side behavior anchor: Player.HandleActionEnterPkLite (Player.cs:1087-1159):
 *   1. Eligibility: PlayerKillerStatus must be NPK; MinimumTimeSincePk must
 *      be null. Failure → GameEventWeenieError(OnlyNonPKsMayEnterPKLite=0x0507).
 *   2. Not busy: IsBusy / Teleporting / suicideInProgress all false. Failure →
 *      GameEventWeenieError(YoureTooBusy=0x001D).
 *   3. Force NonCombat mode + play MotionCommand.EnterPKLite.
 *   4. Broadcast "{Name} is looking for a fight!" (LocalBroadcastRange).
 *   5. Self confirmation: GameEventWeenieError(YouAreNowPKLite=0x0506).
 *
 * Both rejection error codes (0x0507, 0x001D) and the success confirmation
 * code (0x0506) are already mapped in `weenieErrorText`, so the user gets
 * actionable feedback regardless of outcome.
 *
 * The @pklite / @pkl command itself is now the retail DoPKLite port
 * (chat/commands/DeathTravelHouseCommands.ts), driven behaviorally in
 * verify-retail-commands-death-travel-house.ts; this file keeps the ACE
 * anchors for the action it sends.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const ENTERPK_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionEnterPkLite.cs'),
  'utf8',
);
const PLAYER_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/WorldObjects/Player.cs'),
  'utf8',
);
const WEERR = readFileSync(
  resolve(REPO, 'packages/shared/src/combat/WeenieErrorText.ts'),
  'utf8',
);

describe('ACE source anchors EnterPkLite wire format + behavior (FAITHFUL.564)', () => {
  it('GameActionEnterPkLite reads no payload fields and delegates to player handler', () => {
    expect(ENTERPK_CS).toMatch(/\[GameAction\(GameActionType\.EnterPkLite\)\]/);
    expect(ENTERPK_CS).toMatch(/session\.Player\.HandleActionEnterPkLite\(\);/);
    // No ReadString16L / ReadUInt32 in the handler body — confirming empty payload.
    expect(ENTERPK_CS).not.toMatch(/ReadString16L|ReadUInt32|ReadSingle/);
  });

  it('Player.HandleActionEnterPkLite has both silent-reject paths plus success broadcast', () => {
    expect(PLAYER_CS).toMatch(/HandleActionEnterPkLite\(\)/);
    expect(PLAYER_CS).toMatch(/WeenieError\.OnlyNonPKsMayEnterPKLite/);
    expect(PLAYER_CS).toMatch(/WeenieError\.YoureTooBusy/);
    expect(PLAYER_CS).toMatch(/WeenieError\.YouAreNowPKLite/);
    expect(PLAYER_CS).toMatch(/"\{Name\} is looking for a fight!"/);
    expect(PLAYER_CS).toMatch(/MotionCommand\.EnterPKLite/);
    expect(PLAYER_CS).toMatch(/PlayerKillerStatus\.PKLite/);
  });
});

describe('Client-side WeenieError text covers both reject paths + success (FAITHFUL.564)', () => {
  it('OnlyNonPKsMayEnterPKLite (0x0507) has user-facing text', () => {
    expect(WEERR).toMatch(/\[0x0507\]:\s*'Only Non-Player Killers may enter PK Lite/);
  });

  it("YoureTooBusy (0x001D) has user-facing text", () => {
    expect(WEERR).toMatch(/\[0x001D\]:\s*'You\\'re too busy!/);
  });

  it('YouAreNowPKLite (0x0506) has user-facing text', () => {
    expect(WEERR).toMatch(/\[0x0506\]:/);
  });
});
