/**
 * BUG.chargen-olthoi-pending — a server that forbids Olthoi characters.
 *
 * ACE (and ClassicACE) answer a CharacterCreate for heritage Olthoi (12) or
 * OlthoiAcid (13) with CharacterGenerationVerificationResponse Pending (2)
 * when the server property `olthoi_play_disabled` is set
 * (CharacterHandler.CharacterCreateEx). Retail's
 * gmCharGenMainUI::RecvNotice_CharGenVerificationResponse @ 004e9030 shows
 * its default arm for 2, ID_Character_Err_NameDBDown ("The server cannot
 * create your new character at this time. Please try again later."), so a
 * player retried the same Olthoi forever (Levistras, 2026-10-18).
 *
 * Nothing tells the client beforehand: retail's gmCGHeritagePage always
 * offers all thirteen heritages (InitializePage / Update @ 00483a10 /
 * 00483210 gate none), and ACE's CharacterList carries only slot count,
 * account, TurbineChat and ToD flags. So after the first refusal the client
 * remembers it per world for OLTHOI_REFUSAL_TTL_MS and stops offering the
 * Olthoi rows there (a named exception to retail faithfulness, CLAUDE.md).
 */
import { OLTHOI_HERITAGES } from './ChargenTemplates.js';

/** The line under retail's refusal text when the refused character was an Olthoi. */
export const OLTHOI_DISALLOWED_HINT = "This server doesn't allow Olthoi characters. Choose another heritage.";

/** The heritage page's line where the Olthoi rows would be, on a world remembered as refusing them. */
export const OLTHOI_UNAVAILABLE_NOTE = "This server doesn't allow Olthoi characters.";

/** CharacterGenerationVerificationResponse.Pending: ACE's (and ClassicACE's) refusal of a disallowed heritage. */
const PENDING = 2;

export function isOlthoiHeritage(heritage: number | null | undefined): boolean {
  return heritage !== null && heritage !== undefined && OLTHOI_HERITAGES.includes(heritage);
}

/** A Pending refusal of an Olthoi character: the server forbids Olthoi (olthoi_play_disabled). */
export function isOlthoiRefusal(responseCode: number, heritage: number | null | undefined): boolean {
  return responseCode === PENDING && isOlthoiHeritage(heritage);
}

/**
 * The refusal dialog's text: retail's string for the code, plus
 * OLTHOI_DISALLOWED_HINT when it is the Olthoi refusal. Any other code or
 * heritage keeps retail's text alone.
 */
export function chargenRefusalText(retailText: string, responseCode: number, heritage: number | null | undefined): string {
  return isOlthoiRefusal(responseCode, heritage) ? `${retailText}\n\n${OLTHOI_DISALLOWED_HINT}` : retailText;
}

// ── Per-world memory ───────────────────────────────────────────────────────

export const OLTHOI_REFUSAL_STORAGE_KEY = 'acjs.chargen.olthoiRefused.v1';
/** A server may turn Olthoi play back on: the memory lapses after 30 days. */
export const OLTHOI_REFUSAL_TTL_MS = 30 * 24 * 3600_000;
/** At most this many worlds are remembered (oldest dropped). */
const MAX_WORLDS = 64;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * The world's key: the bridge URL's host, path and query (its `?server=`
 * names the world behind a shared bridge), without the per-page `trace`.
 */
export function chargenWorldKey(connectUrl: string): string {
  try {
    const u = new URL(connectUrl);
    u.searchParams.delete('trace');
    u.searchParams.sort();
    const q = u.searchParams.toString();
    return `${u.host}${u.pathname}${q ? `?${q}` : ''}`;
  } catch {
    return connectUrl;
  }
}

function readAll(storage: StorageLike): Record<string, number> {
  const raw = storage.getItem(OLTHOI_REFUSAL_STORAGE_KEY);
  if (!raw) return {};
  const v = JSON.parse(raw) as unknown;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [k, t] of Object.entries(v as Record<string, unknown>)) {
    if (typeof t === 'number' && Number.isFinite(t)) out[k] = t;
  }
  return out;
}

/** Whether `worldKey` refused an Olthoi creation within the last OLTHOI_REFUSAL_TTL_MS. */
export function olthoiRefusedOnWorld(worldKey: string, now: number = Date.now(), storage: StorageLike | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    const at = readAll(storage)[worldKey];
    return at !== undefined && now - at >= 0 && now - at < OLTHOI_REFUSAL_TTL_MS;
  } catch {
    return false;
  }
}

/** Remember that `worldKey` refused an Olthoi creation now (expired entries are dropped). */
export function rememberOlthoiRefused(worldKey: string, now: number = Date.now(), storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    let all: Record<string, number> = {};
    try { all = readAll(storage); } catch { /* corrupt: start over */ }
    const kept = Object.entries(all)
      .filter(([k, t]) => k !== worldKey && now - t >= 0 && now - t < OLTHOI_REFUSAL_TTL_MS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_WORLDS - 1);
    storage.setItem(OLTHOI_REFUSAL_STORAGE_KEY, JSON.stringify(Object.fromEntries([[worldKey, now], ...kept])));
  } catch {
    /* storage full or blocked: the refusal dialog still says why */
  }
}
