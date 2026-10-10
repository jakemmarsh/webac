/**
 * playtest-npc-fellowship — discovery mode (d) session #4, beat 3: the two
 * beats run 1b couldn't finish — NPC examine (outdoors this time; the
 * interior tele wedged the camera into wall geometry) and the FELLOWSHIP
 * lifecycle (create through the real panel button, openness toggle, quit).
 * Run 1b's DOM matchers failed because every panel label is an AC-font
 * canvas (textContent = '') — buttons are now targeted by class/style:
 * create = the 33px-tall DAT-textured div, in-fellowship actions =
 * button.fellow-action-btn[i] (row order: Leader, Quit, Open/Close,
 * Recruit, Dismiss, Disband).
 *
 * Output: verification/playtest/<utc>-npc-fellowship/.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=playtest4f';
const VIEW = { width: 1568, height: 775 };
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-npc-fellowship`);

interface ConsoleEntry { phase: string; type: string; text: string }
const consoleLog: ConsoleEntry[] = [];
const chatLog: string[] = [];
const steps: Array<Record<string, unknown>> = [];
let phase = 'boot';

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

async function screenPos(page: Page, guid: number, yOff = 1.0): Promise<{ x: number; y: number; behind: boolean } | null> {
  return page.evaluate(`(() => {
    const objs = window.acDebug.getObjects();
    const o = objs.find(o => o.guid === ${guid});
    if (!o || !o.pos) return null;
    const sm = window.__ac.sceneManager;
    const cam = sm.camera;
    const rect = sm.renderer.domElement.getBoundingClientRect();
    const v = o.pos.clone(); v.y += ${yOff};
    v.project(cam);
    return {
      x: rect.left + (v.x + 1) / 2 * rect.width,
      y: rect.top + (1 - v.y) / 2 * rect.height,
      behind: v.z > 1,
    };
  })()`) as Promise<{ x: number; y: number; behind: boolean } | null>;
}

async function objects(page: Page): Promise<Array<{ guid: number; name: string; radarColor: number; type: number; dist: number }>> {
  return page.evaluate(`(() => {
    const me = window.acDebug.collisionState();
    return window.acDebug.getObjects()
      .filter(o => o.pos && o.name)
      .map(o => ({ guid: o.guid, name: o.name, radarColor: o.radarColor, type: o.type,
        dist: Math.hypot(o.pos.x - me.x, o.pos.z - me.z) }))
      .sort((a, b) => a.dist - b.dist);
  })()`) as any;
}

async function rightClickExamine(page: Page, guid: number): Promise<{ itemCount: number } | null> {
  for (const yOff of [1.0, 0.6, 1.4, 0.2, 1.8]) {
    const sp = await screenPos(page, guid, yOff);
    if (!sp || sp.behind) continue;
    for (const dx of [0, -18, 18]) {
      const x = sp.x + dx, y = sp.y;
      if (x < 5 || x > VIEW.width - 5 || y < 40 || y > VIEW.height - 5) continue;
      await page.evaluate(`(() => {
        const c = window.__ac.sceneManager.renderer.domElement;
        const opts = { bubbles: true, cancelable: true, button: 2, clientX: ${x}, clientY: ${y} };
        c.dispatchEvent(new MouseEvent('mousedown', opts));
        c.dispatchEvent(new MouseEvent('mouseup', opts));
      })()`);
      await page.waitForTimeout(400);
      const found = await page.evaluate(`(() => {
        const menus = [...document.querySelectorAll('div')].filter(d => d.style.position === 'fixed' && d.style.minWidth === '120px');
        if (!menus.length) return null;
        const items = [...menus[menus.length - 1].children];
        if (!items.length) return null;
        items[items.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { itemCount: items.length };
      })()`) as { itemCount: number } | null;
      if (found) return found;
    }
  }
  return null;
}

async function faceObject(page: Page, guid: number, yOff = 1.0): Promise<{ x: number; y: number; behind: boolean } | null> {
  for (let i = 0; i < 24; i++) {
    const sp = await screenPos(page, guid, yOff);
    if (sp && !sp.behind && sp.x > VIEW.width * 0.35 && sp.x < VIEW.width * 0.65 && sp.y > 40 && sp.y < VIEW.height - 20) return sp;
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(350);
    await page.keyboard.up('ArrowLeft');
    await page.waitForTimeout(250);
  }
  return screenPos(page, guid, yOff);
}

async function fellowData(page: Page): Promise<unknown> {
  return page.evaluate(`window.__ac.gameUI.fellowshipData`);
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
    const t = m.type();
    if (t === 'error' || t === 'warning') consoleLog.push({ phase, type: t, text: m.text().slice(0, 500) });
    const txt = m.text();
    if (/\[AC\]|\[Chat\]/.test(txt)) chatLog.push(`${phase}| ${txt.slice(0, 300)}`);
  });
  page.on('pageerror', (e) => consoleLog.push({ phase, type: 'pageerror', text: String(e).slice(0, 500) }));

  console.log(`[npcfellow] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (Date.now() - lastReload > 60_000) {
      console.log('[npcfellow] reload (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep looping */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await shot(page, 'f00-never-entered'); await browser.close(); throw new Error('never entered world'); }

  phase = 'settle';
  await page.waitForTimeout(10_000);
  await shot(page, 'f01-spawn');

  // ── Beat N: NPC examine, outdoors on the Holtburg green ──
  phase = 'npc-examine';
  await page.evaluate(`window.acDebug.tele('0xA9B40000', 101.9, 25, 94.1)`);
  await page.waitForTimeout(10_000);
  const objsNow = await objects(page);
  const npc = objsNow.find(o =>
    o.dist > 2 && o.dist < 35 &&
    !/rabbit|tester|portal|sword|statue/i.test(o.name) &&
    (o.type & 0x10) !== 0 /* ItemType.Creature bit */);
  steps.push({ step: 'npc-pick', npc: npc ?? null, nearest: objsNow.slice(0, 8) });
  console.log('[npcfellow] npc pick:', JSON.stringify(npc ?? null));
  if (npc) {
    await faceObject(page, npc.guid, 1.0);
    const menu = await rightClickExamine(page, npc.guid);
    await page.waitForTimeout(3500);
    await shot(page, 'f02-examine-npc');
    steps.push({ step: 'examine-npc', npc: npc.name, menu });
    await page.evaluate(`window.__ac.gameUI.hideExaminePanel && window.__ac.gameUI.hideExaminePanel()`).catch(() => {});
  }

  // ── Beat F: fellowship lifecycle ──
  phase = 'fellowship';
  await page.evaluate(`window.__ac.gameUI.toggleSocialPanel()`);
  await page.waitForTimeout(2500);
  await shot(page, 'f03-fellowship-empty');
  const createResult = await page.evaluate(`(() => {
    const panel = window.__ac.gameUI.socialPanel;
    if (!panel) return 'no-panel';
    const input = panel.querySelector('.fellowship-name-input');
    if (!input) return 'no-input';
    input.value = 'Playtest Fellows';
    // BUG.fellowship-create-button-unwired: the panel button's
    // onCreateFellowship callback is never assigned, so drive the working
    // chat-command path instead (same route as typing /fellow create).
    window.__ac.gameUI.callbacks.onChatSend('/fellow create Playtest Fellows');
    return 'chat-command';
  })()`);
  await page.waitForTimeout(6000);
  steps.push({ step: 'fellowship-created', createResult, fellowData: await fellowData(page) });
  console.log('[npcfellow] create:', createResult, JSON.stringify(await fellowData(page)));
  await shot(page, 'f04-fellowship-created');

  // openness toggle: .fellow-action-btn order = Leader, Quit, Open/Close, Recruit, Dismiss, Disband
  const openResult = await page.evaluate(`(() => {
    const panel = window.__ac.gameUI.socialPanel;
    if (!panel) return 'no-panel';
    const btns = panel.querySelectorAll('button.fellow-action-btn');
    if (btns.length < 3) return 'btn-count-' + btns.length;
    btns[2].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'clicked-openness';
  })()`);
  await page.waitForTimeout(5000);
  steps.push({ step: 'fellowship-openness', openResult, fellowData: await fellowData(page) });
  console.log('[npcfellow] openness:', openResult, JSON.stringify(await fellowData(page)));
  await shot(page, 'f05-fellowship-open');

  // quit: .fellow-action-btn[1]
  const quitResult = await page.evaluate(`(() => {
    const panel = window.__ac.gameUI.socialPanel;
    if (!panel) return 'no-panel';
    const btns = panel.querySelectorAll('button.fellow-action-btn');
    if (btns.length < 2) return 'btn-count-' + btns.length;
    btns[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'clicked-quit';
  })()`);
  await page.waitForTimeout(6000);
  steps.push({ step: 'fellowship-quit', quitResult, fellowData: await fellowData(page) });
  console.log('[npcfellow] quit:', quitResult, JSON.stringify(await fellowData(page)));
  await shot(page, 'f06-fellowship-after-quit');

  await browser.close();
  const errors = consoleLog.filter(c => c.type !== 'warning');
  writeFileSync(join(OUT, 'observations.json'), JSON.stringify({
    utc: UTC, url: URL, viewport: VIEW, steps,
    consoleErrorCount: errors.length, consoleWarningCount: consoleLog.length - errors.length,
    console: consoleLog, chatLog: chatLog.slice(-400),
  }, null, 2));
  console.log(`\n[npcfellow] done — ${steps.length} steps, ${errors.length} errors; wrote ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
