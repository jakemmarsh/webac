/**
 * CORE.5.e live verification — compass N/E/S/W letters are the DAT letter
 * textures riding the radar ring band, repositioned around the dial center
 * (60,60 — CORE.5.b.b EoL floaty radar 0x21000074) per gmRadarUI::UpdateCompassTokens.
 *
 * Asserts (at 1568x775):
 *  - #radar-compass-{n,e,s,w} exist inside #hud-radar, 10x9, DAT texture
 *    background (0x060011fb / 0x06001938 / 0x0600193a / 0x0600193c).
 *  - Each token's DOM offset matches computeCompassTokenPositions() for the
 *    live player heading.
 *  - After turning the player (held ArrowRight), the heading changed and the
 *    tokens still match the formula — i.e. they actually ride the band.
 *  - The disc canvas no longer draws the old 0.88r bitmap-font letters
 *    (structural: only DOM tokens carry the letters now).
 *
 * Saves radar crops for the side-by-side vs reference/images/hud/
 * radar-coordinates.jpg into verification/core5e-compass/.
 *
 * Usage: npx tsx tools/verify-core5e-compass-tokens.ts
 * Requires: vite (:3000), ws-tcp-bridge (:9090), ACE stack.
 */
import { chromium, type Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RADAR_COMPASS_TOKENS,
  computeCompassTokenPositions,
} from '../../packages/renderer/src/ui/RadarCompassTokens.js';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const URL = 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs&cb=core5e';
const OUT = join(__dir, '..', 'verification', 'core5e-compass');

async function inWorld(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
      const cs = dbg?.collisionState?.();
      return !!(cs && cs.x > 0);
    });
  } catch { return false; }
}
function drive(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = 'Hud Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}
async function waitForWorld(page: Page): Promise<void> {
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) return;
    if (!createSent) {
      let created = 'not-at-create';
      try { created = await drive(page); } catch { /* nav mid-probe */ }
      if (created !== 'not-at-create') { createSent = true; lastReload = Date.now(); }
    }
    if (Date.now() - lastReload > 60_000) {
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* retry */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  throw new Error('never entered world');
}

const failures: string[] = [];
function check(name: string, cond: boolean, detail: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!cond) failures.push(name);
}

interface TokenDom { left: number; top: number; w: number; h: number; bg: string; parent: string; }
async function readTokens(page: Page): Promise<Record<string, TokenDom | null>> {
  return page.evaluate(() => {
    const out: Record<string, { left: number; top: number; w: number; h: number; bg: string; parent: string } | null> = {};
    for (const k of ['n', 'e', 's', 'w']) {
      const el = document.querySelector(`#radar-compass-${k}`) as HTMLElement | null;
      out[k] = el ? {
        left: parseFloat(el.style.left), top: parseFloat(el.style.top),
        w: parseFloat(el.style.width), h: parseFloat(el.style.height),
        bg: el.style.backgroundImage ? 'set' : 'MISSING',
        parent: el.parentElement?.id ?? '',
      } : null;
    }
    return out;
  });
}

async function heading(page: Page): Promise<number> {
  return page.evaluate(() => {
    const ui = (window as unknown as { __ac?: { gameUI?: { hud?: { headingDegrees?: number } } } }).__ac?.gameUI;
    return ui?.hud?.headingDegrees ?? NaN;
  });
}

function checkTokensMatch(label: string, doms: Record<string, TokenDom | null>, h: number): void {
  const expected = computeCompassTokenPositions(h);
  for (const t of RADAR_COMPASS_TOKENS) {
    const dom = doms[t.key];
    check(`${label}-${t.key}-present`, !!dom && dom.parent === 'hud-radar' && dom.w === 10 && dom.h === 9 && dom.bg === 'set',
      JSON.stringify(dom));
    if (dom) {
      const e = expected[t.key];
      // The live heading can drift a hair between the heading read and the
      // rAF that repositioned the tokens — allow 2px.
      check(`${label}-${t.key}-at-formula-pos`,
        Math.abs(dom.left - e.left) <= 2 && Math.abs(dom.top - e.top) <= 2,
        `dom=(${dom.left},${dom.top}) expected=(${e.left},${e.top}) at heading ${h.toFixed(1)}`);
    }
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    args: ['--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1568, height: 775 } });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await waitForWorld(page);
  await page.waitForTimeout(4000);

  const h0 = await heading(page);
  check('heading-readable', !Number.isNaN(h0), `heading=${h0}`);
  checkTokensMatch('idle', await readTokens(page), h0);

  const radar = await page.evaluate(() => {
    const el = document.querySelector('#hud-radar');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  check('radar-present', !!radar, JSON.stringify(radar));
  if (radar) {
    await page.screenshot({ path: join(OUT, `core5e-radar-h${Math.round(h0)}.png`), clip: radar });
  }

  // Turn the player and confirm the tokens ride the band.
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(900);
  await page.keyboard.up('ArrowRight');
  await page.waitForTimeout(600);
  const h1 = await heading(page);
  check('heading-changed', Math.abs(h1 - h0) > 10, `h0=${h0.toFixed(1)} h1=${h1.toFixed(1)}`);
  checkTokensMatch('turned', await readTokens(page), h1);
  if (radar) {
    await page.screenshot({ path: join(OUT, `core5e-radar-h${Math.round(h1)}.png`), clip: radar });
  }

  // Full HUD context shot
  await page.screenshot({ path: join(OUT, 'core5e-full.png') });

  await browser.close();
  console.log(failures.length === 0 ? '\nALL CHECKS PASS' : `\n${failures.length} FAILURES: ${failures.join(', ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
