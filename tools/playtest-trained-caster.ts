/**
 * playtest-trained-caster — discovery mode (d) session #4, beat 2: create a
 * fresh character through the REAL chargen wizard with War Magic + Mana
 * Conversion trained and a caster attribute spread (Focus/Self 100), then
 * cast Flame Bolt I at a rabbit with genuine (non-@god) skill values — the
 * live trained-skill check / fizzle / mana pipeline.
 *
 * Run with the stack up. Uses &autoenter=false so an existing character on
 * the account (the bundle DB ships with "Perf Tester") doesn't swallow the
 * login; drives GameUI.showCharacterCreate() from character select.
 * Output: verification/playtest/<utc>-trained-caster/.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = '/home/user/acjs';
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&autoenter=false&cb=playtest4c';
const VIEW = { width: 1568, height: 775 };
const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(REPO, 'verification', 'playtest', `${UTC}-trained-caster`);

const RABBIT_WCID = 2567;
const FLAME_BOLT_1 = 27;
const SKILL_WAR_MAGIC = 34;
const SKILL_MANA_CONVERSION = 16;
const CHAR_NAME = 'Caster Tester';

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

async function currentScreen(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    return ui && ui.ui ? String(ui.ui.currentScreen) : 'no-ui';
  })()`) as Promise<string>;
}

async function driveCasterCreate(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return { state: 'not-at-create' };
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return { state: 'no-hooks' };
    const w = ui.wizard;
    const heritage = ui.characterGenerator && ui.characterGenerator.heritageGroups.get(w.heritage);
    if (!heritage) return { state: 'no-heritage-cg' };
    // caster spread summing to exactly 330 (ACE ValidateAttributeCredits:
    // sum of VALUES <= heritage AttributeCredits, each in [10,100])
    w.setAttribute('quickness', 30);
    w.setAttribute('coordination', 40);
    w.setAttribute('endurance', 50);
    w.setAttribute('focus', 100);
    w.setAttribute('self', 100);
    // Costs come from the DAT SkillTable (heritage CG only lists the free
    // racial skill in the EoL DAT — Aluvian: skillNum 14 Arcane Lore at
    // cost 0). Mirrors GameUI's chargen skill list: heritage override when
    // present, else SkillTable trainedCost — exactly ACE PlayerFactory.
    const chargen = ui.getChargenSkills();
    const trained = [];
    for (const skillId of [${SKILL_WAR_MAGIC}, ${SKILL_MANA_CONVERSION}]) {
      const cg = heritage.skills.find(s => s.skillNum === skillId);
      const st = chargen.find(s => s.id === skillId);
      if (!st && !cg) { trained.push({ skillId, ok: false, reason: 'not-in-skilltable-chargen' }); continue; }
      const cost = cg ? cg.normalCost : st.skill.trainedCost;
      const ok = w.trainSkill(skillId, cost);
      trained.push({ skillId, cost, ok });
    }
    w.name = ${JSON.stringify(CHAR_NAME)};
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

async function inventory(page: Page): Promise<unknown> {
  return page.evaluate(`window.__ac.playerState.inventory.getAll().map(i => ({ guid: i.guid ?? i.id, name: i.name }))`);
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

  console.log(`[caster] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // Reach character select (autoenter=false parks there), then open the
  // create wizard and submit the caster build. Phantom-session windows can
  // still force reloads.
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    const screen = await currentScreen(page);
    if (screen === 'character-select') {
      // Enter a pre-existing Caster Tester (earlier partial run) rather
      // than bouncing off NameInUse; create only if the slot is absent.
      const entered = await page.evaluate(`(() => {
        const ui = window.__ac.gameUI;
        const slots = (ui.selectScreen && ui.selectScreen.slots) || [];
        const m = slots.find(s => /caster tester/i.test(s.name || ''));
        if (m && ui.callbacks && ui.callbacks.onEnterWorld) { ui.callbacks.onEnterWorld(m); return 'entered-existing'; }
        return 'no-slot';
      })()`).catch(() => 'enter-error');
      if (entered === 'entered-existing') {
        console.log('[caster] entering pre-existing Caster Tester');
        steps.push({ step: 'enter-existing' });
        lastReload = Date.now();
      } else if (!createSent) {
        await page.evaluate(`window.__ac.gameUI.showCharacterCreate()`);
        await page.waitForTimeout(2000);
        await shot(page, 'c01-create-wizard');
      }
    }
    if (!createSent && (await currentScreen(page)) === 'character-create') {
      const created = await driveCasterCreate(page);
      console.log(`[caster] create: ${JSON.stringify(created)}`);
      steps.push({ step: 'caster-create', ...created });
      if (created.state === 'sent') { createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[caster] reload (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep looping */ }
      createSent = false;
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await shot(page, 'c00-never-entered'); await browser.close(); throw new Error('never entered world'); }

  phase = 'settle';
  await page.waitForTimeout(10_000);
  const spawnInfo = { collision: await collision(page), vitals: await vitals(page), skills: await skillState(page), inventory: await inventory(page) };
  steps.push({ step: 'spawn', ...spawnInfo });
  console.log('[caster] spawn:', JSON.stringify(spawnInfo.vitals), JSON.stringify(spawnInfo.skills));
  console.log('[caster] inventory:', JSON.stringify(spawnInfo.inventory));
  await shot(page, 'c02-spawn');

  // ── trained cast: Flame Bolt I at a rabbit, outdoors ──
  phase = 'trained-cast';
  await page.evaluate(`window.acDebug.tele('0xA9B40000', 101.9, 25, 94.1)`);
  await page.waitForTimeout(10_000);
  await talk(page, `@addspell ${FLAME_BOLT_1}`);
  await page.waitForTimeout(2500);
  await talk(page, '@comps');
  await page.waitForTimeout(6000);
  steps.push({ step: 'setup', vitals: await vitals(page) });
  await talk(page, `@create ${RABBIT_WCID}`);
  await page.waitForTimeout(5000);
  const objsNow = await objects(page);
  const target = objsNow.find(o => /rabbit/i.test(o.name) && o.dist < 40);
  steps.push({ step: 'target', found: target ?? null, nearest: objsNow.slice(0, 6) });
  if (!target) { console.log('[caster] no rabbit found'); }
  else {
    await page.evaluate(`window.acDebug.addSpellFavorite(${FLAME_BOLT_1}, 0, 0)`);
    await page.waitForTimeout(1500);
    // Step back a few meters first — a rabbit at point-blank range projects
    // below the viewport bottom (run 1b: y=997 on a 775px view), so the
    // select click can't land.
    await page.keyboard.down('KeyS');
    await page.waitForTimeout(1800);
    await page.keyboard.up('KeyS');
    await page.waitForTimeout(800);
    const spT = await faceObject(page, target.guid, 0.4);
    let selected: unknown = null;
    let selectedVia = 'click';
    if (spT && !spT.behind && Number.isFinite(spT.x) && Number.isFinite(spT.y)
        && spT.x >= 0 && spT.x < VIEW.width && spT.y >= 0 && spT.y < VIEW.height) {
      await page.mouse.click(spT.x, spT.y);
      await page.waitForTimeout(1200);
      selected = await page.evaluate(`window.acDebug.getTarget()`);
    }
    if (!selected) {
      // SwiftShader + a rabbit-sized hitbox makes the raycast click flaky;
      // acDebug.select drives the same selectTarget path as a click.
      await page.evaluate(`window.acDebug.select(${target.guid})`);
      await page.waitForTimeout(800);
      selected = await page.evaluate(`window.acDebug.getTarget()`);
      selectedVia = 'debug-select';
    }
    steps.push({ step: 'select', screenPos: spT, selected, selectedVia });
    await shot(page, 'c03-selected');
    const manaBefore = await vitals(page);
    await page.keyboard.press('Digit1');
    const castSeries: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(5000);
      const st = await page.evaluate(`(() => {
        const objs = window.acDebug.getObjects();
        const r = objs.find(o => o.guid === ${target.guid});
        return { rabbitPresent: !!r, mana: window.__ac.playerState.mana };
      })()`) as Record<string, unknown>;
      castSeries.push(st);
      if (i === 0) await shot(page, 'c04-cast-windup');
      if (!st.rabbitPresent) { console.log('[caster] rabbit gone (killed)'); break; }
      if (i === 2 || i === 5 || i === 7) await page.keyboard.press('Digit1');
    }
    steps.push({ step: 'trained-cast-series', manaBefore, castSeries, vitalsAfter: await vitals(page) });
    await shot(page, 'c05-after-cast');
  }

  await browser.close();
  const errors = consoleLog.filter(c => c.type !== 'warning');
  writeFileSync(join(OUT, 'observations.json'), JSON.stringify({
    utc: UTC, url: URL, viewport: VIEW, steps,
    consoleErrorCount: errors.length, consoleWarningCount: consoleLog.length - errors.length,
    console: consoleLog, chatLog: chatLog.slice(-400),
  }, null, 2));
  console.log(`\n[caster] done — ${steps.length} steps, ${errors.length} errors; wrote ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
