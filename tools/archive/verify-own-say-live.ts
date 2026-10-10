/**
 * BUG.own-say-rendered-third-person live verification — enter the world,
 * send a real /say through acDebug.sendTalk (round-trips through ACE's
 * self-inclusive HearSpeech broadcast), and assert the chat panel renders
 * the retail first-person 'You say, "..."' line (demangled.txt:19347)
 * instead of the pre-fix 'Name says, "..."'.
 *
 * Usage: npx tsx tools/verify-own-say-live.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=ownsay';
const VIEW = { width: 1568, height: 775 };
const OUT = join(__dir, '..', 'verification', 'screens', 'bug-own-say');

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}
async function driveCharacterCreate(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = 'Chat Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));

  console.log(`[ownsay] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') { console.log(`[ownsay] virgin create: ${created}`); createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) { await page.screenshot({ path: join(OUT, '00-never-entered.png') }); await browser.close(); throw new Error('never entered world'); }

  console.log('[ownsay] in world — settling…');
  await page.waitForTimeout(8_000);

  const MSG = 'own say live verification 42';
  // Chat glyphs are AC-font rendered (no DOM textContent), so record the
  // exact line text by wrapping addSystemMessage with a delegating spy —
  // the real render path still runs.
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    window.__chatLines = [];
    const orig = ui.addSystemMessage.bind(ui);
    ui.addSystemMessage = (t, c, ty) => { window.__chatLines.push(t); return orig(t, c, ty); };
  })()`);
  await page.evaluate(`window.acDebug.sendTalk(${JSON.stringify(MSG)})`);
  await page.waitForTimeout(3_000);

  const probe = await page.evaluate(`(() => {
    const lines = (window.__chatLines || []).filter(t => t.includes('own say live verification 42'));
    return { found: lines.length > 0, lines };
  })()`) as { found: boolean; lines: string[] };
  console.log('[ownsay] probe:', JSON.stringify(probe, null, 2));

  await page.screenshot({ path: join(OUT, '01-hud.png') });
  await page.screenshot({ path: join(OUT, '02-chat-crop.png'), clip: { x: 0, y: Math.max(0, VIEW.height - 200), width: 540, height: 200 } });

  const expected = `You say, "${MSG}"`;
  const gotExpected = probe.lines.some(l => l.includes(expected));
  const gotThirdPerson = probe.lines.some(l => /says, "/.test(l));
  writeFileSync(join(OUT, 'probe.json'), JSON.stringify({ probe, expected, gotExpected, gotThirdPerson, errors }, null, 2));
  await browser.close();

  console.log(`[ownsay] expected line present: ${gotExpected}; third-person leak: ${gotThirdPerson}; page errors: ${errors.length}`);
  if (!gotExpected || gotThirdPerson) { process.exit(1); }
  console.log(`[ownsay] PASS → ${OUT}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
