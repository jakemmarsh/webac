/**
 * CORE.17.k.b.b.a.f.e — live check: does anything draw a SECOND copy of the
 * attribute row template's lock 0x100002ec / slider 0x100002ee (a static
 * default-state instance from the LayoutRenderer) under the live controls
 * on the chargen profession page?
 *
 * Char select → Create Character → Profession page; every row unlocked
 * (the default). Reports, per row: every DOM node carrying the lock / slider
 * element id (or a LayoutRenderer desc path ending in it), the stack
 * `elementsFromPoint` returns at the lock's and the slider's centre, and a
 * pixel test: the row screenshot with the live lock + slider hidden (what
 * would show through if a static copy sat beneath) against the same row
 * with them hidden AND the page's LayoutRenderer layer hidden.
 *
 *   npx tsx tools/probe-core17kbbafe-profession-row-duplicates.ts [before|after]
 *
 * Also counts the VISIBLE static copies and shoots the Strength lock zoomed,
 * unlocked and locked (a static unlocked copy shows through the locked art).
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const LABEL = process.argv[2] ?? 'after';
const OUT = join(resolve(__dir, '..'), 'verification', 'core17kbbafe', LABEL);
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const BASE = process.env.AC_URL ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'], ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}) });
  const page = await browser.newPage({ viewport: VIEW });
  page.on('dialog', (d) => void d.dismiss());
  await page.goto(`${BASE}&autoenter=false&cb=kbbafe`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const t0 = Date.now();
  while (Date.now() - t0 < 360_000) {
    if (await page.evaluate(`document.getElementById('charsel-inner')?.dataset.mode === 'select'`).catch(() => false)) break;
    await page.waitForTimeout(2500);
  }
  await page.waitForTimeout(1500);
  await page.evaluate(`document.querySelector('#btn-create-character').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await page.waitForFunction(() => document.getElementById('chargen-root') !== null, undefined, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; ui.wizard.currentStep = 1; ui.renderCharacterCreate(); })()`);
  await page.waitForTimeout(2500);
  // every row unlocked (the default; make sure)
  const unlocked = await page.evaluate(`(() => { const ui = window.__ac.gameUI; const w = ui.wizard; const names = ['strength','endurance','coordination','quickness','focus','self']; let n = 0; for (const a of names) { if (w.isAttributeLocked && w.isAttributeLocked(a)) { document.querySelector('.attr-lock[data-attr="' + a + '"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); } if (!(w.isAttributeLocked && w.isAttributeLocked(a))) n++; } return n; })()`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, 'ours-profession-page.png') });

  const report = await page.evaluate(`(() => {
    const ids = ['0x100002ec', '0x100002ee'];
    const all = Array.from(document.querySelectorAll('*'));
    const carriers = all.filter((el) => {
      const de = el.getAttribute('data-element'); const desc = el.getAttribute('data-ac-desc') || '';
      return ids.includes(de) || ids.some((id) => desc.toLowerCase().endsWith(id.slice(2)));
    }).map((el) => ({ tag: el.tagName, cls: el.className, element: el.getAttribute('data-element'), desc: el.getAttribute('data-ac-desc'), live: el.classList.contains('attr-lock') || el.classList.contains('attr-slider'), rect: (() => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; })() }));
    const rows = Array.from(document.querySelectorAll('.attr-row')).map((row) => {
      const lock = row.querySelector('.attr-lock').getBoundingClientRect();
      const slider = row.querySelector('.attr-slider').getBoundingClientRect();
      const stack = (x, y) => document.elementsFromPoint(x, y).slice(0, 8).map((e) => (e.className && typeof e.className === 'string' ? e.tagName + '.' + e.className.split(' ')[0] : e.tagName) + (e.getAttribute('data-element') ? '[' + e.getAttribute('data-element') + ']' : ''));
      return { attr: row.getAttribute('data-attr'), state: row.getAttribute('data-ac-state'),
        lockStack: stack(lock.left + lock.width / 2, lock.top + lock.height / 2),
        sliderStack: stack(slider.left + slider.width * 0.8, slider.top + slider.height / 2) };
    });
    // any LayoutRenderer-built node under the rows' rects (the layer the page mounts for the chargen layout)
    const layoutNodes = all.filter((el) => el.hasAttribute('data-ac-desc') && !el.closest('.attr-row')).filter((el) => {
      const r = el.getBoundingClientRect(); const rows = document.querySelectorAll('.attr-row');
      for (const row of rows) { const q = row.getBoundingClientRect(); if (r.width > 0 && r.height > 0 && r.left >= q.left - 1 && r.right <= q.right + 1 && r.top >= q.top - 1 && r.bottom <= q.bottom + 1) return true; }
      return false;
    }).map((el) => ({ tag: el.tagName, desc: el.getAttribute('data-ac-desc'), cls: el.className }));
    return { carriers, rows, layoutNodesInsideRowRects: layoutNodes };
  })()`);

  // Pixel test: hide the live lock + slider; if anything static draws beneath them it now shows.
  const rowClip = await page.evaluate(`(() => { const r = document.querySelector('.attr-row').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`) as { x: number; y: number; width: number; height: number };
  await page.evaluate(`document.querySelectorAll('.attr-lock, .attr-slider').forEach((e) => e.style.visibility = 'hidden')`);
  await page.waitForTimeout(300);
  const hidden = await page.screenshot({ path: join(OUT, 'ours-row0-live-controls-hidden.png'), clip: rowClip });
  const hiddenPage = await page.screenshot({ path: join(OUT, 'ours-profession-live-controls-hidden.png') });
  await page.evaluate(`document.querySelectorAll('.attr-lock, .attr-slider').forEach((e) => e.style.visibility = '')`);
  // What paints under the (hidden) live lock: every element at its centre with its own background / img / canvas
  const painters = await page.evaluate(`(() => {
    document.querySelectorAll('.attr-lock, .attr-slider').forEach((e) => e.style.visibility = 'hidden');
    const row = document.querySelector('.attr-row');
    const lock = row.querySelector('.attr-lock').getBoundingClientRect();
    const out = [];
    for (const [what, x, y] of [['lock', lock.left + lock.width / 2, lock.top + lock.height / 2]]) {
      // every element whose box holds the point (elementsFromPoint skips pointer-events:none layers)
      const hits = Array.from(document.querySelectorAll('body *')).filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && x >= r.left && x < r.right && y >= r.top && y < r.bottom; });
      for (const el of hits) {
        const cs = getComputedStyle(el);
        const bg = cs.backgroundImage && cs.backgroundImage !== 'none' ? cs.backgroundImage.slice(0, 80) : '';
        const r = el.getBoundingClientRect();
        out.push({ what, tag: el.tagName, cls: typeof el.className === 'string' ? el.className : '', id: el.id, element: el.getAttribute('data-element'), desc: el.getAttribute('data-ac-desc'), media: el.getAttribute('data-ac-media'), bg, visibility: cs.visibility, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
      }
    }
    // the anonymous static copies: nodes outside .attr-row whose box equals a live lock / slider box
    const liveBoxes = Array.from(document.querySelectorAll('.attr-lock, .attr-slider')).map((e) => { const r = e.getBoundingClientRect(); return { kind: e.classList.contains('attr-lock') ? 'lock' : 'slider', r }; });
    const same = (a, b) => Math.abs(a.left - b.left) < 1.5 && Math.abs(a.top - b.top) < 1.5 && Math.abs(a.width - b.width) < 1.5 && Math.abs(a.height - b.height) < 1.5;
    const copies = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('.attr-row')) continue;
      const r = el.getBoundingClientRect();
      const hit = liveBoxes.find((b) => same(b.r, r));
      if (!hit) continue;
      const chain = []; let p = el; for (let i = 0; i < 6 && p; i++, p = p.parentElement) chain.push(p.tagName + (p.id ? '#' + p.id : '') + (typeof p.className === 'string' && p.className ? '.' + p.className.split(' ').join('.') : '') + Array.from(p.attributes).filter((a) => a.name.startsWith('data-')).map((a) => '[' + a.name + '=' + a.value.slice(0, 40) + ']').join(''));
      copies.push({ kind: hit.kind, chain, hasBg: getComputedStyle(el).backgroundImage !== 'none', childCount: el.children.length });
    }
    out.push({ what: 'static-copies', copies });
    document.querySelectorAll('.attr-lock, .attr-slider').forEach((e) => e.style.visibility = '');
    return out;
  })()`);
  void hidden; void hiddenPage;
  const visibleStatic = await page.evaluate(`Array.from(document.querySelectorAll('[data-layout-id="0x21000038"] [data-element-id="0x100002ec"], [data-layout-id="0x21000038"] [data-element-id="0x100002ee"]')).filter((e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0).length`);
  const lockClip = await page.evaluate(`(() => { const r = document.querySelector('.attr-row .attr-lock').getBoundingClientRect(); return { x: r.left - 6, y: r.top - 6, width: r.width + 12, height: r.height + 12 }; })()`) as { x: number; y: number; width: number; height: number };
  await page.screenshot({ path: join(OUT, 'ours-strength-lock-unlocked.png'), clip: lockClip, scale: 'css' });
  await page.evaluate(`document.querySelector('.attr-lock[data-attr="strength"]').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, 'ours-strength-lock-locked.png'), clip: lockClip, scale: 'css' });
  await page.screenshot({ path: join(OUT, 'ours-profession-strength-locked.png') });
  const visibleStaticLocked = await page.evaluate(`Array.from(document.querySelectorAll('[data-layout-id="0x21000038"] [data-element-id="0x100002ec"], [data-layout-id="0x21000038"] [data-element-id="0x100002ee"]')).filter((e) => getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0).length`);
  const out = { capturedAt: new Date().toISOString(), label: LABEL, unlockedRows: unlocked, visibleStaticCopies: visibleStatic, visibleStaticCopiesAfterLock: visibleStaticLocked, painters, ...(report as object) };
  writeFileSync(join(OUT, 'probe.json'), JSON.stringify(out, null, 2));
  console.log(`[kbbafe] ${LABEL}: visible static copies ${visibleStatic} (after locking Strength ${visibleStaticLocked})`);
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
