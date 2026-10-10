/**
 * GAP.2 (lighting half) — dungeon light sources come from the DAT, not a
 * hardcoded approximation.
 *
 * SetupModel carries a Lights dict (LightInfo: viewer-space frame, _RGB
 * color, intensity, falloff, coneAngle — ACE.DatLoader/Entity/LightInfo.cs);
 * retail dungeons were lit by these placed static objects (torch sconces,
 * braziers). EnvCellRenderer.buildCellGroup now attaches a THREE.PointLight
 * per LightInfo under the placed object (userData.datLight), so cell
 * streaming manages light lifetime.
 *
 * DAT-gated: drives the real parser + renderer over client_portal/cell dats
 * and asserts the Training Academy landblock (0x8602 — the EoL starter
 * dungeon) produces at least one DAT-lit cell whose light matches the
 * SetupModel's LightInfo values.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RETAIL_LIGHT_RANGE_ADJUST, retailStaticLightDecay } from '../packages/renderer/src/models/RetailLighting.js';
import { openDat } from './_harness/dat.js';

const REPO = resolve(__dirname, '..');
const PORTAL = resolve(REPO, 'dat/client_portal.dat');
const CELL = resolve(REPO, 'dat/client_cell_1.dat');
const datPresent = existsSync(PORTAL) && existsSync(CELL);

describe.skipIf(!datPresent)('GAP.2 — DAT-driven dungeon lights (needs DAT files)', () => {
  it('Training Academy cells contain PointLights matching SetupModel LightInfo', async () => {
    const THREE = await import('three');
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
    const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
    const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
    const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');

    const portalDb = openDat(PORTAL);
    const cellDb = openDat(CELL);

    // Same wiring as main.ts:855-932.
    const textureManager = new TextureManager(portalDb);
    const materialFactory = new MaterialFactory(portalDb, textureManager);
    const modelRenderer = new ModelRenderer(portalDb, materialFactory);
    const setupRenderer = new SetupModelRenderer(portalDb, modelRenderer);
    const envRenderer = new EnvCellRenderer(portalDb, cellDb, materialFactory, setupRenderer, modelRenderer);

    // Scan the Training Academy landblock's interior cells for DAT lights.
    let litCells = 0;
    let checkedLight: { color: number; intensity: number; falloff: number } | null = null;
    for (let cell = 0x100; cell <= 0x1ff; cell++) {
      const cellId = (0x8602 << 16) | cell;
      let envCell;
      try {
        envCell = envRenderer.loadEnvCell(cellId);
      } catch { continue; }
      if (!envCell) continue;
      let group;
      try {
        group = envRenderer.createCellMesh(cellId);
      } catch { continue; }
      if (!group) continue;
      const lights: InstanceType<typeof THREE.PointLight>[] = [];
      group.traverse((o) => { if ((o as { userData?: { datLight?: boolean } }).userData?.datLight) lights.push(o as never); });
      if (lights.length === 0) continue;
      litCells++;
      if (!checkedLight) {
        // cross-check one light against its source SetupModel
        for (const stab of envCell.staticObjects) {
          if (((stab.id >> 24) & 0xff) !== 0x02) continue;
          const setup = setupRenderer.loadSetupModel(stab.id);
          if (setup && setup.lights.size > 0) {
            const info = [...setup.lights.values()][0];
            // CORE.17.q — the DAT bytes are the light's WORKING values (retail
            // multiplied raw bytes in gamma space), so read them back without
            // the sRGB encode.
            const match = lights.find((l) => l.color.getHex(THREE.LinearSRGBColorSpace) === (info.color & 0xffffff));
            if (match) {
              checkedLight = { color: match.color.getHex(THREE.LinearSRGBColorSpace), intensity: match.intensity, falloff: match.distance };
              expect(match.intensity).toBeCloseTo(info.intensity, 5);
              // CORE.17.q — D3DLIGHT.Range = falloff × rangeAdjust (1.5),
              // PrimD3DRender::config_hardware_light @ 0059ad30.
              expect(match.distance).toBeCloseTo(info.falloff * RETAIL_LIGHT_RANGE_ADJUST, 5);
              // CORE.17.q.a — decay is the light-class channel: a cell stab's LightInfo is a STATIC light (−intensity).
              expect(match.decay).toBe(retailStaticLightDecay(info.intensity));
              expect(match.decay).toBeLessThan(0);
              expect(match.visible).toBe(false); // disabled until DungeonRenderer enables nearest 8
            }
            break;
          }
        }
      }
    }
    expect(litCells).toBeGreaterThan(0);
    expect(checkedLight).not.toBeNull();
  }, 120_000);
});

describe('GAP.2 — DatLightBudget (the retail static list; CORE.17.h.g.c.c.b lifted the old nearest-8 cap)', () => {
  it('enables exactly the nearest max_static_lights DAT lights and re-ranks when the origin moves', async () => {
    const THREE = await import('three');
    const { DatLightBudget } = await import('../packages/renderer/src/effects/DatLightBudget.js');
    const root = new THREE.Group();
    const lights: InstanceType<typeof THREE.PointLight>[] = [];
    for (let i = 0; i < 20; i++) {
      const l = new THREE.PointLight(0xffffff, 1, 10, 1);
      l.position.set(i * 10, 0, 0); // 0,10,20,…,190
      l.userData.datLight = true;
      l.visible = false;
      root.add(l);
      lights.push(l);
    }
    root.updateMatrixWorld(true);
    const budget = new DatLightBudget(root);
    // the retail startup caps (40 static) keep all 20
    budget.update(new THREE.Vector3(0, 0, 0), 0);
    expect(budget.lightCount).toBe(20);
    expect(budget.activeCount).toBe(20);
    // a cap of 8 (what the old D3D7-premise budget did) keeps the 8 nearest
    const cap8 = { maxStaticLights: 8, maxDynamicLights: 0 };
    budget.update(new THREE.Vector3(0, 0, 0), 1, cap8);
    expect(budget.activeCount).toBe(8);
    // nearest 8 to x=0 are indices 0..7
    for (let i = 0; i < 20; i++) expect(lights[i].visible).toBe(i < 8);
    // move the origin to the far end — set flips to indices 12..19
    budget.update(new THREE.Vector3(190, 0, 0), 100, cap8);
    for (let i = 0; i < 20; i++) expect(lights[i].visible).toBe(i >= 12);
  });

  it('re-gathers lights only after the refresh interval (or invalidate)', async () => {
    const THREE = await import('three');
    const { DatLightBudget } = await import('../packages/renderer/src/effects/DatLightBudget.js');
    const root = new THREE.Group();
    const budget = new DatLightBudget(root);
    budget.update(new THREE.Vector3(), 0);
    expect(budget.lightCount).toBe(0);
    const l = new THREE.PointLight(0xffffff, 1, 10, 1);
    l.userData.datLight = true;
    l.visible = false;
    root.add(l);
    budget.update(new THREE.Vector3(), 100); // within refresh window — not seen yet
    expect(budget.lightCount).toBe(0);
    budget.invalidate();
    budget.update(new THREE.Vector3(), 200);
    expect(budget.lightCount).toBe(1);
    expect(l.visible).toBe(true);
  });
});
