/**
 * ERA.dm-support production smoke (docs/dark-majesty-support.md): on a
 * deployed client, a classic world (default Seedsow) is listed with its era,
 * and that era's hosted DATs load. Nothing reaches the third-party server and
 * no account is created: the probe boots the era with `?era=<id>` (the same
 * boot ENTER triggers) and stops at the launcher instead of pressing ENTER.
 *
 *   npx tsx tools/probe-era-prod-smoke.ts [--base https://playwebac.com/] [--world Seedsow --world-id <Servers.xml id>]
 *       [--era classic-dereth] [--out <dir>]
 * Exits 1 on a failed check.
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { createRunProfile } from './lib/temp-profile.js';
import { SWIFTSHADER_ARGS, waitFor } from './lib/game-session.js';

const args = process.argv.slice(2);
const opt = (n: string, d: string): string => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const out = opt('out', '/tmp/era-prod-smoke');
const base = opt('base', 'https://playwebac.com/');
const worldName = opt('world', 'Seedsow');
const era = opt('era', 'classic-dereth');
// Row names are bitmap-font canvases; rows carry the Servers.xml id in data-world.
const worldId = opt('world-id', '394c58d0-885d-466b-b17f-d7e0b96fe3e2').toLowerCase();
const rowJs = `[...document.querySelectorAll('.launcher-world-row')].find(r => (r.dataset.world || '').toLowerCase() === ${JSON.stringify(worldId)})`;
mkdirSync(out, { recursive: true });
let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${what}`); if (!ok) failed = true; };

// Deleted at exit, on a signal or a thrown error (tools/lib/temp-profile.ts): it holds a ~1 GB DAT cache.
const profile = createRunProfile('acjs-prod-smoke-', { tool: 'probe-era-prod-smoke' });
const ctx = await chromium.launchPersistentContext(profile.dir, { args: SWIFTSHADER_ARGS, viewport: { width: 1280, height: 720 } });
profile.setCloser(() => ctx.close());
const page = ctx.pages()[0] ?? await ctx.newPage();
page.setDefaultTimeout(60_000);
const lines: string[] = [];
page.on('console', (m) => { if (/AC:Era|launcher|ERROR|error/i.test(m.text())) lines.push(m.text().slice(0, 200)); });
// Production hides the debug globals: read the era from the boot log and the DAT requests.
const classicRequests: string[] = [];
page.on('request', (r) => { if (/\/v1\/raw\/classic/.test(r.url())) classicRequests.push(r.url()); });

// 1. The world is listed with its era (an end-of-retail boot, as every page load is now).
await page.goto(base, { waitUntil: 'commit' });
check(await waitFor(page, `!!(${rowJs})`, { timeoutMs: 240_000, reloadEveryMs: 0 }), `${worldName} listed`);
await page.evaluate(`(${rowJs}).click()`);
await page.waitForTimeout(800);
console.log('details:', (await page.locator('.launcher-details').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200));
check(lines.some((l) => /booting End of Retail/.test(l)), 'a plain page load boots end of retail');

// 2. The era's hosted DATs load (the boot ENTER would reload into), with no data-files prompt.
lines.length = 0;
const url = new URL(base);
url.searchParams.set('era', era);
await page.goto(url.toString(), { waitUntil: 'commit' });
const booted = await waitFor(page, `!!document.querySelector('.launcher-world-row')`, { timeoutMs: Number(process.env.ERA_WAIT_MS ?? 600_000), reloadEveryMs: 0 });
const bootLine = lines.find((l) => /\[AC:Era\] booting/.test(l)) ?? '';
console.log('boot:', bootLine);
console.log('classic DAT requests:', [...new Set(classicRequests.map((u) => u.replace(/\?.*$/, '')))].join(', '));
check(booted && /booting (?!End of Retail)/.test(bootLine), `?era=${era} booted that era and reached the launcher`);
check(classicRequests.some((u) => u.includes('/v1/raw/')), 'its own files came from the hosted sets');
check(await page.locator('[data-element-id="0x15"]').count() === 0, 'no data-files prompt');
await page.screenshot({ path: `${out}/prod-era-boot.png` });
console.log(lines.join('\n'));
await profile.dispose(); // closes the browser and removes the profile
process.exit(failed ? 1 : 0);
