/**
 * streaming-ab — the A/B regression gate for DAT streaming
 * (RELEASE.streaming-regression-gate; docs/dat-streaming.md §6.5).
 *
 * Runs the SAME scripted session twice against the local ACE, one headless
 * browser at a time: first with whole DATs (`&rawDats`, Vite serving dat/),
 * then streaming the published set (default the R2 EoL set) from a fresh
 * profile (empty OPFS: the cold, worst case). At every capture it waits for
 * the streamed misses to land (≤ settle cap), then records:
 *   - a full-viewport screenshot (+ the panel's on-screen box);
 *   - the DOM icon signature of the surface: every data-URL image under it
 *     (item icons, slot art, glyphs), as a multiset of hashes. The same DAT
 *     bytes decode to the same data URL, so a letter placeholder, a missing
 *     layer or a palette-less icon shows up as a hash that differs;
 *   - text runs: each DAT-font canvas's pixels, each browser-font fallback span
 *   - white-fallback particle systems (no more than whole DATs drew)
 *   - the player model's signature (per mesh: material texture pixels hash or
 *     flat colour) and the signature of every server object both runs saw;
 *   - the streaming counters: unresolved misses (must be 0) and icon holders
 *     still pending (must be 0).
 *
 * Script (both runs): enter world → @teleloc Holtburg → world + toolbar →
 * inventory (backpack + paperdoll) → wield the dirk + shield + platemail
 * (created once with @ci) → inventory +
 * world → unwield the shield → inventory → character panel → magic panel →
 * @teleloc Shoushi → world + inventory → take everything off again (both runs
 * then log in at Shoushi and start from the same baseline).
 *
 * Output: verification/dat-streaming/ab/<stamp>/ — raw/ + stream/ frames,
 * one side-by-side sheet per capture (raw | stream | pixel diff) and
 * verdict.json (PASS only if every hard check passes; pixel diffs are
 * reported, not gated: NPCs move and the 3D frames are never identical).
 *
 * Usage (your own Vite + bridge pinned to the local ACE; never :9090, never a public server):
 *   AC_BASE=http://localhost:3241/ AC_BRIDGE=ws://localhost:9097 AC_ACCOUNT=streamab1 \
 *     npx tsx tools/streaming-ab.ts [--set <pointer url>] [--out <dir>] [--only raw|stream]
 * The account must be a fresh, admin local account (ACE auto-creates it; the
 * local ACE makes new accounts admin) — never testacjs / testacjs2 / testacjs3.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import type { Browser, Page } from 'playwright';
import { type Box, REPO, cropCellHtml, enterWorld, launchBrowser, renderSheet, sheetHtml } from './lib/game-session.js';

const argv = process.argv.slice(2);
const opt = (f: string, d: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const SET = opt('--set', 'https://dats.playwebac.com/v1/sets/eol-p2072-c982-h497-l994.json');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = opt('--out', join(REPO, 'verification/dat-streaming/ab', STAMP));
/**
 * --prod <url>: check a deployed build after flipping ACJS_DAT_SET_URL. Runs only
 * the stream half against that site (its own config.json datSet, `&debug` for
 * acDebug, CSP + Local Network Access bypassed so it can reach the local ws://
 * bridge) and compares it with the raw captures of an earlier run of the same
 * script (--raw-from <dir>). A deployed page ignores URL login and ?bridge
 * (config/urlOverrides.ts), so it logs in through the launcher's CUSTOM… world.
 * Start that bridge with BRIDGE_ALLOWED_ORIGINS=https://playwebac.com or it
 * answers 403.
 */
const PROD = opt('--prod', '');
/**
 * --era <id>: run both sessions in a classic era (docs/dat-streaming.md §6.9):
 * raw = that era's whole DATs, stream = --set as that era's set (`eraDatSet`).
 * Point AC_BRIDGE at a bridge pinned to that era's server.
 */
const ERA = opt('--era', '');
const RAW_FROM = opt('--raw-from', '');
const ONLY = PROD ? 'stream' : opt('--only', '');
const ACCOUNT = process.env.AC_ACCOUNT ?? 'streamab1';
if (/^testacjs\d?$/i.test(ACCOUNT)) throw new Error(`refusing to drive ${ACCOUNT}: use a fresh local account (e.g. streamab1)`);
const BASE = PROD || (process.env.AC_BASE ?? 'http://localhost:3241/');
const BRIDGE = process.env.AC_BRIDGE ?? 'ws://localhost:9097';
const CHAR = process.env.AC_CHAR_NAME ?? 'Streamab';
/** How long a capture waits for streamed misses / pending icons to land. */
const SETTLE_CAP_MS = 25_000; // also covers ACE's Hidden window (~7 s)

const HOLTBURG = '@teleloc 0xA9B40019 [85.0 20.5 94.0] 1 0 0 0';
const SHOUSHI = '@teleloc 0xDA55001D [84.8 99.0 20.0] 1 0 0 0';
const WIELD: Array<[string, string]> = [['Training Dirk', 'MeleeWeapon'], ['Round Shield', 'Shield']];
/** The academy character's worn starter clothes (the baseline every run restores). */
const STARTER_CLOTHES: Array<[string, string]> = [['Doublet', 'ChestWear'], ['Trousers', 'UpperLegWear'], ['Leather Boots', 'FootWear']];
/**
 * Heavier armor than the academy kit (ClothingTable palettes, many parts and
 * textures — what Jake's character wore): created once on the probe
 * character with the admin @ci (the local ACE makes new accounts admin),
 * then worn and removed by every run. [name, weenie class id, EquipMask slot].
 */
const ARMOR: Array<[string, number, string]> = [
  ['Platemail Hauberk', 72, 'ChestArmor'],
  ['Platemail Leggings', 82, 'UpperLegArmor'],
  ['Platemail Gauntlets', 57, 'HandWear'],
  ['Sollerets', 107, 'FootWear'],
];

type Mode = 'raw' | 'stream';
type Multiset = Record<string, number>;

interface Capture {
  name: string;
  file: string;
  box: Box | null;
  icons: Multiset | null;
  model: Multiset | null;
  objects: Record<string, string>;
  unresolvedMisses: number | null;
  pendingIcons: number;
  /** Our PhysicsState Hidden bit and LoginComplete sent (a teleport that never finished leaves us hidden). */
  hidden: boolean;
  loginComplete: boolean;
  settleMs: number;
  missesByType: Record<string, number> | null;
  /** Particle systems created so far that drew the untextured white fallback (ParticleSystem.stats). */
  whiteParticles: number;
}

// ── page-side probes (strings: tsx must not transform them) ──────────────
const PAGE_HELPERS = `(() => {
  if (window.__abHelpers) return;
  const fnv = (s, step) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i += step) { h ^= s.charCodeAt ? s.charCodeAt(i) : s[i]; h = Math.imul(h, 0x01000193) >>> 0; } return (h >>> 0).toString(16) + ':' + s.length; };
  const urlsUnder = (root) => {
    const out = {};
    if (!root) return null;
    const add = (u) => { if (!u || !u.startsWith('data:')) return; const k = fnv(u, 3); out[k] = (out[k] || 0) + 1; };
    for (const el of [root, ...root.querySelectorAll('*')]) {
      const bg = el.style && el.style.backgroundImage;
      if (bg) for (const m of bg.matchAll(/url\\(["']?([^"')]+)["']?\\)/g)) add(m[1]);
      if (el.tagName === 'IMG') add(el.getAttribute('src'));
      // Text runs: a DAT-font canvas (its pixels) or a browser-font span fallback
      // (a font whose glyph surface had not streamed in, 2026-10-06).
      if (el.dataset && el.dataset.acRunText !== undefined) {
        if (el.tagName === 'CANVAS') add(el.toDataURL());
        else { const k = 'fallback-font:' + el.dataset.acRunText; out[k] = (out[k] || 0) + 1; }
      }
    }
    return out;
  };
  const texSig = (m) => {
    if (!m) return 'none';
    const t = m.map;
    if (t && t.image && t.image.data) return 'tex:' + t.image.width + 'x' + t.image.height + ':' + fnv(t.image.data, 7);
    return 'col:' + (m.color ? m.color.getHexString() : '?') + (m.opacity !== undefined ? ':' + m.opacity.toFixed(2) : '');
  };
  const modelSig = (root) => {
    if (!root) return null;
    const out = {};
    // What is drawn only: a degrade level built once and hidden since (DegradeLod keeps its
    // holders) depends on the camera's path, not on the DAT bytes (2026-10-08, a door's lod_1).
    root.traverseVisible((o) => {
      if (!o.isMesh) return;
      for (const m of (Array.isArray(o.material) ? o.material : [o.material])) { const k = texSig(m); out[k] = (out[k] || 0) + 1; }
    });
    return out;
  };
  window.__abHelpers = { urlsUnder, modelSig,
    objectSigs: () => {
      const out = {};
      const som = window.__ac.serverObjectManager;
      if (!som) return out;
      for (const [guid, o] of som.getAllObjects()) {
        if (!o.mesh) continue;
        const sig = modelSig(o.mesh);
        out[(guid >>> 0).toString(16)] = Object.entries(sig).sort().map(([k, n]) => k + '*' + n).join(',');
      }
      return out;
    },
  };
})()`;

const PANEL_ROOT: Record<string, string> = {
  inventory: '(ui.inventoryPanel && ui.inventoryPanel.isConnected ? ui.inventoryPanel : (ui.inventoryPanelHandle && ui.inventoryPanelHandle.root))',
  character: '(ui.charPanel && ui.charPanel.isConnected ? ui.charPanel : (ui.charPanelHandle && ui.charPanelHandle.root))',
  magic: '(ui.magicPanel && ui.magicPanel.isConnected ? ui.magicPanel : (ui.magicPanelHandle && ui.magicPanelHandle.root))',
  toolbar: "document.getElementById('hud-toolbar-window')",
  world: 'null',
};

async function streamCounters(page: Page): Promise<{ unresolved: number | null; pending: number; missesByType: Record<string, number> | null }> {
  return page.evaluate(`(() => { const s = window.__datStream && window.__datStream.store.stats;
    return { unresolved: s ? s.unresolvedMisses : null, pending: window.__ac.gameUI.pendingIconCount || 0, missesByType: s ? s.missesByType : null }; })()`) as Promise<{ unresolved: number | null; pending: number; missesByType: Record<string, number> | null }>;
}

/** Wait until no streamed miss is in flight and no icon holder is pending (bounded), then a short quiet. */
async function settle(page: Page): Promise<number> {
  const t0 = Date.now();
  await page.waitForTimeout(1500);
  while (Date.now() - t0 < SETTLE_CAP_MS) {
    const c = await streamCounters(page);
    // ACE hides the player for a few seconds around teleports and some equips
    // (the pink-bubble Hidden script, both modes): capture outside that window.
    const hidden = (await page.evaluate('(window.acDebug.collisionState().physicsState & 0x4000) !== 0').catch(() => false)) as boolean;
    if ((c.unresolved ?? 0) === 0 && c.pending === 0 && !hidden) break;
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(1200); // the arrival repaint (50 ms batch) + rebuilds + a frame
  return Date.now() - t0;
}

async function capture(page: Page, mode: Mode, name: string, surface: keyof typeof PANEL_ROOT): Promise<Capture> {
  const settleMs = await settle(page);
  await page.evaluate(PAGE_HELPERS);
  const file = join(OUT, mode, `${name}.png`);
  mkdirSync(join(OUT, mode), { recursive: true });
  await page.screenshot({ path: file, timeout: 150_000 });
  const root = PANEL_ROOT[surface];
  const box = (await page.evaluate(`(() => { const ui = window.__ac.gameUI; const el = ${root};
    if (!el) return null; const r = el.getBoundingClientRect(); if (r.width < 4 || r.height < 4) return null;
    return { x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)), w: Math.ceil(r.width), h: Math.ceil(r.height) }; })()`)) as Box | null;
  const icons = surface === 'world' ? null : (await page.evaluate(`(() => { const ui = window.__ac.gameUI; return window.__abHelpers.urlsUnder(${root}); })()`)) as Multiset | null;
  const model = (await page.evaluate('window.__abHelpers.modelSig(window.__ac.playerModel)')) as Multiset | null;
  const objects = surface === 'world' ? ((await page.evaluate('window.__abHelpers.objectSigs()')) as Record<string, string>) : {};
  const c = await streamCounters(page);
  const phys = (await page.evaluate(`(() => { const c = window.acDebug.collisionState(); return { hidden: (c.physicsState & 0x4000) !== 0, loginComplete: c.loginComplete !== false }; })()`)) as { hidden: boolean; loginComplete: boolean };
  console.log(`  [${mode}] ${name}: settle ${settleMs} ms, unresolved ${c.unresolved}, pending icons ${c.pending}`);
  const whiteParticles = (await page.evaluate('(globalThis.__acParticleStats && globalThis.__acParticleStats.whiteFallback) || 0')) as number;
  return { name, file, box, icons, model, objects, unresolvedMisses: c.unresolved, pendingIcons: c.pending, ...phys, settleMs, missesByType: c.missesByType, whiteParticles };
}

async function chat(page: Page, cmd: string): Promise<void> {
  await page.evaluate(`window.acDebug.sendChat(${JSON.stringify(cmd)})`);
}

async function teleport(page: Page, cmd: string): Promise<void> {
  const before = await page.evaluate('JSON.stringify(window.acDebug.collisionState())');
  await chat(page, cmd);
  const t0 = Date.now();
  // The tunnel runs, the gate holds (streaming), the arrival lands: wait for the tunnel to close at a new position.
  let tunnel = false;
  while (Date.now() - t0 < 120_000) {
    await page.waitForTimeout(500);
    const st = (await page.evaluate(`(() => ({ state: window.__ac.gameUI.portalSpaceState, pos: JSON.stringify(window.acDebug.collisionState()) }))()`).catch(() => null)) as { state: number; pos: string } | null;
    if (st && st.state !== 0) tunnel = true;
    if (st && st.state === 0 && (tunnel || st.pos !== before) && Date.now() - t0 > 3000) break;
    if (!tunnel && Date.now() - t0 > 20_000) { console.warn(`  teleport "${cmd}" never entered portal space`); break; }
  }
  await page.waitForTimeout(4000);
}

async function equipped(page: Page): Promise<string[]> {
  return ((await page.evaluate('window.acDebug.equipped()')) as Array<{ name: string }>).map((e) => e.name);
}

async function wield(page: Page, name: string, slot: string): Promise<void> {
  for (let attempt = 0; attempt < 2 && !(await equipped(page)).includes(name); attempt++) {
    // The double-click path first; the explicit slot (GetAndWieldItem) if the server refused it.
    await page.evaluate(attempt === 0 ? `window.acDebug.wieldByName(${JSON.stringify(name)})` : `window.acDebug.equip(${JSON.stringify(name)}, ${JSON.stringify(slot)})`);
    for (let i = 0; i < 40 && !(await equipped(page)).includes(name); i++) await page.waitForTimeout(250);
  }
  if (!(await equipped(page)).includes(name)) console.warn(`  could not wield ${name}: equipped = ${JSON.stringify(await equipped(page))}`);
}

async function unwield(page: Page, _slot: string, name: string): Promise<void> {
  const item = ((await page.evaluate('window.acDebug.equipped()')) as Array<{ name: string; slot: string }>).find((e) => e.name === name);
  if (!item) return;
  // The item's own wielded mask (armor covers several EquipMask bits).
  const mask = /^0x[0-9a-f]+$/i.test(item.slot) ? Number(item.slot) : item.slot;
  await page.evaluate(`window.acDebug.unwield(${JSON.stringify(mask)})`);
  for (let i = 0; i < 40 && (await equipped(page)).includes(name); i++) await page.waitForTimeout(250);
}

async function carried(page: Page): Promise<string[]> {
  return (await page.evaluate('window.__ac.gameUI.inventoryItems.map((i) => i.name)')) as string[];
}

/** @ci the armor the character does not have yet (one-time; it persists on the character). */
async function ensureArmor(page: Page): Promise<void> {
  for (const [name, wcid] of ARMOR) {
    if ((await carried(page)).includes(name) || (await equipped(page)).includes(name)) continue;
    await chat(page, `@ci ${wcid}`); // create-in-inventory (@create drops it on the ground)
    for (let i = 0; i < 40 && !(await carried(page)).includes(name); i++) await page.waitForTimeout(250);
    console.log(`  created ${name} (wcid ${wcid}): ${(await carried(page)).includes(name) ? 'ok' : 'NOT in inventory'}`);
  }
}

async function setPanel(page: Page, panel: 'inventory' | 'character' | 'magic', open: boolean): Promise<void> {
  const vis = { inventory: 'inventoryVisible', character: 'charPanelVisible', magic: 'magicVisible' }[panel];
  const toggle = { inventory: 'toggleInventory', character: 'toggleCharPanel', magic: 'toggleMagicPanel' }[panel];
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; if (!!ui.${vis} !== ${open}) ui.${toggle}(); })()`);
  await page.waitForTimeout(600);
}

async function runSession(mode: Mode): Promise<{ captures: Capture[]; loginMs: number; errors: string[]; log: string[] }> {
  // --prod: `networker=0` keeps the socket on the page. The net worker takes its CSP
  // (connect-src wss: only) from its own script response, which bypassCSP does
  // not reach, so it could not open the local ws:// bridge.
  const datArg = ERA
    ? `&era=${ERA}` + (mode === 'raw' ? '&rawDats' : `&eraDatSet=${encodeURIComponent(`${ERA}:${SET}`)}`)
    : mode === 'raw' ? '&rawDats' : PROD ? '&debug&networker=0' : `&datSet=${encodeURIComponent(SET)}`;
  const password = process.env.AC_PASSWORD ?? ACCOUNT;
  const url = PROD
    ? `${BASE}?cb=streaming-ab-${mode}${datArg}`
    : `${BASE}?ace&bridge=${encodeURIComponent(BRIDGE)}&account=${ACCOUNT}&password=${password}&cb=streaming-ab-${mode}${datArg}`;
  console.log(`[${mode}] ${url}`);
  const { browser, page, ms } = await enterWorld({ url, createCharacter: CHAR, settleMs: 4000, timeoutMs: 420_000, bypassCSP: !!PROD,
    ...(PROD ? { launcher: { bridge: BRIDGE, account: ACCOUNT, password } } : {}) });
  const errors: string[] = [];
  const log: string[] = [];
  const t0 = Date.now();
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
  page.on('console', (m) => {
    const t = m.text();
    if (/DatStream|LoginComplete|Teleport →|PlayerTeleport|Player model created|Own appearance|\[Wield\]|failed/i.test(t)) log.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${t.slice(0, 200)}`);
  });
  const captures: Capture[] = [];
  try {
    // Baseline: nothing from this script wielded, every panel closed.
    for (const p of ['inventory', 'character', 'magic'] as const) await setPanel(page, p, false);
    await unwield(page, 'Shield', 'Round Shield');
    await unwield(page, 'MeleeWeapon', 'Training Dirk');
    for (const [name, , slot] of ARMOR) await unwield(page, slot, name);
    // Removing the sollerets leaves the starter boots in the pack (wearing them displaced the boots): put the kit back on.
    for (const [name, slot] of STARTER_CLOTHES) if ((await carried(page)).includes(name)) await wield(page, name, slot);
    await ensureArmor(page);
    await teleport(page, HOLTBURG);
    captures.push(await capture(page, mode, '01-world-holtburg', 'world'));
    captures.push(await capture(page, mode, '02-toolbar', 'toolbar'));
    await setPanel(page, 'inventory', true);
    captures.push(await capture(page, mode, '03-inventory', 'inventory'));
    for (const [w, slot] of [...WIELD, ...ARMOR.map(([n, , sl]) => [n, sl] as [string, string])]) { await wield(page, w, slot); await page.waitForTimeout(1500); }
    console.log(`  [${mode}] equipped: ${JSON.stringify(await equipped(page))}`);
    captures.push(await capture(page, mode, '04-inventory-wielded', 'inventory'));
    await setPanel(page, 'inventory', false);
    captures.push(await capture(page, mode, '05-world-wielded', 'world'));
    await setPanel(page, 'inventory', true);
    await unwield(page, 'Shield', 'Round Shield');
    captures.push(await capture(page, mode, '06-inventory-unwielded-shield', 'inventory'));
    await setPanel(page, 'inventory', false);
    await setPanel(page, 'character', true);
    captures.push(await capture(page, mode, '07-character', 'character'));
    // The Skills page: its rows' pictograms (missing on a cold stream, 2026-10-06).
    await page.evaluate("window.__ac.gameUI.toggleCharPage('skills')");
    captures.push(await capture(page, mode, '07b-skills', 'character'));
    await page.evaluate("window.__ac.gameUI.toggleCharPage('attributes')");
    await setPanel(page, 'character', false);
    await setPanel(page, 'magic', true);
    captures.push(await capture(page, mode, '08-magic', 'magic'));
    await setPanel(page, 'magic', false);
    await teleport(page, SHOUSHI);
    captures.push(await capture(page, mode, '09-world-after-teleport', 'world'));
    await setPanel(page, 'inventory', true);
    captures.push(await capture(page, mode, '10-inventory-after-teleport', 'inventory'));
    await setPanel(page, 'inventory', false);
    await unwield(page, 'MeleeWeapon', 'Training Dirk');
    for (const [name, , slot] of ARMOR) await unwield(page, slot, name);
    // The run ends at Shoushi, so the next run's first teleport (Holtburg) is a real one.
  } finally {
    await browser.close().catch(() => {});
  }
  return { captures, loginMs: ms, errors, log };
}

// ── comparison ───────────────────────────────────────────────────────────
function multisetDiff(a: Multiset | null, b: Multiset | null): { onlyRaw: number; onlyStream: number } {
  if (!a || !b) return { onlyRaw: a ? Object.values(a).reduce((s, n) => s + n, 0) : 0, onlyStream: b ? Object.values(b).reduce((s, n) => s + n, 0) : 0 };
  let onlyRaw = 0, onlyStream = 0;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = (a[k] ?? 0) - (b[k] ?? 0);
    if (d > 0) onlyRaw += d; else onlyStream -= d;
  }
  return { onlyRaw, onlyStream };
}

function cropPng(file: string, box: Box): PNG {
  const src = PNG.sync.read(readFileSync(file));
  const w = Math.min(box.w, src.width - box.x), h = Math.min(box.h, src.height - box.y);
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(src, out, box.x, box.y, w, h, 0, 0);
  return out;
}

function pixelDiff(rawFile: string, streamFile: string, box: Box | null, diffFile: string): number {
  const fullBox = box ?? (() => { const p = PNG.sync.read(readFileSync(rawFile)); return { x: 0, y: 0, w: p.width, h: p.height }; })();
  const a = cropPng(rawFile, fullBox), b = cropPng(streamFile, fullBox);
  const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
  const diff = new PNG({ width: w, height: h });
  const n = pixelmatch(a.data, b.data, diff.data, w, h, { threshold: 0.1 });
  writeFileSync(diffFile, PNG.sync.write(diff));
  return n / (w * h);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const runs: Partial<Record<Mode, Awaited<ReturnType<typeof runSession>>>> = {};
  for (const mode of ['raw', 'stream'] as Mode[]) {
    if (ONLY && ONLY !== mode) continue;
    runs[mode] = await runSession(mode);
    writeFileSync(join(OUT, `${mode}.json`), JSON.stringify(runs[mode], null, 2) + '\n');
    await new Promise((r) => setTimeout(r, 10_000)); // ACE's logout save before the next login
  }
  if (RAW_FROM && !runs.raw) runs.raw = JSON.parse(readFileSync(join(RAW_FROM, 'raw.json'), 'utf8'));
  const raw = runs.raw, stream = runs.stream;
  if (!raw || !stream) { console.log(`one mode only: wrote ${OUT}`); return; }

  const browser: Browser = await launchBrowser();
  const results: Array<Record<string, unknown>> = [];
  const failures: string[] = [];
  for (const s of stream.captures) {
    const r = raw.captures.find((c) => c.name === s.name);
    if (!r) { failures.push(`${s.name}: no raw capture`); continue; }
    const box = r.box ?? s.box;
    const diffFile = join(OUT, 'diff', `${s.name}.png`);
    mkdirSync(join(OUT, 'diff'), { recursive: true });
    const pixelFraction = pixelDiff(r.file, s.file, box, diffFile);
    const icons = multisetDiff(r.icons, s.icons);
    const model = multisetDiff(r.model, s.model);
    // Other players (guids 0x50000000–0x5FFFFFFF) are live and unscripted: another session's
    // character casting between the two runs is not a streaming difference (2026-10-08). Our own
    // player is checked by playerModelMatches.
    const isPlayer = (g: string) => (parseInt(g, 16) >>> 28) === 5;
    const shared = Object.keys(r.objects).filter((g) => g in s.objects && !isPlayer(g));
    const objectMismatches = shared.filter((g) => r.objects[g] !== s.objects[g]);
    const checks = {
      unresolvedMissesZero: s.unresolvedMisses === 0,
      noPendingIcons: s.pendingIcons === 0,
      iconsMatch: icons.onlyRaw === 0 && icons.onlyStream === 0,
      playerModelMatches: model.onlyRaw === 0 && model.onlyStream === 0,
      sharedObjectsMatch: objectMismatches.length === 0,
      teleportFinished: !s.hidden && s.loginComplete && !r.hidden && r.loginComplete,
      // Login / logout bubbles, buffs: no more white-square emitters than whole DATs drew (2026-10-06).
      noWhiteParticles: (s.whiteParticles ?? 0) <= (r.whiteParticles ?? 0),
    };
    // Against a raw run from another session (--raw-from), NPCs whose landblock
    // reloaded in between re-roll their create-list clothing colors on the
    // server (Shoushi's townsfolk, 2026-10-06), so shared objects are reported, not gated.
    for (const [k, ok] of Object.entries(checks)) {
      if (ok) continue;
      if (RAW_FROM && k === 'sharedObjectsMatch') console.log(`  warn ${s.name}: ${objectMismatches.length} shared objects differ (server-side re-randomization across sessions)`);
      else failures.push(`${s.name}: ${k}`);
    }
    results.push({
      capture: s.name, checks, pixelDiffFraction: Number(pixelFraction.toFixed(4)), box,
      icons, playerModel: model, sharedObjects: shared.length, objectMismatches: objectMismatches.slice(0, 20),
      stream: { unresolvedMisses: s.unresolvedMisses, pendingIcons: s.pendingIcons, settleMs: s.settleMs },
    });
    const zoom = box && box.w < 500 ? 2 : 1;
    const crop = box ?? null;
    const label = (m: string) => `${m} — ${s.name}`;
    const cells = crop
      ? [cropCellHtml(r.file, label('whole DATs'), crop, zoom), cropCellHtml(s.file, label('streaming'), crop, zoom), cropCellHtml(diffFile, label(`pixel diff ${(pixelFraction * 100).toFixed(2)}%`), { x: 0, y: 0, w: crop.w, h: crop.h }, zoom)]
      : [cropCellHtml(r.file, label('whole DATs'), null, 0.6), cropCellHtml(s.file, label('streaming'), null, 0.6), cropCellHtml(diffFile, label(`pixel diff ${(pixelFraction * 100).toFixed(2)}%`), null, 0.6)];
    const verdictLine = Object.entries(checks).map(([k, ok]) => `${ok ? 'ok' : 'FAIL'} ${k}`).join(' · ');
    const sheet = await renderSheet(sheetHtml(`streaming A/B — ${s.name}`, [cells], verdictLine), join(OUT, `sheet-${s.name}.png`), browser, { width: crop ? Math.max(1200, crop.w * zoom * 3 + 80) : 2900, height: 800 });
    rmSync(sheet.replace(/\.png$/, '.html'), { force: true }); // the HTML inlines every frame as base64 (megabytes each)
  }
  await browser.close();
  const verdict = {
    verdict: failures.length === 0 ? 'PASS' : 'FAIL',
    date: new Date().toISOString(), set: SET, account: ACCOUNT, out: OUT,
    loginMs: { raw: raw.loginMs, stream: stream.loginMs },
    pageErrors: { raw: raw.errors, stream: stream.errors },
    streamMissesByType: stream.captures.at(-1)?.missesByType ?? null,
    failures, captures: results,
    note: 'Hard checks gate the verdict; pixelDiffFraction is informational (live NPCs, animation phase and weather differ between the two sessions).',
  };
  writeFileSync(join(OUT, 'verdict.json'), JSON.stringify(verdict, null, 2) + '\n');
  console.log(`\nverdict: ${verdict.verdict}${failures.length ? `\n  ${failures.join('\n  ')}` : ''}\nwrote ${OUT}/verdict.json`);
  // Exit 0 PASS, 1 FAIL, 2 the run itself broke (the gpu-worker's streaming-ab verdict).
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(2); });
