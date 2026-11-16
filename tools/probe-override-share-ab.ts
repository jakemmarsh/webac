/**
 * probe-override-share-ab — in-session A/B for PERF.override-material-share (2026-11-16,
 * docs/perf-pass-2026-11-15.md). MaterialFactory used to make a fresh material on every
 * getMaterial call with a palette / texture override (every creature, NPC and player),
 * so identical objects never shared one; now an object whose whole build repeats an
 * earlier object's draws that object's materials, part for part (endObjectBuild).
 *
 * The page is told to make them the old way (window.__acUniqueOverrideMaterials, read
 * by MaterialFactory.getMaterial) before the game starts (an init script), and
 * the probe swaps every such mesh between its per-call materials (A, the old behaviour)
 * and the content-shared ones the same calls make now (B: MaterialFactory.sharedOverrideFor: what endObjectBuild would have swapped in,
 * and its cell-pass variant when the mesh draws one), in the same frames.
 *   1. same-frame pixel A/B at YAWS headings; 2. CPU-throttled interleaved speed A/B (tools/lib/inline-ab.ts).
 * Needs the Vite dev server (it imports /src/models/RetailLighting.ts).
 * Usage (env): AC_URL; HOP (an optional teleport first); TELE (default: the Holtburg academy hall);
 *   THROTTLE=10; ROUNDS=6; SLICE_MS=5000; YAWS='0,90,180,270'; SPEED=0 skips the speed A/B; TAG.
 *   npx tsx tools/probe-override-share-ab.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO, adminCommand, enterWorld } from './lib/game-session.ts';
import { pixelAB, speedAB } from './lib/inline-ab.ts';

const HOP = process.env.HOP ?? '';
const TELE = process.env.TELE ?? '@teleloc 0x8602023A [60 -20 0.005] 1 0 0 0';
const THROTTLE = Number(process.env.THROTTLE ?? 10);
const ROUNDS = Number(process.env.ROUNDS ?? 6);
const SLICE_MS = Number(process.env.SLICE_MS ?? 5000);
const YAWS = (process.env.YAWS ?? '0,90,180,270').split(',').map(Number);
const SPEED = process.env.SPEED !== '0';
const TAG = process.env.TAG ?? 'academy';

// The switch is on before the game starts, so every object (the ones met at login too) is built the old way.
const { browser, page } = await enterWorld({ gpu: true, timeoutMs: 420000, initScript: 'window.__acUniqueOverrideMaterials = true' });
if (HOP) { await adminCommand(page, HOP); await page.waitForTimeout(15000); }
if (TELE) await adminCommand(page, TELE);
await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 30000));
await page.mouse.click(780, 250);

const setup = await page.evaluate(`(async () => {
  const RL = await import('/src/models/RetailLighting.ts');
  const mf = window.__ac.materialFactory; const scene = window.__ac.sceneManager.scene;
  const swaps = []; const before = new Set(); const after = new Set();
  scene.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    let changed = false;
    const next = list.map((m) => {
      const base = RL.cellObjectBaseOf(m);
      const shared = mf.sharedOverrideFor(base);
      if (!shared) return m;
      changed = true;
      return base === m ? shared : RL.cellObjectVariantOf(shared, o.geometry);
    });
    if (!changed) return;
    for (const m of list) before.add(m); for (const m of next) after.add(m);
    swaps.push({ mesh: o, unique: o.material, shared: Array.isArray(o.material) ? next : next[0] });
  });
  window.__abSet = (sharedOn) => { for (const s of swaps) s.mesh.material = sharedOn ? s.shared : s.unique; };
  return { meshes: swaps.length, materialsUnique: before.size, materialsShared: after.size };
})()`);
console.log('SETUP', JSON.stringify(setup));

const pixels = await pixelAB(page, YAWS);
const speed = SPEED ? await speedAB(page, { throttle: THROTTLE, rounds: ROUNDS, sliceMs: SLICE_MS, labels: ['unique', 'shared'] }) : null;
if (speed) console.log('SPEED', JSON.stringify(speed, null, 1));
await page.evaluate('window.__abSet(false)');
await browser.close();
mkdirSync(resolve(REPO, 'verification/perf'), { recursive: true });
const file = resolve(REPO, `verification/perf/override-share-ab-${new Date().toISOString().replace(/[:.]/g, '-')}-${TAG}.json`);
writeFileSync(file, JSON.stringify({ hop: HOP, tele: TELE, throttle: THROTTLE, rounds: ROUNDS, sliceMs: SLICE_MS, setup, pixels, speed }, null, 1) + '\n');
console.log('wrote', file);
