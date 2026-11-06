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
 * launcher ENTER starts from the world's rule again.
 *
 * UX.login-case-remember: an account like that would otherwise pay a refused
 * login (a failed login on the server; some servers count them) and the retry
 * on every new page. So when the as-typed form gets in, LoginCaseMemory
 * remembers it for this world + account, and the next login there on any
 * page starts as typed. A lowercase login that gets in forgets it (the
 * password was reset, say). A remembered as-typed login refused with "Client
 * logon failed" falls back once to lowercase, so a stale memory never locks
 * anyone out. Only a salted hash of the world key + lowercased account name
 * is stored, never the password or anything derived from it; capped, with a
 * 180-day expiry. Worlds whose rule is 'verbatim' (ACE) never touch it.
 */
import { retailLowercase, type LoginProfile, type PasswordCase } from '@ac/network';

/** Emulators ThwargLauncher launches as "-a user:password" (GameLauncher.cs). */
export const LOWERCASE_PASSWORD_EMUS: ReadonlySet<string> = new Set(['GDL', 'GDLE']);

/** The refusal a lowercased password can earn when the account's password has capitals. */
export const CASE_VERBATIM_REFUSAL_TOKEN = 'ID_ConnectionError_ClientLogOnFailed';

/** The wait before the as-typed retry: the refused socket is done, the bridge needs only a moment. */
export const CASE_VERBATIM_RETRY_DELAY_MS = 500;

/** The localStorage key of the remembered as-typed logins (UX.login-case-remember). */
export const LOGIN_CASE_STORAGE_KEY = 'acjs.loginCase.v1';
/** How many world + account entries are kept (the oldest goes first). */
export const LOGIN_CASE_MAX_ENTRIES = 64;
/** An entry no login has refreshed for this long is forgotten. */
export const LOGIN_CASE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** Whose login: the world (chargenWorldKey of the socket URL) and the account name as typed. */
export interface LoginCaseOwner {
  readonly world: string;
  readonly account: string;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface StoredLoginCase {
  v: 1;
  /** A per-browser random salt for the entry hashes. */
  salt: string;
  /** Entry hash → when an as-typed login there last got in (ms). */
  entries: Record<string, number>;
}

function pageStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function newSalt(): string {
  const c = globalThis.crypto;
  if (c?.getRandomValues) return Array.from(c.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  // No Web Crypto (never in a supported browser): a time-based salt. It only has to differ per browser.
  return Date.now().toString(16) + Math.floor((globalThis.performance?.now?.() ?? 0) * 1000).toString(16);
}

/** A 53-bit string hash (cyrb53) as 14 hex digits. */
function hash53(text: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * UX.login-case-remember — the world + account pairs whose password got in as
 * typed (not lowercased), kept in localStorage across pages. Every access is
 * guarded: storage that is missing or throws behaves as if nothing were
 * remembered, which is the behaviour before this existed.
 */
export class LoginCaseMemory {
  private readonly storage: () => StorageLike | null;
  private readonly now: () => number;

  constructor(opts: { storage?: StorageLike | null; now?: () => number } = {}) {
    const given = opts.storage;
    this.storage = given !== undefined ? () => given : pageStorage;
    this.now = opts.now ?? Date.now;
  }

  /** True when an as-typed login for `owner` got in within the expiry. */
  remembersVerbatim(owner: LoginCaseOwner): boolean {
    const data = this.read();
    if (!data) return false;
    const at = data.entries[this.keyOf(data.salt, owner)];
    return typeof at === 'number' && this.now() - at < LOGIN_CASE_TTL_MS;
  }

  /** The as-typed form got in for `owner`: remember (or refresh) it; expired and the oldest past the cap go. */
  rememberVerbatim(owner: LoginCaseOwner): void {
    const data = this.read() ?? { v: 1 as const, salt: newSalt(), entries: {} };
    const now = this.now();
    const key = this.keyOf(data.salt, owner);
    const kept = Object.entries(data.entries)
      .filter(([k, at]) => k !== key && now - at < LOGIN_CASE_TTL_MS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, LOGIN_CASE_MAX_ENTRIES - 1);
    this.write({ v: 1, salt: data.salt, entries: Object.fromEntries([[key, now], ...kept]) });
  }

  /** The lowercase form got in for `owner`: forget any as-typed memory. */
  forget(owner: LoginCaseOwner): void {
    const data = this.read();
    if (!data) return;
    const key = this.keyOf(data.salt, owner);
    if (!(key in data.entries)) return;
    delete data.entries[key];
    if (Object.keys(data.entries).length) {
      this.write(data);
      return;
    }
    try {
      this.storage()?.removeItem(LOGIN_CASE_STORAGE_KEY);
    } catch {
      /* storage blocked: nothing is remembered anyway */
    }
  }

  private keyOf(salt: string, owner: LoginCaseOwner): string {
    const text = `${salt}\u0000${owner.world}\u0000${owner.account.trim().toLowerCase()}`;
    return hash53(text, 0x9e3779b1) + hash53(text, 0x85ebca6b);
  }

  private read(): StoredLoginCase | null {
    try {
      const raw = this.storage()?.getItem(LOGIN_CASE_STORAGE_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw) as Partial<StoredLoginCase> | null;
      if (!d || d.v !== 1 || typeof d.salt !== 'string' || !d.salt || !d.entries || typeof d.entries !== 'object') return null;
      const entries: Record<string, number> = {};
      for (const [k, at] of Object.entries(d.entries)) if (typeof at === 'number' && Number.isFinite(at)) entries[k] = at;
      return { v: 1, salt: d.salt, entries };
    } catch {
      return null;
    }
  }

  private write(data: StoredLoginCase): void {
    try {
      this.storage()?.setItem(LOGIN_CASE_STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* storage full or blocked: the next page starts from the world's rule */
    }
  }
}

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
  private policy: PasswordCase = 'verbatim';
  /** The form this login started in: the world's rule, or 'verbatim' remembered for this world + account. */
  private start: PasswordCase = 'verbatim';
  private mode: PasswordCase = 'verbatim';
  private tried = false;
  /** A login in this form got in: it is proven, no more case retries until a reset. */
  private accepted = false;
  private owner: LoginCaseOwner | null = null;
  private readonly memory: LoginCaseMemory | null;

  constructor(policy: PasswordCase = 'verbatim', opts: { memory?: LoginCaseMemory | null; owner?: LoginCaseOwner | null } = {}) {
    this.memory = opts.memory ?? null;
    this.reset(policy, opts.owner ?? null);
  }

  /** The password case the next LoginRequest uses. */
  get current(): PasswordCase {
    return this.mode;
  }

  /**
   * The retry onRefused just asked for, for telemetry: 'case_verbatim'
   * (lowercase refused, now as typed) or 'case_lower' (the remembered
   * as-typed form refused, now lowercased).
   */
  get retryKind(): 'case_verbatim' | 'case_lower' {
    return this.mode === 'lower' ? 'case_lower' : 'case_verbatim';
  }

  /** `base` with the current password case. */
  profile(base: LoginProfile): LoginProfile {
    return { ...base, passwordCase: this.mode };
  }

  /**
   * A new login (a launcher ENTER, an era-switch resume, a URL login): the
   * world's rule, or the as-typed form remembered for `owner` when that rule
   * is 'lower'; no retry made yet.
   */
  reset(policy: PasswordCase, owner: LoginCaseOwner | null = null): void {
    this.policy = policy;
    this.owner = owner;
    this.start = policy === 'lower' && owner && this.memory?.remembersVerbatim(owner) ? 'verbatim' : policy;
    this.mode = this.start;
    this.tried = false;
    this.accepted = false;
  }

  /**
   * The server accepted the login: keep the form that got in (resumes and
   * reconnects reuse it), and on a 'lower' world remember it for the next
   * page when it is the as-typed form with capitals, else forget it.
   */
  noteAccepted(typedPassword?: string): void {
    this.tried = false;
    this.accepted = true;
    this.start = this.mode;
    if (this.policy !== 'lower' || !this.owner || !this.memory || typedPassword === undefined) return;
    if (this.mode === 'verbatim' && retailLowercase(typedPassword) !== typedPassword) this.memory.rememberVerbatim(this.owner);
    else this.memory.forget(this.owner);
  }

  /**
   * A login was refused with `token`. True: log in again now in the other
   * case (as typed after a lowercase refusal; lowercased after a remembered
   * as-typed one). Once per login: when that attempt is refused too, the
   * login's starting form comes back for the existing quiet retries and the
   * error, and this never fires again until a reset. A form that already
   * got in this session is proven: its refusals are left to those retries.
   */
  onRefused(token: string | null | undefined, typedPassword: string): boolean {
    if (token !== CASE_VERBATIM_REFUSAL_TOKEN || this.policy !== 'lower') return false;
    if (this.tried) {
      this.mode = this.start;
      return false;
    }
    if (this.accepted || retailLowercase(typedPassword) === typedPassword) return false;
    this.tried = true;
    this.mode = this.mode === 'lower' ? 'verbatim' : 'lower';
    return true;
  }
}
