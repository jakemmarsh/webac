/**
 * OBS.login-refusal-identity — the identifiers that let a repeated login
 * refusal be root-caused from the bridge's client_preworld lines.
 *
 * Production 2026-11-07 (Snowreap, GDL, 13:35 / 13:40Z, one address): logins
 * refused with ClientLogOnFailed while another tab of the same player held an
 * account at chargen, and the BUG.held-account-logon-failed offer never came.
 * The lines could not say whether the refused login was the same account, the
 * same browser, or a wrong password. Three tags answer that:
 *
 *  - `acct`: the first 8 hex of SHA-256 over a fixed product salt, the world
 *    (accountSessionKey's server part) and the case-folded account. Only for
 *    matching two events of one account on one world; the account name is
 *    never sent, and nothing derived from the password is an input.
 *  - `bid`: a random id per browser profile (localStorage, shared by its
 *    tabs), so two tabs of one browser read apart from two browsers behind
 *    one address. Absent when the page has no working localStorage (a
 *    per-page stand-in would read as a new browser on every load).
 *  - `tab`: the AccountTabGuard tab id, random per page, so the tab that
 *    holds an account and the tab that was refused can be paired.
 */
import { accountSessionKey, serverOfSessionKey } from '../session/AccountTabGuard.js';

/** Fixed, so the same account on the same world tags the same on every page and browser. */
export const ACCOUNT_TAG_SALT = 'webac-acct-tag-v1';

/** localStorage key of the browser id. */
export const BROWSER_ID_STORAGE_KEY = 'acjs.telemetry.bid.v1';

/** What a tag / browser id looks like on the wire (the bridge checks the same). */
export const ACCOUNT_TAG_PATTERN = /^[0-9a-f]{8}$/;
export const BROWSER_ID_PATTERN = /^[0-9a-f]{8}$/;

/** SHA-256 hex of a string; null without WebCrypto. */
export type Sha256Hex = (text: string) => Promise<string | null>;

/** WebCrypto SHA-256 as hex (null where crypto.subtle is missing: an insecure context, an old browser). */
export const webCryptoSha256Hex: Sha256Hex = async (text) => {
  try {
    const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
    if (!subtle) return null;
    const hash = await subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
};

/** The hashed text: salt, world, case-folded account (the same folding as accountSessionKey). */
export function accountTagInput(connectUrl: string, account: string): string {
  const key = accountSessionKey(connectUrl, account);
  const world = serverOfSessionKey(key);
  const acct = key.slice(world.length + 1);
  return `${ACCOUNT_TAG_SALT}\u0000${world}\u0000${acct}`;
}

/** The `acct` tag for a login to `connectUrl` as `account`; null without an account or WebCrypto. */
export async function accountTag(connectUrl: string, account: string, sha256: Sha256Hex = webCryptoSha256Hex): Promise<string | null> {
  if (!account || !account.trim()) return null;
  const hex = await sha256(accountTagInput(connectUrl, account));
  const tag = hex ? hex.slice(0, 8).toLowerCase() : null;
  return tag && ACCOUNT_TAG_PATTERN.test(tag) ? tag : null;
}

/** 8 random hex from WebCrypto; '' without it (browserId then stores nothing: no `bid`). */
function randomHex8(): string {
  const bytes = new Uint8Array(4);
  try { crypto.getRandomValues(bytes); } catch { return ''; }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The real localStorage, or null when reading it throws or it is missing (never a stand-in). */
export function realLocalStorage(g: object = globalThis): Storage | null {
  try { return (g as { localStorage?: Storage }).localStorage ?? null; } catch { return null; }
}

/**
 * This browser profile's id: the stored one, or a new one stored now. Null
 * when storage is missing or refuses the read or the write.
 */
export function browserId(storage: Pick<Storage, 'getItem' | 'setItem'> | null, random: () => string = randomHex8): string | null {
  if (!storage) return null;
  try {
    const stored = storage.getItem(BROWSER_ID_STORAGE_KEY);
    if (stored && BROWSER_ID_PATTERN.test(stored)) return stored;
    const id = random();
    if (!BROWSER_ID_PATTERN.test(id)) return null;
    storage.setItem(BROWSER_ID_STORAGE_KEY, id);
    return storage.getItem(BROWSER_ID_STORAGE_KEY) === id ? id : null;
  } catch { return null; }
}

/** A tab id as it goes on the wire (AccountTabGuard: a UUID, or a clock id on an old browser); null when malformed. */
export const TAB_ID_PATTERN = /^[A-Za-z0-9-]{1,40}$/;
export function wireTabId(id: string | null | undefined): string | null {
  return typeof id === 'string' && TAB_ID_PATTERN.test(id) ? id : null;
}
