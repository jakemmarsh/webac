/**
 * Main application entry point for the Asheron's Call browser client.
 *
 * Sets up Three.js scene, camera, controls, and terrain streaming.
 * This module requires a browser environment with WebGL support.
 */

export { LandblockMesh, LandblockGeometry } from './terrain/LandblockMesh.js';
export { TerrainManager } from './terrain/TerrainManager.js';
export { TerrainRenderer } from './terrain/TerrainRenderer.js';
export { SceneManager } from './scene/SceneManager.js';
export { CameraController } from './scene/CameraController.js';
export { TextureManager } from './models/TextureManager.js';
export { MaterialFactory } from './models/MaterialFactory.js';
export { ModelRenderer } from './models/ModelRenderer.js';
export { buildGfxObjGeometry } from './models/GfxObjMesh.js';
export { SetupModelRenderer } from './models/SetupModelRenderer.js';
export { ClothingRenderer } from './models/ClothingRenderer.js';
export { AppearanceManager } from './models/AppearanceManager.js';
export { CharacterModelBuilder } from './models/CharacterModelBuilder.js';
export { getPartPlacements } from './models/SetupModelGroup.js';
export { EnvCellRenderer } from './world/EnvCellRenderer.js';
export { DungeonRenderer } from './world/DungeonRenderer.js';
export { AnimationPlayer, interpolateFrames, slerp, lerp3 } from './animation/AnimationPlayer.js';
export { MotionManager } from './animation/MotionManager.js';
export { SkeletonSystem, combineFrames, multiplyQuaternions, rotateByQuaternion, IDENTITY_FRAME } from './animation/SkeletonSystem.js';
export { ParticleSystem } from './effects/ParticleSystem.js';
export { SkyboxRenderer } from './effects/SkyboxRenderer.js';
export { SpellEffects } from './effects/SpellEffects.js';
export { MagicSchool } from '@ac/shared';
export { AudioManager } from './audio/AudioManager.js';
export type { AudioCategory } from './audio/AudioManager.js';
export { SoundPlayer } from './audio/SoundPlayer.js';
export { MusicPlayer } from './audio/MusicPlayer.js';
export type { MusicTrack } from './audio/MusicPlayer.js';

/**
 * Application configuration
 */
export interface AppConfig {
  /** Canvas element or selector to render into */
  canvas?: HTMLCanvasElement | string;
  /** Path to DAT files directory (default: '/dat/') */
  datPath?: string;
  /** Terrain load radius in landblocks (default: 2 = 5×5 grid) */
  terrainRadius?: number;
}

/**
 * Initialize the application.
 * Call this from the browser entry point after DOM is ready.
 */
export async function initApp(_config?: AppConfig): Promise<void> {
  // Full initialization will be completed in later phases.
  // For now, this module serves as the entry point that
  // re-exports all renderer modules.
}
