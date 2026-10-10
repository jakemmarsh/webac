/**
 * CORE.18.c — our side of the retail open-container frame
 * (verification/retail-client/ab/retail-container-open.png): the retail
 * session's steps at 1600x900 (@telepoi holtburg, @create 143 Chest,
 * @teleloc 4 m south, select the chest, Use), then the whole screen and the
 * strip crop, and a side-by-side strip (retail above, ours below).
 *
 *   npx tsx tools/capture-core18c-container-strip.ts
 */
import { chromium, type Page } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core18c');
const RETAIL = join(REPO, 'verification', 'retail-client', 'ab', 'retail-container-open.png');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_BASE ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090';
const URL_A = `${BASE}&account=testacjs&password=testacjs`;
const VIEW = { width: 1600, height: 900 };
const HEADING = '0.9969 0 0 -0.0785';
const TAG = '[core18c]';
/** The dock strip in both 1600x900 frames: x 495..1105, y 700..820. */
const STRIP = { x: 495, y: 700, w: 612, h: 122 };

const ev = <T>(page: Page, src: string): Promise<T> => page.evaluate(src) as Promise<T>;
const admin = (p: Page, cmd: string) => ev(p, `window.acDebug.admin(${JSON.stringify(cmd)})`);

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await (await browser.newContext({ viewport: VIEW })).newPage();
  await page.addInitScript('window.__name = (f) => f;');
  page.on('dialog', (d) => void d.dismiss());
  await page.goto(`${URL_A}&cb=core18c`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const deadline = Date.now() + 420_000; let lastReload = Date.now();
  while (!(await ev<boolean>(page, `(() => { const cs = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(cs && cs.x > 0); })()`))) {
    if (Date.now() > deadline) { await page.screenshot({ path: join(OUT, '_login-failed.png') }); throw new Error('never entered world'); }
    if (Date.now() - lastReload > 90_000) { await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now(); }
    await page.waitForTimeout(3000);
  }
  console.log(`${TAG} in world`);
  await page.waitForTimeout(4000);
  await admin(page, '@telepoi holtburg');
  await page.waitForTimeout(12_000);
  await admin(page, '@create 143');
  await page.waitForTimeout(2500);
  await admin(page, `@teleloc 0xA9B40019 84.3 5.0 94 ${HEADING}`);
  await page.waitForTimeout(10_000);
  const chest = await ev<number | null>(page, `(() => { const o = (window.acDebug.getObjects() || []).filter((x) => x.name === 'Chest').map((x) => x.guid); return o.length ? Math.max(...o) : null; })()`);
  if (!chest) throw new Error('no chest');
  await ev(page, `window.acDebug.select(${chest})`);
  await page.waitForTimeout(1000);
  for (let attempt = 0; attempt < 3; attempt++) {
    await ev(page, `window.acDebug.useObject(${chest})`);
    const end = Date.now() + 12_000;
    while (Date.now() < end && !(await ev<boolean>(page, `!!window.__ac.gameUI.containerPanel`).catch(() => false))) await page.waitForTimeout(500);
    if (await ev<boolean>(page, `!!window.__ac.gameUI.containerPanel`)) break;
  }
  await page.waitForTimeout(3000);
  const state = await ev<Record<string, unknown>>(page, `(() => {
    const ui = window.__ac.gameUI; const p = ui.containerPanel;
    return {
      chest: ${chest},
      nestedListCapacity: ui.containerNestedListCapacity,
      nestedEmptyCells: p ? p.querySelectorAll('[data-ac-container-pack-empty]').length : -1,
      nestedPackCells: p ? p.querySelectorAll('[data-element-id="0x10000067"] [data-ac-container-tab]').length : -1,
      rowCells: p ? p.querySelectorAll('[data-ac-container-cell]').length : -1,
      ants: p ? p.querySelectorAll('[data-slot-state="selected"]').length : -1,
      selected: ui.hudState.target ? ui.hudState.target.id : 0,
    };
  })()`);
  console.log(TAG, JSON.stringify(state));
  writeFileSync(join(OUT, 'core18c-state.json'), JSON.stringify(state, null, 2));
  await page.screenshot({ path: join(OUT, 'ours-container-open.png') });
  await page.screenshot({ path: join(OUT, 'ours-strip.png'), clip: { x: STRIP.x, y: STRIP.y, width: STRIP.w, height: STRIP.h } });

  // Side-by-side: retail strip over ours, 2x nearest-neighbour.
  const retail = readFileSync(RETAIL).toString('base64');
  const ours = readFileSync(join(OUT, 'ours-container-open.png')).toString('base64');
  const sbs = await page.evaluate(async ({ retail, ours, S }) => {
    const load = async (b64: string) => { const i = new Image(); i.src = 'data:image/png;base64,' + b64; await i.decode(); return i; };
    const [a, b] = [await load(retail), await load(ours)];
    const K = 2, LBL = 22;
    const c = document.createElement('canvas'); c.width = S.w * K; c.height = (S.h * K + LBL) * 2;
    const g = c.getContext('2d')!; g.imageSmoothingEnabled = false; g.fillStyle = '#111'; g.fillRect(0, 0, c.width, c.height);
    g.font = '16px sans-serif'; g.fillStyle = '#fff';
    g.fillText('RETAIL (real client, ACE, @create 143 Chest, Use)', 6, 16);
    g.drawImage(a, S.x, S.y, S.w, S.h, 0, LBL, S.w * K, S.h * K);
    g.fillText('OURS (CORE.18.c)', 6, S.h * K + LBL + 16);
    g.drawImage(b, S.x, S.y, S.w, S.h, 0, S.h * K + LBL * 2, S.w * K, S.h * K);
    return c.toDataURL('image/png');
  }, { retail, ours, S: STRIP });
  writeFileSync(join(OUT, 'core18c-container-sidebyside.png'), Buffer.from(sbs.split(',')[1], 'base64'));
  console.log(`${TAG} wrote ${OUT}`);
  await browser.close();
}

main().catch((e) => { console.error(TAG, e); process.exit(1); });
