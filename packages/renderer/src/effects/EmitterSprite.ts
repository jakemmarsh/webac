import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { GfxObj } from '@ac/dat-parser/file-types/GfxObj.js';
import { GfxObjDegradeInfo, type GfxObjLOD } from '@ac/dat-parser/file-types/GfxObjDegradeInfo.js';
import { Surface, SurfaceType } from '@ac/dat-parser/file-types/Surface.js';
import type { ParticleEmitterInfo } from '@ac/dat-parser/file-types/ParticleEmitterInfo.js';
import type { TextureManager } from '../models/TextureManager.js';
import { alphaTestRefFor, surfaceDrawState } from '../models/MaterialFactory.js';
import type { ParticleSpriteOptions } from './ParticleSystem.js';
import { buildParticleSubmeshes, type ParticleGfx, type ParticleSurface } from './ParticleGfx.js';
import { datMissEpoch, noDatMissSince } from '@ac/dat-parser/streaming/DatMiss.js';

/** A texture source: TextureManager.getTexture's shape (keeps tests DAT/GL-light). */
type TextureSource = Pick<TextureManager, 'getTexture'>;

/**
 * resolveEmitterSprite — load what a ParticleEmitterInfo's particles draw,
 * per the retail client's particle pipeline (VISUAL.particles-oriented-quads).
 *
 * ParticleEmitter::SetInfo @ 0051ce90 builds every particle part from the
 * emitter's `hw_gfxobj_id` ONLY (no HW GfxObj → no emitter at all; the
 * software `gfxobj_id` is never drawn). CPhysicsPart::SetPart @ 0050e700 /
 * LoadGfxObjArray @ 0050dcf0 then load the GfxObj's DIDDegrade chain: every
 * level draws its own chain GfxObj (INVALID = nothing) through the level-0
 * surface array (SetGfxObjArray @ 0050e2e0). The result carries:
 *
 *  - `gfx`: the chain's GfxObjs as per-surface geometry (the real mesh — a
 *    quad in the local XZ plane for most emitters, a ground-flat XY quad or a
 *    multi-polygon mesh for others), the degrade levels (mode + distance
 *    band), and the sort centre — see ParticleGfx.
 *  - `map` / `additive`: the level-0 first surface's texture and Additive bit
 *    (probes, and the fallback square when `gfx` could not be built).
 *  - `sizeScale`: the HW GfxObj's largest axis extent.
 *
 * Without this, particles drew as untextured white squares (the
 * VISUAL.portal-renders-opaque-white defect).
 */
export function resolveEmitterSprite(
  info: ParticleEmitterInfo,
  portalDb: Pick<DatDatabase, 'getFileData'>,
  textureManager: TextureSource,
): ParticleSpriteOptions | null {
  const gfxId = info.hwGfxObjId >>> 0;
  if (!gfxId) return null;
  let perDb = cache.get(portalDb);
  if (!perDb) { perDb = new WeakMap(); cache.set(portalDb, perDb); }
  let perTex = perDb.get(textureManager);
  if (!perTex) { perTex = new Map(); perDb.set(textureManager, perTex); }
  if (perTex.has(gfxId)) return perTex.get(gfxId)!;
  const missEpoch = datMissEpoch();
  const resolved = resolveGfx(gfxId, portalDb, textureManager);
  // RELEASE.dat-streaming — not cached when a streamed file was not resident yet.
  if (noDatMissSince(missEpoch)) perTex.set(gfxId, resolved);
  return resolved;
}

/** Resolved sprites per DAT → texture source → HW GfxObj id (shared by every emitter using it). */
const cache = new WeakMap<object, WeakMap<object, Map<number, ParticleSpriteOptions | null>>>();

function readGfxObj(db: Pick<DatDatabase, 'getFileData'>, id: number): GfxObj | null {
  const data = id ? db.getFileData(id) : null;
  return data ? new GfxObj(new DatReader(data)) : null;
}

function resolveSurface(db: Pick<DatDatabase, 'getFileData'>, textureManager: TextureSource, surfaceId: number): ParticleSurface | null {
  const data = db.getFileData(surfaceId);
  if (!data) return null;
  const surface = Surface.read(new DatReader(data));
  const isClipMap = (surface.type & SurfaceType.Base1ClipMap) !== 0;
  const hasTexture = (surface.type & SurfaceType.Base1Image) !== 0 || isClipMap;
  const map = hasTexture && surface.origTextureId
    ? textureManager.getTexture(surface.origTextureId, surface.origPaletteId || undefined, isClipMap)
    : null;
  const translucent = (surface.type & SurfaceType.Translucent) !== 0 && surface.translucency > 0;
  return {
    map,
    additive: (surface.type & SurfaceType.Additive) !== 0,
    // FX.emitter-black-solid-becomes-white — an untextured surface draws its
    // own colour: D3DPolyRender::SetSurface @ 0059c4d0 (no texture map, or no
    // D3D texture) → SetSolidColorTextureColor(alpha << 24 | color_value &
    // 0xffffff). Black stays black (the old `|| 0xffffff` turned it white).
    color: (surface.colorValue >>> 0) & 0xffffff,
    opacity: translucent ? 1 - surface.translucency : 1,
    // SetSurface @ 0059c4d0's ref (100 palettized / 200 otherwise) when it alpha-tests.
    alphaTest: surfaceDrawState(surface.type).alphaTest && map ? alphaTestRefFor(map) : 0,
    type: surface.type,
    luminosity: surface.luminosity,
  };
}

function resolveGfx(gfxId: number, db: Pick<DatDatabase, 'getFileData'>, textureManager: TextureSource): ParticleSpriteOptions | null {
  const hw = readGfxObj(db, gfxId);
  if (!hw || hw.surfaces.length === 0) return null;

  const surfaces: ParticleSurface[] = [];
  for (let i = 0; i < hw.surfaces.length; i++) {
    const s = resolveSurface(db, textureManager, hw.surfaces[i]);
    if (s) surfaces[i] = s;
  }
  const first = surfaces[0] ?? null;

  // World extent of the HW quad — the fallback square's size.
  let sizeScale = 1;
  if (hw.vertexArray) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const v of hw.vertexArray.vertices.values()) {
      if (v.origin.x < minX) minX = v.origin.x;
      if (v.origin.x > maxX) maxX = v.origin.x;
      if (v.origin.y < minY) minY = v.origin.y;
      if (v.origin.y > maxY) maxY = v.origin.y;
      if (v.origin.z < minZ) minZ = v.origin.z;
      if (v.origin.z > maxZ) maxZ = v.origin.z;
    }
    const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
    if (Number.isFinite(extent) && extent > 0) sizeScale = extent;
  }

  // The degrade chain: LoadGfxObjArray loads degrades[i].gfxobj_id per level.
  let degrades: GfxObjLOD[] = [];
  let levelIds: number[] = [gfxId];
  if (hw.didDegrade) {
    const data = db.getFileData(hw.didDegrade);
    if (data) {
      const chain = GfxObjDegradeInfo.read(new DatReader(data));
      if (chain.degrades.length > 0) {
        degrades = chain.degrades;
        levelIds = chain.degrades.map(l => (l.gfxObjId === 0xffffffff ? 0 : l.gfxObjId >>> 0));
      }
    }
  }
  const gfxObjs: ParticleGfx['gfxObjs'] = [];
  const indexById = new Map<number, number>();
  const levelGfx = levelIds.map((id) => {
    if (!id) return -1;
    const known = indexById.get(id);
    if (known !== undefined) return known;
    const g = id === gfxId ? hw : readGfxObj(db, id);
    const submeshes = g ? buildParticleSubmeshes(g, surfaces) : [];
    if (submeshes.length === 0) { indexById.set(id, -1); return -1; }
    indexById.set(id, gfxObjs.length);
    gfxObjs.push(submeshes);
    return gfxObjs.length - 1;
  });
  const level0 = levelIds[0] ? (levelIds[0] === gfxId ? hw : readGfxObj(db, levelIds[0])) : hw;
  const gfx: ParticleGfx | null = gfxObjs.length > 0
    ? { gfxObjs, degrades, levelGfx, sortCenter: { ...(level0 ?? hw).sortCenter } }
    : null;

  return {
    gfx,
    map: first?.map ?? null,
    additive: first?.additive ?? false,
    sizeScale,
  };
}
