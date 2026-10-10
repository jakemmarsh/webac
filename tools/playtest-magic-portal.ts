/**
 * playtest-magic-portal — discovery mode (d) session #3 covering the beats
 * the prior two runs never reached: MAGIC COMBAT (god-mode caster, Flame
 * Bolt I vs a rabbit, self-buff + heal) and PORTAL USE (the real Holtburg
 * outdoor portal, walk-in collision path and dblclick-Use path), plus
 * regression probes of the two 2026-08-20 gesture fixes (world context menu
 * render, peace-mode dblclick on a vendor) and a magic-panel depth pass
 * (Spellbook + Components tabs vs reference/images/hud/*.jpg).
 *
 * Uses the admin (level 5) testacjs account: @god, @addspell, @comps,
 * @create, @teleloc. Output: verification/playtest/<utc>-magic-portal/.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=playtest3';
const VIEW = { width: 1568, height: 775 };
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-magic-portal`);

// SpellId (reference/ACE/Source/ACE.Entity/Enum/SpellId.cs, implicit numbering)
const FLAME_BOLT_1 = 27;
const ARMOR_SELF_1 = 24;
const HEAL_SELF_1 = 6;

// Holtburg outdoor portal (ace_world landblock_instance guid 2056994907,
// wcid 11960 portalredspire-xp) at 0xA9B40000 (27.325, 137.487, 66.5),
// destination 0x17B2002A (132.623, 25.809, 44.005).
const PORTAL_LB = 0xA9B4;
const PORTAL_POS = { x: 27.325, y: 137.487, z: 66.5 };
const DEST_LB = 0x17B2;

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

const MENU_COUNT = `[...document.querySelectorAll('div')].filter(d => d.style.position === 'fixed' && d.style.minWidth === '120px').length`;

async function rightClickMenu(page: Page, guid: number): Promise<{ x: number; y: number; items: number; labels: string[] } | null> {
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
        const r = items[0]?.getBoundingClientRect();
        return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2, items: items.length,
          labels: items.map(i => (i.textContent || '').trim()) } : null;
      })()`) as { x: number; y: number; items: number; labels: string[] } | null;
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
    return { health: ps.health, mana: ps.mana, level: ps.level };
  })()`) as any;
}

async function knownSpells(page: Page): Promise<Array<{ id: number; name: string }>> {
  return page.evaluate(`window.__ac.magicController ? window.__ac.magicController.knownSpells.map(s => ({ id: s.id, name: s.name })) : (window.__ac.gameUI.knownSpells || []).map(s => ({ id: s.id, name: s.name }))`) as any;
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
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[playtest] create: ${created}`); createSent = true; lastReload = Date.now(); }
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
  steps.push({ step: 'spawn', collision: await collision(page), vitals: await vitals(page) });
  await shot(page, '01-spawn');

  // ── Beat R (regression, 2026-08-20 fixes): context menu renders + peace-mode dblclick opens vendor ──
  phase = 'regression-vendor';
  await page.evaluate(`window.acDebug.tele('0xA9B40100', 84, 127, 66.005)`);
  await page.waitForTimeout(10_000);
  const objsV = await objects(page);
  const vendor = objsV.find(o => /wystan/i.test(o.name)) ?? objsV.find(o => o.dist < 15);
  steps.push({ step: 'regression-interior', nearest: objsV.slice(0, 6) });
  if (vendor) {
    await faceObject(page, vendor.guid);
    const menu = await rightClickMenu(page, vendor.guid);
    await shot(page, '02-regression-context-menu');
    steps.push({ step: 'regression-context-menu', vendor: vendor.name, menu });
    console.log('[playtest] ctx menu:', JSON.stringify(menu?.labels ?? null));
    // dismiss menu with a left-click elsewhere
    await page.mouse.click(VIEW.width - 60, VIEW.height - 60);
    await page.waitForTimeout(800);
    const spD = await faceObject(page, vendor.guid);
    if (spD && !spD.behind) {
      await page.mouse.dblclick(spD.x, spD.y);
      await page.waitForTimeout(4000);
      const inCombat = await page.evaluate(`window.__ac.combatController.isInCombat`);
      const vendorOpen = await page.evaluate(`window.__ac.gameUI.vendorVisible`);
      steps.push({ step: 'regression-dblclick-vendor', inCombat, vendorOpen });
      console.log(`[playtest] dblclick vendor → inCombat=${inCombat} vendorOpen=${vendorOpen}`);
      await shot(page, '03-regression-dblclick-vendor');
      await page.evaluate(`window.__ac.gameUI.hideVendorWindow?.()`).catch(() => {});
    } else {
      steps.push({ step: 'regression-dblclick-vendor', skipped: 'offscreen' });
    }
  } else {
    steps.push({ step: 'regression-context-menu', skipped: 'no vendor found' });
  }

  // ── Beat M0: god-mode caster setup, outdoors ──
  phase = 'magic-setup';
  await page.evaluate(`window.acDebug.tele('0xA9B40000', 101.9, 25, 94.1)`);
  await page.waitForTimeout(10_000);
  await talk(page, '@god');
  await page.waitForTimeout(8000);
  const vitalsGod = await vitals(page);
  steps.push({ step: 'god', vitals: vitalsGod, collision: await collision(page) });
  console.log('[playtest] after @god:', JSON.stringify(vitalsGod));
  for (const id of [FLAME_BOLT_1, ARMOR_SELF_1, HEAL_SELF_1]) {
    await talk(page, `@addspell ${id}`);
    await page.waitForTimeout(2000);
  }
  await talk(page, '@comps');
  await page.waitForTimeout(6000);
  const spells = await knownSpells(page);
  steps.push({ step: 'spells-known', spells });
  console.log('[playtest] known spells:', JSON.stringify(spells));

  // ── Beat M1 (panel depth): magic panel — Spellbook tab + Components tab ──
  phase = 'magic-panel';
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(2500);
  await shot(page, '04-spellbook-panel');
  const compTab = await page.evaluate(`(() => {
    const tabs = [...document.querySelectorAll('div')].filter(d => (d.textContent || '').trim() === 'Components' && d.children.length === 0);
    if (!tabs.length) return 'no-components-tab';
    tabs[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'clicked';
  })()`);
  await page.waitForTimeout(2000);
  steps.push({ step: 'magic-panel', compTab });
  await shot(page, '05-components-panel');
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(1000);

  // ── Beat M2: war magic vs rabbit — Flame Bolt I from spell bar slot 1 ──
  phase = 'magic-combat';
  await talk(page, '@create 2567');
  await page.waitForTimeout(5000);
  const objsR = await objects(page);
  const rabbit = objsR.find(o => /rabbit/i.test(o.name) && o.dist < 40);
  steps.push({ step: 'rabbit', found: rabbit ?? null, nearest: objsR.slice(0, 6) });
  if (rabbit) {
    const spellsNow = await knownSpells(page);
    const boltIdx = spellsNow.findIndex(s => s.id === FLAME_BOLT_1);
    // put Flame Bolt I into spell bar 0 slot 0, then real key gesture Digit1
    await page.evaluate(`window.acDebug.addSpellFavorite(${FLAME_BOLT_1}, 0, 0)`);
    await page.waitForTimeout(1500);
    const spR = await faceObject(page, rabbit.guid, 0.4);
    let selected: unknown = null;
    if (spR && !spR.behind) {
      await page.mouse.click(spR.x, spR.y);       // real gesture: left-click selects
      await page.waitForTimeout(1200);
      selected = await page.evaluate(`window.acDebug.getTarget()`);
    }
    steps.push({ step: 'select-rabbit', screenPos: spR, selected });
    console.log('[playtest] selected:', JSON.stringify(selected));
    await shot(page, '06-rabbit-selected');
    await page.keyboard.press('Digit1');          // real gesture: spell bar slot 1
    // watch the cast for up to 30s
    const castSeries: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(5000);
      const st = await page.evaluate(`(() => {
        const objs = window.acDebug.getObjects();
        const r = objs.find(o => o.guid === ${rabbit.guid});
        return { rabbitPresent: !!r, mana: window.__ac.playerState.mana };
      })()`) as Record<string, unknown>;
      castSeries.push(st);
      if (i === 0) await shot(page, '07-cast-windup');
      if (!st.rabbitPresent) { console.log('[playtest] rabbit gone (killed)'); break; }
      if (i === 2) await page.keyboard.press('Digit1');  // second cast if first fizzled/missed
    }
    steps.push({ step: 'war-cast-series', castSeries });
    await shot(page, '08-after-war-cast');
  }

  // ── Beat M3: self spells — Armor Self I (buff icon) then Heal Self I ──
  phase = 'magic-self';
  const spellsB = await knownSpells(page);
  const armorIdx = spellsB.findIndex(s => s.id === ARMOR_SELF_1);
  if (armorIdx >= 0) {
    await page.evaluate(`window.__ac.gameUI.spellCallbacks.onCastSpell(${armorIdx})`);
    await page.waitForTimeout(8000);
    const ench = await page.evaluate(`(() => {
      const ui = window.__ac.gameUI;
      const m = ui.activeEnchantments;
      return m ? [...m.values()].map(e => ({ spellId: e.spellId, name: e.name, isBeneficial: e.isBeneficial })) : 'no-accessor';
    })()`);
    steps.push({ step: 'armor-self', enchantments: ench });
    console.log('[playtest] enchantments:', JSON.stringify(ench));
    await shot(page, '09-armor-self-buff');
  }
  const healIdx = spellsB.findIndex(s => s.id === HEAL_SELF_1);
  if (healIdx >= 0) {
    await page.evaluate(`window.__ac.gameUI.spellCallbacks.onCastSpell(${healIdx})`);
    await page.waitForTimeout(8000);
    steps.push({ step: 'heal-self', vitals: await vitals(page) });
    await shot(page, '10-heal-self');
  }

  // ── Beat P: portal use — walk into the Holtburg outdoor Redspire portal ──
  phase = 'portal';
  await page.evaluate(`window.acDebug.tele('0x${PORTAL_LB.toString(16).toUpperCase()}0000', ${PORTAL_POS.x - 8}, ${PORTAL_POS.y - 8}, ${PORTAL_POS.z})`);
  await page.waitForTimeout(10_000);
  const objsP = await objects(page);
  const portal = objsP.find(o => /portal/i.test(o.name) && o.dist < 30);
  steps.push({ step: 'portal-approach', found: portal ?? null, nearest: objsP.slice(0, 8), collision: await collision(page) });
  console.log('[playtest] portal:', JSON.stringify(portal ?? null));
  await shot(page, '11-portal-approach');
  if (portal) {
    await faceObject(page, portal.guid, 1.0);
    // Arrival detection: the Redspire teleport moves the player thousands of
    // meters (0xA9B4 → 0x17B2 is ~26km west), so a horizontal jump > 1000m
    // from the approach position means the portal fired. Raw coords are
    // recorded so the destination can be checked offline against
    // 0x17B2002A (132.623, 25.809, 44.005).
    const start = await collision(page);
    const jumped = (c: Record<string, number>) =>
      Math.hypot((c.x ?? 0) - (start.x ?? 0), (c.z ?? 0) - (start.z ?? 0)) > 1000;
    let arrived = false;
    let via = 'none';
    for (let burst = 0; burst < 6 && !arrived; burst++) {
      const near0 = await objects(page);
      if (near0.find(o => o.guid === portal.guid)) await faceObject(page, portal.guid, 1.0);
      await page.keyboard.down('KeyW');
      await page.waitForTimeout(2500);
      await page.keyboard.up('KeyW');
      await page.waitForTimeout(3000);
      const c = await collision(page);
      const near = await objects(page);
      const p2 = near.find(o => o.guid === portal.guid);
      console.log(`[playtest] walk burst ${burst}: pos=(${c.x?.toFixed(1)},${c.z?.toFixed(1)}) portalDist=${p2 ? p2.dist.toFixed(1) : 'gone'}`);
      if (jumped(c)) { arrived = true; via = 'walk-in-collision'; break; }
      if (p2 && p2.dist < 1.5) {
        // standing inside the portal and nothing happened — wait once more
        await page.waitForTimeout(5000);
        if (jumped(await collision(page))) { arrived = true; via = 'walk-in-collision'; break; }
      }
    }
    await shot(page, '12-portal-contact');
    if (!arrived) {
      // dblclick-Use path (retail: dblclick portal = use)
      const spP = await faceObject(page, portal.guid, 1.0);
      if (spP && !spP.behind) {
        await page.mouse.dblclick(spP.x, spP.y);
        for (let i = 0; i < 8 && !arrived; i++) {
          await page.waitForTimeout(3000);
          if (jumped(await collision(page))) { arrived = true; via = 'dblclick-use'; }
        }
      }
    }
    const cEnd = await collision(page);
    steps.push({ step: 'portal-result', arrived, via, start, collision: cEnd });
    console.log(`[playtest] portal result: arrived=${arrived} via=${via} pos=(${cEnd.x?.toFixed(1)},${cEnd.z?.toFixed(1)})`);
    await page.waitForTimeout(12_000);   // let destination stream in
    await shot(page, '13-portal-destination');
    steps.push({ step: 'portal-settled', collision: await collision(page), nearest: (await objects(page)).slice(0, 8) });
  }

  await browser.close();
  const errors = consoleLog.filter(c => c.type !== 'warning');
  writeFileSync(join(OUT, 'observations.json'), JSON.stringify({
    utc: UTC, url: URL, viewport: VIEW, steps,
    consoleErrorCount: errors.length, consoleWarningCount: consoleLog.length - errors.length,
    console: consoleLog, chatLog: chatLog.slice(-300),
  }, null, 2));
  console.log(`\n[playtest] done — ${steps.length} steps, ${errors.length} errors; wrote ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
