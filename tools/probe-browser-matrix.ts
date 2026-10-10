/**
 * Play the deployed site in Firefox and WebKit (Safari's engine) the way a
 * player does: the launcher's Account / Password fields and ENTER by mouse,
 * the first character on the list, ENTER, then the inventory. Records the
 * time to the world, page errors, console errors and a screenshot per beat.
 * RELEASE.browser-matrix's re-run (docs/verification-workflows.md).
 *
 *   AC_ACCOUNT=<acct> AC_PASSWORD=<pw> npx tsx tools/probe-browser-matrix.ts \
 *     [--browser firefox|webkit|chromium] [--url https://playwebac.com/] \
 *     [--world Coldeve] [--out <dir>] [--headed]
 *
 * The account must already have a character on that world (one test account
 * on a public world, never several). Coordinates are the 1568x775 viewport's
 * (tools/lib/game-session.ts DEFAULT_VIEWPORT), the same live-drive uses.
 */
import { chromium, firefox, webkit, type BrowserType, type Page } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_VIEWPORT } from './lib/game-session.js';

const args = process.argv.slice(2);
const opt = (name: string, dflt: string): string => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] ?? dflt : dflt; };
const which = opt('browser', 'firefox');
const url = opt('url', 'https://playwebac.com/');
const world = opt('world', 'Coldeve');
const out = opt('out', `/tmp/browser-matrix-${which}`);
const account = process.env.AC_ACCOUNT ?? '';
const password = process.env.AC_PASSWORD ?? '';
if (!account || !password) { console.error('set AC_ACCOUNT and AC_PASSWORD'); process.exit(2); }

const TYPES: Record<string, BrowserType> = { firefox, webkit, chromium };
const type = TYPES[which];
if (!type) { console.error(`unknown browser ${which}`); process.exit(2); }

mkdirSync(out, { recursive: true });
const errors: string[] = [];
const report: Record<string, unknown> = { browser: which, url, world, beats: [] as unknown[] };
const beats = report.beats as Array<Record<string, unknown>>;
const t0 = Date.now();
let shotN = 0;

async function shot(page: Page, name: string): Promise<string> {
  const p = join(out, `${String(++shotN).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}
async function beat(page: Page, name: string, extra: Record<string, unknown> = {}): Promise<void> {
  const s = await shot(page, name);
  beats.push({ name, atSec: Math.round((Date.now() - t0) / 100) / 10, shot: s, ...extra });
  console.log(`[${which}] ${name} @ ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
/** Waits for `fn` in the page to return truthy, polling (no debug globals on production). */
async function waitFor(page: Page, what: string, fn: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await page.evaluate(fn).catch(() => false)) return true;
    await page.waitForTimeout(1000);
  }
  errors.push(`timeout: ${what}`);
  return false;
}

const browser = await type.launch({ headless: !args.includes('--headed') });
const ctx = await browser.newContext({ viewport: { ...DEFAULT_VIEWPORT } });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`); });
try {
  await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
  // The launcher: the world list and the Account field are up.
  await waitFor(page, 'launcher', `!!document.querySelector('.launcher-account')`, 120_000);
  await page.waitForTimeout(1500);
  report.webgl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'webgl';
  });
  await beat(page, 'launcher');
  // Pick the world row by its name, then the fields and ENTER by mouse.
  const row = page.getByText(world, { exact: true }).first();
  if (await row.count()) await row.click();
  await page.mouse.click(418, 92);
  await page.keyboard.type(account, { delay: 20 });
  await page.mouse.click(418, 160);
  await page.keyboard.type(password, { delay: 20 });
  await beat(page, 'credentials', {
    passwordDots: await page.evaluate(() => {
      const p = document.querySelector('.launcher-password') as HTMLInputElement | null;
      return p ? { len: p.value.length, painted: !!p.parentElement?.querySelector('.ac-dat-edit-layer canvas') } : null;
    }),
  });
  await page.mouse.click(712, 508);
  // Character select: the first row, then ENTER.
  await page.waitForTimeout(8000);
  await beat(page, 'char-select');
  await page.mouse.click(420, 285);
  await page.waitForTimeout(500);
  await page.mouse.click(712, 508);
  const enteredAt = Date.now();
  // In the world: the HUD's toolbar backpack is up and the canvas is drawing.
  const inWorld = await waitFor(page, 'world', `!!document.querySelector('#game-hud') && getComputedStyle(document.querySelector('#game-hud')).display !== 'none'`, 180_000);
  // The HUD is up behind the portal tunnel; the world shows after the
  // EndTeleportAnimation hold (2 s + zooms), so give it the tunnel's time.
  await page.waitForTimeout(20000);
  report.secondsToWorld = inWorld ? Math.round((Date.now() - enteredAt) / 100) / 10 : null;
  await beat(page, 'world');
  // A string, not a function: tsx's __name helper does not exist in the page.
  report.fps = await page.evaluate(`new Promise((res) => {
    let n = 0; const s = performance.now();
    const f = () => { n++; if (performance.now() - s < 3000) requestAnimationFrame(f); else res(Math.round(n / ((performance.now() - s) / 1000))); };
    requestAnimationFrame(f);
  })`);
  await page.mouse.click(1530, 710); // the backpack
  await page.waitForTimeout(2500);
  await beat(page, 'inventory');
  await page.keyboard.down('w'); await page.waitForTimeout(1500); await page.keyboard.up('w');
  await page.waitForTimeout(1000);
  await beat(page, 'walked');
} catch (e) {
  errors.push(`probe: ${(e as Error).message}`);
} finally {
  report.errors = errors;
  report.totalSec = Math.round((Date.now() - t0) / 1000);
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ browser: which, webgl: report.webgl, secondsToWorld: report.secondsToWorld, fps: report.fps, errors: errors.length }, null, 0));
  await browser.close();
}
