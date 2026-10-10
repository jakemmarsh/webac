/**
 * CORE.5.c.a repro 2: fresh login with server-persisted magicPanelTab=components,
 * press P — panel fails to appear. Capture JS errors + DOM state.
 */
import { chromium, type Page } from 'playwright';
import { existsSync } from 'node:fs';

const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=c5ca3';
const VIEW = { width: 1568, height: 775 };

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as any).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  page.on('pageerror', e => console.log('PAGEERROR:', e.stack || e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log(`CONSOLE-${m.type()}:`, m.text().slice(0, 500)); });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 300_000;
  let lastReload = Date.now();
  while (Date.now() < deadline && !(await inWorld(page))) {
    if (Date.now() - lastReload > 60_000) {
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* loop */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await browser.close(); throw new Error('never entered world'); }
  console.log('[dbg] in world');
  await page.waitForTimeout(10000);

  const pre = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    return { tab: ui.magicPanelTab, visible: ui.magicVisible, panel: !!ui.magicPanel, handle: !!ui.magicPanelHandle };
  })()`);
  console.log('[dbg] pre-P:', JSON.stringify(pre));

  // Call the toggle directly inside a try/catch to surface any throw the
  // key-handler path might swallow.
  const result = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    try {
      ui.toggleMagicPanel();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.stack) ? String(e.stack).slice(0, 2000) : String(e) };
    }
  })()`);
  console.log('[dbg] toggleMagicPanel():', JSON.stringify(result, null, 1));

  await page.waitForTimeout(1500);
  const post = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const wrap = ui.magicPanel;
    return {
      tab: ui.magicPanelTab, visible: ui.magicVisible,
      panel: !!wrap, handle: !!ui.magicPanelHandle,
      wrapConnected: wrap ? wrap.isConnected : null,
      wrapRect: wrap ? (() => { const r = wrap.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })() : null,
      wrapStyle: wrap ? { left: wrap.style.left, top: wrap.style.top, display: wrap.style.display, visibility: wrap.style.visibility } : null,
      childCount: wrap ? wrap.childElementCount : null,
      tabEls: document.querySelectorAll('[data-magic-tab]').length,
      panelSelector: !!document.querySelector('[data-panel="0x21000034"]'),
    };
  })()`);
  console.log('[dbg] post-P:', JSON.stringify(post, null, 1));

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
