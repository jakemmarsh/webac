/**
 * CPlayerSystem::Handle_AccountBooted @ 00562a70: the boot reason (ACE sends
 * e.g. " because the password entered for this account was not correct",
 * with its own leading space) fills "You have been booted from Asheron's
 * Call%s." (acclient.exe literal); an empty reason becomes " for Code of
 * Conduct Violations". Retail then moves the UI flow to its disconnected
 * state (UIFlow vtable +0x20, mode 0x10000002).
 */
/**
 * ACE's (and ClassicACE's) wrong-password boot reason
 * (AuthenticationHandler.cs:174, ClassicACE :217): an EXISTING account name
 * with another password. ACE answers an unknown name by creating it
 * (auto-create worlds) or with CharacterError.AccountDoesntExist, never this.
 */
export const PASSWORD_MISMATCH_BOOT_REASON = ' because the password entered for this account was not correct';

/** webAC players can't install a client: a version refusal is fixed by reloading the page. */
export const RELOAD_FOR_LATEST_TEXT = 'Reload the page to get the latest webAC.';

/** The next step under a ban: Turbine's support site is gone; the server's own operators hear appeals. */
export const BAN_APPEAL_TEXT = "To appeal, contact this server's operators.";

/**
 * Boot reasons that mean "your client is the wrong version". ACE
 * (AuthenticationHandler.cs:114, CharacterHandler.cs:139) sends " because
 * your client is not the correct version for this server. Please visit
 * http://play.emu.ac/ to update to latest client"; ClassicACE sends
 * " because you are not running the correct executable file version for
 * this server" (AuthenticationHandler.cs:189) and " because you do not have
 * the correct data files for this server" (CharacterHandler.cs:148). A webAC
 * player can install nothing and play.emu.ac is a download page, so the
 * reason keeps its first clause and the next step is a reload.
 */
const CLIENT_VERSION_BOOT_RE = /^\s*because (?:your client is not the correct version|you are not running the correct executable file version|you do not have the correct data files)\b/i;

/** A trailing sentence that sends the player to a website to download something: dropped from server reasons. */
const DOWNLOAD_LINK_SENTENCE_RE = /\.?\s*Please visit \S*(?:https?:\/\/|www\.)\S*[^.]*\.?\s*$/i;

/**
 * A refusal that names a VPN or proxy: ClassicACE's " Connections from VPN /
 * proxy disallowed by server policy" (AuthenticationHandler.cs:265, AChard)
 * and any other server's wording of the same rule (JawnTide's site says "No
 * VPNs or proxies"; its boot text was never captured, 2026-10-29). Every
 * webAC player reaches a world through the bridge's shared egress, which such
 * a check sees as a proxy, so no webAC player can get in there.
 */
const PROXY_REFUSAL_RE = /\b(?:vpns?|prox(?:y|ies))\b/i;

/** True for a boot / ban reason that refuses VPN or proxy connections (PROXY_REFUSAL_RE). */
export function isProxyRefusalReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && PROXY_REFUSAL_RE.test(reason);
}

/** The next step under a VPN / proxy refusal: nothing the player can change from webAC. */
export const PROXY_REFUSED_HINT =
  "This world doesn't accept connections that come through a proxy, and webAC connects through one. Pick another world.";

/**
 * A refusal over a per-address (per-IP) limit on accounts or sessions
 * ("Up to 2 accounts logged in at a time per person", JawnTide): the words
 * IP / address together with a limit word. Every webAC player shares the
 * bridge's address, so other webAC players can fill such a limit.
 */
const ADDRESS_LIMIT_REFUSAL_RE = /\b(?:ip|address(?:es)?)\b/i;
const LIMIT_WORD_RE = /\b(?:too many|limit(?:ed)?|max(?:imum)?|only \d+|exceed(?:s|ed)?)\b/i;

/** True for a boot reason about a per-address limit (and not a VPN / proxy refusal). */
export function isAddressLimitReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && !isProxyRefusalReason(reason)
    && ADDRESS_LIMIT_REFUSAL_RE.test(reason) && LIMIT_WORD_RE.test(reason);
}

/** The next step under a per-address limit refusal. */
export const ADDRESS_LIMIT_HINT =
  'Every webAC player reaches this world from the same address, so its per-address limit may be taken by other webAC players. Try again later, or pick another world.';

/** The webAC next step for a server's boot / ban reason, or null when retail's text is enough. */
export function serverReasonNextStep(reason: string | null | undefined): string | null {
  if (isClientVersionBootReason(reason)) return RELOAD_FOR_LATEST_TEXT;
  if (isProxyRefusalReason(reason)) return PROXY_REFUSED_HINT;
  if (isAddressLimitReason(reason)) return ADDRESS_LIMIT_HINT;
  return null;
}

/** True for a boot reason that says the client is the wrong version (CLIENT_VERSION_BOOT_RE). */
export function isClientVersionBootReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && CLIENT_VERSION_BOOT_RE.test(reason);
}

/**
 * A server-supplied reason, split for joining onto retail's sentence ("You
 * have been booted from Asheron's Call%s." / "…banned until %s%s."). Retail
 * pasted it verbatim, which reads right only for ACE's own continuations
 * (" because …", " for …", " - …"). ClassicACE's VPN boot (" Connections
 * from VPN / proxy disallowed by server policy"), a reason with no leading
 * space ("…2026Testing.") and GDLE's / the AC1999 server's ban string,
 * padded with newlines to push retail's support.turbine.com line out of the
 * box ("\n\n<ban string>\n\n\n\n", Network.cpp KickBannedClient), did not.
 * A continuation (one leading space, then a lower-case word, an opening
 * bracket, a comma / colon / semicolon, or a spaced dash) stays inline
 * without its trailing period (the caller's format adds one); anything else
 * becomes its own sentence, given a period when it has no end mark. Returns
 * [inline, ownSentence]; at most one is non-empty.
 */
export function splitServerReason(reason: string | null | undefined): [string, string] {
  if (typeof reason !== 'string') return ['', ''];
  const body = reason.replace(DOWNLOAD_LINK_SENTENCE_RE, '').trim();
  if (!body) return ['', ''];
  if (/^ (?:[a-z([,;:]|[-–—] )/.test(reason)) return [` ${body.replace(/\.+$/, '')}`, ''];
  return ['', /[.!?]$/.test(body) ? body : `${body}.`];
}

export function accountBootedText(reason: string | undefined | null): string {
  const given = typeof reason === 'string' && reason.length > 0;
  const [inline, own] = given ? splitServerReason(reason) : [' for Code of Conduct Violations', ''];
  let text = `You have been booted from Asheron's Call${inline}.`;
  if (own) text += `\n\n${own}`;
  const next = serverReasonNextStep(reason);
  if (next) text += `\n\n${next}`;
  return text;
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
 * reason has no fallback, unlike AccountBooted (ACE sends " - <reason>").
 * `< 1` is a permanent ban: "You have been banned from Asheron's Call%s."
 * (acclient.exe VA 0x7cd590). Otherwise the client's real time is rounded UP
 * to the minute, the seconds added, and the result printed with asctime minus
 * its newline into "You have been banned until %s%s. For ban appeals, please
 * visit support.turbine.com" (VA 0x7cd4e8). Retail then moves the UI flow to
 * its disconnected state (UIFlow vtable +0x20, mode 0x10000002), as for a
 * boot.
 *
 * Two deliberate departures: Turbine's support site is gone (No Dead-End
 * UI), so the appeal line names this server's operators instead, under both
 * kinds of ban; and the reason is joined by splitServerReason, so one sent
 * without ACE's leading " - " no longer runs into the date.
 */
export function accountBannedText(seconds: number, reason: string | undefined | null, nowMs: number): string {
  const s = seconds | 0;
  const [inline, own] = splitServerReason(reason);
  // A ban for a VPN / proxy (or a per-address limit) gets its next step before the appeal line.
  const next = isProxyRefusalReason(reason) || isAddressLimitReason(reason) ? serverReasonNextStep(reason) : null;
  const tail = `${own ? `\n\n${own}` : ''}${next ? `\n\n${next}` : ''}\n\n${BAN_APPEAL_TEXT}`;
  if (s < 1) return `You have been banned from Asheron's Call${inline}.${tail}`;
  let t = Math.floor(nowMs / 1000);
  if (t % 60 !== 0) t += 60 - (t % 60);
  t += s;
  return `You have been banned until ${asctimeLocal(t)}${inline}.${tail}`;
}
