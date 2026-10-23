/**
 * The first hour of 1999, played through and checked (TOOL.ac1999-playthrough).
 *
 * A 1999 player kept finding bugs one flow at a time (webac #3–#12). This drives our client on a local
 * server through what a new player does in their first hour: enter the world; open and close every main
 * panel; buy from and sell to a vendor; kill a weak creature (picked from the era's world data, never one
 * that casts or hits hard), open its corpse, walk away mid-loot, loot the rest; read a scroll, eat, use a
 * healing kit; magic mode with a held caster, a cast at a creature and at yourself; give an NPC an item;
 * @help, @loc, @version and the era's Yes / No command answered No; log out to character select and back.
 * After every step it checks the client: no inventory request left pending, the busy cursor count at 0, no
 * "one item at a time" or other unexpected refusal, no console error, the player alive (a death ends the run).
 *
 *   npx tsx tools/ac1999-playthrough.ts --base http://localhost:5291/ --bridge ws://localhost:9312
 *   npx tsx tools/ac1999-playthrough.ts --era eor --bridge ws://localhost:9313 --account testacjs3
 *   npx tsx tools/ac1999-playthrough.ts --era classicace-customdm --bridge ws://localhost:9193 --account agentapp99dm
 *
 * Flags: --era ac1999-retail (default) | eor | classicace-customdm; --account (default per era; AC1999 names
 * ≤ 8 characters), --password (default the account); --character <name for a new character>; --query
 * <extra page parameters, e.g. datSet=…>; --out <dir>; --only step,step (enter-world always runs);
 * --data-root <checkout with reference/ and world-db-raw/>; --profile <fixed Chrome profile dir, kept>;
 * --headed; --swiftshader (default: headless on the real GPU).
 *
 * Output: verification/ac1999-playthrough/<timestamp>-<era>/report.md (each step ok / skipped (why) /
 * FAIL (details)), results.json, run.log and the screenshots. Exit 1 on any FAIL or an aborted run.
 * The step logic and health checks are tools/lib/playthrough.ts (tests/verify-ac1999-playthrough-tool.ts).
 * Docs: docs/verification-workflows.md, "The first hour, played through".
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chromium, type Page } from 'playwright';
import { DEFAULT_VIEWPORT, GPU_ARGS, REMOTE_CHROMIUM, REPO, SWIFTSHADER_ARGS, createCharacterIfNeeded, waitForWorld } from './lib/game-session.ts';
import { createRunProfile } from './lib/temp-profile.ts';
import {
  type ClientProbe, type Place, type PlaythroughDriver, type Signals, type VendorStockRow, loadGiveTables, loadVendorSpots, emptySignals, exitCode, freshState, loadCreatureFacts,
  parsePlaythroughArgs, playthroughSteps, playthroughUrl, renderReport, runPlaythrough, selectSteps,
} from './lib/playthrough.ts';

/** Wraps GameUI.displayErrorText (the spew box) so each spew line reaches the console as `[PT:Spew] …`. */
const SPEW_TAP_JS = `(() => { setInterval(() => {
  const ui = window.__ac && window.__ac.gameUI;
  if (!ui || ui.__ptSpew || typeof ui.displayErrorText !== 'function') return;
  const orig = ui.displayErrorText.bind(ui);
  ui.displayErrorText = (text, w) => { try { console.log('[PT:Spew] ' + String(text)); } catch (e) {} return orig(text, w); };
  ui.__ptSpew = true;
}, 250); })();`;

const PROBE_JS = `(() => {
  const a = window.__acAgent, d = window.acDebug;
  const me = a && a.self ? a.self() : null;
  const st = a && a.status ? a.status() : null;
  const req = d && d.inventoryRequest ? d.inventoryRequest() : null;
  const cur = d && d.cursorState ? d.cursorState() : null;
  return { screen: st ? st.screen : 'unknown', inventoryRequest: req === undefined ? null : req, busy: cur ? (cur.busy || 0) : 0,
    dead: !!(me && me.dead), health: me ? me.health.cur / Math.max(1, me.health.max) : null, character: me ? me.name : null };
})()`;

/** The open vendor window's stock (GameUI vendorData.buyItems) with ItemType; Service 0x00100000 marks a vendor's spell. */
const VENDOR_STOCK_JS = `(() => { const ui = window.__ac && window.__ac.gameUI; if (!ui || !ui.isVendorVisible) return null;
  const v = ui.vendorData; if (!v || !v.buyItems) return null;
  return v.buyItems.filter((i) => i.guid).map((i) => ({ guid: i.guid >>> 0, name: i.name, price: i.price,
    itemType: i.itemType === undefined ? undefined : i.itemType >>> 0, service: ((i.itemType || 0) & 0x00100000) !== 0 })); })()`;

/** The player's and some objects' places: landscape cell, a building's room (EnvCell SeenOutside 0x1), or a dungeon's. */
const PLACE_OF_JS = `(gs) => {
  const ac = window.__ac, a = window.__acAgent;
  const kind = (c) => {
    if (c === null || c === undefined) return 'unknown';
    if ((c & 0xffff) < 0x100) return 'outdoors';
    try { const e = ac.envCellRenderer.loadEnvCell(c >>> 0); return e ? ((e.flags & 1) ? 'building' : 'dungeon') : 'unknown'; } catch (x) { return 'unknown'; }
  };
  const me = a && a.where ? a.where() : null;
  const objects = {};
  for (const g of gs) {
    const o = ac && ac.serverObjectManager ? ac.serverObjectManager.getObject(g) : null;
    objects[g] = kind(o ? ((o.physics && o.physics.cell) || o.objCellId || (o.position && o.position.landblock)) : null);
  }
  return { me: kind(me ? me.cell : null), objects };
}`;

const UI_STATE_JS = `(() => { const ui = window.__ac && window.__ac.gameUI; if (!ui || !ui.getUIState) return null;
  return Object.assign({}, ui.getUIState(), { charPanelTab: ui.charPanelTab, socialTab: ui.socialTab }); })()`;

/** The main checkout of a worktree (reference/ and world-db-raw/ are gitignored, so a worktree has none). */
function mainCheckout(): string | null {
  try {
    const common = execFileSync('git', ['-C', REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    return dirname(common);
  } catch { return null; }
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${what}: no answer in ${Math.round(ms / 1000)} s`)), ms); })]).finally(() => clearTimeout(t));
};

async function main(): Promise<number> {
  const args = parsePlaythroughArgs(process.argv.slice(2));
  const started = new Date();
  const out = args.out ?? join(REPO, 'verification', 'ac1999-playthrough', `${started.toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z')}-${args.era.key}`);
  mkdirSync(out, { recursive: true });
  const runLog = join(out, 'run.log');
  const log = (m: string): void => { console.log(m); appendFileSync(runLog, `${new Date().toISOString()} ${m}\n`); };
  const url = playthroughUrl(args);
  log(`first-hour play-through: ${args.era.label}; account ${args.account}; report in ${out}`);

  const roots = [args.dataRoot, REPO, mainCheckout()].filter((r): r is string => !!r && existsSync(r));
  const loaded = loadCreatureFacts(args.era, roots);
  log(loaded ? `creature facts: ${loaded.facts.size} names from ${loaded.from}` : `creature facts: none for ${args.era.key} (${args.era.creatureSql.length ? `no ${args.era.creatureSql[0]} under ${roots.join(', ')}` : 'its world is not in SQL files'}): only the no-data allow list is fought`);

  const vendorSpots = loadVendorSpots(args.era, roots);
  log(vendorSpots ? `vendor spawns: ${vendorSpots.length} from the era's world data` : `vendor spawns: none for ${args.era.key} (a vendor out of view is looked for by town only)`);

  const giveTables = loadGiveTables(args.era, roots);
  log(giveTables ? `give tables: ${giveTables.size} NPCs with Give emotes in the era's world data` : `give tables: none for ${args.era.key}`);

  const profile = createRunProfile('acjs-playthrough-profile-', { tool: 'ac1999-playthrough', ...(args.profile ? { persistDir: args.profile } : {}) });
  const ctx = await chromium.launchPersistentContext(profile.dir, {
    headless: !args.headed,
    viewport: DEFAULT_VIEWPORT,
    ...(args.gpu
      ? { ...(args.headed ? {} : { channel: 'chromium' }), args: GPU_ARGS }
      : { args: SWIFTSHADER_ARGS, ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}) }),
  });
  profile.setCloser(() => ctx.close());
  const page: Page = ctx.pages()[0] ?? await ctx.newPage();
  page.setDefaultTimeout(120_000);
  page.on('dialog', (d) => void d.dismiss());
  await page.addInitScript({ content: SPEW_TAP_JS });

  let sig: Signals = emptySignals();
  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('[AC:Chat] ')) sig.chat.push(t.slice(10));
    else if (t.startsWith('[PT:Spew] ')) sig.spew.push(t.slice(10));
    else if (m.type() === 'error') { const where = m.location()?.url; sig.consoleErrors.push(`${t}${where ? ` (${where})` : ''}`); }
  });
  page.on('pageerror', (e) => sig.consoleErrors.push(`uncaught: ${String(e?.message ?? e)}`));
  page.on('crash', () => sig.consoleErrors.push('the page crashed'));
  // client_refusal telemetry (telemetry/RefusalReporter.ts): the first of each refusal on the page, silent server codes included.
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !/\/client-preworld/.test(r.url())) return;
    try {
      const b = JSON.parse(r.postData() ?? 'null');
      for (const ev of Array.isArray(b) ? b : [b]) if (ev?.outcome === 'refusal') sig.refusals.push({ source: ev.source, code: ev.code, text: ev.text ?? null, context: ev.context, sink: ev.sink, ...(ev.first === false ? { rollup: true } : {}) });
    } catch { /* not ours */ }
  });

  let shotN = 0;
  const driver: PlaythroughDriver = {
    async enterWorld() {
      const t0 = Date.now();
      await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(async (e: Error) => {
        if (!/interrupted by another navigation/.test(e.message)) throw e;
        await page.goto(url, { waitUntil: 'domcontentloaded' });
      });
      const okWorld = await waitForWorld(page, { timeoutMs: 360_000, url, reloadVia: 'goto', onPoll: createCharacterIfNeeded(args.character), log: (m) => log(`   ${m}`) });
      if (!okWorld) return { ok: false, detail: 'never entered the world in 6 min (see run.log)' };
      await page.waitForFunction('!!window.__acAgent', undefined, { timeout: 30_000 });
      return { ok: true, detail: `logged in as ${args.account} in ${Math.round((Date.now() - t0) / 1000)} s` };
    },
    call<T>(method: string, a: unknown[] = [], timeoutMs = 60_000): Promise<T> {
      return withTimeout(page.evaluate(([m, xs]) => {
        const api = (window as unknown as { __acAgent?: Record<string, (...v: unknown[]) => unknown> }).__acAgent;
        if (!api) throw new Error('agent API not loaded');
        if (typeof api[m as string] !== 'function') throw new Error(`unknown agent method: ${m}`);
        return api[m as string](...(xs as unknown[]));
      }, [method, a] as const) as Promise<T>, timeoutMs + 5000, method);
    },
    probe: () => page.evaluate(PROBE_JS) as Promise<ClientProbe>,
    uiState: () => page.evaluate(UI_STATE_JS) as Promise<Record<string, unknown> | null>,
    vendorStock: () => page.evaluate(VENDOR_STOCK_JS) as Promise<VendorStockRow[] | null>,
    placeOf: (guids) => page.evaluate(`(${PLACE_OF_JS})(${JSON.stringify(guids)})`) as Promise<{ me: Place; objects: Record<number, Place> }>,
    npcCreatures: (guids) => page.evaluate(`(() => { const som = window.__ac && window.__ac.serverObjectManager; if (!som) return [];
      return ${JSON.stringify(guids)}.filter((g) => { const o = som.getObject(g);
        return !!o && ((o.itemType >>> 0) & 0x10) !== 0 && ((o.objectDescFlags >>> 0) & 0x8) === 0 && ((o.objectDescFlags >>> 0) & 0x10) === 0; }); })()`) as Promise<number[]>,
    async clickIndicator(id) {
      const sel = `#hud-indicator-${id}`;
      const st = await page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const ui = window.__ac && window.__ac.gameUI;
        if (!el || el.style.display === 'none' || !el.getBoundingClientRect().width) return null;
        return { lit: !!(ui && ui.indicatorActive && ui.indicatorActive.get(${JSON.stringify(id)})) }; })()`) as { lit: boolean } | null;
      if (!st) return { found: false, lit: false };
      // The real mouse, as a player clicks: the indicator is a button that ignores a click while unlit.
      const box = await page.locator(sel).boundingBox();
      if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      return { found: true, lit: st.lit };
    },
    chat: async (text) => { await page.evaluate(`window.acDebug.sendChat(${JSON.stringify(text)})`); },
    peek: () => ({ chat: [...sig.chat], spew: [...sig.spew], consoleErrors: [...sig.consoleErrors], refusals: [...sig.refusals] }),
    drain: () => { const s = sig; sig = emptySignals(); return s; },
    async screenshot(name) {
      const file = `${String(++shotN).padStart(2, '0')}-${name.replace(/[^a-z0-9-]+/gi, '-')}.png`;
      try { await page.screenshot({ path: join(out, file), timeout: 60_000 }); return file; } catch (e) { log(`   screenshot ${file} failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`); return null; }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };

  const steps = selectSteps(playthroughSteps(args.era), args.only);
  const state = freshState();
  let res;
  try {
    res = await runPlaythrough(steps, { driver, era: args.era, facts: loaded?.facts ?? null, vendorSpots, giveTables, state, log }, { log });
  } finally {
    // Never leave the character standing in the world (docs/agent-play.md, idle logout).
    const p = await driver.probe().catch(() => null);
    if (p?.screen === 'world') { await driver.call('logout').catch(() => undefined); await driver.sleep(4000); }
  }
  const finished = new Date();
  writeFileSync(join(out, 'report.md'), renderReport(res, { era: args.era, url, account: args.account, character: state.character, started, finished }));
  writeFileSync(join(out, 'results.json'), `${JSON.stringify({ era: args.era.key, account: args.account, character: state.character, aborted: res.aborted, steps: res.records.map((r) => ({ ...r, signals: undefined })) }, null, 2)}\n`);
  const code = exitCode(res);
  log(`${code ? 'FAIL' : 'PASS'}: ${res.records.filter((r) => r.status === 'ok').length} ok, ${res.records.filter((r) => r.status === 'skipped').length} skipped, ${res.records.filter((r) => r.status === 'fail').length} failed${res.aborted ? `; aborted: ${res.aborted}` : ''}. Report: ${join(out, 'report.md')}`);
  await profile.dispose();
  return code;
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(2); });
