/**
 * playtest-examine-speed — targeted live verification for
 * VISUAL.examine-speed-row-missing-word.
 *
 * Boots into the ACE world on the admin testacjs account, spawns weapons
 * with known WeaponTime values spanning the retail speed bands
 * (WEAPON_WCIDS env: comma-separated wcids, picked from the world DB),
 * right-click→Examines each on the ground, and asserts the examine panel's
 * Speed row reads "Speed: <Very Fast|Fast|Average|Slow|Very Slow> (N)"
 * with the word matching the retail thresholds from
 * AppraisalSystem::WeaponTimeToString @ 005b4970 (<11 Very Fast, <31 Fast,
 * <=49 Average, <80 Slow, else Very Slow).
 *
 * Output: verification/playtest/<utc>-examine-speed/ (screenshots + JSON).
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=examinespeed';
const VIEW = { width: 1568, height: 775 };
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-examine-speed`);

const WEAPON_WCIDS: number[] = (process.env.WEAPON_WCIDS ?? '')
  .split(',').map(s => Number(s.trim())).filter(n => n > 0);

const steps: Array<Record<string, unknown>> = [];

function expectedWord(t: number): string {
  if (t < 0xb) return 'Very Fast';
  if (t < 0x1f) return 'Fast';
  if (t <= 0x31) return 'Average';
  if (t < 0x50) return 'Slow';
  return 'Very Slow';
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
    w.name = 'Speed Tester';
    ui.callbacks.onCharacterCreated(w);
    return { state: 'sent', name: w.name };
  })()`) as Promise<Record<string, unknown>>;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`[shot] ${name}`);
}

async function screenPos(page: Page, guid: number, yOff = 0.2): Promise<{ x: number; y: number; behind: boolean } | null> {
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
      .map(o => ({ guid: o.guid, name: o.name, dist: Math.hypot(o.pos.x - me.x, o.pos.z - me.z) }))
      .sort((a, b) => a.dist - b.dist);
  })()`) as any;
}

async function faceObject(page: Page, guid: number, yOff: number): Promise<void> {
  for (let i = 0; i < 24; i++) {
    const sp = await screenPos(page, guid, yOff);
    if (sp && !sp.behind && sp.x > VIEW.width * 0.35 && sp.x < VIEW.width * 0.65 && sp.y > 40 && sp.y < VIEW.height - 20) return;
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(350);
    await page.keyboard.up('ArrowLeft');
    await page.waitForTimeout(250);
  }
}

async function rightClickExamine(page: Page, guid: number): Promise<string[] | null> {
  for (const yOff of [0.2, 0.6, 1.0]) {
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
      // 'Examine' is always the last context-menu item (ContextMenu.ts).
      const found = await page.evaluate(`(() => {
        const menus = [...document.querySelectorAll('div')].filter(d => d.style.position === 'fixed' && d.style.minWidth === '120px');
        if (!menus.length) return null;
        const items = [...menus[menus.length - 1].children];
        const labels = items.map(i => (i.textContent || '').trim() || '<canvas>');
        items[items.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return labels;
      })()`) as string[] | null;
      if (found) return found;
    }
  }
  return null;
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
  if (!WEAPON_WCIDS.length) throw new Error('pass WEAPON_WCIDS=<wcid,wcid,...>');
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
  await page.waitForTimeout(10_000);

  await installACTextShim(page);

  // Teleport to the open Holtburg outdoor anchor (same as playtest-fellow-examine)
  // so ground spawns aren't occluded by interior walls/doors.
  const tx = Number(process.env.TELE_X ?? 17.325);
  const ty = Number(process.env.TELE_Y ?? 127.487);
  await page.evaluate(`window.acDebug.tele('0xA9B40000', ${tx}, ${ty}, 66.5)`);
  await page.waitForTimeout(10_000);
  await shot(page, '01-spawn');

  let pass = 0, fail = 0;
  for (let i = 0; i < WEAPON_WCIDS.length; i++) {
    const wcid = WEAPON_WCIDS[i];
    // Step forward so each spawn lands clear of the previous items —
    // overlapping ground piles make the right-click hit the wrong object.
    if (i > 0) {
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(1500);
      await page.keyboard.up('ArrowUp');
      await page.waitForTimeout(500);
    }
    const before = new Set((await objects(page)).map(o => o.guid));
    await page.evaluate(`window.acDebug.sendTalk(${JSON.stringify(`@create ${wcid}`)})`);
    await page.waitForTimeout(5000);
    const objs = await objects(page);
    const item = objs.find(o => o.dist < 20 && !before.has(o.guid));
    if (!item) { steps.push({ wcid, skipped: 'spawn not found', nearest: objs.slice(0, 6) }); fail++; continue; }
    await faceObject(page, item.guid, 0.2);
    const menu = await rightClickExamine(page, item.guid);
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
    const speedLine = lines.find(l => /^Speed:/.test(l)) ?? null;
    const m = speedLine?.match(/^Speed:\s*(Very Fast|Fast|Average|Slow|Very Slow)\s*\((\d+)\)$/)
      ?? speedLine?.match(/^Speed:\s*(Unknown)$/);
    let verdict = 'FAIL';
    if (!opened) verdict = 'FAIL(no-panel)';
    else if (!titleMatches) verdict = 'FAIL(wrong-panel)';
    else if (m && m[2] !== undefined && expectedWord(Number(m[2])) === m[1]) verdict = 'PASS';
    else if (m && m[1] === 'Unknown') verdict = 'PASS(unknown)';
    if (verdict.startsWith('PASS')) pass++; else fail++;
    steps.push({ wcid, name: item.name, menu, handleOpen, opened, titleMatches, speedLine, verdict });
    console.log(`[examine] wcid=${wcid} "${item.name}" opened=${opened} title=${titleMatches} speedLine=${JSON.stringify(speedLine)} → ${verdict}`);
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
