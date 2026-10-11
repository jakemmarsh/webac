/**
 * ERA.dm-support live probe (docs/dark-majesty-support.md): drive the real
 * launcher (no URL login) into a world of another era, follow the era reload
 * and check the client lands in that world with that era's DATs. Headless
 * SwiftShader, one fresh browser profile per run.
 *
 *   npx tsx tools/probe-era-switch.ts --base http://localhost:3010/ --bridge ws://localhost:9190 \
 *     --account eraprobe1 --password pw --out /tmp/era [--custom ws://localhost:9090] [--revisit]
 *
 *   --bridge   the bridge the launcher lists worlds from (a pinned bridge's
 *              /healthz `era`, or a multi bridge's /servers rows). Passed as
 *              ?bridge=, which only a dev / VITE_ACJS_URL_OVERRIDES=1 build
 *              honors: a deployed --base lists its own config's worlds
 *              (use --custom to reach another bridge there)
 *   --world    the world row to enter: its Servers.xml id (or visible text); default the first
 *   --custom   enter a Custom… bridge instead (its /healthz era decides)
 *   --revisit  after reaching char select, reload the page: it must boot end
 *              of retail (a remembered classic world only preselects the row;
 *              its DATs load on ENTER)
 *   --create <Name>  after the era reload, create a character with the wizard's
 *              defaults (if the account has none), enter the world, walk
 *              forward 2 s and screenshot. Needs the page's debug hooks, which a
 *              deployed page never installs (2026-10-11: ?debug is dev-only). For a
 *              production-shaped run, point --base at a local
 *              `VITE_ACJS_URL_OVERRIDES=1 npx vite build && npx vite preview` of the
 *              same commit, with ?debug (e.g. http://localhost:4173/?debug&).
 *   --then-custom <ws url>  after --revisit, enter that Custom… bridge (an
 *              end-of-retail ACE bridge): no era reload, the boot was already
 *              end of retail
 * The classic DATs are hosted (eraAssetBases or <assetBase>/sets/<era>/):
 * ENTER must never show a data-files prompt.
 * Writes <out>/console.log and screenshots; exits 1 on any failed check.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { shot, waitFor, AT_CHAR_SELECT_JS, IN_CHARGEN_JS, IN_WORLD_JS, PROBE_CHARGEN_REOPEN_JS, SWIFTSHADER_ARGS } from './lib/game-session.js';

const args = process.argv.slice(2);
const opt = (name: string): string | null => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] ?? '' : null; };
const base = opt('base') ?? 'http://localhost:3010/';
const bridge = opt('bridge') ?? 'ws://localhost:9190';
const account = opt('account') ?? 'eraprobe1';
const password = opt('password') ?? 'eraprobe1pw';
const out = opt('out') ?? '/tmp/era-probe';
const custom = opt('custom');
const worldName = opt('world');
const revisit = args.includes('--revisit');
const thenCustom = opt('then-custom');
const createName = opt('create');
mkdirSync(out, { recursive: true });
const LOG = join(out, 'console.log');
const log = (s: string) => { console.log(`[era ${new Date().toISOString().slice(11, 19)}] ${s}`); appendFileSync(LOG, `### ${s}\n`); };

// A persistent profile, like a player's: an incognito context keeps OPFS in
// memory and refuses the classic files (~1.2 GB) on top of the end-of-retail
// cache (QuotaExceededError at ~2.2 GB, 2026-10-06).
const profile = mkdtempSync(join(tmpdir(), 'acjs-era-probe-'));
const browser = await chromium.launchPersistentContext(profile, { args: SWIFTSHADER_ARGS, viewport: { width: 1280, height: 720 } });
const page = browser.pages()[0] ?? await browser.newPage();
page.setDefaultTimeout(60_000);
page.on('dialog', (d) => void d.dismiss());
const eraLines: string[] = [];
page.on('console', (m) => {
  const t = m.text();
  appendFileSync(LOG, `[${new Date().toISOString().slice(11, 23)}] ${m.type()} ${t}\n`);
  if (t.startsWith('[AC:Era]')) eraLines.push(t);
});
page.on('pageerror', (e) => appendFileSync(LOG, `PAGEERROR ${e.message}\n`));
const ev = <T = unknown>(js: string): Promise<T> => page.evaluate(js) as Promise<T>;
const snap = async (name: string) => { await shot(page, join(out, `${name}.png`)).catch((e) => log(`shot fail ${e}`)); };
let failed = false;
const check = (ok: boolean, what: string) => { log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failed = true; };

try {
  await page.goto(`${base}?ace&bridge=${encodeURIComponent(bridge)}`, { waitUntil: 'commit', timeout: 120_000 });
  check(await waitFor(page, `!!document.querySelector('.launcher-world-row')`, { timeoutMs: 180_000, reloadEveryMs: 0 }), 'launcher lists worlds');
  log(`boot: ${eraLines.join(' | ')}`);
  await snap('01-launcher');

  if (custom) {
    await ev(`document.querySelector('.launcher-custom').click()`);
    await page.waitForTimeout(500);
    const entry = page.locator('input.ac-dialog-entry');
    await entry.fill(custom);
    await page.locator('[data-element-id="0x2e"]').last().click(); // the text-entry dialog's Done
    await page.waitForTimeout(1500);
  } else if (worldName) {
    // Row names are drawn in the DAT font, so match the server id (data-world) too.
    await ev(`[...document.querySelectorAll('.launcher-world-row')].find(r => r.dataset.world === ${JSON.stringify(worldName.toLowerCase())} || r.dataset.world === ${JSON.stringify(worldName)} || r.textContent.includes(${JSON.stringify(worldName)})).click()`);
  }
  await page.locator('input.launcher-account').fill(account);
  await page.locator('input.launcher-password').fill(password);
  const before = eraLines.length;

  let prompted = false;
  page.on('filechooser', () => { prompted = true; });
  await ev(`document.querySelector('.launcher-enter').click()`);
  // ERA_SWITCH_FRAMES=N: one screenshot a second through the era reload
  // (what the player sees between ENTER and char select).
  for (let i = 0; i < Number(process.env.ERA_SWITCH_FRAMES ?? 0); i++) {
    await page.waitForTimeout(1000);
    await snap(`02-switch-${String(i).padStart(2, '0')}`).catch(() => {});
  }
  await page.waitForTimeout(1500);
  // DialogFactory's Yes/No confirmation (element 0x15) was the retired data-files prompt.
  if (await page.locator('[data-element-id="0x15"]').count().catch(() => 0)) prompted = true;

  const reloaded = await waitFor(page, `(${AT_CHAR_SELECT_JS}) || (${IN_CHARGEN_JS})`, { timeoutMs: Number(process.env.ERA_WAIT_MS ?? 300_000), reloadEveryMs: 0 });
  check(reloaded, 'reached char select / character creation after ENTER');
  check(!prompted, 'no data-files prompt (the era\'s DATs are hosted)');
  log(`after ENTER: ${eraLines.slice(before).join(' | ')}`);
  check(eraLines.slice(before).some((l) => l.includes('reloading into its data')), 'ENTER reloaded into the world\'s era');
  const era = await ev<{ id: string } | null>(`window.__era || (window.acDebug && window.acDebug.__era) || null`).catch(() => null);
  log(`active era: ${JSON.stringify(era)}`);
  await snap('03-after-enter');

  if (createName && reloaded) {
    // --create always creates: an empty account lands on char select (not the
    // wizard), and ENTER there has no character to play.
    const inChargen = await ev<boolean>(IN_CHARGEN_JS);
    const charCount = await ev<number>(`(window.__ac.gameUI.lastCharacterSlots || []).length`).catch(() => 0);
    if (inChargen || charCount === 0) {
      const sent = await ev<boolean>(`(() => { const ui = window.__ac.gameUI; if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return false; ${PROBE_CHARGEN_REOPEN_JS}
        ui.wizard.name = ${JSON.stringify(createName)}; ui.callbacks.onCharacterCreated(ui.wizard); return true; })()`);
      check(sent, 'character create sent');
    } else {
      // An existing character: select the first and press ENTER (0x100003a2).
      await ev(`(() => { const el = [...document.querySelectorAll('[data-ac-press]')].find(e => e.dataset.acPress.toLowerCase().includes('100003a2') && e.offsetParent !== null); el && el.click(); })()`);
    }
    const inWorld = await waitFor(page, IN_WORLD_JS, { timeoutMs: Number(process.env.ERA_WAIT_MS ?? 300_000), reloadEveryMs: 0 });
    check(inWorld, 'in the world');
    if (inWorld) {
      await page.waitForTimeout(8000);
      await snap('05-in-world');
      const before = await ev<unknown>(`JSON.stringify(window.acDebug.collisionState().serverFrame)`);
      await page.mouse.click(640, 300);
      await page.keyboard.down('KeyW'); await page.waitForTimeout(2000); await page.keyboard.up('KeyW');
      await page.waitForTimeout(3000);
      const after = await ev<unknown>(`JSON.stringify(window.acDebug.collisionState().serverFrame)`);
      log(`position ${before} -> ${after}`);
      check(before !== after, 'the server moved the character');
      const objs = await ev<string[]>(`window.acDebug.getObjects().map(o => o.name)`);
      log(`objects (${objs.length}): ${objs.slice(0, 25).join(', ')}`);
      await snap('06-after-walk');
    }
  }

  if (revisit) {
    const mark = eraLines.length;
    await page.reload({ waitUntil: 'commit' });
    check(await waitFor(page, `!!document.querySelector('.launcher-world-row')`, { timeoutMs: 180_000, reloadEveryMs: 0 }), 'launcher after revisit');
    const boot = eraLines.slice(mark).join(' | ');
    log(`revisit boot: ${boot}`);
    check(/booting End of Retail/.test(boot), 'revisit boots end of retail (the remembered classic world doesn\'t pick the DATs)');
    const selected = await ev<string | null>(`(document.querySelector('.launcher-world-row[aria-selected="true"]') || {}).dataset?.world ?? null`);
    log(`revisit preselected world: ${selected}`);
    await snap('04-revisit-launcher');
    if (thenCustom) {
      const from = eraLines.length;
      await ev(`document.querySelector('.launcher-custom').click()`);
      await page.waitForTimeout(500);
      await page.locator('input.ac-dialog-entry').fill(thenCustom);
      await page.locator('[data-element-id="0x2e"]').last().click(); // the text-entry dialog's Done
      await page.waitForTimeout(1500);
      await page.locator('input.launcher-account').fill(account);
      await page.locator('input.launcher-password').fill(password);
      await ev(`document.querySelector('.launcher-enter').click()`);
      const back = await waitFor(page, `(${AT_CHAR_SELECT_JS}) || (${IN_CHARGEN_JS})`, { timeoutMs: Number(process.env.ERA_WAIT_MS ?? 300_000), reloadEveryMs: 0 });
      check(back, 'reached char select / character creation on the custom world');
      const lines = eraLines.slice(from).join(' | ');
      log(`custom switch: ${lines}`);
      check(!/reloading into its data/.test(lines), 'the custom end-of-retail world entered with no era reload');
      await snap('05-custom-world');
    }
  }
} catch (e) {
  log(`ERROR ${(e as Error).message}`);
  failed = true;
} finally {
  await browser.close();
  // The fresh profile holds the streamed/whole DATs (1-2 GB): never leave it behind.
  rmSync(profile, { recursive: true, force: true });
}
log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);
