/**
 * probe-particle-load — evidence probe for the 2026-08-21 perf-pass anomaly
 * (idle avgFps 1.4 vs 2.7 baseline on identical SwiftShader renderer).
 *
 * Hypothesis under test: the portal-vortex change (ca3599f) gave endless
 * emitters Infinity maxAge; if ambient interior emitters (fires, torches)
 * classify as endless, particle systems now accumulate forever and the
 * software rasterizer pays for them every frame.
 *
 * Reports: active particle-system count + per-system particle counts +
 * scene Points objects, sampled at 15s and 45s after world entry.
 */
import { chromium, type Page } from 'playwright';
import { existsSync } from 'node:fs';

const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=pprobe';
const VIEW = { width: 1568, height: 775 };

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as any).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function sample(page: Page, label: string): Promise<void> {
  const r = await page.evaluate(`(() => {
    const sm = window.__ac.sceneManager;
    const fx = window.__ac.spellEffects || window.__ac.sceneManager?.spellEffects;
    let pointsObjs = 0, pointsTotal = 0;
    sm.scene.traverse(o => { if (o.name?.startsWith('particles_')) pointsObjs++; if (o.isInstancedMesh && o.name?.startsWith('particle_gfx')) pointsTotal += o.count; });
    const aps = fx ? (fx.activeParticleSystems || []).map(ps => ({
      maxAge: ps.maxAge, age: Math.round(ps.age * 10) / 10,
      count: ps.system?.particleCount ?? ps.system?.count ?? '?',
    })) : 'no-fx-accessor';
    return { pointsObjs, pointsTotal, activeCount: fx?.activeEffectCount?.() ?? '?', systems: aps };
  })()`);
  console.log(`[probe:${label}]`, JSON.stringify(r));
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline && !(await inWorld(page))) await page.waitForTimeout(3000);
  if (!(await inWorld(page))) { await browser.close(); throw new Error('never entered world'); }
  console.log('[probe] in world');
  await page.waitForTimeout(15_000);
  await sample(page, 't+15s');
  await page.waitForTimeout(30_000);
  await sample(page, 't+45s');
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
