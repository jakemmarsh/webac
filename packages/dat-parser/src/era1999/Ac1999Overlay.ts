/**
 * The 1999 DAT overlay: serves every 1999 file in the end-of-retail format
 * our parsers read (docs/ac1999-support-scope.md Phase 2), plus the server's
 * DAT patches (AC1999 pushes changed files as 0xF7B7 at login; they are 1999
 * bytes and are translated the same way). Install with
 * `db.setOverlay(ac1999PortalOverlay(...))` / `ac1999CellOverlay(...)` on a
 * pre-ToD DatDatabase; nothing else changes.
 *
 * Portal routing (per type prefix): GfxObj 0x01, SurfaceTexture 0x05 (+ the
 * synthetic 0x07 textures it names), Texture 0x06, Surface 0x08, Environment
 * 0x0D, Region 0x13 (0x13000000 serves the hardware region 0x130F0000, as the
 * 1999 client picks for hardware rendering), CharGen / XpTable / SpellTable
 * (0x0E000002 / 0x0E000018 / 0x0E00000E), String 0x31 and PhysicsScriptTable
 * 0x34 (parses as is, but its keys are renumbered to end of retail's
 * PlayScript: docs/ac1999-support.md "Meaning checks") and SpellComponentTable
 * 0x0E00000F (names lose their NUL). Synthetic: the spell-component
 * DualDidMapper 0x27000002 the 1999 portal lacks (the client hardcoded the
 * map), served whatever the base, a streamed set included. Every other type
 * already parses and means the same (docs/ac1999-support.md). Cell routing: EnvCells.
 */
import type { DatOverlay } from '../DatDatabase.js';
import { transcodeEnvCell1999, transcodeEnvironment1999, transcodeGfxObj1999 } from './Geometry1999.js';
import {
  REGION_1999_HARDWARE_ID, SPELL_COMPONENT_MAPPER_ID, synthesizeSpellComponentMapper1999, transcodeCharGen1999,
  transcodePhysicsScriptTable1999, transcodeRegion1999, transcodeSpellComponentTable1999, transcodeSpellTable1999,
  transcodeString1999, transcodeXpTable1999,
} from './Tables1999.js';
import {
  SYNTHETIC_TEXTURE_PREFIX, synthesizeTexture1999, syntheticTextureId, transcodeSurface1999,
  transcodeSurfaceTexture1999, transcodeTexture1999,
} from './Textures1999.js';

/** Files the server pushed (1999 format), by id; consulted before the container. */
export type Patches1999 = Map<number, ArrayBuffer>;

export interface Ac1999OverlayOptions {
  /** Server DAT patches (0xF7B7), 1999 format. */
  patches?: Patches1999;
  /** The iteration the server stamped (reported in place of the container's once patched). */
  iteration?: number;
  /** Called once per file that fails to translate (it is then served as missing). */
  onError?: (id: number, err: unknown) => void;
  /**
   * The DAT underneath already serves end-of-retail formats: a streamed 1999
   * world set, built through this overlay (tools/publish-dats-r2.ts
   * --overlay ac1999). Only the server's patches (1999 bytes) are translated;
   * every other file passes through, and the untranslated bytes the client
   * still reads (CharGen) come from the set's copies (AC1999_UNTRANSLATED_COPIES).
   */
  translatedBase?: boolean;
}

/** The overlay kind (DatOverlay.kind / DatDatabase.overlayKind) of both 1999 overlays. */
export const AC1999_OVERLAY_KIND = 'ac1999';

/**
 * Files a streamed 1999 world set also carries untranslated, by id → the id
 * of the copy. The CharGen's description string ids have no slot in the
 * end-of-retail format (Tables1999 readCharGen1999Text; Chargen1999.ts), so
 * the set keeps the 1999 bytes under an id no DAT uses (0x0E00F000 + the
 * low bits; the EoL portal's 0x0E table ids stop at 0x0E000020).
 */
export const AC1999_UNTRANSLATED_COPIES: ReadonlyMap<number, number> = new Map([[0x0e000002, 0x0e00f002]]);

/**
 * The overlay a 1999 DAT wears. Beyond DatOverlay it exposes the patch map it
 * serves (the page adds the server's 0xF7B7 files to it at login), a settable
 * iteration (the server stamps its own once its patches are applied) and a way
 * to drop translated files already served (when a patch replaces one).
 */
export interface Ac1999DatOverlay extends DatOverlay {
  iteration?: number;
  readonly patches: Patches1999;
  /** How many files have been translated and cached (0 = nothing read yet). */
  readonly cachedCount: number;
  /** Forget every translated file; the next read translates again (from the patches when present). */
  clearCache(): void;
}

const CHARGEN = 0x0e000002;
const XPTABLE = 0x0e000018;
const SPELLTABLE = 0x0e00000e;
const SPELLCOMPONENTTABLE = 0x0e00000f;
const REGION = 0x13000000;

type Translate = (raw: ArrayBuffer, id: number, getRaw: (id: number) => ArrayBuffer | null) => ArrayBuffer | null;

function portalTranslator(id: number): Translate | null {
  switch (id) {
    case CHARGEN: return (raw) => transcodeCharGen1999(raw);
    case XPTABLE: return (raw) => transcodeXpTable1999(raw);
    case SPELLTABLE: return (raw) => transcodeSpellTable1999(raw);
    case SPELLCOMPONENTTABLE: return (raw) => transcodeSpellComponentTable1999(raw);
    default: break;
  }
  switch (id >>> 24) {
    case 0x01: return (raw) => transcodeGfxObj1999(raw);
    case 0x05: return (raw, i) => transcodeSurfaceTexture1999(raw, i);
    case 0x06: return (raw) => transcodeTexture1999(raw);
    case 0x08: return (raw) => transcodeSurface1999(raw);
    case 0x0d: return (raw) => transcodeEnvironment1999(raw);
    case 0x13: return (raw) => transcodeRegion1999(raw);
    case 0x31: return (raw) => transcodeString1999(raw);
    case 0x34: return (raw) => transcodePhysicsScriptTable1999(raw);
    default: return null;
  }
}

/**
 * Portal files the 1999 DAT lacks, built from data the 1999 client hardcoded
 * (not from the base): served before the base and the patches, translated or
 * not, so a streamed set built before one was added still has it.
 */
const PORTAL_CONSTANTS: ReadonlyMap<number, () => ArrayBuffer> = new Map([
  [SPELL_COMPONENT_MAPPER_ID, synthesizeSpellComponentMapper1999],
]);

/** Shared caching + patch plumbing; `route` picks the translator and the raw source id. */
function makeOverlay(
  opts: Ac1999OverlayOptions,
  route: (id: number) => { from: number; translate: Translate | null } | null,
  synthetic: { has: (id: number, baseHas: (id: number) => boolean, patches: Patches1999) => boolean;
    ids: (prefix: number | undefined, baseIds: (p?: number) => number[]) => number[] } | null,
  constants: ReadonlyMap<number, () => ArrayBuffer> = new Map(),
): Ac1999DatOverlay {
  const patches = opts.patches ?? new Map<number, ArrayBuffer>();
  const cache = new Map<number, ArrayBuffer | null>();
  const translatedBase = opts.translatedBase === true;
  return {
    kind: AC1999_OVERLAY_KIND,
    patches,
    get cachedCount() { return cache.size; },
    clearCache() { cache.clear(); },
    get(id, base) {
      const build = constants.get(id);
      if (build) {
        const hit = cache.get(id);
        if (hit !== undefined) return hit;
        const out = build();
        cache.set(id, out);
        return out;
      }
      const r = route(id);
      if (!r) return patches.has(id) ? patches.get(id)! : undefined;
      // An already-translated base: only a patched source needs translating.
      if (translatedBase && !patches.has(r.from)) return undefined;
      const hit = cache.get(id);
      if (hit !== undefined) return hit;
      const getRaw = (i: number): ArrayBuffer | null => patches.get(i) ?? base(i);
      const raw = getRaw(r.from);
      let out: ArrayBuffer | null = null;
      if (raw) {
        try {
          out = r.translate ? r.translate(raw, r.from === id ? id : r.from, getRaw) : raw;
        } catch (err) {
          opts.onError?.(id, err);
          out = null;
        }
      }
      cache.set(id, out);
      return out;
    },
    getRaw(id, base) {
      if (constants.has(id)) return null; // no 1999 bytes: built, not translated
      const patched = patches.get(id);
      if (patched) return patched;
      if (!translatedBase) return base(id);
      const copy = AC1999_UNTRANSLATED_COPIES.get(id >>> 0);
      if (copy !== undefined) return base(copy);
      // The base holds this file translated: its 1999 bytes exist only for types served as they are.
      return route(id) ? null : base(id);
    },
    has(id, baseHas) {
      if (constants.has(id) || patches.has(id) || baseHas(id)) return true;
      return synthetic ? synthetic.has(id, baseHas, patches) : false;
    },
    extraIds(prefix, baseIds) {
      const ofPrefix = (i: number) => prefix === undefined || (i >>> 24) === prefix;
      const fromPatches = [...patches.keys(), ...[...constants.keys()].filter((i) => !patches.has(i))].filter(ofPrefix);
      return synthetic ? fromPatches.concat(synthetic.ids(prefix, baseIds)) : fromPatches;
    },
    iteration: opts.iteration,
  };
}

/** The 1999 portal.dat overlay. */
export function ac1999PortalOverlay(opts: Ac1999OverlayOptions = {}): Ac1999DatOverlay {
  return makeOverlay(opts, (id) => {
    if (id === REGION) return { from: REGION_1999_HARDWARE_ID, translate: (raw) => transcodeRegion1999(raw) };
    if ((id >>> 24) === SYNTHETIC_TEXTURE_PREFIX) {
      const source = (0x05000000 | (id & 0xffffff)) >>> 0;
      return { from: source, translate: (_raw, _i, getRaw) => synthesizeTexture1999(id, getRaw) };
    }
    const t = portalTranslator(id);
    return t ? { from: id, translate: t } : null;
  }, {
    has: (id, baseHas, patches) => {
      if ((id >>> 24) !== SYNTHETIC_TEXTURE_PREFIX) return false;
      const source = (0x05000000 | (id & 0xffffff)) >>> 0;
      return patches.has(source) || baseHas(source);
    },
    ids: (prefix, baseIds) => (prefix === undefined || prefix === SYNTHETIC_TEXTURE_PREFIX
      ? baseIds(0x05).map(syntheticTextureId) : []),
  }, PORTAL_CONSTANTS);
}

/** The 1999 cell.dat overlay: EnvCells (0xXXYY0100..0xXXYYFFFD) are translated; landblocks parse as is. */
export function ac1999CellOverlay(opts: Ac1999OverlayOptions = {}): Ac1999DatOverlay {
  return makeOverlay(opts, (id) => {
    const low = id & 0xffff;
    if (low >= 0x0100 && low <= 0xfffd) return { from: id, translate: (raw, i) => transcodeEnvCell1999(raw, i) };
    return null;
  }, null);
}
