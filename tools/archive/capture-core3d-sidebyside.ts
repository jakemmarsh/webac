/**
 * CORE.3.d — capture the options-panel Chat tab + compose the side-by-side
 * sheets vs the retail references (chat-options.jpg, chat-panel.jpg).
 *
 * Usage: npx tsx tools/capture-core3d-sidebyside.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core3dsxs';
const OUT = join(REPO, 'verification', 'screens', 'core3d');

async function inWorld(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
      const cs = dbg?.collisionState?.();
      return !!(cs && cs.x > 0);
    });
  } catch { return false; }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true, args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  page.setDefaultTimeout(120000);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline && !(await inWorld(page))) await page.waitForTimeout(3000);
  if (!(await inWorld(page))) throw new Error('never entered world');
  await page.waitForTimeout(8000);

  // Open the options panel on the Chat tab.
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    ui.optionsSettings.optionsTab = 'chat';
    ui.optionsTab = 'chat';
    ui.toggleOptionsPanel();
  })()`);
  await page.waitForTimeout(1200);
  const clip = await page.evaluate(`(() => {
    const p = document.querySelector('[data-panel="options"]')
      || document.getElementById('options-panel')
      || [...document.querySelectorAll('div')].find(d => d.querySelector('[data-options-tab]'));
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return { x: Math.max(0, r.x - 4), y: Math.max(0, r.y - 4), width: r.width + 8, height: r.height + 8 };
  })()`) as { x: number; y: number; width: number; height: number } | null;
  if (!clip) throw new Error('options panel not found');
  await page.screenshot({ path: join(OUT, 'options-chat-tab.png'), clip });
  console.log('[sxs] captured options chat tab');

  // Compose side-by-side sheets in a fresh page (data URLs, no CSP issues).
  const b64 = (p: string, mime: string): string => `data:${mime};base64,${readFileSync(p).toString('base64')}`;
  const sheets: Array<[string, string, string, string, string]> = [
    ['side-by-side-options.png', b64(join(REPO, 'reference/images/hud/chat-options.jpg'), 'image/jpeg'), 'RETAIL chat-options.jpg',
      b64(join(OUT, 'options-chat-tab.png'), 'image/png'), 'OURS options Chat tab'],
    ['side-by-side-windows.png', b64(join(REPO, 'reference/images/hud/chat-panel.jpg'), 'image/jpeg'), 'RETAIL chat-panel.jpg',
      b64(join(OUT, '04-after-reload.png'), 'image/png'), 'OURS resized+retitled after reload'],
  ];
  for (const [out, leftSrc, leftLabel, rightSrc, rightLabel] of sheets) {
    const sheet = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await sheet.setContent(`<!doctype html><body style="margin:0;background:#222;display:flex;gap:8px;align-items:flex-start;font-family:monospace;color:#fff">
      <figure style="margin:4px"><figcaption>${leftLabel}</figcaption><img src="${leftSrc}" style="max-height:840px"></figure>
      <figure style="margin:4px"><figcaption>${rightLabel}</figcaption><img src="${rightSrc}" style="max-height:840px"></figure>
    </body>`);
    await sheet.waitForTimeout(400);
    await sheet.screenshot({ path: join(OUT, out), fullPage: true });
    await sheet.close();
    console.log(`[sxs] wrote ${out}`);
  }
  await browser.close();
  console.log(`[sxs] done → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
