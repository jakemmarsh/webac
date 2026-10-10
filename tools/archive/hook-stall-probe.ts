/**
 * hook-stall-probe — SOUND.hook-stall-burst live check (one-off).
 * Enters the world at a POI, counts the animation hooks each
 * ServerObjectManager.updateAnimations call fires (the CSequence hooks:
 * footsteps, swings, particle hooks) over a baseline window, then blocks
 * the page's main thread for --stall-ms (a real rAF gap, as a backgrounded
 * tab or a long load gives) and records the hooks the frame after it fired.
 * Retail's update_object skips a step over HUGE_QUANTUM (2 s): that frame
 * should fire none, and hooks should resume on the following frames.
 * Usage: npx tsx tools/archive/hook-stall-probe.ts [--poi Holtburg] [--stall-ms 5000] [--base-ms 10000]
 * Writes verification/audio/hook-stall-<utc>.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO, enterWorld, telepoi } from '../lib/game-session.ts';

const args = process.argv.slice(2);
const arg = (k: string, d: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const POI = arg('--poi', 'Holtburg');
const STALL_MS = Number(arg('--stall-ms', '5000'));
const BASE_MS = Number(arg('--base-ms', '10000'));

const { browser, page } = await enterWorld({ settleMs: 3000 });
await telepoi(page, POI);
await page.waitForTimeout(5000);
await page.evaluate(`(() => {
  const som = window.__ac.serverObjectManager;
  const rec = window.__stall = { phase: 'base', calls: [] };
  let hooks = 0;
  const onHook = som.onAnimationHook;
  som.onAnimationHook = (g, h, a) => { hooks++; return onHook && onHook(g, h, a); };
  const upd = som.updateAnimations.bind(som);
  som.updateAnimations = (dt) => { hooks = 0; upd(dt); rec.calls.push({ phase: rec.phase, dt, hooks }); };
})()`);
await page.waitForTimeout(BASE_MS);
await page.evaluate(`(() => { window.__stall.phase = 'stall'; const t = performance.now(); while (performance.now() - t < ${STALL_MS}) {} })()`);
await page.waitForTimeout(300);
await page.evaluate(`window.__stall.phase = 'after'`);
await page.waitForTimeout(3000);
const rec = JSON.parse(await page.evaluate('JSON.stringify(window.__stall)') as string) as { calls: Array<{ phase: string; dt: number; hooks: number }> };
const animated = await page.evaluate('window.__ac.serverObjectManager.animatedObjects ? window.__ac.serverObjectManager.animatedObjects.size : -1');
await page.screenshot({ path: resolve(REPO, 'verification/audio/hook-stall-after.png') });
await browser.close();

const base = rec.calls.filter((c) => c.phase === 'base');
const stallFrame = rec.calls.find((c) => c.phase === 'stall' && c.dt > 2) ?? null;
const after = rec.calls.filter((c) => c.phase !== 'base' && c !== stallFrame);
const sum = (a: typeof base) => a.reduce((s, c) => s + c.hooks, 0);
const summary = {
  poi: POI, animatedEntities: animated, stallMs: STALL_MS,
  base: { frames: base.length, seconds: +(base.reduce((s, c) => s + c.dt, 0)).toFixed(2), hooks: sum(base), maxHooksPerFrame: Math.max(0, ...base.map((c) => c.hooks)) },
  stallFrame,
  after: { frames: after.length, seconds: +(after.reduce((s, c) => s + c.dt, 0)).toFixed(2), hooks: sum(after), maxHooksPerFrame: Math.max(0, ...after.map((c) => c.hooks)) },
};
console.log(JSON.stringify(summary, null, 1));
const dir = resolve(REPO, 'verification/audio');
mkdirSync(dir, { recursive: true });
const out = resolve(dir, `hook-stall-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify({ summary, calls: rec.calls }, null, 1));
console.log('wrote', out);
