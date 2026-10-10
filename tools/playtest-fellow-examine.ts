/**
 * playtest-fellow-examine — discovery mode (d) session #4 covering the beats
 * the 2026-08-20c hand-off left unexplored: EXAMINE-PANEL DEPTH (creature,
 * NPC, item-with-appraisal, portal — real right-click → Examine gesture),
 * TRAINED-CASTER combat (a fresh character created through the real chargen
 * wizard with War Magic trained — NOT @god, so the live skill check /
 * fizzle / mana pipeline runs with genuine skill values), and FELLOWSHIP
 * (solo create through the real social-panel name input + Create button,
 * openness toggle, quit — ACE FellowshipCreate is solo-legal).
 *
 * Uses the admin (level 5) testacjs account for @create/@addspell/@comps
 * only (item spawning + spell granting), never @god.
 * Output: verification/playtest/<utc>-fellow-examine/.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=playtest4';
const VIEW = { width: 1568, height: 775 };
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-fellow-examine`);

const RABBIT_WCID = 2567;
// Item with appraisal depth (spells/armor/damage). Overridable per-run from a
// world-DB query; default 344 = drudgestaff? — pass EXAMINE_WCID explicitly.
const EXAMINE_WCID = Number(process.env.EXAMINE_WCID ?? 0);
const FLAME_BOLT_1 = 27;
const SKILL_WAR_MAGIC = 34;
const SKILL_MANA_CONVERSION = 16;

// Holtburg outdoor Redspire portal (same anchor as playtest-magic-portal).
const PORTAL_TELE = { cell: '0xA9B40000', x: 27.325 - 10, y: 137.487 - 10, z: 66.5 };

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

/**
 * Caster chargen: drive the REAL wizard object at the character-create
 * screen — attributes via setAttribute (ACE ValidateAttributeCredits:
 * each 10-100, sum of raises == heritage credits), War Magic (+ Mana
 * Conversion if affordable) via trainSkill with the heritage CG costs.
 */
async function driveCasterCreate(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return { state: 'not-at-create' };
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return { state: 'no-hooks' };
    const w = ui.wizard;
    const heritage = ui.characterGenerator && ui.characterGenerator.heritageGroups.get(w.heritage);
    if (!heritage) return { state: 'no-heritage-cg' };
    // attributes: caster spread summing to exactly 330 (ACE
    // ValidateAttributeCredits: sum of VALUES <= heritage AttributeCredits,
    // each in [10,100])
    w.setAttribute('quickness', 30);
    w.setAttribute('coordination', 40);
    w.setAttribute('endurance', 50);
    w.setAttribute('focus', 100);
    w.setAttribute('self', 100);
    const trained = [];
    for (const skillId of [${SKILL_WAR_MAGIC}, ${SKILL_MANA_CONVERSION}]) {
      const cg = heritage.skills.find(s => s.skillNum === skillId);
      if (!cg) { trained.push({ skillId, ok: false, reason: 'not-in-heritage-cg' }); continue; }
      const ok = w.trainSkill(skillId, cg.normalCost);
      trained.push({ skillId, cost: cg.normalCost, ok });
    }
    w.name = 'Caster Tester';
    const validation = typeof w.validate === 'function' ? w.validate() : 'no-validate';
    ui.callbacks.onCharacterCreated(w);
    return {
      state: 'sent', name: w.name,
      attributes: { ...w.attributes },
      attributeCredits: w.attributeCredits,
      skillCredits: w.skillCredits, skillCreditsUsed: w.skillCreditsUsed,
      trained, validation,
    };
  })()`) as Promise<Record<string, unknown>>;
}

async function collision(page: Page): Promise<Record<string, number>> {
  return page.evaluate(`window.acDebug.collisionState()`) as Promise<Record<string, number>>;
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

/** Right-click an object and, if requested, click the menu item whose label matches. */
async function rightClickMenu(page: Page, guid: number, clickLabel?: string): Promise<{ labels: string[]; clicked?: string } | null> {
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
      // Menu labels are AC-font canvases (no textContent). 'Examine' is
      // ALWAYS the last option for every entity type (ContextMenu.ts), so
      // "click Examine" = click the last item.
      const found = await page.evaluate(`(() => {
        const menus = [...document.querySelectorAll('div')].filter(d => d.style.position === 'fixed' && d.style.minWidth === '120px');
        if (!menus.length) return null;
        const items = [...menus[menus.length - 1].children];
        const labels = items.map(i => (i.textContent || '').trim() || '<canvas>');
        const want = ${JSON.stringify(clickLabel ?? null)};
        if (want === 'Examine' && items.length) {
          items[items.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return { labels, clicked: 'last-item(Examine)', itemCount: items.length };
        }
        return { labels, itemCount: items.length };
      })()`) as { labels: string[]; clicked?: string } | null;
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

async function talk(page: Page, text: string): Promise<void> {
  await page.evaluate(`window.acDebug.sendTalk(${JSON.stringify(text)})`);
  console.log(`[talk] ${text}`);
}

async function vitals(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(`(() => {
    const ps = window.__ac.playerState;
    return { health: ps.health, mana: ps.mana, maxMana: ps.maxMana, level: ps.level };
  })()`) as any;
}

/** Dump the examine panel's visible text (null if no panel is open). */
async function examineText(page: Page): Promise<string | null> {
  return page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const p = ui.examinePanel;
    return p ? p.innerText : null;
  })()`) as Promise<string | null>;
}

/** Skill state from the live player (SkillSystem: advancement class + raises). */
async function skillState(page: Page): Promise<unknown> {
  return page.evaluate(`(() => {
    const ps = window.__ac.playerState;
    const out = [];
    for (const id of [${SKILL_WAR_MAGIC}, ${SKILL_MANA_CONVERSION}]) {
      out.push({ id,
        advancementClass: ps.skills.getAdvancementClass(id),
        raises: ps.skills.getRaises(id) });
    }
    return out;
  })()`);
}

async function examineBeat(page: Page, label: string, guid: number, yOff: number): Promise<void> {
  await faceObject(page, guid, yOff);
  const menu = await rightClickMenu(page, guid, 'Examine');
  await page.waitForTimeout(3500);
  const text = await examineText(page);
  await shot(page, label);
  steps.push({ step: label, guid, menu, examineText: text });
  console.log(`[examine] ${label}: menu=${JSON.stringify(menu?.labels ?? null)} textLen=${text?.length ?? 0}`);
  if (text) console.log(text.split('\n').slice(0, 25).map(l => '    | ' + l).join('\n'));
  // close panel: examine panel close via hideExaminePanel
  await page.evaluate(`window.__ac.gameUI.hideExaminePanel && window.__ac.gameUI.hideExaminePanel()`).catch(() => {});
  await page.waitForTimeout(500);
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

  console.log(`[playtest] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCasterCreate(page);
      if (created.state !== 'not-at-create') {
        console.log(`[playtest] caster create: ${JSON.stringify(created)}`);
        steps.push({ step: 'caster-create', ...created });
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

  phase = 'settle';
  await page.waitForTimeout(10_000);
  steps.push({ step: 'spawn', collision: await collision(page), vitals: await vitals(page), skills: await skillState(page) });
  await shot(page, '01-spawn');

  // ── Beat E: examine-panel depth ──
  phase = 'examine';
  // E1 creature: spawn a rabbit outdoors near us
  await talk(page, `@create ${RABBIT_WCID}`);
  await page.waitForTimeout(5000);
  let objsNow = await objects(page);
  const rabbit = objsNow.find(o => /rabbit/i.test(o.name) && o.dist < 40);
  if (rabbit) await examineBeat(page, '02-examine-rabbit', rabbit.guid, 0.4);
  else steps.push({ step: '02-examine-rabbit', skipped: 'no rabbit', nearest: objsNow.slice(0, 6) });

  // E2 item: spawn the appraisal-rich item and examine it on the ground
  if (EXAMINE_WCID > 0) {
    await talk(page, `@create ${EXAMINE_WCID}`);
    await page.waitForTimeout(5000);
    objsNow = await objects(page);
    const known = new Set([rabbit?.guid]);
    const item = objsNow.find(o => o.dist < 20 && !known.has(o.guid) && !/rabbit|tester/i.test(o.name) && o.radarColor !== undefined);
    if (item) await examineBeat(page, '03-examine-item', item.guid, 0.2);
    else steps.push({ step: '03-examine-item', skipped: 'item not found', nearest: objsNow.slice(0, 8) });
  }

  // E3 portal: tele to the Holtburg outdoor portal and examine it
  await page.evaluate(`window.acDebug.tele('${PORTAL_TELE.cell}', ${PORTAL_TELE.x}, ${PORTAL_TELE.y}, ${PORTAL_TELE.z})`);
  await page.waitForTimeout(10_000);
  objsNow = await objects(page);
  const portal = objsNow.find(o => /portal/i.test(o.name) && o.dist < 40);
  if (portal) await examineBeat(page, '04-examine-portal', portal.guid, 1.0);
  else steps.push({ step: '04-examine-portal', skipped: 'no portal', nearest: objsNow.slice(0, 8) });

  // E4 NPC: interior vendor (Wystan anchor from run #3)
  await page.evaluate(`window.acDebug.tele('0xA9B40100', 84, 127, 66.005)`);
  await page.waitForTimeout(10_000);
  objsNow = await objects(page);
  const npc = objsNow.find(o => /wystan/i.test(o.name)) ?? objsNow.find(o => o.dist < 15 && !/tester/i.test(o.name));
  if (npc) await examineBeat(page, '05-examine-npc', npc.guid, 1.0);
  else steps.push({ step: '05-examine-npc', skipped: 'no npc', nearest: objsNow.slice(0, 8) });

  // ── Beat C: trained-caster combat (NO @god) ──
  phase = 'caster-combat';
  await page.evaluate(`window.acDebug.tele('0xA9B40000', 101.9, 25, 94.1)`);
  await page.waitForTimeout(10_000);
  await talk(page, `@addspell ${FLAME_BOLT_1}`);
  await page.waitForTimeout(2500);
  await talk(page, '@comps');
  await page.waitForTimeout(6000);
  steps.push({ step: 'caster-setup', vitals: await vitals(page), skills: await skillState(page) });
  await talk(page, `@create ${RABBIT_WCID}`);
  await page.waitForTimeout(5000);
  objsNow = await objects(page);
  const target = objsNow.find(o => /rabbit/i.test(o.name) && o.dist < 40);
  steps.push({ step: 'caster-target', found: target ?? null, nearest: objsNow.slice(0, 6) });
  if (target) {
    await page.evaluate(`window.acDebug.addSpellFavorite(${FLAME_BOLT_1}, 0, 0)`);
    await page.waitForTimeout(1500);
    const spT = await faceObject(page, target.guid, 0.4);
    let selected: unknown = null;
    if (spT && !spT.behind && Number.isFinite(spT.x) && Number.isFinite(spT.y)
        && spT.x >= 0 && spT.x < VIEW.width && spT.y >= 0 && spT.y < VIEW.height) {
      await page.mouse.click(spT.x, spT.y);
      await page.waitForTimeout(1200);
      selected = await page.evaluate(`window.acDebug.getTarget()`);
    }
    steps.push({ step: 'caster-select', screenPos: spT, selected });
    await shot(page, '06-caster-selected');
    const manaBefore = await vitals(page);
    await page.keyboard.press('Digit1');
    const castSeries: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(5000);
      const st = await page.evaluate(`(() => {
        const objs = window.acDebug.getObjects();
        const r = objs.find(o => o.guid === ${target.guid});
        return { rabbitPresent: !!r, mana: window.__ac.playerState.mana };
      })()`) as Record<string, unknown>;
      castSeries.push(st);
      if (i === 0) await shot(page, '07-cast-windup');
      if (!st.rabbitPresent) { console.log('[playtest] rabbit gone (killed)'); break; }
      if (i === 2 || i === 5) await page.keyboard.press('Digit1'); // recast on fizzle/miss
    }
    steps.push({ step: 'trained-cast-series', manaBefore, castSeries, vitalsAfter: await vitals(page) });
    await shot(page, '08-after-trained-cast');
  }

  // ── Beat F: fellowship — create solo via the real panel, toggle openness, quit ──
  phase = 'fellowship';
  await page.evaluate(`window.__ac.gameUI.toggleSocialPanel()`);
  await page.waitForTimeout(2500);
  await shot(page, '09-social-fellowship-empty');
  const preState = await page.evaluate(`(() => {
    const panel = window.__ac.gameUI.socialPanel;
    if (!panel) return { hasPanel: false };
    const input = panel.querySelector('.fellowship-name-input');
    const btns = [...panel.querySelectorAll('div')].filter(d => /create fellowship/i.test((d.textContent || '').trim()));
    return { hasPanel: true, hasInput: !!input, createBtns: btns.length, panelTextHead: panel.innerText.slice(0, 300) };
  })()`);
  steps.push({ step: 'fellowship-panel-empty', preState });
  console.log('[playtest] fellowship empty state:', JSON.stringify(preState));
  const createResult = await page.evaluate(`(() => {
    const panel = window.__ac.gameUI.socialPanel;
    if (!panel) return 'no-panel';
    const input = panel.querySelector('.fellowship-name-input');
    if (!input) return 'no-input';
    input.value = 'Playtest Fellows';
    const btns = [...panel.querySelectorAll('div')].filter(d => /create fellowship/i.test((d.textContent || '').trim()));
    if (!btns.length) return 'no-button';
    btns[btns.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'clicked';
  })()`);
  await page.waitForTimeout(6000);
  const fellowData = await page.evaluate(`window.__ac.gameUI.fellowshipData`);
  steps.push({ step: 'fellowship-created', createResult, fellowData });
  console.log('[playtest] fellowship create:', createResult, JSON.stringify(fellowData));
  await shot(page, '10-fellowship-created');

  // openness toggle (leader-only; we are the leader)
  const openResult = await page.evaluate(`(() => {
    const panel = window.__ac.gameUI.socialPanel;
    if (!panel) return 'no-panel';
    const btns = [...panel.querySelectorAll('div')].filter(d => /^(Open|Close)$/.test((d.textContent || '').trim()));
    if (!btns.length) return 'no-openness-button';
    const label = (btns[btns.length - 1].textContent || '').trim();
    btns[btns.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return label;
  })()`);
  await page.waitForTimeout(5000);
  const fellowData2 = await page.evaluate(`window.__ac.gameUI.fellowshipData`);
  steps.push({ step: 'fellowship-openness', openResult, fellowData: fellowData2 });
  console.log('[playtest] openness toggle:', openResult, JSON.stringify(fellowData2));
  await shot(page, '11-fellowship-openness');

  // quit (real button routes '/fellow quit' through chat)
  const quitResult = await page.evaluate(`(() => {
    const panel = window.__ac.gameUI.socialPanel;
    if (!panel) return 'no-panel';
    const btns = [...panel.querySelectorAll('div')].filter(d => /^quit$/i.test((d.textContent || '').trim()));
    if (!btns.length) return 'no-quit-button';
    btns[btns.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'clicked';
  })()`);
  await page.waitForTimeout(6000);
  const fellowData3 = await page.evaluate(`window.__ac.gameUI.fellowshipData`);
  steps.push({ step: 'fellowship-quit', quitResult, fellowData: fellowData3 });
  console.log('[playtest] quit:', quitResult, JSON.stringify(fellowData3));
  await shot(page, '12-fellowship-after-quit');

  await browser.close();
  const errors = consoleLog.filter(c => c.type !== 'warning');
  writeFileSync(join(OUT, 'observations.json'), JSON.stringify({
    utc: UTC, url: URL, viewport: VIEW, examineWcid: EXAMINE_WCID, steps,
    consoleErrorCount: errors.length, consoleWarningCount: consoleLog.length - errors.length,
    console: consoleLog, chatLog: chatLog.slice(-400),
  }, null, 2));
  console.log(`\n[playtest] done — ${steps.length} steps, ${errors.length} errors; wrote ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
