/**
 * BUG.login-credential-case — which case the password goes on the wire in,
 * and the one quiet retry with the password as typed.
 *
 * Players on Reefcull (GDL) reported that mixed-case credentials that work
 * through ThwargLauncher failed in webAC, while the same ones typed lowercase
 * worked. Retail lowercases its whole `-a` argument (`_strlwr` in
 * Client::EvaluateCommandLineArg @ 0x004124f0; the 1999 client's tolower
 * copy @ 0x00402380), and ThwargLauncher launches GDL / GDLE worlds as
 * "-a user:password", so those servers only ever saw lowercase passwords and
 * hashed their accounts that way (GDL compares SHA512(password + salt) case
 * for case). @ac/network loginWireCredentials does the same: the account is
 * always lowercased, the password when `passwordCase` is 'lower'.
 *
 * passwordCaseFor decides 'lower' exactly where retail's launch carried the
 * password inside `-a`: a GDL / GDLE world (the launcher world's emu, as
 * string16WireFor decides the string wire; never DAT iterations) or an era
 * whose LoginRequest is auth type 1 "account:password" (Seedsow's classic
 * profile, AC1999). ACE / ClassicACE take "-a user -v password": verbatim.
 *
 * A departure from retail (a named browser-UX exception in CLAUDE.md): an
 * account made with capitals in its password (a web form that allowed them,
 * or an earlier webAC login that auto-created it as typed) would be locked
 * out by the lowercasing. So when a lowercased password that differs from
 * what was typed is refused with "Client logon failed", the page logs in once
 * more at once with the password exactly as typed (LoginCaseFallback). The
 * form that gets in stays for the session (resumes, reconnects); a new
 * launcher ENTER starts from the world's rule again. Nothing is stored.
 */
import { retailLowercase, type LoginProfile, type PasswordCase } from '@ac/network';

/** Emulators ThwargLauncher launches as "-a user:password" (GameLauncher.cs). */
export const LOWERCASE_PASSWORD_EMUS: ReadonlySet<string> = new Set(['GDL', 'GDLE']);

/** The refusal a lowercased password can earn when the account's password has capitals. */
export const CASE_VERBATIM_REFUSAL_TOKEN = 'ID_ConnectionError_ClientLogOnFailed';

/** The wait before the as-typed retry: the refused socket is done, the bridge needs only a moment. */
export const CASE_VERBATIM_RETRY_DELAY_MS = 500;

/** The login profile's password case for an era's login and the launcher world's emulator (null: a URL / Custom… login). */
export function passwordCaseFor(login: Pick<LoginProfile, 'authStyle'>, emu: string | null | undefined): PasswordCase {
  if (login.authStyle === 'account-colon-password') return 'lower';
  return emu && LOWERCASE_PASSWORD_EMUS.has(emu.toUpperCase()) ? 'lower' : 'verbatim';
}

/**
 * The page's password case for the login under way. `current` is what the
 * connection sends (main.ts copies it into aceConnection.loginProfile).
 */
export class LoginCaseFallback {
  private policy: PasswordCase;
  private mode: PasswordCase;
  private tried = false;

  constructor(policy: PasswordCase = 'verbatim') {
    this.policy = policy;
    this.mode = policy;
  }

  /** The password case the next LoginRequest uses. */
  get current(): PasswordCase {
    return this.mode;
  }

  /** `base` with the current password case. */
  profile(base: LoginProfile): LoginProfile {
    return { ...base, passwordCase: this.mode };
  }

  /** A new login (a launcher ENTER, an era-switch resume, a URL login): the world's rule, no retry made yet. */
  reset(policy: PasswordCase): void {
    this.policy = policy;
    this.mode = policy;
    this.tried = false;
  }

  /** The server accepted the login: keep the form that got in (resumes reuse it). */
  noteAccepted(): void {
    this.tried = false;
  }

  /**
   * A login was refused with `token`. True: log in again now with the
   * password as typed (`current` is now 'verbatim'). Once per login: when
   * that attempt is refused too, the world's rule comes back for the
   * existing quiet retries and the error, and this never fires again until
   * a reset or an accepted login.
   */
  onRefused(token: string | null | undefined, typedPassword: string): boolean {
    if (token !== CASE_VERBATIM_REFUSAL_TOKEN) return false;
    if (!this.tried && this.mode === 'lower' && retailLowercase(typedPassword) !== typedPassword) {
      this.tried = true;
      this.mode = 'verbatim';
      return true;
    }
    if (this.tried && this.mode === 'verbatim') this.mode = this.policy;
    return false;
  }
}
