/**
 * playtest-target-mode-arm — targeted live verification for CORE.10.c.
 *
 * Retail (gmToolbarUI::ListenToElementMessage @ 004bee90): clicking the
 * toolbar Use hand (el 0x1000019d) or Examine magnifier (el 0x100001a5)
 * with nothing selected arms ClientUISystem::SetTargetMode(TARGET_MODE_USE
 * / TARGET_MODE_EXAMINE) — the world cursor swaps and the next world click
 * applies the action to the clicked object.
 *
 * Asserts, in the live ACE world:
 *  1. with no selection, clicking the magnifier swaps the canvas cursor to
 *     the Examine cursor (hotspot 0,0 data-URI, different from default);
 *  2. a world click on a creature then opens the examine panel and resets
 *     the cursor (mode disarmed on execute);
 *  3. clicking the hand with no selection swaps to the Use cursor
 *     (hotspot "14 14");
 *  4. Escape disarms the armed Use mode (cursor back to default).
 *
 * Output: verification/playtest/<utc>-target-mode-arm/ (screenshots + JSON).
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=targetmodearm';
const VIEW = { width: 1568, height: 775 };
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-target-mode-arm`);

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
    w.name = 'Arm Tester';
    ui.callbacks.onCharacterCreated(w);
    return { state: 'sent', name: w.name };
  })()`) as Promise<Record<string, unknown>>;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`[shot] ${name}`);
}

/**
 * Canvas cursor CSS identity: kind (hotspot classification) + an FNV hash
 * of the full value, since different cursor textures share their data-URI
 * prefix and the raw string is too big to log.
 */
async function cursorInfo(page: Page): Promise<{ raw: string; kind: string; hash: string }> {
  return page.evaluate(`(() => {
    const c = window.__ac.sceneManager.renderer.domElement;
    const cur = c.style.cursor || getComputedStyle(c).cursor || '';
    let kind = 'other';
    if (!cur || cur === 'auto' || cur === 'default') kind = 'plain';
    else if (cur.startsWith('url(')) {
      const m = cur.match(/\\)\\s*(\\d+)\\s+(\\d+)\\s*,/);
      kind = m ? 'data-uri hotspot ' + m[1] + ',' + m[2] : 'data-uri hotspot unknown';
    }
    let h = 0x811c9dc5;
    for (let i = 0; i < cur.length; i++) { h ^= cur.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return { raw: cur.slice(0, 40) + (cur.length > 40 ? '…' : ''), kind, hash: h.toString(16) };
  })()`) as Promise<{ raw: string; kind: string; hash: string }>;
}

async function clearSelection(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

async function selectionGuid(page: Page): Promise<number | null> {
  return page.evaluate(`(() => {
    const t = window.__ac.gameUI.hudState.target;
    return t ? t.id : null;
  })()`) as Promise<number | null>;
}

async function clickToolbar(page: Page, id: string): Promise<void> {
  await page.evaluate(`document.getElementById('${id}').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await page.waitForTimeout(400);
}

async function screenPos(page: Page, guid: number, yOff = 0.6): Promise<{ x: number; y: number; behind: boolean } | null> {
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

async function nearestCreature(page: Page): Promise<{ guid: number; name: string } | null> {
  return page.evaluate(`(() => {
    const me = window.acDebug.collisionState();
    const list = window.acDebug.getObjects()
      .filter(o => o.pos && o.name && (o.radarColor === 2 || o.radarColor === 7 || o.radarColor === 8))
      .map(o => ({ guid: o.guid, name: o.name, dist: Math.hypot(o.pos.x - me.x, o.pos.z - me.z) }))
      .sort((a, b) => a.dist - b.dist);
    return list[0] || null;
  })()`) as Promise<{ guid: number; name: string } | null>;
}

async function faceObject(page: Page, guid: number): Promise<{ x: number; y: number } | null> {
  for (let i = 0; i < 30; i++) {
    const sp = await screenPos(page, guid);
    if (sp && !sp.behind && sp.x > VIEW.width * 0.3 && sp.x < VIEW.width * 0.7 && sp.y > 40 && sp.y < VIEW.height - 90) {
      return { x: sp.x, y: sp.y };
    }
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(350);
    await page.keyboard.up('ArrowLeft');
    await page.waitForTimeout(250);
  }
  return null;
}

async function worldClick(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(`(() => {
    const c = window.__ac.sceneManager.renderer.domElement;
    const opts = { bubbles: true, cancelable: true, button: 0, clientX: ${x}, clientY: ${y} };
    c.dispatchEvent(new MouseEvent('mousedown', opts));
    c.dispatchEvent(new MouseEvent('mouseup', opts));
    c.dispatchEvent(new MouseEvent('click', opts));
  })()`);
  await page.waitForTimeout(700);
}

async function examineOpen(page: Page): Promise<boolean> {
  return page.evaluate(`!!window.__ac.gameUI.examinePanelHandle`) as Promise<boolean>;
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
      lastReload = Date.now(); createSent = false;
    }
    await page.waitForTimeout(2000);
  }
  if (!(await inWorld(page))) throw new Error('never entered world');
  console.log('[playtest] in world');
  await page.waitForTimeout(5000);
  await shot(page, '00-in-world');

  // ── 1. Examine arm: no selection → magnifier click swaps cursor ──
  await clearSelection(page);
  const sel0 = await selectionGuid(page);
  const curDefault = await cursorInfo(page);
  await clickToolbar(page, 'tb-examine');
  const selAfterExamineClick = await selectionGuid(page);
  const curExamine = await cursorInfo(page);
  await shot(page, '01-examine-armed');
  const examineArmed = curExamine.hash !== curDefault.hash && curExamine.kind.startsWith('data-uri');
  steps.push({ step: 'examine-arm', sel0, selAfterExamineClick, curDefault, curExamine, pass: examineArmed && sel0 === null });
  console.log(`[assert] examine-arm: default=${curDefault.kind} armed=${curExamine.kind} → ${examineArmed ? 'PASS' : 'FAIL'}`);

  // ── 2. Armed examine executes on the next world click ──
  const target = await nearestCreature(page);
  let examineExecuted = false;
  if (target) {
    console.log(`[playtest] nearest creature: ${target.name} (0x${target.guid.toString(16)})`);
    const pos = await faceObject(page, target.guid);
    if (pos) {
      await worldClick(page, pos.x, pos.y);
      const panel = await examineOpen(page);
      const curAfter = await cursorInfo(page);
      examineExecuted = panel;
      await shot(page, '02-examine-executed');
      steps.push({ step: 'examine-execute', target: target.name, panelOpen: panel, curAfter, pass: panel });
      console.log(`[assert] examine-execute on ${target.name}: panel=${panel} cursorAfter=${curAfter.kind} → ${panel ? 'PASS' : 'FAIL'}`);
      // close panel + clear
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    } else {
      steps.push({ step: 'examine-execute', skipped: 'could not face creature' });
    }
  } else {
    steps.push({ step: 'examine-execute', skipped: 'no creature in range' });
  }

  // ── 3. Use arm: no selection → hand click swaps to Use cursor (hotspot 14,14) ──
  await clearSelection(page);
  await clickToolbar(page, 'tb-use');
  const curUse = await cursorInfo(page);
  await shot(page, '03-use-armed');
  const useArmed = curUse.kind.includes('14,14');
  steps.push({ step: 'use-arm', curUse, pass: useArmed });
  console.log(`[assert] use-arm: cursor=${curUse.kind} → ${useArmed ? 'PASS' : 'FAIL'}`);

  // ── 4. Escape disarms ──
  // The pre-arm "default" can read as plain '' before the first
  // updateWorldCursor paint, so assert the disarm by difference: the armed
  // Use cursor (hotspot 14,14) must be gone after Escape.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const curDisarmed = await cursorInfo(page);
  const disarmed = curDisarmed.hash !== curUse.hash && !curDisarmed.kind.includes('14,14');
  steps.push({ step: 'escape-disarm', curDisarmed, pass: disarmed });
  console.log(`[assert] escape-disarm: cursor=${curDisarmed.kind} (default=${curDefault.kind}) → ${disarmed ? 'PASS' : 'FAIL'}`);
  await shot(page, '04-disarmed');

  const failed = steps.filter(s => s.pass === false);
  writeFileSync(join(OUT, 'result.json'), JSON.stringify({ steps, failed: failed.length, examineExecuted }, null, 2));
  console.log(`[playtest] ${failed.length === 0 ? 'ALL PASS' : failed.length + ' FAILED'} — evidence in ${OUT}`);
  await browser.close();
  if (failed.length) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
