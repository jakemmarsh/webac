/**
 * probe-bookpagedata — live verification for BUG.bookpagedataresponse-dropped.
 *
 * Exercises the full single-page read round trip the wire protocol intends
 * (the "refresh a single page after an edit" flow from the task):
 *
 *   1. Spawn a writable book (@ci BOOK_WCID) and open it with bookData —
 *      the panel renders the page as it exists NOW.
 *   2. Edit page 0 server-side via the real bookAddPage/bookModifyPage
 *      GameActions (panel still shows the stale text — retail only refreshes
 *      what it is told to).
 *   3. Send bookPageData(guid, 0) — ACE's live GameActionBookPageData handler
 *      replies with GameEventBookPageDataResponse; before this fix the
 *      response was silently discarded, now it parses (console
 *      `[AC] BookPageDataResponse: ...`) and patches the open panel in place.
 *
 * Screenshots under verification/bookpagedata/ document stale vs refreshed.
 *
 * Usage: BOOK_WCID=<writable book wcid> npx tsx tools/probe-bookpagedata.ts
 * Requires: vite dev server (:3000), ws-tcp-bridge (:9090), ACE stack,
 * admin-enabled testacjs account.
 */

import { chromium, type Page } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const OUT_DIR = join(__dir, '..', 'verification', 'bookpagedata');
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=bookpagedata';
const BOOK_WCID = Number(process.env.BOOK_WCID ?? '365');
const BOOK_NAME = process.env.BOOK_NAME ?? 'Book';
const STALE_TEXT = 'Stale text from before the server-side edit.';
const FRESH_TEXT = 'Fresh from the server via BookPageDataResponse.';
const VIEW = { width: 1280, height: 800 };

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function driveCharacterCreate(page: Page): Promise<string> {
  // Source string, not a function — tsx injects __name into named fns
  // inside evaluate() callbacks (see measure-perf.ts).
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = 'Perf Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());

  const lines: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (t.includes('BookData') || t.includes('BookPageData') || t.includes('BookAddPage')
      || t.includes('BookModifyPage')) {
      lines.push(t);
      console.log(`[probe][console] ${t}`);
    }
  });

  console.log(`[probe] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // Phantom-session retry loop (see measure-perf.ts).
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[probe] character-create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[probe] not in world yet — reloading');
      try { await page.goto(URL, { waitUntil: 'domcontentloaded' }); } catch { /* retry next window */ }
      lastReload = Date.now();
      createSent = false;
    }
    await page.waitForTimeout(2000);
  }
  if (!(await inWorld(page))) {
    console.error('[probe] FAIL: never entered world');
    await browser.close();
    process.exit(1);
  }
  console.log('[probe] in world — settling 8s');
  await page.waitForTimeout(8000);

  // Spawn the writable book (idempotent-enough: a duplicate just means two books).
  await page.evaluate(`window.acDebug.sendChat('@ci ${BOOK_WCID}')`);
  await page.waitForTimeout(4000);

  const guid = await page.evaluate(`(() => {
    const items = window.__ac.playerState.inventory.getAll();
    const b = items.filter(i => i.name === ${JSON.stringify(BOOK_NAME)}).pop();
    return b ? b.id : 0;
  })()`) as number;
  if (!guid) {
    console.error(`[probe] FAIL: no "${BOOK_NAME}" (wcid ${BOOK_WCID}) in inventory after @ci`);
    await browser.close();
    process.exit(1);
  }
  console.log(`[probe] book guid=0x${guid.toString(16)}`);

  // Beat 0: seed page 0 with the stale text (a fresh @ci book has no pages).
  await page.evaluate(`window.acDebug.bookAddPage(${guid})`);
  await page.waitForTimeout(2000);
  await page.evaluate(`window.acDebug.bookModifyPage(${guid}, 0, ${JSON.stringify(STALE_TEXT)})`);
  await page.waitForTimeout(2000);

  // Beat 1: open the book — the panel snapshots page 0 as it is NOW (stale).
  await page.evaluate(`window.acDebug.bookData(${guid})`);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(OUT_DIR, '01-book-open-stale.png') });

  // Beat 2: edit page 0 server-side while the panel stays open — the panel
  // keeps showing the stale text (retail only refreshes what it is told to).
  await page.evaluate(`window.acDebug.bookModifyPage(${guid}, 0, ${JSON.stringify(FRESH_TEXT)})`);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(OUT_DIR, '02-after-server-edit-panel-stale.png') });

  // Beat 3: the single-page refresh round trip under test.
  const before = lines.filter(l => l.includes('[AC] BookPageDataResponse')).length;
  await page.evaluate(`window.acDebug.bookPageData(${guid}, 0)`);
  await page.waitForTimeout(3000);
  const after = lines.filter(l => l.includes('[AC] BookPageDataResponse')).length;
  await page.screenshot({ path: join(OUT_DIR, '03-after-bookpagedata-refresh.png') });

  const respLine = lines.find(l => l.includes('[AC] BookPageDataResponse')) ?? '';
  const gotText = respLine.includes(`chars=${FRESH_TEXT.length}`);

  console.log('[probe] === RESULT ===');
  console.log(`[probe] BookPageDataResponse parsed: ${after - before} (expect >= 1)`);
  console.log(`[probe] response carried the edited text (${FRESH_TEXT.length} chars): ${gotText}`);
  for (const l of lines) console.log(`[probe] LOG: ${l}`);

  await browser.close();
  process.exit(after - before >= 1 && gotText ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
