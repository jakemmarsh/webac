/**
 * CORE.5.c.a repro 3: in one session — open panel (spells), switch to
 * components, close, re-open. Does a FRESH open with magicPanelTab=components
 * fail? Then reload the page (same context/localStorage) and open again.
 */
import { chromium, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=c5ca4';
const VIEW = { width: 1568, height: 775 };
const OUT = join('/home/user/acjs', 'verification', 'playtest', 'core5ca-magic-tab');

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as any).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function enterWorld(page: Page): Promise<void> {
  const deadline = Date.now() + 300_000;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) return;
    if (Date.now() - lastReload > 60_000) {
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* loop */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  throw new Error('never entered world');
}

const DUMP = `(() => {
  const ui = window.__ac.gameUI;
  const wrap = ui.magicPanel;
  return {
    tab: ui.magicPanelTab, visible: ui.magicVisible,
    panel: !!wrap, connected: wrap ? wrap.isConnected : null,
    rect: wrap ? (() => { const r = wrap.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })() : null,
    tabEls: document.querySelectorAll('[data-magic-tab]').length,
  };
})()`;

async function main(): Promise<void> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  page.on('pageerror', e => console.log('PAGEERROR:', (e.stack || e.message).slice(0, 1500)));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await enterWorld(page);
  console.log('[dbg] in world');
  await page.waitForTimeout(10000);

  const step = async (label: string, code: string) => {
    const r = await page.evaluate(`(() => { try { ${code}; return {ok:true}; } catch (e) { return {ok:false, err:String(e && e.stack || e).slice(0,1500)}; } })()`);
    await page.waitForTimeout(800);
    const s = await page.evaluate(DUMP);
    console.log(`[dbg] ${label}:`, JSON.stringify(r), '->', JSON.stringify(s));
    return s as any;
  };

  await step('open #1 (spells)', `window.__ac.gameUI.toggleMagicPanel()`);
  await step('switch to components', `document.querySelector('[data-magic-tab=components]').click()`);
  await step('close', `window.__ac.gameUI.toggleMagicPanel()`);
  const reopened = await step('re-open (components)', `window.__ac.gameUI.toggleMagicPanel()`);
  await page.screenshot({ path: join(OUT, 'reopen-components.png') });

  if (reopened.tabEls === 0 || !reopened.connected) {
    console.log('[dbg] REPRO in-session: fresh open on components broken');
  } else {
    console.log('[dbg] in-session reopen OK — trying page reload (localStorage tab=components)');
    await step('close again', `window.__ac.gameUI.toggleMagicPanel()`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await enterWorld(page);
    await page.waitForTimeout(10000);
    const pre = await page.evaluate(`window.__ac.gameUI.magicPanelTab`);
    console.log('[dbg] after reload, persisted tab =', pre);
    const after = await step('open after reload', `window.__ac.gameUI.toggleMagicPanel()`);
    await page.screenshot({ path: join(OUT, 'reload-open-components.png') });
    if (after.tabEls === 0 || !after.connected) console.log('[dbg] REPRO after reload: fresh open on components broken');
    else console.log('[dbg] NO REPRO anywhere — panel opens fine on components');
  }
  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
