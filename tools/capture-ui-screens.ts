/**
 * capture-ui-screens — visual-fidelity capture harness (WF5 Phase 0).
 *
 * Logs into the local ACE stack headlessly via Playwright, toggles each UI
 * panel, and writes full-page PNGs to verification/screens/ plus a
 * manifest.json mapping every capture to its retail reference screenshot(s)
 * in reference/images/hud/ and the relevant LayoutDesc id.
 *
 * The panels are DOM elements, so headless rendering is faithful even if the
 * WebGL world canvas falls back to SwiftShader.
 *
 * Usage:  npx tsx tools/capture-ui-screens.ts
 * Requires: vite dev server (:3000), ws-tcp-bridge (:9090), ACE docker stack.
 * NOTE: uses the testacjs account unless ACJS_ACCOUNT / AC_ACCOUNT (or AC_URL)
 * names another — ACE allows one session per account, so capture on
 * testacjs2 while someone plays on testacjs.
 */

import { chromium, type Page } from 'playwright';
import { assertHealthy, attachCrashAlarms, deleteObjects, launchBrowser } from './lib/game-session.js';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
// --out <dir> — write captures somewhere else (tools/screen-regression.ts
// captures the base and head builds into separate dirs with THIS driver).
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > -1 && process.argv[outIdx + 1]
  ? resolvePath(process.argv[outIdx + 1])
  : join(__dir, '..', 'verification', 'screens');
// --no-world — hide the full-viewport WebGL world canvas before each PANEL
// capture, so the regression diff judges the UI alone (NPCs walking and
// ambient animation behind a panel are not UI changes). Scenes keep the world.
const NO_WORLD = process.argv.includes('--no-world');
// Pre-world captures (connecting/loading, login/char-select, char-create,
// portal space) land here — the visual-fidelity-preworld workflow reads this dir.
const PREWORLD = join(OUT, 'preworld');
// The account: AC_URL wins; else ACJS_ACCOUNT / AC_ACCOUNT (screen-regression
// and game-session's names; password defaults to the account name), else
// testacjs. (Run directly, this used to ignore both and log in as testacjs —
// kicking a user playing there; 2026-09-27.)
const CAPTURE_ACCOUNT = process.env.ACJS_ACCOUNT ?? process.env.AC_ACCOUNT ?? 'testacjs';
const CAPTURE_PASSWORD = process.env.ACJS_PASSWORD ?? process.env.AC_PASSWORD ?? CAPTURE_ACCOUNT;
const URL = process.env.AC_URL
  ?? `http://localhost:3000/?ace&bridge=ws://localhost:9090&account=${encodeURIComponent(CAPTURE_ACCOUNT)}&password=${encodeURIComponent(CAPTURE_PASSWORD)}&cb=capture`;

// Viewport matches the interactive-session geometry so panel coordinates and
// retail-comparison proportions stay stable across runs. On --attach the tab
// is the user's own window, so the REAL viewport is measured and recorded in
// the manifest instead (the audit prompt reads it from there).
/** page.screenshot that refuses after a crash or graphics-context loss (game-session assertHealthy). */
async function snapHealthy(p: Page, path: string): Promise<void> {
  await assertHealthy(p, `capture ${path}`);
  await p.screenshot({ path });
}

const VIEW = { width: 1568, height: 775 };

// --attach [endpoint] — capture against a real GPU by attaching to a Chrome
// the user started themselves:
//   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
//     --remote-debugging-port=9222
// then: npx tsx tools/capture-ui-screens.ts --scenes --attach
// Headless renders on SwiftShader; world findings from headless scenes are
// candidates only. See docs/verification-workflows.md.
const attachIdx = process.argv.indexOf('--attach');
const ATTACH = attachIdx > -1;
const ATTACH_ENDPOINT =
  ATTACH && process.argv[attachIdx + 1] && !process.argv[attachIdx + 1].startsWith('--')
    ? process.argv[attachIdx + 1]
    : 'http://localhost:9222';
// --gpu (or AC_GPU=1) — launch headless Chromium on the machine's real GPU
// (tools/lib/game-session.ts launchBrowser, the measure-perf --gpu recipe)
// instead of SwiftShader. Local Macs only; the cloud container has no GPU.
const GPU = !ATTACH && (process.argv.includes('--gpu') || process.env.AC_GPU === '1');

/**
 * Positional args (scene / panel name filters). `--attach`'s optional endpoint
 * is positional too, so it must be excluded or `--attach http://localhost:9222`
 * silently filters every capture out by treating the URL as a name.
 */
function positionalArgs(): string[] {
  const argv = process.argv.slice(2);
  const skip = new Set<number>();
  argv.forEach((a, i) => {
    if (a === '--attach' && argv[i + 1] && !argv[i + 1].startsWith('--')) skip.add(i + 1);
    if (a === '--out' && argv[i + 1]) skip.add(i + 1);
  });
  return argv.filter((a, i) => !a.startsWith('-') && !skip.has(i));
}

/** The REAL viewport. On --attach this is the user's window, not VIEW. */
async function actualViewport(page: Page): Promise<{ width: number; height: number }> {
  try {
    return await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  } catch { return VIEW; }
}

/** The WebGL renderer string (UNMASKED_RENDERER_WEBGL), recorded in the
 *  manifests so screen-regression noise floors know which renderer measured
 *  them (SwiftShader noise is not a real GPU's). */
async function webglRenderer(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      const g = document.createElement('canvas').getContext('webgl2') ?? document.createElement('canvas').getContext('webgl');
      const e = g?.getExtension('WEBGL_debug_renderer_info');
      return e ? String(g!.getParameter(e.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    });
  } catch { return 'unknown'; }
}

/** Hide (or restore) the full-viewport WebGL world canvas; smaller canvases (radar, paperdoll) stay. */
async function setWorldCanvasHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    for (const c of document.querySelectorAll('canvas')) {
      const r = c.getBoundingClientRect();
      if (h && r.width >= window.innerWidth * 0.9 && r.height >= window.innerHeight * 0.9) {
        c.style.visibility = 'hidden';
        c.dataset.acHiddenWorld = '1';
      } else if (!h && c.dataset.acHiddenWorld) {
        c.style.visibility = '';
        delete c.dataset.acHiddenWorld;
      }
    }
  }, hidden);
}

const isGameUrl = (u: string): boolean => /\/\/(localhost|127\.0\.0\.1):\d+/.test(u) && u.includes('?ace');

type Action =
  | { clickId: string }          // dispatch a click on a DOM element by id (toolbar toggles)
  | { clickXY: [number, number] } // raw click (panel sub-tabs render as anonymous divs)
  | { clickSel: string }         // click a DOM element by CSS selector (stable sub-tab hooks)
  | { evalJs: string }           // run JS in the page (e.g. acDebug.seed* social test data, VISUAL.167)
  | { waitSel: string }          // wait (≤5 s) until a selector exists — seeded lists render async
  | { wait: number };

interface Capture {
  name: string;
  actions: Action[];
  /** JS run after the screenshot so transient UI (a context menu) can't leak into the next capture. */
  cleanupJs?: string;
  /** retail reference screenshots in reference/images/hud/ */
  refs: string[];
  /** LayoutDesc id(s) for the DAT ground truth, where known */
  layouts: string[];
  notes?: string;
}

// Toolbar toggles are stateful — each capture lists the toggles to flip ON
// before the shot; the harness flips the same ids OFF afterward so captures
// stay independent.
const CAPTURES: Capture[] = [
  { name: 'hud-overview', actions: [], refs: ['rawg_01.jpg', 'reddit-shutdown.jpg', 'status-panels.png', 'radar-regular.jpg', 'chat-panel.jpg', 'link-status.jpg', 'mana-status.jpg'], layouts: ['0x21000006', '0x21000010', '0x21000016'], notes: 'no panels open — vitals bars, radar, chat, toolbar' },
  { name: 'inventory', actions: [{ clickId: 'tb-inv' }], refs: ['inventory-panel.jpg', 'equipment-slots.jpg', 'item-stack-tooltip.jpg'], layouts: ['0x21000011'], notes: 'paperdoll + slots + item grid + burden' },
  { name: 'char-attributes', actions: [{ clickId: 'tb-char' }], refs: ['character-panel-attributes.jpg', 'character-panel.jpg', 'character-info.jpg'], layouts: ['0x21000013'] },
  { name: 'char-skills', actions: [{ clickId: 'tb-char' }, { clickXY: [1250, 17] }], refs: ['character-panel-skills.jpg'], layouts: ['0x21000013'] },
  { name: 'char-titles', actions: [{ clickId: 'tb-char' }, { clickXY: [1430, 17] }], refs: ['character-panel-titles.jpg'], layouts: ['0x21000013'] },
  { name: 'magic-spellbook', actions: [{ clickId: 'tb-magic' }], refs: ['spellbook-panel.jpg', 'beneficial-spells.jpg'], layouts: ['0x21000032', '0x21000010'] },
  { name: 'magic-components', actions: [{ clickId: 'tb-magic' }, { clickSel: '[data-magic-tab="components"]' }], refs: ['components-panel.jpg'], layouts: ['0x21000032'] },
  { name: 'social-fellowship', actions: [{ clickId: 'tb-social' }], refs: ['fellowship-panel.jpg', 'fellowship-panel-2.jpg'], layouts: ['0x21000033'] },
  { name: 'social-allegiance', actions: [{ clickId: 'tb-social' }, { clickSel: '[data-social-tab="allegiance"]' }], refs: ['allegiance-panel.jpg', 'allegiance-panel-2.jpg'], layouts: ['0x21000031'] },
  { name: 'social-friends', actions: [{ clickId: 'tb-social' }, { clickSel: '[data-social-tab="friends"]' }], refs: ['friends-panel.jpg'], layouts: ['0x21000031'] },
  // VISUAL.167 — POPULATED social views (test char has no real social data): seed sample data then capture.
  { name: 'social-allegiance-seeded', actions: [{ clickId: 'tb-social' }, { evalJs: 'window.acDebug.seedAllegiance()' }, { clickSel: '[data-social-tab="allegiance"]' }], refs: ['allegiance-panel.jpg', 'allegiance-panel-2.jpg'], layouts: ['0x2100002F'] },
  { name: 'social-fellowship-seeded', actions: [{ clickId: 'tb-social' }, { evalJs: 'window.acDebug.seedFellowship()' }, { clickSel: '[data-social-tab="fellowship"]' }], refs: ['fellowship-panel.jpg', 'fellowship-panel-2.jpg'], layouts: ['0x21000030'] },
  // VISUAL.117 — right-click a fellow name strip to surface the context menu (Tell/Add to Friends/Assign Leadership/Dismiss).
  { name: 'social-fellowship-ctxmenu', actions: [{ clickId: 'tb-social' }, { evalJs: 'window.acDebug.seedFellowship()' }, { clickSel: '[data-social-tab="fellowship"]' }, { waitSel: '[data-fellow-name]' }, { evalJs: 'var el=document.querySelectorAll("[data-fellow-name]")[1]||document.querySelector("[data-fellow-name]"); var r=el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,clientX:r.left+20,clientY:r.top+8}));' }], cleanupJs: 'window.__ac.gameUI.hideContextMenu()', refs: ['fellowship-panel-2.jpg'], layouts: ['0x21000041'] },
  { name: 'social-friends-seeded', actions: [{ clickId: 'tb-social' }, { evalJs: 'window.acDebug.seedFriends()' }, { clickSel: '[data-social-tab="friends"]' }], refs: ['friends-panel.jpg'], layouts: ['0x2100005d'] },
  { name: 'options', actions: [{ clickId: 'tb-opt' }], refs: ['options-config.jpg', 'options-character.jpg', 'options-gameplay.jpg', 'chat-options.jpg'], layouts: ['0x2100002b'], notes: 'default Gameplay Options tab (DAT tab group 0x2100002b)' },
  // VISUAL.22/.23 — the Character tab has default-on toggles, so it shows the bright-green ON bullets (0x06004d17).
  { name: 'options-character', actions: [{ clickId: 'tb-opt' }, { clickSel: '[data-options-tab="character"]' }], refs: ['options-character.jpg'], layouts: ['0x2100002b'] },
  // VISUAL.24 — the Chat tab is short, so its Apply/Reset/Defaults footer sits in view without scrolling.
  { name: 'options-chat', actions: [{ clickId: 'tb-opt' }, { clickSel: '[data-options-tab="chat"]' }], refs: ['chat-options.jpg'], layouts: ['0x2100002b'] },
  // VISUAL.72 — Config tab: sound sliders + Field of View slider + Resolution dropdown.
  { name: 'options-config', actions: [{ clickId: 'tb-opt' }, { clickSel: '[data-options-tab="config"]' }], refs: ['options-config.jpg'], layouts: ['0x2100002b'] },
  // (options-collapsed retired: VISUAL.options-panel-eol-window — in the panels
  // window the corner 0x10000210 hides the panel; there is no roll-up.)
  // VISUAL.126 — the Gameplay "Report Abuse" action button opens the 3-page Report Abuse dialog
  // (the Gameplay tab is clicked first: the panel reopens on the persisted tab).
  { name: 'report-abuse', actions: [{ clickId: 'tb-opt' }, { clickSel: '[data-options-tab="gameplay"]' }, { clickSel: '[data-options-action="Report Abuse"]' }], refs: [], layouts: ['0x21000018'] },
  // VISUAL.126 — second page: name + description inputs (click the dialog's first red button to advance).
  { name: 'report-abuse-input', actions: [{ clickId: 'tb-opt' }, { clickSel: '[data-options-tab="gameplay"]' }, { clickSel: '[data-options-action="Report Abuse"]' }, { evalJs: 'document.querySelector(".ac-report-abuse [data-element-id=\\"0x10000102\\"]").dispatchEvent(new MouseEvent("click",{bubbles:true}))' }], refs: [], layouts: ['0x21000018'] },
  { name: 'map', actions: [{ clickId: 'tb-map' }], refs: ['map-panel.jpg'], layouts: ['0x21000017'] },
  { name: 'map-house', actions: [{ clickId: 'tb-map' }, { clickSel: '[data-map-tab="House"]' }], refs: ['map-panel.jpg'], layouts: ['0x21000025'] },
];

// ── Whole-screen SCENE captures (world + UI composite) ──────────────────
//
// WHY THIS EXISTS: the panel captures above are already full-viewport shots,
// but the audit workflow was explicitly told "ignore the world, audit the
// PANEL UI only" — so for its whole life the harness discarded the world half
// of every image it took, and never captured the player in motion, in combat,
// at night, or in weather at all. That is the surface Jake found badly wrong
// on 2026-08-23 while every automated lens stayed green.
//
// Scenes are judged as WHOLE FRAMES — terrain, lighting, sky, buildings,
// creatures AND the HUD composite over them — against full-screen retail
// references. Anything a player sees is in scope.
//
// Determinism: time of day is pinned, weather forced off except where a
// scene is specifically about weather, AND the sky's day group is pinned
// (CORE.17.r), so reruns are comparable.
const SCENE_OUT = join(OUT, 'scenes');

import { DEFAULT_DAY_GROUP, SCENES, SPAWNED_WCIDS, leftoversOf, type Scene } from './capture-scenes.js';

// ── HARNESS.scene-spawn-leak: scenes that @create / @ci clean up after themselves ──
type WorldSnap = { inv: number[]; world: Array<{ guid: number; wcid: number }> };
async function snapshotObjects(page: Page): Promise<WorldSnap> {
  return page.evaluate(() => {
    const ac = (window as any).__ac;
    const inv = (ac?.playerState?.inventory?.getAll?.() ?? []).map((i: any) => i.id >>> 0);
    const world: Array<{ guid: number; wcid: number }> = [];
    for (const [guid, obj] of ac?.serverObjectManager?.getAllObjects?.() ?? []) world.push({ guid: guid >>> 0, wcid: (obj as any).weenieClassId ?? 0 });
    return { inv, world };
  });
}
/** Leftovers of any scene's spawned classes near the player (dynamic guids only), e.g. from an earlier run. */
async function sweepLeftovers(page: Page): Promise<void> {
  if (!SPAWNED_WCIDS.length) return;
  const snap = await snapshotObjects(page);
  const stale = snap.world.filter((o) => SPAWNED_WCIDS.includes(o.wcid) && o.guid >= 0x80000000 && !snap.inv.includes(o.guid)).map((o) => o.guid);
  if (stale.length) console.log(`[scenes] cleanup: ${await deleteObjects(page, stale)}/${stale.length} leftover spawned object(s) removed`);
}



/** Whole-screen scene pass — world + HUD composite, judged as whole frames. */
async function captureScenes(page: Page): Promise<Array<Scene & { file: string }>> {
  mkdirSync(SCENE_OUT, { recursive: true });
  const done: Array<Scene & { file: string }> = [];

  const only = positionalArgs();
  const list = only.length ? SCENES.filter((s) => only.includes(s.name)) : SCENES;
  if (only.length) console.log(`[scenes] filtered to: ${list.map((s) => s.name).join(', ')}`);

  for (const s of list) {
    try {
      if (s.teleport) {
        await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), s.teleport);
        await page.waitForTimeout(4000);
        // DECOMP.login-complete-timing — the player stays Hidden until our
        // LoginComplete (sent when the portal animation ends); wait for it so
        // no scene captures the teleport's bubble silhouette.
        for (let i = 0; i < 120 && !(await inWorld(page)); i++) await page.waitForTimeout(500);
        await sweepLeftovers(page);
      }
      const before = s.spawns ? await snapshotObjects(page) : null;
      // Weather off by default so reruns are lighting-comparable; the weather
      // scene turns it back on deliberately.
      await page.evaluate((on) => (window as any).__ac?.skybox?.setWeatherEnabled?.(on), s.weather === true);
      // CORE.17.r — pin the day group. Without this the sky is whatever the
      // session (or the last in-game day boundary) rolled: blue one run,
      // overcast the next, with the clock frozen at the same noon in both.
      {
        const want = s.dayGroup ?? DEFAULT_DAY_GROUP;
        const pin = await page.evaluate(
          (g) => (window as any).acDebug?.pinDayGroup?.(g),
          want,
        ) as { ok?: boolean; name?: string; index?: number } | undefined;
        if (!pin?.ok) {
          console.log(`[scenes] ${s.name}: WARNING day-group pin "${want}" did not take — sky is the session's roll`);
        } else {
          console.log(`[scenes] ${s.name}: day group "${pin.name}" (#${pin.index})`);
        }
      }
      // FREEZE, don't set. acDebug.setTimeOfDay() writes the phase once and
      // the per-frame world clock overwrites it within ~1s — that is why the
      // first run of this harness produced a `world-night` capture in broad
      // daylight (tools/probe-timeofday-pin.ts; tests/verify-timeofday-freeze.ts).
      // freezeTimeOfDay also holds cloud UV scroll, so repeat captures compare.
      if (s.timeOfDay !== undefined) {
        const pin = await page.evaluate(
          (t) => (window as any).acDebug?.freezeTimeOfDay?.(t),
          s.timeOfDay,
        ) as { frozen?: boolean; timeOfDay?: number } | undefined;
        if (!pin?.frozen) {
          console.log(`[scenes] ${s.name}: WARNING time-of-day freeze did not take — lighting is whatever the world clock reads`);
        } else if (Math.abs((pin.timeOfDay ?? -1) - s.timeOfDay) > 0.01) {
          console.log(`[scenes] ${s.name}: WARNING asked for ${s.timeOfDay}, skybox reports ${pin.timeOfDay}`);
        }
      } else {
        await page.evaluate(() => (window as any).acDebug?.freezeTimeOfDay?.(null));
      }
      if (s.yaw !== undefined) await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), s.yaw);
      if (s.cameraDistance !== undefined) {
        await page.evaluate((d) => { const c = (window as any).__ac?.cameraController; if (c) c.cameraDistance = d; }, s.cameraDistance);
      }
      for (const id of s.toggles ?? []) {
        await page.evaluate((elId) => document.getElementById(elId)?.dispatchEvent(new MouseEvent('click', { bubbles: true })), id);
        await page.waitForTimeout(700);
      }
      if (s.evalJs) {
        await page.evaluate((js) => { try { (0, eval)(js); } catch (e) { console.error('[scenes] evalJs failed', e); } }, s.evalJs);
      }
      await page.waitForTimeout(s.settleMs ?? 2500);

      for (const k of s.holdKeys ?? []) await page.keyboard.down(k);
      if (s.holdKeys?.length) await page.waitForTimeout(s.settleMs ?? 1400);

      const file = `${s.name}.png`;
      const hideParticles = NO_WORLD && s.regressionHideParticles === true;
      if (hideParticles) {
        await page.evaluate(() => {
          (window as any).__ac?.sceneManager?.scene?.traverse((o: any) => { if (/^particles_/.test(o.name) && o.visible) { o.visible = false; o.userData.acRegressionHidden = true; } });
        });
        await page.waitForTimeout(250); // a frame or two so the canvas shows the hidden state
      }
      await snapHealthy(page, join(SCENE_OUT, file));
      if (hideParticles) {
        await page.evaluate(() => {
          (window as any).__ac?.sceneManager?.scene?.traverse((o: any) => { if (o.userData?.acRegressionHidden) { o.visible = true; delete o.userData.acRegressionHidden; } });
        });
      }
      if (NO_WORLD) {
        // Regression runs also capture the scene's HUD/DOM layer alone
        // (`<name>.hud.png`, world canvas hidden) so screen-regression.ts can
        // judge it at panel strictness instead of inside the moving world's
        // frame-wide noise. Same instant: keys still held, then restored.
        await setWorldCanvasHidden(page, true);
        await snapHealthy(page, join(SCENE_OUT, `${s.name}.hud.png`));
        await setWorldCanvasHidden(page, false);
      }
      for (const k of s.holdKeys ?? []) await page.keyboard.up(k);
      console.log(`[scenes] ${file}`);
      done.push({ ...s, file });

      // restore: undo evalJs, close panels, reset camera, release keys
      if (s.cleanupJs) {
        await page.evaluate((js) => { try { (0, eval)(js); } catch (e) { console.error('[scenes] cleanupJs failed', e); } }, s.cleanupJs);
        await page.waitForTimeout(500);
      }
      if (before && s.spawns) {
        const left = leftoversOf({ inv: before.inv, world: before.world.map((o) => o.guid) }, await snapshotObjects(page), s.spawns);
        if (left.length) console.log(`[scenes] ${s.name}: cleanup removed ${await deleteObjects(page, left)}/${left.length} spawned object(s)`);
      }
      for (const id of (s.toggles ?? []).slice().reverse()) {
        await page.evaluate((elId) => document.getElementById(elId)?.dispatchEvent(new MouseEvent('click', { bubbles: true })), id);
        await page.waitForTimeout(500);
      }
      if (s.cameraDistance !== undefined) {
        await page.evaluate(() => { const c = (window as any).__ac?.cameraController; if (c) c.cameraDistance = 7; });
      }
    } catch (e) {
      console.log(`[scenes] ${s.name} FAILED: ${String(e).slice(0, 160)}`);
      if (NO_WORLD) await setWorldCanvasHidden(page, false).catch(() => { /* page gone */ });
    }
  }

  // Release the clock so a following panel pass runs on normal game time.
  await page.evaluate(() => (window as any).acDebug?.freezeTimeOfDay?.(null));

  writeFileSync(join(SCENE_OUT, 'manifest.json'), JSON.stringify({
    capturedAt: new Date().toISOString(), viewport: await actualViewport(page), realGpu: ATTACH || GPU, renderer: await webglRenderer(page),
    retailRefDir: 'reference/images/hud', kind: 'scene', captures: done,
  }, null, 2));
  console.log(`[scenes] wrote ${done.length} scene captures + manifest to ${SCENE_OUT}`);
  return done;
}

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number; loginComplete?: boolean } } }).acDebug;
    const cs = dbg?.collisionState?.();
    // DECOMP.login-complete-timing: also wait for our LoginComplete, so a
    // capture never catches the login's Hidden bubble silhouette.
    return !!(cs && cs.x > 0 && cs.loginComplete !== false);
  });
}

/** Is the loading overlay currently visible + populated? */
async function loadingVisible(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const o = document.getElementById('loading-overlay');
    if (!o) return false;
    const cs = getComputedStyle(o);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    // The DAT splash (#patch-inner), or the placeholder's status line once it
    // is revealed (the ranged splash read failed) — not the black frame the
    // placeholder holds while the splash's files are read.
    if (o.querySelector('#patch-inner')) return true;
    const label = document.getElementById('load-text-left');
    return !!label && getComputedStyle(label).visibility !== 'hidden' && !!label.textContent;
  });
}

/** Is the char-select / pre-world screen rendered (not in world)? */
async function atCharSelect(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const sc = document.getElementById('game-ui-screens');
    if (!sc) return false;
    return getComputedStyle(sc).display !== 'none' && sc.childElementCount > 0;
  });
}

/**
 * Pre-world capture pass (VISUAL2 / end-to-end audit). Loads with autoenter=false
 * so we land on char-select, captures connecting/loading → login → char-create.
 * Portal space is captured later (in-world) via gameUI.showPortalSpace().
 */
async function capturePreWorld(page: Page): Promise<string[]> {
  mkdirSync(PREWORLD, { recursive: true });
  const done: string[] = [];
  const preUrl = URL + (URL.includes('?') ? '&' : '?') + 'autoenter=false';
  console.log(`[preworld] navigating ${preUrl}`);
  await page.goto(preUrl, { waitUntil: 'domcontentloaded' });

  // Loading/connecting screen — fires during DAT parse + connect. Poll the
  // first few seconds and grab it the moment it's up (cached loads are brief).
  for (let i = 0; i < 16; i++) {
    if (await loadingVisible(page)) {
      await snapHealthy(page, join(PREWORLD, 'loading.png'));
      console.log('[preworld] loading.png'); done.push('loading');
      break;
    }
    await page.waitForTimeout(250);
  }

  // Char-select / login screen — wait up to ~40s (incl. phantom-session retry).
  const deadline = Date.now() + 40_000;
  let lastReload = Date.now();
  while (Date.now() < deadline && !(await atCharSelect(page))) {
    if (Date.now() - lastReload > 20_000) {
      await page.reload({ waitUntil: 'domcontentloaded' }); lastReload = Date.now();
    }
    await page.waitForTimeout(1000);
  }
  if (await atCharSelect(page)) {
    // The screen mounts before the server's character list lands; until then
    // GameUI.connectingMode holds a "Please Wait" dialog over it (drawn in the
    // DAT font, so it is not DOM text). Capturing then made login.png differ
    // run to run (tools/screen-regression.ts calibration, 2026-09-26).
    for (let i = 0; i < 40 && (await page.evaluate(() => (window as any).__ac?.gameUI?.connectingMode === true)); i++) {
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(1200);
    await snapHealthy(page, join(PREWORLD, 'login.png'));
    console.log('[preworld] login.png'); done.push('login');

    // Character creation wizard.
    const created = await page.evaluate(() => {
      const ui = (window as unknown as { __ac?: { gameUI?: { showCharacterCreate?: () => void; pinChargenRandom?: (seed: number) => void } } }).__ac?.gameUI;
      // A fresh chargen opens on RandomizeCharacter (gmCharGenMainUI ctor);
      // seed the roll so regression runs of identical code match.
      ui?.pinChargenRandom?.(1);
      // The summary's name field opens focused (gmCGSummaryPage::Update
      // TakeFocus): hold its caret lit so the blink phase cannot differ.
      (ui as { pinCaretBlink?: (on: boolean) => void } | undefined)?.pinCaretBlink?.(true);
      if (ui?.showCharacterCreate) { ui.showCharacterCreate(); return true; }
      return false;
    });
    if (created) {
      await page.waitForTimeout(1500);
      await snapHealthy(page, join(PREWORLD, 'char-create.png'));
      console.log('[preworld] char-create.png'); done.push('char-create');
      // Every other wizard page (CreateStep 1..5), and Appearance in both of
      // its modes: whole-screen regression could not see a change on any page
      // but Heritage (2026-09-27: the chargen colour-wheel rebuild changed
      // Appearance and the pass reported "no changes").
      const pages: Array<[string, number, string | null, string | null]> = [
        ['char-create-profession', 1, null, null],
        ['char-create-skills', 2, null, null],
        ['char-create-appearance-face', 3, 'face', 'hairStyle'],
        ['char-create-appearance-clothes', 3, 'clothes', 'headgear'],
        ['char-create-town', 4, null, null],
        ['char-create-summary', 5, null, null],
      ];
      for (const [name, step, mode, cat] of pages) {
        const ok = await page.evaluate(([st, md, ct]) => {
          const ui = (window as any).__ac?.gameUI;
          if (!ui?.wizard || !ui.renderCharacterCreate) return false;
          ui.wizard.currentStep = st;
          if (md) { ui.appearMode = md; ui.appearCategory = ct; }
          ui.renderCharacterCreate();
          return true;
        }, [step, mode, cat] as const);
        if (!ok) { console.log(`[preworld] ${name}: wizard hooks missing — skipped`); continue; }
        await page.waitForTimeout(1200);
        // Regression runs hold the 3D figure on frame 0 of its idle loop
        // (GameUI.pinChargenAnimation) so both sides capture the same pose.
        if (NO_WORLD) {
          await page.evaluate(() => (window as any).__ac?.gameUI?.pinChargenAnimation?.(true));
          await page.waitForTimeout(400);
        }
        await snapHealthy(page, join(PREWORLD, `${name}.png`));
        console.log(`[preworld] ${name}.png`); done.push(name);
      }
    } else {
      console.log('[preworld] showCharacterCreate hook not found — skipped char-create');
    }
  } else {
    console.log('[preworld] never reached char-select — skipped login/char-create');
  }
  return done;
}

async function run(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  // Remote/cloud containers pin a pre-installed browser at a fixed path whose
  // version can drift ahead of the @playwright/test devDependency here,
  // making the default chromium.launch() resolution 404 looking for a
  // headless-shell build that was never fetched (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
  // is set there). Fall back to it only when present; local/CI installs with
  // `npx playwright install` are unaffected.
  const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
  let browser;
  let page: Page;
  let ownPage = true; // pages we opened get closed; an attached user tab stays
  if (ATTACH) {
    // REAL-GPU path (mirrors tools/measure-perf.ts --attach, CORE.14.d).
    // Headless renders on SwiftShader, so every world finding from a scene
    // capture — lighting, fog, water, particles, LOD, popping — is only a
    // CANDIDATE. Attaching to a Chrome the user started with a real GPU makes
    // those captures trustworthy. A headed launch hangs under the local
    // harness, so we only ever ATTACH, never launch headed.
    console.log(`[capture] attaching over CDP: ${ATTACH_ENDPOINT}`);
    browser = await chromium.connectOverCDP(ATTACH_ENDPOINT);
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    const existing = ctx.pages().find((p) => isGameUrl(p.url()));
    if (existing) {
      page = existing;
      ownPage = false;
      console.log(`[capture] reusing open game tab: ${page.url()}`);
    } else {
      page = await ctx.newPage();
    }
    console.log('[capture] keep the game tab visible/frontmost — hidden tabs throttle rAF');
  } else if (GPU) {
    console.log('[capture] real GPU (headless, --gpu)');
    browser = await launchBrowser({ gpu: true });
    page = await browser.newPage({ viewport: VIEW });
  } else {
    browser = await chromium.launch({
      args: ['--enable-unsafe-swiftshader'],
      ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
    });
    page = await browser.newPage({ viewport: VIEW });
  }
  // Crash / exhaustion alarms: a crash or graphics-context loss fails the run instead of capturing broken frames.
  attachCrashAlarms(page);
  void ownPage; // an attached tab is left open for the user by design
  // SwiftShader ReadPixels stalls under this software-rendered GPU path can
  // exceed Playwright's 30s default action timeout on screenshot() calls.
  page.setDefaultTimeout(120000);
  page.on('dialog', d => void d.dismiss());
  // Surface the client's own progress logs so login failures are diagnosable.
  page.on('console', (msg) => {
    const t = msg.text();
    if (/\[AC\]|error|Error|WebGL|webgl/.test(t)) console.log(`  [page] ${t.slice(0, 160)}`);
  });
  page.on('pageerror', (err) => console.log(`  [pageerror] ${String(err).slice(0, 200)}`));

  // ── Pre-world pass: connecting/loading → login → char-create ──
  // Skipped in scenes-only mode: scenes are all in-world, and the pre-world
  // pass costs ~40s plus phantom-session reloads.
  const preworldDone = process.argv.includes('--scenes') ? [] : await capturePreWorld(page);

  // On --attach, reuse the user's already-logged-in tab rather than navigating
  // it away (re-navigating would drop them back through the phantom-session
  // window for no reason). Mirrors measure-perf.ts.
  if (!ATTACH || !isGameUrl(page.url()) || !(await inWorld(page))) {
    console.log(`[capture] navigating ${URL}`);
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
  } else {
    console.log('[capture] attached tab is already in world — skipping navigation');
  }

  // Login + DAT load + world entry can take a couple minutes (incl. the
  // phantom-session window if another client just disconnected: ACE rejects
  // with "two accounts logged on" until the stale session times out).
  // Reload every 60s so a phantom-blocked attempt retries automatically.
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (Date.now() - lastReload > 60_000) {
      console.log('[capture] not in world yet — reloading (phantom-session retry)');
      await page.reload({ waitUntil: 'domcontentloaded' });
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, '_login-failed.png') });
    await browser.close();
    throw new Error('never entered world within 240s — see _login-failed.png');
  }
  console.log('[capture] in world');
  // Let object streams settle so panels have data.
  await page.waitForTimeout(8000);

  // ── Portal space (in-world via the gameUI hook) — VISUAL2.1 ──
  // Regression runs (--no-world) pin the tunnel to a reproducible still
  // (GameUI.pinPortalSpace: frozen clock 1.8 s in, seeded roll). The live
  // tunnel differed by up to 29% between two runs of identical code.
  const portalShot = await page.evaluate((pin) => {
    const ui = (window as unknown as { __ac?: { gameUI?: { showPortalSpace?: () => void; pinPortalSpace?: (s: number, seed: number) => void } } }).__ac?.gameUI;
    if (pin && ui?.pinPortalSpace) { ui.pinPortalSpace(1.8, 1); return true; }
    if (ui?.showPortalSpace) { ui.showPortalSpace(); return true; }
    return false;
  }, NO_WORLD);
  if (portalShot) {
    await page.waitForTimeout(1800);
    await snapHealthy(page, join(PREWORLD, 'portal-space.png'));
    console.log('[preworld] portal-space.png'); preworldDone.push('portal-space');
    await page.evaluate(() => {
      const ui = (window as unknown as { __ac?: { gameUI?: { hidePortalSpace?: () => void } } }).__ac?.gameUI;
      ui?.hidePortalSpace?.();
    });
    await page.waitForTimeout(600);
  } else {
    console.log('[preworld] showPortalSpace hook not found — skipped portal-space');
  }

  // Pre-world manifest for the visual-fidelity-preworld workflow (args.captures).
  const preMeta: Record<string, { file: string; layouts: string[]; notes: string }> = {
    loading: { file: 'loading.png', layouts: [], notes: 'connecting/loading overlay during DAT load' },
    login: { file: 'login.png', layouts: ['0x21000004'], notes: 'character-select / login splash' },
    'char-create': { file: 'char-create.png', layouts: ['0x21000002'], notes: 'character creation wizard (Heritage tab)' },
    'char-create-profession': { file: 'char-create-profession.png', layouts: ['0x21000002'], notes: 'chargen Profession page' },
    'char-create-skills': { file: 'char-create-skills.png', layouts: ['0x21000002'], notes: 'chargen Skills page' },
    'char-create-appearance-face': { file: 'char-create-appearance-face.png', layouts: ['0x21000049'], notes: 'chargen Appearance, Face mode (Hair Style row, hair colour wheel)' },
    'char-create-appearance-clothes': { file: 'char-create-appearance-clothes.png', layouts: ['0x21000049'], notes: 'chargen Appearance, Clothes mode (Headgear row, trim colour wheel)' },
    'char-create-town': { file: 'char-create-town.png', layouts: ['0x21000002'], notes: 'chargen Town page' },
    'char-create-summary': { file: 'char-create-summary.png', layouts: ['0x21000002'], notes: 'chargen Summary page' },
    'portal-space': { file: 'portal-space.png', layouts: [], notes: 'portal-space transition (should be ethereal void, NOT a rock tunnel)' },
  };
  const preCaptures = preworldDone.map((name) => ({ name, ...preMeta[name] }));
  // --scenes skips capturePreWorld (which is what created this dir), so a
  // fresh clone's scenes-only run must create it before writing the manifest.
  mkdirSync(PREWORLD, { recursive: true });
  writeFileSync(join(PREWORLD, 'manifest.json'), JSON.stringify({ captures: preCaptures }, null, 2));
  console.log(`[preworld] wrote ${preCaptures.length} pre-world captures + manifest to ${PREWORLD}`);

  // ── Whole-screen scene pass (world + HUD composite) ──
  // Runs before the panel pass: scenes need a clean, panel-free screen, and
  // the panel loop leaves toggles flipped.
  const wantScenes = !process.argv.includes('--panels');
  const wantPanels = !process.argv.includes('--scenes');
  if (wantScenes) await captureScenes(page);
  if (!wantPanels) { await browser.close(); return; }

  // Close any panels persisted-open from saved UI state, so captures start clean.
  const allToggles = ['tb-inv', 'tb-char', 'tb-magic', 'tb-social', 'tb-opt', 'tb-map'];
  const isOpenProbe = async (): Promise<void> => {
    // toggling closed panels open then closed again is harmless; instead rely
    // on the harness convention: flip each toggle and screenshot-diff is
    // overkill here — panels persisted open are rare after a fresh login with
    // cleared state, so just proceed.
  };
  void isOpenProbe;

  const toggle = async (id: string): Promise<void> => {
    await page.evaluate((elId) => {
      document.getElementById(elId)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, id);
    await page.waitForTimeout(700);
  };

  const manifest: Array<Capture & { file: string }> = [];

  // Optional per-panel filter: `npx tsx tools/capture-ui-screens.ts inventory map`
  // captures only the named panels (the workflow loop re-captures one panel
  // after a fix). No args → capture all.
  const only = positionalArgs();
  const captureList = only.length ? CAPTURES.filter((c) => only.includes(c.name)) : CAPTURES;
  if (only.length) console.log(`[capture] filtered to: ${captureList.map((c) => c.name).join(', ')}`);

  for (const cap of captureList) {
    const toggled: string[] = [];
    for (const a of cap.actions) {
      if ('clickId' in a) { await toggle(a.clickId); toggled.push(a.clickId); }
      else if ('clickXY' in a) { await page.mouse.click(a.clickXY[0], a.clickXY[1]); await page.waitForTimeout(700); }
      else if ('clickSel' in a) {
        await page.evaluate((sel) => (document.querySelector(sel) as HTMLElement | null)?.dispatchEvent(new MouseEvent('click', { bubbles: true })), a.clickSel);
        await page.waitForTimeout(700);
      }
      else if ('evalJs' in a) {
        await page.evaluate((js) => { try { (0, eval)(js); } catch (e) { console.error('[capture] evalJs failed', e); } }, a.evalJs);
        await page.waitForTimeout(500);
      }
      else if ('waitSel' in a) {
        await page.waitForSelector(a.waitSel, { timeout: 5000 }).catch(() => console.error(`[capture] waitSel timed out: ${a.waitSel}`));
      }
      else await page.waitForTimeout(a.wait);
    }
    await page.waitForTimeout(800);
    if (NO_WORLD) {
      await page.evaluate(() => {
        // Server chatter (creation notices, object guids, arrival order) differs
        // every login; an empty log keeps the chat FRAME under test without it.
        (window as any).__ac?.gameUI?.clearChatPanel?.();
      });
      await setWorldCanvasHidden(page, true);
    }
    const file = `${cap.name}.png`;
    await snapHealthy(page, join(OUT, file));
    console.log(`[capture] ${file}`);
    manifest.push({ ...cap, file });
    if (cap.cleanupJs) {
      await page.evaluate((js) => { try { (0, eval)(js); } catch (e) { console.error('[capture] cleanupJs failed', e); } }, cap.cleanupJs);
    }
    // restore: flip toggles back off
    for (const id of toggled.reverse()) await toggle(id);
    await page.waitForTimeout(400);
  }

  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({
    capturedAt: new Date().toISOString(),
    viewport: await actualViewport(page),
    realGpu: ATTACH || GPU,
    renderer: await webglRenderer(page),
    retailRefDir: 'reference/images/hud',
    captures: manifest,
  }, null, 2));
  console.log(`[capture] wrote ${manifest.length} captures + manifest.json to ${OUT}`);

  await browser.close();
}

run().catch((e) => { console.error(e); process.exit(1); });
