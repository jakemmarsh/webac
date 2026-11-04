/**
 * STREAM.login-pack-split (docs/dat-streaming.md §6.16) — the `world` pack in three parts, so a login
 * waits only for what its first view draws.
 *
 * The whole `world` pack (23.4 MB gz in end of retail) is GameUI's preload art, chargen's models and art,
 * the terrain materials' textures and portal space (§6.6). A cold immediate login waited for all of it,
 * though most of it is either character creation's (the 13 heritage portraits alone are 3.2 MB) or the
 * landscape's (30 512×512 land textures, 17.8 MB, which an AC1999 login never reads: its landscape is
 * the 1999 world set's). The parts:
 *
 *   worldCore     the rest: the HUD's preload art, portal space. Every login waits for it.
 *   worldChargen  art only the character-creation layouts draw (CHARGEN_LAYOUTS and no other layout,
 *                 closures included): the heritage portraits, the backdrop, the attribute overlays.
 *                 Loaded in the background; character creation waits for it (and asks for it first
 *                 when the player opens it). The chargen preview's models and their textures stay in
 *                 worldCore: they are the human base figures every human in the world is built from
 *                 (measured live: an NPC read 0x01001860 / 0x01001864 at the login when they were here).
 *   worldLand     the terrain materials' textures (the simulation's `world-init` phase plus the set's own
 *                 RegionDesc TexMerge closure). A login waits for it only where the set serves the world.
 *
 * The rule is the same in the publish tool (which builds the parts) and the client (which decides what
 * to wait for), so it lives here.
 */
import { layoutArtIds } from './DatClosure.js';
import { type FileKey, fileKey, splitFileKey } from './DatStore.js';

/**
 * The character-creation LayoutDescs: gmCharGenMainUI's chargen_master 0x21000038 and its pages
 * 0x21000046 heritage, 0x21000047 profession / attributes, 0x21000048 skills, 0x21000049 appearance,
 * 0x2100004a town, 0x2100004b summary, 0x2100004c the appearance row template.
 */
export const CHARGEN_LAYOUTS: readonly number[] = [0x21000038, 0x21000046, 0x21000047, 0x21000048, 0x21000049, 0x2100004a, 0x2100004b, 0x2100004c];

/** The three split roles, in the order a pointer lists them. */
export const WORLD_SPLIT_ROLES = ['worldCore', 'worldChargen', 'worldLand'] as const;
export type WorldSplitRole = (typeof WORLD_SPLIT_ROLES)[number];

type LocalDb = { listFileIds(prefix?: number): number[]; getFileData(id: number): ArrayBuffer | null };

/** Every LayoutDesc but character creation's: what the world's panels and HUD draw. */
export function inWorldLayoutIds(local: LocalDb): number[] {
  const cg = new Set(CHARGEN_LAYOUTS);
  return local.listFileIds(0x21).filter((id) => !cg.has(id >>> 0));
}

/**
 * The art of the in-world layouts (baseLayout chains followed) and of the chargen layouts, each with
 * its closure (`edges`: DatClosure.edges, so a font's glyph surfaces or a surface's textures and
 * palettes count). An id in `chargen` and not in `inWorld` is drawn only by character creation.
 */
export function layoutArtByUse(local: LocalDb, edges: (key: FileKey) => readonly FileKey[]): { inWorld: Set<number>; chargen: Set<number> } {
  const closed = (ids: number[]): Set<number> => {
    const seen = new Set<FileKey>();
    const out = new Set<number>();
    const stack = ids.map((id) => fileKey('portal', id));
    while (stack.length) {
      const k = stack.pop()!;
      if (seen.has(k)) continue;
      seen.add(k);
      const { dat, id } = splitFileKey(k);
      if (dat === 'portal') out.add(id >>> 0);
      for (const c of edges(k)) stack.push(c);
    }
    return out;
  };
  return {
    inWorld: closed(layoutArtIds(local, inWorldLayoutIds(local))),
    chargen: closed(layoutArtIds(local, CHARGEN_LAYOUTS)),
  };
}

export interface WorldSplitInput {
  /** The `world` pack's file ids. */
  worldIds: Iterable<number>;
  /** The in-world / chargen layout art (layoutArtByUse). */
  art: { inWorld: ReadonlySet<number>; chargen: ReadonlySet<number> };
  /** The terrain materials' files (the `world-init` phase + the RegionDesc TexMerge closure). */
  landIds: ReadonlySet<number>;
}

/** Partition the world pack's ids into the three parts (each id in exactly one); anything unclaimed is core. */
export function splitWorldPack(input: WorldSplitInput): Record<WorldSplitRole, number[]> {
  const out: Record<WorldSplitRole, number[]> = { worldCore: [], worldChargen: [], worldLand: [] };
  for (const raw of input.worldIds) {
    const id = raw >>> 0;
    if (input.landIds.has(id)) { out.worldLand.push(id); continue; }
    const chargenOnly = input.art.chargen.has(id) && !input.art.inWorld.has(id);
    (chargenOnly ? out.worldChargen : out.worldCore).push(id);
  }
  for (const r of WORLD_SPLIT_ROLES) out[r].sort((a, b) => a - b);
  return out;
}

/**
 * Whether a pointer's packs carry the split a client of `scope` can use: an interface-only set needs
 * worldCore + worldChargen (its landscape is another set's); a set that serves the world needs all three.
 * A world-only set has no split (its `world` pack is the terrain closure alone).
 */
export function hasWorldSplit(packs: Partial<Record<string, unknown>>, scope: 'all' | 'interface' | 'world'): boolean {
  if (scope === 'world') return false;
  if (!packs.worldCore || !packs.worldChargen) return false;
  return scope === 'interface' || !!packs.worldLand;
}
