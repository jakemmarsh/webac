/**
 * playtest-town — discovery mode (d) targeted session for the beats the
 * 2026-08-19 run cut short: vendor buy/sell + melee combat vs a low-level
 * creature, driven through REAL user gestures (right-click context menu,
 * double-click, DOM clicks on the vendor panel) wherever possible.
 *
 * Uses the admin (level 5) testacjs account for @teleloc/@create/@ci to
 * reach populated Holtburg town (0xA9B4) from the empty starter cottage.
 * Output: verification/playtest/<utc>-town/ screenshots + observations.json.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=playtest2';
const VIEW = { width: 1568, height: 775 };
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-town`);

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

/** Project a server object's mesh position to viewport pixel coords. */
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
  // collisionState x/z are world-horizontal; mesh pos is three.js scene space
  // where x/z are the same world-horizontal axes (y is up).
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

/**
 * Right-click the object via the canvas handler, probing a small grid of aim
 * offsets around the projected anchor until the world context menu appears
 * (the raycast needs to hit actual mesh geometry, so a single fixed offset
 * above the feet can miss). Returns the first menu item's center, or null.
 */
async function rightClickMenu(page: Page, guid: number): Promise<{ x: number; y: number; items: number } | null> {
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
        return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2, items: items.length } : null;
      })()`) as { x: number; y: number; items: number } | null;
      if (found) return found;
    }
  }
  return null;
}

/** Turn in place (real ArrowLeft input) until the object projects on-screen. */
async function faceObject(page: Page, guid: number, yOff = 1.0): Promise<{ x: number; y: number; behind: boolean } | null> {
  for (let i = 0; i < 24; i++) {
    const sp = await screenPos(page, guid, yOff);
    if (sp && !sp.behind && sp.x > 20 && sp.x < VIEW.width - 20 && sp.y > 40 && sp.y < VIEW.height - 20) return sp;
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

async function vendorState(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    if (!ui || !ui.vendorVisible) return null;
    const d = ui.vendorData;
    return { name: d.name, tab: d.tab, buyRate: d.buyRate, sellRate: d.sellRate,
      altCurrencyName: d.altCurrencyName,
      buyItems: d.buyItems.slice(0, 12), sellItems: d.sellItems.slice(0, 12) };
  })()`) as any;
}

async function pyreals(page: Page): Promise<number> {
  return page.evaluate(`(() => {
    const inv = window.__ac.playerState.inventory.getAll();
    const coins = inv.filter(i => /pyreal/i.test(i.name));
    return coins.reduce((s, i) => s + (i.stackSize || 1), 0);
  })()`) as Promise<number>;
}

async function vitals(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(`(() => {
    const ps = window.__ac.playerState;
    return { health: ps.health, level: ps.level };
  })()`) as any;
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

  // ── Beat 1: teleport into Holtburg blacksmith interior ──
  phase = 'tele-vendor';
  await page.evaluate(`window.acDebug.tele('0xA9B40100', 84, 127, 66.005)`);
  await page.waitForTimeout(10_000);
  const afterTele = await collision(page);
  steps.push({ step: 'tele-blacksmith', collision: afterTele });
  await shot(page, '02-blacksmith-interior');

  const objs1 = await objects(page);
  steps.push({ step: 'interior-entities', nearest: objs1.slice(0, 10) });
  console.log('[playtest] interior entities:', objs1.slice(0, 6).map(o => `${o.name}@${o.dist.toFixed(1)}`).join(', '));
  const vendor = objs1.find(o => /blacksmith|smith|armorer/i.test(o.name)) ?? objs1.find(o => o.dist < 15 && o.guid !== 0);
  if (!vendor) { console.log('[playtest] NO VENDOR FOUND — aborting vendor beat'); }

  if (vendor) {
    // ── Beat 2: right-click context menu → Buy/Sell (sanctioned path, clean state) ──
    phase = 'vendor-open';
    let sp = await faceObject(page, vendor.guid);
    steps.push({ step: 'vendor-screenpos', sp, vendor });
    const menuInfo = await rightClickMenu(page, vendor.guid);
    await shot(page, '04-context-menu');
    steps.push({ step: 'context-menu', menuInfo });
    console.log('[playtest] context menu:', JSON.stringify(menuInfo));
    if (menuInfo) {
      await page.mouse.click(menuInfo.x, menuInfo.y);
      // poll for vendor panel up to 8s
      for (let i = 0; i < 8; i++) {
        await page.waitForTimeout(1000);
        if (await page.evaluate(`window.__ac.gameUI.vendorVisible`)) break;
      }
    }
    const vs = await vendorState(page);
    steps.push({ step: 'vendor-panel', vendorState: vs });
    await shot(page, '05-vendor-buy-tab');
    console.log('[playtest] vendor panel:', vs ? `open "${(vs as any).name}" buyItems=${((vs as any).buyItems || []).length}` : 'NOT OPEN');

    if (vs) {
      // ── Beat 4: give coins, buy the selected (first) item via real DOM clicks ──
      phase = 'vendor-buy';
      await talk(page, '@ci 273 5000');
      await page.waitForTimeout(4000);
      const coinsBefore = await pyreals(page);
      // click first buy row then the Buy button (both real DOM nodes)
      const clicked = await page.evaluate(`(() => {
        const rows = [...document.querySelectorAll('div')].filter(d =>
          d.style.borderBottom === '1px solid rgba(60, 50, 40, 0.3)');
        if (!rows.length) return 'no-rows';
        rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return 'row-clicked:' + rows.length;
      })()`);
      await page.waitForTimeout(1000);
      const buyBtnClicked = await page.evaluate(`(() => {
        const btns = [...document.querySelectorAll('div')].filter(d =>
          d.style.width === '64px' && d.style.height === '22px');
        if (!btns.length) return 'no-btn';
        btns[btns.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return 'buy-clicked';
      })()`);
      await page.waitForTimeout(4000);
      const coinsAfterBuy = await pyreals(page);
      const invAfterBuy = await page.evaluate(`window.__ac.playerState.inventory.getAll().map(i => ({ name: i.name, stack: i.stackSize }))`);
      steps.push({ step: 'vendor-buy', clicked, buyBtnClicked, coinsBefore, coinsAfterBuy, invAfterBuy });
      console.log(`[playtest] buy: ${clicked} ${buyBtnClicked} coins ${coinsBefore} -> ${coinsAfterBuy}`);
      await shot(page, '06-after-buy');

      // ── Beat 5: sell tab — select first sellable, sell it ──
      phase = 'vendor-sell';
      const sellTab = await page.evaluate(`(() => {
        const tabs = [...document.querySelectorAll('div')].filter(d =>
          d.style.width === '92px' && d.style.height === '20px');
        if (tabs.length < 2) return 'no-tabs:' + tabs.length;
        tabs[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return 'sell-tab-clicked';
      })()`);
      await page.waitForTimeout(1500);
      await shot(page, '07-vendor-sell-tab');
      const vsSell = await vendorState(page);
      const sellClick = await page.evaluate(`(() => {
        const rows = [...document.querySelectorAll('div')].filter(d =>
          d.style.borderBottom === '1px solid rgba(60, 50, 40, 0.3)');
        if (!rows.length) return 'no-rows';
        rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return 'row-clicked';
      })()`);
      await page.waitForTimeout(800);
      const sellBtn = await page.evaluate(`(() => {
        const btns = [...document.querySelectorAll('div')].filter(d =>
          d.style.width === '64px' && d.style.height === '22px');
        if (!btns.length) return 'no-btn';
        btns[btns.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return 'sell-clicked';
      })()`);
      await page.waitForTimeout(4000);
      const coinsAfterSell = await pyreals(page);
      steps.push({ step: 'vendor-sell', sellTab, vsSell, sellClick, sellBtn, coinsAfterSell });
      console.log(`[playtest] sell: ${sellTab} ${sellClick} ${sellBtn} coins now ${coinsAfterSell}`);
      await shot(page, '08-after-sell');
      // close the vendor panel via its close button path (escape-hatch: hide via UI API)
      await page.evaluate(`window.__ac.gameUI.hideVendorWindow?.()`).catch(() => {});
      await page.waitForTimeout(800);
    }

    // ── Beat 5b: dblclick-on-vendor probe (retail: opens shop / talks — ours?) ──
    phase = 'vendor-dblclick-probe';
    const sp2 = await faceObject(page, vendor.guid);
    if (sp2 && !sp2.behind && sp2.x > 0 && sp2.x < VIEW.width && sp2.y > 0 && sp2.y < VIEW.height) {
      await page.mouse.dblclick(sp2.x, sp2.y);
      await page.waitForTimeout(3000);
      const combatAfterDbl = await page.evaluate(`window.__ac.combatController.isInCombat`);
      const vendorAfterDbl = await vendorState(page);
      steps.push({ step: 'dblclick-vendor-result', enteredCombat: combatAfterDbl, vendorOpened: !!vendorAfterDbl });
      console.log(`[playtest] dblclick vendor → inCombat=${combatAfterDbl} vendorOpen=${!!vendorAfterDbl}`);
      await shot(page, '03-after-dblclick-vendor');
      if (combatAfterDbl) { await page.evaluate(`window.acDebug.combatMode('peace')`); await page.waitForTimeout(1500); }
    } else {
      steps.push({ step: 'dblclick-vendor-result', skipped: 'offscreen', sp: sp2 });
    }
  }

  // ── Beat 6: outdoor combat vs @created drudge skulker ──
  phase = 'tele-outdoor';
  await page.evaluate(`window.acDebug.tele('0xA9B40000', 101.9, 25, 94.1)`);
  await page.waitForTimeout(10_000);
  steps.push({ step: 'tele-outdoor', collision: await collision(page) });
  await shot(page, '09-outdoor-town');

  phase = 'combat';
  // wcid 2567 = rabbitbrown, level 2 — weak enough that a min-attribute L1
  // character can plausibly fight it (a drudge skulker two-shot us on the
  // prior run). Numeric wcid: the name arg fuzzy-matched a statue weenie.
  await talk(page, '@create 2567');
  await page.waitForTimeout(5000);
  const objs2 = await objects(page);
  const drudge = objs2.find(o => /rabbit/i.test(o.name) && o.dist < 30);
  steps.push({ step: 'spawn-drudge', found: drudge ?? null, nearest: objs2.slice(0, 8) });
  if (drudge) {
    console.log(`[playtest] drudge @ ${drudge.dist.toFixed(1)}m guid=0x${drudge.guid.toString(16)}`);
    await shot(page, '10-drudge-spawned');
    const sp = await faceObject(page, drudge.guid, 0.7);
    let attackVia = 'debug';
    if (sp && !sp.behind && sp.x > 0 && sp.x < VIEW.width && sp.y > 40 && sp.y < VIEW.height) {
      await page.mouse.dblclick(sp.x, sp.y);   // real retail gesture: dblclick creature = attack
      attackVia = 'dblclick';
    } else {
      await page.evaluate(`window.acDebug.attack(${drudge.guid})`);
    }
    steps.push({ step: 'attack-start', attackVia, sp });
    // watch the fight for up to 60s, snapshotting
    const hpSeries: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(5000);
      const st = await page.evaluate(`(() => {
        const objs = window.acDebug.getObjects();
        const d = objs.find(o => o.guid === ${drudge.guid});
        const ps = window.__ac.playerState;
        return { drudgePresent: !!d, inCombat: window.__ac.combatController.isInCombat,
          myHealth: ps.health, target: window.acDebug.getTarget() };
      })()`) as Record<string, unknown>;
      hpSeries.push(st);
      if (i === 1) await shot(page, '11-combat-mid');
      const hp = (st.myHealth as { current?: number } | null)?.current;
      if (hp === 0) { console.log('[playtest] PLAYER DIED'); await shot(page, '11b-player-died'); await page.waitForTimeout(8000); await shot(page, '11c-after-death'); break; }
      if (!st.drudgePresent) { console.log('[playtest] target gone (dead/despawned)'); break; }
      // keep swinging if not auto (retry attack every 15s)
      if (i % 3 === 2) await page.evaluate(`window.acDebug.attack(${drudge.guid})`).catch(() => {});
    }
    steps.push({ step: 'combat-series', hpSeries });
    await shot(page, '12-combat-end');

    // corpse loot attempt: find corpse object
    const objs3 = await objects(page);
    const corpse = objs3.find(o => /corpse/i.test(o.name) && o.dist < 30);
    if (corpse) {
      await faceObject(page, corpse.guid, 0.3);
      const menuInfo2 = await rightClickMenu(page, corpse.guid);
      steps.push({ step: 'corpse', corpse, menu: menuInfo2 });
      await shot(page, '13-corpse-menu');
      if (menuInfo2) { await page.mouse.click(menuInfo2.x, menuInfo2.y); await page.waitForTimeout(3000); }
      await shot(page, '14-corpse-open');
    } else {
      steps.push({ step: 'corpse', found: false, nearest: objs3.slice(0, 6) });
    }
  }
  await page.evaluate(`window.acDebug.combatMode('peace')`).catch(() => {});

  await browser.close();
  const errors = consoleLog.filter(c => c.type !== 'warning');
  writeFileSync(join(OUT, 'observations.json'), JSON.stringify({
    utc: UTC, url: URL, viewport: VIEW, steps,
    consoleErrorCount: errors.length, consoleWarningCount: consoleLog.length - errors.length,
    console: consoleLog, chatLog: chatLog.slice(-200),
  }, null, 2));
  console.log(`\n[playtest] done — ${steps.length} steps, ${errors.length} errors; wrote ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
