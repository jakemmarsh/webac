/**
 * probe-stream-miss-sweep — which code reads streamed DAT files before they
 * land, per screen, so render paths with no redraw-on-arrival can be found
 * (the bug class of BUG.classic-stream-chargen-blank: a chargen preview built
 * with nothing and never redrawn).
 *
 * Drives one cold-profile streamed session: char select / chargen (every
 * step + Random) → create → world → each main panel → a few teleports →
 * reload to char select. Sets window.__missTrace (DatStore's probe hook) so
 * every miss carries the stack that made it, and screenshots each surface
 * after its files have had time to land. Writes <out>/misses.json (per phase:
 * misses grouped by the first caller outside the DAT layer, with the file
 * types) and the screenshots.
 *
 *   npx tsx tools/probe-stream-miss-sweep.ts --base http://localhost:3017/ --bridge ws://localhost:9136 \
 *     --account c7sweep1 --out <dir> [--era <id> --set <pointer url>]   (classic era: its streamed set)
 *     [--set <pointer url>]                                               (end of retail: datSet)
 * Local servers only (an admin account: the teleports use @teleloc).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { SWIFTSHADER_ARGS, waitFor, AT_CHAR_SELECT_JS, IN_CHARGEN_JS, IN_WORLD_JS } from './lib/game-session.js';

const args = process.argv.slice(2);
const opt = (n: string, d = ''): string => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] ?? d : d; };
const base = opt('base', 'http://localhost:3017/');
const bridge = opt('bridge', 'ws://localhost:9136');
const account = opt('account', 'c7sweep1');
const out = opt('out', '/tmp/stream-miss-sweep');
const era = opt('era');
const set = opt('set', 'https://dats.playwebac.com/v1/sets/eol-p2072-c982-h497-l994.json');
mkdirSync(out, { recursive: true });

const q = new URLSearchParams({ bridge, account, password: `${account}pw` });
if (era) { q.set('era', era); q.set('eraDatSet', `${era}:${set}`); } else q.set('datSet', set);
const url = `${base}?ace&${q.toString().replace(/%3A/g, ':').replace(/%2F/g, '/')}`;

/** First stack frame outside the DAT layer: the code that read too early. */
function caller(stack: string): string {
  const frames = stack.split('\n').slice(1).map((l) => l.trim().replace(/^at /, ''));
  const skip = /DatStore|DatDatabase|StreamedDat|RangedDat|ResidentSource|DatReader|noteMiss|getFileData|getReader|Error\b/;
  const own = frames.filter((f) => !skip.test(f));
  return own.slice(0, 3).map((f) => f.replace(/\(?https?:\/\/[^)]*\/(src\/[^?:)]+)[^)]*\)?/, '[$1]').replace(/\s+/g, ' ')).join(' ← ');
}

interface Miss { key: string; at: number; stack: string }
const phases: Array<{ phase: string; byCaller: Record<string, { count: number; types: Record<string, number> }> }> = [];
let page: Page;

async function takeMisses(phase: string): Promise<void> {
  const misses = await page.evaluate('(() => { const t = window.__missTrace || []; window.__missTrace = []; return t; })()') as Miss[];
  const byCaller: Record<string, { count: number; types: Record<string, number> }> = {};
  for (const m of misses) {
    const c = caller(m.stack);
    const t = String(m.key).slice(0, String(m.key).indexOf(':') + 3);
    const e = (byCaller[c] ??= { count: 0, types: {} });
    e.count++; e.types[t] = (e.types[t] ?? 0) + 1;
  }
  phases.push({ phase, byCaller });
  console.log(`[sweep] ${phase}: ${misses.length} misses from ${Object.keys(byCaller).length} callers`);
}
const ev = <T = unknown>(js: string) => page.evaluate(js) as Promise<T>;
const snap = (name: string) => page.screenshot({ path: join(out, `${name}.png`) }).catch(() => {});
const settle = (ms = 4000) => page.waitForTimeout(ms);

const profile = mkdtempSync(join(tmpdir(), 'acjs-miss-sweep-'));
const ctx = await chromium.launchPersistentContext(profile, { args: SWIFTSHADER_ARGS, viewport: { width: 1280, height: 720 } });
page = ctx.pages()[0] ?? await ctx.newPage();
page.setDefaultTimeout(120_000);
await page.addInitScript('window.__missTrace = []');
const consoleLines: string[] = [];
page.on('console', (m) => consoleLines.push(`${m.type()} ${m.text()}`.slice(0, 300)));

try {
  await page.goto(url, { waitUntil: 'commit' });
  if (!await waitFor(page, `(${AT_CHAR_SELECT_JS}) || (${IN_CHARGEN_JS})`, { timeoutMs: 300_000, reloadEveryMs: 0 })) throw new Error('never reached char select / chargen');
  await settle(); await snap('01-charselect-or-chargen'); await takeMisses('boot → char select');

  // Chargen: every step, a Random on each, then create.
  if (!await ev<boolean>(IN_CHARGEN_JS)) { await ev('window.__ac.gameUI.showCharacterCreate()'); await settle(3000); }
  for (let step = 0; step < 6; step++) {
    await ev(`(() => { const ui = window.__ac.gameUI; ui.wizard.setProgressState(${step}); ui.renderCharacterCreate(); })()`);
    await settle(2500);
    await ev(`(() => { const ui = window.__ac.gameUI; ui.doChargenRandom && ui.doChargenRandom(); })()`).catch(() => {});
    await settle(3500);
    await snap(`02-chargen-step${step}`);
  }
  await takeMisses('chargen (6 steps + Random)');
  const name = `Sw${Math.random().toString(36).slice(2, 7)}`;
  await ev(`(() => { const ui = window.__ac.gameUI; ui.wizard.setProgressState(0); ui.wizard.name = ${JSON.stringify(name)}; ui.callbacks.onCharacterCreated(ui.wizard); })()`);
  if (!await waitFor(page, IN_WORLD_JS, { timeoutMs: 240_000, reloadEveryMs: 0 })) throw new Error('never entered the world');
  await settle(15_000); await snap('03-world'); await takeMisses('enter world');

  const panels: Array<[string, string]> = [
    ['inventory', 'toggleInventory()'], ['character', 'toggleCharPanel()'], ['char-skills', "toggleCharPage('skills')"],
    ['char-titles', "toggleCharPage('titles')"], ['magic', 'toggleMagicPanel()'], ['magic-components', "toggleMagicPage('components')"],
    ['map', 'toggleMapPanel()'], ['social', 'toggleSocialPanel()'], ['social-fellowship', "toggleSocialPage('fellowship')"],
    ['options', 'toggleOptionsPanel()'], ['keyboard', 'toggleKeyboardConfigPanel()'], ['enchantments', 'toggleEnchantmentPanel()'],
    ['contracts', 'toggleContractPanel()'], ['minigame', 'toggleMiniGamePanel()'], ['vitae', 'toggleVitaePanel()'],
  ];
  for (const [label, call] of panels) {
    const opened = await ev<boolean>(`(() => { try { window.__ac.gameUI.${call}; return true; } catch (e) { console.warn('[sweep] ' + ${JSON.stringify(label)} + ': ' + e); return false; } })()`);
    if (!opened) continue;
    await settle(3500); await snap(`04-panel-${label}`);
    await ev(`(() => { try { window.__ac.gameUI.${call}; } catch {} })()`).catch(() => {});
    await settle(500);
  }
  await takeMisses('panels');

  // Combat stance and a few teleports (admin): new terrain, scenery, NPCs, dungeons.
  await ev('window.__ac.gameUI.toggleCombatMode()').catch(() => {});
  await settle(3000); await snap('05-combat'); await ev('window.__ac.gameUI.toggleCombatMode()').catch(() => {});
  for (const [label, cmd] of [['shoushi', '@telepoi Shoushi'], ['yaraq', '@telepoi Yaraq'], ['holtburg', '@telepoi Holtburg']] as const) {
    await ev(`window.acDebug.sendTalk(${JSON.stringify(cmd)})`).catch(() => {});
    await settle(25_000); await snap(`06-tele-${label}`);
    await takeMisses(`teleport ${label}`);
  }

  // A fresh load: char select with the character on it (its figure / portrait).
  await page.goto(url.replace('&account=', '&autoenter=false&account='), { waitUntil: 'commit' });
  await waitFor(page, AT_CHAR_SELECT_JS, { timeoutMs: 240_000, reloadEveryMs: 0 });
  await settle(8000); await snap('07-charselect-again'); await takeMisses('char select with a character (reload)');
} catch (e) {
  console.log(`[sweep] ERROR ${(e as Error).message}`);
  await snap('99-error');
} finally {
  writeFileSync(join(out, 'misses.json'), JSON.stringify({ url, era: era || 'eor', set, phases }, null, 1));
  writeFileSync(join(out, 'console.log'), consoleLines.join('\n'));
  await ctx.close();
  rmSync(profile, { recursive: true, force: true }); // the profile holds a ~1 GB DAT cache
}
