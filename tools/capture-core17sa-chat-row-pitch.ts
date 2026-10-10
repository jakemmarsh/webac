/**
 * CORE.17.s.a — live capture + side-by-side evidence for the main chat log's
 * row pitch (UIElement_Text::DrawSelf @ 00467aa0 advances y by each
 * GlyphLine's m_nLineHeight = Font::maxCharHeight — 16 px for the default
 * Chat_PalatinoLinotype_Small 0x40000000; ClientSystem::AddTextToScroll @
 * 00563c50 trims "\n" off both ends of every message; the text element
 * 0x2100006f:0x10000011 carries p35/p36 = 2 (margL/margR) and no p37/p38).
 *
 * Drives the running stack (vite :3000, bridge :9090, ACE) with Playwright
 * exactly like tools/capture-core17s-chat-colors.ts (scripted creation on a
 * virgin account, Holtburg, weather off, noon, yaw 0) and shoots
 *   <label>-hud-idle-over-world.png   the whole frame right after login
 *   <label>-chat-log.png              the #chat-messages crop
 *   <label>-rows.json                 the rows' DOM geometry: every canvas
 *                                     row's top/height inside the log, the
 *                                     log's padding, the pitch between rows
 * Then `--compose` builds, from verification/core17sa/:
 *   core17sa-chat-sidebyside.png       retail Wine chat crop | before | after (3x)
 *   core17sa-fullscreen-sidebyside.png retail Wine frame | ours before | ours after
 *
 * Usage: npx tsx tools/capture-core17sa-chat-row-pitch.ts --label before|after
 *        npx tsx tools/capture-core17sa-chat-row-pitch.ts --compose
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17sa');
const WINE = join(REPO, 'docs/images/retail-client-wine-inworld-holtburg.png');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };

const labelIdx = process.argv.indexOf('--label');
const LABEL = labelIdx >= 0 ? process.argv[labelIdx + 1] : '';

function launch() {
  return chromium.launch({
    args: ['--enable-unsafe-swiftshader'],
    ...(existsSync(REMOTE_CHROMIUM) ? { executablePath: REMOTE_CHROMIUM } : {}),
  });
}

async function inWorld(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dbg = (window as unknown as { acDebug?: { collisionState?: () => { x: number } } }).acDebug;
    const cs = dbg?.collisionState?.();
    return !!(cs && cs.x > 0);
  });
}

/** Same scripted creation as measure-perf.ts (source string — tsx __name landmine). */
async function driveCharacterCreate(page: Page): Promise<string> {
  return page.evaluate(`(() => {
    const ui = window.__ac && window.__ac.gameUI;
    if (!ui || !ui.ui || ui.ui.currentScreen !== 'character-create') return 'not-at-create';
    if (!ui.wizard || !ui.callbacks || !ui.callbacks.onCharacterCreated) return 'no-hooks';
    ui.wizard.name = 'Perf Tester';
    ui.callbacks.onCharacterCreated(ui.wizard);
    return 'sent';
  })()`) as Promise<string>;
}

interface RowGeometry {
  logRect: { x: number; y: number; width: number; height: number };
  padding: { top: number; right: number; bottom: number; left: number };
  messages: Array<{ text: string; marginBottom: string; rows: Array<{ top: number; height: number; width: number }> }>;
  /** Distance between consecutive row tops across the whole log. */
  pitches: number[];
  /** The last row's bottom edge relative to the log's visible bottom edge. */
  lastRowBottomGap: number | null;
  firstRowLeft: number | null;
}

async function rowGeometry(page: Page): Promise<RowGeometry | null> {
  return page.evaluate(() => {
    const log = document.getElementById('chat-messages');
    if (!log) return null;
    const lr = log.getBoundingClientRect();
    const cs = getComputedStyle(log);
    const messages = [...log.children].map((m) => {
      const el = m as HTMLElement;
      const rows = [...el.querySelectorAll('canvas, span')].map((c) => {
        const r = (c as HTMLElement).getBoundingClientRect();
        return { top: Math.round((r.top - lr.top + log.scrollTop) * 100) / 100, height: Math.round(r.height * 100) / 100, width: Math.round(r.width) };
      });
      return { text: el.dataset.chatText ?? el.textContent ?? '', marginBottom: el.style.marginBottom, rows };
    });
    const tops = messages.flatMap((m) => m.rows.map((r) => r.top));
    const pitches = tops.slice(1).map((t, i) => Math.round((t - tops[i]) * 100) / 100);
    const all = messages.flatMap((m) => m.rows);
    const last = all[all.length - 1];
    const lastRowBottomGap = last ? Math.round((log.scrollTop + log.clientHeight - (last.top + last.height)) * 100) / 100 : null;
    const first = log.querySelector('canvas, span') as HTMLElement | null;
    const firstRowLeft = first ? Math.round((first.getBoundingClientRect().left - lr.left) * 100) / 100 : null;
    return {
      logRect: { x: Math.round(lr.left), y: Math.round(lr.top), width: Math.round(lr.width), height: Math.round(lr.height) },
      padding: { top: parseFloat(cs.paddingTop), right: parseFloat(cs.paddingRight), bottom: parseFloat(cs.paddingBottom), left: parseFloat(cs.paddingLeft) },
      messages, pitches, lastRowBottomGap, firstRowLeft,
    };
  });
}

async function captureLive(label: string): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());
  console.log(`[core17sa] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[core17sa] virgin account at character-create — scripted create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[core17sa] not in world yet — reloading (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep polling */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, `_${label}-login-failed.png`) });
    await browser.close();
    throw new Error('never entered world — see _login-failed.png');
  }
  console.log('[core17sa] in world; settling');
  await page.waitForTimeout(9000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), '@telepoi holtburg');
  await page.waitForTimeout(4000);
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), 0);
  await page.waitForTimeout(2500);

  const geo = await rowGeometry(page);
  if (!geo) throw new Error('#chat-messages not found');
  writeFileSync(join(OUT, `${label}-rows.json`), JSON.stringify(geo, null, 2));
  console.log(`[core17sa] rows: ${geo.messages.map((m) => `${JSON.stringify(m.text.slice(0, 24))}×${m.rows.length}`).join(' ')}`);
  console.log(`[core17sa] pitches ${JSON.stringify(geo.pitches)} padding ${JSON.stringify(geo.padding)} lastRowBottomGap ${geo.lastRowBottomGap} firstRowLeft ${geo.firstRowLeft}`);
  const idle = join(OUT, `${label}-hud-idle-over-world.png`);
  await page.screenshot({ path: idle });
  await page.screenshot({ path: join(OUT, `${label}-chat-log.png`), clip: geo.logRect });
  console.log(`[core17sa] ${idle}`);
  await browser.close();
}

interface Panel { file: string; label: string; x: number; y: number; w: number; h: number }

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}

function cropCell(p: Panel, zoom: number): string {
  return `<div class="cell"><div class="lbl">${p.label}</div>
    <div class="clip" style="width:${p.w * zoom}px;height:${p.h * zoom}px">
      <img src="${dataUrl(p.file)}" style="position:absolute;left:${-p.x * zoom}px;top:${-p.y * zoom}px;transform-origin:0 0;transform:scale(${zoom});image-rendering:pixelated"/>
    </div></div>`;
}

const CSS = `<style>
  body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
  .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{color:#ffd;white-space:normal;max-width:900px}
  .clip{position:relative;overflow:hidden;background:#000;border:1px solid #444}
  .full img{display:block;width:780px;height:auto;border:1px solid #444}
  table{border-collapse:collapse} td{padding:2px 8px;border-bottom:1px solid #333}
  h1{font-size:14px;margin:0 0 8px}
</style>`;

function geometryOf(label: string): RowGeometry | null {
  const f = join(OUT, `${label}-rows.json`);
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) as RowGeometry : null;
}

async function compose(): Promise<void> {
  const BEFORE = join(OUT, 'before-hud-idle-over-world.png');
  const AFTER = join(OUT, 'after-hud-idle-over-world.png');
  for (const f of [WINE, BEFORE, AFTER]) if (!existsSync(f)) throw new Error(`missing ${f}`);
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2700, height: 1300 } });

  const geoRow = (label: string): string => {
    const g = geometryOf(label);
    if (!g) return `<tr><td>${label}</td><td colspan="4">no rows.json</td></tr>`;
    const rows = g.messages.reduce((n, m) => n + m.rows.length, 0);
    return `<tr><td>${label}</td><td>${rows} rows / ${g.messages.length} messages</td><td>pitches ${g.pitches.join(', ')}</td><td>padding ${g.padding.top}/${g.padding.right}/${g.padding.bottom}/${g.padding.left}</td><td>first row left ${g.firstRowLeft}, last row bottom gap ${g.lastRowBottomGap}</td></tr>`;
  };
  const chat: Panel[] = [
    { file: WINE, label: 'retail EoL client (Wine, 1024x768) fresh login at Holtburg: 16 px row pitch (Font 0x40000000 maxCharHeight), 2 px left inset, the welcome\'s trailing "\\n" trimmed — 4 full rows + the clipped first row', x: 0, y: 660, w: 430, h: 108 },
    { file: BEFORE, label: 'ours BEFORE: 18 px canvas rows (maxCharHeight + 2) + 1 px message margin, 2px 4px log padding, the trailing "\\n" drawn as an empty row', x: 0, y: 670, w: 430, h: 105 },
    { file: AFTER, label: 'ours AFTER: rows at Font::maxCharHeight (16), no message margin, margL/margR 2 from p35/p36, "\\n" trimmed off both ends like AddTextToScroll @ 00563c50', x: 0, y: 670, w: 430, h: 105 },
  ];
  await page.setContent(`${CSS}<h1>CORE.17.s.a — main chat log row pitch after login: retail vs ours before/after (3x crops, bottom-left)</h1>
    <div class="row">${chat.map((p) => cropCell(p, 3)).join('')}</div>
    <table style="margin-top:10px"><tr><td>retail (Wine frame, measured)</td><td>5 rows visible (4 full + 9 px of the first)</td><td>pitches 16, 16, 16, 16</td><td>margins 0/2/0/2 (p37/p36/p38/p35)</td><td>first row left 2, last row bottom gap 0</td></tr>${geoRow('before')}${geoRow('after')}</table>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17sa-chat-sidebyside.png'), fullPage: true });

  await page.setContent(`${CSS}<h1>CORE.17.s.a — whole screen: retail EoL client (Wine 1024x768) | ours before | ours after (1568x775)</h1>
    <div class="row full">
      <div class="cell"><div class="lbl">retail EoL client under Wine</div><img src="${dataUrl(WINE)}"/></div>
      <div class="cell"><div class="lbl">ours BEFORE</div><img src="${dataUrl(BEFORE)}"/></div>
      <div class="cell"><div class="lbl">ours AFTER</div><img src="${dataUrl(AFTER)}"/></div>
    </div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17sa-fullscreen-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17sa] wrote side-by-sides to ${OUT}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  if (process.argv.includes('--compose')) { await compose(); return; }
  if (!LABEL) throw new Error('usage: --label before|after, or --compose');
  await captureLive(LABEL);
}

main().catch((e) => { console.error(e); process.exit(1); });
