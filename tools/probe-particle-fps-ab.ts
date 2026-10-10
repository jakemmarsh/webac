/**
 * probe-particle-fps-ab — causal A/B for the 2026-08-21 perf anomaly:
 * measure fps with ambient particle Points visible vs hidden, same session,
 * same SwiftShader renderer. If hiding them recovers the ~2.7fps baseline,
 * the ca3599f ambient endless-emitter cost is the regression source.
 */
import { chromium, type Page } from 'playwright';
import { existsSync } from 'node:fs';

const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=pab';
const VIEW = { width: 1568, height: 775 };

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as any).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function fps(page: Page, secs: number): Promise<{ frames: number; avgFps: number; p50Ms: number }> {
  return page.evaluate(`(async () => {
    const times = [];
    let last = performance.now();
    const end = last + ${secs * 1000};
    await new Promise(res => {
      const tick = () => {
        const now = performance.now();
        times.push(now - last); last = now;
        if (now < end) requestAnimationFrame(tick); else res(null);
      };
      requestAnimationFrame(tick);
    });
    times.sort((a, b) => a - b);
    const total = times.reduce((s, t) => s + t, 0);
    return { frames: times.length, avgFps: Math.round(times.length / (total / 1000) * 10) / 10,
      p50Ms: Math.round(times[Math.floor(times.length / 2)] * 10) / 10 };
  })()`) as Promise<{ frames: number; avgFps: number; p50Ms: number }>;
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
  console.log('[ab] in world, settling 15s…');
  await page.waitForTimeout(15_000);

  const withParticles = await fps(page, 12);
  console.log('[ab] WITH particles:', JSON.stringify(withParticles));

  const hidden = await page.evaluate(`(() => {
    let n = 0;
    window.__ac.sceneManager.scene.traverse(o => { if (o.name?.startsWith('particles_')) { o.visible = false; n++; } });
    return n;
  })()`);
  console.log(`[ab] hid ${hidden} particle systems`);
  const withoutParticles = await fps(page, 12);
  console.log('[ab] WITHOUT particles:', JSON.stringify(withoutParticles));

  // restore
  await page.evaluate(`window.__ac.sceneManager.scene.traverse(o => { if (o.name?.startsWith('particles_')) o.visible = true; })`);
  const restored = await fps(page, 12);
  console.log('[ab] RESTORED:', JSON.stringify(restored));
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
