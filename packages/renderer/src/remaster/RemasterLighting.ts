/**
 * REMASTER lighting — the opt-in modern shading for world materials
 * (RemasterMode.ts). The retail patch (RetailLighting.ts) reproduces D3D8's
 * per-vertex, gamma-space, clamped light sum. This one keeps the SAME DAT
 * light inputs (the RegionDesc sun and ambient, the DAT point lights, the
 * object ambient scale) and changes how they are applied:
 *
 *  - per pixel, in linear space, unclamped (the post stack tone-maps it);
 *  - the sun casts three.js shadow-map shadows (RemasterPipeline places them);
 *  - the ambient takes a sky/ground split: surfaces facing up get more of it
 *    than surfaces facing down, so shapes read without a second light;
 *  - surface detail: a bump normal derived from the surface's own texture
 *    (its luminance), so stone, bark and cloth catch the light;
 *  - point lights (torches, braziers, spell lights) reach every surface near
 *    them, outdoors too, with a smooth falloff.
 *
 * The geometry-class light sets stay retail's: env cells and the objects in
 * them take no sun (PView::DrawCells' useSunlightSet(0) span).
 */
import * as THREE from 'three';
import type { RetailLightingKind } from '../models/RetailLighting.js';

export const REMASTER_LIGHTING_CACHE_KEY = 'acRemasterLighting';

/** Landscape detail tiling: the terrain texture repeated this much finer near the camera. */
export const REMASTER_TERRAIN_DETAIL_TILING = 6.0;

/** Bump strength of the texture-derived detail normal. */
export const REMASTER_BUMP_SCALE = 0.7;

/**
 * DAT light levels are gamma-space values: retail multiplied the 8-bit texel
 * by them (0.4 light = 40% of the texel's displayed value). Applied in linear
 * space unchanged they would lift every dim scene (0.4 shows as ~66%), so each
 * light's brightness is converted to linear (^2.2, hue kept: a per-channel
 * power over-saturates the DAT's tinted night and dungeon light) first; dawn, dusk, night and dungeons
 * keep retail's darkness. The gains then set the sun vs ambient balance (AC's
 * ambient is strong; the remaster lets shadows read) and the tone-map
 * exposure (RemasterPipeline) brings noon back to retail's brightness.
 */
export const REMASTER_LIGHT_GAMMA = 2.2;
export const REMASTER_SUN_GAIN = 1.3;
export const REMASTER_AMBIENT_GAIN = 2.2;
/** Sealed cells live on the 0.2 dungeon ambient alone (plus their lights): lift it so walls read as in retail. */
export const REMASTER_CELL_AMBIENT_GAIN = 1.7;

/** Ambient multiplier for a surface facing straight down / straight up. */
/** The brightest a single point light can make a surface (per channel, before tone mapping). */
export const REMASTER_POINT_LIGHT_CAP = 1.25;

export const REMASTER_AMBIENT_GROUND = 0.6;
export const REMASTER_AMBIENT_SKY = 1.15;

const IN_CELL_DEFINE = 'AC_REMASTER_IN_CELL';
const LANDSCAPE_DEFINE = 'AC_REMASTER_LANDSCAPE';

const LAMBERT_PARS = '#include <lights_lambert_pars_fragment>';
const LIGHTS_PARS = '#include <lights_pars_begin>';
const LIGHTS_BEGIN = '#include <lights_fragment_begin>';
const NORMAL_MAPS = '#include <normal_fragment_maps>';
const COLOR_FRAGMENT = '#include <color_fragment>';
const COMMON = '#include <common>';
const FOG_INCLUDE = '#include <fog_fragment>';
const FOG_MIX = 'gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );';
const OUTGOING = 'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;';

const DIR_GUARD = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )';
const DIR_INFO = 'getDirectionalLightInfo( directionalLight, directLight );';
const AMBIENT_LINE = 'vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );';
const POINT_ATTEN = 'light.color *= getDistanceAttenuation( lightDistance, pointLight.distance, pointLight.decay );';
const BRDF = 'BRDF_Lambert( material.diffuseColor )';

/**
 * Point-light falloff. The DAT lights carry retail's conventions
 * (RetailLighting.ts): `distance` is the hard D3D range, and a static cell
 * light stores `decay = −intensity` with `color` = raw colour × intensity.
 * Both are mapped to a bounded contribution with a smooth window to the range.
 */
const GLSL_PARS = `
uniform float acAmbientScale;
#ifndef AC_LIGHT_SCALE
	#define AC_LIGHT_SCALE 1.0
#endif
float acRemasterAtten( const in float d, const in float range, const in float decay ) {
	if ( range > 0.0 && d >= range ) return 0.0;
	float w = range > 0.0 ? pow2( saturate( 1.0 - pow4( d / range ) ) ) : 1.0;
	if ( decay < 0.0 ) {
		float intensity = - decay;
		return w * min( intensity / max( d * d, 1.0 ), 1.0 ) / intensity;
	}
	return w / max( d, 1.0 );
}
// A DAT hardware light's colour carries its intensity (retail clamped the
// per-vertex sum to 1); cap one light's reach at a bright-but-finite level.
vec3 acCapLight( const in vec3 c ) {
	float m = max( c.r, max( c.g, c.b ) );
	return m > ${REMASTER_POINT_LIGHT_CAP.toFixed(3)} ? c * ( ${REMASTER_POINT_LIGHT_CAP.toFixed(3)} / m ) : c;
}
vec3 acSRGBToLinearRm( in vec3 c ) {
	return mix( c / 12.92, pow( ( c + 0.055 ) / 1.055, vec3( 2.4 ) ), step( 0.04045, c ) );
}
vec3 acLightToLinear( const in vec3 c ) {
	float v = max( c.r, max( c.g, c.b ) );
	return v > 0.0 ? c * ( pow( v, ${REMASTER_LIGHT_GAMMA.toFixed(2)} ) / v ) : vec3( 0.0 );
}
#ifdef ${IN_CELL_DEFINE}
	#define acCellAmbient ${REMASTER_CELL_AMBIENT_GAIN.toFixed(3)}
#else
	#define acCellAmbient 1.0
#endif
float acLuma( const in vec3 c ) { return dot( c, vec3( 0.299, 0.587, 0.114 ) ); }
vec3 acPerturbNormal( vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir ) {
	vec3 sx = normalize( dFdx( surfPos ) );
	vec3 sy = normalize( dFdy( surfPos ) );
	vec3 r1 = cross( sy, surfNorm );
	vec3 r2 = cross( surfNorm, sx );
	float det = dot( sx, r1 ) * faceDir;
	vec3 grad = sign( det ) * ( dHdxy.x * r1 + dHdxy.y * r2 );
	return normalize( abs( det ) * surfNorm - grad );
}
`;

const GLSL_BUMP = `
#ifdef USE_MAP
	{
		#ifdef ${LANDSCAPE_DEFINE}
		vec2 acBuv = vMapUv * ${REMASTER_TERRAIN_DETAIL_TILING.toFixed(1)};
		#else
		vec2 acBuv = vMapUv;
		#endif
		vec2 acDx = dFdx( acBuv );
		vec2 acDy = dFdy( acBuv );
		float acH0 = acLuma( texture2D( map, acBuv ).rgb );
		float acHx = acLuma( texture2D( map, acBuv + acDx ).rgb );
		float acHy = acLuma( texture2D( map, acBuv + acDy ).rgb );
		normal = acPerturbNormal( - vViewPosition, normal, vec2( acHx - acH0, acHy - acH0 ) * ${REMASTER_BUMP_SCALE.toFixed(3)}, faceDirection );
	}
#endif
`;

/**
 * Landscape close-up detail: the terrain texture again at a finer tiling,
 * normalised by its own mip average so it adds grain without shifting the
 * colour, fading out with distance. Uses only the DAT terrain texture.
 */
const GLSL_TERRAIN_DETAIL = `
#if defined( ${LANDSCAPE_DEFINE} ) && defined( USE_MAP )
	{
		float acFade = 1.0 - smoothstep( 6.0, 42.0, length( vViewPosition ) );
		if ( acFade > 0.0 ) {
			vec2 acDuv = vMapUv * ${REMASTER_TERRAIN_DETAIL_TILING.toFixed(1)};
			float acSharp = acLuma( texture2D( map, acDuv ).rgb );
			float acMean = acLuma( texture2D( map, acDuv, 6.0 ).rgb );
			diffuseColor.rgb *= mix( 1.0, clamp( acSharp / max( acMean, 0.04 ), 0.55, 1.5 ), 0.6 * acFade );
		}
	}
#endif
`;

const GLSL_AMBIENT = `vec3 irradiance = acLightToLinear( max( ambientLightColor * acAmbientScale, 0.0 ) ) * ${REMASTER_AMBIENT_GAIN.toFixed(3)} * acCellAmbient * AC_LIGHT_SCALE
		* mix( ${REMASTER_AMBIENT_GROUND.toFixed(3)}, ${REMASTER_AMBIENT_SKY.toFixed(3)}, dot( geometryNormal, normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz ) ) * 0.5 + 0.5 );`;

function mustReplace(src: string, anchor: string, by: string, what: string): string {
  if (!src.includes(anchor)) throw new Error(`RemasterLighting: ${what} anchor missing (${anchor})`);
  return src.split(anchor).join(by);
}

/** The Lambert fragment shader with the remaster equation (throws if three.js moved an anchor). */
function remasterLightChunks(): { lightsPars: string; begin: string; fog: string } {
  const lightsPars = mustReplace(THREE.ShaderChunk.lights_pars_begin, POINT_ATTEN, 'light.color = acCapLight( acLightToLinear( max( light.color * acRemasterAtten( lightDistance, pointLight.distance, pointLight.decay ), 0.0 ) ) ) * AC_LIGHT_SCALE;', 'point attenuation');
  let begin = mustReplace(THREE.ShaderChunk.lights_fragment_begin, AMBIENT_LINE, GLSL_AMBIENT, 'ambient');
  begin = mustReplace(begin, DIR_INFO, `${DIR_INFO}\n\t\tdirectLight.color = acLightToLinear( max( directLight.color, 0.0 ) ) * ${REMASTER_SUN_GAIN.toFixed(3)} * AC_LIGHT_SCALE;`, 'directional info');
  begin = mustReplace(begin, DIR_GUARD, `${DIR_GUARD} && !defined( ${IN_CELL_DEFINE} )`, 'directional guard');
  // The DAT fog colour and range are gamma-space values (D3D8 blended fog after
  // the texel x light modulate); blend there too, so far hills keep retail's
  // haze instead of washing out to the sky colour in linear space.
  const fog = mustReplace(THREE.ShaderChunk.fog_fragment, FOG_MIX,
    'gl_FragColor.rgb = acSRGBToLinearRm( mix( sRGBTransferOETF( vec4( max( gl_FragColor.rgb, 0.0 ), 1.0 ) ).rgb, fogColor, fogFactor ) );', 'fog mix');
  return { lightsPars, begin, fog };
}

/** The Lambert fragment shader with the remaster equation (throws if three.js moved an anchor). */
export function patchRemasterFragment(fragmentShader: string, kind: RetailLightingKind): string {
  const inCell = kind === 'envcell' || kind === 'cellobject';
  const lambertPars = mustReplace(THREE.ShaderChunk.lights_lambert_pars_fragment, BRDF, 'material.diffuseColor', 'BRDF_Lambert');
  const { lightsPars, begin, fog } = remasterLightChunks();
  let out = fragmentShader;
  out = mustReplace(out, LIGHTS_PARS, GLSL_PARS + lightsPars, 'lights_pars_begin include');
  out = mustReplace(out, LAMBERT_PARS, lambertPars, 'lambert pars include');
  out = mustReplace(out, LIGHTS_BEGIN, begin, 'lights_fragment_begin include');
  // The surface's luminosity glows THROUGH its texture, as D3D's material
  // emissive did (RetailLighting: emissive is part of the modulated colour);
  // stock three.js adds it flat, turning a luminous flame sprite into a lit square.
  out = mustReplace(out, OUTGOING, 'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance * diffuseColor.rgb;', 'outgoingLight');
  out = mustReplace(out, FOG_INCLUDE, fog, 'fog_fragment include');
  out = mustReplace(out, COLOR_FRAGMENT, `${COLOR_FRAGMENT}\n${GLSL_TERRAIN_DETAIL}`, 'color_fragment include');
  out = mustReplace(out, NORMAL_MAPS, `${NORMAL_MAPS}\n${GLSL_BUMP}`, 'normal_fragment_maps include');
  const defines = (inCell ? `#define ${IN_CELL_DEFINE}\n` : '') + (kind === 'landscape' ? `#define ${LANDSCAPE_DEFINE}\n` : '');
  return defines + out;
}

/**
 * The same DAT lights for a physically based (Standard / Physical) material:
 * a replacement asset (AssetOverrides.ts) sits under the same sun, ambient,
 * point lights and fog as the world around it. Its BRDF keeps three's 1/PI,
 * so the light levels are scaled by PI to match the Lambert remaster patch.
 */
export function patchRemasterPbrFragment(fragmentShader: string, kind: RetailLightingKind = 'object'): string {
  const inCell = kind === 'envcell' || kind === 'cellobject';
  const { lightsPars, begin, fog } = remasterLightChunks();
  let out = fragmentShader;
  out = mustReplace(out, LIGHTS_PARS, GLSL_PARS + lightsPars, 'lights_pars_begin include');
  out = mustReplace(out, LIGHTS_BEGIN, begin, 'lights_fragment_begin include');
  out = mustReplace(out, FOG_INCLUDE, fog, 'fog_fragment include');
  return '#define AC_LIGHT_SCALE 3.14159265\n' + (inCell ? `#define ${IN_CELL_DEFINE}\n` : '') + out;
}

/** Sanity check used by tests: the vertex stage keeps three's own Lambert vertex (shadow coords, normals). */
export function patchRemasterVertex(vertexShader: string): string {
  if (!vertexShader.includes(COMMON)) throw new Error('RemasterLighting: not a three.js vertex shader');
  return vertexShader;
}

export function remasterCacheKey(kind: RetailLightingKind): string {
  return `${REMASTER_LIGHTING_CACHE_KEY}:${kind}`;
}

/**
 * Should a mesh drawn with this kind cast sun shadows? Objects, buildings and
 * scenery do; the ground only receives; the sky neither.
 */
export function remasterCastsShadow(kind: RetailLightingKind | undefined): boolean {
  return kind === 'object' || kind === 'cellobject' || kind === 'envcell';
}

export function remasterReceivesShadow(kind: RetailLightingKind | undefined): boolean {
  return kind !== undefined && kind !== 'sky';
}
