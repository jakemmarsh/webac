/**
 * playtest-examine-booster — targeted live verification for
 * BUG.appraisal-booster-vital-enum-off-by-one.
 *
 * Boots into the ACE world on the admin testacjs account, spawns booster
 * items (potions/food) with known BoosterEnum values from the world DB
 * (BOOSTER_WCIDS env: comma-separated wcid:enum:value triples, e.g.
 * "690:2:50" = wcid 690, BoosterEnum 2 (Health), BoostValue 50),
 * Examines each via the real network identify round-trip
 * (__ac.identifyObject → onIdentifyResponse → showExaminePanel; the
 * right-click ray misses tiny ground potions), and asserts the panel's
 * booster row reads "Restores: <N> <Health|Stamina|Mana>" per the
 * PropertyAttribute2nd CURRENT vitals (Health=2, Stamina=4, Mana=6 —
 * ACE PropertyAttribute2nd.cs; retail client dispatches only on 2/4/6).
 *
 * Output: verification/playtest/<utc>-examine-booster/ (screenshots + JSON).
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=examinebooster';
const VIEW = { width: 1568, height: 775 };
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-examine-booster`);

interface BoosterSpec { wcid: number; boosterEnum: number; boostValue: number }
const BOOSTERS: BoosterSpec[] = (process.env.BOOSTER_WCIDS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(s => {
    const [wcid, boosterEnum, boostValue] = s.split(':').map(Number);
    return { wcid, boosterEnum, boostValue };
  });

const steps: Array<Record<string, unknown>> = [];

function expectedVital(e: number): string | null {
  if (e === 2) return 'Health';
  if (e === 4) return 'Stamina';
  if (e === 6) return 'Mana';
  return null;
}

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
    w.name = 'Booster Tester';
    ui.callbacks.onCharacterCreated(w);
    return { state: 'sent', name: w.name };
  })()`) as Promise<Record<string, unknown>>;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`[shot] ${name}`);
}


async function objects(page: Page): Promise<Array<{ guid: number; name: string; dist: number }>> {
  return page.evaluate(`(() => {
    const me = window.acDebug.collisionState();
    return window.acDebug.getObjects()
      .filter(o => o.pos && o.name)
      .map(o => ({ guid: o.guid, name: o.name, dist: Math.hypot(o.pos.x - me.x, o.pos.z - me.z) }))
      .sort((a, b) => a.dist - b.dist);
  })()`) as any;
}



/**
 * Panel rows are AC-bitmap-font canvases (renderACText), so innerText is
 * empty. Shim renderACText to stamp each rendered element with its source
 * string via data-actext — pixels stay identical, text becomes readable.
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

async function examineText(page: Page): Promise<{ text: string | null; handleOpen: boolean }> {
  return page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const p = ui.examinePanel;
    if (!p) return { text: null, handleOpen: !!ui.examinePanelHandle };
    const lines = [...p.querySelectorAll('div')]
      .map(d => [...d.children]
        .filter(c => c.hasAttribute && c.hasAttribute('data-actext'))
        .map(c => c.getAttribute('data-actext'))
        .join(' '))
      .filter(Boolean);
    return { text: lines.join('\\n') || p.innerText || null, handleOpen: !!ui.examinePanelHandle };
  })()`) as Promise<{ text: string | null; handleOpen: boolean }>;
}

async function main(): Promise<void> {
  if (!BOOSTERS.length) throw new Error('pass BOOSTER_WCIDS=<wcid:enum:value,...>');
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync('/opt/pw-browsers/chromium') ? { executablePath: '/opt/pw-browsers/chromium' } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  // A crashed/wedged renderer makes page.evaluate hang forever (no timeout
  // governs it) — surface it and bail instead of hanging the whole run.
  page.on('crash', () => { console.error('[playtest] PAGE CRASHED'); process.exit(2); });
  page.on('pageerror', e => console.error(`[pageerror] ${e.message}`));

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
  await page.waitForTimeout(10_000);

  await installACTextShim(page);

  // Teleport to the open Holtburg outdoor anchor (same as playtest-examine-speed)
  // so ground spawns aren't occluded by interior walls/doors.
  const tx = Number(process.env.TELE_X ?? 17.325);
  const ty = Number(process.env.TELE_Y ?? 127.487);
  await page.evaluate(`window.acDebug.tele('0xA9B40000', ${tx}, ${ty}, 66.5)`);
  await page.waitForTimeout(10_000);
  await shot(page, '01-spawn');

  let pass = 0, fail = 0;
  for (let i = 0; i < BOOSTERS.length; i++) {
    const { wcid, boosterEnum, boostValue } = BOOSTERS[i];
    const before = new Set((await objects(page)).map(o => o.guid));
    await page.evaluate(`window.acDebug.sendTalk(${JSON.stringify(`@create ${wcid}`)})`);
    await page.waitForTimeout(5000);
    const objs = await objects(page);
    const item = objs.find(o => o.dist < 20 && !before.has(o.guid));
    if (!item) { steps.push({ wcid, skipped: 'spawn not found', nearest: objs.slice(0, 6) }); fail++; continue; }
    // Ground potions are tiny meshes — the right-click ray misses far more
    // often than it hits (first run: 0/3 menus), and the mouse/keyboard
    // choreography wedged the SwiftShader page on the second run. Drive the
    // debug identify hook directly instead: it sends the same identify
    // request over the real network and the response drives the same
    // onIdentifyResponse → showExaminePanel path; only mouse targeting
    // (not what this bug touches) is bypassed.
    const menu = ['<identifyObject>'];
    console.log(`[item] wcid=${wcid} guid=${item.guid} "${item.name}" — sending identify`);
    await page.evaluate(`window.__ac.identifyObject(${item.guid})`);
    // Poll for the panel actually opening (identify roundtrip).
    let opened = false;
    for (let t = 0; t < 12; t++) {
      await page.waitForTimeout(500);
      opened = await page.evaluate(`!!window.__ac.gameUI.examinePanel`) as boolean;
      if (opened) break;
    }
    await page.waitForTimeout(500);
    const { text, handleOpen } = await examineText(page);
    await shot(page, `0${i + 2}-examine-${wcid}`);
    const lines = text?.split('\n').map(l => l.trim()) ?? [];
    // The panel's first AC-text line is the examined object's name — require
    // it to match so a stale or wrong-target panel can never false-pass.
    const titleMatches = lines.length > 0 && lines[0] === item.name;
    const boosterLine = lines.find(l => /^(Restores|Drains):/.test(l)) ?? null;
    const vital = expectedVital(boosterEnum);
    const verb = boostValue > 0 ? 'Restores' : 'Drains';
    const expected = vital ? `${verb}: ${Math.abs(boostValue)} ${vital}` : null;
    let verdict = 'FAIL';
    if (!opened) verdict = 'FAIL(no-panel)';
    else if (!titleMatches) verdict = 'FAIL(wrong-panel)';
    else if (expected && boosterLine === expected) verdict = 'PASS';
    else if (boosterLine && /Vital #\d+/.test(boosterLine)) verdict = 'FAIL(vital-fallback)';
    if (verdict === 'PASS') pass++; else fail++;
    steps.push({ wcid, boosterEnum, boostValue, name: item.name, menu, handleOpen, opened, titleMatches, boosterLine, expected, verdict });
    console.log(`[examine] wcid=${wcid} "${item.name}" opened=${opened} title=${titleMatches} boosterLine=${JSON.stringify(boosterLine)} expected=${JSON.stringify(expected)} → ${verdict}`);
    if (text) console.log(text.split('\n').slice(0, 12).map(l => '    | ' + l).join('\n'));
    // Close and wait until the panel is really gone.
    await page.evaluate(`window.__ac.gameUI.hideExaminePanel && window.__ac.gameUI.hideExaminePanel()`).catch(() => {});
    for (let t = 0; t < 6; t++) {
      const open = await page.evaluate(`!!window.__ac.gameUI.examinePanel`) as boolean;
      if (!open) break;
      await page.waitForTimeout(500);
    }
  }

  writeFileSync(join(OUT, 'steps.json'), JSON.stringify({ url: URL, steps, pass, fail }, null, 2));
  await browser.close();
  console.log(`[playtest] done: ${pass} pass, ${fail} fail → ${OUT}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
