#!/usr/bin/env node
/**
 * boot-click-stress — click the page every 50 ms from the moment it opens until
 * the launcher is up, in a throwaway headless profile, and report page errors.
 *
 * Catches handlers that fire during boot before the bindings they read exist
 * (2026-10-14: a document click listener read `gameUI` before main() declared it
 * and threw "Cannot access 'gameUI' before initialization" for a real player;
 * one click a second never landed in that window, this does — BUG.boot-click-tdz).
 *
 *   node tools/boot-click-stress.mjs [url] [seconds]
 *   node tools/boot-click-stress.mjs "http://localhost:5173/?bridge=ws://localhost:9090&nocache"
 *   node tools/boot-click-stress.mjs https://playwebac.com/
 *
 * Exit code 1 when any page error was thrown. One headless browser; the profile
 * is a temp dir deleted at exit.
 */
import { chromium } from 'playwright';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] ?? 'https://playwebac.com/';
const seconds = Number(process.argv[3] ?? 25);
const dir = mkdtempSync(join(tmpdir(), 'boot-click-stress-'));
const ctx = await chromium.launchPersistentContext(dir, { headless: true, viewport: { width: 1280, height: 800 } });
let errors = 0;
try {
  const page = ctx.pages()[0] ?? await ctx.newPage();
  page.on('pageerror', (e) => { errors++; console.log(`page error: ${String(e).slice(0, 200)}`); });
  const nav = page.goto(url);
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    try { await page.mouse.click(1000, 600); } catch { /* page mid-navigation */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  await nav.catch(() => {});
  const launcher = !!(await page.$('input.launcher-password'));
  console.log(`launcher=${launcher} pageErrors=${errors}`);
} finally {
  await ctx.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(errors > 0 ? 1 : 0);
