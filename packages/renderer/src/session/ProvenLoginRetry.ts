/**
 * BUG.gdle-transient-login-failed — a quiet retry of a refused login whose
 * credentials already got in to this world earlier in this page's lifetime.
 *
 * GDLE / ClassicDereth (the Dark Majesty worlds) and the AC1999 server answer
 * a refused LoginRequest with the STR_LOGIN_FAILED NetError
 * (ID_ConnectionError_ClientLogOnFailed, 0x04DF9C54 in table 8) whenever
 * `AuthenticateUserQuery::PerformQuery` sees `VerifyAccount` fail
 * (reference/classic/ClassicDereth/Source/Network.cpp; reference/ac1999
 * Server/Source/Network.cpp). That is a wrong password, and also the
 * server's own account query failing. Production 2026-10-17 (Seedsow): a
 * player logged out at 16:52:31, was refused at 16:52:35 and got in at
 * 16:52:43 with the same credentials; another was refused twice, then got in
 * a minute later, several times overnight. Most likely the database was busy
 * saving the logout.
 *
 * Retail showed the error at once. Ours retries on its own, behind the
 * connecting screen, at 3 s and then 6 s, but ONLY when this exact world +
 * account + password already logged in successfully on this page: a
 * first-time login (a typo) gets today's error immediately. A named
 * browser-UX exception (CLAUDE.md), like the automatic reconnect.
 *
 * Privacy: the page already holds the password it logs in with (main.ts
 * acePassword). This module keeps only a salted SHA-256 of world, account and
 * password, in memory, per page; nothing is persisted. Without WebCrypto (an
 * insecure context) nothing is ever proven and every refusal is shown at once.
 *
 * ACE (end of retail) never sends this NetError (its wrong password is an
 * AccountBoot, its account-in-use a CharacterError ClientConnection already
 * retries), so the same decision simply never fires there.
 */

/** Waits before each automatic retry of a proven login (about 10 s in all); after the last, today's error. */
export const PROVEN_LOGIN_RETRY_DELAYS_MS: readonly number[] = Object.freeze([3000, 6000]);

/**
 * Login refusals a proven login retries. Only the server's catch-all "Client
 * logon failed": never the account-in-use refusals (retail behaviour, the
 * account really is in use), the server-full or version refusals, or the
 * client's own give-ups (no socket, a timed-out login that already resent
 * for 40 s / 150 s).
 */
export const RETRYABLE_LOGIN_REFUSAL_TOKENS: ReadonlySet<string> = new Set([
  'ID_ConnectionError_ClientLogOnFailed',
]);

/** What a login was made with. `world` is the bridge URL naming the server (main.ts connectUrl). */
export interface LoginCredentials {
  readonly world: string;
  readonly account: string;
  readonly password: string;
}

/**
 * The pure decision: the delay before the next automatic retry, or null to
 * show the refusal now. `retriesSoFar` counts this refusal's earlier
 * automatic retries (0 for the player's own attempt).
 */
export function provenLoginRetryDelay(input: {
  token: string | null | undefined;
  proven: boolean;
  retriesSoFar: number;
  delays?: readonly number[];
}): number | null {
  const delays = input.delays ?? PROVEN_LOGIN_RETRY_DELAYS_MS;
  if (!input.proven) return null;
  if (!input.token || !RETRYABLE_LOGIN_REFUSAL_TOKENS.has(input.token)) return null;
  if (input.retriesSoFar < 0 || input.retriesSoFar >= delays.length) return null;
  return delays[input.retriesSoFar];
}

export type ProvenLoginRefusalVerdict =
  | { readonly retry: true; readonly attempt: number; readonly delayMs: number }
  | { readonly retry: false };

/** A salted digest of `text`, or null when the platform has no WebCrypto. */
export type CredentialDigest = (text: string) => Promise<string | null>;

function randomSalt(): string {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) return '';
  const bytes = c.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 (WebCrypto) of a per-page salt + `text`; null without crypto.subtle. */
export function webCryptoDigest(salt: string = randomSalt()): CredentialDigest {
  return async (text) => {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle || !salt) return null;
    try {
      const hash = await subtle.digest('SHA-256', new TextEncoder().encode(`${salt}\u0000${text}`));
      return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return null;
    }
  };
}

function credentialText(c: LoginCredentials): string {
  return `${c.world}\u0000${c.account}\u0000${c.password}`;
}

/**
 * The page's proven logins and the retry count of the refusal under way.
 * main.ts calls noteAccepted on each character list, onRefused on each
 * login-phase NetError refusal, and cancel when the player (or another tab)
 * ends the connect cycle while a retry is pending.
 */
export class ProvenLoginRetry {
  private readonly digest: CredentialDigest;
  private readonly delays: readonly number[];
  private readonly proven = new Set<string>();
  private pendingNote: Promise<void> = Promise.resolve();
  private retries = 0;

  constructor(opts: { digest?: CredentialDigest; delays?: readonly number[] } = {}) {
    this.digest = opts.digest ?? webCryptoDigest();
    this.delays = opts.delays ?? PROVEN_LOGIN_RETRY_DELAYS_MS;
  }

  /** Retries already made for the refusal under way (0 when none is). */
  get retriesSoFar(): number {
    return this.retries;
  }

  /** The server accepted a login (its character list arrived): these credentials are proven for this world. */
  noteAccepted(creds: LoginCredentials): Promise<void> {
    this.retries = 0;
    if (!creds.account || !creds.password) return this.pendingNote;
    const text = credentialText(creds);
    this.pendingNote = this.pendingNote.then(async () => {
      const d = await this.digest(text);
      if (d) this.proven.add(d);
    });
    return this.pendingNote;
  }

  /**
   * A login was refused with `token`: retry (the attempt number, 1-based,
   * and its delay) or show the refusal. Giving up resets the count and
   * forgets these credentials, so the player's own next try is shown at once
   * if it fails too (a password changed elsewhere stops being delayed).
   */
  async onRefused(creds: LoginCredentials, token: string | null | undefined): Promise<ProvenLoginRefusalVerdict> {
    if (!token || !RETRYABLE_LOGIN_REFUSAL_TOKENS.has(token) || !creds.account || !creds.password) {
      this.retries = 0;
      return { retry: false };
    }
    await this.pendingNote;
    const d = this.proven.size ? await this.digest(credentialText(creds)) : null;
    const isProven = d !== null && this.proven.has(d);
    const delayMs = provenLoginRetryDelay({ token, proven: isProven, retriesSoFar: this.retries, delays: this.delays });
    if (delayMs === null) {
      if (isProven && d) this.proven.delete(d);
      this.retries = 0;
      return { retry: false };
    }
    this.retries++;
    return { retry: true, attempt: this.retries, delayMs };
  }

  /** The connect cycle ended some other way (the launcher, another tab, the Disconnected screen): start counting afresh. */
  cancel(): void {
    this.retries = 0;
  }
}
