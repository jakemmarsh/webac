/**
 * CPlayerSystem::Handle_AccountBooted @ 00562a70: the boot reason (ACE sends
 * e.g. " because the password entered for this account was not correct",
 * with its own leading space) fills "You have been booted from Asheron's
 * Call%s." (acclient.exe literal); an empty reason becomes " for Code of
 * Conduct Violations". Retail then moves the UI flow to its disconnected
 * state (UIFlow vtable +0x20, mode 0x10000002).
 */
export function accountBootedText(reason: string | undefined | null): string {
  const r = reason && reason.length > 0 ? reason : ' for Code of Conduct Violations';
  return `You have been booted from Asheron's Call${r}.`;
}

/**
 * Where a boot lands. A login the server refuses (wrong password, banned,
 * account in use) arrives before the world: when the player logged in from
 * the launcher, they need the launcher again to fix it, so the message is a
 * dialog whose OK returns there. URL logins (dev tooling) and in-world boots
 * get retail's Disconnected screen.
 */
export function accountBootSurface(opts: { inWorld: boolean; launcherLogin: boolean }): 'launcher' | 'disconnected' {
  return !opts.inWorld && opts.launcherLogin ? 'launcher' : 'disconnected';
}

/**
 * What OK on a client-side connection failure (ID_NetError_CantSocket,
 * ID_ConnectionError_ClientTimedOutServer) does. Retail exits after the box
 * (Client::Run returns). From the launcher that is the launcher again, where
 * the player can pick another world or fix the address, as for a refused
 * login (accountBootSurface). Relaunching the connect cycle there retried the
 * same unreachable bridge and put the same box back a second later, so OK
 * looked dead (playwebac.com, 2026-10-08). URL logins (dev tooling) relaunch.
 */
export function connectionFailureRecovery(opts: { inWorld: boolean; launcherLogin: boolean }): 'launcher' | 'relaunch' {
  return accountBootSurface(opts) === 'launcher' ? 'launcher' : 'relaunch';
}

const ASCTIME_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ASCTIME_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * C `asctime(localtime(&t))` without its trailing newline:
 * "Www Mmm dd hh:mm:ss yyyy", the day space-padded to width 2
 * (format "%.3s %.3s%3d %.2d:%.2d:%.2d %d").
 */
export function asctimeLocal(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${ASCTIME_DAYS[d.getDay()]} ${ASCTIME_MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} `
    + `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getFullYear()}`;
}

/**
 * CPlayerSystem::Handle_AccountBanned @ 00562bd0 (decomp :345474). The
 * seconds field is read as a SIGNED int (`iVar8 = *(int *)param_1`); the
 * reason is used verbatim, "" when absent or empty (no fallback, unlike
 * AccountBooted; ACE already sends " - <reason>"). `< 1` is a permanent ban:
 * "You have been banned from Asheron's Call%s." (acclient.exe VA 0x7cd590).
 * Otherwise the client's real time is rounded UP to the minute, the seconds
 * added, and the result printed with asctime minus its newline into "You have
 * been banned until %s%s. For ban appeals, please visit support.turbine.com"
 * (VA 0x7cd4e8). Retail then moves the UI flow to its disconnected state
 * (UIFlow vtable +0x20, mode 0x10000002), as for a boot.
 */
export function accountBannedText(seconds: number, reason: string | undefined | null, nowMs: number): string {
  const s = seconds | 0;
  const r = reason ?? '';
  if (s < 1) return `You have been banned from Asheron's Call${r}.`;
  let t = Math.floor(nowMs / 1000);
  if (t % 60 !== 0) t += 60 - (t % 60);
  t += s;
  return `You have been banned until ${asctimeLocal(t)}${r}. For ban appeals, please visit support.turbine.com`;
}
