/**
 * verify-core5bc-floaty-windows — live verification for CORE.5.b.c:
 * floaty vitals cluster / indicator strip / radar drag + resize +
 * persistence against the running ACE stack.
 *
 * Flow: log in → capture default HUD → drag the vitals cluster (top drag
 * strip) + widen it (right resize handle) → drag the indicator strip +
 * radar → capture → reload → assert every window restored its persisted
 * geometry → toggle Lock UI via the radar padlock → assert border swap →
 * capture. Screenshots land in verification/screens/core5bc/.
 *
 * Usage: npx tsx tools/verify-core5bc-floaty-windows.ts
 * Requires: vite dev server (:3000), ws-tcp-bridge (:9090), ACE docker stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const OUT = join(__dir, '..', 'verification', 'screens', 'core5bc');
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core5bc';
const VIEW = { width: 1568, height: 775 };

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function waitInWorld(page: Page, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) return;
    if (Date.now() - lastReload > 60_000) {
      console.log('[core5bc] not in world yet — reloading (phantom-session retry)');
      await page.reload({ waitUntil: 'domcontentloaded' });
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  await page.screenshot({ path: join(OUT, '_login-failed.png') });
  throw new Error('never entered world — see _login-failed.png');
}

interface Rect { x: number; y: number; width: number; height: number }
async function rectOf(page: Page, sel: string): Promise<Rect> {
  const box = await page.locator(sel).boundingBox();
  if (!box) throw new Error(`no bounding box for ${sel}`);
  return box;
}

async function styleOf(page: Page, sel: string): Promise<{ left: string; top: string; width: string; height: string; right: string }> {
  return page.evaluate((s) => {
    const el = document.querySelector(s) as HTMLElement;
    return { left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height, right: el.style.right };
  }, sel);
}

async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

/**
 * Reset the floaty-window geometry to defaults: clear the localStorage
 * stand-in AND flush a cleared GameplayOptions blob to ACE (the server echo
 * from a prior run's pagehide flush would otherwise restore moved windows
 * on the next login).
 */
async function resetFloatyGeometry(page: Page): Promise<void> {
  // Unlock the UI first if a prior run left LockUI ON (the padlock click
  // persists CharacterOptions2 server-side).
  const locked = await page.evaluate(() =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__ac?.gameUI?.optionsSettings?.lockUI === true);
  if (locked) {
    await page.locator('#radar-lock-button').click();
    await page.waitForTimeout(300);
  }
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('ac_floaty_windows_v1')) localStorage.removeItem(k);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui = (window as any).__ac?.gameUI;
    if (ui) {
      ui.floatyWindowGeometry?.clear?.();
      if (ui.serverChatOptions?.chatWindows) {
        for (const id of [11, 12, 14, 17]) ui.serverChatOptions.chatWindows.delete(id);
      }
      ui.markChatOptionsDirty?.();
      ui.flushChatOptionsSave?.();
    }
  });
  await page.waitForTimeout(1000);
}

async function run(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());
  page.on('pageerror', (err) => console.log(`  [pageerror] ${String(err).slice(0, 200)}`));

  console.log(`[core5bc] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await waitInWorld(page, 360_000);
  console.log('[core5bc] in world');
  await page.waitForTimeout(6000);

  // A prior run may have left server-persisted geometry — reset and reload
  // so the default-position checks start clean.
  await resetFloatyGeometry(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitInWorld(page, 360_000);
  await page.waitForTimeout(6000);

  const fails: string[] = [];
  const check = (name: string, cond: boolean, detail: string) => {
    console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
    if (!cond) fails.push(`${name}: ${detail}`);
  };

  // ── 1. Defaults ──
  const vitals0 = await styleOf(page, '#hud-vitals');
  check('default vitals top-center', vitals0.top === '0px' && vitals0.left === '704px' && vitals0.width === '160px',
    `left=${vitals0.left} top=${vitals0.top} w=${vitals0.width} (expect 704px/0px/160px at 1568w)`);
  const ind0 = await styleOf(page, '#hud-indicators');
  check('default indicators top-left', ind0.left === '0px' && ind0.top === '0px', `left=${ind0.left} top=${ind0.top}`);
  await page.screenshot({ path: join(OUT, '1-default-hud.png') });

  // ── 2. Drag vitals via the top drag strip (0x1000063c, 5px tall) ──
  const vr = await rectOf(page, '#hud-vitals');
  await drag(page, [vr.x + 80, vr.y + 2], [vr.x + 80 - 300, vr.y + 2 + 120]);
  let vs = await styleOf(page, '#hud-vitals');
  check('vitals dragged', vs.left === '404px' && vs.top === '120px', `left=${vs.left} top=${vs.top} (expect 404px/120px)`);

  // ── 3. Resize vitals via the right edge handle (0x10000642, 5px wide) ──
  const vr2 = await rectOf(page, '#hud-vitals');
  await drag(page, [vr2.x + vr2.width - 2, vr2.y + 30], [vr2.x + vr2.width - 2 + 240, vr2.y + 30]);
  vs = await styleOf(page, '#hud-vitals');
  check('vitals widened', vs.width === '400px' && vs.height === '58px', `w=${vs.width} h=${vs.height} (expect 400px/58px)`);
  const barW = await page.evaluate(() =>
    (document.querySelector('#hud-vitals [data-element-id="0x100000e6"]') as HTMLElement)?.style.width);
  check('health bar stretched with window', barW === '390px', `bar w=${barW} (expect 390px = 150+240)`);

  // ── 4. Drag the indicator strip via its bottom border ──
  const ir = await rectOf(page, '#hud-indicators');
  await drag(page, [ir.x + 70, ir.y + ir.height - 2], [ir.x + 70 + 200, ir.y + ir.height - 2 + 300]);
  const is1 = await styleOf(page, '#hud-indicators');
  check('indicators dragged', is1.left === '200px' && is1.top === '300px', `left=${is1.left} top=${is1.top}`);

  // ── 5. Drag the radar via its drag button ──
  const rb = await rectOf(page, '#radar-drag-button');
  await drag(page, [rb.x + 13, rb.y + 13], [rb.x + 13 - 200, rb.y + 13 + 150]);
  const rs1 = await styleOf(page, '#hud-radar');
  check('radar dragged', rs1.left === '1248px' && rs1.top === '150px' && rs1.right === '',
    `left=${rs1.left} top=${rs1.top} (expect 1248px/150px — 1448-200/0+150)`);
  await page.screenshot({ path: join(OUT, '2-dragged-resized.png') });

  // localStorage persisted?
  const stored = await page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith('ac_floaty_windows_v1'));
    return keys.map((k) => `${k}=${localStorage.getItem(k)}`).join('; ');
  });
  check('localStorage persisted', /"11":/.test(stored) && /"12":/.test(stored) && /"14":/.test(stored), stored.slice(0, 300));

  // ── 6. Reload → geometry restored ──
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitInWorld(page, 360_000);
  await page.waitForTimeout(6000);
  const vsr = await styleOf(page, '#hud-vitals');
  check('vitals restored after reload', vsr.left === '404px' && vsr.top === '120px' && vsr.width === '400px',
    `left=${vsr.left} top=${vsr.top} w=${vsr.width}`);
  const isr = await styleOf(page, '#hud-indicators');
  check('indicators restored', isr.left === '200px' && isr.top === '300px', `left=${isr.left} top=${isr.top}`);
  const rsr = await styleOf(page, '#hud-radar');
  check('radar restored', rsr.left === '1248px' && rsr.top === '150px', `left=${rsr.left} top=${rsr.top}`);
  await page.screenshot({ path: join(OUT, '3-restored-after-reload.png') });

  // ── 7. Lock UI via the radar padlock → border swap ──
  await page.locator('#radar-lock-button').click();
  await page.waitForTimeout(300);
  // (single-expression evaluate — esbuild's __name helper injection breaks
  // page.evaluate callbacks that declare inner named consts under tsx)
  const lockState = await page.evaluate(
    (sels) => sels.map((s) => (document.querySelector(s) as HTMLElement | null)?.style.display),
    [
      '#hud-vitals [data-element-id="0x1000063c"]',
      '#hud-vitals [data-element-id="0x10000642"]',
      '#hud-vitals [data-element-id="0x10000634"]',
      '#hud-indicators [data-element-id="0x10000650"]',
      '#hud-indicators [data-element-id="0x10000644"]',
      '#radar-drag-button',
    ],
  ).then(([dragStrip, resizeHandle, lockedArt, indDrag, indLockedArt, radarDragBtn]) => ({
    dragStrip, resizeHandle, lockedArt, indDrag, indLockedArt, radarDragBtn,
  }));
  check('lock hides interactive borders',
    lockState.dragStrip === 'none' && lockState.resizeHandle === 'none' && lockState.indDrag === 'none'
    && lockState.radarDragBtn === 'none',
    JSON.stringify(lockState));
  check('lock shows locked border art', lockState.lockedArt === '' && lockState.indLockedArt === '', JSON.stringify(lockState));
  await page.screenshot({ path: join(OUT, '4-locked.png') });
  // Unlock again (leave the account in the default state).
  await page.locator('#radar-lock-button').click();
  await page.waitForTimeout(300);

  // ── 8. Reset geometry to defaults for future runs ──
  await resetFloatyGeometry(page);

  await browser.close();
  console.log(fails.length === 0 ? '\n[core5bc] ALL CHECKS PASSED' : `\n[core5bc] ${fails.length} FAILURES:\n- ${fails.join('\n- ')}`);
  process.exit(fails.length === 0 ? 0 : 1);
}

run().catch((err) => { console.error(err); process.exit(1); });
