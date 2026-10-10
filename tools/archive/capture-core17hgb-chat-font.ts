/**
 * CORE.17.h.g.b — live capture + side-by-side evidence for the Chat Font Face /
 * Chat Font Size menus driving the chat log's DAT font.
 *
 * Drives the running stack (vite :3000, bridge :9090, ACE) with Playwright,
 * logs in like tools/capture-core17s-chat-colors.ts, parks at Holtburg with
 * the scene harness' pins, then:
 *   default-frame.png            whole frame at the retail default pair (Palatino Small)
 *   default-chat.png             the main log crop at the default pair
 *   pair-<face>-<size>.png       the main log crop after applyOptionsBulk({chatFontFace, chatFontSize})
 *                                (the same path Reset/Defaults use) for every face at Small and
 *                                Palatino at every size, with a sample line pushed per pair
 *   menu-click-frame.png         whole frame after opening Options › Config and CLICKING the
 *                                Chat Font Size menu once (Small → Medium): panel + re-fonted log
 *   samples.json                 per pair: resolved Font DID, canvas heights, line count in view
 * `--compose` then builds core17hgb-chat-font-sidebyside.png from those files
 * plus the retail chat crop (reference/images/hud/chat-panel.jpg, Palatino
 * Small at 1024x768).
 *
 * Usage: npx tsx tools/capture-core17hgb-chat-font.ts
 *        npx tsx tools/capture-core17hgb-chat-font.ts --compose
 */
import { chromium, type Page } from 'playwright';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(dirname(fileURLToPath(import.meta.url))); // archived: resolve from tools/ as before the move
const REPO = resolve(__dir, '..');
const OUT = join(REPO, 'verification', 'core17hgb');
const RETAIL = join(REPO, 'reference/images/hud/chat-panel.jpg');
const REMOTE_CHROMIUM = '/opt/pw-browsers/chromium';
const URL = process.env.AC_URL
  ?? 'http://localhost:3000/?ace&bridge=ws://localhost:9090&account=testacjs&password=testacjs';
const VIEW = { width: 1568, height: 775 };

const FACES = ['Arial', 'CourierNew', 'PalatinoLinotype', 'Tahoma', 'TimesNewRoman'];
const SIZES = ['Tiny', 'Small', 'Medium', 'Large', 'XL'];
/** Every face at Small, then Palatino at every size (the default pair appears once). */
const PAIRS: Array<[number, number]> = [
  [0, 1], [1, 1], [2, 1], [3, 1], [4, 1],
  [2, 0], [2, 2], [2, 3], [2, 4],
];

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

async function chatRect(page: Page) {
  const rect = await page.evaluate(() => {
    const el = document.getElementById('chat-messages');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) };
  });
  if (!rect) throw new Error('#chat-messages not found');
  return rect;
}

interface Sample {
  face: number; size: number; name: string; applied: boolean; fontDid: string;
  canvasHeights: number[]; visibleRows: number; logHeight: number;
}

async function sample(page: Page, face: number, size: number): Promise<Sample> {
  return page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const applied = (() => { ui.applyOptionsBulk({ chatFontFace: ${face}, chatFontSize: ${size} }); return ui.currentChatFontDid; })();
    ui.addSystemMessage('${FACES[face]} ${SIZES[size]}: The quick brown fox jumps over the lazy dog 0123456789', '#ffffff', 0);
    const log = document.getElementById('chat-messages');
    const runs = [...log.querySelectorAll('[data-ac-chat-text]')];
    const heights = [...new Set(runs.map((c) => c.height))];
    const line = log.lastElementChild;
    const rowH = line ? line.getBoundingClientRect().height : 0;
    return {
      face: ${face}, size: ${size}, name: 'Chat_${FACES[face]}_${SIZES[size]}', applied: applied !== 0,
      fontDid: '0x' + (ui.currentChatFontDid >>> 0).toString(16), canvasHeights: heights,
      visibleRows: rowH > 0 ? Math.floor(log.clientHeight / rowH) : 0, logHeight: log.clientHeight,
    };
  })()`) as Promise<Sample>;
}

async function captureLive(): Promise<void> {
  const browser = await launch();
  const page = await browser.newPage({ viewport: VIEW });
  page.setDefaultTimeout(120000);
  page.on('dialog', (d) => void d.dismiss());
  console.log(`[core17hgb] navigating ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 360_000;
  let lastReload = Date.now();
  let createSent = false;
  while (Date.now() < deadline) {
    if (await inWorld(page)) break;
    if (!createSent) {
      const created = await driveCharacterCreate(page);
      if (created !== 'not-at-create') {
        console.log(`[core17hgb] virgin account at character-create — scripted create: ${created}`);
        createSent = true;
        lastReload = Date.now();
      }
    }
    if (Date.now() - lastReload > 60_000) {
      console.log('[core17hgb] not in world yet — reloading (phantom-session retry)');
      try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); } catch { /* keep polling */ }
      lastReload = Date.now();
    }
    await page.waitForTimeout(3000);
  }
  if (!(await inWorld(page))) {
    await page.screenshot({ path: join(OUT, '_login-failed.png') });
    await browser.close();
    throw new Error('never entered world — see _login-failed.png');
  }
  console.log('[core17hgb] in world; settling');
  await page.waitForTimeout(9000);
  await page.evaluate(() => (window as any).__ac?.skybox?.setWeatherEnabled?.(false));
  await page.evaluate((cmd) => (window as any).acDebug?.admin?.(cmd), '@telepoi holtburg');
  await page.waitForTimeout(4000);
  await page.evaluate((t) => (window as any).acDebug?.freezeTimeOfDay?.(t), 0.5);
  await page.evaluate((y) => (window as any).acDebug?.setPlayerYaw?.(y), 0);
  await page.waitForTimeout(2500);

  // Make sure we start from the retail default pair (a persisted profile may differ).
  const initial = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    ui.applyOptionsBulk({ chatFontFace: 2, chatFontSize: 1 });
    return { fontDid: '0x' + (ui.currentChatFontDid >>> 0).toString(16), face: ui.optionsSettings.chatFontFace, size: ui.optionsSettings.chatFontSize };
  })()`);
  console.log(`[core17hgb] default pair: ${JSON.stringify(initial)}`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(OUT, 'default-frame.png') });
  const rect = await chatRect(page);
  await page.screenshot({ path: join(OUT, 'default-chat.png'), clip: rect });

  const samples: Sample[] = [];
  for (const [face, size] of PAIRS) {
    const s = await sample(page, face, size);
    await page.waitForTimeout(400);
    const file = join(OUT, `pair-${face}-${size}.png`);
    await page.screenshot({ path: file, clip: await chatRect(page) });
    console.log(`[core17hgb] ${s.name} → ${s.fontDid} heights=${JSON.stringify(s.canvasHeights)} rows=${s.visibleRows} ${file}`);
    samples.push(s);
  }
  writeFileSync(join(OUT, 'samples.json'), JSON.stringify({ initial, samples }, null, 2));

  // Back to the default, then the REAL menu: open Options › Config and click Chat Font Size once.
  await page.evaluate(`(() => { window.__ac.gameUI.applyOptionsBulk({ chatFontFace: 2, chatFontSize: 1 }); window.__ac.gameUI.clearChatPanel(); })()`);
  await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    ui.addSystemMessage("Welcome to Asheron's Call", '#80ff7f', 0);
    ui.addSystemMessage('  powered by ACEmulator', '#80ff7f', 0);
    ui.addSystemMessage('For more information on commands supported by this server, type @acehelp', '#80ff7f', 0);
    if (ui.optionsPanelVisible) ui.toggleOptionsPanel();
    ui.optionsTab = 'config'; ui.optionsSettings.optionsTab = 'config';
    ui.toggleOptionsPanel();
  })()`);
  await page.waitForTimeout(600);
  const menuBefore = await page.evaluate(`(() => {
    const row = window.__ac.gameUI.optionsPanel.querySelector('[data-option-key="chatFontSize"]');
    if (!row) return 'no-row';
    row.scrollIntoView({ block: 'center' });
    const plate = row.querySelector('.options-menu-value');
    return plate ? plate.textContent : 'no-plate';
  })()`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'menu-before-frame.png') });
  const menuAfter = await page.evaluate(`(() => {
    const ui = window.__ac.gameUI;
    const row = ui.optionsPanel.querySelector('[data-option-key="chatFontSize"]');
    const field = row && row.querySelector('.options-menu-field');
    if (!field) return 'no-field';
    field.dispatchEvent(new Event('click', { bubbles: true }));
    const row2 = ui.optionsPanel.querySelector('[data-option-key="chatFontSize"]');
    if (row2) row2.scrollIntoView({ block: 'center' });
    return { size: ui.optionsSettings.chatFontSize, fontDid: '0x' + (ui.currentChatFontDid >>> 0).toString(16) };
  })()`);
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(OUT, 'menu-click-frame.png') });
  console.log(`[core17hgb] menu click: before=${JSON.stringify(menuBefore)} after=${JSON.stringify(menuAfter)}`);
  await page.evaluate(`(() => { const ui = window.__ac.gameUI; if (ui.optionsPanelVisible) ui.toggleOptionsPanel(); ui.applyOptionsBulk({ chatFontFace: 2, chatFontSize: 1 }); })()`);
  await browser.close();
}

function dataUrl(file: string): string {
  const ext = file.endsWith('.jpg') ? 'jpeg' : 'png';
  return `data:image/${ext};base64,${readFileSync(file).toString('base64')}`;
}

const CSS = `<style>
  body{margin:0;background:#1a1a1a;color:#eee;font:13px/1.3 monospace;padding:10px}
  .row{display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap}
  .cell{display:flex;flex-direction:column;gap:4px}
  .lbl{color:#ffd;white-space:normal;max-width:700px}
  .clip{position:relative;overflow:hidden;background:#000;border:1px solid #444}
  .full img{display:block;width:760px;height:auto;border:1px solid #444}
  .sw img{display:block;border:1px solid #444;image-rendering:pixelated}
  h1{font-size:14px;margin:0 0 8px}
</style>`;

function crop(file: string, label: string, x: number, y: number, w: number, h: number, zoom: number): string {
  return `<div class="cell"><div class="lbl">${label}</div>
    <div class="clip" style="width:${w * zoom}px;height:${h * zoom}px">
      <img src="${dataUrl(file)}" style="position:absolute;left:${-x * zoom}px;top:${-y * zoom}px;transform-origin:0 0;transform:scale(${zoom});image-rendering:pixelated"/>
    </div></div>`;
}

async function compose(): Promise<void> {
  const samples = JSON.parse(readFileSync(join(OUT, 'samples.json'), 'utf8')) as { samples: Sample[] };
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 2400, height: 1400 } });
  const cells: string[] = [];
  cells.push(crop(RETAIL, 'retail (chat-panel.jpg, 1024x768): main log at the default pair — Palatino Linotype / Small (Chat_PalatinoLinotype_Small → Palatino_Linotype_16)', 0, 676, 700, 76, 2));
  cells.push(`<div class="cell"><div class="lbl">ours, default pair (0x40000000 = Palatino_Linotype_16, unchanged by this task)</div><img class="sw" src="${dataUrl(join(OUT, 'default-chat.png'))}" style="width:${2 * 700}px;image-rendering:pixelated"/></div>`);
  for (const s of samples.samples) {
    const f = join(OUT, `pair-${s.face}-${s.size}.png`);
    if (!existsSync(f)) continue;
    cells.push(`<div class="cell"><div class="lbl">${s.name} → ${s.fontDid}${s.applied ? '' : ' (NOT applied)'} · canvas heights ${JSON.stringify(s.canvasHeights)} · ~${s.visibleRows} rows in the ${s.logHeight}px log</div><img class="sw" src="${dataUrl(f)}" style="width:${2 * 700}px;image-rendering:pixelated"/></div>`);
  }
  await page.setContent(`${CSS}<h1>CORE.17.h.g.b — Chat Font Face / Size menus → UI_ChatFonts DidMapper 0x25000012 → DAT font (retail default crop | ours default | every face at Small | Palatino at every size; 2x)</h1>
    <div class="row">${cells.join('')}</div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17hgb-chat-font-sidebyside.png'), fullPage: true });

  const frames = ['default-frame.png', 'menu-before-frame.png', 'menu-click-frame.png']
    .filter((f) => existsSync(join(OUT, f)))
    .map((f) => `<div class="cell"><div class="lbl">${f}</div><img src="${dataUrl(join(OUT, f))}"/></div>`);
  await page.setContent(`${CSS}<h1>CORE.17.h.g.b — whole frames: default pair | Options › Config before the click | after one click on Chat Font Size (Small → Medium: log re-fonted to Palatino_Linotype_18)</h1>
    <div class="row full">${frames.join('')}</div>`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(OUT, 'core17hgb-frames-sidebyside.png'), fullPage: true });
  await browser.close();
  console.log(`[core17hgb] wrote side-by-sides to ${OUT}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  if (process.argv.includes('--compose')) { await compose(); return; }
  await captureLive();
}

main().catch((e) => { console.error(e); process.exit(1); });
