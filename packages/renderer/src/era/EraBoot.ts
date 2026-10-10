/**
 * Which era's DATs this page load uses, and where each DAT comes from
 * (docs/dark-majesty-support.md).
 *
 * The client loads one era per page load: every DAT-derived table (textures,
 * fonts, layouts, CharGen, SkillTable, spells…) is built from the DATs at boot.
 * Entering a world of another era stashes the login (EraSwitch) and reloads;
 * the next boot picks that era first, loads its DATs and resumes the login
 * without showing the launcher again — or the patch splash: that boot is the
 * rest of ENTER, not a new launch (ui/PatchScreen.ts patchBootPlan).
 *
 * Boot era, first match wins:
 *   1. `?era=<id>` (developer / probe override);
 *   2. a pending era switch (this tab, under two minutes old: ENTER on a
 *      classic world);
 *   3. end of retail, streamed.
 * The remembered launcher world only preselects that world; it never picks
 * the DATs, so a page load never blocks on a classic set nobody has entered
 * yet (Jake, 2026-10-06: a returning Doctide visitor sat through a 1.1 GB
 * download before the world list showed).
 *
 * A classic DAT is hosted, like end of retail's: the runtime config's
 * `eraAssetBases[era]` (production: dats.playwebac.com/v1/raw/<set>), else
 * `<assetBase>/sets/<era>/` (local dev serves dat/sets/ → dat-sets/). Files
 * the era does not replace load from the end-of-retail URLs, unchanged.
 * Players never supply files (Jake, 2026-10-06: no data-file prompt).
 */
import { assetUrl, datSetForEra, type RuntimeConfig } from '../config/RuntimeConfig.js';
import type { DatBlobStore } from '../dat/DatCache.js';
import { EOR_DAT_ROLES, EOR_ERA_ID, ERA_PROFILES, datFileName, eraProfile, ownRoles, type DatRole, type EorDatRole, type EraProfile } from './EraProfiles.js';

export const ERA_SWITCH_KEY = 'acjs.eraSwitch.v1';
/** A stashed switch older than this is ignored (a stale tab, a crashed reload). */
export const ERA_SWITCH_MAX_AGE_MS = 2 * 60 * 1000;

/** A login carried across the era reload. sessionStorage only: never persisted past the tab. */
export interface EraSwitch {
  era: string;
  worldKey: string;
  worldName: string | null;
  connectUrl: string;
  account: string;
  password: string;
  at: number;
}

type SessionLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultSession(): SessionLike | null {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  } catch {
    return null;
  }
}

export function stashEraSwitch(sw: EraSwitch, storage: SessionLike | null = defaultSession()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(ERA_SWITCH_KEY, JSON.stringify(sw));
    return true;
  } catch {
    return false;
  }
}

/** Read and remove the pending switch; null when absent, malformed or stale. */
export function takeEraSwitch(storage: SessionLike | null = defaultSession(), now: number = Date.now()): EraSwitch | null {
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(ERA_SWITCH_KEY);
    storage.removeItem(ERA_SWITCH_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<EraSwitch>;
    const ok = typeof v.era === 'string' && typeof v.worldKey === 'string' && typeof v.connectUrl === 'string'
      && typeof v.account === 'string' && typeof v.password === 'string' && typeof v.at === 'number';
    if (!ok || now - v.at! > ERA_SWITCH_MAX_AGE_MS || v.at! > now + 5000) return null;
    return { era: v.era!, worldKey: v.worldKey!, worldName: typeof v.worldName === 'string' ? v.worldName : null,
      connectUrl: v.connectUrl!, account: v.account!, password: v.password!, at: v.at! };
  } catch {
    return null;
  }
}

/** The era to boot (see the module comment); unknown ids fall back to end of retail. */
export function resolveBootEra(opts: { search: string; pending: EraSwitch | null }): EraProfile {
  const param = new URLSearchParams(opts.search).get('era');
  for (const id of [param, opts.pending?.era ?? null]) {
    if (!id) continue;
    const p = eraProfile(id);
    if (p) return p;
  }
  return eraProfile(EOR_ERA_ID)!;
}

/** Where one DAT's bytes come from. */
export interface DatSource { kind: 'url'; url: string; cacheNamespace?: string }

export interface EraDatPlan {
  era: EraProfile;
  /** Every end-of-retail role, plus `worldPortal` only when the era owns one. */
  sources: Record<EorDatRole, DatSource> & { worldPortal?: DatSource };
}

export interface EraDatProbes {
  /** A HEAD of `url` succeeds (the file is hosted there). */
  headOk(url: string): Promise<boolean>;
}

/** Candidate hosted URLs for an era's own `role` file, in preference order. */
export function hostedDatUrls(cfg: RuntimeConfig, era: string, role: DatRole): string[] {
  const file = datFileName(eraProfile(era), role);
  const urls: string[] = [];
  const configured = cfg.eraAssetBases[era];
  if (configured) urls.push(`${configured}/${file}`);
  urls.push(assetUrl(cfg, `/sets/${era}/${file}`));
  return urls;
}

/**
 * Resolve every DAT for `era`, or name the roles nothing provides. End of
 * retail (and every role an era does not replace) resolves to the existing
 * end-of-retail URL with no probing, exactly as before.
 */
export async function planEraDats(
  era: EraProfile, cfg: RuntimeConfig, probes: EraDatProbes,
): Promise<EraDatPlan | { era: EraProfile; missing: DatRole[] }> {
  const sources = {} as EraDatPlan['sources'];
  for (const role of EOR_DAT_ROLES) {
    sources[role] = { kind: 'url', url: assetUrl(cfg, `/${datFileName(null, role)}`) };
  }
  const missing: DatRole[] = [];
  // A world served by the era's own streamed set (eraStreamPlan) needs no hosted whole file.
  const streamedWorld = era.own.worldPortal && eraStreamPlan(era, cfg).world;
  for (const role of ownRoles(era)) {
    if (streamedWorld && (role === 'worldPortal' || role === 'cell')) {
      sources[role] = { kind: 'url', url: hostedDatUrls(cfg, era.id, role)[0], cacheNamespace: era.id };
      continue;
    }
    let found: string | null = null;
    for (const url of hostedDatUrls(cfg, era.id, role)) {
      if (await probes.headOk(url).catch(() => false)) { found = url; break; }
    }
    if (found) sources[role] = { kind: 'url', url: found, cacheNamespace: era.id };
    else missing.push(role);
  }
  return missing.length ? { era, missing } : { era, sources };
}

/**
 * Which streamed DAT sets this page load opens (docs/dat-streaming.md §6.9):
 * `interface` serves the interface portal, language and highres DATs; `world`
 * serves the world portal and cell. Null = that side loads whole DATs.
 *
 * - End of retail and a classic era: one set (end of retail's `datSet`, or
 *   the era's own `eraDatSets` entry) serves both; `world === interface`.
 * - An era with its own world portal (AC1999): the interface IS end of
 *   retail's (EraProfiles: the era replaces only worldPortal and cell), so it
 *   streams end of retail's set exactly as end of retail does (`scope:
 *   'interface'` — that set's terrain and landblocks are never read); the
 *   world streams the era's own world-only set when one is published
 *   (`eraDatSets[era]`), else loads the era's whole DATs.
 */
export interface EraStreamPlan {
  interface: { manifestUrl: string } | null;
  world: { manifestUrl: string } | null;
  /** The world is not the interface's set (an era with its own world portal). */
  separateWorld: boolean;
}

export function eraStreamPlan(era: EraProfile, cfg: RuntimeConfig): EraStreamPlan {
  if (era.own.worldPortal) {
    return { interface: cfg.datSet, world: datSetForEra(cfg, era.id, EOR_ERA_ID), separateWorld: true };
  }
  const set = datSetForEra(cfg, era.id, EOR_ERA_ID);
  return { interface: set, world: set, separateWorld: false };
}

/** ENTER on a world whose era's hosted DATs don't answer (the launcher shows again). */
export function eraUnavailableText(worldName: string): string {
  return `${worldName}'s game data can't be reached right now. Try again in a few minutes, or pick another world.`;
}

/**
 * Delete classic DATs a player imported before the classic sets were hosted
 * (the retired data-file prompt stored them in the DAT cache's OPFS store as
 * `era-import__<era>__<file>`, up to ~1.2 GB per era). Never throws.
 */
export async function forgetImportedEraFiles(store: DatBlobStore): Promise<number> {
  if (!store.available) return 0;
  let removed = 0;
  for (const era of Object.values(ERA_PROFILES)) {
    for (const role of ownRoles(era)) {
      const key = `era-import__${era.id}__${datFileName(era, role)}`;
      try {
        if (await store.getMeta(key)) { await store.remove(key); removed++; }
      } catch { /* storage unavailable: nothing to free */ }
    }
  }
  return removed;
}
