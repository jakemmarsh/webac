/**
 * STREAM.login-pack-split — the publish side of the world pack's split (the rule itself:
 * packages/renderer/src/dat/streaming/WorldSplit.ts; docs/dat-streaming.md §6.16).
 */
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';
import { parseMasterProperty, setMasterPropertyTypes } from '../../packages/dat-parser/src/file-types/LayoutDesc.js';
import { RegionDesc } from '../../packages/dat-parser/src/file-types/RegionDesc.js';
import { Surface } from '../../packages/dat-parser/src/file-types/Surface.js';
import { SurfaceTexture } from '../../packages/dat-parser/src/file-types/SurfaceTexture.js';
import { Texture } from '../../packages/dat-parser/src/file-types/Texture.js';
import { SKELETON_TYPES } from '../../packages/dat-parser/src/streaming/DatSetFormat.js';
import { DatClosure, type ClosureStore } from '../../packages/renderer/src/dat/streaming/DatClosure.js';
import type { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { LocalClosureStore } from './area-packs.js';
import { WORLD_SPLIT_ROLES, layoutArtByUse, splitWorldPack, type WorldSplitRole } from '../../packages/renderer/src/dat/streaming/WorldSplit.js';

/**
 * The leaves (non-skeleton portal files) the terrain materials read: RegionDesc 0x13000000's TexMerge
 * (land textures + their detail textures, corner / side alpha maps, road maps) → SurfaceTexture 0x05
 * (every level) or Surface 0x08 → Texture 0x06/0x07 → default Palette 0x04. The structural files on the
 * way (0x05, 0x08, 0x13) ride the skeleton pack.
 */
export function regionTerrainLeaves(get: (id: number) => ArrayBuffer | null): number[] {
  const region = get(0x13000000);
  if (!region) return [];
  const tm = new RegionDesc(new DatReader(region)).terrainInfo.landSurfaces.texMerge;
  if (!tm) return [];
  const roots = [
    ...tm.terrainDesc.flatMap((d) => [d.terrainTex.texGID, d.terrainTex.detailTexGID]),
    ...tm.cornerTerrainMaps.map((m) => m.texGID), ...tm.sideTerrainMaps.map((m) => m.texGID),
    ...tm.roadMaps.map((m) => m.roadTexGID),
  ];
  const seen = new Set<number>();
  const leaves = new Set<number>();
  const queue = roots.map((id) => id >>> 0).filter((id) => id !== 0);
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const data = get(id);
    if (!data) continue;
    const type = id >>> 24;
    if (!SKELETON_TYPES.has(type)) leaves.add(id);
    const next: number[] = [];
    if (type === 0x05) next.push(...SurfaceTexture.read(new DatReader(data)).textures);
    else if (type === 0x08) { const s = Surface.read(new DatReader(data)); next.push(s.origTextureId, s.origPaletteId); }
    else if (type === 0x06 || type === 0x07) { const t = Texture.read(new DatReader(data)); if (t.defaultPaletteId) next.push(t.defaultPaletteId); }
    for (const n of next) if (n) queue.push(n >>> 0);
  }
  return [...leaves].sort((a, b) => a - b);
}


/**
 * The world pack's three parts (WorldSplit.ts): the land part is the simulation's world-init files plus
 * the set's own RegionDesc TexMerge closure; the chargen part the art only chargen layouts draw; the rest
 * (the HUD's preload art, portal space, the chargen preview's human base figures) is the core.
 */
export function planWorldSplit(
  world: ReadonlyMap<number, Uint8Array>, phases: Record<string, Record<string, string[]>>,
  portalGet: (id: number) => ArrayBuffer | null, local: { listFileIds(p?: number): number[]; getFileData(id: number): ArrayBuffer | null },
): Record<WorldSplitRole, number[]> {
  const ids = (ph: string) => new Set((phases[ph]?.portal ?? []).map((h) => parseInt(h, 16) >>> 0));
  const mp = portalGet(0x39000001);
  if (mp) setMasterPropertyTypes(parseMasterProperty(new DatReader(mp)));
  const land = ids('world-init');
  for (const id of regionTerrainLeaves(portalGet)) land.add(id >>> 0);
  // The client's own closure walk over the set's files (a font's glyph surfaces, a surface's textures).
  const portalDb = { hasFile: (id: number) => portalGet(id) !== null, getFileData: portalGet } as unknown as DatDatabase;
  const closure = new DatClosure(new LocalClosureStore({ portal: portalDb }) as unknown as ClosureStore);
  const parts = splitWorldPack({ worldIds: world.keys(), art: layoutArtByUse(local, (k) => closure.edges(k)), landIds: land });
  const n = WORLD_SPLIT_ROLES.reduce((a, r) => a + parts[r].length, 0);
  if (n !== world.size) throw new Error(`world split: ${n} files in the parts, ${world.size} in the world pack`);
  return parts;
}

