/**
 * probe-restored-copy-ab — in-session A/B for PERF.restored-copy-release (2026-11-16,
 * docs/perf-pass-2026-11-15.md). A part that faded (a creature materializing, a
 * player portalling in) got a private material copy per mesh (CPhysicsPart::CopyMaterial)
 * and kept it after the fade ended; retail's RestoreMaterial @ 0050df70 drops it.
 *
 * The page is told to keep the copies (window.__acKeepRestoredCopies, read by
 * MaterialOwnership.releaseRestoredCopies) before the game starts (an init script), so the
 * session holds the pre-fix state; the probe then finds every mesh the fix would
 * release (an owned copy at the part's default translucency, no script values, no
 * owned UV map) and swaps those meshes between their copies (A, the old behaviour)
 * and the shared originals (B, the fix) — the same objects, lights and frames.
 *   1. same-frame pixel A/B at YAWS headings (tools/lib/inline-ab.ts pixelAB);
 *   2. CPU-throttled interleaved speed A/B while circling (speedAB).
 * Needs the Vite dev server (it imports /src/models/MaterialOwnership.ts).
 * Usage (env): AC_URL as tools/lib/game-session.ts; HOP (an optional teleport first);
 *   TELE (default: the Holtburg academy hall); THROTTLE=10; ROUNDS=6; SLICE_MS=5000;
 *   YAWS='0,90,180,270'; SPEED=0 skips the speed A/B; TAG names the output file.
 *   npx tsx tools/probe-restored-copy-ab.ts
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
const { browser, page } = await enterWorld({ gpu: true, timeoutMs: 420000, initScript: 'window.__acKeepRestoredCopies = true' });
if (HOP) { await adminCommand(page, HOP); await page.waitForTimeout(15000); }
if (TELE) await adminCommand(page, TELE);
await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 30000));
await page.mouse.click(780, 250);

const setup = await page.evaluate(`(async () => {
  const MO = await import('/src/models/MaterialOwnership.ts');
  const scene = window.__ac.sceneManager.scene;
  const swaps = []; let owned = 0; const byRoot = {};
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const rec = MO.ownedCopyState(o); if (!rec) return; owned++;
    // releaseRestoredCopies' conditions, as ObjectTranslucency.setPartTranslucency reaches it.
    let part = o; while (part && !/^part_\\d+$/.test(part.name) && part.parent && !(part.parent.isScene)) part = part.parent;
    const t = part.userData.acPartTranslucency ?? 0;
    if (t !== 0 || part.userData.acScriptPartMaterial !== undefined) return;
    const copies = Array.isArray(rec.copies) ? rec.copies : [rec.copies];
    if (copies.some((m) => m.userData.acScriptMaterial || (m.map && m.map.userData.acUvOwned))) return;
    swaps.push({ mesh: o, copies: rec.copies, originals: rec.originals });
    let root = o; while (root.parent && !root.parent.isScene) root = root.parent;
    const k = (root.name || root.type).replace(/^server_[0-9a-f]+_/, ''); byRoot[k] = (byRoot[k] || 0) + 1;
  });
  window.__abSet = (released) => { for (const s of swaps) s.mesh.material = released ? s.originals : s.copies; };
  const mats = (released) => { const set = new Set(); for (const s of swaps) for (const m of [].concat(released ? s.originals : s.copies)) set.add(m); return set.size; };
  return { ownedMeshes: owned, releasable: swaps.length, materialsWithCopies: mats(false), materialsReleased: mats(true), byRoot };
})()`);
console.log('SETUP', JSON.stringify(setup));

const pixels = await pixelAB(page, YAWS);
const speed = SPEED ? await speedAB(page, { throttle: THROTTLE, rounds: ROUNDS, sliceMs: SLICE_MS, labels: ['copies', 'released'] }) : null;
if (speed) console.log('SPEED', JSON.stringify(speed, null, 1));
await page.evaluate('window.__abSet(false)');
await browser.close();
mkdirSync(resolve(REPO, 'verification/perf'), { recursive: true });
const file = resolve(REPO, `verification/perf/restored-copy-ab-${new Date().toISOString().replace(/[:.]/g, '-')}-${TAG}.json`);
writeFileSync(file, JSON.stringify({ hop: HOP, tele: TELE, throttle: THROTTLE, rounds: ROUNDS, sliceMs: SLICE_MS, setup, pixels, speed }, null, 1) + '\n');
console.log('wrote', file);
