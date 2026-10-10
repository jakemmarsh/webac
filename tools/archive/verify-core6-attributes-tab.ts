/**
 * CORE.6 verification — [char-panel] Attributes tab overflow / bottom black bar.
 *
 * Logs into the ACE stack headlessly (same path as live-playtest.ts), opens
 * the character panel on the Attributes tab, and measures:
 *   - the panel wrapper rect vs the dock slot (radar bottom y=140 → toolbar top)
 *   - the active tab content: scrollHeight vs clientHeight (content overflow)
 *   - a pixel-sample of the bottom strip of the panel (black-bar detector)
 * Screenshots the full HUD + a panel crop to verification/core6-attributes/.
 *
 * Usage: npx tsx tools/verify-core6-attributes-tab.ts [--headed]
 */

import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const HEADED = process.argv.includes('--headed');
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core6';
const VIEW = { width: 1568, height: 775 };
const OUT = join(__dir, '..', 'verification', 'core6-attributes');

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

/** Same virgin-account handling as measure-perf.ts (source string — __name landmine). */
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

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) && !HEADED ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));

  console.log(`[core6] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[core6] virgin account create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[core6] not in world yet — phantom-session reload');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep waiting */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, '00-never-entered.png') });
    await browser.close();
    throw new Error('never entered world within 360s');
  }
  console.log('[core6] in world — settling 8s');
  await page.waitForTimeout(8000);

  // Open the character panel on the Attributes tab (persisted sub-tab may
  // differ — force attributes through the persisted-options path first).
  await page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (ui && ui.charPanelTab) ui.charPanelTab = 'attributes';
  })()`);
  await page.evaluate(`document.getElementById('tb-char')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await page.waitForTimeout(1500);

  // Capture all three tabs (whole-screen rule).
  for (const [tab, shotName] of [['skills', '03-skills-tab'], ['titles', '04-titles-tab']] as const) {
    await page.evaluate(`(() => {
      const ui = window.__ac.gameUI;
      ui.charPanelTab = '${tab}';
      ui.renderCharPanel();
    })()`);
    await page.waitForTimeout(800);
    const r = await page.evaluate(`(() => {
      const wr = window.__ac.gameUI.charPanel.getBoundingClientRect();
      return { x: wr.x, y: wr.y, w: wr.width, h: wr.height };
    })()`) as { x: number; y: number; w: number; h: number };
    await page.screenshot({
      path: join(OUT, `${shotName}.png`),
      clip: { x: Math.max(0, r.x - 10), y: Math.max(0, r.y - 10), width: r.w + 40, height: Math.min(VIEW.height - r.y + 10, r.h + 50) },
    });
  }
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.charPanelTab = 'attributes'; ui.renderCharPanel(); })()`);
  await page.waitForTimeout(800);

  const metrics = await page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    const wrapper = ui && ui.charPanel;
    if (!wrapper) return { error: 'charPanel wrapper not found' };
    const handle = ui.charPanelHandle;
    const wr = wrapper.getBoundingClientRect();
    const contentIds = [0x1000022b, 0x1000022c, 0x10000539];
    const active = handle && handle.elements ? handle.elements.get(0x1000022b) : null;
    const out = {
      tab: ui.charPanelTab,
      wrapperRect: { x: wr.x, y: wr.y, w: wr.width, h: wr.height },
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      content: null,
      overflowChildren: [],
    };
    if (active) {
      const ar = active.getBoundingClientRect();
      out.content = {
        rect: { x: ar.x, y: ar.y, w: ar.width, h: ar.height },
        scrollHeight: active.scrollHeight,
        clientHeight: active.clientHeight,
        overflows: active.scrollHeight > active.clientHeight + 1,
      };
      // any child extending past the wrapper bottom?
      const walk = (el) => {
        for (const c of el.children) {
          const r = c.getBoundingClientRect();
          if (r.bottom > wr.bottom + 1 && r.height > 0) {
            out.overflowChildren.push({ tag: c.tagName, cls: c.className, bottom: r.bottom, wrapBottom: wr.bottom });
          }
          walk(c);
        }
      };
      walk(wrapper);
      out.overflowChildren = out.overflowChildren.slice(0, 10);
    }
    return out;
  })()`) as Record<string, unknown>;
  console.log('[core6] metrics:', JSON.stringify(metrics, null, 2));

  await page.screenshot({ path: join(OUT, '01-full-hud.png') });
  const wr = (metrics as { wrapperRect?: { x: number; y: number; w: number; h: number } }).wrapperRect;
  if (wr) {
    // Crop panel + 30px margin below so a bottom black bar (outside the
    // wrapper) is still visible in the crop.
    await page.screenshot({
      path: join(OUT, '02-panel-crop.png'),
      clip: { x: Math.max(0, wr.x - 10), y: Math.max(0, wr.y - 10), width: wr.w + 40, height: Math.min(VIEW.height - wr.y + 10, wr.h + 50) },
    });
  }
  writeFileSync(join(OUT, 'metrics.json'), JSON.stringify({ metrics, errors: errors.slice(0, 20) }, null, 2));
  await browser.close();
  console.log(`[core6] done — output in ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
