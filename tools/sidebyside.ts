/**
 * sidebyside — the ONE retail-vs-ours side-by-side tool (DEBT.tools-sprawl).
 * Replaces the per-task `capture-*-sidebyside.ts` scripts: the scene lives
 * as a row in SIDE_BY_SIDE_SCENES (tools/capture-scenes.ts), the driving in
 * tools/lib/game-session.ts.
 *
 *   npx tsx tools/sidebyside.ts --list
 *   npx tsx tools/sidebyside.ts --scene inventory [--scene chat,radar]
 *   npx tsx tools/sidebyside.ts --scene chat --tag before     (then fix, then --tag after)
 *   npx tsx tools/sidebyside.ts --scene toolbar --ref reference/images/hud/rawg_10.jpg --crop 700,660,324,108
 *   npx tsx tools/sidebyside.ts --scene chat --compose-only    (re-compose from the captures on disk)
 *   npx tsx tools/sidebyside.ts --scene chat --compose-only --ours verification/screens/scenes/hud-idle-over-world.png
 *
 * Per scene, into verification/sidebyside/<scene>/ (or --out <dir>):
 *   ours-<tag>.png + ours-<tag>.json   the live frame and the crop box used
 *   <scene>-sidebyside.html / .png     row 1: every retail crop, then every
 *                                      ours-*.png crop (before first);
 *                                      row 2: the whole frames (the
 *                                      WHOLE-SCREEN rule — a panel is judged
 *                                      against the scene it sits in too)
 *
 * Flags:
 *   --scene <a[,b]>      rows of SIDE_BY_SIDE_SCENES (repeatable)
 *   --tag <name>         capture as ours-<name>.png (default "ours")
 *   --ref <img>          replace the row's refs with this image (repeatable)
 *   --crop x,y,w,h       crop for the preceding --ref
 *   --ref-label <text>   label for the preceding --ref
 *   --ours <png>         compose an existing capture as another ours cell (repeatable)
 *   --ours-crop x,y,w,h  our crop box, overriding the row's
 *   --zoom <n>           crop magnification, overriding the row's
 *   --compose-only       no live capture
 *   --out <dir>          output dir (single scene)
 *   --gpu / --attach [endpoint]   real-GPU capture (tools/lib/game-session.ts)
 * Env: AC_URL / AC_ACCOUNT / AC_PASSWORD … (game-session.ts header).
 * Requires for live capture: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright';
import { CAMERA_RESET_JS } from './lib/camera-pins.js';
import {
  SIDE_BY_SIDE_SCENES, letterboxBox, sideBySidePins, type CropBox, type SideBySideRef, type SideBySideScene,
} from './capture-scenes.js';
import {
  REPO, DEFAULT_VIEWPORT, applyWorldPins, clickSel, cropCellHtml, dataUrl, elementBox, evalSafe, frameCellHtml, gameUrl,
  launchBrowser, openSession, parseCrop, renderSheet, sessionArgs, sheetHtml, shot, waitFor, waitForCharSelect, waitForWorld,
  IN_CHARGEN_JS, type Box,
} from './lib/game-session.js';

export interface SideBySideArgs {
  scenes: string[];
  tag: string;
  refs: SideBySideRef[] | null;
  ours: string[];
  oursCrop: CropBox | null;
  zoom: number | null;
  composeOnly: boolean;
  out: string | null;
  list: boolean;
}

/** Parse the CLI (pure — tests drive it). */
export function parseSideBySideArgs(argv: string[]): SideBySideArgs {
  const a: SideBySideArgs = { scenes: [], tag: 'ours', refs: null, ours: [], oursCrop: null, zoom: null, composeOnly: false, out: null, list: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = (): string => {
      const n = argv[++i];
      if (n === undefined) throw new Error(`${k} needs a value`);
      return n;
    };
    switch (k) {
      case '--scene': a.scenes.push(...v().split(',').filter(Boolean)); break;
      case '--tag': a.tag = v(); break;
      case '--ref': (a.refs ??= []).push({ file: v(), label: '' }); break;
      case '--crop': {
        if (!a.refs?.length) throw new Error('--crop must follow a --ref (use --ours-crop for our crop)');
        a.refs[a.refs.length - 1].crop = parseCrop(v());
        break;
      }
      case '--ref-label': {
        if (!a.refs?.length) throw new Error('--ref-label must follow a --ref');
        a.refs[a.refs.length - 1].label = v();
        break;
      }
      case '--ours': a.ours.push(v()); break;
      case '--ours-crop': a.oursCrop = parseCrop(v()); break;
      case '--zoom': a.zoom = Number(v()); break;
      case '--compose-only': a.composeOnly = true; break;
      case '--out': a.out = v(); break;
      case '--list': a.list = true; break;
      case '--gpu': break;
      case '--attach': if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++; break;
      default: throw new Error(`unknown argument ${k}`);
    }
  }
  for (const r of a.refs ?? []) if (!r.label) r.label = `${basename(r.file)}${r.crop ? ` (${r.crop.x},${r.crop.y} ${r.crop.w}x${r.crop.h})` : ''}`;
  return a;
}

export function findScene(name: string): SideBySideScene {
  const s = SIDE_BY_SIDE_SCENES.find((r) => r.name === name);
  if (!s) throw new Error(`no side-by-side scene "${name}" — --list shows them`);
  return s;
}

export const sceneDir = (scene: string, out: string | null = null): string => (out ? resolve(out) : join(REPO, 'verification', 'sidebyside', scene));

interface OursCell { file: string; label: string; box: CropBox | null }

/** Every ours-*.png in the scene dir (ours-before first, then alphabetical) with its recorded crop box. */
export function oursCells(dir: string, extra: string[] = [], cropOverride: CropBox | null = null): OursCell[] {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^ours(-.+)?\.png$/.test(f)) : [];
  const rank = (f: string): string => (f === 'ours-before.png' ? '0' : f === 'ours-after.png' ? '2' : `1${f}`);
  files.sort((x, y) => rank(x).localeCompare(rank(y)));
  const cells: OursCell[] = files.map((f) => {
    const meta = join(dir, f.replace(/\.png$/, '.json'));
    const box = existsSync(meta) ? (JSON.parse(readFileSync(meta, 'utf8')) as { box: CropBox | null }).box : null;
    const tag = f === 'ours.png' ? '' : ` — ${f.slice(5, -4)}`;
    return { file: join(dir, f), label: `ours${tag}`, box };
  });
  for (const e of extra) cells.push({ file: resolve(e), label: `ours — ${basename(e)}`, box: null });
  return cells.map((c) => ({ ...c, box: cropOverride ?? c.box }));
}

/** The side-by-side sheet (pure — tests drive it). `src` maps a file to its <img> source. */
export function composeHtml(
  row: SideBySideScene, refs: SideBySideRef[], ours: OursCell[], zoomOverride: number | null,
  src: (file: string) => string = dataUrl,
): string {
  const zoom = zoomOverride ?? row.zoom ?? 2;
  const oursH = ours.find((o) => o.box)?.box?.h ?? DEFAULT_VIEWPORT.height;
  const z = (h: number | undefined): number => (row.matchHeight && h ? (oursH * zoom) / h : zoom);
  const refFile = (r: SideBySideRef): string => resolve(REPO, r.file);
  const crops = [
    ...refs.map((r) => cropCellHtml(refFile(r), r.label, r.crop ?? null, z(r.crop?.h ?? imageHeight(refFile(r))), src(refFile(r)))),
    ...ours.map((o) => cropCellHtml(o.file, `${o.label}${o.box ? ` (${o.box.x},${o.box.y} ${o.box.w}x${o.box.h})` : ''}`, o.box, z(o.box?.h ?? oursH), src(o.file))),
  ];
  const frames = [
    ...refs.filter((r) => r.crop).map((r) => frameCellHtml(refFile(r), `${r.label} — whole frame`, 780, src(refFile(r)))),
    ...ours.filter((o) => o.box).map((o) => frameCellHtml(o.file, `${o.label} — whole frame`, 780, src(o.file))),
  ];
  const note = [row.notes, refs.length ? '' : 'no retail reference in this row'].filter(Boolean).join(' · ');
  return sheetHtml(row.title, frames.length ? [crops, frames] : [crops], note || undefined);
}

/** PNG / JPEG height from the header (webp → undefined; matchHeight then falls back to the zoom). */
export function imageHeight(file: string): number | undefined {
  if (!existsSync(file)) return undefined;
  const b = readFileSync(file);
  if (b[0] === 0x89 && b[1] === 0x50) return b.readUInt32BE(20);
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return b.readUInt16BE(i + 5);
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const fmt = b.toString('ascii', 12, 16);
    if (fmt === 'VP8 ') return b.readUInt16LE(28) & 0x3fff;
    if (fmt === 'VP8L') return (((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)) & 0x3fff) + 1;
    if (fmt === 'VP8X') return (b[27] | (b[28] << 8) | (b[29] << 16)) + 1;
  }
  return undefined;
}

// ── live capture ─────────────────────────────────────────────────────────

async function oursBox(page: Page, row: SideBySideScene, override: CropBox | null): Promise<Box | null> {
  if (override) return override;
  if (row.ours.letterbox) return letterboxBox(page.viewportSize() ?? DEFAULT_VIEWPORT);
  if (row.ours.element) {
    const b = await elementBox(page, row.ours.element, row.ours.pad ?? 0);
    if (b) return b;
    if (row.ours.box) console.log(`[sidebyside] ${row.name}: ${row.ours.element} not on screen — using the table's box`);
    else console.log(`[sidebyside] ${row.name}: ${row.ours.element} not on screen — whole frame`);
  }
  return row.ours.box ?? null;
}

async function record(page: Page, row: SideBySideScene, dir: string, tag: string, override: CropBox | null): Promise<void> {
  const file = join(dir, tag === 'ours' ? 'ours.png' : `ours-${tag}.png`);
  await shot(page, file);
  const box = await oursBox(page, row, override);
  writeFileSync(file.replace(/\.png$/, '.json'), JSON.stringify({ capturedAt: new Date().toISOString(), scene: row.name, tag, box, url: page.url(), viewport: page.viewportSize() }, null, 2));
  console.log(`[sidebyside] ${row.name}: ${file}${box ? ` crop ${box.x},${box.y} ${box.w}x${box.h}` : ''}`);
}

/** Move the chargen wizard to `target` pages past the one it opened on. */
async function chargenTo(page: Page, base: number, target: number): Promise<void> {
  const step = (): Promise<number> => page.evaluate("parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10)") as Promise<number>;
  for (let guard = 0; guard < 12; guard++) {
    const cur = await step();
    if (cur === base + target) return;
    const btn = cur < base + target ? '#btn-next' : '#btn-back';
    if (!(await clickSel(page, btn))) throw new Error(`${btn} not found on chargen step ${cur}`);
    await page.waitForFunction((prev) => parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10) !== prev, cur, { timeout: 15_000 });
    await page.waitForTimeout(1500);
  }
  throw new Error(`chargen never reached page ${target}`);
}

async function captureLive(rows: SideBySideScene[], args: SideBySideArgs): Promise<void> {
  const pre = rows.filter((r) => r.stage !== 'world').sort((x, y) => (x.stage === 'charselect' ? -1 : 0) - (y.stage === 'charselect' ? -1 : 0) || (x.chargenPage ?? 0) - (y.chargenPage ?? 0));
  const world = rows.filter((r) => r.stage === 'world');
  const { browser, page } = await openSession({ ...sessionArgs(), consoleFilter: /\[AC\] (ACE|CharacterError)|pageerror/ });
  const log = (s: string): void => console.log(`[sidebyside] ${s}`);
  try {
    if (pre.length) {
      const url = gameUrl({ autoenter: false, cb: 'sidebyside' });
      log(`navigating ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      if (!(await waitForCharSelect(page, { log }))) throw new Error('character select never appeared');
      // GameUI.connectingMode holds a "Please Wait" dialog until the list lands.
      await waitFor(page, '!(window.__ac && window.__ac.gameUI && window.__ac.gameUI.connectingMode === true)', { timeoutMs: 20_000, pollMs: 500, reloadEveryMs: 0 });
      await page.waitForTimeout(1500);
      let base = -1;
      for (const row of pre) {
        if (row.stage === 'charselect') { await record(page, row, sceneDir(row.name, args.out), args.tag, args.oursCrop); continue; }
        if (base < 0) {
          // A fresh chargen opens on RandomizeCharacter (gmCharGenMainUI ctor); seed it so reruns match.
          await page.evaluate('window.__ac?.gameUI?.pinChargenRandom?.(1)');
          // The summary's name field opens focused: hold its caret lit (no blink phase).
          await page.evaluate('window.__ac?.gameUI?.pinCaretBlink?.(true)');
          if (!(await clickSel(page, '#btn-create-character'))) throw new Error('#btn-create-character not found');
          if (!(await waitFor(page, IN_CHARGEN_JS, { timeoutMs: 15_000, pollMs: 500, reloadEveryMs: 0 }))) throw new Error('chargen never opened');
          await page.waitForTimeout(2000);
          base = await page.evaluate("parseInt(document.getElementById('chargen-root')?.dataset.step ?? '-1', 10)") as number;
        }
        await chargenTo(page, base, row.chargenPage ?? 0);
        if (row.pins?.evalJs) { await evalSafe(page, row.pins.evalJs, 'evalJs'); await page.waitForTimeout(row.pins.settleMs ?? 800); }
        await record(page, row, sceneDir(row.name, args.out), args.tag, args.oursCrop);
      }
    }
    if (world.length) {
      const url = gameUrl({ cb: 'sidebyside' });
      log(`navigating ${url}`);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      if (!(await waitForWorld(page, { log }))) throw new Error('never entered world');
      await page.waitForTimeout(8000);
      for (const row of world) {
        const pins = sideBySidePins(row);
        await applyWorldPins(page, pins, log);
        for (const k of pins.holdKeys ?? []) await page.keyboard.down(k);
        if (pins.holdKeys?.length) await page.waitForTimeout(pins.settleMs ?? 1400);
        await record(page, row, sceneDir(row.name, args.out), args.tag, args.oursCrop);
        for (const k of pins.holdKeys ?? []) await page.keyboard.up(k);
        if (pins.cleanupJs) { await evalSafe(page, pins.cleanupJs, 'cleanupJs'); await page.waitForTimeout(500); }
        for (const id of (pins.toggles ?? []).slice().reverse()) { await clickSel(page, `#${id}`); await page.waitForTimeout(500); }
        if (pins.cameraDistance !== undefined) await page.evaluate(CAMERA_RESET_JS);
      }
      await page.evaluate('window.acDebug && window.acDebug.freezeTimeOfDay && window.acDebug.freezeTimeOfDay(null)');
    }
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const args = parseSideBySideArgs(process.argv.slice(2));
  if (args.list || !args.scenes.length) {
    for (const s of SIDE_BY_SIDE_SCENES) console.log(`${s.name.padEnd(20)} ${s.stage.padEnd(10)} ${s.title}`);
    if (!args.list) console.log('\n--scene <name> required');
    return;
  }
  if (args.out && args.scenes.length > 1) throw new Error('--out takes a single --scene');
  const rows = args.scenes.map(findScene);
  if (!args.composeOnly) await captureLive(rows, args);
  const browser = await launchBrowser();
  try {
    for (const row of rows) {
      const dir = sceneDir(row.name, args.out);
      mkdirSync(dir, { recursive: true });
      const refs = args.refs ?? row.refs;
      for (const r of refs) if (!existsSync(resolve(REPO, r.file))) throw new Error(`missing reference ${r.file}`);
      const ours = oursCells(dir, args.ours, args.oursCrop);
      if (!ours.length) throw new Error(`${row.name}: no ours*.png in ${dir} — run without --compose-only, or pass --ours <png>`);
      const png = await renderSheet(composeHtml(row, refs, ours, args.zoom), join(dir, `${row.name}-sidebyside.png`), browser);
      console.log(`[sidebyside] wrote ${png} (+ .html)`);
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
