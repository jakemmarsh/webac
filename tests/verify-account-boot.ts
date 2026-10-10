import { describe, it, expect } from 'vitest';
import { accountBootedText, accountBootSurface, connectionFailureRecovery } from '../packages/renderer/src/session/AccountBoot.js';

// CPlayerSystem::Handle_AccountBooted @ 00562a70 + the acclient.exe literal
// "You have been booted from Asheron's Call%s.". A wrong password on
// playwebac.com left "Please Wait" up forever (2026-10-04).
describe('account boot', () => {
  it('formats ACE reasons with retail text (ACE supplies the leading space)', () => {
    expect(accountBootedText(' because the password entered for this account was not correct'))
      .toBe("You have been booted from Asheron's Call because the password entered for this account was not correct.");
  });

  it('an empty reason is the Code of Conduct default', () => {
    for (const r of ['', undefined, null]) {
      expect(accountBootedText(r)).toBe("You have been booted from Asheron's Call for Code of Conduct Violations.");
    }
  });

  it('a refused launcher login returns to the launcher; URL logins and in-world boots get the Disconnected screen', () => {
    expect(accountBootSurface({ inWorld: false, launcherLogin: true })).toBe('launcher');
    expect(accountBootSurface({ inWorld: false, launcherLogin: false })).toBe('disconnected');
    expect(accountBootSurface({ inWorld: true, launcherLogin: true })).toBe('disconnected');
  });

  it('OK on a connection failure returns a launcher login to the launcher; it used to retry the same unreachable bridge (playwebac.com, 2026-10-08)', () => {
    expect(connectionFailureRecovery({ inWorld: false, launcherLogin: true })).toBe('launcher');
    expect(connectionFailureRecovery({ inWorld: false, launcherLogin: false })).toBe('relaunch');
    expect(connectionFailureRecovery({ inWorld: true, launcherLogin: true })).toBe('relaunch');
  });
});
