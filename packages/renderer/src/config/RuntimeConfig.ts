/**
 * Deployment config read at boot (docs/release-plan.md, Phase 1).
 *
 * One built bundle serves every deployment: the host writes a `config.json`
 * next to index.html (the web Dockerfile generates it from env vars), and
 * local dev runs without one and gets the dev defaults below. The
 * `?bridge=` / `?datSet=` / `?eraDatSet=` query overrides apply only where
 * URL overrides are enabled (dev builds; see config/urlOverrides.ts).
 */
import { urlOverridesEnabled } from './urlOverrides.js';

export interface RuntimeConfig {
  /**
   * Base URL the DATs and weenie side-files are fetched from. '' = same
   * origin (dev: Vite serves dat/ as its publicDir). Production points at the
   * DAT host (Cloudflare R2), e.g. 'https://dats.example.org/eol'.
   */
  assetBase: string;
  /** WebSocket URL of the WS→UDP bridge. */
  bridgeUrl: string;
  /**
   * RELEASE.dat-streaming — the content-addressed DAT set to stream
   * (docs/dat-streaming.md): `manifestUrl` is the set pointer, e.g.
   * 'https://dats.example.org/v1/sets/eol-p2072-c982-h497-l994.json'. When
   * set the client streams the DATs from it; null keeps the whole-DAT path
   * under assetBase (local dev: Vite serves dat/). This is end of retail's set;
   * classic eras stream from eraDatSets (datSetForEra). An era with its own
   * world portal (AC1999) streams its interface from this set too
   * (era/EraBoot.ts eraStreamPlan).
   */
  datSet: { manifestUrl: string } | null;
  /**
   * The public source repository, shown as the launcher's "Source code"
   * link (AGPL-3.0 §13). null = no link (local dev).
   */
  sourceUrl: string | null;
  /**
   * The site's own pages (deploy/web/site: /about/, /servers/, …) are served
   * beside the client, so the launcher links to them. The web image always
   * writes true; false (local dev, where those pages don't exist) = no links.
   */
  siteLinks: boolean;
  /**
   * Where a classic era's own DATs are hosted, by era id (era/EraBoot.ts,
   * docs/dark-majesty-support.md), e.g. { "classic-dereth":
   * "https://dats.example.org/sets/classic-dereth" }. Empty: the client looks
   * under `<assetBase>/sets/<era>/`, then asks the player for their files.
   */
  eraAssetBases: Record<string, string>;
  /**
   * A classic era's streamed DAT set pointer, by era id (docs/dat-streaming.md
   * §6.9), e.g. { "classicace-infiltration":
   * "https://dats.example.org/v1/sets/classicace-infiltration-1.9.json" }. An
   * era listed here streams like end of retail; an era missing from it loads
   * its whole DATs (eraAssetBases). For an era with its own world portal
   * (AC1999) the entry is its WORLD-only set (§6.10), e.g. { "ac1999-retail":
   * "https://dats.example.org/v1/sets/ac1999-retail-world-p102-c67.json" }.
   */
  eraDatSets: Record<string, string>;
}

export const DEV_RUNTIME_CONFIG: Readonly<RuntimeConfig> = Object.freeze({
  assetBase: '',
  bridgeUrl: 'ws://localhost:9090',
  datSet: null,
  sourceUrl: null,
  siteLinks: false,
  eraAssetBases: Object.freeze({}) as Record<string, string>,
  eraDatSets: Object.freeze({}) as Record<string, string>,
});

export const RUNTIME_CONFIG_PATH = '/config.json';

function isWsUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'ws:' || u.protocol === 'wss:';
  } catch {
    return false;
  }
}

function isAssetBase(v: string): boolean {
  if (v === '' || v.startsWith('/')) return true;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function isSetPointerUrl(v: string): boolean {
  if (!v.includes('/v1/sets/') || !v.endsWith('.json')) return false;
  if (v.startsWith('/')) return true;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Merge the config file (if any) and the page's query string over the dev
 * defaults. Invalid values are ignored, not fatal: a typo in config.json
 * falls back to the default rather than bricking the page.
 */
export function resolveRuntimeConfig(file: unknown, search: string, allowOverrides: boolean = urlOverridesEnabled()): RuntimeConfig {
  const cfg: RuntimeConfig = { ...DEV_RUNTIME_CONFIG, eraAssetBases: {}, eraDatSets: {} };
  if (file && typeof file === 'object') {
    const f = file as Record<string, unknown>;
    if (typeof f.assetBase === 'string' && isAssetBase(f.assetBase)) {
      cfg.assetBase = f.assetBase.replace(/\/+$/, '');
    }
    if (typeof f.bridgeUrl === 'string' && isWsUrl(f.bridgeUrl)) cfg.bridgeUrl = f.bridgeUrl;
  }
  if (file && typeof file === 'object') {
    const ds = (file as Record<string, unknown>).datSet as Record<string, unknown> | null | undefined;
    if (ds && typeof ds === 'object' && typeof ds.manifestUrl === 'string' && isSetPointerUrl(ds.manifestUrl)) {
      cfg.datSet = { manifestUrl: ds.manifestUrl };
    }
  }
  if (file && typeof file === 'object') {
    const src = (file as Record<string, unknown>).sourceUrl;
    if (typeof src === 'string' && /^https:\/\//.test(src)) {
      try { cfg.sourceUrl = new URL(src).toString(); } catch { /* invalid: no link */ }
    }
    if ((file as Record<string, unknown>).siteLinks === true) cfg.siteLinks = true;
  }
  if (file && typeof file === 'object') {
    const bases = (file as Record<string, unknown>).eraAssetBases;
    if (bases && typeof bases === 'object') {
      for (const [era, base] of Object.entries(bases as Record<string, unknown>)) {
        if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(era) && typeof base === 'string' && base !== '' && isAssetBase(base)) {
          cfg.eraAssetBases[era] = base.replace(/\/+$/, '');
        }
      }
    }
  }
  if (file && typeof file === 'object') {
    const sets = (file as Record<string, unknown>).eraDatSets;
    if (sets && typeof sets === 'object') {
      for (const [era, url] of Object.entries(sets as Record<string, unknown>)) {
        if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(era) && typeof url === 'string' && isSetPointerUrl(url)) cfg.eraDatSets[era] = url;
      }
    }
  }
  const params = new URLSearchParams(search);
  if (allowOverrides) {
    // Where the password goes and whose bytes draw the UI: dev builds only (urlOverrides.ts).
    const bridgeParam = params.get('bridge');
    if (bridgeParam && isWsUrl(bridgeParam)) cfg.bridgeUrl = bridgeParam;
    // ?datSet=<pointer url> streams that set (dev / probes).
    const datSetParam = params.get('datSet');
    if (datSetParam && isSetPointerUrl(datSetParam)) cfg.datSet = { manifestUrl: datSetParam };
    // ?eraDatSet=<era>:<pointer url> streams that era from that set (dev / probes: a locally staged set).
    const eraParam = params.get('eraDatSet');
    const sep = eraParam ? eraParam.indexOf(':') : -1;
    if (eraParam && sep > 0) {
      const era = eraParam.slice(0, sep), url = eraParam.slice(sep + 1);
      if (/^[a-z0-9][a-z0-9-]{0,63}$/.test(era) && isSetPointerUrl(url)) cfg.eraDatSets[era] = url;
    }
  }
  // ?rawDats forces the whole-DAT path (same hosts, everywhere).
  if (params.has('rawDats')) { cfg.datSet = null; cfg.eraDatSets = {}; }
  return cfg;
}

/**
 * The set to stream for the era this page load boots: end of retail's
 * `datSet`, or a classic era's own entry in `eraDatSets`; null loads that
 * era's whole DATs. A classic era never streams end of retail's set (its
 * portal replaces it). An era with its own world portal pairs end of
 * retail's interface set with this one for its world: era/EraBoot.ts
 * eraStreamPlan decides.
 */
export function datSetForEra(cfg: RuntimeConfig, eraId: string, eorId = 'eor'): { manifestUrl: string } | null {
  if (eraId === eorId) return cfg.datSet;
  const url = Object.prototype.hasOwnProperty.call(cfg.eraDatSets, eraId) ? cfg.eraDatSets[eraId] : undefined;
  return url ? { manifestUrl: url } : null;
}

/** URL for an asset path such as '/client_portal.dat' under the config's assetBase. */
export function assetUrl(cfg: RuntimeConfig, path: string): string {
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${cfg.assetBase}${p}`;
}

/**
 * Fetch `/config.json` and resolve the runtime config. A missing file (dev)
 * or a network/parse error yields the defaults.
 */
export async function loadRuntimeConfig(
  fetchFn: typeof fetch = fetch,
  search: string = typeof location !== 'undefined' ? location.search : '',
  allowOverrides: boolean = urlOverridesEnabled(),
): Promise<RuntimeConfig> {
  let file: unknown = null;
  try {
    const resp = await fetchFn(RUNTIME_CONFIG_PATH, { cache: 'no-store' });
    if (resp.ok) file = await resp.json();
  } catch {
    file = null;
  }
  return resolveRuntimeConfig(file, search, allowOverrides);
}
