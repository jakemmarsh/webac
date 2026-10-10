/**
 * SWEEP1006B.message-reactions.accountbanned-goes-hidden-pre-world
 *
 * CPlayerSystem::Handle_AccountBanned @ 00562bd0 (decomp :345474-345546):
 * signed seconds, `< 1` → "You have been banned from Asheron's Call%s."
 * (acclient.exe VA 0x7cd590); otherwise real time rounded up to the minute
 * plus the seconds, asctime without its newline, into "You have been banned
 * until %s%s. For ban appeals, please visit support.turbine.com" (VA
 * 0x7cd4e8). The reason is used verbatim ("" when absent). The text goes to
 * UIFlow 0x10000002 like AccountBooted, so it shares accountBootSurface.
 */
import { describe, it, expect } from 'vitest';
import {
  accountBannedText, asctimeLocal, accountBootSurface,
} from '../packages/renderer/src/session/AccountBoot.js';

// Local-time construction keeps these independent of the runner's TZ
// (asctime uses localtime, as retail does).
const NOW = new Date(2026, 9, 6, 14, 32, 10).getTime();

describe('accountBannedText (retail Handle_AccountBanned)', () => {
  it('a zero or negative duration is the permanent ban', () => {
    expect(accountBannedText(0, '', NOW)).toBe("You have been banned from Asheron's Call.");
    expect(accountBannedText(-5, ' - griefing', NOW)).toBe("You have been banned from Asheron's Call - griefing.");
  });

  it('reads the seconds as signed: a uint32 with the top bit set is permanent, not far-future', () => {
    expect(accountBannedText(0xFFFFFFFF, '', NOW)).toBe("You have been banned from Asheron's Call.");
  });

  it('a timed ban rounds now up to the minute, adds the seconds and prints asctime', () => {
    expect(accountBannedText(3600, '', NOW))
      .toBe('You have been banned until Tue Oct  6 15:33:00 2026. For ban appeals, please visit support.turbine.com');
  });

  it('an exact minute is not rounded further', () => {
    const onMinute = new Date(2026, 9, 6, 14, 32, 0).getTime();
    expect(accountBannedText(60, '', onMinute))
      .toBe('You have been banned until Tue Oct  6 14:33:00 2026. For ban appeals, please visit support.turbine.com');
  });

  it("appends ACE's ' - reason' verbatim and uses no fallback text", () => {
    expect(accountBannedText(60, ' - spamming', NOW))
      .toBe('You have been banned until Tue Oct  6 14:34:00 2026 - spamming. For ban appeals, please visit support.turbine.com');
    for (const r of ['', undefined, null]) {
      expect(accountBannedText(60, r, NOW)).not.toContain('No reason');
      expect(accountBannedText(60, r, NOW)).toContain('2026. For ban appeals');
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
