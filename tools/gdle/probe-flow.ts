/**
 * GDLE compat flow probe (docs/gdle-compat.md). Headless SwiftShader only:
 * never a GPU mode, never a headed window.
 *
 *   npx tsx tools/gdle/probe-flow.ts <account> <password> <outdir> <phases...>
 *
 * phases: login | relogin | create:<Name> | enter | world | use:<npc name part>
 *         | logout | wait:<s> | shot:<name> | eval:<js>
 * env: GDLE_BASE (default http://localhost:3000/), PROBE_QUERY (extra query, e.g. era=classic-dereth), GDLE_BRIDGE (default
 *      ws://localhost:9092), CONSOLE_LOG (page console log file, required),
 *      VW / VH (viewport, default 1280x720).
 * A fresh account on a server with auto_create_accounts=1 is created by the
 * first login and lands on character creation.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import {
  openSession, shot, waitFor, AT_CHAR_SELECT_JS, IN_WORLD_JS, PROBE_CHARGEN_REOPEN_JS,
} from '../lib/game-session.js';

const [account, password, outdir, ...phases] = process.argv.slice(2);
mkdirSync(outdir, { recursive: true });
const LOG = process.env.CONSOLE_LOG!;
const base = `${process.env.GDLE_BASE ?? 'http://localhost:3000/'}?ace&bridge=${process.env.GDLE_BRIDGE ?? 'ws://localhost:9092'}&account=${account}&password=${password}${process.env.PROBE_QUERY ? `&${process.env.PROBE_QUERY}` : ''}`;
const log = (s: string) => { console.log(`[flow ${new Date().toISOString().slice(11, 19)}] ${s}`); appendFileSync(LOG, `### ${s}\n`); };

const { browser, page } = await openSession({ gpu: process.env.GPU === '1', timeoutMs: 60_000, viewport: { width: Number(process.env.VW ?? 1280), height: Number(process.env.VH ?? 720) } });
page.on('console', (m) => appendFileSync(LOG, `[${new Date().toISOString().slice(11, 23)}] ${m.type()} ${m.text()}\n`));
let charListCount = 0;
page.on('console', (m) => { if (m.text().includes('Got character list')) charListCount++; });
page.on('pageerror', (e) => appendFileSync(LOG, `PAGEERROR ${e.message}\n`));
const ev = <T = unknown>(js: string): Promise<T> => page.evaluate(js) as Promise<T>;
const snap = async (name: string) => { const f = `${outdir}/${name}.png`; await shot(page, f).catch((e) => log(`shot fail ${e}`)); log(`shot ${f}`); };
const screen = () => ev<string>(`(() => { const ui = window.__ac && window.__ac.gameUI; return ui && ui.ui ? String(ui.ui.currentScreen) : (ui && ui.uiManager ? String(ui.uiManager.currentScreen) : 'none'); })()`).catch(() => 'eval-fail');

async function clickPress(frag: string): Promise<boolean> {
  return ev<boolean>(`(() => { const el = [...document.querySelectorAll('[data-ac-press]')].find(e => e.dataset.acPress.toLowerCase().includes(${JSON.stringify(frag.toLowerCase())}) && e.offsetParent !== null); if (!el) return false; el.click(); return true; })()`);
}

let exit = 0;
try {
  for (const ph of phases) {
    log(`phase ${ph}`);
    if (ph === 'login' || ph === 'relogin') {
      await page.goto(`${base}&autoenter=false&cb=${ph}${Date.now()}`, { waitUntil: 'commit', timeout: 120_000 });
      const ok = await waitFor(page, `(${AT_CHAR_SELECT_JS}) || (window.__ac && window.__ac.gameUI && window.__ac.gameUI.ui && window.__ac.gameUI.ui.currentScreen === 'character-create')`, { timeoutMs: 120_000, reloadEveryMs: 0 });
      log(`login result: ${ok} screen=${await screen()}`);
      await page.waitForTimeout(3000);
      await snap(`${ph === 'login' ? '01-login-charselect' : '07-relogin-charselect'}`);
      if (!ok) { exit = 1; break; }
    } else if (ph.startsWith('create:')) {
      const name = ph.slice(7);
      if ((await screen()) !== 'character-create') {
        await ev(`window.__ac.gameUI.showCharacterCreate()`);
        await page.waitForTimeout(3000);
      }
      await snap('02-chargen');
      const sent = await ev<boolean>(`(() => { const ui = window.__ac.gameUI; if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return false; ${PROBE_CHARGEN_REOPEN_JS}
        ui.wizard.name = ${JSON.stringify(name)}; ui.callbacks.onCharacterCreated(ui.wizard); return true; })()`);
      log(`create sent: ${sent}`);
      const ok = await waitFor(page, `((${AT_CHAR_SELECT_JS}) && document.body.innerText.includes(${JSON.stringify(name)})) || (${IN_WORLD_JS})`, { timeoutMs: 120_000, reloadEveryMs: 0 });
      await page.waitForTimeout(12_000);
      log(`create result: ${ok} screen=${await screen()}`);
      await page.waitForTimeout(2000);
      await snap('03-after-create');
      if (!ok) { exit = 1; break; }
    } else if (ph === 'enter') {
      const sel = await ev<string>(`(() => { const s = window.__ac.gameUI.selectScreen; return s && s.selectedCharacter ? s.selectedCharacter.name : 'none'; })()`);
      log(`selected: ${sel}`);
      const clicked = await clickPress('100003a2');
      log(`enter clicked: ${clicked}`);
      const ok = await waitFor(page, IN_WORLD_JS, { timeoutMs: 180_000, reloadEveryMs: 0 });
      log(`in world: ${ok}`);
      await page.waitForTimeout(15_000);
      await snap('04-in-world');
      if (!ok) { exit = 1; break; }
    } else if (ph === 'world') {
      const before = await ev(`window.acDebug.collisionState()`);
      log(`pos before ${JSON.stringify(before).slice(0, 200)}`);
      await page.keyboard.down('w'); await page.waitForTimeout(3000); await page.keyboard.up('w');
      await page.waitForTimeout(2000);
      const after = await ev(`window.acDebug.collisionState()`);
      log(`pos after ${JSON.stringify(after).slice(0, 200)}`);
      await snap('05a-after-move');
      await ev(`window.acDebug.sendChat('Hello from acjs on GDLE')`).catch((e) => log(`chat fail ${e}`));
      await page.waitForTimeout(3000);
      await snap('05b-say-chat');
      // inventory (F12 retail default) and character info (F9? use keybinds)
      await page.keyboard.press('F12'); await page.waitForTimeout(3000); await snap('05c-inventory');
      await page.keyboard.press('F12'); await page.waitForTimeout(1000);
      await page.keyboard.press('F9'); await page.waitForTimeout(3000); await snap('05d-character');
      await page.keyboard.press('F9'); await page.waitForTimeout(1000);
      const objs = await ev<Array<{ guid: number; name: string; itemType: number }>>(`window.acDebug.listServerObjects()`);
      log(`objects (${objs.length}): ${objs.map(o => o.name + '/0x' + o.itemType.toString(16)).join(', ').slice(0, 2500)}`);
    } else if (ph.startsWith('use:')) {
      const want = ph.slice(4).toLowerCase();
      const objs = await ev<Array<{ guid: number; name: string; itemType: number }>>(`window.acDebug.listServerObjects()`);
      const o = objs.find(x => x.name.toLowerCase().includes(want));
      log(`use target: ${o ? o.name + ' 0x' + o.guid.toString(16) : 'none'}`);
      if (o) {
        await ev(`window.acDebug.select(${o.guid})`).catch(() => {});
        const r = await ev(`window.acDebug.useObject(${o.guid})`);
        log(`useObject: ${r}`);
        await page.waitForTimeout(8000);
        await snap('05e-npc-use');
      }
    } else if (ph === 'logout') {
      const before = charListCount;
      const ok0 = await ev<boolean>(`(() => { const ui = window.__ac.gameUI; if (ui.callbacks && ui.callbacks.onLogout) { ui.callbacks.onLogout(); return true; } return false; })()`);
      log(`logout called: ${ok0}`);
      const t0 = Date.now(); let ok = false;
      while (Date.now() - t0 < 60_000) { if (charListCount > before) { ok = true; break; } await page.waitForTimeout(1000); }
      log(`character list after logout: ${ok} in ${Date.now() - t0} ms`);
      await page.waitForTimeout(3000);
      await snap('06-after-logout');
    } else if (ph.startsWith('wait:')) {
      await page.waitForTimeout(Number(ph.slice(5)) * 1000);
    } else if (ph.startsWith('eval:')) {
      log(`eval => ${(JSON.stringify(await ev(ph.slice(5))) ?? 'undefined').slice(0, 2000)}`);
    } else if (ph.startsWith('shot:')) {
      await snap(ph.slice(5));
    }
  }
} catch (e) {
  log(`ERROR ${(e as Error).stack}`);
  exit = 2;
}
await browser.close().catch(() => {});
process.exit(exit);
