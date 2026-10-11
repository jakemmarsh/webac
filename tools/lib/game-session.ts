/**
 * game-session — the one shared helper every live capture / probe script
 * drives the game through (DEBT.tools-sprawl). Before it, ~60 side-by-side
 * scripts and ~40 probes each re-implemented the same five things: launch
 * Playwright on SwiftShader, build the hard-coded `?ace&…account=testacjs`
 * URL, poll `acDebug.collisionState().x > 0` for world entry (reloading for
 * the phantom-session window), send an @telepoi / @teleloc, and screenshot /
 * crop / compose an HTML sheet. They live here now; tools/sidebyside.ts and
 * the probes import them.
 *
 * Environment overrides (all optional):
 *   AC_URL        full game URL (wins over everything below)
 *   AC_BASE       base origin + path, default http://localhost:3000/
 *   AC_BRIDGE     bridge URL, default ws://localhost:9090
 *   AC_ACCOUNT    default testacjs2 on macOS (Jake plays testacjs there — a
 *                 probe on his account kicks his session and can teleport his
 *                 character), testacjs elsewhere (the cloud container)
 *   AC_PASSWORD   default = the account name
 *   AC_AUTOENTER  'false' → land on character select instead of the world
 *   AC_GPU        '1' → launch on the real GPU instead of SwiftShader (--gpu)
 *   AC_ATTACH     CDP endpoint to attach to instead of launching (--attach)
 *
 * URL login (`?bridge=&account=&password=`) only works on the Vite dev server
 * or a VITE_ACJS_URL_OVERRIDES=1 build (packages/renderer/src/config/
 * urlOverrides.ts). A deployed page ignores it, even with `?debug`: drive it
 * through the launcher instead (`launcherLogin` / EnterOptions.launcher).
 */
import { chromium, type Browser, type Page } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cameraZoomToJs } from './camera-pins.js';

/** Repo root (tools/lib/ → ../..). */
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The interactive-session geometry every scene / side-by-side crop box is measured in. */
export const DEFAULT_VIEWPORT = { width: 1568, height: 775 } as const;

/** Cloud containers pin a pre-installed Chromium here (see capture-ui-screens.ts). */
export const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';

/** SwiftShader flags: headless WebGL without a GPU. */
export const SWIFTSHADER_ARGS = ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'];
/**
 * Real-GPU launch: the full-Chromium headless channel with the blocklist off
 * — the recipe tools/measure-perf.ts --gpu proved (CORE.14.d). A headed launch
 * hangs under the local harness, so this stays headless; no SwiftShader
 * opt-in, so a machine without a GPU fails loudly instead of falling back.
 */
export const GPU_ARGS = ['--ignore-gpu-blocklist'];

export interface SessionOptions {
  /** Real GPU instead of SwiftShader (also `--gpu` / AC_GPU=1). */
  gpu?: boolean;
  /** CDP endpoint to attach to (also `--attach [endpoint]` / AC_ATTACH). */
  attach?: string;
  viewport?: { width: number; height: number };
  /** Default action timeout — SwiftShader ReadPixels stalls exceed Playwright's 30 s. */
  timeoutMs?: number;
  /** Forward matching page console lines to stdout. */
  consoleFilter?: RegExp;
  /** A production build talking to a local ws:// bridge: ignore its CSP (connect-src wss: only) and Chrome's Local Network Access checks. */
  bypassCSP?: boolean;
}

export interface UrlOptions {
  /** false → `autoenter=false` (land on character select). */
  autoenter?: boolean;
  /** Cache-buster tag (`cb=`), one per script so server logs are attributable. */
  cb?: string;
  env?: NodeJS.ProcessEnv;
  /** Defaults to process.platform; decides the default account (see header). */
  platform?: NodeJS.Platform;
}

/**
 * The ACE login URL. AC_URL wins as-is (with autoenter/cb appended when asked
 * for and not already present); otherwise it is assembled from the parts.
 */
export function gameUrl(opts: UrlOptions = {}): string {
  const env = opts.env ?? process.env;
  const autoenterEnv = env.AC_AUTOENTER;
  const autoenter = opts.autoenter ?? (autoenterEnv === undefined ? true : !/^(0|false|no)$/i.test(autoenterEnv));
  let url = env.AC_URL;
  if (!url) {
    const base = env.AC_BASE ?? 'http://localhost:3000/';
    const bridge = env.AC_BRIDGE ?? 'ws://localhost:9090';
    const account = env.AC_ACCOUNT ?? ((opts.platform ?? process.platform) === 'darwin' ? 'testacjs2' : 'testacjs');
    const password = env.AC_PASSWORD ?? account;
    url = `${base}?ace&bridge=${bridge}&account=${encodeURIComponent(account)}&password=${encodeURIComponent(password)}`;
  }
  const sep = () => (url!.includes('?') ? '&' : '?');
  if (!autoenter && !/[?&]autoenter=/.test(url)) url += `${sep()}autoenter=false`;
  if (opts.cb && !/[?&]cb=/.test(url)) url += `${sep()}cb=${encodeURIComponent(opts.cb)}`;
  return url;
}

/** `--gpu` / `--attach [endpoint]` from argv, with the env fallbacks. */
export function sessionArgs(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Pick<SessionOptions, 'gpu' | 'attach'> {
  const gpu = argv.includes('--gpu') || env.AC_GPU === '1';
  const i = argv.indexOf('--attach');
  const attach = i > -1
    ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'http://localhost:9222')
    : env.AC_ATTACH || undefined;
  return { gpu, attach };
}

/** Launch Chromium (SwiftShader by default, the real GPU with gpu: true). */
/** A public page (https://playwebac.com) may not open ws://localhost under Chrome's Local Network Access checks. */
const LOCAL_NETWORK_ARGS = ['--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests'];

export async function launchBrowser(opts: Pick<SessionOptions, 'gpu' | 'bypassCSP'> = {}): Promise<Browser> {
  const extra = opts.bypassCSP ? LOCAL_NETWORK_ARGS : [];
  if (opts.gpu) return chromium.launch({ headless: true, channel: 'chromium', args: [...GPU_ARGS, ...extra] });
  return chromium.launch({
    args: [...SWIFTSHADER_ARGS, ...extra],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

/**
 * A browser + a fresh page wired the way every script wants it: long default
 * timeout, JS dialogs dismissed, optional console forwarding. With `attach`,
 * connects over CDP to a user-started Chrome (real GPU) instead.
 */
export async function openSession(opts: SessionOptions = {}): Promise<{ browser: Browser; page: Page }> {
  let browser: Browser;
  let page: Page;
  if (opts.attach) {
    browser = await chromium.connectOverCDP(opts.attach);
    const ctx = browser.contexts()[0] ?? (await browser.newContext());
    page = await ctx.newPage();
    if (opts.viewport) await page.setViewportSize(opts.viewport);
  } else {
    browser = await launchBrowser(opts);
    page = await browser.newPage({ viewport: opts.viewport ?? DEFAULT_VIEWPORT, ...(opts.bypassCSP ? { bypassCSP: true } : {}) });
  }
  page.setDefaultTimeout(opts.timeoutMs ?? 120_000);
  page.on('dialog', (d) => void d.dismiss());
  attachCrashAlarms(page);
  if (opts.consoleFilter) {
    const re = opts.consoleFilter;
    page.on('console', (m) => { const t = m.text(); if (re.test(t)) console.log(`  [page] ${t.slice(0, 200)}`); });
  }
  return { browser, page };
}

// ── State probes (page-side source strings: tsx/esbuild injects a `__name`
// helper into evaluated closures that the page does not have) ──────────────

/** In world: the player's collision body has a position. */
/** In the world AND visible: the client has sent LoginComplete (ACE keeps the player Hidden until then; DECOMP.login-complete-timing). */
export const IN_WORLD_JS = '(() => { const c = window.acDebug && window.acDebug.collisionState && window.acDebug.collisionState(); return !!(c && c.x > 0 && c.loginComplete !== false); })()';
/** Character select is up with the list loaded. */
export const AT_CHAR_SELECT_JS = "(() => { const i = document.getElementById('charsel-inner'); if (i && i.dataset.mode === 'select') return true;"
  + " const ui = window.__ac && window.__ac.gameUI; return !!(ui && ui.uiManager && ui.uiManager.currentScreen === 'character-select'); })()";
/** The chargen wizard is mounted. */
export const IN_CHARGEN_JS = "!!document.getElementById('chargen-root')";

export async function isTrue(page: Page, js: string): Promise<boolean> {
  return !!(await page.evaluate(js).catch(() => false));
}
export const inWorld = (page: Page): Promise<boolean> => isTrue(page, IN_WORLD_JS);
export const atCharSelect = (page: Page): Promise<boolean> => isTrue(page, AT_CHAR_SELECT_JS);

export interface WaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** Reload after this long without success (phantom-session retry); 0 = never. */
  reloadEveryMs?: number;
  /** How to retry: page.reload() or page.goto(url). */
  reloadVia?: 'reload' | 'goto';
  url?: string;
  /** Called each poll before the check (e.g. drive character creation on a fresh DB). */
  onPoll?: (page: Page) => Promise<void>;
  log?: (s: string) => void;
}

/** Poll a page-side boolean expression, reloading on a stall. */
export async function waitFor(page: Page, js: string, opts: WaitOptions = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 360_000;
  const pollMs = opts.pollMs ?? 2000;
  const reloadEvery = opts.reloadEveryMs ?? 60_000;
  const t0 = Date.now();
  let lastReload = t0;
  while (Date.now() - t0 < timeoutMs) {
    // A poll interrupted by a navigation is retried next time; any other error (a refused character, a choice
    // that doesn't exist) ends the wait instead of being retried forever in silence.
    if (opts.onPoll) await opts.onPoll(page).catch((e) => { if (!/Execution context was destroyed|navigat|Target (page, context or browser )?closed|frame was detached/i.test(String((e as Error)?.message ?? e))) throw e; });
    if (await isTrue(page, js)) return true;
    if (reloadEvery > 0 && Date.now() - lastReload > reloadEvery) {
      opts.log?.('still waiting — reloading (phantom-session retry)');
      if (opts.reloadVia === 'goto' && opts.url) await page.goto(opts.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      else await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      lastReload = Date.now();
    }
    await page.waitForTimeout(pollMs);
  }
  return isTrue(page, js);
}

export const waitForWorld = (page: Page, opts: WaitOptions = {}): Promise<boolean> => waitFor(page, IN_WORLD_JS, opts);
export const waitForCharSelect = (page: Page, opts: WaitOptions = {}): Promise<boolean> => waitFor(page, AT_CHAR_SELECT_JS, opts);

/**
 * On a fresh DB the account has no character: when the client lands on
 * character-create, send one (the pattern capture-core17d-radar used).
 */
/**
 * The chargen roll probes create their character from. A fresh chargen opens
 * on RandomizeCharacter (gmCharGenMainUI ctor), so a probe re-opens it seeded:
 * seed 7 rolls an Aluvian male starting in Holtburg (the Soldier template),
 * where probe characters always spawned.
 */
export const PROBE_CHARGEN_SEED = 7;
/** Page-side source: re-open the chargen on the probe seed (`ui` = window.__ac.gameUI). */
export const PROBE_CHARGEN_REOPEN_JS = `if (ui.pinChargenRandom) { ui.pinChargenRandom(${PROBE_CHARGEN_SEED}); ui.showCharacterCreate(); }`;

/** A new character's choices by name (GameUI.agentChooseCharacter); `seed` pins the chargen's appearance roll (default PROBE_CHARGEN_SEED). */
export interface CharacterChoices {
  template?: string; heritage?: string; gender?: string; town?: string; seed?: number;
  /** Attribute values in the order to set them (each locked once set): { strength: 100, … }. */
  attributes?: Record<string, number>;
  /** Skill name → specialized | trained | untrained. */
  skills?: Record<string, string>;
}

export function createCharacterIfNeeded(name: string, opts: CharacterChoices = {}): (page: Page) => Promise<void> {
  // When the create went out; resent if the chargen is still (or again) up 20 s later — the request
  // can be lost to a re-login or reload in between, and a lost one would otherwise never be retried.
  let sentAt = 0;
  const seenErrors = new Set<string>();
  return async (page) => {
    if (sentAt && Date.now() - sentAt < 20_000) return;
    const r = await page.evaluate(`(() => { const ui = window.__ac && window.__ac.gameUI;
      if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create' || !ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return false;
      ${opts.seed === undefined ? PROBE_CHARGEN_REOPEN_JS : `if (ui.pinChargenRandom) { ui.pinChargenRandom(${Math.floor(opts.seed)}); ui.showCharacterCreate(); }`}
      ${opts.template || opts.heritage || opts.gender || opts.town || opts.attributes || opts.skills ? `{ const err = ui.agentChooseCharacter && ui.agentChooseCharacter(${JSON.stringify({ template: opts.template, heritage: opts.heritage, gender: opts.gender, town: opts.town, attributes: opts.attributes, skills: opts.skills })}); if (err) throw new Error(err); }` : ''}
      ui.wizard.name = ${JSON.stringify(name)}; ui.callbacks.onCharacterCreated(ui.wizard); return true; })()`).catch((e) => {
      if (/no (profession|heritage|starting town|attribute|skill)|gender must|attributes don't fit|skill level for|can't make/.test(String(e))) throw e;
      // A navigation mid-poll is expected; anything else is worth seeing once.
      const msg = String((e as Error)?.message ?? e);
      if (!/Execution context was destroyed|navigation/i.test(msg) && !seenErrors.has(msg)) { seenErrors.add(msg); console.warn(`[createCharacterIfNeeded] ${msg.slice(0, 300)}`); }
      return false;
    });
    if (r) sentAt = Date.now();
  };
}

/** A launcher login: CUSTOM… → this bridge, then the account fields and ENTER. */
export interface LauncherLogin {
  /** The bridge to enter as a Custom… world (wss://, or ws:// on localhost). */
  bridge: string;
  account: string;
  password: string;
}

/**
 * Log in through the launcher the way a player does: the only login a
 * deployed page accepts (URL login is dev-only). Resolves once ENTER is
 * pressed; wait for char select / the world afterwards.
 */
export async function launcherLogin(page: Page, login: LauncherLogin, timeoutMs = 180_000): Promise<void> {
  if (!(await waitFor(page, `!!document.querySelector('.launcher-custom')`, { timeoutMs, reloadEveryMs: 0, pollMs: 500 }))) {
    throw new Error('the launcher never appeared');
  }
  await page.evaluate(`document.querySelector('.launcher-custom').click()`);
  await page.locator('input.ac-dialog-entry').fill(login.bridge);
  await page.locator('[data-element-id="0x2e"]').last().click(); // the text-entry dialog's Done
  await page.waitForTimeout(1000);
  await page.locator('input.launcher-account').fill(login.account);
  await page.locator('input.launcher-password').fill(login.password);
  await page.evaluate(`document.querySelector('.launcher-enter').click()`);
}

/** Page-side source: press character select's ENTER (0x100003a2) on the selected character. */
export const PRESS_CHARSEL_ENTER_JS = `(() => { const el = [...document.querySelectorAll('[data-ac-press]')].find(e => e.dataset.acPress.toLowerCase().includes('100003a2') && e.offsetParent !== null); if (el) el.click(); return !!el; })()`;
/**
 * Page-side source: an account with no characters opens chargen (as CREATE
 * would). URL login does this on its own; a launcher login stays on the
 * empty list, as retail did.
 */
export const OPEN_CHARGEN_IF_EMPTY_JS = `(() => { const ui = window.__ac && window.__ac.gameUI;
  if (!ui || !Array.isArray(ui.lastCharacterSlots) || ui.lastCharacterSlots.length > 0) return false;
  ui.showCharacterCreate(); return true; })()`;

export interface EnterOptions extends SessionOptions, WaitOptions {
  cb?: string;
  /**
   * Log in through the launcher instead of the URL (a deployed page), then
   * press ENTER at character select. Page reloads are off: they would drop
   * back to the launcher.
   */
  launcher?: LauncherLogin;
  /** Extra settle after entry (object streams, panels with data). */
  settleMs?: number;
  /** Create a character with this name if the account has none. */
  createCharacter?: string;
}

/** Launch, log in and wait for world entry. Throws if the world never comes up. */
export async function enterWorld(opts: EnterOptions = {}): Promise<{ browser: Browser; page: Page; url: string; ms: number }> {
  const { browser, page } = await openSession(opts);
  const url = opts.url ?? gameUrl({ cb: opts.cb });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  let onPoll = opts.onPoll ?? (opts.createCharacter ? createCharacterIfNeeded(opts.createCharacter) : undefined);
  if (opts.launcher) {
    await launcherLogin(page, opts.launcher);
    const create = onPoll;
    let entered = false;
    onPoll = async (p) => {
      if (create) await create(p);
      if (entered || !(await isTrue(p, AT_CHAR_SELECT_JS))) return;
      if (opts.createCharacter && (await isTrue(p, OPEN_CHARGEN_IF_EMPTY_JS))) return;
      entered = await isTrue(p, PRESS_CHARSEL_ENTER_JS);
    };
  }
  const ok = await waitForWorld(page, {
    ...opts, url, onPoll,
    ...(opts.launcher ? { reloadEveryMs: 0 } : {}),
  });
  if (!ok) {
    await browser.close().catch(() => {});
    throw new Error(`never entered world within ${Math.round((opts.timeoutMs ?? 360_000) / 1000)} s (${url})`);
  }
  const ms = Date.now() - t0;
  if (opts.settleMs) await page.waitForTimeout(opts.settleMs);
  return { browser, page, url, ms };
}

/** Launch with autoenter=false and wait for character select. */
export async function enterCharSelect(opts: EnterOptions = {}): Promise<{ browser: Browser; page: Page; url: string }> {
  const { browser, page } = await openSession(opts);
  const url = opts.url ?? gameUrl({ cb: opts.cb, autoenter: false });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  if (!(await waitForCharSelect(page, { ...opts, url }))) {
    await browser.close().catch(() => {});
    throw new Error(`character select never appeared (${url})`);
  }
  if (opts.settleMs) await page.waitForTimeout(opts.settleMs);
  return { browser, page, url };
}

// ── Admin commands / teleports ──────────────────────────────────────────

/**
 * Send an admin command. `via: 'chat'` goes through the chat box
 * (acDebug.sendChat → GameUI's onChatSend, the path a typed command takes);
 * `via: 'talk'` sends the raw Talk action (acDebug.admin).
 */
/** Delete objects through ACE's @delete, which acts on the appraised object: clear the selection (drops HealthQueryTarget/ManaQueryTarget, which @delete would prefer), appraise, delete, wait until gone. */
export async function deleteObjects(page: Page, guids: number[]): Promise<number> {
  let removed = 0;
  for (const g of guids) {
    const present = () => page.evaluate((id) => {
      const ac = (window as any).__ac;
      return !!(ac?.serverObjectManager?.getObject?.(id) || ac?.playerState?.inventory?.getItem?.(id));
    }, g);
    if (!(await present())) continue;
    await page.evaluate(() => { const ui = (window as any).__ac?.gameUI; if (ui) { ui.hudState.target = null; ui.updateHUD(); } });
    await page.waitForTimeout(400);
    await page.evaluate((id) => (window as any).__ac?.identifyObject?.(id), g);
    await page.waitForTimeout(900);
    await page.evaluate(() => (window as any).acDebug?.admin?.('@delete'));
    for (let i = 0; i < 12 && (await present()); i++) await page.waitForTimeout(500);
    if (await present()) console.log(`[cleanup] 0x${g.toString(16)} still present after @delete`);
    else removed++;
  }
  return removed;
}
/**
 * Probe hygiene: @delete the dynamic world objects (guid >= 0x80000000) of
 * these weenie classes the client sees within `radius` m of the player.
 * Probes that @create chests, monsters or ground items call this when done,
 * so their spawns do not linger in other sessions' captures (a probe chest
 * once showed up in a GPU screen-regression pass).
 */
export async function deleteSpawnsNear(page: Page, wcids: readonly number[], radius = 40): Promise<number> {
  const guids = await page.evaluate(([ws, r]) => {
    const ac = (window as any).__ac;
    const p = ac?.playerModel?.position;
    const out: number[] = [];
    for (const [guid, o] of ac?.serverObjectManager?.getAllObjects?.() ?? []) {
      if ((guid >>> 0) < 0x80000000 || !(ws as number[]).includes(o.weenieClassId)) continue;
      const m = o.mesh?.position;
      if (p && m && Math.hypot(m.x - p.x, m.z - p.z) > (r as number)) continue;
      out.push(guid >>> 0);
    }
    return out;
  }, [wcids as number[], radius] as const);
  return guids.length ? deleteObjects(page, guids) : 0;
}

export async function adminCommand(page: Page, cmd: string, via: 'chat' | 'talk' = 'chat'): Promise<void> {
  const text = cmd.startsWith('@') ? cmd : `@${cmd}`;
  await page.evaluate(via === 'chat'
    ? `window.acDebug.sendChat(${JSON.stringify(text)})`
    : `window.acDebug.admin(${JSON.stringify(text)})`);
}

/**
 * Type a chat line exactly as written (acDebug.sendChat → GameUI's onChatSend,
 * the path the chat box takes): "@…" lines are admin commands, anything else
 * is spoken (HARNESS.retail-ab-say-through-admin — adminCommand's added "@"
 * turned "Hello Dereth" into an unknown command).
 */
export async function chatLine(page: Page, text: string): Promise<void> {
  await page.evaluate(`window.acDebug.sendChat(${JSON.stringify(text)})`);
}

/** @telepoi <poi>, then wait for the landblock to stream in. */
export async function telepoi(page: Page, poi: string, settleMs = 20_000, via: 'chat' | 'talk' = 'chat'): Promise<void> {
  await adminCommand(page, `@telepoi ${poi}`, via);
  await page.waitForTimeout(settleMs);
}

/** @teleloc <cell> [x y z] qw qx qy qz — ACE wants the full form (see capture-scenes DUNGEON). */
export async function teleloc(page: Page, loc: string, settleMs = 20_000, via: 'chat' | 'talk' = 'chat'): Promise<void> {
  await adminCommand(page, `@teleloc ${loc}`, via);
  await page.waitForTimeout(settleMs);
}

/** `acDebug.collisionState()` — x/z are world metres, feetY / lastFloor heights. */
export interface CollisionState { x: number; z: number; feetY?: number; lastFloor?: number; onGround?: boolean; playerYaw?: number; [k: string]: unknown }
export const collisionState = (page: Page): Promise<CollisionState> => page.evaluate('window.acDebug.collisionState()') as Promise<CollisionState>;

/** Evaluate an expression with `ac` bound to window.__ac (and `dbg` to window.acDebug). */
export function readAc<T>(page: Page, expr: string): Promise<T> {
  return page.evaluate(`(() => { const ac = window.__ac; const dbg = window.acDebug; return (${expr}); })()`) as Promise<T>;
}

/** Dispatch a click on the first element matching `sel`; false when missing. */
export function clickSel(page: Page, sel: string): Promise<boolean> {
  return page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`) as Promise<boolean>;
}

/** Run page JS that may throw without failing the script (scene evalJs / cleanupJs). */
export async function evalSafe(page: Page, js: string, tag = 'evalJs'): Promise<void> {
  await page.evaluate(`(() => { try { (0, eval)(${JSON.stringify(js)}); } catch (e) { console.error(${JSON.stringify(`[game-session] ${tag} failed`)}, e); } })()`);
}

// ── World-scene pinning (capture-scenes.ts Scene semantics) ─────────────

export interface WorldPins {
  teleport?: string;
  teleportVia?: 'chat' | 'talk';
  teleportSettleMs?: number;
  timeOfDay?: number;
  weather?: boolean;
  dayGroup?: string | number;
  yaw?: number;
  cameraDistance?: number;
  toggles?: string[];
  evalJs?: string;
  settleMs?: number;
}

/**
 * Pin a lighting-comparable frame the way capture-ui-screens --scenes does:
 * teleport, weather off unless asked, the day group pinned (CORE.17.r), the
 * clock FROZEN (not set — the world clock overwrites a set within ~1 s),
 * yaw, camera distance, toolbar toggles, page JS, settle.
 */
export async function applyWorldPins(page: Page, s: WorldPins, log: (m: string) => void = console.log): Promise<void> {
  if (s.teleport) await adminCommand(page, s.teleport, s.teleportVia ?? 'talk');
  if (s.teleport) await page.waitForTimeout(s.teleportSettleMs ?? 4000);
  await page.evaluate(`window.__ac && window.__ac.skybox && window.__ac.skybox.setWeatherEnabled && window.__ac.skybox.setWeatherEnabled(${s.weather === true})`);
  if (s.dayGroup !== undefined) {
    const pin = await page.evaluate(`window.acDebug && window.acDebug.pinDayGroup && window.acDebug.pinDayGroup(${JSON.stringify(s.dayGroup)})`) as { ok?: boolean; name?: string } | undefined;
    if (!pin?.ok) log(`WARNING day-group pin ${JSON.stringify(s.dayGroup)} did not take`);
  }
  if (s.timeOfDay !== undefined) {
    const pin = await page.evaluate(`window.acDebug && window.acDebug.freezeTimeOfDay && window.acDebug.freezeTimeOfDay(${s.timeOfDay})`) as { frozen?: boolean } | undefined;
    if (!pin?.frozen) log('WARNING time-of-day freeze did not take');
  }
  if (s.yaw !== undefined) await page.evaluate(`window.acDebug && window.acDebug.setPlayerYaw && window.acDebug.setPlayerYaw(${s.yaw})`);
  if (s.cameraDistance !== undefined) await page.evaluate(cameraZoomToJs(s.cameraDistance));
  for (const id of s.toggles ?? []) {
    await clickSel(page, `#${id}`);
    await page.waitForTimeout(700);
  }
  if (s.evalJs) await evalSafe(page, s.evalJs);
  await page.waitForTimeout(s.settleMs ?? 2500);
}

// ── Screenshots, crops and HTML sheets ──────────────────────────────────

export interface Box { x: number; y: number; w: number; h: number }

/** Parse `x,y,w,h`. */
export function parseCrop(s: string): Box {
  const n = s.split(/[ ,x]+/).map(Number);
  if (n.length !== 4 || n.some((v) => !Number.isFinite(v))) throw new Error(`bad crop "${s}" — want x,y,w,h`);
  return { x: n[0], y: n[1], w: n[2], h: n[3] };
}

/**
 * The on-screen box of a CSS selector (`#hud-chat`) or a page expression
 * yielding an element (`window.__ac.gameUI.vendorWrapper`), padded and
 * clamped to the viewport. Null when absent or zero-sized.
 */
export async function elementBox(page: Page, target: string, pad = 0): Promise<Box | null> {
  const isExpr = !/^[#.[a-z]/i.test(target) || target.startsWith('window.');
  const r = await page.evaluate(`(() => { const el = ${isExpr ? target : `document.querySelector(${JSON.stringify(target)})`};
    if (!el || !el.getBoundingClientRect) return null; const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight } : null; })()`).catch(() => null) as
    { x: number; y: number; w: number; h: number; vw: number; vh: number } | null;
  if (!r) return null;
  const x = Math.max(0, Math.floor(r.x - pad));
  const y = Math.max(0, Math.floor(r.y - pad));
  return { x, y, w: Math.min(r.vw - x, Math.ceil(r.w + 2 * pad)), h: Math.min(r.vh - y, Math.ceil(r.h + 2 * pad)) };
}

// ── Crash / exhaustion alarms (2026-10-03 resource sweep, proposal 3) ──
//
// A tool must never quietly capture a broken frame. The page side counts GPU
// context losses (packages/renderer/src/ui/ContextHealth.ts → window.__acHealth,
// deliberate portal-space releases excluded). The Playwright side records page
// crashes and uncaught errors. `shot()` refuses to capture once anything fatal
// has happened; long runs (soaks, perf) check `healthSignals` at each sample.

export class CrashSignal extends Error {}

interface PageAlarms { crashed: boolean; pageErrors: string[] }
const ALARMS = new WeakMap<Page, PageAlarms>();

/** Start recording page crashes and uncaught page errors (openSession does this). */
export function attachCrashAlarms(page: Page): void {
  if (ALARMS.has(page)) return;
  const a: PageAlarms = { crashed: false, pageErrors: [] };
  ALARMS.set(page, a);
  page.on('crash', () => { a.crashed = true; });
  page.on('pageerror', (e) => { if (a.pageErrors.length < 20) a.pageErrors.push(String(e?.message ?? e).slice(0, 300)); });
}

export interface HealthSignals {
  crashed: boolean;
  webglLost: number;
  canvas2dLost: number;
  pageErrors: string[];
  events: Array<{ type: string; canvas: string }>;
}

/** Everything the page and the browser have reported so far. */
export async function healthSignals(page: Page): Promise<HealthSignals> {
  const a = ALARMS.get(page) ?? { crashed: false, pageErrors: [] };
  if (a.crashed) return { crashed: true, webglLost: 0, canvas2dLost: 0, pageErrors: a.pageErrors, events: [] };
  const h = await page.evaluate('window.__acHealth || null').catch(() => null) as
    { webglLost: number; canvas2dLost: number; events: Array<{ type: string; canvas: string }> } | null;
  return { crashed: false, webglLost: h?.webglLost ?? 0, canvas2dLost: h?.canvas2dLost ?? 0, pageErrors: a.pageErrors, events: h?.events ?? [] };
}

/** A fatal signal's one-line description, or null. Page errors are reported but not fatal on their own. */
export function fatalReason(s: HealthSignals): string | null {
  if (s.crashed) return 'the page crashed';
  if (s.webglLost > 0 || s.canvas2dLost > 0) {
    const last = s.events.filter((e) => e.type.endsWith('lost')).slice(-1)[0];
    return `graphics context lost (${s.webglLost} WebGL, ${s.canvas2dLost} 2D${last ? `; last on ${last.canvas}` : ''})`;
  }
  return null;
}

/** Throw CrashSignal if the page crashed or lost a graphics context. */
export async function assertHealthy(page: Page, tag = 'page'): Promise<void> {
  const why = fatalReason(await healthSignals(page));
  if (why) throw new CrashSignal(`${tag}: ${why}. The frame would be broken; refusing to continue.`);
}

/** Screenshot (whole viewport, or `clip`). Creates the directory. Refuses after a crash or context loss. */
export async function shot(page: Page, file: string, clip?: Box): Promise<string> {
  await assertHealthy(page, `screenshot ${file}`);
  mkdirSync(dirname(file), { recursive: true });
  await page.screenshot({ path: file, timeout: 150_000, ...(clip ? { clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h } } : {}) });
  return file;
}

export function dataUrl(file: string): string {
  const ext = file.endsWith('.webp') ? 'webp' : /\.jpe?g$/i.test(file) ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}

const escHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One labelled crop of an image at `zoom`x (whole image when no crop). Needs the image's size only when cropless. */
export function cropCellHtml(file: string, label: string, crop: Box | null, zoom: number, src: string = dataUrl(file)): string {
  if (!crop) {
    return `<div class="cell"><div class="lbl">${escHtml(label)}</div><img src="${src}" style="zoom:${zoom};image-rendering:pixelated;border:1px solid #444"/></div>`;
  }
  return `<div class="cell"><div class="lbl">${escHtml(label)}</div>
    <div class="clip" style="width:${crop.w * zoom}px;height:${crop.h * zoom}px">
      <img src="${src}" style="position:absolute;left:${-crop.x * zoom}px;top:${-crop.y * zoom}px;transform-origin:0 0;transform:scale(${zoom});image-rendering:pixelated"/>
    </div></div>`;
}

/** A whole frame scaled to `width` px. */
export function frameCellHtml(file: string, label: string, width = 780, src: string = dataUrl(file)): string {
  return `<div class="cell"><div class="lbl">${escHtml(label)}</div><img src="${src}" style="width:${width}px;height:auto;border:1px solid #444"/></div>`;
}

export const SHEET_CSS = `<style>
  body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
  .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin-top:12px}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{color:#ffd;white-space:normal;max-width:900px}
  .clip{position:relative;overflow:hidden;background:#000;border:1px solid #444}
  h1{font-size:14px;margin:0 0 8px} p{max-width:1900px;color:#ccc;margin:0 0 8px}
</style>`;

/** Wrap rows into a sheet document. */
export function sheetHtml(title: string, rows: string[][], note?: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${escHtml(title)}</title>${SHEET_CSS}<h1>${escHtml(title)}</h1>`
    + (note ? `<p>${escHtml(note)}</p>` : '')
    + rows.map((cells) => `<div class="row">${cells.join('')}</div>`).join('');
}

/**
 * Write `html` next to `png` and screenshot it full-page. Opens a page in
 * `browser` (or launches a throwaway SwiftShader one).
 */
export async function renderSheet(html: string, png: string, browser?: Browser, viewport = { width: 2400, height: 1000 }): Promise<string> {
  mkdirSync(dirname(png), { recursive: true });
  writeFileSync(png.replace(/\.png$/, '.html'), html);
  const own = !browser;
  const br = browser ?? (await launchBrowser());
  const page = await br.newPage({ viewport });
  await page.setContent(html);
  await page.waitForTimeout(400);
  await page.screenshot({ path: png, fullPage: true });
  await page.close();
  if (own) await br.close();
  return png;
}
