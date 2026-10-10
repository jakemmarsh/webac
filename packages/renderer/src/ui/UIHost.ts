/**
 * DEBT.main-ts-extractions — the world services GameUI drives, injected by
 * main.ts (GameUI.setUIHost) instead of reached back through the
 * `window.__ac` debug bridge. `window.__ac` still exists for live probes;
 * GameUI just no longer depends on it.
 *
 * Before main.ts installs the host (pre-world, and in the DOM test harness)
 * GameUI has none and every consumer is the same no-op it was when
 * `window.__ac` was absent: the offscreen previews leave their canvases
 * blank and the Config-tab setters do nothing (main.ts reads the persisted
 * prefs itself before the world is built).
 */
import type * as THREE from 'three';
import type { AppearanceManager } from '../models/AppearanceManager.js';
import type { CharacterModelBuilder } from '../models/CharacterModelBuilder.js';

/** The camera-controller fields the Config tab's camera / mouse-look rows write (VISUAL3.69, CORE.17.h.g). */
export interface UIHostCameraConfig {
  lookSpeed: number;
  mouseLookSensitivity?: number;
  invertMouseLookY?: boolean;
  setStiffness?: (s: number) => void;
  adjustmentSpeed?: number;
  alignToSlope?: boolean;
}

export interface UIHost {
  /** The shared WebGL renderer the examine / chargen / paperdoll previews render offscreen with. */
  readonly renderer?: THREE.WebGLRenderer | null;
  /** Builds the chargen preview character (CORE.17.k.b.b.a.e). */
  readonly characterModelBuilder?: CharacterModelBuilder | null;
  /** Resolves chargen palette-set swatches + the shade disk (VISUAL.156). */
  readonly appearanceManager?: AppearanceManager | null;
  /** The player's live model, cloned into the paperdoll (CORE.17.m). */
  readonly playerModel?: THREE.Group | null;
  /** The live camera controller the Config camera rows write (VISUAL3.69). */
  readonly cameraController?: UIHostCameraConfig | null;
  /** Retail m_fGameFOV → the main camera (VISUAL.72 / CORE.18.b). */
  setGameFov?(deg: number): void;
  /** The m_fGameFOV preference currently applied (degrees) — portal space's
   *  CreatureMode viewport uses it too (UseSmartboxFOV). */
  readonly gameFov?: number;
  /** SmartBox::SetOverrideFovDistance as a ratio g / v (null = the game's own
   *  projection): the world zoom of the teleport fades (PortalSpaceModel.ts). */
  setViewDistanceRatio?(ratio: number | null): void;
  /** Render.DegradeDistance / AdaptiveDegrade / bias (CORE.17.h.g.c.c). */
  setDegradePrefs?(prefs: Record<string, unknown>): boolean;
  /** Render.BuildingDetailTextures (CORE.17.h.g.c.b). */
  setDetailTexturing?(on: boolean): boolean;
  /** Render.TextureFiltering / *TextureDetail (CORE.17.h.g.c). */
  setTexturePrefs?(prefs: Record<string, unknown>): boolean;
  /** Render.LandscapeDrawDistance in landblocks (CORE.17.h.g.a). */
  setLandscapeDrawDistance?(blocks: number): boolean;
}
