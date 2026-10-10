/**
 * verify-damage-type-row-live — targeted live verification for
 * VISUAL.examine-damage-type-composite-raw-enum.
 *
 * Examines a Sword of Lost Light (wcid 1427, DamageType Slash|Pierce = 3)
 * and a Lightning Hammer (wcid 1436, DamageType Electric = 64):
 *  - sword examine must show "Damage Type: Slashing/Piercing"
 *    (retail AppraisalSystem::DamageTypeToString @ 005b4200 "/"-join),
 *    never the pre-fix "DamageType #3"
 *  - hammer examine must show "Damage Type: Electrical"
 *    (retail rename; ACE GetName says "Electric")
 * Output: verification/playtest/<utc>-damage-type-row/.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=dmgtype';
const VIEW = { width: 1568, height: 775 };
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-damage-type-row`);

const SWORD_WCID = 1427;   // Sword of Lost Light — DamageType 3 (Slash|Pierce)
const HAMMER_WCID = 1436;  // Lightning Hammer — DamageType 64 (Electric)

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
    w.setAttribute('quickness', 30);
    w.setAttribute('coordination', 40);
    w.setAttribute('endurance', 50);
    w.setAttribute('focus', 100);
    w.setAttribute('self', 100);
    w.name = 'Dmg Tester';
    ui.callbacks.onCharacterCreated(w);
    return { state: 'sent', name: w.name };
  })()`) as Promise<Record<string, unknown>>;
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

async function objects(page: Page): Promise<Array<{ guid: number; name: string; dist: number }>> {
  return page.evaluate(`(() => {
    const me = window.acDebug.collisionState();
    return window.acDebug.getObjects()
      .filter(o => o.pos && o.name)
      .map(o => ({ guid: o.guid, name: o.name,
        dist: Math.hypot(o.pos.x - me.x, o.pos.z - me.z) }))
      .sort((a, b) => a.dist - b.dist);
  })()`) as any;
}

async function faceObject(page: Page, guid: number, yOff: number): Promise<{ x: number; y: number; behind: boolean } | null> {
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

async function rightClickExamine(page: Page, guid: number, yOff: number): Promise<unknown> {
  for (const dy of [yOff, yOff - 0.4, yOff + 0.4]) {
    const sp = await faceObject(page, guid, dy);
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
      // 'Examine' is always the last context-menu option (ContextMenu.ts).
      const found = await page.evaluate(`(() => {
        const menus = [...document.querySelectorAll('div')].filter(d => d.style.position === 'fixed' && d.style.minWidth === '120px');
        if (!menus.length) return null;
        const items = [...menus[menus.length - 1].children];
        if (!items.length) return null;
        items[items.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return { itemCount: items.length };
      })()`);
      if (found) return found;
    }
  }
  // Gesture missed (tiny wandering hitbox): send the identify through the
  // client's real action path — the examine panel still renders through the
  // full shipped showExaminePanel pipeline on the server's response.
  await page.evaluate(`window.__ac.identifyObject(${guid})`);
  return { fallback: 'identifyObject' };
}

/**
 * The examine panel draws every string through ACFontRenderer canvases
 * (no DOM text), so innerText is always empty. Capture the real strings
 * the shipped code renders by tapping the font-render entry points.
 */
async function tapFontRenderer(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    if (window.__fontTapInstalled) return;
    const fr = window.__ac.gameUI.fontRenderer;
    if (!fr) { window.__renderedTexts = null; return; }
    window.__renderedTexts = [];
    for (const m of ['renderTextToCanvas', 'renderWrappedTextToCanvas']) {
      const orig = fr[m].bind(fr);
      fr[m] = (text, ...rest) => { window.__renderedTexts.push(String(text)); return orig(text, ...rest); };
    }
    window.__fontTapInstalled = true;
  })()`);
}

async function examineText(page: Page): Promise<string | null> {
  return page.evaluate(`(() => {
    const t = window.__renderedTexts;
    return t ? t.join('\\n') : (window.__ac.gameUI.examinePanel ? window.__ac.gameUI.examinePanel.innerText : null);
  })()`) as Promise<string | null>;
}

async function talk(page: Page, text: string): Promise<void> {
  await page.evaluate(`window.acDebug.sendTalk(${JSON.stringify(text)})`);
  console.log(`[talk] ${text}`);
}

async function examineBeat(page: Page, label: string, guid: number, yOff: number, expectName: RegExp): Promise<string | null> {
  await tapFontRenderer(page);
  await page.evaluate(`window.__renderedTexts = window.__renderedTexts ? [] : null`);
  const menu = await rightClickExamine(page, guid, yOff);
  await page.waitForTimeout(3500);
  let text = await examineText(page);
  let via: string = 'right-click';
  // Leftover spawns from earlier runs can pile up on the same anchor, so the
  // projected right-click may examine a different stacked object. When the
  // captured panel isn't the expected item, re-drive through the client's
  // real identify action path with the exact guid — the panel still renders
  // through the full shipped showExaminePanel pipeline.
  if (!text || !expectName.test(text)) {
    via = 'identifyObject-retry';
    await page.evaluate(`window.__ac.gameUI.hideExaminePanel && window.__ac.gameUI.hideExaminePanel()`).catch(() => {});
    await page.evaluate(`window.__renderedTexts = window.__renderedTexts ? [] : null`);
    await page.evaluate(`window.__ac.identifyObject(${guid})`);
    await page.waitForTimeout(3500);
    text = await examineText(page);
  }
  await shot(page, label);
  steps.push({ step: label, guid, menu, via, examineText: text });
  if (text) console.log(text.split('\n').slice(0, 25).map(l => '    | ' + l).join('\n'));
  await page.evaluate(`window.__ac.gameUI.hideExaminePanel && window.__ac.gameUI.hideExaminePanel()`).catch(() => {});
  await page.waitForTimeout(500);
  return text;
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

  console.log(`[verify] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCreate(page);
      if (created.state !== 'not-at-create') {
        console.log(`[verify] character create: ${JSON.stringify(created)}`);
        createSent = true; lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[verify] reload (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep looping */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await shot(page, '00-never-entered'); await browser.close(); throw new Error('never entered world'); }
  await page.waitForTimeout(10_000);
  // Teleport to outdoor Holtburg (same anchor as verify-mana-cost-row-live)
  // so the spawned objects are in the open, not behind interior walls that
  // make the projected right-click hit something else.
  await page.evaluate(`window.acDebug.tele('0xA9B40000', 101.9, 25, 94.1)`);
  await page.waitForTimeout(10_000);
  await shot(page, '01-spawn');

  // Beat 1: composite mask — Sword of Lost Light (Slash|Pierce = 3) must
  // show "Damage Type: Slashing/Piercing".
  await talk(page, `@create ${SWORD_WCID}`);
  await page.waitForTimeout(5000);
  let objsNow = await objects(page);
  const sword = objsNow.find(o => /sword/i.test(o.name) && o.dist < 20);
  let swordText: string | null = null;
  if (sword) swordText = await examineBeat(page, '02-examine-sword', sword.guid, 0.2, /Sword of Lost Light/i);
  else steps.push({ step: '02-examine-sword', skipped: 'sword not found', nearest: objsNow.slice(0, 8) });

  // Beat 2: single Electric mask — Lightning Hammer (64) must show the
  // retail "Electrical" rename, not ACE GetName "Electric".
  await talk(page, `@create ${HAMMER_WCID}`);
  await page.waitForTimeout(5000);
  objsNow = await objects(page);
  const hammer = objsNow.find(o => /hammer/i.test(o.name) && o.dist < 20);
  let hammerText: string | null = null;
  if (hammer) hammerText = await examineBeat(page, '03-examine-hammer', hammer.guid, 0.2, /Hammer of Lightning/i);
  else steps.push({ step: '03-examine-hammer', skipped: 'hammer not found', nearest: objsNow.slice(0, 8) });

  await browser.close();

  // The font tap captures label and value as separate render calls, so the
  // row appears as "Damage Type:\nSlashing/Piercing" in the joined text.
  const swordOk = swordText !== null
    && /Damage Type:\s*\n\s*Slashing\/Piercing/.test(swordText)
    && !/DamageType #/.test(swordText);
  const hammerOk = hammerText !== null
    && /Damage Type:\s*\n\s*Electrical\b/.test(hammerText)
    && !/Damage Type:\s*\n\s*Electric\n/.test(hammerText);
  const verdict = {
    swordExamined: swordText !== null,
    swordShowsRetailCompositeJoin: swordOk,
    hammerExamined: hammerText !== null,
    hammerShowsElectricalRename: hammerOk,
    pass: swordOk && hammerOk,
  };
  writeFileSync(join(OUT, 'observations.json'), JSON.stringify({ utc: UTC, url: URL, verdict, steps }, null, 2));
  console.log(`\n[verify] verdict: ${JSON.stringify(verdict)}`);
  console.log(`[verify] wrote ${OUT}`);
  if (!verdict.pass) process.exit(2);
}

main().catch((err) => { console.error(err); process.exit(1); });
