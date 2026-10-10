/**
 * playtest-fellowship-toggle-labels — targeted live verification for
 * VISUAL.fellowship-share-xp-string-table-collision.
 *
 * Boots into the ACE world, opens the Social panel's fellowship tab
 * (empty state — the four option toggles + Create button), and asserts the
 * shareFellowshipXP toggle label is the LONG retail text
 * "Share Fellowship Experience and Luminance" (table 0x23000003, the
 * binding gmFellowshipUI::PostInit @ 0048fd40 sets via table enum
 * 0x10000003) and NOT the 0x23000005 short "Share Fellowship Experience"
 * that the flat last-write-wins string index used to resolve. The other
 * three toggle labels are asserted too.
 *
 * Output: verification/playtest/<utc>-fellowship-toggle-labels/
 * (screenshots + steps.json).
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=fellowtoggles';
const VIEW = { width: 1568, height: 775 };
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-fellowship-toggle-labels`);

const LONG = 'Share Fellowship Experience and Luminance';
const SHORT = 'Share Fellowship Experience';

const EXPECTED: Record<string, string> = {
  ignoreFellowshipRequests: 'Ignore Fellowship Requests',
  autoAcceptFellowshipRequests: 'Automatically Accept Fellowship Requests',
  shareFellowshipXP: LONG,
  shareFellowshipLoot: 'Share Fellowship Loot',
};

const steps: Array<Record<string, unknown>> = [];

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as any).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function driveCreate(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return { state: 'not-at-create' };
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return { state: 'no-hooks' };
    const w = ui.wizard;
    w.setAttribute('strength', 100);
    w.setAttribute('endurance', 100);
    w.setAttribute('coordination', 100);
    w.setAttribute('quickness', 10);
    w.setAttribute('focus', 10);
    w.setAttribute('self', 10);
    w.name = 'Fellow Toggle Tester';
    ui.callbacks.onCharacterCreated(w);
    return { state: 'sent', name: w.name };
  })()`) as Promise<Record<string, unknown>>;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`[shot] ${name}`);
}

/**
 * Toggle-row labels are AC-bitmap-font canvases (renderACText), so innerText
 * is empty. Shim renderACText to stamp each rendered element with its source
 * string via data-actext — pixels stay identical, text becomes readable.
 * Must be installed BEFORE the social panel renders.
 */
async function installACTextShim(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    if (ui.__origRenderACText) return;
    ui.__origRenderACText = ui.renderACText;
    ui.renderACText = function (text, color, scale, maxWidth) {
      const el = ui.__origRenderACText.call(this, text, color, scale, maxWidth);
      if (el && el.setAttribute) el.setAttribute('data-actext', String(text));
      return el;
    };
  })()`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());

  console.log(`[playtest] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCreate(page);
      if (created.state !== 'not-at-create') {
        console.log(`[playtest] character create: ${JSON.stringify(created)}`);
        createSent = true; lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[playtest] reload (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep looping */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await shot(page, '00-never-entered'); await browser.close(); throw new Error('never entered world'); }
  await page.waitForTimeout(8000);

  await installACTextShim(page);

  // Open the Social panel (fellowship tab is the default/first tab; the
  // empty no-fellowship state carries the four option toggles).
  await page.evaluate(`document.getElementById('tb-social').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await page.waitForTimeout(1200);
  await shot(page, '01-social-fellowship-empty');

  const rows = await page.evaluate(`(() => {
    const panel = window.__ac.gameUI.socialPanel;
    if (!panel) return null;
    return [...panel.querySelectorAll('.option-toggle-row')].map(r => ({
      key: r.dataset.optionKey,
      label: [...r.children].filter(c => c.hasAttribute && c.hasAttribute('data-actext'))
        .map(c => c.getAttribute('data-actext')).join(' '),
    }));
  })()`) as Array<{ key: string; label: string }> | null;

  const byKey = new Map((rows ?? []).map(r => [r.key, r.label]));
  const mismatches: string[] = [];
  for (const [key, expected] of Object.entries(EXPECTED)) {
    const got = byKey.get(key);
    if (got !== expected) mismatches.push(`${key}: expected "${expected}", got "${got ?? '(missing)'}"`);
  }
  const shareLabel = byKey.get('shareFellowshipXP') ?? null;
  let verdict = 'FAIL';
  if (!rows) verdict = 'FAIL(no-social-panel)';
  else if (shareLabel === SHORT) verdict = 'FAIL(pre-fix-short-label)';
  else if (mismatches.length) verdict = `FAIL(${mismatches.length}-mismatch)`;
  else verdict = 'PASS';

  steps.push({ step: 'fellowship-toggle-labels', rows, mismatches, verdict });
  writeFileSync(join(OUT, 'steps.json'), JSON.stringify(steps, null, 2));
  console.log(`[verdict] ${verdict}`);
  for (const r of rows ?? []) console.log(`  ${r.key} = "${r.label}"`);
  if (mismatches.length) for (const m of mismatches) console.log(`  MISMATCH ${m}`);

  await browser.close();
  if (verdict !== 'PASS') process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exitCode = 1; });
