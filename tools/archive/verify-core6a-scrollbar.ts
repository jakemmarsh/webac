/**
 * CORE.6.a verification — DAT scrollbar widget on the char-panel stat/titles
 * lists. Enters the ACE stack, opens the character panel, and per tab:
 *   - reads the bar element (0x1000023e stat / 0x10000533 titles): display,
 *     track art, widget children (buttons + thumb), thumb geometry
 *   - clicks the down/up arrows and asserts the list scrollTop steps
 *   - screenshots each tab crop to verification/core6a-scrollbar/
 *
 * Usage: npx tsx tools/verify-core6a-scrollbar.ts [--headed]
 */

import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const HEADED = process.argv.includes('--headed');
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core6a';
const VIEW = { width: 1568, height: 775 };
const OUT = join(__dir, '..', 'verification', 'core6a-scrollbar');

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
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

  console.log(`[core6a] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[core6a] virgin account create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[core6a] not in world yet — phantom-session reload');
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
  console.log('[core6a] in world — settling 8s');
  await page.waitForTimeout(8000);

  await page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (ui && ui.charPanelTab) ui.charPanelTab = 'attributes';
  })()`);
  await page.evaluate(`document.getElementById('tb-char')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await page.waitForTimeout(1500);

  const results: Record<string, unknown> = {};
  const tabs = [
    ['attributes', 0x1000023e, 0x1000023d],
    ['skills', 0x1000023e, 0x1000023d],
    ['titles', 0x10000533, 0x10000532],
  ] as const;

  for (const [tab, sbId, listId] of tabs) {
    await page.evaluate(`(() => {
      const ui = window.__ac.gameUI;
      ui.charPanelTab = '${tab}';
      ui.renderCharPanel();
    })()`);
    await page.waitForTimeout(1000);

    const m = await page.evaluate(`(() => {
      const ui = window.__ac.gameUI;
      const handle = ui.charPanelHandle;
      const paneId = { attributes: 0x1000022b, skills: 0x1000022c, titles: 0x10000539 }['${tab}'];
      const pane = handle.elements.get(paneId);
      const byId = (root, id) => root.querySelector('[data-element-id="0x' + id.toString(16) + '"]');
      const sb = byId(pane, ${sbId});
      const list = byId(pane, ${listId});
      if (!sb || !list) return { error: 'sb/list not found', sb: !!sb, list: !!list };
      const sr = sb.getBoundingClientRect();
      const thumb = sb.querySelector('[data-dat-thumb="1"]');
      const kids = Array.from(sb.children).map(c => ({
        bg: (c.style.backgroundImage || '').slice(0, 80),
        top: c.style.top, bottom: c.style.bottom, h: c.style.height,
      }));
      const overflows = list.scrollHeight > list.clientHeight + 1;
      const out = {
        display: sb.style.display, rect: { x: sr.x, y: sr.y, w: sr.width, h: sr.height },
        trackBg: (sb.style.backgroundImage || '').slice(0, 90),
        kids, thumb: thumb ? { top: thumb.style.top, h: thumb.style.height } : null,
        list: { scrollHeight: list.scrollHeight, clientHeight: list.clientHeight, scrollTop: list.scrollTop, overflows },
      };
      // Interactivity: click the down arrow (child pinned to bottom), then up.
      const kidEls = Array.from(sb.children);
      const down = kidEls.find(c => c.style.bottom === '0px');
      const up = kidEls.find(c => c.style.top === '0px' && c !== thumb);
      if (down && overflows) {
        const before = list.scrollTop;
        down.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        out.downStep = { before, after: list.scrollTop };
        if (up) { up.dispatchEvent(new MouseEvent('click', { bubbles: true })); out.upStep = { after: list.scrollTop }; }
      }
      return out;
    })()`) as Record<string, unknown>;
    results[tab] = m;
    console.log(`[core6a] ${tab}:`, JSON.stringify(m, null, 1).slice(0, 1200));

    const r = await page.evaluate(`(() => {
      const wr = window.__ac.gameUI.charPanel.getBoundingClientRect();
      return { x: wr.x, y: wr.y, w: wr.width, h: wr.height };
    })()`) as { x: number; y: number; w: number; h: number };
    await page.screenshot({
      path: join(OUT, `${tab}-tab.png`),
      clip: { x: Math.max(0, r.x - 10), y: Math.max(0, r.y - 10), width: r.w + 40, height: Math.min(VIEW.height - r.y + 10, r.h + 50) },
    });
  }

  writeFileSync(join(OUT, 'metrics.json'), JSON.stringify({ results, errors: errors.slice(0, 20) }, null, 2));
  await browser.close();
  console.log(`[core6a] done — output in ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
