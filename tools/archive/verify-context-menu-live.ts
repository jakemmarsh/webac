/**
 * verify-context-menu-live — targeted live verification for
 * BUG.world-context-menu-never-renders.
 *
 * Repro of the 2026-08-20 discovery observation, post-fix: enter world,
 * teleport into the Holtburg blacksmith interior, right-click the vendor via
 * real mousedown/mouseup on the canvas, and assert the world context menu
 * element actually lands in document.body (the exact observable the
 * discovery MutationObserver proved missing), then click Buy/Sell and assert
 * the vendor panel opens. Screenshots to verification/playtest/<utc>-ctxmenu/.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=ctxmenu1';
const VIEW = { width: 1568, height: 775 };
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-ctxmenu`);

const steps: Array<Record<string, unknown>> = [];

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dbg = (window as any).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function driveCharacterCreate(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = 'Perf Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`[shot] ${name}`);
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
    return {
      x: rect.left + (v.x + 1) / 2 * rect.width,
      y: rect.top + (1 - v.y) / 2 * rect.height,
      behind: v.z > 1,
    };
  })()`) as Promise<{ x: number; y: number; behind: boolean } | null>;
}

async function faceObject(page: Page, guid: number): Promise<void> {
  for (let i = 0; i < 24; i++) {
    const sp = await screenPos(page, guid);
    if (sp && !sp.behind && sp.x > 20 && sp.x < VIEW.width - 20 && sp.y > 40 && sp.y < VIEW.height - 20) return;
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(350);
    await page.keyboard.up('ArrowLeft');
    await page.waitForTimeout(250);
  }
}

interface MenuState { items: string[]; firstItem: { x: number; y: number } }

/** Right-click via real canvas mousedown/mouseup, probing aim offsets. */
async function rightClickMenu(page: Page, guid: number): Promise<MenuState | null> {
  for (const yOff of [1.0, 0.6, 1.4, 0.2, 1.8]) {
    const sp = await screenPos(page, guid, yOff);
    if (!sp || sp.behind) continue;
    for (const dx of [0, -18, 18]) {
      const x = sp.x + dx, y = sp.y;
      if (x < 5 || x > VIEW.width - 5 || y < 40 || y > VIEW.height - 5) continue;
      await page.evaluate(`(() => {
        const c = window.__ac.sceneManager.renderer.domElement;
        const opts = { bubbles: true, cancelable: true, button: 2, clientX: ${x}, clientY: ${y} };
        c.dispatchEvent(new MouseEvent('mousedown', opts));
        c.dispatchEvent(new MouseEvent('mouseup', opts));
      })()`);
      await page.waitForTimeout(400);
      const found = await page.evaluate(`(() => {
        const menus = [...document.querySelectorAll('div')].filter(d => d.style.position === 'fixed' && d.style.minWidth === '120px');
        if (!menus.length) return null;
        const menu = menus[menus.length - 1];
        const items = [...menu.children];
        const r = items[0]?.getBoundingClientRect();
        if (!r) return null;
        return {
          items: items.map(i => i.textContent || '[bitmap]'),
          firstItem: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
        };
      })()`) as MenuState | null;
      if (found) return found;
    }
  }
  return null;
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

  console.log(`[verify] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[verify] create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[verify] reload (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep looping */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await shot(page, '00-never-entered'); await browser.close(); throw new Error('never entered world'); }
  await page.waitForTimeout(10_000);

  // Teleport into Holtburg blacksmith interior (same cell as the discovery repro).
  await page.evaluate(`window.acDebug.tele('0xA9B40100', 84, 127, 66.005)`);
  await page.waitForTimeout(10_000);
  await shot(page, '01-blacksmith-interior');

  const vendor = await page.evaluate(`(() => {
    const me = window.acDebug.collisionState();
    return window.acDebug.getObjects()
      .filter(o => o.pos && o.name && /blacksmith|smith|armorer/i.test(o.name))
      .map(o => ({ guid: o.guid, name: o.name,
        dist: Math.hypot(o.pos.x - me.x, o.pos.z - me.z) }))
      .sort((a, b) => a.dist - b.dist)[0] || null;
  })()`) as { guid: number; name: string; dist: number } | null;
  if (!vendor) { await browser.close(); throw new Error('no vendor found in blacksmith interior'); }
  console.log(`[verify] vendor: ${vendor.name} 0x${vendor.guid.toString(16)} @${vendor.dist.toFixed(1)}m`);

  await faceObject(page, vendor.guid);
  const menu = await rightClickMenu(page, vendor.guid);
  await shot(page, '02-context-menu');
  steps.push({ step: 'context-menu', vendor, menu });
  if (!menu) { writeFileSync(join(OUT, 'observations.json'), JSON.stringify(steps, null, 2)); await browser.close(); throw new Error('FAIL: context menu did not render'); }
  console.log(`[verify] MENU RENDERED: ${menu.items.length} items`);

  // Click the first verb (Buy/Sell for a vendor) and assert the vendor panel opens.
  await page.mouse.click(menu.firstItem.x, menu.firstItem.y);
  let vendorOpen = false;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1000);
    vendorOpen = (await page.evaluate(`!!window.__ac.gameUI.vendorVisible`)) as boolean;
    if (vendorOpen) break;
  }
  await shot(page, '03-after-buysell-click');
  steps.push({ step: 'buysell-click', vendorOpen });
  console.log(`[verify] vendor panel open: ${vendorOpen}`);

  writeFileSync(join(OUT, 'observations.json'), JSON.stringify(steps, null, 2));
  await browser.close();
  if (!vendorOpen) throw new Error('FAIL: Buy/Sell click did not open vendor panel');
  console.log(`[verify] PASS — evidence in ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
