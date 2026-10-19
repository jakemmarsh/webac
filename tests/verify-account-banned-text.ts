/**
 * SWEEP1006B.message-reactions.accountbanned-goes-hidden-pre-world
 *
 * CPlayerSystem::Handle_AccountBanned @ 00562bd0 (decomp :345474-345546):
 * signed seconds, `< 1` → "You have been banned from Asheron's Call%s."
 * (acclient.exe VA 0x7cd590); otherwise real time rounded up to the minute
 * plus the seconds, asctime without its newline, into "You have been banned
 * until %s%s. For ban appeals, please visit support.turbine.com" (VA
 * 0x7cd4e8). The text goes to UIFlow 0x10000002 like AccountBooted, so it
 * shares accountBootSurface.
 *
 * Deliberate departures (No Dead-End UI): Turbine's support site is gone, so
 * the appeal line names this server's operators (BAN_APPEAL_TEXT) under both
 * kinds of ban; and a reason that is not ACE's " - <reason>" continuation (no
 * leading space, GDLE's newline-padded ban string) is its own sentence
 * instead of running into the date (splitServerReason).
 */
import { describe, it, expect } from 'vitest';
import {
  accountBannedText, asctimeLocal, accountBootSurface, BAN_APPEAL_TEXT,
} from '../packages/renderer/src/session/AccountBoot.js';

const APPEAL = `\n\n${BAN_APPEAL_TEXT}`;

// Local-time construction keeps these independent of the runner's TZ
// (asctime uses localtime, as retail does).
const NOW = new Date(2026, 9, 6, 14, 32, 10).getTime();

describe('accountBannedText (retail Handle_AccountBanned)', () => {
  it('a zero or negative duration is the permanent ban', () => {
    expect(accountBannedText(0, '', NOW)).toBe(`You have been banned from Asheron's Call.${APPEAL}`);
    expect(accountBannedText(-5, ' - griefing', NOW)).toBe(`You have been banned from Asheron's Call - griefing.${APPEAL}`);
  });

  it('reads the seconds as signed: a uint32 with the top bit set is permanent, not far-future', () => {
    expect(accountBannedText(0xFFFFFFFF, '', NOW)).toBe(`You have been banned from Asheron's Call.${APPEAL}`);
  });

  it('a timed ban rounds now up to the minute, adds the seconds and prints asctime', () => {
    expect(accountBannedText(3600, '', NOW))
      .toBe(`You have been banned until Tue Oct  6 15:33:00 2026.${APPEAL}`);
  });

  it('an exact minute is not rounded further', () => {
    const onMinute = new Date(2026, 9, 6, 14, 32, 0).getTime();
    expect(accountBannedText(60, '', onMinute))
      .toBe(`You have been banned until Tue Oct  6 14:33:00 2026.${APPEAL}`);
  });

  it("appends ACE's ' - reason' inline and uses no fallback text", () => {
    expect(accountBannedText(60, ' - spamming', NOW))
      .toBe(`You have been banned until Tue Oct  6 14:34:00 2026 - spamming.${APPEAL}`);
    // A reason that already ends its sentence does not get a second period.
    expect(accountBannedText(60, ' - spamming.', NOW))
      .toBe(`You have been banned until Tue Oct  6 14:34:00 2026 - spamming.${APPEAL}`);
    for (const r of ['', undefined, null]) {
      expect(accountBannedText(60, r, NOW)).not.toContain('No reason');
      expect(accountBannedText(60, r, NOW)).toBe(`You have been banned until Tue Oct  6 14:34:00 2026.${APPEAL}`);
    }
  });

  it('a reason without a leading space no longer runs into the date: it is its own sentence', () => {
    expect(accountBannedText(60, 'Testing', NOW))
      .toBe(`You have been banned until Tue Oct  6 14:34:00 2026.\n\nTesting.${APPEAL}`);
    expect(accountBannedText(60, 'Testing.', NOW)).not.toContain('2026Testing');
    expect(accountBannedText(0, 'Cheating!', NOW)).toBe(`You have been banned from Asheron's Call.\n\nCheating!${APPEAL}`);
  });

  it("GDLE / AC1999's newline-padded ban string (KickBannedClient) is trimmed to one sentence", () => {
    expect(accountBannedText(3600, '\n\nYou are banned from this server\n\n\n\n', NOW))
      .toBe(`You have been banned until Tue Oct  6 15:33:00 2026.\n\nYou are banned from this server.${APPEAL}`);
  });

  it("never sends the player to Turbine's retired support site", () => {
    for (const s of [0, 60, 3600]) {
      for (const r of ['', ' - x', 'y', '\n\nz\n\n']) {
        expect(accountBannedText(s, r, NOW)).not.toMatch(/turbine/i);
        expect(accountBannedText(s, r, NOW).endsWith(BAN_APPEAL_TEXT)).toBe(true);
      }
    }
  });
});

describe('asctimeLocal', () => {
  it('pads the day with a space to width 2 and zero-pads the clock', () => {
    const t = new Date(2027, 0, 3, 4, 5, 6).getTime() / 1000;
    expect(asctimeLocal(t)).toBe('Sun Jan  3 04:05:06 2027');
    const t2 = new Date(2026, 11, 25, 23, 59, 59).getTime() / 1000;
    expect(asctimeLocal(t2)).toBe('Fri Dec 25 23:59:59 2026');
  });
});

describe('ban routing matches AccountBooted', () => {
  it('a refused launcher login returns to the launcher; URL logins get the Disconnected screen', () => {
    expect(accountBootSurface({ inWorld: false, launcherLogin: true })).toBe('launcher');
    expect(accountBootSurface({ inWorld: false, launcherLogin: false })).toBe('disconnected');
  });
});
