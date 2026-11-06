/**
 * OBS.login-after-refusal — did a login that got in, shortly after a refused
 * one to the same world, use the same credentials?
 *
 * Seedsow (GDL, Dark Majesty era), 2026-10-28 – 11-06: half the refused
 * logins were a first-time login refused with "Client logon failed", its two
 * quiet first_time retries (ProvenLoginRetry) refused too, then the same page
 * got in 10–80 s later and found no characters (a new account). Seedsow's
 * server creates accounts on first login (reference/classic/Seedsow
 * Network.cpp ConnectionRequest, DatabaseIO.cpp CreateAccount / VerifyAccount)
 * and refuses a name that exists with another password, or when its own
 * database query fails. Whether the player then changed the account or the
 * password (a taken name, a typo), or got in with the very same credentials
 * (a server flake that longer quiet retries would hide), decides what to do
 * next. The char_list event answers it with `afterRefusal`.
 *
 * Privacy, as ProvenLoginRetry: only a per-page salted SHA-256 of the account
 * (lowercased: the servers lowercase it) and, separately, of the password, in
 * memory; nothing is stored or sent but two booleans and two numbers. The
 * password compared is the one handed to the connection's connect(): the
 * password as the player typed it. The connection puts it on the wire in the
 * world's case itself (@ac/network loginWireCredentials, BUG.login-credential-case),
 * so a case retry (LoginCaseFallback: case_verbatim / case_lower) of the same
 * typed password is the same password here, never a changed one; and a
 * password retyped with other capitals reads as changed even on a world that
 * lowercases it. The case retries' own refusals are not counted (the reporter
 * skips login_retry kinds case_verbatim / case_lower). Nothing survives a
 * reload (the era switch's reload included): a refusal before one is lost.
 * Without WebCrypto nothing is compared and the field is never sent.
 *
 * Every era's connection (ACE's ClientConnection, GDL / GDLE's, AC1999's
 * Connection1999, on the page or in the network worker) goes through the same
 * connect() wrapper (PreworldReporter reportConnectAttempts) and the same
 * char_list report, so the field works the same in each.
 */
import { webCryptoDigest, type CredentialDigest } from './ProvenLoginRetry.js';

/** A refusal older than this when a login gets in is not reported. */
export const AFTER_REFUSAL_WINDOW_MS = 10 * 60_000;
/** The reported refusal count's bound. */
export const MAX_AFTER_REFUSAL_COUNT = 1000;
/** Refusals kept per page at most (the oldest go first). */
const MAX_KEPT = 64;

/** char_list's afterRefusal: the latest refusal on this world in the window, against the login that got in. */
export interface AfterRefusal {
  /** The same account name (case-insensitive) as the latest refused attempt. */
  sameAccount: boolean;
  /** The same password, as sent, as the latest refused attempt. */
  samePassword: boolean;
  /** From the latest refusal to the character list, in ms. */
  sinceRefusedMs: number;
  /** Refused attempts on this world in the window (the quiet retries' refusals included). */
  refusals: number;
}

interface Attempt {
  readonly world: string;
  account: string | null;
  password: string | null;
  ready: boolean;
}

interface Refusal {
  readonly attempt: Attempt;
  readonly at: number;
}

export class LoginRefusalMemory {
  private readonly digest: CredentialDigest;
  private readonly now: () => number;
  private readonly windowMs: number;
  private current: Attempt | null = null;
  private refusals: Refusal[] = [];

  constructor(opts: { digest?: CredentialDigest; now?: () => number; windowMs?: number } = {}) {
    this.digest = opts.digest ?? webCryptoDigest();
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.windowMs = opts.windowMs ?? AFTER_REFUSAL_WINDOW_MS;
  }

  /**
   * A connect attempt starts with these credentials (the connection's
   * connect() arguments). The digests start now, so they are ready long
   * before a server can answer; the returned promise is for tests.
   */
  attempt(world: string, account: string, password: string): Promise<void> {
    const a: Attempt = { world, account: null, password: null, ready: false };
    this.current = a;
    return Promise.all([this.digest(`a\u0000${account.toLowerCase()}`), this.digest(`p\u0000${password}`)])
      .then(([acc, pw]) => { a.account = acc; a.password = pw; })
      .catch(() => { /* compared as unknown: no field */ })
      .finally(() => { a.ready = true; });
  }

  /** The current attempt was refused (login_refused, or a login_retry's refusal). */
  refused(): void {
    if (!this.current) return;
    this.refusals.push({ attempt: this.current, at: this.now() });
    if (this.refusals.length > MAX_KEPT) this.refusals.splice(0, this.refusals.length - MAX_KEPT);
  }

  /**
   * The current attempt got in (its character list arrived): afterRefusal
   * when a login to the same world was refused within the window, else null.
   * The world's refusals are then forgotten, so a later character list (after
   * a logoff, or the next login) reports only refusals after this one. Null
   * too when a digest is missing (no WebCrypto, or not finished yet).
   */
  accepted(): AfterRefusal | null {
    const cur = this.current;
    if (!cur) return null;
    const now = this.now();
    const recent = this.refusals.filter((r) => r.attempt !== cur && r.attempt.world === cur.world && now - r.at <= this.windowMs);
    this.refusals = this.refusals.filter((r) => r.attempt.world !== cur.world && now - r.at <= this.windowMs);
    if (recent.length === 0) return null;
    const last = recent[recent.length - 1];
    if (!cur.ready || !last.attempt.ready || !cur.account || !cur.password || !last.attempt.account || !last.attempt.password) return null;
    return {
      sameAccount: cur.account === last.attempt.account,
      samePassword: cur.password === last.attempt.password,
      sinceRefusedMs: Math.max(0, Math.round(now - last.at)),
      refusals: Math.min(MAX_AFTER_REFUSAL_COUNT, recent.length),
    };
  }
}
