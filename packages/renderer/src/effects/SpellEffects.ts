import * as THREE from 'three';
import { ParticleSystem, type ParticleSpriteOptions, type ParticleFrameSource, type ParticleView } from './ParticleSystem.js';
import type { ParticleEmitterInfo } from '@ac/dat-parser/file-types/ParticleEmitterInfo.js';

/** Extra spawn options for DAT emitters (see PhysicsScriptPlayer's CreateParticle). */
export interface SpawnParticleOptions {
  /** The parent (object or part) frame the emitter rides — world-space simulation. */
  frameSource?: ParticleFrameSource;
  /** The hook's part index (-1 = the object itself) — informational, for probes. */
  partIndex?: number;
}

/**
 * SpellEffects — the live DAT particle emitters (0x32 ParticleEmitterInfo),
 * spawned by PhysicsScriptPlayer's CreateParticle hooks and advanced every
 * frame. Every effect retail draws goes through that path: server
 * PlayScripts through the target's PhysicsScriptTable, animation frame
 * hooks, DefaultScripts, and the client's own set_hidden Hidden / UnHide
 * scripts (effects/HiddenStateScripts).
 *
 * BUG.invented-portal-burst-and-spell-effects (2026-09-28): the invented
 * procedural layer that used to live here is gone — spawnProjectile (a fake
 * school-coloured bolt beside the server's real projectile), createImpactFlash
 * (a ring + sphere + PointLight), createWeaponImpact / createCriticalHit
 * (spheres, rings and PointLights on every melee hit, doubling the server's
 * Splatter* script — ACE Player_Combat.cs:175), createShieldBlock,
 * createResistSparkle (on every evade — nothing in retail), and the
 * synthetic THREE.Points bursts behind them (spawnParticleBurst). Retail's
 * client has no such effects: every particle comes from a DAT emitter
 * (ParticleManager::CreateParticleEmitter @ 0051b6c0, only reached from the
 * CreateParticle hooks).
 */
export class SpellEffects {
  private scene: THREE.Scene;
  private activeParticleSystems: Array<{ system: ParticleSystem; parent: THREE.Object3D }> = [];

  /** See setParticleView. */
  private particleView: ParticleView | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /**
   * Spawn a particle system from a ParticleEmitterInfo at a world position.
   * The particle system is driven by real DAT data (0x32xxxxxx).
   *
   * `sprite` carries the emitter's own quad rendering options (texture +
   * additive bit + quad extent, resolved via resolveEmitterSprite) — the
   * retail client draws every particle as the emitter's GfxObj quad, so
   * omitting it leaves untextured white squares. A system lives until it
   * reports itself done (ParticleManager::UpdateParticles @ 0051b800 deletes
   * an emitter only when its UpdateParticles returns 0) or its owner removes
   * it (removeParticleSystem) — an endless emitter (totalSeconds and
   * totalParticles both 0, e.g. the portal vortex) runs for the owning
   * object's lifetime.
   *
   * CORE.9.b — `parent` attaches the system under that node instead of the
   * scene, with `position` interpreted as a LOCAL offset. Retail parents
   * sky-script emitters into GameSky's before/after_sky_cell
   * (GameSky::MakeObject → AddObjectToSingleCell), whose frame is re-anchored
   * to the viewer every tick — a scene-rooted spawn at the world position of
   * spawn time would stay behind at that point forever.
   */
  spawnParticleEffect(
    info: ParticleEmitterInfo,
    position: { x: number; y: number; z: number },
    color?: number,
    sprite?: ParticleSpriteOptions,
    parent?: THREE.Object3D,
    opts?: SpawnParticleOptions,
  ): ParticleSystem {
    const system = new ParticleSystem(info, color ?? 0xffffff, sprite, opts?.frameSource);
    const obj = system.object3D;
    obj.name = `particles_${(info.id >>> 0).toString(16).padStart(8, '0')}`;
    if (system.isWorldSpace) {
      // World-frame emitters (ParticleEmitter::SetParenting) simulate their
      // particles in world coordinates against the live parent frame; the
      // system's node itself stays at the scene origin.
      this.scene.add(obj);
    } else {
      obj.position.set(position.x, position.y, position.z);
      (parent ?? this.scene).add(obj);
    }
    // Lay the burst out against the viewer (billboards, LOD) at birth.
    if (this.particleView) system.setView(this.particleView);
    this.activeParticleSystems.push({ system, parent: obj });
    return system;
  }

  /**
   * VISUAL.particles-oriented-quads — the viewer (Render::viewer_pos) and
   * degrade preferences every DAT particle is laid out against: particles
   * are world-size GfxObj meshes, billboarded / LOD-culled per their
   * GfxObj's degrade chain, so they need the camera, not a point scale.
   * The owner mutates the same object each frame (before update()); a new
   * object is handed to every live system.
   */
  setParticleView(view: ParticleView | null): void {
    if (view === this.particleView) return;
    this.particleView = view;
    for (const ps of this.activeParticleSystems) ps.system.setView(view);
  }

  /**
   * Remove one active particle system immediately (endless emitters whose
   * owning world object despawned). No-op if the system isn't tracked.
   */
  removeParticleSystem(system: ParticleSystem): void {
    const idx = this.activeParticleSystems.findIndex(ps => ps.system === system);
    if (idx === -1) return;
    const ps = this.activeParticleSystems[idx];
    // removeFromParent, not scene.remove — anchored systems (CORE.9.b) are
    // not direct scene children, and scene.remove silently no-ops on those.
    ps.parent.removeFromParent();
    ps.system.dispose();
    this.activeParticleSystems.splice(idx, 1);
  }

  /**
   * Advance every live emitter. Call once per frame from the render loop.
   */
  update(dt: number): void {
    for (let i = this.activeParticleSystems.length - 1; i >= 0; i--) {
      const ps = this.activeParticleSystems[i];
      ps.system.update(dt);

      // DECOMP.invented-emitter-maxage — removed only when the emitter is
      // done (stopped with nothing left — UpdateParticles returning 0); a
      // stationary per-metre trail waits for its owner, as in retail.
      if (ps.system.isDone) {
        ps.parent.removeFromParent();
        ps.system.dispose();
        this.activeParticleSystems.splice(i, 1);
      }
    }
  }

  /** Live particle systems. */
  get activeCount(): number {
    return this.activeParticleSystems.length;
  }

  /** Clean up every live system. */
  dispose(): void {
    for (const ps of this.activeParticleSystems) {
      ps.parent.removeFromParent();
      ps.system.dispose();
    }
    this.activeParticleSystems.length = 0;
  }
}
