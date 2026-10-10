/**
 * playtest-fellowship-quit-self — live verification for
 * BUG.fellowship-quit-leaves-stale-panel: after quitting via the panel's
 * real Quit button, the social panel must return to the you-do-not-belong
 * create state (retail ClientFellowshipSystem::Handle_Fellowship__Quit,
 * acclient 0x569e90: own guid → DeleteFellowship).
 *
 * Beats:
 *  1. create a fellowship through the real DOM create button → member state
 *  2. click the real Quit button (second .fellow-action-btn: Leader/Quit/…)
 *     → FellowshipQuit for own guid arrives → fellowshipData null, panel
 *     re-renders .fellowship-create-btn + .fellowship-name-input
 *  3. regression guard: create again through the freshly re-rendered create
 *     state (the original bug blocked exactly this beat in the
 *     create-button playtest)
 *
 * Output: verification/playtest/<utc>-fellowship-quit-self/.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=fellowquit';
const VIEW = { width: 1568, height: 775 };
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-fellowship-quit-self`);

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

/** Snapshot which state the rendered panel is in. */
async function panelState(page: Page): Promise<any> {
  return page.evaluate(`(() => {
    const panel = window.__ac.gameUI.socialPanel;
    if (!panel) return { open: false };
    return {
      open: true,
      createBtn: !!panel.querySelector('.fellowship-create-btn'),
      nameInput: !!panel.querySelector('.fellowship-name-input'),
      actionBtns: panel.querySelectorAll('.fellow-action-btn').length,
    };
  })()`);
}

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

/** Click the real member-state Quit button (row 1: Leader / Quit / openness). */
async function clickQuit(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const panel = window.__ac.gameUI.socialPanel;
    if (!panel) return 'no-panel';
    const btns = panel.querySelectorAll('.fellow-action-btn');
    if (btns.length < 2) return 'no-quit-button';
    btns[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
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

  console.log(`[fellowquit] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[fellowquit] scripted character create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[fellowquit] reload (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep looping */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await shot(page, 'f00-never-entered'); await browser.close(); throw new Error('never entered world'); }

  await page.waitForTimeout(10_000);

  // Beat 1: open panel, create a fellowship through the real button.
  await page.evaluate(`window.__ac.gameUI.toggleSocialPanel()`);
  await page.waitForTimeout(2500);
  const createResult = await clickCreate(page, 'Quit Test Fellows');
  await page.waitForTimeout(6000);
  const fdMember = await fellowData(page);
  const stMember = await panelState(page);
  steps.push({ step: 'create', createResult, fellowData: fdMember, panel: stMember });
  console.log('[fellowquit] created:', createResult, JSON.stringify(stMember));
  await shot(page, 'f01-member-state');

  // Beat 2: click the real Quit button → panel must return to create state.
  const quitResult = await clickQuit(page);
  await page.waitForTimeout(6000);
  const fdAfter = await fellowData(page);
  const stAfter = await panelState(page);
  steps.push({ step: 'quit', quitResult, fellowData: fdAfter, panel: stAfter });
  console.log('[fellowquit] after quit:', quitResult, 'fellowData:', JSON.stringify(fdAfter), 'panel:', JSON.stringify(stAfter));
  await shot(page, 'f02-after-quit');

  // Beat 3: the re-rendered create state must be functional again.
  const createResult2 = await clickCreate(page, 'Quit Test Fellows II');
  await page.waitForTimeout(6000);
  const fdSecond = await fellowData(page);
  steps.push({ step: 're-create', createResult2, fellowData: fdSecond });
  console.log('[fellowquit] re-create:', createResult2, JSON.stringify(fdSecond));
  await shot(page, 'f03-recreated');

  // cleanup
  await page.evaluate(`window.__ac.gameUI.callbacks.onChatSend('/fellow quit')`);
  await page.waitForTimeout(3000);

  await browser.close();
  writeFileSync(join(OUT, 'observations.json'), JSON.stringify({
    utc: UTC, url: URL, steps,
    consoleErrorCount: consoleLog.length, console: consoleLog, chatLog: chatLog.slice(-200),
  }, null, 2));

  const member = steps[0] as any, quit = steps[1] as any, second = steps[2] as any;
  const pass =
    member.fellowData && member.fellowData.fellowshipName === 'Quit Test Fellows' &&
    member.panel.actionBtns > 0 && member.panel.createBtn === false &&
    quit.fellowData === null && quit.panel.createBtn === true && quit.panel.nameInput === true &&
    quit.panel.actionBtns === 0 &&
    second.fellowData && second.fellowData.fellowshipName === 'Quit Test Fellows II';
  console.log(`\n[fellowquit] VERDICT: ${pass ? 'PASS' : 'FAIL'} — wrote ${OUT}`);
  if (!pass) process.exit(2);
}

main().catch((err) => { console.error(err); process.exit(1); });
