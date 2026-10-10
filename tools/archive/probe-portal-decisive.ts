/**
 * probe-portal-decisive — follow-up to playtest-magic-portal: decisive tests for
 * (a) the Components tab capture (via the data-magic-tab harness hook),
 * (b) portal walk-in collision: teleport ONTO the portal position + small moves,
 * (c) close-range dblclick-Use (range discriminator for the distant-use no-op).
 * Output: appends into verification/playtest/<utc>-portal-probe/.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=probe4';
const VIEW = { width: 1568, height: 775 };
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-portal-probe`);

const PORTAL = { cell: '0xA9B40000', x: 27.325, y: 137.487, z: 66.5 };

const steps: Array<Record<string, unknown>> = [];
const chatLog: string[] = [];
let phase = 'boot';

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as any).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function collision(page: Page): Promise<Record<string, number>> {
  return page.evaluate(`window.acDebug.collisionState()`) as Promise<Record<string, number>>;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`[shot] ${name}`);
}

async function talk(page: Page, text: string): Promise<void> {
  await page.evaluate(`window.acDebug.sendTalk(${JSON.stringify(text)})`);
  console.log(`[talk] ${text}`);
}

async function screenPos(page: Page, guid: number, yOff = 1.0): Promise<{ x: number; y: number; behind: boolean } | null> {
  return page.evaluate(`(() => {
    const objs = window.acDebug.getObjects();
    const o = objs.find(o => o.guid === ${guid});
    if (!o || !o.pos) return null;
    const sm = window.__ac.sceneManager;
    const cam = sm.camera;
    const rect = sm.renderer.domElement.getBoundingClientRect();
    const v = o.pos.clone(); v.y += ${yOff};
    v.project(cam);
    return { x: rect.left + (v.x + 1) / 2 * rect.width, y: rect.top + (1 - v.y) / 2 * rect.height, behind: v.z > 1 };
  })()`) as Promise<{ x: number; y: number; behind: boolean } | null>;
}

async function portalObj(page: Page): Promise<{ guid: number; name: string; dist: number } | null> {
  return page.evaluate(`(() => {
    const me = window.acDebug.collisionState();
    const o = window.acDebug.getObjects().find(o => o.pos && /Portal to Redspire/.test(o.name || ''));
    if (!o) return null;
    return { guid: o.guid, name: o.name, dist: Math.hypot(o.pos.x - me.x, o.pos.z - me.z) };
  })()`) as any;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  page.on('console', (m) => { const t = m.text(); if (/\[AC\]|\[Chat\]/.test(t)) chatLog.push(`${phase}| ${t.slice(0, 250)}`); });

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
  phase = 'settle';
  await page.waitForTimeout(8000);

  // ── (a) Components tab via the data-magic-tab hook ──
  phase = 'components';
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(2500);
  const compClick = await page.evaluate(`(() => {
    const el = document.querySelector('[data-magic-tab="components"]');
    if (!el) return 'no-hook-el';
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'clicked';
  })()`);
  await page.waitForTimeout(2500);
  steps.push({ step: 'components-tab', compClick });
  console.log(`[probe] components tab: ${compClick}`);
  await shot(page, '01-components-tab');
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(1000);

  // ── (b) walk-in collision: teleport ONTO the portal, then nudge ──
  phase = 'portal-standin';
  await page.evaluate(`window.acDebug.tele('${PORTAL.cell}', ${PORTAL.x}, ${PORTAL.y}, ${PORTAL.z})`);
  await page.waitForTimeout(10_000);
  const c0 = await collision(page);
  const p0 = await portalObj(page);
  steps.push({ step: 'stand-in-portal', collision: c0, portal: p0 });
  console.log(`[probe] standing at portal: dist=${p0 ? p0.dist.toFixed(2) : 'n/a'} pos=(${c0.x?.toFixed(1)},${c0.z?.toFixed(1)})`);
  await shot(page, '02-stand-in-portal');
  const jumped = (a: Record<string, number>, b: Record<string, number>) =>
    Math.hypot((b.x ?? 0) - (a.x ?? 0), (b.z ?? 0) - (a.z ?? 0)) > 1000;
  let arrived = false; let via = 'none';
  // small nudges: forward taps in 4 directions to generate autonomous position
  // updates crossing the portal cylinder
  for (const key of ['KeyW', 'KeyS', 'KeyW', 'KeyS']) {
    await page.keyboard.down(key);
    await page.waitForTimeout(500);
    await page.keyboard.up(key);
    await page.waitForTimeout(4000);
    const c = await collision(page);
    const p = await portalObj(page);
    console.log(`[probe] nudge ${key}: pos=(${c.x?.toFixed(1)},${c.z?.toFixed(1)}) portalDist=${p ? p.dist.toFixed(2) : 'gone'}`);
    if (jumped(c0, c)) { arrived = true; via = 'walk-in-collision'; break; }
  }
  steps.push({ step: 'nudge-result', arrived, via, collision: await collision(page) });
  await shot(page, '03-after-nudges');

  // ── (c) close-range dblclick-Use ──
  if (!arrived) {
    phase = 'portal-dblclick-close';
    const p = await portalObj(page);
    if (p) {
      // back off ~2m so the portal projects on screen, then dblclick it
      await page.keyboard.down('KeyS');
      await page.waitForTimeout(700);
      await page.keyboard.up('KeyS');
      await page.waitForTimeout(3000);
      const cPre = await collision(page);
      const pPre = await portalObj(page);
      let sp = null;
      for (const yOff of [1.2, 0.8, 1.6, 0.4]) {
        sp = await screenPos(page, p.guid, yOff);
        if (sp && !sp.behind && sp.x > 10 && sp.x < VIEW.width - 10 && sp.y > 40 && sp.y < VIEW.height - 10) break;
        sp = null;
      }
      steps.push({ step: 'dblclick-close-setup', dist: pPre?.dist, screenPos: sp });
      console.log(`[probe] dblclick setup: dist=${pPre?.dist.toFixed(2)} sp=${JSON.stringify(sp)}`);
      if (sp) {
        await page.mouse.dblclick(sp.x, sp.y);
        for (let i = 0; i < 10 && !arrived; i++) {
          await page.waitForTimeout(3000);
          const c = await collision(page);
          if (jumped(cPre, c)) { arrived = true; via = 'dblclick-use-close'; }
        }
      }
      await shot(page, '04-after-close-dblclick');
    }
  }
  const cEnd = await collision(page);
  steps.push({ step: 'final', arrived, via, collision: cEnd });
  console.log(`[probe] FINAL: arrived=${arrived} via=${via} pos=(${cEnd.x?.toFixed(1)},${cEnd.z?.toFixed(1)})`);
  await page.waitForTimeout(10_000);
  await shot(page, '05-final');

  await browser.close();
  writeFileSync(join(OUT, 'observations.json'), JSON.stringify({ utc: UTC, steps, chatLog: chatLog.slice(-150) }, null, 2));
  console.log(`[probe] done — wrote ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
