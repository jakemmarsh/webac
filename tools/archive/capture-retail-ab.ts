/**
 * GAP.retail-client-reference-frames — our side of the same-viewport A/B
 * against the retail frames in verification/retail-client/ab/ (made with
 * tools/launch-retail-client.sh + xdotool on the same ACE, same character,
 * same spots). Replays the retail session's steps at 1600x900:
 *
 *   holtburg          @telepoi holtburg (the lifestone spawn)
 *   chest-closed      @create 143 (Chest) at the spawn, @teleloc 4 m south
 *   container-open    Use on the chest → the 0x21000008 strip
 *   vendor-items      @create 718 (Shopkeeper), @teleloc 3.5 m further south, Use
 *   vendor-buying / vendor-selling   the vendor's other two tabs
 *   inventory-vendor  the inventory panel over the open vendor
 *
 * Screenshots + state JSON → verification/retail-client/ab/ours-*.png.
 *
 *   npx tsx tools/capture-retail-ab.ts
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'retail-client', 'ab');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_BASE ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090';
const URL_A = `${BASE}&account=testacjs&password=testacjs`;
const VIEW = { width: 1600, height: 900 };
const TAG = '[retail-ab]';
// The retail session's heading (ACE @create audit line: w 0.996917, z -0.078459).
const HEADING = '0.9969 0 0 -0.0785';

const ev = <T>(page: Page, src: string): Promise<T> => page.evaluate(src) as Promise<T>;
const admin = (p: Page, cmd: string) => ev(p, `window.acDebug.admin(${JSON.stringify(cmd)})`);

async function inWorld(page: Page): Promise<boolean> {
  return ev<boolean>(page, `(() => { const cs = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(cs && cs.x > 0); })()`);
}

async function enterWorld(page: Page): Promise<void> {
  await page.goto(`${URL_A}&cb=retailab`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 420_000; let lastReload = Date.now();
  while (!(await inWorld(page))) {
    if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, '_login-failed.png') }); throw new Error('never entered world'); }
    if (Date.now() - lastReload > 90_000) { await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now(); }
    await page.waitForTimeout(3000);
  }
  console.log(`${TAG} in world`);
  await page.waitForTimeout(4000);
}

const findObject = (page: Page, name: string) => ev<number | null>(page, `(() => {
  const o = (window.acDebug.getObjects() || []).filter((x) => x.name === ${JSON.stringify(name)});
  return o.length ? o[o.length - 1].guid : null;
})()`);

async function shot(page: Page, name: string, settle = 3000): Promise<void> {
  await page.waitForTimeout(settle);
  await page.screenshot({ path: join(OUT, `ours-${name}.png`) });
  console.log(`${TAG} ours-${name}.png`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const A = await (await browser.newContext({ viewport: VIEW })).newPage();
  await A.addInitScript('window.__name = (f) => f;');
  A.on('dialog', (d) => void d.dismiss());
  const state: Record<string, unknown> = { at: new Date().toISOString(), viewport: VIEW };

  await enterWorld(A);
  await admin(A, '@telepoi holtburg');
  await shot(A, 'holtburg', 15_000);

  await admin(A, '@create 143');
  await A.waitForTimeout(2500);
  await admin(A, `@teleloc 0xA9B40019 84.3 5.0 94 ${HEADING}`);
  await shot(A, 'chest-closed', 10_000);
  const chest = await findObject(A, 'Chest');
  state.chest = chest;
  if (chest) {
    await ev(A, `window.acDebug.useObject(${chest})`);
    const end = Date.now() + 20_000;
    while (Date.now() < end && !(await ev<boolean>(A, `!!document.querySelector('[data-layout-id="0x21000008"]') || !!window.__ac.gameUI.containerPanelVisible`).catch(() => false))) await A.waitForTimeout(500);
    await shot(A, 'container-open', 3000);
  }
  await ev(A, `(() => { const ui = window.__ac.gameUI; if (ui.closeContainerPanelFromUi) ui.closeContainerPanelFromUi(); })()`);

  await admin(A, '@create 718');
  await A.waitForTimeout(2000);
  await admin(A, '@ci 273 5000');
  await A.waitForTimeout(2000);
  await admin(A, `@teleloc 0xA9B40019 84.3 1.5 94 ${HEADING}`);
  await shot(A, 'chest-selected', 10_000);
  const vendor = await findObject(A, 'Shopkeeper Renald the Elder');
  state.vendor = vendor;
  if (vendor) {
    await ev(A, `window.acDebug.useObject(${vendor})`);
    const end = Date.now() + 25_000;
    while (Date.now() < end && !(await ev<boolean>(A, `!!window.__ac.gameUI.isVendorVisible`))) await A.waitForTimeout(500);
    state.vendorOpened = await ev<boolean>(A, `!!window.__ac.gameUI.isVendorVisible`);
    await shot(A, 'vendor-items', 3000);
    for (const [tab, name] of [[1, 'vendor-buying'], [2, 'vendor-selling']] as const) {
      await ev(A, `(() => { const ui = window.__ac.gameUI; ui.vendorData.tab = ${tab}; ui.renderVendorPanel(); })()`);
      await shot(A, name, 1500);
    }
    await ev(A, `(() => { const ui = window.__ac.gameUI; if (!ui.inventoryVisible) ui.toggleInventory(); })()`);
    await shot(A, 'inventory-vendor', 3000);
  }
  writeFileSync(join(OUT, 'ours-state.json'), JSON.stringify(state, null, 2));
  await browser.close();
}

main().catch((e) => { console.error(TAG, e); process.exit(1); });
