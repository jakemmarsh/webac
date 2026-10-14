/**
 * REMASTER — an opt-in modern rendering mode (a prototype, off by default).
 *
 * Retail fidelity stays the default everywhere (CLAUDE.md "Always Match
 * Retail's Defaults"). `?remaster` turns on a separate presentation layer
 * over the same DAT assets and the same DAT light levels:
 *  - lighting: per-pixel, linear-space shading with the DAT sun / ambient /
 *    point lights, a sky/ground ambient split and bump detail derived from
 *    each surface's own texture (RemasterLighting.ts);
 *  - shadows: the DAT sun casts real shadows around the camera;
 *  - ao / bloom / tonemap: a post stack (RemasterPipeline.ts);
 *  - models: smoother silhouettes from curved (PN) triangles built from the
 *    DAT vertex normals at load (PnTessellation.ts);
 *  - grass: instanced 3D grass on the DAT's grass terrain types (GrassField.ts);
 *  - assets: high-detail replacement models keyed by DAT GfxObj id (AssetOverrides.ts, remodels/).
 *
 * `?remaster` (or `?remaster=1`) turns every feature on; `?remaster=shadows,ao`
 * turns on just those; `?remaster=0` is off. The flag is read once, before the
 * first material compiles, because materials pick their shading at creation.
 */

export interface RemasterSettings {
  lighting: boolean;
  shadows: boolean;
  ao: boolean;
  bloom: boolean;
  tonemap: boolean;
  models: boolean;
  grass: boolean;
  assets: boolean;
}

export const REMASTER_FEATURES: readonly (keyof RemasterSettings)[] = ['lighting', 'shadows', 'ao', 'bloom', 'tonemap', 'models', 'grass', 'assets'];

/** Parse the `remaster` query value. null = the mode is off. */
export function parseRemaster(search: string): RemasterSettings | null {
  const params = new URLSearchParams(search);
  if (!params.has('remaster')) return null;
  const raw = (params.get('remaster') ?? '').trim().toLowerCase();
  if (raw === '0' || raw === 'off' || raw === 'false') return null;
  const all = raw === '' || raw === '1' || raw === 'on' || raw === 'true' || raw === 'all';
  const picked = new Set(raw.split(',').map(s => s.trim()));
  const s = {} as RemasterSettings;
  for (const f of REMASTER_FEATURES) s[f] = all || picked.has(f);
  // Shadows and the sky/ground ambient live in the remaster lighting patch.
  if (s.shadows || s.grass || s.assets) s.lighting = true;
  return REMASTER_FEATURES.some(f => s[f]) ? s : null;
}

let current: RemasterSettings | null | undefined;

/** The active remaster settings, or null when the retail renderer is in use. */
export function remaster(): RemasterSettings | null {
  if (current === undefined) {
    current = typeof location !== 'undefined' ? parseRemaster(location.search) : null;
  }
  return current;
}

/** Tests and tools: force the mode (null = retail). */
export function setRemaster(settings: RemasterSettings | null): void {
  current = settings;
}
