/**
 * playtest-fellowship-create-button — live verification for
 * BUG.fellowship-create-button-unwired: the social panel's Create Fellowship
 * button must send a real FellowshipCreate through the REAL DOM button (the
 * bug's original evidence drove the chat-command path because the button was
 * a no-op).
 *
 * Beats:
 *  1. empty-name click on the real button → nothing sent (retail disables
 *     the button on empty text), fellowshipData stays null
 *  2. shareFellowshipXP=false + typed name + real button click →
 *     FellowshipCreate on the wire, FullUpdate arrives, panel flips to
 *     member state, fellowshipData.shareXP === false (toggle honored,
 *     retail PlayerModule::FellowshipShareXP semantics)
 *  3. /fellow quit cleanup, then create again with shareFellowshipXP=true →
 *     fellowshipData.shareXP === true
 *
 * Output: verification/playtest/<utc>-fellowship-create-button/.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=fellowbtn';
const VIEW = { width: 1568, height: 775 };
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-fellowship-create-button`);

const consoleLog: Array<{ type: string; text: string }> = [];
const chatLog: string[] = [];
const steps: Array<Record<string, unknown>> = [];

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as any).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`[shot] ${name}`);
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

async function fellowData(page: Page): Promise<any> {
  return page.evaluate(`window.__ac.gameUI.fellowshipData`);
}

/** Type into the real input + click the real DAT-textured create button. */
async function clickCreate(page: Page, name: string): Promise<string> {
  return page.evaluate(`(() => {
    const panel = window.__ac.gameUI.socialPanel;
    if (!panel) return 'no-panel';
    const input = panel.querySelector('.fellowship-name-input');
    if (!input) return 'no-input';
    input.value = ${JSON.stringify(name)};
    const btn = panel.querySelector('.fellowship-create-btn');
    if (!btn) return 'no-button';
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'clicked';
  })()`) as Promise<string>;
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
  page.on('console', (m) => {
    const txt = m.text();
    if (m.type() === 'error') consoleLog.push({ type: 'error', text: txt.slice(0, 500) });
    if (/\[AC\]|\[Chat\]/.test(txt)) chatLog.push(txt.slice(0, 300));
  });
  page.on('pageerror', (e) => consoleLog.push({ type: 'pageerror', text: String(e).slice(0, 500) }));

  console.log(`[fellowbtn] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[fellowbtn] scripted character create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[fellowbtn] reload (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep looping */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await shot(page, 'f00-never-entered'); await browser.close(); throw new Error('never entered world'); }

  await page.waitForTimeout(10_000);
  await shot(page, 'f01-spawn');

  await page.evaluate(`window.__ac.gameUI.toggleSocialPanel()`);
  await page.waitForTimeout(2500);
  await shot(page, 'f02-empty-state');

  // Beat 1: empty-name click must send nothing.
  const wireMark = () => chatLog.filter(l => l.includes('Sent FellowshipCreate')).length;
  const before = wireMark();
  const emptyResult = await clickCreate(page, '   ');
  await page.waitForTimeout(4000);
  steps.push({ step: 'empty-name-click', emptyResult, sends: wireMark() - before, fellowData: await fellowData(page) });
  console.log('[fellowbtn] empty-name click:', emptyResult, 'sends:', wireMark() - before);

  // Beat 2: toggle OFF + real click → created with shareXP=false.
  await page.evaluate(`window.__ac.gameUI.optionsSettings.shareFellowshipXP = false`);
  const createResult = await clickCreate(page, 'Create Btn Fellows');
  await page.waitForTimeout(6000);
  const fd2 = await fellowData(page);
  steps.push({ step: 'create-toggle-off', createResult, sends: wireMark() - before, fellowData: fd2 });
  console.log('[fellowbtn] create (shareXP off):', createResult, JSON.stringify(fd2));
  await shot(page, 'f03-created-toggle-off');

  // Beat 3: quit, toggle ON, create again → shareXP=true.
  await page.evaluate(`window.__ac.gameUI.callbacks.onChatSend('/fellow quit')`);
  await page.waitForTimeout(5000);
  await page.evaluate(`window.__ac.gameUI.optionsSettings.shareFellowshipXP = true`);
  const createResult2 = await clickCreate(page, 'Create Btn Fellows II');
  await page.waitForTimeout(6000);
  const fd3 = await fellowData(page);
  steps.push({ step: 'create-toggle-on', createResult2, sends: wireMark() - before, fellowData: fd3 });
  console.log('[fellowbtn] create (shareXP on):', createResult2, JSON.stringify(fd3));
  await shot(page, 'f04-created-toggle-on');

  // cleanup
  await page.evaluate(`window.__ac.gameUI.callbacks.onChatSend('/fellow quit')`);
  await page.waitForTimeout(3000);

  await browser.close();
  writeFileSync(join(OUT, 'observations.json'), JSON.stringify({
    utc: UTC, url: URL, steps,
    consoleErrorCount: consoleLog.length, console: consoleLog, chatLog: chatLog.slice(-200),
  }, null, 2));

  const created1 = steps[1]?.fellowData as any, created2 = steps[2]?.fellowData as any;
  const pass =
    (steps[0] as any).sends === 0 && (steps[0] as any).fellowData === null &&
    created1 && created1.fellowshipName === 'Create Btn Fellows' && created1.shareXP === false &&
    created2 && created2.fellowshipName === 'Create Btn Fellows II' && created2.shareXP === true;
  console.log(`\n[fellowbtn] VERDICT: ${pass ? 'PASS' : 'FAIL'} — wrote ${OUT}`);
  if (!pass) process.exit(2);
}

main().catch((err) => { console.error(err); process.exit(1); });
