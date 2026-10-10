/**
 * CORE.14.b.1 — same-session A/B probe: does the doorway-gate rule change
 * JS-side renderer.render() cost? Alternates gating OFF/ON in interleaved
 * blocks at parked Holtburg and prints per-block renderJs p50 — isolates
 * the change from run-to-run SwiftShader/weather variance that clouds
 * cross-run measure-perf comparisons.
 */
import { chromium, type Page } from 'playwright';
import { existsSync } from 'node:fs';

const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=abprobe';

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const dbg = window.acDebug; const cs = dbg && dbg.collisionState && dbg.collisionState();
    return !!(cs && cs.x > 0);
  })()`) as Promise<boolean>;
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  page.setDefaultTimeout(120000);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 300_000;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (Date.now() - lastReload > 60_000) {
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await browser.close(); throw new Error('never entered world'); }
  await page.waitForTimeout(10_000);
  await page.evaluate(`window.acDebug.setTimeOfDay(0.5)`);
  await page.evaluate(`window.acDebug.setPlayerYaw(${(4 * Math.PI) / 3})`); // town-facing

  await page.evaluate(`(() => {
    const r = window.__ac.sceneManager.renderer;
    if (r.__perfPatched) return;
    const orig = r.render.bind(r);
    window.__perfRenderMs = [];
    r.render = function (a, b) { const t = performance.now(); const out = orig(a, b); window.__perfRenderMs.push(performance.now() - t); return out; };
    r.__perfPatched = true;
  })()`);

  const FRAMES = 8;
  const results: { gating: boolean; p50: number; n: number; drawCalls: number }[] = [];
  for (let block = 0; block < 6; block++) {
    const gating = block % 2 === 1; // OFF, ON, OFF, ON, OFF, ON
    await page.evaluate(`window.acDebug.setPortalGating(${gating})`);
    // settle 2 frames, then measure FRAMES frames
    await page.evaluate(`new Promise(res => { let n=2; const t=()=>{ if(--n<=0) res(0); else requestAnimationFrame(t); }; requestAnimationFrame(t); })`);
    await page.evaluate(`window.__perfRenderMs = []`);
    await page.evaluate(`new Promise(res => { let n=${FRAMES}; const t=()=>{ if(--n<=0) res(0); else requestAnimationFrame(t); }; requestAnimationFrame(t); })`);
    const r = await page.evaluate(`(() => {
      const a = window.__perfRenderMs.slice(); window.__perfRenderMs = [];
      a.sort((x,y)=>x-y);
      return { p50: a[Math.floor(a.length/2)] || 0, n: a.length,
               drawCalls: window.__ac.sceneManager.renderer.info.render.calls };
    })()`) as { p50: number; n: number; drawCalls: number };
    results.push({ gating, ...r });
    console.log(`[ab] block${block} gating=${gating ? 'ON ' : 'OFF'} renderJs p50=${r.p50.toFixed(1)}ms n=${r.n} drawCalls=${r.drawCalls}`);
  }
  await page.evaluate(`window.acDebug.setPortalGating(true)`);
  const med = (g: boolean) => {
    const v = results.filter(x => x.gating === g).map(x => x.p50).sort((a, b) => a - b);
    return v[Math.floor(v.length / 2)];
  };
  console.log(`\n[ab] median-of-blocks renderJs p50: OFF=${med(false).toFixed(1)}ms ON=${med(true).toFixed(1)}ms`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
