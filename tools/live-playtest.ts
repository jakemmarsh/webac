/**
 * live-playtest — scripted in-world play-test session for the discovery loop
 * (mode (d) in docs/remote-agent-ops.md). Logs into the ACE stack headlessly
 * (same path as measure-perf.ts), enters the world, then exercises core
 * gameplay systems in sequence, screenshotting after each step and recording
 * every console error/warning plus structured probe results to
 * verification/playtest/<utc>/observations.json.
 *
 * The output is REVIEW MATERIAL for a human/agent pass, not a pass/fail
 * gate: the reviewing session inspects the screenshots + console log +
 * probe JSON, adversarially verifies anything suspicious against ACE/DAT/
 * client-eol ground truth, and files confirmed defects as tasks.
 *
 * Steps exercised: spawn settle, forward movement, turning, jump, /say chat
 * echo, entity selection (real selectTarget path), inventory/character/map
 * panels, combat-stance toggle.
 *
 * Usage:  npx tsx tools/live-playtest.ts [--headed] [--url URL]
 * Requires: vite dev server (:3000), ws-tcp-bridge (:9090), ACE stack.
 * NOTE: uses the testacjs account — close other clients on that account first.
 */

import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBE_CHARGEN_REOPEN_JS } from './lib/game-session.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const HEADED = process.argv.includes('--headed');
const urlArg = process.argv.indexOf('--url');
const URL = urlArg > -1 ? process.argv[urlArg + 1]
  : process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=playtest';
const VIEW = { width: 1568, height: 775 };

const UTC = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(__dir, '..', 'verification', 'playtest', UTC);

interface ConsoleEntry { phase: string; type: string; text: string }
interface StepNote { step: string; [k: string]: unknown }

const consoleLog: ConsoleEntry[] = [];
const steps: StepNote[] = [];
let phase = 'boot';

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

/** Same virgin-account handling as measure-perf.ts (source string — __name landmine). */
async function driveCharacterCreate(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ${PROBE_CHARGEN_REOPEN_JS}
    ui.wizard.name = 'Perf Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}

async function collision(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(`window.acDebug.collisionState()`) as Promise<Record<string, unknown>>;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    headless: !HEADED,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) && !HEADED ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning') consoleLog.push({ phase, type: t, text: m.text().slice(0, 500) });
  });
  page.on('pageerror', (e) => consoleLog.push({ phase, type: 'pageerror', text: String(e).slice(0, 500) }));

  console.log(`[playtest] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // Phantom-session retry loop (same shape as measure-perf.ts).
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[playtest] virgin account — scripted create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[playtest] not in world yet — reloading (phantom-session retry)');
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      } catch (e) {
        console.log(`[playtest] reload failed (${(e as Error).message.split('\n')[0]}) — continuing`);
      }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await shot(page, '00-never-entered-world');
    await browser.close();
    throw new Error('never entered world within 360s');
  }

  phase = 'settle';
  console.log('[playtest] in world — settling 12s…');
  await page.waitForTimeout(12_000);
  const spawn = await collision(page);
  steps.push({ step: 'spawn', collision: spawn });
  await shot(page, '01-spawn');

  // Nearby entities (names, radar colors) for the selection step + review.
  const entities = await page.evaluate(`(() => {
    const objs = window.acDebug.getObjects();
    const me = window.acDebug.collisionState();
    return objs
      .filter((o) => o.pos && o.name)
      .map((o) => ({
        guid: o.guid, name: o.name, radarColor: o.radarColor,
        dist: Math.hypot(o.pos.x - me.x, o.pos.y - me.y),
      }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 25);
  })()`) as Array<{ guid: number; name: string; radarColor: number; dist: number }>;
  steps.push({ step: 'entities', nearest: entities });
  console.log(`[playtest] ${entities.length} named entities nearby; nearest: ${entities[0]?.name} @ ${entities[0]?.dist.toFixed(1)}m`);

  phase = 'movement';
  console.log('[playtest] step: forward movement (4s)…');
  await page.keyboard.down('w');
  await page.waitForTimeout(4000);
  await page.keyboard.up('w');
  await page.waitForTimeout(1000);
  const afterMove = await collision(page);
  const moved = Math.hypot(
    (afterMove.x as number) - (spawn.x as number),
    (afterMove.y as number) - (spawn.y as number),
  );
  steps.push({ step: 'move-forward', collision: afterMove, distanceMoved: moved });
  console.log(`[playtest] moved ${moved.toFixed(2)}m`);
  await shot(page, '02-after-move');

  phase = 'turning';
  console.log('[playtest] step: turning (2.5s)…');
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(2500);
  await page.keyboard.up('ArrowLeft');
  await shot(page, '03-after-turn');

  phase = 'jump';
  console.log('[playtest] step: jump…');
  await page.keyboard.press('Space');
  await page.waitForTimeout(2500);
  const jumpStats = await page.evaluate(`window.acDebug.jumpStats ? window.acDebug.jumpStats() : null`);
  steps.push({ step: 'jump', jumpStats });
  await shot(page, '04-after-jump');

  phase = 'chat';
  console.log('[playtest] step: /say chat echo…');
  // Messages render as ACFont canvases inside #chat-messages (no textContent) —
  // verify the echo behaviorally by node-count growth; the screenshot carries
  // the actual text for the review pass.
  const chatCountBefore = await page.evaluate(
    `document.querySelectorAll('#chat-messages > *').length`) as number;
  await page.evaluate(`window.acDebug.sendTalk('playtest hello world')`);
  await page.waitForTimeout(2500);
  const chatCountAfter = await page.evaluate(
    `document.querySelectorAll('#chat-messages > *').length`) as number;
  steps.push({ step: 'chat', chatCountBefore, chatCountAfter, echoArrived: chatCountAfter > chatCountBefore });
  console.log(`[playtest] chat messages ${chatCountBefore} -> ${chatCountAfter}`);
  await shot(page, '05-chat');

  phase = 'select';
  const target = entities.find(e => e.guid !== 0 && e.dist > 0.1 && e.dist < 60);
  if (target) {
    console.log(`[playtest] step: select ${target.name} (0x${target.guid.toString(16)})…`);
    await page.evaluate(`window.acDebug.select(${target.guid})`);
    await page.waitForTimeout(1500);
    const sel = await page.evaluate(`window.acDebug.getTarget()`);
    steps.push({ step: 'select', requested: target, selected: sel });
    await shot(page, '06-selected');
  } else {
    steps.push({ step: 'select', skipped: 'no entity within 60m' });
  }

  phase = 'panels';
  for (const [id, name] of [['tb-inv', '07-inventory'], ['tb-char', '08-character'], ['tb-map', '09-map']] as const) {
    console.log(`[playtest] step: panel ${id}…`);
    await page.evaluate(`document.getElementById('${id}')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await page.waitForTimeout(1200);
    await shot(page, name);
    await page.evaluate(`document.getElementById('${id}')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await page.waitForTimeout(500);
  }

  phase = 'combat-stance';
  console.log('[playtest] step: combat stance toggle…');
  await page.evaluate(`window.acDebug.combatMode('melee')`);
  await page.waitForTimeout(2000);
  await shot(page, '10-combat-stance');
  await page.evaluate(`window.acDebug.combatMode('peace')`);
  await page.waitForTimeout(1000);

  await browser.close();

  const errors = consoleLog.filter(c => c.type !== 'warning');
  const observations = {
    utc: UTC, url: URL, viewport: VIEW,
    steps,
    consoleErrorCount: errors.length,
    consoleWarningCount: consoleLog.length - errors.length,
    console: consoleLog,
  };
  writeFileSync(join(OUT, 'observations.json'), JSON.stringify(observations, null, 2));
  console.log(`\n[playtest] done — ${steps.length} steps, ${errors.length} console errors, ${consoleLog.length - errors.length} warnings`);
  console.log(`[playtest] wrote ${OUT}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
