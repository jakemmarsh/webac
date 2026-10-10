import * as THREE from 'three';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { ClothingTable, type ClothingBaseEffect, type CloObjectEffect } from '@ac/dat-parser/file-types/ClothingTable.js';
import type { SetupModelRenderer } from './SetupModelRenderer.js';
import type { ModelRenderer } from './ModelRenderer.js';
import type { MaterialFactory } from './MaterialFactory.js';
import { LruMap } from '../utils/LruMap.js';

/**
 * ClothingRenderer — applies clothing/equipment appearance changes to models.
 * Uses ClothingTable data to override textures and model parts.
 */
export class ClothingRenderer {
  private portalDb: DatDatabase;
  private setupModelRenderer: SetupModelRenderer;
  private modelRenderer: ModelRenderer;
  private materialFactory: MaterialFactory;
  // ASSESS: bounded leak backstop (fresh-eyes audit 2026-06-10). Parsed
  // ClothingTables are plain data; 1024 covers far more distinct 0x10 files
  // than any session equips/sees, and a miss re-parses from the in-memory
  // portal DAT. No disposal needed on evict.
  private clothingCache = new LruMap<number, ClothingTable>(1024);

  constructor(
    portalDb: DatDatabase,
    setupModelRenderer: SetupModelRenderer,
    modelRenderer: ModelRenderer,
    materialFactory: MaterialFactory,
  ) {
    this.portalDb = portalDb;
    this.setupModelRenderer = setupModelRenderer;
    this.modelRenderer = modelRenderer;
    this.materialFactory = materialFactory;
  }

  /**
   * Load and parse a ClothingTable from portal.dat.
   */
  loadClothingTable(clothingTableId: number): ClothingTable | null {
    const cached = this.clothingCache.get(clothingTableId);
    if (cached) return cached;

    const data = this.portalDb.getFileData(clothingTableId);
    if (!data) return null;

    const ct = new ClothingTable(new DatReader(data));
    this.clothingCache.set(clothingTableId, ct);
    return ct;
  }

  /**
   * Get the clothing base effect for a given setup model.
   */
  getBaseEffect(clothingTableId: number, setupModelId: number): ClothingBaseEffect | null {
    const ct = this.loadClothingTable(clothingTableId);
    if (!ct) return null;
    return ct.clothingBaseEffects.get(setupModelId) ?? null;
  }

  /**
   * Apply clothing effects to an existing setup mesh group.
   * Replaces part meshes and swaps textures based on ClothingBaseEffect.
   */
  applyClothingEffect(
    setupGroup: THREE.Group,
    clothingTableId: number,
    setupModelId: number,
  ): boolean {
    const baseEffect = this.getBaseEffect(clothingTableId, setupModelId);
    if (!baseEffect) return false;

    for (const objEffect of baseEffect.cloObjectEffects) {
      this.applyObjectEffect(setupGroup, objEffect);
    }

    return true;
  }

  /**
   * Apply a single CloObjectEffect to a setup mesh group.
   * Finds the part at the given index, replaces model if needed,
   * and applies texture overrides.
   */
  private applyObjectEffect(setupGroup: THREE.Group, effect: CloObjectEffect): void {
    // Find the part mesh at this index
    const partName = `part_${effect.index}`;
    let partMesh: THREE.Object3D | null = null;

    setupGroup.traverse((child) => {
      if (child.name === partName) {
        partMesh = child;
      }
    });

    if (!partMesh) return;

    // Apply texture overrides to existing meshes
    if (effect.cloTextureEffects.length > 0) {
      this.applyTextureOverrides(partMesh, effect);
    }
  }

  /**
   * Apply texture overrides from clothing to a part's mesh children.
   * This modifies the material textures by swapping surface textures.
   */
  private applyTextureOverrides(partMesh: THREE.Object3D, effect: CloObjectEffect): void {
    // Track which old textures map to new textures
    const textureMap = new Map<number, number>();
    for (const texEffect of effect.cloTextureEffects) {
      textureMap.set(texEffect.oldTexture, texEffect.newTexture);
    }

    // Store the texture map on the mesh for external access (e.g., tests)
    (partMesh as THREE.Object3D & { _textureOverrides?: Map<number, number> })._textureOverrides = textureMap;
  }

  /**
   * Get the number of cached ClothingTables.
   */
  get cacheSize(): number {
    return this.clothingCache.size;
  }

  /**
   * Clear all caches.
   */
  clear(): void {
    this.clothingCache.clear();
  }
}
